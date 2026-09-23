/**
 * A ÚNICA chamada desta ponte que prova assinatura e expiração do token —
 * `GET {RETRIX_CENTRAL_SUPABASE_URL}/auth/v1/user` é o próprio GoTrue do
 * Portal validando o JWT que ele mesmo assinou. Tudo que vem depois (decodificar
 * `aal` do payload, checar domínio) só roda DEPOIS de um 200 daqui — ver o
 * cabeçalho de `lib/retrix/jwt.ts`.
 */
import { logger } from "@/lib/logger";

/** GoTrue típico responde rápido; acima disso é o portal fora do ar, não lento. */
const PRAZO_MS = 5_000;

export type UsuarioDoPortal = {
  id: string;
  email: string;
  emailConfirmado: boolean;
};

export type ResultadoVerificacaoPortal =
  | { ok: true; usuario: UsuarioDoPortal }
  | { ok: false; motivo: "token_invalido" | "portal_indisponivel" };

export async function verificarTokenNoPortal(params: {
  centralSupabaseUrl: string;
  centralSupabaseAnonKey: string;
  accessToken: string;
}): Promise<ResultadoVerificacaoPortal> {
  const { centralSupabaseUrl, centralSupabaseAnonKey, accessToken } = params;

  let resposta: Response;
  try {
    resposta = await fetch(`${centralSupabaseUrl}/auth/v1/user`, {
      method: "GET",
      headers: {
        apikey: centralSupabaseAnonKey,
        Authorization: `Bearer ${accessToken}`,
      },
      signal: AbortSignal.timeout(PRAZO_MS),
    });
  } catch (err) {
    logger.error("[retrix.sso] falha de rede ao validar token no portal", {
      erro: err instanceof Error ? err.message : String(err),
    });
    return { ok: false, motivo: "portal_indisponivel" };
  }

  // Qualquer não-200 (401 assinatura/expiração ruim, 403, 5xx do portal) é
  // "token inválido" do ponto de vista de quem chama — a distinção fina não
  // muda a decisão aqui, e não vale a pena arriscar mapear código a código
  // contra uma API de terceiro que pode mudar.
  if (!resposta.ok) {
    return { ok: false, motivo: "token_invalido" };
  }

  let corpo: unknown;
  try {
    corpo = await resposta.json();
  } catch {
    return { ok: false, motivo: "token_invalido" };
  }

  const usuario = corpo as
    | { id?: unknown; email?: unknown; email_confirmed_at?: unknown }
    | null;
  if (
    !usuario ||
    typeof usuario.id !== "string" ||
    usuario.id.length === 0 ||
    typeof usuario.email !== "string" ||
    usuario.email.length === 0
  ) {
    return { ok: false, motivo: "token_invalido" };
  }

  return {
    ok: true,
    usuario: {
      id: usuario.id,
      email: usuario.email,
      emailConfirmado:
        typeof usuario.email_confirmed_at === "string" && usuario.email_confirmed_at.length > 0,
    },
  };
}
