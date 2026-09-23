/**
 * POST /api/retrix/sso — a "ponte de login" entre o Portal Central Retrix e o
 * CRM. Fecha o handshake iniciado em `app/retrix/entrar/page.tsx`: recebe o
 * `access_token` da sessão do Portal (já `aal2`, TOTP provado lá) e — se ele
 * passar em TODAS as checagens abaixo — cria uma sessão de verdade neste
 * Supabase (o do CRM, um projeto DIFERENTE do Portal) via magic link gerado
 * por admin, sem enviar e-mail nenhum.
 *
 * Arquivo isolado do resto do produto por design (issue Retrix): tudo que
 * este endpoint precisa vive em `lib/retrix/*`, para o merge de upstream
 * nunca colidir aqui.
 *
 * Ordem das checagens — cada uma é um requisito INDEPENDENTE do doc de
 * especificação da ponte, na ordem que falha mais barato primeiro:
 *
 *  0. Recurso desligado (falta config) → 404. Instalação que nunca configurou
 *     a Retrix nunca tem esta porta.
 *  1. Rate limit por IP sobre FALHAS (não sobre chamadas — o parceiro
 *     legítimo nunca esbarra nisto).
 *  2. Origem do pedido é o PRÓPRIO CRM (`Origin` == `NEXT_PUBLIC_APP_URL`).
 *  3. Content-Type e tamanho do corpo.
 *  4. `access_token` verificado contra o Supabase do PORTAL — a ÚNICA fonte
 *     de verdade sobre assinatura/expiração.
 *  5. `aal2` (segundo fator provado nesta sessão do Portal).
 *  6. Domínio do e-mail em `RETRIX_SSO_DOMINIOS`.
 *  7. Usuário existe (ou é autoprovisionado) e tem vínculo ativo no CRM.
 *  8. Sessão do CRM criada via `generateLink` + `verifyOtp` — cookies saem no
 *     `Set-Cookie` da resposta, com o MESMO nome/flags de sempre
 *     (`lib/supabase/server.ts`, `sb-deskcomm-auth`).
 *
 * Erros NUNCA ecoam o token nem o e-mail completo (mascarado via
 * `lib/lgpd/mask.ts`) — nem na resposta, nem no log.
 */
import { randomUUID } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";

import { checkRateLimit, peekRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail } from "@/lib/api/wrappers";
import { env } from "@/lib/env";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import { maskEmail } from "@/lib/lgpd/mask";
import { carregarConfigRetrixSso } from "@/lib/retrix/env";
import { dominioPermitido } from "@/lib/retrix/dominio";
import { decodificarPayloadJwt, possuiAal2 } from "@/lib/retrix/jwt";
import { origemBateComOApp } from "@/lib/retrix/origem";
import { verificarTokenNoPortal } from "@/lib/retrix/portal";
import { resolverUsuarioParaSso } from "@/lib/retrix/usuario";
import { createAdminClient } from "@/lib/supabase/admin";
import { createClient } from "@/lib/supabase/server";

// Sempre executa server-side (lê Origin/corpo por request, nunca cacheia).
export const dynamic = "force-dynamic";

/** Acima disto o corpo não é um JWT de sessão — é abuso. */
const TAMANHO_MAX_CORPO = 20_000;
const TAMANHO_MIN_TOKEN = 20;
const TAMANHO_MAX_TOKEN = 8_000;
/** Falhas por IP por minuto — o parceiro legítimo verifica uma vez e acerta. */
const FALHAS_POR_MINUTO = 20;

const corpoSchema = z
  .object({
    access_token: z.string().trim().min(TAMANHO_MIN_TOKEN).max(TAMANHO_MAX_TOKEN),
  })
  .strict();

