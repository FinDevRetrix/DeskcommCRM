/**
 * Sincronização de clientes do Conta Azul, vindos do Portal Central Retrix,
 * como contatos do CRM — a peça de negócio de `POST /api/retrix/clientes`
 * (`app/api/retrix/clientes/route.ts`).
 *
 * Isolado aqui pela MESMA razão do resto de `lib/retrix/*` (ver
 * `lib/retrix/README.md`): este fork recebe atualizações frequentes do
 * upstream (`melgarafael/DeskcommCRM`), e nada específico da integração
 * Retrix mora em arquivo do produto original — só em arquivos NOVOS. Por
 * isso este módulo lê `process.env.RETRIX_*` DIRETO (nunca por `@/lib/env`,
 * que é o contrato de env da instalação upstream) e nunca importa nada de
 * `lib/retrix/env.ts` — só duplica, aqui, a MESMA forma de leitura (a
 * variável ausente desliga o recurso, nunca derruba o app).
 *
 * ## Por que este endpoint existe (não é o caminho "normal")
 *
 * `POST /api/v1/contacts` (a rota pública de criar contato) e
 * `PATCH /api/v1/contacts/[id]` só aceitam SESSÃO de navegador — não Bearer
 * `dsk_...` (ver `lib/api/auth-dual.ts`, que implementa o padrão dual só em
 * `GET /api/v1/contacts` e `POST /api/v1/messages`, nunca em `contacts`
 * de escrita). Uma Edge Function do Portal (sem navegador, sem cookie) não
 * tem como chamar essas rotas. Em vez de abrir Bearer nelas — o que exigiria
 * tocar arquivo do produto original —, esta integração ganha uma porta
 * PRÓPRIA, isolada, que resolve a identidade sozinha (Bearer fixo,
 * comparado em tempo constante) e por baixo REUSA os mesmos handlers de
 * negócio que a rota pública usa (`createContactHandler`/
 * `patchContactHandler` de `app/api/v1/contacts/_handler.ts` — o MESMO
 * arquivo que `lib/mcp/tools/contacts.ts` já importa de dentro de `lib/`,
 * então isto não é um precedente novo). Reusar os handlers, e não escrever
 * outro `INSERT` à mão, é o que garante que o contato criado por aqui tem a
 * mesma auditoria (`audit()`), o mesmo `emit_event` e as mesmas regras de
 * negócio (telefone canônico, teto de `custom_fields`, etc.) de um contato
 * criado pela tela.
 *
 * ## O ator: por que é um literal fixo, não um `api_token` de verdade
 *
 * Os handlers pedem um `Actor` (`lib/api/handlers/types.ts`). Não existe
 * usuário nem token de API de verdade por trás desta chamada — é uma
 * integração de servidor, então o tipo certo é o já existente `api_token`
 * ("TOKEN DE SERVIDOR sem escopo de agente — uma integração, não uma
 * pessoa", no comentário daquele arquivo). `actor.id` não tem FK nenhuma —
 * só viaja como metadado de auditoria (`metadataActor.actor_id`) —, e o
 * PRÓPRIO comentário daquele tipo já cita precedente de um id literal fixo
 * ("o envio do motor chega a pôr a string literal `agent-engine`"). Por
 * isso `ATOR_SISTEMA` abaixo é uma string fixa, não uma linha de
 * `api_tokens`: criar uma linha ali só para ter um id "de verdade" não
 * traria nenhuma garantia a mais (nada valida essa FK) e ainda inventaria
 * uma chave `dsk_...` que ninguém usa para autenticar.
 *
 * O `supabase` passado aos handlers é sempre o cliente ADMIN (service
 * role) — não porque o ator seja privilegiado, mas porque não há sessão de
 * usuário para carregar RLS nenhuma; é o MESMO arranjo que
 * `app/api/retrix/sso/route.ts` já usa para todo o resto do fluxo
 * (`createAdminClient()`).
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { createContactHandler, patchContactHandler } from "@/app/api/v1/contacts/_handler";
import type { Actor, HandlerCtx } from "@/lib/api/handlers/types";
import type { ContactCreate, ContactPatch } from "@/lib/schemas";

// ---------------------------------------------------------------------------
// Configuração — mesma forma de `lib/retrix/env.ts`, duplicada de propósito.
// ---------------------------------------------------------------------------

export type ConfigRetrixClientes = {
  /** Bearer fixo, comparado em tempo constante pela rota. */
  segredo: string;
  /** slug de `organizations` onde os contatos são criados/atualizados. */
  orgSlug: string;
};

