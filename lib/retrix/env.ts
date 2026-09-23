/**
 * Configuração da "ponte de login" (SSO) com o Portal Central Retrix.
 *
 * Lê `process.env.RETRIX_*` DIRETO — de propósito NÃO passa por `@/lib/env`.
 * `lib/env.ts` é o contrato de env da instalação (Zod, `schema.parse` no
 * import do módulo raiz); acrescentar campos ali tornaria toda instalação do
 * DeskcommCRM open source ciente de uma integração que só existe neste fork
 * (Retrix). Ler `process.env` aqui, isolado, é o que deixa o merge de upstream
 * limpo: `lib/env.ts` nunca precisa saber que este arquivo existe.
 *
 * Todas as chaves são OPCIONAIS na instalação: sem as quatro obrigatórias
 * (`portalOrigin`, `centralSupabaseUrl`, `centralSupabaseAnonKey`, `dominios`),
 * `carregarConfigRetrixSso()` devolve `null` e quem chama trata isso como
 * "recurso desligado" — a rota responde 404 e a página some, não 500. Falha
 * fechada por AUSÊNCIA de configuração é a postura seguro-por-padrão: uma
 * instalação que nunca ouviu falar da Retrix nunca tem esta porta aberta.
 */

/** Papéis humanos válidos em `user_organizations` (espelha o CHECK do banco). */
const PAPEIS_VALIDOS = ["viewer", "agent", "manager", "admin"] as const;
export type PapelRetrixSso = (typeof PAPEIS_VALIDOS)[number];

export type ConfigRetrixSso = {
  /** Origem exata do Portal (ex.: `https://central-retrix2-0.vercel.app`) — sem barra final. */
  portalOrigin: string;
  /** URL do projeto Supabase do PORTAL (não é o Supabase do CRM). */
  centralSupabaseUrl: string;
  /** anon key do projeto Supabase do PORTAL — só valida token, nunca abre RLS daqui. */
  centralSupabaseAnonKey: string;
  /** Domínios de e-mail aceitos (já normalizados: minúsculo, sem espaço, sem vazio). */
  dominios: string[];
  /** `true` só com `RETRIX_SSO_AUTOPROVISIONAR=true` — qualquer outro valor é `false`. */
  autoProvisionar: boolean;
  /** slug da organização de destino do autoprovisionamento. Default: `retrix`. */
  orgSlug: string;
  /** papel atribuído ao autoprovisionar. Default: `agent` (ver README para o porquê). */
  papel: PapelRetrixSso;
};

/** Remove barra(s) final(is) — `origin` nunca deve terminar em `/`. */
function semBarraFinal(valor: string): string {
  return valor.replace(/\/+$/, "");
}

/**
 * `RETRIX_SSO_DOMINIOS=r3xconsultoria.com, Outra.com ,,` → `["r3xconsultoria.com", "outra.com"]`.
 * Minúsculo (comparação de domínio é case-insensitive) e sem entradas vazias
 * (`,,` ou espaço sobrando não pode virar "aceita qualquer coisa").
 */
export function parsearDominios(csv: string): string[] {
  return csv
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter((d) => d.length > 0);
}

/** `"true"` exato liga; qualquer outra coisa (`"1"`, `"TRUE"`, ausente) fica desligado — falha fechada. */
function ligado(valor: string | undefined): boolean {
  return (valor ?? "").trim() === "true";
}

function papelValido(valor: string | undefined): PapelRetrixSso {
  const v = (valor ?? "").trim().toLowerCase();
  if ((PAPEIS_VALIDOS as readonly string[]).includes(v)) return v as PapelRetrixSso;
  if (v.length > 0) {
    console.warn(
      `[retrix.sso] RETRIX_SSO_PAPEL="${v}" não é um papel válido — usando "agent". Papéis aceitos: ${PAPEIS_VALIDOS.join(", ")}.`,
    );
  }
  return "agent";
}

/**
 * `null` quando a integração está desligada (falta alguma variável crítica).
 * Nunca lança — quem chama decide o 404 (rota) ou o fallback (página).
 */
export function carregarConfigRetrixSso(): ConfigRetrixSso | null {
  const portalOrigin = semBarraFinal((process.env.RETRIX_PORTAL_ORIGIN ?? "").trim());
  const centralSupabaseUrl = semBarraFinal((process.env.RETRIX_CENTRAL_SUPABASE_URL ?? "").trim());
  const centralSupabaseAnonKey = (process.env.RETRIX_CENTRAL_SUPABASE_ANON_KEY ?? "").trim();
  const dominios = parsearDominios(process.env.RETRIX_SSO_DOMINIOS ?? "");

  if (!portalOrigin || !centralSupabaseUrl || !centralSupabaseAnonKey || dominios.length === 0) {
    return null;
  }

  return {
    portalOrigin,
    centralSupabaseUrl,
    centralSupabaseAnonKey,
    dominios,
    autoProvisionar: ligado(process.env.RETRIX_SSO_AUTOPROVISIONAR),
    orgSlug: (process.env.RETRIX_SSO_ORG_SLUG ?? "").trim() || "retrix",
    papel: papelValido(process.env.RETRIX_SSO_PAPEL),
  };
}

/**
 * Só a origem pública do portal — é tudo que a PÁGINA `/retrix/entrar`
 * precisa (não a config inteira, que carrega segredos como a anon key).
 *
 * `null` quando a integração está desligada — e "desligada" aqui usa a MESMA
 * régua de `carregarConfigRetrixSso()` (as quatro variáveis críticas), não só
 * `RETRIX_PORTAL_ORIGIN` isolada. Instalação com `PORTAL_ORIGIN` setada mas
 * sem as outras três chegaria à handshake, receberia o token do portal e
 * bateria num 404 em `POST /api/retrix/sso` — pior experiência que o
 * fallback direto, que pelo menos explica e linka `/login`.
 */
export function origemDoPortal(): string | null {
  return carregarConfigRetrixSso()?.portalOrigin ?? null;
}
