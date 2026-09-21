/**
 * "NÃO CONSEGUI LER" NÃO É "NÃO HÁ VÍNCULO".
 *
 * `vinculoAtivo` filtra `.is("revoked_at", null)` e devolve `organization_id`
 * ou `null`. Enquanto o `error` da consulta era descartado, um soluço de
 * leitura devolvia `data: null` e o `?? null` o convertia no MESMO `null` de
 * "esta pessoa não pertence a organização nenhuma" — dois estados opostos com
 * a mesma resposta.
 *
 * Quem paga são os dois caminhos que fazem a pergunta:
 *
 *  - `/auth/callback` (a volta da entrada com Google) trataria um membro de
 *    casa como primeiro acesso: numa instalação `so_convite` isso o expulsa
 *    para `/login?error=cadastro_por_convite`, sem sinal da causa;
 *  - `ensureTenantForUser` abriria uma SEGUNDA empresa para quem já tem a dele.
 *
 * O contraste já estava no mesmo arquivo: `vinculoVivo` captura e lança, com o
 * motivo escrito. Este arquivo prende as duas pontas — que lança quando não
 * leu, e que continua devolvendo `null` quando leu e não achou (senão a
 * correção viraria um throw para todo primeiro acesso legítimo).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

import { vinculoAtivo } from "@/lib/auth/provision";
import { createAdminClient } from "@/lib/supabase/admin";

vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: vi.fn(async () => undefined) }));

const USER = "11111111-1111-4111-8111-111111111111";

function bancoQue(resposta: { data: unknown; error: unknown }) {
  const maybeSingle = vi.fn(async () => resposta);
  const limit = vi.fn(() => ({ maybeSingle }));
  const is = vi.fn(() => ({ limit }));
  const eq = vi.fn(() => ({ is }));
  const select = vi.fn(() => ({ eq }));
  const from = vi.fn(() => ({ select }));
  vi.mocked(createAdminClient).mockReturnValue({ from } as unknown as ReturnType<
    typeof createAdminClient
  >);
  return { from, select, eq, is };
}

describe("vinculoAtivo", () => {
  beforeEach(() => vi.clearAllMocks());

  it("erro de consulta LANÇA — não se disfarça de 'sem vínculo'", async () => {
    bancoQue({ data: null, error: { message: "connection reset" } });

    await expect(vinculoAtivo(USER)).rejects.toThrow(/connection reset/);
  });

  it("leu e não achou: devolve null, que é o primeiro acesso legítimo", async () => {
    const espiao = bancoQue({ data: null, error: null });

    await expect(vinculoAtivo(USER)).resolves.toBeNull();
    expect(espiao.eq).toHaveBeenCalledWith("user_id", USER);
    expect(espiao.is).toHaveBeenCalledWith("revoked_at", null);
  });

  it("achou: devolve a organização", async () => {
    bancoQue({ data: { organization_id: "org-1" }, error: null });

    await expect(vinculoAtivo(USER)).resolves.toBe("org-1");
  });
});
