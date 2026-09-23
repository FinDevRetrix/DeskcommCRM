import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

const { verificarTokenNoPortal } = await import("@/lib/retrix/portal");

const PARAMS_BASE = {
  centralSupabaseUrl: "https://central.supabase.co",
  centralSupabaseAnonKey: "anon-key",
  accessToken: "token-qualquer",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("verificarTokenNoPortal", () => {
  it("200 com e-mail confirmado → ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        expect(url).toBe("https://central.supabase.co/auth/v1/user");
        expect((init.headers as Record<string, string>).apikey).toBe("anon-key");
        expect((init.headers as Record<string, string>).Authorization).toBe("Bearer token-qualquer");
        return new Response(
          JSON.stringify({ id: "u1", email: "douglas.alves@r3xconsultoria.com", email_confirmed_at: "2026-01-01T00:00:00Z" }),
          { status: 200 },
        );
      }),
    );
    const r = await verificarTokenNoPortal(PARAMS_BASE);
    expect(r).toEqual({
      ok: true,
      usuario: { id: "u1", email: "douglas.alves@r3xconsultoria.com", emailConfirmado: true },
    });
  });

  it("e-mail sem confirmação (email_confirmed_at nulo) → emailConfirmado false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ id: "u1", email: "x@r3xconsultoria.com" }), { status: 200 })),
    );
    const r = await verificarTokenNoPortal(PARAMS_BASE);
    expect(r.ok && r.usuario.emailConfirmado).toBe(false);
  });

  it("401 do GoTrue (assinatura/expiração ruim) → token_invalido", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("unauthorized", { status: 401 })));
    expect(await verificarTokenNoPortal(PARAMS_BASE)).toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("corpo sem email → token_invalido", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ id: "u1" }), { status: 200 })));
    expect(await verificarTokenNoPortal(PARAMS_BASE)).toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("corpo não é JSON → token_invalido, sem lançar", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>não é json</html>", { status: 200 })));
    await expect(verificarTokenNoPortal(PARAMS_BASE)).resolves.toEqual({ ok: false, motivo: "token_invalido" });
  });

  it("rede falha (portal fora do ar) → portal_indisponivel, sem lançar", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    expect(await verificarTokenNoPortal(PARAMS_BASE)).toEqual({ ok: false, motivo: "portal_indisponivel" });
  });
});
