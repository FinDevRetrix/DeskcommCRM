import { describe, expect, it } from "vitest";

import { origemBateComOApp } from "@/lib/retrix/origem";

describe("origemBateComOApp", () => {
  const APP_URL = "https://crm.r3xconsultoria.com";

  it("aceita quando a origem do pedido é exatamente a do app", () => {
    expect(origemBateComOApp("https://crm.r3xconsultoria.com", APP_URL)).toBe(true);
  });

  it("ignora path/query da origem canônica (Origin nunca carrega isso, mas a comparação é por .origin)", () => {
    expect(origemBateComOApp("https://crm.r3xconsultoria.com", "https://crm.r3xconsultoria.com/qualquer")).toBe(
      true,
    );
  });

  it("recusa origem ausente — falha fechada", () => {
    expect(origemBateComOApp(null, APP_URL)).toBe(false);
    expect(origemBateComOApp("", APP_URL)).toBe(false);
  });

  it("recusa outro domínio", () => {
    expect(origemBateComOApp("https://evil.test", APP_URL)).toBe(false);
  });

  it("recusa subdomínio parecido (não é a mesma origem)", () => {
    expect(origemBateComOApp("https://crm.r3xconsultoria.com.evil.test", APP_URL)).toBe(false);
  });

  it("recusa esquema diferente (http vs https)", () => {
    expect(origemBateComOApp("http://crm.r3xconsultoria.com", APP_URL)).toBe(false);
  });

  it("recusa porta diferente", () => {
    expect(origemBateComOApp("https://crm.r3xconsultoria.com:8443", APP_URL)).toBe(false);
  });

  it("recusa Origin malformado sem lançar", () => {
    expect(origemBateComOApp("não-é-uma-url", APP_URL)).toBe(false);
  });
});
