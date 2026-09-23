import { describe, expect, it } from "vitest";

import { decodificarPayloadJwt, possuiAal2, type PayloadJwtRetrix } from "@/lib/retrix/jwt";

function tokenFalso(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  // Assinatura não importa aqui — este módulo nunca a verifica (ver cabeçalho de jwt.ts).
  const assinatura = "assinatura-nao-verificada";
  return `${header}.${body}.${assinatura}`;
}

describe("decodificarPayloadJwt", () => {
  it("decodifica um payload bem formado", () => {
    const payload = decodificarPayloadJwt(tokenFalso({ aal: "aal2", email: "douglas.alves@r3xconsultoria.com" }));
    expect(payload).toEqual({ aal: "aal2", email: "douglas.alves@r3xconsultoria.com" });
  });

  it("devolve null para string sem três segmentos", () => {
    expect(decodificarPayloadJwt("so-uma-string")).toBeNull();
    expect(decodificarPayloadJwt("a.b")).toBeNull();
    expect(decodificarPayloadJwt("")).toBeNull();
  });

  it("devolve null quando o segmento do meio não é JSON válido", () => {
    const lixo = `${Buffer.from("{}").toString("base64url")}.${Buffer.from("nao-e-json").toString("base64url")}.sig`;
    expect(decodificarPayloadJwt(lixo)).toBeNull();
  });

  it("devolve null quando o payload decodifica para um array ou primitivo, não objeto", () => {
    const arr = `h.${Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url")}.sig`;
    const num = `h.${Buffer.from(JSON.stringify(42)).toString("base64url")}.sig`;
    expect(decodificarPayloadJwt(arr)).toBeNull();
    expect(decodificarPayloadJwt(num)).toBeNull();
  });

  it("nunca lança para entrada hostil", () => {
    expect(() => decodificarPayloadJwt("....")).not.toThrow();
    expect(() => decodificarPayloadJwt("a.!!!!!!.c")).not.toThrow();
  });
});

describe("possuiAal2", () => {
  it("true só com aal exatamente 'aal2'", () => {
    expect(possuiAal2({ aal: "aal2" })).toBe(true);
  });

  it("false com aal1 (segundo fator não provado nesta sessão)", () => {
    expect(possuiAal2({ aal: "aal1" })).toBe(false);
  });

  it("false quando aal está ausente do payload", () => {
    const payload: PayloadJwtRetrix = { email: "x@r3xconsultoria.com" };
    expect(possuiAal2(payload)).toBe(false);
  });

  it("false para payload null (token não decodificável)", () => {
    expect(possuiAal2(null)).toBe(false);
  });

  it("false para valor de aal que não é exatamente a string 'aal2'", () => {
    expect(possuiAal2({ aal: "AAL2" })).toBe(false);
    expect(possuiAal2({ aal: "aal3" })).toBe(false);
  });
});
