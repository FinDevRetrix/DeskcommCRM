# Sincronização de clientes do Conta Azul (`POST /api/retrix/clientes`)

Porta ISOLADA da integração Retrix (mesma família de `app/api/retrix/sso`,
ver `lib/retrix/README.md`) que recebe, em lote, os clientes que o Portal
Central Retrix já reconciliou contra o Conta Azul e garante que cada um vira
(ou já é) um contato deste CRM.

**Isolamento**: todo o código específico desta integração mora em arquivos
NOVOS — `app/api/retrix/clientes/route.ts` e `lib/retrix/clientes.ts` — para
o merge de upstream (`melgarafael/DeskcommCRM`) nunca precisar resolver
conflito aqui. A única exceção é a linha (mais o comentário que a explica) em
`lib/auth/public-paths.ts`, necessária para o `proxy.ts` deixar o Bearer
chegar à rota antes de exigir cookie de sessão.

## Por que esta rota existe (e não um Bearer em `POST /api/v1/contacts`)

Levantamento no próprio código do CRM: `POST /api/v1/contacts` (criar
contato) e `PATCH /api/v1/contacts/[id]` (editar) só aceitam **sessão de
navegador** — o padrão dual sessão-ou-Bearer de `lib/api/auth-dual.ts` só
está ligado em `GET /api/v1/contacts` e `POST /api/v1/messages`. Uma Edge
Function do Portal (sem navegador, sem cookie) não tem como chamar essas
rotas de escrita.

Em vez de abrir Bearer nelas — o que exigiria editar arquivo do produto
original —, esta integração ganha uma porta própria, que resolve sua PRÓPRIA
identidade (Bearer fixo) e por baixo **reusa os mesmos handlers de negócio**
que a rota pública usa: `createContactHandler`/`patchContactHandler`
(`app/api/v1/contacts/_handler.ts` — o mesmo arquivo que
`lib/mcp/tools/contacts.ts` já importa de dentro de `lib/`, então isto não é
um precedente novo). Reusar os handlers é o que garante que o contato criado
por aqui tem a mesma auditoria (`audit()`), o mesmo `emit_event` e as mesmas
regras de negócio de um contato criado pela tela — sem duplicar nenhuma
delas.

## Contrato

```
POST /api/retrix/clientes
Authorization: Bearer <RETRIX_CLIENTES_SECRET>
Content-Type: application/json

{
  "clientes": [
    {
      "ref": "caz_3f9a...",              // hash estável gerado pelo Portal — chave de casamento
      "nome": "Nome do cliente",
      "resumo": {                         // opcional
        "em_aberto": 1234.56,
        "vencido": 0,
        "proximo_vencimento": "2026-10-05", // ou null — opcional
        "atualizado_em": "2026-09-23T09:00:00.000Z"
      }
    }
  ]
}
```

- No máximo **500** clientes por chamada; corpo `.strict()` (campo
  desconhecido é `422`).
- Resposta de sucesso: `{ "data": { "criados": N, "atualizados": N, "erros": N } }`
  — nunca a lista de nomes, só a contagem.
- `401` credencial inválida/ausente; `404` recurso desligado (sem o
  segredo); `422` corpo inválido; `429` rate limit de falhas por IP; `500`
  falha inesperada ou organização de destino não configurada.

## O que a rota faz com cada cliente

Organização de destino: `RETRIX_SSO_ORG_SLUG` (a MESMA variável que a ponte
de SSO já usa — a organização Retrix é uma só; default `retrix`).

Para cada item do lote (`lib/retrix/clientes.ts#sincronizarClientesRetrix`,
nunca deixando uma falha derrubar o lote inteiro):

1. Procura um contato da organização com `custom_fields->>'retrix_ref' = ref`
   (não filtra contato já mesclado/absorvido — `is_merged_into is null`).
   Não existe coluna `external_id` em `contacts` (só em `leads`/`orders`/
   `messages`), então a chave estável mora dentro do `custom_fields` jsonb
   livre, como o resto desta integração já faz.
2. **Não achou** → cria via `createContactHandler`, com:
   - `tags: ["cliente conta azul"]` (o CRM normaliza para minúsculo de
     qualquer forma — `normalizarTags` —, mas já nasce assim);
   - `source: "retrix_conta_azul"`;
   - `custom_fields: { retrix_ref, retrix_resumo_financeiro? }`.