/**
 * `null` quando a integração está desligada (sem `RETRIX_CLIENTES_SECRET`) —
 * quem chama trata isso como "recurso desligado" (404), nunca como 500.
 */
export function carregarConfigRetrixClientes(): ConfigRetrixClientes | null {
  const segredo = (process.env.RETRIX_CLIENTES_SECRET ?? "").trim();
  if (!segredo) return null;
  // Mesma variável (e mesmo default) que `lib/retrix/env.ts` já usa para o
  // autoprovisionamento do SSO — a organização Retrix é uma só.
  const orgSlug = (process.env.RETRIX_SSO_ORG_SLUG ?? "").trim() || "retrix";
  return { segredo, orgSlug };
}

// ---------------------------------------------------------------------------
// Corpo da requisição — validado, estrito, teto de 500 itens.
// ---------------------------------------------------------------------------

const resumoFinanceiroSchema = z
  .object({
    em_aberto: z.number().finite(),
    vencido: z.number().finite(),
    proximo_vencimento: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, "proximo_vencimento deve ser YYYY-MM-DD")
      .nullable()
      .optional(),
    atualizado_em: z.string().min(1),
  })
  .strict();

export const clienteRetrixSchema = z
  .object({
    /** Hash estável gerado pelo Portal (`gerarExternalId`) — chave de casamento. */
    ref: z.string().min(1).max(200),
    nome: z.string().trim().min(1).max(200),
    resumo: resumoFinanceiroSchema.optional(),
  })
  .strict();

export const clientesPayloadSchema = z
  .object({
    clientes: z.array(clienteRetrixSchema).min(1).max(500),
  })
  .strict();

export type ClienteRetrix = z.infer<typeof clienteRetrixSchema>;
export type ClientesPayload = z.infer<typeof clientesPayloadSchema>;

// ---------------------------------------------------------------------------
// Mascaramento — mesma régua do Portal: nome nunca em log por inteiro.
// ---------------------------------------------------------------------------

export function mascararNomeParaLog(nome: string): string {
  const partes = nome.trim().split(/\s+/).filter(Boolean);
  if (partes.length === 0) return "?***";
  return partes.map((p) => `${p[0]}***`).join(" ");
}

/**
 * Mensagens de erro (do Postgres, do PostgREST, de uma `ApiError`) às vezes
 * ecoam o valor que causou o problema. Troca só as ocorrências EXATAS do nome
 * original pela versão mascarada — nunca deixa a mensagem sair intacta por
 * confiar que ela não continha o nome.
 */
export function mascararMensagemDeErro(mensagem: string, nomeOriginal: string): string {
  if (!nomeOriginal) return mensagem;
  return mensagem.split(nomeOriginal).join(mascararNomeParaLog(nomeOriginal));
}

// ---------------------------------------------------------------------------
// Tag fixa e ator de sistema (ver cabeçalho do arquivo).
// ---------------------------------------------------------------------------

/** Já em minúsculo — o CRM normaliza tags para minúsculo de qualquer forma
 * (`normalizarTags`, `lib/contacts/tag-normalizada.ts`), mas não custa nascer
 * do jeito que ele vai gravar. */
export const TAG_CLIENTE_CONTA_AZUL = "cliente conta azul";
export const SOURCE_RETRIX = "retrix_conta_azul";

/** Ver "O ator" no cabeçalho do arquivo — literal fixo, sem FK. */
const ATOR_SISTEMA: Actor = { type: "api_token", id: "retrix-clientes-sync", role: "agent" };

// ---------------------------------------------------------------------------
// Resolução da organização — mesma consulta de `lib/retrix/usuario.ts`
// (função privada lá; duplicada aqui em vez de importada, pela mesma
// doutrina de isolamento: nenhum arquivo do fork Retrix depende de outro
// arquivo do fork Retrix ficar do jeito que está hoje).
// ---------------------------------------------------------------------------

async function organizacaoPorSlug(admin: SupabaseClient, slug: string): Promise<string | null> {
  const { data, error } = await admin
    .from("organizations")
    .select("id")
    .eq("slug", slug)
    .maybeSingle();
  if (error) {
    throw new Error(`retrix-clientes: busca da organização "${slug}" falhou: ${error.message}`);
  }
  return (data as { id: string } | null)?.id ?? null;
}

// ---------------------------------------------------------------------------
// Casamento por `custom_fields->>'retrix_ref'` — não há coluna `external_id`
// em `contacts` (só em `leads`/`orders`/`messages`), então a chave estável
// mora dentro do jsonb livre, como o resto desta integração já faz.
// ---------------------------------------------------------------------------

