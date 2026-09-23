/**
 * `POST /api/retrix/sso` nasce DESLIGADA (sem as 4 env vars críticas → 404), e
 * o resto do arquivo prova a ORDEM das guardas: origem antes de corpo, corpo
 * antes do portal, aal2 antes de domínio, domínio antes de identidade — cada
 * checagem recusa sozinha, sem depender da seguinte ter rodado.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
  config: null as unknown,
  appUrl: "https://crm.r3xconsultoria.com",
  limite: vi.fn(),
  espiar: vi.fn(),
  verificarToken: vi.fn(),
  resolverUsuario: vi.fn(),
  generateLink: vi.fn(),
  verifyOtp: vi.fn(),
}));

vi.mock("@/lib/env", () => ({ env: { NEXT_PUBLIC_APP_URL: h.appUrl } }));
vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({ checkRateLimit: h.limite, peekRateLimit: h.espiar }));
vi.mock("@/lib/retrix/env", () => ({ carregarConfigRetrixSso: () => h.config }));
vi.mock("@/lib/retrix/portal", () => ({ verificarTokenNoPortal: h.verificarToken }));
vi.mock("@/lib/retrix/usuario", () => ({ resolverUsuarioParaSso: h.resolverUsuario }));
vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ auth: { admin: { generateLink: h.generateLink } } }),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: async () => ({ auth: { verifyOtp: h.verifyOtp } }),
}));

const { POST } = await import("./route");

const CONFIG_LIGADA = {
  portalOrigin: "https://central-retrix2-0.vercel.app",
  centralSupabaseUrl: "https://central.supabase.co",
  centralSupabaseAnonKey: "anon-key",
  dominios: ["r3xconsultoria.com"],
  autoProvisionar: false,
  orgSlug: "retrix",
  papel: "agent" as const,
};

function tokenAal(aal: string | undefined, email = "douglas.alves@r3xconsultoria.com"): string {
  const header = Buffer.from(JSON.stringify({ alg: "HS256" })).toString("base64url");
  const payload: Record<string, unknown> = { email };
  if (aal !== undefined) payload.aal = aal;
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  return `${header}.${body}.sig`;
}

const TOKEN_VALIDO = tokenAal("aal2");

function pedido(opts: {
  body?: unknown;
  origin?: string | null;
  contentType?: string | null;
  ip?: string;
} = {}): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  if (opts.origin !== null) headers.origin = opts.origin ?? h.appUrl;
  headers["x-forwarded-for"] = opts.ip ?? "203.0.113.9";

  const corpo = opts.body === undefined ? { access_token: TOKEN_VALIDO } : opts.body;
  return new NextRequest("http://localhost/api/retrix/sso", {
    method: "POST",
    headers,
    body: typeof corpo === "string" ? corpo : JSON.stringify(corpo),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.config = CONFIG_LIGADA;
  h.limite.mockResolvedValue({ allowed: true, count: 1, limit: 20, window_sec: 60 });
  h.espiar.mockResolvedValue(0);
  h.verificarToken.mockResolvedValue({
    ok: true,
    usuario: { id: "portal-1", email: "douglas.alves@r3xconsultoria.com", emailConfirmado: true },
  });
  h.resolverUsuario.mockResolvedValue({ ok: true, userId: "crm-1", email: "douglas.alves@r3xconsultoria.com" });
  h.generateLink.mockResolvedValue({ data: { properties: { hashed_token: "hash-abc" } }, error: null });
  h.verifyOtp.mockResolvedValue({ error: null });
});

describe("desligada por padrão", () => {
  it("sem config (faltam as 4 env vars), a rota não existe", async () => {
    h.config = null;
    const res = await POST(pedido());
    expect(res.status).toBe(404);
    expect(h.verificarToken).not.toHaveBeenCalled();
  });
});

describe("guardas de transporte", () => {
  it("recusa origem ausente", async () => {
    const res = await POST(pedido({ origin: null }));
    expect(res.status).toBe(403);
  });

  it("recusa origem de outro site", async () => {
    const res = await POST(pedido({ origin: "https://evil.test" }));
    expect(res.status).toBe(403);
  });

  it("recusa content-type que não é application/json", async () => {
    const res = await POST(pedido({ contentType: "text/plain" }));
    expect(res.status).toBe(400);
  });

  it("recusa corpo vazio", async () => {
    const res = await POST(pedido({ body: "" }));
    expect(res.status).toBe(400);
  });

  it("recusa JSON malformado", async () => {
    const res = await POST(pedido({ body: "{not json" }));
    expect(res.status).toBe(400);
  });

  it("recusa corpo sem access_token ou com token curto demais", async () => {
    expect((await POST(pedido({ body: {} }))).status).toBe(400);
    expect((await POST(pedido({ body: { access_token: "curto" } }))).status).toBe(400);
  });

  it("recusa campo extra no corpo (schema .strict())", async () => {
    const res = await POST(pedido({ body: { access_token: TOKEN_VALIDO, extra: "x" } }));
    expect(res.status).toBe(400);
  });

  it("rate limit: acima do teto de falhas por IP, nem chega a verificar o token", async () => {
    h.espiar.mockResolvedValue(20);
    const res = await POST(pedido());
    expect(res.status).toBe(429);
    expect(h.verificarToken).not.toHaveBeenCalled();
  });
});

describe("validação do token contra o portal", () => {
  it("portal recusa o token → 401", async () => {
    h.verificarToken.mockResolvedValue({ ok: false, motivo: "token_invalido" });
    expect((await POST(pedido())).status).toBe(401);
  });

  it("portal fora do ar → 503, não 401 (não é culpa do parceiro)", async () => {
    h.verificarToken.mockResolvedValue({ ok: false, motivo: "portal_indisponivel" });
    expect((await POST(pedido())).status).toBe(503);
  });

  it("e-mail não confirmado no portal → 401", async () => {
    h.verificarToken.mockResolvedValue({
      ok: true,
      usuario: { id: "p1", email: "x@r3xconsultoria.com", emailConfirmado: false },
    });
    expect((await POST(pedido())).status).toBe(401);
  });
});

describe("aal2 e domínio", () => {
  it("sessão aal1 (sem MFA provado no portal) → 403 mfa_required", async () => {
    const res = await POST(pedido({ body: { access_token: tokenAal("aal1") } }));
    expect(res.status).toBe(403);
    const json = await res.json();
    expect(json.error.code).toBe("mfa_required");
  });

  it("token sem claim aal → 403", async () => {
    const res = await POST(pedido({ body: { access_token: tokenAal(undefined) } }));
    expect(res.status).toBe(403);
  });

  it("e-mail fora dos domínios permitidos → 403, mesmo com aal2", async () => {
    h.verificarToken.mockResolvedValue({
      ok: true,
      usuario: { id: "p1", email: "gente@outraempresa.com", emailConfirmado: true },
    });
    const res = await POST(
      pedido({ body: { access_token: tokenAal("aal2", "gente@outraempresa.com") } }),
    );
    expect(res.status).toBe(403);
    expect(h.resolverUsuario).not.toHaveBeenCalled();
  });
});

describe("identidade no CRM", () => {
  it("usuário não provisionado → 403, nunca cria sessão", async () => {
    h.resolverUsuario.mockResolvedValue({ ok: false, motivo: "usuario_nao_provisionado" });
    const res = await POST(pedido());
    expect(res.status).toBe(403);
    expect(h.generateLink).not.toHaveBeenCalled();
  });

  it("sem membership ativa → 403", async () => {
    h.resolverUsuario.mockResolvedValue({ ok: false, motivo: "sem_membership_ativa" });
    expect((await POST(pedido())).status).toBe(403);
  });

  it("erro de configuração (org do autoprovisionamento não existe) → 500, não 403", async () => {
    h.resolverUsuario.mockResolvedValue({ ok: false, motivo: "organizacao_nao_configurada" });
    expect((await POST(pedido())).status).toBe(500);
  });
});

describe("caminho feliz", () => {
  it("gera o link, troca por sessão e responde 200 { ok: true } sem ecoar o token", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json).toEqual({ ok: true });
    expect(JSON.stringify(json)).not.toContain(TOKEN_VALIDO);

    expect(h.generateLink).toHaveBeenCalledWith({
      type: "magiclink",
      email: "douglas.alves@r3xconsultoria.com",
    });
    expect(h.verifyOtp).toHaveBeenCalledWith({ type: "magiclink", token_hash: "hash-abc" });
  });

  it("falha ao gerar o link → 500, nunca chama verifyOtp", async () => {
    h.generateLink.mockResolvedValue({ data: null, error: { message: "boom" } });
    const res = await POST(pedido());
    expect(res.status).toBe(500);
    expect(h.verifyOtp).not.toHaveBeenCalled();
  });

  it("verifyOtp falha → 500", async () => {
    h.verifyOtp.mockResolvedValue({ error: { message: "boom" } });
    expect((await POST(pedido())).status).toBe(500);
  });
});
