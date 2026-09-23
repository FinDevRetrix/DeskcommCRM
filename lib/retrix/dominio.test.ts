import { describe, expect, it } from "vitest";

import { dominioPermitido } from "@/lib/retrix/dominio";

describe("dominioPermitido", () => {
  const DOMINIOS = ["r3xconsultoria.com", "parceira.com.br"];

  it("aceita e-mail no domínio permitido", () => {
    expect(dominioPermitido("douglas.alves@r3xconsultoria.com", DOMINIOS)).toBe(true);
  });

  it("é case-insensitive no domínio e no e-mail", () => {
    expect(dominioPermitido("Douglas@R3XCONSULTORIA.COM", DOMINIOS)).toBe(true);
  });

  it("aceita o segundo domínio da lista", () => {
    expect(dominioPermitido("alguem@parceira.com.br", DOMINIOS)).toBe(true);
  });

  it("recusa domínio fora da lista", () => {
    expect(dominioPermitido("alguem@outraempresa.com", DOMINIOS)).toBe(false);
  });

  it("recusa domínio que CONTÉM o permitido como substring — não é o mesmo domínio", () => {
    expect(dominioPermitido("alguem@nao-r3xconsultoria.com", DOMINIOS)).toBe(false);
  });

  it("recusa domínio que termina parecido mas é subdomínio de outra coisa", () => {
    expect(dominioPermitido("alguem@r3xconsultoria.com.evil.test", DOMINIOS)).toBe(false);
  });

  it("recusa e-mail sem @ ou vazio", () => {
    expect(dominioPermitido("nao-e-email", DOMINIOS)).toBe(false);
    expect(dominioPermitido("", DOMINIOS)).toBe(false);
    expect(dominioPermitido("@r3xconsultoria.com", DOMINIOS)).toBe(false);
    expect(dominioPermitido("alguem@", DOMINIOS)).toBe(false);
  });

  it("lista vazia nunca aceita nada", () => {
    expect(dominioPermitido("douglas.alves@r3xconsultoria.com", [])).toBe(false);
  });
});
