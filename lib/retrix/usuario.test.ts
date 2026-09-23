import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";

vi.mock("@/lib/auth/provision", () => ({ vinculoAtivo: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

const { vinculoAtivo } = await import("@/lib/auth/provision");
const { encontrarUsuarioPorEmail, resolverUsuarioParaSso } = await import("@/lib/retrix/usuario");

type Usuario = { id: string; email: string };

/** Fábrica de um admin client falso — só implementa o que `lib/retrix/usuario.ts` chama. */
function adminFalso(opts: {
  paginas?: Usuario[][];
  createUser?: (email: string) => { data: { user: Usuario } | null; error: { code?: string; status?: number; message: string } | null };
  organizacoes?: Record<string, string>;
  falhaInsertMembro?: { code: string; message: string } | null;
}) {
  const paginas = opts.paginas ?? [[]];
  const listUsers = vi.fn(async ({ page }: { page: number; perPage: number }) => {
    const idx = page - 1;
    if (idx >= paginas.length) return { data: { users: [] }, error: null };
    return { data: { users: paginas[idx] }, error: null };
  });
  const createUser = vi.fn(async ({ email }: { email: string }) =>
    (opts.createUser ?? (() => ({ data: { user: { id: "novo-id", email } }, error: null })))(email),
  );

  const from = vi.fn((tabela: string) => {
    if (tabela === "organizations") {
      return {
        select: () => ({
          eq: (_col: string, slug: string) => ({
            maybeSingle: async () => {
              const id = (opts.organizacoes ?? {})[slug];
              return { data: id ? { id } : null, error: null };
            },
          }),
        }),
      };
    }
    if (tabela === "user_organizations") {
      return {
        insert: async () => ({ error: opts.falhaInsertMembro ?? null }),
      };
    }
    throw new Error(`tabela inesperada no teste: ${tabela}`);
  });

  return {
    auth: { admin: { listUsers, createUser } },
    from,
  } as unknown as SupabaseClient;
}

describe("encontrarUsuarioPorEmail", () => {
  it("encontra o usuário na primeira página", async () => {
    const admin = adminFalso({ paginas: [[{ id: "u1", email: "douglas.alves@r3xconsultoria.com" }]] });
    const achado = await encontrarUsuarioPorEmail(admin, "Douglas.Alves@R3xconsultoria.com");
    expect(achado?.id).toBe("u1");
  });

  it("continua para a página seguinte quando não acha na primeira", async () => {
    const admin = adminFalso({
      paginas: [
        [{ id: "u1", email: "outro@r3xconsultoria.com" }],
        [{ id: "u2", email: "alvo@r3xconsultoria.com" }],
      ],
    });
    const achado = await encontrarUsuarioPorEmail(admin, "alvo@r3xconsultoria.com");
    expect(achado?.id).toBe("u2");
  });

  it("devolve null quando a página vem vazia (fim do diretório)", async () => {
    const admin = adminFalso({ paginas: [[]] });
    expect(await encontrarUsuarioPorEmail(admin, "ninguem@r3xconsultoria.com")).toBeNull();
  });

  it("propaga erro do GoTrue em vez de tratar como 'não existe'", async () => {
    const admin = {
      auth: { admin: { listUsers: vi.fn(async () => ({ data: { users: [] }, error: { message: "fora do ar" } })) } },
    } as unknown as SupabaseClient;
    await expect(encontrarUsuarioPorEmail(admin, "x@r3xconsultoria.com")).rejects.toThrow(/fora do ar/);
  });
});

describe("resolverUsuarioParaSso", () => {
  const base = { email: "parceiro@r3xconsultoria.com", orgSlug: "retrix", papel: "agent" as const };

  it("usuário existente com vínculo ativo → ok", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue("org-1");
    const admin = adminFalso({ paginas: [[{ id: "u1", email: base.email }]] });
    const r = await resolverUsuarioParaSso({ admin, ...base, autoProvisionar: false });
    expect(r).toEqual({ ok: true, userId: "u1", email: base.email });
  });

  it("usuário existente SEM vínculo ativo → sem_membership_ativa", async () => {
    vi.mocked(vinculoAtivo).mockResolvedValue(null);
    const admin = adminFalso({ paginas: [[{ id: "u1", email: base.email }]] });
    const r = await resolverUsuarioParaSso({ admin, ...base, autoProvisionar: false });
    expect(r).toEqual({ ok: false, motivo: "sem_membership_ativa" });
  });

  it("usuário não existe e autoprovisionar=false → usuario_nao_provisionado, sem criar nada", async () => {
    const admin = adminFalso({ paginas: [[]] });
    const r = await resolverUsuarioParaSso({ admin, ...base, autoProvisionar: false });
    expect(r).toEqual({ ok: false, motivo: "usuario_nao_provisionado" });
    expect(admin.auth.admin.createUser).not.toHaveBeenCalled();
  });

  it("usuário não existe, autoprovisionar=true, org configurada → cria e vincula", async () => {
    const admin = adminFalso({ paginas: [[]], organizacoes: { retrix: "org-retrix" } });
    const r = await resolverUsuarioParaSso({ admin, ...base, autoProvisionar: true });
    expect(r).toEqual({ ok: true, userId: "novo-id", email: base.email });
    expect(admin.from).toHaveBeenCalledWith("user_organizations");
  });

  it("autoprovisionar=true mas RETRIX_SSO_ORG_SLUG não existe → organizacao_nao_configurada", async () => {
    const admin = adminFalso({ paginas: [[]], organizacoes: {} });
    const r = await resolverUsuarioParaSso({ admin, ...base, autoProvisionar: true });
    expect(r).toEqual({ ok: false, motivo: "organizacao_nao_configurada" });
  });

  it("createUser bate em email_exists (fora da varredura) → conflito_provisionamento, nunca duplica", async () => {
    const admin = adminFalso({
      paginas: [[]],
      organizacoes: { retrix: "org-retrix" },
      createUser: () => ({ data: null, error: { code: "email_exists", message: "já existe" } }),
    });
    const r = await resolverUsuarioParaSso({ admin, ...base, autoProvisionar: true });
    expect(r).toEqual({ ok: false, motivo: "conflito_provisionamento" });
  });

  it("insert de membership com 23505 (corrida) não lança — idempotente", async () => {
    const admin = adminFalso({
      paginas: [[]],
      organizacoes: { retrix: "org-retrix" },
      falhaInsertMembro: { code: "23505", message: "duplicado" },
    });
    const r = await resolverUsuarioParaSso({ admin, ...base, autoProvisionar: true });
    expect(r.ok).toBe(true);
  });
});