3. **Achou** → atualiza (`patchContactHandler`) **só**
   `custom_fields.retrix_resumo_financeiro` (mesclando com o que já existia
   em `custom_fields` — nunca substitui as demais chaves) e o `name`, só se
   mudou. Se nada realmente mudou, conta como "atualizado" sem gastar um
   `UPDATE`/audit à toa.

O ator de todas as escritas é um literal fixo,
`{ type: "api_token", id: "retrix-clientes-sync", role: "agent" }` — não uma
linha de verdade em `api_tokens` (nada valida essa FK; o comentário de
`lib/api/handlers/types.ts` já cita o precedente de um id literal fixo, `
"agent-engine"`, para o mesmo propósito). O cliente Supabase usado é sempre
o **admin** (service role) — não porque o ator seja privilegiado, mas porque
não há sessão de usuário para RLS nenhuma; mesmo arranjo que
`app/api/retrix/sso/route.ts` já usa para o resto do fluxo.

## Segurança

- **Bearer fixo, tempo constante**: `Authorization: Bearer <segredo>`
  comparado com `timingSafeStringEqual` (`lib/auth/cron-auth.ts`, já usado
  por `POST /api/v1/system/agent` — reuso, não duplicação).
- **Rate limit por IP, só sobre falhas** (`lib/ai/dispatcher/rate-limit.ts`):
  20/min — o chamador legítimo (o cron do Portal) nunca esbarra nisto.
- **Nunca loga nome de cliente por inteiro** — nem em erro de validação (só
  a CONTAGEM de problemas do zod), nem em falha de sincronização
  (`mascararNomeParaLog`/`mascararMensagemDeErro` em `lib/retrix/clientes.ts`
  mascaram qualquer nome antes de ir para `logger.warn`/`logger.error`).
- **Nunca loga o Bearer**, nem no corpo de erro nem no log.
- Corpo `.strict()` e teto de 500 itens — nenhum campo extra passa
  despercebido, nenhum lote gigante prende a requisição.

## Variável de ambiente

| Variável                 | Obrigatória                       | Descrição                                                                                                                                                                                                            |
| ------------------------ | --------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RETRIX_CLIENTES_SECRET` | sim (senão a rota responde `404`) | Bearer fixo que a Edge Function do Portal envia. Gere com `openssl rand -base64 32` e configure o MESMO valor como `CRM_CLIENTES_SECRET` do lado do Portal (`supabase/functions/crm-sync-clientes` — repo separado). |
| `RETRIX_SSO_ORG_SLUG`    | não (default `retrix`)            | Já existe para a ponte de SSO — reaproveitada aqui como a organização de destino dos contatos.                                                                                                                       |

Não está em `lib/env.ts` nem em `.env.example`, pela mesma razão do resto de
`lib/retrix/*`: o contrato de env do produto upstream nunca precisa saber
que esta integração existe.

## Testes

`lib/retrix/clientes.test.ts` (helpers puros e a orquestração, com um admin
client falso — mesmo estilo de `lib/retrix/usuario.test.ts`) e
`app/api/retrix/clientes/route.test.ts` (ordem das guardas HTTP, com
`clientesPayloadSchema` REAL, não mockado). Só nomes fictícios. Rodar:

```bash
npx vitest run lib/retrix/clientes.test.ts app/api/retrix/clientes/route.test.ts lib/auth/public-paths.test.ts
```

## Questão em aberto

Uma homonímia real — dois clientes distintos com o mesmo nome no Conta Azul —
não é o problema que esta rota resolve: o casamento é por `ref` (hash do
nome normalizado, gerado pelo Portal), então dois clientes homônimos
recebem `ref`s diferentes só se o Portal já os distinguir de alguma forma
além do nome. Como a normalização do Portal hoje é só "nome, minúsculo,
espaços colapsados", dois clientes de mesmo nome no Conta Azul colidem no
MESMO contato aqui. Aceitável para o volume esperado desta operação, mas
vale confirmar com o dono do produto se isso é tolerável antes de ligar em
produção.
