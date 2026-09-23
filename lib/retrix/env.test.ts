import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { carregarConfigRetrixSso, origemDoPortal, parsearDominios } from "@/lib/retrix/env";

const CHAVES = [
  "RETRIX_PORTAL_ORIGIN",
  "RETRIX_CENTRAL_SUPABASE_URL",
  "RETRIX_CENTRAL_SUPABASE_ANON_KEY",
  "RETRIX_SSO_DOMINIOS",
  "RETRIX_SSO_AUTOPROVISIONAR",
  "RETRIX_SSO_ORG_SLUG",
  "RETRIX_SSO_PAPEL",
] as const;

function limpar(): void {
  for (const chave of CHAVES) delete process.env[chave];
}

function configCompletaValida(): void {
  process.env.RETRIX_PORTAL_ORIGIN = "https://central-retrix2-0.vercel.app/";
  process.env.RETRIX_CENTRAL_SUPABASE_URL = "https://central.supabase.co/";
  process.env.RETRIX_CENTRAL_SUPABASE_ANON_KEY = "anon-key-do-portal";
  process.env.RETRIX_SSO_DOMINIOS = "r3xconsultoria.com";
}

beforeEach(limpar);
afterEach(limpar);

describe("parsearDominios", () => {
  it("normaliza minúsculo, remove espaço e entradas vazias", () => {
    expect(parsearDominios("r3xconsultoria.com, Outra.com ,,")).toEqual([
      "r3xconsultoria.com",
      "outra.com",
    ]);
  });

  it("string vazia vira lista vazia", () => {
    expect(parsearDominios("")).toEqual([]);
  });
});

describe("carregarConfigRetrixSso", () => {
  it("null quando nenhuma variável está setada — seguro por padrão", () => {
    expect(carregarConfigRetrixSso()).toBeNull();
  });

  it.each(["RETRIX_PORTAL_ORIGIN", "RETRIX_CENTRAL_SUPABASE_URL", "RETRIX_CENTRAL_SUPABASE_ANON_KEY", "RETRIX_SSO_DOMINIOS"])(
    "null quando falta só %s (as quatro são obrigatórias)",
    (faltante) => {
      configCompletaValida();
      delete process.env[faltante];
      expect(carregarConfigRetrixSso()).toBeNull();
    },
  );

  it("carrega config com defaults quando as quatro obrigatórias estão presentes", () => {
    configCompletaValida();
    const config = carregarConfigRetrixSso();
    expect(config).toEqual({
      portalOrigin: "https://central-retrix2-0.vercel.app",
      centralSupabaseUrl: "https://central.supabase.co",
      centralSupabaseAnonKey: "anon-key-do-portal",
      dominios: ["r3xconsultoria.com"],
      autoProvisionar: false,
      orgSlug: "retrix",
      papel: "agent",
    });
  });

  it("RETRIX_SSO_AUTOPROVISIONAR só liga com o literal 'true'", () => {
    configCompletaValida();
    process.env.RETRIX_SSO_AUTOPROVISIONAR = "1";
    expect(carregarConfigRetrixSso()?.autoProvisionar).toBe(false);
    process.env.RETRIX_SSO_AUTOPROVISIONAR = "TRUE";
    expect(carregarConfigRetrixSso()?.autoProvisionar).toBe(false);
    process.env.RETRIX_SSO_AUTOPROVISIONAR = "true";
    expect(carregarConfigRetrixSso()?.autoProvisionar).toBe(true);
  });

  it("papel inválido cai para 'agent' com aviso, nunca vira admin por acidente", () => {
    configCompletaValida();
    process.env.RETRIX_SSO_PAPEL = "super-admin";
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(carregarConfigRetrixSso()?.papel).toBe("agent");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("papel explícito válido é respeitado, inclusive admin (decisão do operador)", () => {
    configCompletaValida();
    process.env.RETRIX_SSO_PAPEL = "admin";
    expect(carregarConfigRetrixSso()?.papel).toBe("admin");
  });

  it("orgSlug default é 'retrix', mas respeita override", () => {
    configCompletaValida();
    expect(carregarConfigRetrixSso()?.orgSlug).toBe("retrix");
    process.env.RETRIX_SSO_ORG_SLUG = "outra-org";
    expect(carregarConfigRetrixSso()?.orgSlug).toBe("outra-org");
  });
});

describe("origemDoPortal", () => {
  it("null quando a config completa está desligada, mesmo com PORTAL_ORIGIN setado sozinho", () => {
    process.env.RETRIX_PORTAL_ORIGIN = "https://central-retrix2-0.vercel.app";
    expect(origemDoPortal()).toBeNull();
  });

  it("devolve a origem sem barra final quando a config está completa", () => {
    configCompletaValida();
    expect(origemDoPortal()).toBe("https://central-retrix2-0.vercel.app");
  });
});
