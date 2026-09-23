/**
 * Testes de `lib/retrix/clientes.ts`. Só nomes FICTÍCIOS
 * ("Cliente Fictício da Silva", "Empresa Fictícia XYZ") — nenhum dado real de
 * cliente entra aqui.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

const createContactHandler = vi.fn();
const patchContactHandler = vi.fn();
vi.mock("@/app/api/v1/contacts/_handler", () => ({
  createContactHandler: (...args: unknown[]) => createContactHandler(...args),
  patchContactHandler: (...args: unknown[]) => patchContactHandler(...args),
}));

const {
  carregarConfigRetrixClientes,
  clienteRetrixSchema,
  clientesPayloadSchema,
  mascararNomeParaLog,
  mascararMensagemDeErro,
  sincronizarClientesRetrix,
  TAG_CLIENTE_CONTA_AZUL,
  SOURCE_RETRIX,
} = await import("@/lib/retrix/clientes");

// ---------------------------------------------------------------------------
// carregarConfigRetrixClientes
// ---------------------------------------------------------------------------

describe("carregarConfigRetrixClientes", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
  });

  it("null quando RETRIX_CLIENTES_SECRET está ausente — recurso desligado", () => {
    delete process.env.RETRIX_CLIENTES_SECRET;
    expect(carregarConfigRetrixClientes()).toBeNull();
  });

  it("null quando RETRIX_CLIENTES_SECRET é só espaço", () => {
    process.env.RETRIX_CLIENTES_SECRET = "   ";
    expect(carregarConfigRetrixClientes()).toBeNull();
  });

  it("usa 'retrix' como orgSlug default quando RETRIX_SSO_ORG_SLUG está ausente", () => {
    process.env.RETRIX_CLIENTES_SECRET = "segredo-de-teste";
    delete process.env.RETRIX_SSO_ORG_SLUG;
    expect(carregarConfigRetrixClientes()).toEqual({
      segredo: "segredo-de-teste",
      orgSlug: "retrix",
    });
  });

  it("respeita RETRIX_SSO_ORG_SLUG quando configurado", () => {
    process.env.RETRIX_CLIENTES_SECRET = "segredo-de-teste";
    process.env.RETRIX_SSO_ORG_SLUG = "outra-org";
    expect(carregarConfigRetrixClientes()).toEqual({
      segredo: "segredo-de-teste",
      orgSlug: "outra-org",
    });
  });
});

// ---------------------------------------------------------------------------
// clienteRetrixSchema / clientesPayloadSchema
// ---------------------------------------------------------------------------

describe("clienteRetrixSchema / clientesPayloadSchema", () => {
  it("aceita um cliente mínimo (sem resumo)", () => {
    const r = clienteRetrixSchema.safeParse({ ref: "caz_abc123", nome: "Cliente Fictício" });
    expect(r.success).toBe(true);
  });

  it("aceita um cliente com resumo completo", () => {
    const r = clienteRetrixSchema.safeParse({
      ref: "caz_abc123",
      nome: "Cliente Fictício",
      resumo: {
        em_aberto: 1234.5,
        vencido: 0,
        proximo_vencimento: "2026-10-05",
        atualizado_em: "2026-09-23T09:00:00.000Z",
      },
    });
    expect(r.success).toBe(true);
  });

  it("recusa campo desconhecido (schema estrito)", () => {
    const r = clienteRetrixSchema.safeParse({
      ref: "caz_x",
      nome: "Cliente Fictício",
      extra: "não deveria estar aqui",
    });
    expect(r.success).toBe(false);
  });

  it("recusa proximo_vencimento fora do formato YYYY-MM-DD", () => {
    const r = clienteRetrixSchema.safeParse({
      ref: "caz_x",
      nome: "Cliente Fictício",
      resumo: { em_aberto: 1, vencido: 0, atualizado_em: "x", proximo_vencimento: "05/10/2026" },
    });
    expect(r.success).toBe(false);
  });

  it("recusa nome vazio ou ref vazia", () => {
    expect(clienteRetrixSchema.safeParse({ ref: "", nome: "Cliente" }).success).toBe(false);
    expect(clienteRetrixSchema.safeParse({ ref: "caz_x", nome: "" }).success).toBe(false);
  });

  it("aceita lote de até 500 clientes e recusa 501", () => {
    const clientes = Array.from({ length: 500 }, (_, i) => ({
      ref: `caz_${i}`,
      nome: `Cliente Fictício ${i}`,
    }));
    expect(clientesPayloadSchema.safeParse({ clientes }).success).toBe(true);

    const excedente = [...clientes, { ref: "caz_500", nome: "Cliente Fictício 500" }];
    expect(clientesPayloadSchema.safeParse({ clientes: excedente }).success).toBe(false);
  });

  it("recusa lote vazio e corpo com chave desconhecida", () => {
    expect(clientesPayloadSchema.safeParse({ clientes: [] }).success).toBe(false);
    expect(
      clientesPayloadSchema.safeParse({ clientes: [{ ref: "a", nome: "b" }], extra: 1 }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// mascararNomeParaLog / mascararMensagemDeErro
// ---------------------------------------------------------------------------

describe("mascararNomeParaLog", () => {
  it("preserva só a primeira letra de cada palavra", () => {
    expect(mascararNomeParaLog("Cliente Fictício da Silva")).toBe("C*** F*** d*** S***");
  });

  it("nunca devolve string vazia para entrada vazia/só espaço", () => {
    expect(mascararNomeParaLog("")).toBe("?***");
    expect(mascararNomeParaLog("   ")).toBe("?***");
  });
});

describe("mascararMensagemDeErro", () => {
  it("troca ocorrências exatas do nome original pela versão mascarada", () => {
    const msg = mascararMensagemDeErro(
      'já existe um contato "Cliente Fictício da Silva"',
      "Cliente Fictício da Silva",
    );
    expect(msg).not.toContain("Cliente Fictício da Silva");
    expect(msg).toContain("C*** F*** d*** S***");
  });

  it("sem nome original, devolve a mensagem intacta", () => {
    expect(mascararMensagemDeErro("erro genérico", "")).toBe("erro genérico");
  });
});

// ---------------------------------------------------------------------------
// sincronizarClientesRetrix
// ---------------------------------------------------------------------------

type Contato = { id: string; name: string | null; custom_fields: Record<string, unknown> | null };

function adminFalso(opts: { orgId?: string | null; contatosPorRef?: Record<string, Contato> }) {
  const contatosPorRef = opts.contatosPorRef ?? {};
  const from = vi.fn((tabela: string) => {
    if (tabela === "organizations") {
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({
              data: opts.orgId ? { id: opts.orgId } : null,
              error: null,
            }),
          }),
        }),
      };
    }
    if (tabela === "contacts") {
      return {
        select: () => ({
          eq: () => ({
            is: () => ({
              eq: (_col: string, ref: string) => ({
                maybeSingle: async () => ({ data: contatosPorRef[ref] ?? null, error: null }),
              }),
            }),
          }),
        }),
      };
    }
    throw new Error(`tabela inesperada no teste: ${tabela}`);
  });
  return { from } as unknown as SupabaseClient;
}

beforeEach(() => {
  createContactHandler.mockReset();
  patchContactHandler.mockReset();
});

describe("sincronizarClientesRetrix", () => {
  const base = { requestId: "req-1", orgSlug: "retrix" };

  it("organização não configurada → organizacao_nao_configurada, nada é chamado", async () => {
    const admin = adminFalso({ orgId: null });
    const r = await sincronizarClientesRetrix(
      admin,
      { ...base, clientes: [{ ref: "caz_1", nome: "Cliente Fictício" }] },
      () => {},
    );
    expect(r).toEqual({ ok: false, motivo: "organizacao_nao_configurada" });
    expect(createContactHandler).not.toHaveBeenCalled();
  });

  it("cliente novo (sem contato existente) → cria, com tag fixa e custom_fields.retrix_ref", async () => {
    createContactHandler.mockResolvedValue({ contact: { id: "novo-id" }, action: "created" });
    const admin = adminFalso({ orgId: "org-retrix", contatosPorRef: {} });

    const r = await sincronizarClientesRetrix(
      admin,
      {
        ...base,
        clientes: [
          {
            ref: "caz_1",
            nome: "Cliente Fictício da Silva",
            resumo: {
              em_aberto: 100,
              vencido: 0,
              atualizado_em: "2026-09-23T00:00:00Z",
              proximo_vencimento: null,
            },
          },
        ],
      },
      () => {},
    );

    expect(r).toEqual({ ok: true, contagem: { criados: 1, atualizados: 0, erros: 0 } });
    expect(createContactHandler).toHaveBeenCalledTimes(1);
    const [, ctx, input] = createContactHandler.mock.calls[0]!;
    expect(ctx.organization_id).toBe("org-retrix");
    expect(ctx.actor).toEqual({ type: "api_token", id: "retrix-clientes-sync", role: "agent" });
    expect(input.name).toBe("Cliente Fictício da Silva");
    expect(input.tags).toEqual([TAG_CLIENTE_CONTA_AZUL]);
    expect(input.source).toBe(SOURCE_RETRIX);
    expect(input.custom_fields.retrix_ref).toBe("caz_1");
    expect(input.custom_fields.retrix_resumo_financeiro).toEqual({
      em_aberto: 100,
      vencido: 0,
      atualizado_em: "2026-09-23T00:00:00Z",
      proximo_vencimento: null,
    });
  });

  it("cliente existente com mudança real → atualiza custom_fields preservando chaves antigas", async () => {
    patchContactHandler.mockResolvedValue({ id: "contato-1" });
    const admin = adminFalso({
      orgId: "org-retrix",
      contatosPorRef: {
        caz_2: {
          id: "contato-1",
          name: "Cliente Fictício",
          custom_fields: { retrix_ref: "caz_2", algo_que_o_crm_gravou: "nao mexer" },
        },
      },
    });

    const r = await sincronizarClientesRetrix(
      admin,
      {
        ...base,
        clientes: [
          {
            ref: "caz_2",
            nome: "Cliente Fictício",
            resumo: { em_aberto: 50, vencido: 10, atualizado_em: "2026-09-23T00:00:00Z" },
          },
        ],
      },
      () => {},
    );

    expect(r).toEqual({ ok: true, contagem: { criados: 0, atualizados: 1, erros: 0 } });
    expect(patchContactHandler).toHaveBeenCalledTimes(1);
    const [, , contactId, patch] = patchContactHandler.mock.calls[0]!;
    expect(contactId).toBe("contato-1");
    expect(patch.name).toBeUndefined(); // nome não mudou
    expect(patch.custom_fields).toEqual({
      retrix_ref: "caz_2",
      algo_que_o_crm_gravou: "nao mexer",
      retrix_resumo_financeiro: {
        em_aberto: 50,
        vencido: 10,
        atualizado_em: "2026-09-23T00:00:00Z",
      },
    });
  });

  it("cliente existente com nome mudado → inclui name no patch", async () => {
    patchContactHandler.mockResolvedValue({ id: "contato-1" });
    const admin = adminFalso({
      orgId: "org-retrix",
      contatosPorRef: {
        caz_3: { id: "contato-1", name: "Nome Antigo", custom_fields: { retrix_ref: "caz_3" } },
      },
    });

    await sincronizarClientesRetrix(
      admin,
      { ...base, clientes: [{ ref: "caz_3", nome: "Nome Novo" }] },
      () => {},
    );

    const [, , , patch] = patchContactHandler.mock.calls[0]!;
    expect(patch.name).toBe("Nome Novo");
  });

  it("cliente existente sem NENHUMA mudança → conta como atualizado, mas não chama patch", async () => {
    const admin = adminFalso({
      orgId: "org-retrix",
      contatosPorRef: {
        caz_4: {
          id: "contato-1",
          name: "Cliente Fictício",
          custom_fields: { retrix_ref: "caz_4" },
        },
      },
    });

    const r = await sincronizarClientesRetrix(
      admin,
      { ...base, clientes: [{ ref: "caz_4", nome: "Cliente Fictício" }] },
      () => {},
    );

    expect(r).toEqual({ ok: true, contagem: { criados: 0, atualizados: 1, erros: 0 } });
    expect(patchContactHandler).not.toHaveBeenCalled();
  });

  it("falha num cliente não derruba os demais — conta erro e mascara o nome no callback", async () => {
    createContactHandler
      .mockRejectedValueOnce(new Error('falhou ao criar "Cliente Fictício Um"'))
      .mockResolvedValueOnce({ contact: { id: "ok" }, action: "created" });
    const admin = adminFalso({ orgId: "org-retrix", contatosPorRef: {} });

    const mensagens: string[] = [];
    const r = await sincronizarClientesRetrix(
      admin,
      {
        ...base,
        clientes: [
          { ref: "caz_a", nome: "Cliente Fictício Um" },
          { ref: "caz_b", nome: "Cliente Fictício Dois" },
        ],
      },
      (m) => mensagens.push(m),
    );

    expect(r).toEqual({ ok: true, contagem: { criados: 1, atualizados: 0, erros: 1 } });
    expect(mensagens).toHaveLength(1);
    expect(mensagens[0]).not.toContain("Cliente Fictício Um");
    expect(mensagens[0]).toContain("C*** F*** U***");
  });

  it("lote misto: alguns criados, alguns atualizados, contagem correta", async () => {
    createContactHandler.mockResolvedValue({ contact: { id: "novo" }, action: "created" });
    patchContactHandler.mockResolvedValue({ id: "existente" });
    const admin = adminFalso({
      orgId: "org-retrix",
      contatosPorRef: {
        caz_existente: { id: "contato-1", name: "Nome Antigo", custom_fields: {} },
      },
    });

    const r = await sincronizarClientesRetrix(
      admin,
      {
        ...base,
        clientes: [
          { ref: "caz_novo", nome: "Cliente Fictício Novo" },
          { ref: "caz_existente", nome: "Nome Atualizado" },
        ],
      },
      () => {},
    );

    expect(r).toEqual({ ok: true, contagem: { criados: 1, atualizados: 1, erros: 0 } });
  });
});