function respostaSucesso(requestId: string): NextResponse {
  const res = NextResponse.json({ ok: true }, { status: 200, headers: { "Cache-Control": "no-store" } });
  res.headers.set("X-Request-Id", requestId);
  return res;
}

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // 0) Desligado por padrão — sem as 4 variáveis críticas, a rota não existe.
  const config = carregarConfigRetrixSso();
  if (!config) return fail("not_found", "Not found.", 404, { requestId });

  // Balde de rate limit por IP, só sobre FALHAS — mesmo padrão de
  // `app/api/v1/tenants/provision/route.ts`. IP ausente (kit self-host sem
  // proxy) = sem balde, nunca um balde compartilhado "desconhecido".
  const ip = ipDoCliente(req.headers);
  const balde = ip === null ? null : `retrix:sso:falha:ip:${ip}`;
  const falhasAnteriores = balde === null ? 0 : await peekRateLimit(balde, 60);
  if (balde !== null && falhasAnteriores >= FALHAS_POR_MINUTO) {
    return fail("rate_limited", "Too many requests.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }
  const falhar = async (codigo: string, mensagem: string, status: number, extra?: Record<string, unknown>) => {
    if (balde !== null) await checkRateLimit(balde, FALHAS_POR_MINUTO, 60);
    logger.warn(`[retrix.sso] recusado: ${codigo}`, { requestId, ...extra });
    return fail(codigo, mensagem, status, { requestId });
  };

  // 1) Mesma origem — este endpoint não tem cookie de sessão prévio para se
  // apoiar (é ele que CRIA a sessão), então a origem do POST é a única
  // barreira contra um site de terceiro tentando falar com ele. Ver
  // `lib/retrix/origem.ts`.
  const origemPedido = req.headers.get("origin");
  if (!origemBateComOApp(origemPedido, env.NEXT_PUBLIC_APP_URL)) {
    return falhar("forbidden_origin", "Origem não permitida.", 403, {
      origem: origemPedido ?? "ausente",
    });
  }

  // 2) Content-Type.
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return falhar("bad_request", "Content-Type deve ser application/json.", 400);
  }

  // 3) Corpo — tamanho ANTES de tentar parsear (evita gastar CPU com JSON.parse
  // num corpo gigante).
  let bruto: string;
  try {
    bruto = await req.text();
  } catch {
    return falhar("bad_request", "Corpo inválido.", 400);
  }
  if (bruto.length === 0 || bruto.length > TAMANHO_MAX_CORPO) {
    return falhar("bad_request", "Corpo inválido.", 400);
  }

  let corpoJson: unknown;
  try {
    corpoJson = JSON.parse(bruto);
  } catch {
    return falhar("bad_request", "JSON malformado.", 400);
  }

  const corpo = corpoSchema.safeParse(corpoJson);
  if (!corpo.success) {
    return falhar("bad_request", "access_token ausente ou em formato inválido.", 400);
  }
  const { access_token: accessToken } = corpo.data;

  // 4) A ÚNICA verificação que prova assinatura/expiração: o próprio GoTrue
  // do Portal, via `GET /auth/v1/user`.
  const verificacao = await verificarTokenNoPortal({
    centralSupabaseUrl: config.centralSupabaseUrl,
    centralSupabaseAnonKey: config.centralSupabaseAnonKey,
    accessToken,
  });
  if (!verificacao.ok) {
    return falhar(
      "invalid_token",
      "Sessão do portal inválida ou expirada.",
      verificacao.motivo === "portal_indisponivel" ? 503 : 401,
      { motivo: verificacao.motivo },
    );
  }
  const { usuario } = verificacao;

  if (!usuario.emailConfirmado) {
    return falhar("invalid_token", "Sessão do portal inválida ou expirada.", 401, {
      email: maskEmail(usuario.email),
    });
  }

  // 5) aal2 — decodificado do MESMO token que acabou de ser validado no passo
  // 4 (nunca confiado sozinho; ver o cabeçalho de `lib/retrix/jwt.ts`).
  const payload = decodificarPayloadJwt(accessToken);
  if (!possuiAal2(payload)) {
    return falhar("mfa_required", "É necessário verificação em duas etapas no portal.", 403, {
      email: maskEmail(usuario.email),
    });
  }

  // 6) Domínio autorizado.
  if (!dominioPermitido(usuario.email, config.dominios)) {
    return falhar("forbidden", "Domínio não autorizado.", 403, { email: maskEmail(usuario.email) });
  }

  // 7) Identidade do lado do CRM — service role, org sempre resolvida no
  // servidor (vínculo existente ou slug configurado), nunca do corpo.
  const admin = createAdminClient();
  let resolucao: Awaited<ReturnType<typeof resolverUsuarioParaSso>>;
  try {
    resolucao = await resolverUsuarioParaSso({
      admin,
      email: usuario.email,
      autoProvisionar: config.autoProvisionar,
      orgSlug: config.orgSlug,
      papel: config.papel,
    });
  } catch (err) {
    logger.error("[retrix.sso] falha ao resolver usuário", {
      requestId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Não foi possível concluir o login.", 500, { requestId });
  }

  if (!resolucao.ok) {
    const status =
      resolucao.motivo === "organizacao_nao_configurada" || resolucao.motivo === "conflito_provisionamento"
        ? 500
        : 403;
    return falhar(resolucao.motivo, "Não foi possível concluir o login.", status, {
      email: maskEmail(usuario.email),
    });
  }

  // 8) Sessão do CRM: magic link gerado por admin (NUNCA envia e-mail —
  // `generateLink` só gera o link/token, quem envia é `signInWithOtp`, que
  // não é chamado aqui) + `verifyOtp` no cliente canônico de rota
  // (`lib/supabase/server.ts`), que grava os cookies de sessão na resposta
  // com o MESMO nome/flags de sempre (`sb-deskcomm-auth`, Strict, Secure).
  let hashedToken: string;
  try {
    const { data, error } = await admin.auth.admin.generateLink({
      type: "magiclink",
      email: resolucao.email,
    });
    if (error || !data?.properties?.hashed_token) {
      throw new Error(error?.message ?? "generateLink sem hashed_token");
    }
    hashedToken = data.properties.hashed_token;
  } catch (err) {
    logger.error("[retrix.sso] falha ao gerar link de sessão", {
      requestId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Não foi possível concluir o login.", 500, { requestId });
  }

  const supabase = await createClient();
  const { error: erroSessao } = await supabase.auth.verifyOtp({
    type: "magiclink",
    token_hash: hashedToken,
  });
  if (erroSessao) {
    logger.error("[retrix.sso] falha ao trocar o link por sessão", {
      requestId,
      erro: erroSessao.message,
    });
    return fail("internal_error", "Não foi possível concluir o login.", 500, { requestId });
  }

  logger.info("[retrix.sso] login via ponte concluído", {
    requestId,
    email: maskEmail(resolucao.email),
  });

  return respostaSucesso(requestId);
}
