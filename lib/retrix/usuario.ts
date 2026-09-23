/**
 * Resolve — e, quando permitido, cria — o usuário do CRM que corresponde ao
 * e-mail validado pelo Portal Central Retrix.
 *
 * Só entra aqui DEPOIS que `app/api/retrix/sso/route.ts` já confirmou, contra
 * o Supabase do PORTAL: assinatura/expiração do token, `aal2` e domínio do
 * e-mail. Este módulo fala com o Supabase do CRM (`lib/supabase/admin.ts`,
 * service role) e nunca recebe `organization_id` de fora — ou o e-mail já tem
 * vínculo ativo aqui, ou a organização de destino vem do slug configurado em
 * `RETRIX_SSO_ORG_SLUG`, nunca do request.
 */
import { randomBytes } from "node:crypto";
import type { SupabaseClient, User } from "@supabase/supabase-js";

import { vinculoAtivo } from "@/lib/auth/provision";
import { logger } from "@/lib/logger";
import type { PapelRetrixSso } from "@/lib/retrix/env";

/** Contas por página na varredura do diretório — mesmo valor de `lib/auth/provision.ts`. */
const CONTAS_POR_PAGINA = 200;
/**
 * Teto de páginas da varredura por e-mail (mesma régua de
 * `lib/auth/provision.ts:PAGINAS_DO_DIRETORIO`): até 10 mil contas. Acima
 * disso, `encontrarUsuarioPorEmail` devolve `null` mesmo que a conta exista —
 * ver o tratamento de `email_exists` em `criarUsuarioAutoprovisionado`, que
 * cobre exatamente esse caso no caminho de autoprovisionamento (o GoTrue, que
 * tem índice único de e-mail, é quem tem a resposta definitiva).
 */
const PAGINAS_DO_DIRETORIO = 50;

/**
 * Varre `listUsers` paginado por falta de filtro por e-mail na admin API do
 * GoTrue (auth-js 2.116.0 — mesma limitação documentada em
 * `lib/auth/provision.ts`). Erro de rede/GoTrue sobe alto: "não consegui
 * verificar" não pode virar silenciosamente "não existe", ou um soluço
 * transitório levaria a route a tentar CRIAR um usuário que já existe.
 */
export async function encontrarUsuarioPorEmail(
  admin: SupabaseClient,
  email: string,
): Promise<User | null> {
  const alvo = email.trim().toLowerCase();
  for (let pagina = 1; pagina <= PAGINAS_DO_DIRETORIO; pagina++) {
    const { data, error } = await admin.auth.admin.listUsers({
      page: pagina,
      perPage: CONTAS_POR_PAGINA,
    });
    if (error) {
      throw new Error(`retrix-sso: busca de usuário por e-mail falhou: ${error.message}`);
    }
    if (data.users.length === 0) break;
    const achado = data.users.find((u) => u.email?.toLowerCase() === alvo);
    if (achado) return achado;
  }
  return null;
}

/**
 * A varredura acima (limitada a 10 mil contas) não achou o e-mail, mas o
 * GoTrue — que tem índice único de verdade — diz que ele já existe. Sinal de
 * que a conta está além do teto da varredura, não de que ela não existe.
 * Tratado como um caso à parte para nunca duplicar uma conta real.
 */
export class UsuarioAlemDaVarreduraError extends Error {
  constructor() {
    super("retrix_sso_usuario_alem_da_varredura");
  }
}

/**
 * Cria a conta com senha aleatória (nunca devolvida a ninguém — a sessão sai
 * por `generateLink`/`verifyOtp`, não por login de senha) e e-mail já
 * confirmado: o Portal Central já provou a posse do e-mail (o próprio access
 * token validado é a prova), então pedir confirmação de novo aqui seria
 * duplicar uma verificação que já aconteceu do outro lado da ponte.
 */
