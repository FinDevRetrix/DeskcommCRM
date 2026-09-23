/**
 * POST /api/retrix/clientes — porta ISOLADA da integração Retrix (ver
 * `lib/retrix/clientes.ts` para o porquê desta rota existir em vez de abrir
 * Bearer em `POST /api/v1/contacts`).
 *
 * Quem chama é a Edge Function `crm-sync-clientes` do Portal Central Retrix
 * (repo separado, `/home/user/portal-crm-sync`), uma vez por dia — nunca um
 * navegador. Por isso a checagem aqui não é `Origin` (não há origem de
 * navegador para conferir): é um Bearer fixo, comparado em tempo constante,
 * exatamente como `app/api/v1/system/agent/route.ts` já faz com
 * `INTERNAL_CRON_SECRET`/`INTERNAL_SECRET` — mas com o PRÓPRIO segredo desta
 * integração (`RETRIX_CLIENTES_SECRET`), para uma chave vazada aqui nunca
 * abrir a porta de atualização do host.
 *
 * Ordem das checagens, mais barato primeiro:
 *  0. Recurso desligado (sem `RETRIX_CLIENTES_SECRET`) → 404.
 *  1. Rate limit por IP sobre FALHAS (mesmo padrão de `/api/retrix/sso`).
 *  2. Bearer, tempo constante.
 *  3. Content-Type e tamanho do corpo.
 *  4. Corpo validado por Zod, estrito, no máximo 500 clientes.
 *  5. Sincronização (`lib/retrix/clientes.ts`) — nunca deixa um cliente
 *     derrubar os demais.
 *
 * Nunca loga nome de cliente por inteiro, nem o Bearer.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";

import { checkRateLimit, peekRateLimit } from "@/lib/ai/dispatcher/rate-limit";
import { fail, ok } from "@/lib/api/wrappers";
import { timingSafeStringEqual } from "@/lib/auth/cron-auth";
import { ipDoCliente } from "@/lib/http/ip-do-cliente";
import { logger } from "@/lib/logger";
import {
  carregarConfigRetrixClientes,
  clientesPayloadSchema,
  sincronizarClientesRetrix,
} from "@/lib/retrix/clientes";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

/** 500 clientes cabem folgado nisto; acima é abuso, não um lote legítimo. */
const TAMANHO_MAX_CORPO = 300_000;
/** Falhas por IP por minuto — o chamador legítimo (o cron do Portal) nunca esbarra nisto. */
const FALHAS_POR_MINUTO = 20;

export async function POST(req: NextRequest): Promise<Response> {
  const requestId = randomUUID();

  // 0) Desligado por padrão — sem o segredo, a rota não existe.
  const config = carregarConfigRetrixClientes();
  if (!config) return fail("not_found", "Not found.", 404, { requestId });

  // 1) Rate limit por IP, só sobre FALHAS.
  const ip = ipDoCliente(req.headers);
  const balde = ip === null ? null : `retrix:clientes:falha:ip:${ip}`;
  const falhasAnteriores = balde === null ? 0 : await peekRateLimit(balde, 60);
  if (balde !== null && falhasAnteriores >= FALHAS_POR_MINUTO) {
    return fail("rate_limited", "Too many requests.", 429, {
      requestId,
      headers: { "Retry-After": "60" },
    });
  }
  const falhar = async (
    codigo: string,
    mensagem: string,
    status: number,
    extra?: Record<string, unknown>,
  ) => {
    if (balde !== null) await checkRateLimit(balde, FALHAS_POR_MINUTO, 60);
    logger.warn(`[retrix.clientes] recusado: ${codigo}`, { requestId, ...extra });
    return fail(codigo, mensagem, status, { requestId });
  };

  // 2) Bearer fixo, tempo constante.
  const authorization = req.headers.get("authorization") ?? "";
  const bearer = authorization.startsWith("Bearer ")
    ? authorization.slice("Bearer ".length).trim()
    : "";
  if (!bearer || !timingSafeStringEqual(bearer, config.segredo)) {
    return falhar("unauthenticated", "Credencial inválida.", 401);
  }

  // 3) Content-Type e tamanho do corpo — antes de gastar CPU decodificando.
  const contentType = req.headers.get("content-type") ?? "";
  if (!contentType.toLowerCase().startsWith("application/json")) {
    return falhar("bad_request", "Content-Type deve ser application/json.", 400);
  }

  let bruto: string;
  try {
    bruto = await req.text();
  } catch {
    return falhar("bad_request", "Corpo inválido.", 400);
  }
  if (bruto.length === 0 || bruto.length > TAMANHO_MAX_CORPO) {
    return falhar("bad_request", "Corpo inválido.", 400);
  }

  let corpoJson: unknown;
  try {
    corpoJson = JSON.parse(bruto);
  } catch {
    return falhar("bad_request", "JSON malformado.", 400);
  }

  // 4) Zod, estrito, no máximo 500 itens — nunca loga o corpo (poderia
  // conter nomes de clientes).
  const corpo = clientesPayloadSchema.safeParse(corpoJson);
  if (!corpo.success) {
    return falhar("validation_failed", "Corpo inválido.", 422, {
      total_problemas: corpo.error.issues.length,
    });
  }

  // 5) Sincronização — uma falha por cliente nunca derruba o lote.
  const admin = createAdminClient();
  const erros: string[] = [];
  try {
    const resultado = await sincronizarClientesRetrix(
      admin,
      { requestId, orgSlug: config.orgSlug, clientes: corpo.data.clientes },
      (mensagem) => erros.push(mensagem),
    );

    if (!resultado.ok) {
      logger.error("[retrix.clientes] organização de destino não configurada", {
        requestId,
        orgSlug: config.orgSlug,
      });
      return fail(
        "internal_error",
        "Organização de destino não configurada — confira RETRIX_SSO_ORG_SLUG.",
        500,
        { requestId },
      );
    }

    if (erros.length > 0) {
      // Mensagens já mascaradas por `sincronizarClientesRetrix` — nunca o
      // nome completo de um cliente.
      logger.warn("[retrix.clientes] alguns clientes não sincronizaram", {
        requestId,
        erros,
      });
    }

    return ok(resultado.contagem, { requestId });
  } catch (err) {
    logger.error("[retrix.clientes] falha inesperada na sincronização", {
      requestId,
      erro: err instanceof Error ? err.message : String(err),
    });
    return fail("internal_error", "Não foi possível sincronizar os clientes.", 500, { requestId });
  }
}
