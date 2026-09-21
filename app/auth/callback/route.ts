import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";
import { ensureTenantForUser, vinculoAtivo } from "@/lib/auth/provision";
import { decidirConviteDoSignup } from "@/lib/auth/convite-no-signup";
import { modoDeCadastro } from "@/lib/auth/politica-de-cadastro";
import { aplicarConvite } from "@/lib/auth/aplicar-convite";
import { safeNext } from "@/lib/auth/safe-next";
import { acessoFoiRevogado } from "@/lib/auth/vinculo-revogado";
import { audit } from "@/lib/audit";
import { logger } from "@/lib/logger";
import { env } from "@/lib/env";

/**
 * GET /auth/callback — a VOLTA da entrada com Google (issue #1388).
 *
 * O GoTrue devolve o navegador aqui com `?code=…` depois de o Google confirmar
 * a identidade. Aqui o `code` vira SESSÃO, no servidor, na mesma requisição que
 * gravou o cookie do verificador de PKCE — que é a razão de a metade de ida
 * (`signInWithGoogle`) existir no servidor e de o cookie dela ser `Lax`
 * (`createClientDeEntradaComGoogle`).
 *
 * ─── Por que a troca não passa `flowId` para o auth-js ──────────────────────
 *
 * O auth-js 2.116.0 grava o verificador em DOIS lugares: um slot por fluxo
 * (`…-flow-<id>-code-verifier`) e a chave fixa de sempre (`…-code-verifier`),
 * esta última de propósito — está escrito no `storePKCEVerifier` que a escrita
 * dupla cobre "trocas que não conseguem identificar o próprio fluxo (SDKs
 * antigos, redirects sem o parâmetro de fluxo)". O servidor é exatamente esse
 * caso: sem `window`, o `_exchangeCodeForSession` não lê o parâmetro da URL, e
 * com `flowId` explícito ele passaria a ler SÓ o slot. Sem ele, cai na chave
 * fixa — que existe. Limite conhecido: dois consentimentos abertos em paralelo
 * no mesmo navegador disputam a chave fixa; o mais novo ganha.
 *
 * ─── O que a volta decide ───────────────────────────────────────────────────
 *
 * Este é o ÚNICO ponto em que "entrar" e "criar conta" chegam juntos, sem o
 * e-mail no meio para dizer qual dos dois é. A bifurcação é o VÍNCULO
 * (`user_organizations`), não uma heurística de data:
 *
 * - quem JÁ tem vínculo está ENTRANDO — vai para o destino pedido, e as travas
 *   de cadastro não o alcançam (numa instalação `so_convite`, barrar aqui
 *   trancaria do lado de fora todo mundo que já usa o sistema);
 * - quem NÃO tem vínculo está CRIANDO CONTA — e aí valem as mesmas travas do
 *   `/auth/confirm`: convite, política de cadastro e provisionamento.
 *
 * Tudo o mais é cópia deliberada do miolo de `app/auth/confirm/route.ts`. Não
 * foi extraído para um módulo comum porque os dois caminhos não são o mesmo
 * caminho: lá já se sabe que houve confirmação de e-mail (e todo mundo entra no
 * onboarding), aqui há duas populações. O que os dois compartilham de verdade —
 * `decidirConviteDoSignup`, `aplicarConvite`, `ensureTenantForUser` — já está
 * compartilhado.
 */
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const code = url.searchParams.get("code");
  const next = url.searchParams.get("next");
  const convite = url.searchParams.get("convite");
  const requestId = request.headers.get("x-request-id");

  // NUNCA usar url.origin aqui: é derivado do header Host, que o proxy/container
  // pode entregar como o bind interno (ex.: 0.0.0.0:3000) em vez do domínio
  // público — o link de recovery quebra silenciosamente para o usuário final.
  const redirectTo = (path: string) => NextResponse.redirect(new URL(path, env.NEXT_PUBLIC_APP_URL));

  // O Google devolve `error=access_denied` quando a pessoa fecha a tela de
  // consentimento. Não é falha do sistema, e tratar como falha manda a pessoa
  // procurar defeito onde não há — mas também não é sucesso: sem esta linha, a
  // tela de login ficaria em branco, sem dizer nada.
  const erroDoProvedor = url.searchParams.get("error");
  if (erroDoProvedor) {
    falhaAnonima("recusado_no_provedor", erroDoProvedor);
    return redirectTo("/login?error=entrada_com_google_cancelada");
  }

  if (!code) {
    falhaAnonima("sem_code");
    return redirectTo("/login?error=entrada_com_google");
  }

  // O cliente de sempre (jar Strict): o verificador já viajou até aqui, e é este
  // que grava o cookie de SESSÃO.
  const supabase = await createClient();
  const { data, error } = await supabase.auth.exchangeCodeForSession(code);

  if (error || !data?.user) {
    falhaAnonima("troca_do_code_falhou", error?.message ?? "no_user");
    return redirectTo("/login?error=entrada_com_google");
  }

  const usuario = data.user;

  // O Google autentica com dois fatores (e a conta pode tê-los). O login por
  // senha NÃO deixa passar quem tem TOTP verificado sem o segundo fator
  // (`signInWithPassword.ts:88`), e a entrada com Google tem de ter a mesma
  // força — senão vira a porta mais fraca do produto, e o fator que a pessoa
  // cadastrou deixa de valer em qualquer navegador novo.
  const { data: fatores } = await supabase.auth.mfa.listFactors();
  const totpVerificado = fatores?.totp?.find((f) => f.status === "verified");
  if (totpVerificado) {
    const params = new URLSearchParams({ factor: totpVerificado.id, next: safeNext(next, "/app") });
    return redirectTo(`/login/mfa?${params}`);
  }

  // ENTRADA: já existe vínculo. Provisionar ou reaplicar convite aqui seria
  // refazer trabalho que já está feito — e recusar pelo modo de cadastro
  // trancaria do lado de fora quem já é de casa.
  let organizacaoId: string | null;
  try {
    organizacaoId = await vinculoAtivo(usuario.id);
  } catch (e) {
    // FALHA FECHADA. `vinculoAtivo` lança quando não CONSEGUIU ler, e seguir
    // daqui trataria "não consegui ler" como "não tem vínculo" — o que manda
    // um membro de casa para a trava de cadastro, ou abre uma segunda empresa
    // para quem já tem a dele. A sessão fica firmada; a pessoa tenta de novo.
    await audit({
      action: "auth.google_signin_failed",
      actorUserId: usuario.id,
      metadata: {
        motivo: "vinculo_ilegivel",
        reason: e instanceof Error ? e.message : String(e),
        provider: "google",
      },
      requestId,
    });
    return redirectTo("/login?error=entrada_com_google");
  }

  if (organizacaoId) {
    await audit({
      action: "auth.login_success",
      actorUserId: usuario.id,
      metadata: { provider: "google" },
      requestId,
    });
    return redirectTo(safeNext(next, "/app"));
  }

  // QUEM PERDEU O ACESSO NÃO É UM VISITANTE NOVO — e sem esta guarda era
  // tratado como um. `vinculoAtivo` filtra `.is("revoked_at", null)`, então
  // para o revogado ele devolve o MESMO `null` de quem nunca teve empresa; o
  // caminho de baixo então provisiona e grava `role: "admin"`. Revogar alguém
  // lhe daria, na prática, um tenant próprio dentro da mesma instalação — o
  // mesmo buraco que `recoverOrganization.ts:86` já fecha na outra porta, com
  // esta chamada nesta mesma posição.
  //
  // A POSIÇÃO É LOAD-BEARING: antes de `decidirConviteDoSignup`. Depois dela,
  // o revogado sem convite sairia auditado como `convite_invalido` — que não é
  // a verdade sobre o que aconteceu com ele, e é exatamente a mentira que o
  // cabeçalho de `lib/auth/vinculo-revogado.ts` foi escrito para acabar.
  if (await acessoFoiRevogado(usuario.id)) {
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: "acesso_revogado", provider: "google" },
      requestId,
    });
    return redirectTo("/login?error=acesso_revogado");
  }

  // CADASTRO: sem vínculo, este é um primeiro acesso. Daqui para baixo é o
  // mesmo miolo do `/auth/confirm`, e pelas mesmas razões — o comentário de lá
  // explica cada trava.
  const decisao = decidirConviteDoSignup(usuario, convite);

  if (decisao.tipo === "recusar") {
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: decisao.motivo, provider: "google" },
      requestId,
    });
    return redirectTo("/login?error=convite_invalido");
  }

  if (decisao.tipo === "convite") {
    const aceite = await aplicarConvite({
      userId: usuario.id,
      payload: decisao.payload,
      requestId,
    });
    if (aceite.ok) return redirectTo("/app");

    // Convite revogado, ou banco fora: a tela de aceite continua existindo e
    // sabe explicar cada caso.
    return redirectTo(`/team/accept-invite/${decisao.token}`);
  }

  // A trava da política de cadastro, depois de `decidirConviteDoSignup` de
  // propósito: quem tem convite válido já saiu acima, então esta guarda só
  // alcança quem chegou sem convite nenhum.
  if ((await modoDeCadastro()) === "so_convite") {
    await audit({
      action: "auth.signup_provision_recusado",
      actorUserId: usuario.id,
      metadata: { motivo: "somente_convite", provider: "google" },
      requestId,
    });
    return redirectTo("/login?error=cadastro_por_convite");
  }

  try {
    await ensureTenantForUser(usuario, { source: "signup" });
  } catch (e) {
    await audit({
      action: "auth.signup_provision_failed",
      actorUserId: usuario.id,
      metadata: { reason: e instanceof Error ? e.message : String(e), provider: "google" },
      requestId,
    });
    // A sessão JÁ está firmada. Mandar para `/login` deixava a pessoa logada e
    // sem organização, sem caminho de volta — ver `recoverOrganization.ts`.
    return redirectTo("/get-started");
  }

  void audit({
    action: "auth.signup_confirmed",
    actorUserId: usuario.id,
    metadata: { provider: "google" },
    requestId,
  });

  return redirectTo("/onboarding/welcome");
}