async function criarUsuarioAutoprovisionado(admin: SupabaseClient, email: string): Promise<User> {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: randomBytes(24).toString("base64url"),
    email_confirm: true,
    app_metadata: { retrix_sso: true },
  });
  if (data?.user) return data.user;

  // Mesmos dois formatos que `lib/auth/provision.ts` trata: código atual do
  // GoTrue (`email_exists`) e a mensagem de versões anteriores (422 + texto).
  const jaExiste =
    error?.code === "email_exists" ||
    (error?.status === 422 && /already (been )?registered/i.test(error.message));
  if (jaExiste) throw new UsuarioAlemDaVarreduraError();

  throw new Error(`retrix-sso: criar usuário autoprovisionado falhou: ${error?.message ?? "sem usuário"}`);
}

async function organizacaoPorSlug(admin: SupabaseClient, slug: string): Promise<string | null> {
  const { data, error } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    throw new Error(`retrix-sso: busca da organização "${slug}" falhou: ${error.message}`);
  }
  return (data as { id: string } | null)?.id ?? null;
}

/**
 * Vínculo idempotente: `23505` (já existe a linha `user_id`+`organization_id`,
 * unique no banco) não é erro — é o replay do mesmo clique em duas abas, ou o
 * usuário que já tinha vínculo (revogado ou não) nesta organização. NÃO
 * ressuscita vínculo revogado por decisão de um admin — mesma régua de
 * `garantirAdminDaOrganizacao` em `lib/auth/provision.ts`: um `23505` aqui
 * significa "linha já existe", e o INSERT nunca vira UPDATE por cima dela.
 */
async function vincularMembro(
  admin: SupabaseClient,
  params: { userId: string; organizationId: string; papel: PapelRetrixSso },
): Promise<void> {
  const { error } = await admin.from("user_organizations").insert({
    user_id: params.userId,
    organization_id: params.organizationId,
    role: params.papel,
    accepted_at: new Date().toISOString(),
  });
  if (error && error.code !== "23505") {
    throw new Error(`retrix-sso: vincular membro falhou: ${error.message}`);
  }
}

export type ResultadoUsuarioRetrix =
  | { ok: true; userId: string; email: string }
  | {
      ok: false;
      motivo:
        | "usuario_nao_provisionado"
        | "sem_membership_ativa"
        | "organizacao_nao_configurada"
        | "conflito_provisionamento";
    };

/**
 * Orquestra a identidade do lado do CRM: acha o usuário (ou cria, se
 * permitido) e garante que ele tem vínculo ativo em alguma organização antes
 * de a rota criar a sessão.
 *
 * `email` já passou pela checagem de domínio (`lib/retrix/dominio.ts`) e vem
 * do `GET /auth/v1/user` do Portal — não do corpo da requisição.
 */
export async function resolverUsuarioParaSso(params: {
  admin: SupabaseClient;
  email: string;
  autoProvisionar: boolean;
  orgSlug: string;
  papel: PapelRetrixSso;
}): Promise<ResultadoUsuarioRetrix> {
  const { admin, email, autoProvisionar, orgSlug, papel } = params;

  const usuarioExistente = await encontrarUsuarioPorEmail(admin, email);
  if (usuarioExistente) {
    const organizationId = await vinculoAtivo(usuarioExistente.id);
    if (!organizationId) return { ok: false, motivo: "sem_membership_ativa" };
    return { ok: true, userId: usuarioExistente.id, email: usuarioExistente.email ?? email };
  }

  if (!autoProvisionar) {
    return { ok: false, motivo: "usuario_nao_provisionado" };
  }

  let novoUsuario: User;
  try {
    novoUsuario = await criarUsuarioAutoprovisionado(admin, email);
  } catch (err) {
    if (err instanceof UsuarioAlemDaVarreduraError) {
      logger.warn("[retrix.sso] e-mail já existe no GoTrue mas ficou fora da varredura", {});
      return { ok: false, motivo: "conflito_provisionamento" };
    }
    throw err;
  }

  const organizationId = await organizacaoPorSlug(admin, orgSlug);
  if (!organizationId) {
    logger.error("[retrix.sso] organização de autoprovisionamento não encontrada — confira RETRIX_SSO_ORG_SLUG", {
      orgSlug,
    });
    return { ok: false, motivo: "organizacao_nao_configurada" };
  }

  await vincularMembro(admin, { userId: novoUsuario.id, organizationId, papel });

  return { ok: true, userId: novoUsuario.id, email: novoUsuario.email ?? email };
}
