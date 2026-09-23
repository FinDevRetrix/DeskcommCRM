/**
 * Decodifica o PAYLOAD de um JWT do GoTrue (Supabase Auth) sem verificar
 * assinatura nem expiração — e isto é seguro aqui, e só aqui, por uma razão
 * específica: quem chama (`app/api/retrix/sso/route.ts`) já mandou o MESMO
 * token para `GET {RETRIX_CENTRAL_SUPABASE_URL}/auth/v1/user` e só chega a
 * decodificar depois de receber 200 daquele servidor — que é quem TEM a
 * chave para validar assinatura e expiração de verdade. Este módulo nunca é
 * usado como a única prova de validade; ele só lê um campo (`aal`) que o
 * endpoint `/auth/v1/user` não devolve no corpo (é claim de SESSÃO, não
 * atributo de usuário).
 *
 * Nunca chame `decodificarPayloadJwt` para decidir "é válido" sozinho — se
 * algum dia decodificar antes de checar contra o servidor central, isto deixa
 * de valer e o token precisa ser tratado como não confiável.
 */

export type PayloadJwtRetrix = {
  /** Authenticator Assurance Level — `"aal2"` só existe com MFA provado NESTA sessão. */
  aal?: string;
  email?: string;
  /** Claim que o GoTrue inclui em alguns formatos de token; o endpoint /user é a fonte primária. */
  email_confirmed?: boolean;
  exp?: number;
  sub?: string;
};

function base64UrlParaJson(segmento: string): unknown {
  // `Buffer.from(..., "base64url")` tolera padding ausente (JWT não usa `=`).
  const texto = Buffer.from(segmento, "base64url").toString("utf8");
  return JSON.parse(texto);
}

/**
 * `null` para qualquer coisa que não seja um JWT bem formado — três segmentos
 * separados por `.`, com o segmento do meio (payload) sendo um objeto JSON
 * válido. Nunca lança: token forjado ou truncado é uma ENTRADA esperada desta
 * função (é exatamente o que ela existe para recusar), não uma exceção.
 */
export function decodificarPayloadJwt(token: string): PayloadJwtRetrix | null {
  const partes = token.split(".");
  if (partes.length !== 3 || !partes[1]) return null;
  try {
    const payload = base64UrlParaJson(partes[1]);
    if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return null;
    return payload as PayloadJwtRetrix;
  } catch {
    return null;
  }
}

/** `true` só com `aal` exatamente `"aal2"` — qualquer outra coisa (`"aal1"`, ausente, lixo) é dívida de MFA. */
export function possuiAal2(payload: PayloadJwtRetrix | null): boolean {
  return payload?.aal === "aal2";
}
