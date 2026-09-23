/**
 * `POST /api/retrix/clientes` nasce DESLIGADA (sem `RETRIX_CLIENTES_SECRET` →
 * 404). O resto prova a ORDEM das guardas — Bearer antes de corpo, corpo
 * antes da sincronização — e que nada aqui loga nome de cliente por inteiro.
 *
 * `clientesPayloadSchema` é a implementação REAL (não mockada): valida o
 * contrato do corpo de verdade, não uma versão simplificada dele.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as ClientesModule from "@/lib/retrix/clientes";

const h = vi.hoisted(() => ({
  config: null as unknown,
  limite: vi.fn(),
  espiar: vi.fn(),
  sincronizar: vi.fn(),
}));

vi.mock("@/lib/ai/dispatcher/rate-limit", () => ({
  checkRateLimit: h.limite,
  peekRateLimit: h.espiar,
}));
vi.mock("@/lib/logger", () => ({
  logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({}) }));
vi.mock("@/lib/retrix/clientes", async (importarReal) => {
  const real = await importarReal<typeof ClientesModule>();
  return {
    ...real,
    carregarConfigRetrixClientes: () => h.config,
    sincronizarClientesRetrix: h.sincronizar,
  };
});

const { POST } = await import("./route");

const CONFIG_LIGADA = { segredo: "segredo-do-cron-de-teste", orgSlug: "retrix" };
const CLIENTE_VALIDO = { ref: "caz_1", nome: "Cliente Fictício da Silva" };

function pedido(
  opts: {
    body?: unknown;
    bearer?: string | null;
    contentType?: string | null;
    ip?: string;
  } = {},
): NextRequest {
  const headers: Record<string, string> = {};
  if (opts.contentType !== null) headers["content-type"] = opts.contentType ?? "application/json";
  if (opts.bearer !== null)
    headers.authorization = `Bearer ${opts.bearer ?? CONFIG_LIGADA.segredo}`;
  headers["x-forwarded-for"] = opts.ip ?? "203.0.113.9";

  const corpo = opts.body === undefined ? { clientes: [CLIENTE_VALIDO] } : opts.body;
  return new NextRequest("http://localhost/api/retrix/clientes", {
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
  h.sincronizar.mockResolvedValue({ ok: true, contagem: { criados: 1, atualizados: 0, erros: 0 } });
});

describe("desligada por padrão", () => {
  it("sem RETRIX_CLIENTES_SECRET, a rota não existe", async () => {
    h.config = null;
    const res = await POST(pedido());
    expect(res.status).toBe(404);
    expect(h.sincronizar).not.toHaveBeenCalled();
  });
});

describe("guardas de transporte", () => {
  it("recusa sem header Authorization", async () => {
    const res = await POST(pedido({ bearer: null }));
    expect(res.status).toBe(401);
  });

  it("recusa Bearer errado", async () => {
    const res = await POST(pedido({ bearer: "segredo-errado" }));
    expect(res.status).toBe(401);
    expect(h.sincronizar).not.toHaveBeenCalled();
  });

  it("recusa Bearer de tamanho diferente do esperado", async () => {
    const res = await POST(pedido({ bearer: "curto" }));
    expect(res.status).toBe(401);
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

  it("rate limit: acima do teto de falhas por IP, nem chega a checar o Bearer", async () => {
    h.espiar.mockResolvedValue(20);
    const res = await POST(pedido({ bearer: "segredo-errado" }));
    expect(res.status).toBe(429);
  });
});

describe("validação do corpo (schema real, estrito)", () => {
  it("recusa lote vazio", async () => {
    const res = await POST(pedido({ body: { clientes: [] } }));
    expect(res.status).toBe(422);
    expect(h.sincronizar).not.toHaveBeenCalled();
  });

  it("recusa mais de 500 clientes", async () => {
    const clientes = Array.from({ length: 501 }, (_, i) => ({
      ref: `caz_${i}`,
      nome: `Cliente ${i}`,
    }));
    const res = await POST(pedido({ body: { clientes } }));
    expect(res.status).toBe(422);
  });

  it("recusa campo desconhecido no corpo (.strict())", async () => {
    const res = await POST(pedido({ body: { clientes: [CLIENTE_VALIDO], extra: "x" } }));
    expect(res.status).toBe(422);
  });

  it("recusa cliente sem nome ou sem ref", async () => {
    const res = await POST(pedido({ body: { clientes: [{ ref: "caz_1" }] } }));
    expect(res.status).toBe(422);
  });

  it("nunca loga o corpo bruto (só a contagem de problemas do zod)", async () => {
    const { logger } = await import("@/lib/logger");
    await POST(
      pedido({ body: { clientes: [{ ref: "caz_1", nome: "Cliente Fictício Secreto" }, {}] } }),
    );
    const chamadas = (logger.warn as ReturnType<typeof vi.fn>).mock.calls;
    const textoDosLogs = JSON.stringify(chamadas);
    expect(textoDosLogs).not.toContain("Cliente Fictício Secreto");
  });
});

describe("caminho feliz", () => {
  it("corpo válido → chama a sincronização e devolve a contagem", async () => {
    const res = await POST(pedido());
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data).toEqual({ criados: 1, atualizados: 0, erros: 0 });
    expect(h.sincronizar).toHaveBeenCalledTimes(1);
  });

  it("organização não configurada → 500", async () => {
    h.sincronizar.mockResolvedValue({ ok: false, motivo: "organizacao_nao_configurada" });
    const res = await POST(pedido());
    expect(res.status).toBe(500);
  });

  it("falha inesperada na sincronização → 500, nunca ecoa o Bearer no corpo do erro", async () => {
    h.sincronizar.mockRejectedValue(new Error("boom"));
    const res = await POST(pedido());
    expect(res.status).toBe(500);
    const json = await res.json();
    expect(JSON.stringify(json)).not.toContain(CONFIG_LIGADA.segredo);
  });
});
