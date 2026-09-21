import type pg from "pg";
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { deveCederTurnoAoRetorno } from "./ceder-turno-ao-retorno";

const ORG = "11111111-1111-1111-1111-111111111111";
const CONTATO = "22222222-2222-4222-8222-222222222222";
const CONVERSA = "33333333-3333-4333-8333-333333333333";
const MSG = "44444444-4444-4444-8444-444444444444";
const POINTER = "55555555-5555-4555-8555-555555555555";
const AGORA = new Date("2026-09-20T12:00:00.000Z");

const pedido = {
  organizationId: ORG,
  contactId: CONTATO,
  conversationId: CONVERSA,
  messageId: MSG,
  agora: AGORA,
};

function pool(respostas: Array<{ match: (sql: string) => boolean; rows: unknown[] }>): Pick<pg.Pool, "query"> {
  return {
    query: (async (sql: string) => {
      const hit = respostas.find((r) => r.match(sql));
      return { rows: hit?.rows ?? [] };
    }) as pg.Pool["query"],
  };
}

const pointerQualifica = {
  match: (sql: string) => sql.includes("inbound_after_silence"),
  rows: [
    {
      id: POINTER,
      trigger_config: { kind: "inbound_after_silence", params: { threshold_minutes: 1440 } },
    },
  ],
};

const conversaLivre = {
  match: (sql: string) => sql.includes("from conversations"),
  rows: [
    {
      is_group: false,
      assignee_kind: "ai",
      bot_silenced_until: null,
      is_blocked: false,
      force_human: false,
      tags: [],
    },
  ],
};

const semVivo = {
  match: (sql: string) => sql.includes("followup_enrollments"),
  rows: [],
};

const inboundOntem = {
  match: (sql: string) => sql.includes("from messages"),
  rows: [{ sent_at: new Date(AGORA.getTime() - 2 * 24 * 60 * 60_000).toISOString() }],
};

const agenteArma = {
  match: (sql: string) => sql.includes("ai_agent_versions"),
  rows: [{ agent_id: "aa", followup: { enabled: true, flow_pointer_ids: [POINTER] } }],
};

describe("deveCederTurnoAoRetorno", () => {
  it("sem pointer armado, o turno do agente segue", async () => {
    expect(await deveCederTurnoAoRetorno(pool([]), pedido)).toBe(false);
  });

  it("consulta falhou: fail-open, o turno segue", async () => {
    const quebrado = {
      query: (async () => {
        throw new Error("db down");
      }) as pg.Pool["query"],
    };
    expect(await deveCederTurnoAoRetorno(quebrado, pedido)).toBe(false);
  });

  it("gap qualifica, gate arma, ninguém vivo: cede o turno", async () => {
    expect(
      await deveCederTurnoAoRetorno(
        pool([pointerQualifica, conversaLivre, semVivo, inboundOntem, agenteArma]),
        pedido,
      ),
    ).toBe(true);
  });

  it("primeiro inbound da vida não cede — não é retorno", async () => {
    expect(
      await deveCederTurnoAoRetorno(
        pool([
          pointerQualifica,
          conversaLivre,
          semVivo,
          { match: (sql: string) => sql.includes("from messages"), rows: [] },
          agenteArma,
        ]),
        pedido,
      ),
    ).toBe(false);
  });

  it("outro enrollment vivo não cede — este gatilho não enrollaria", async () => {
    expect(
      await deveCederTurnoAoRetorno(
        pool([
          pointerQualifica,
          conversaLivre,
          { match: (sql: string) => sql.includes("followup_enrollments"), rows: [{ pointer_id: "outro" }] },
          inboundOntem,
          agenteArma,
        ]),
        pedido,
      ),
    ).toBe(false);
  });
});

describe("o drain do agente chama o skip", () => {
  it("drain.ts importa deveCederTurnoAoRetorno", () => {
    const fonte = readFileSync(
      path.join(process.cwd(), "lib/agent-engine/edge/crm/drain.ts"),
      "utf8",
    );
    expect(fonte).toContain("deveCederTurnoAoRetorno");
  });
});