/**
 * As falhas que acontecem ANTES de haver identidade vão para o log, não para o
 * `api_audit_log`.
 *
 * `/auth/callback` está em `PUBLIC_PATHS` porque tem de estar (o cookie de
 * sessão é `sameSite: "strict"` e não viaja na volta do Google). Auditar nos
 * ramos de cima dava a QUALQUER anônimo uma escrita ilimitada numa tabela
 * append-only, com piso de expurgo de 90 dias, numa VPS com cota de disco — e
 * o `reason` ia cru, com o texto que quem chamou escolheu. Medido pela revisão
 * deste PR: `GET /auth/callback?error=<4000 chars>` gravava uma linha com
 * 4.045 bytes de metadata, uma por requisição.
 *
 * A doutrina já estava escrita no irmão desta rota
 * (`app/api/v1/agenda/google/callback/route.ts:188-191`): não se audita antes
 * de um gate. Aqui o gate é a troca do `code` por sessão — passou dela, há
 * pessoa, e daí para baixo tudo audita. O sinal não se perde: o operador o lê
 * no log do contêiner, que rotaciona, em vez de no banco, que não.
 *
 * O `reason` vai truncado de qualquer forma: linha de log de tamanho escolhido
 * por quem chama enche disco do mesmo jeito, só mais devagar.
 */
function falhaAnonima(motivo: string, reason?: string): void {
  logger.warn("auth.google_signin_failed", {
    motivo,
    ...(reason ? { reason: reason.slice(0, 200) } : {}),
  });
}