type ContatoExistente = {
  id: string;
  name: string | null;
  custom_fields: Record<string, unknown> | null;
};

async function encontrarContatoPorRef(
  admin: SupabaseClient,
  organizationId: string,
  ref: string,
): Promise<ContatoExistente | null> {
  const { data, error } = await admin
    .from("contacts")
    .select("id, name, custom_fields")
    .eq("organization_id", organizationId)
    // A lápide de fusão não é um contato vivo — mesma régua de
    // `listContactsHandler` (`app/api/v1/contacts/_handler.ts`).
    .is("is_merged_into", null)
    .eq("custom_fields->>retrix_ref", ref)
    .maybeSingle();
  if (error) {
    throw new Error(`retrix-clientes: busca de contato por ref falhou: ${error.message}`);
  }
  return data as ContatoExistente | null;
}

// ---------------------------------------------------------------------------
// Orquestração — um cliente por vez, nunca lança: uma falha vira `erro`, sem
// derrubar o lote (mesma doutrina de `POST /api/v1/contacts/import`).
// ---------------------------------------------------------------------------

export type DesfechoCliente = "criado" | "atualizado" | "erro";

async function sincronizarUmCliente(
  admin: SupabaseClient,
  ctx: HandlerCtx,
  cliente: ClienteRetrix,
): Promise<DesfechoCliente> {
  const existente = await encontrarContatoPorRef(admin, ctx.organization_id, cliente.ref);

  if (!existente) {
    const input: ContactCreate = {
      name: cliente.nome,
      tags: [TAG_CLIENTE_CONTA_AZUL],
      source: SOURCE_RETRIX,
      custom_fields: {
        retrix_ref: cliente.ref,
        ...(cliente.resumo ? { retrix_resumo_financeiro: cliente.resumo } : {}),
      },
    };
    await createContactHandler(admin, ctx, input);
    return "criado";
  }

  const customFieldsAnteriores = existente.custom_fields ?? {};
  const customFieldsNovos: Record<string, unknown> = {
    ...customFieldsAnteriores,
    retrix_ref: cliente.ref,
    ...(cliente.resumo
      ? { retrix_resumo_financeiro: cliente.resumo }
      : "retrix_resumo_financeiro" in customFieldsAnteriores
        ? { retrix_resumo_financeiro: customFieldsAnteriores.retrix_resumo_financeiro }
        : {}),
  };

  const nomeMudou = (existente.name ?? "").trim() !== cliente.nome.trim();
  const customFieldsMudaram =
    JSON.stringify(customFieldsNovos) !== JSON.stringify(customFieldsAnteriores);

  if (!nomeMudou && !customFieldsMudaram) {
    // Nada realmente muda — conta como "atualizado" (o cliente já existe e
    // está em dia), mas sem gastar um UPDATE/audit à toa todo dia.
    return "atualizado";
  }

  const patch: ContactPatch = {
    custom_fields: customFieldsNovos,
    ...(nomeMudou ? { name: cliente.nome } : {}),
  };
  await patchContactHandler(admin, ctx, existente.id, patch);
  return "atualizado";
}

export type ResultadoSincronizacao =
  | { ok: true; contagem: { criados: number; atualizados: number; erros: number } }
  | { ok: false; motivo: "organizacao_nao_configurada" };

export async function sincronizarClientesRetrix(
  admin: SupabaseClient,
  params: { requestId: string; orgSlug: string; clientes: ClienteRetrix[] },
  registrarErro: (mensagem: string) => void,
): Promise<ResultadoSincronizacao> {
  const organizationId = await organizacaoPorSlug(admin, params.orgSlug);
  if (!organizationId) {
    return { ok: false, motivo: "organizacao_nao_configurada" };
  }

  const ctx: HandlerCtx = {
    organization_id: organizationId,
    actor: ATOR_SISTEMA,
    requestId: params.requestId,
  };

  let criados = 0;
  let atualizados = 0;
  let erros = 0;

  for (const cliente of params.clientes) {
    try {
      const desfecho = await sincronizarUmCliente(admin, ctx, cliente);
      if (desfecho === "criado") criados += 1;
      else atualizados += 1;
    } catch (err) {
      erros += 1;
      const motivoBruto = err instanceof Error ? err.message : String(err);
      const motivo = mascararMensagemDeErro(motivoBruto, cliente.nome);
      registrarErro(`${mascararNomeParaLog(cliente.nome)}: ${motivo}`);
    }
  }

  return { ok: true, contagem: { criados, atualizados, erros } };
}
