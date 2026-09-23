# Ponte de login com o Portal Central Retrix

Este diretório — e os dois arquivos irmãos fora dele,
`app/retrix/entrar/{page,entrar-client}.tsx` e
`app/api/retrix/sso/route.ts` — implementam um SSO ("single sign-on") de mão
única entre o **Portal Central Retrix** (app separado, com o **próprio**
projeto Supabase, senha + TOTP obrigatório) e este CRM: um parceiro já
logado no Portal clica em "CRM" e cai logado aqui, sem digitar senha de novo.

**Por que tudo mora isolado aqui.** Este repositório é um fork de um produto
open source (upstream: `melgarafael/DeskcommCRM`) e este fork (Retrix)
recebe atualizações dele com frequência. Toda a lógica desta integração vive
em arquivos NOVOS — nunca em arquivos do produto original — para que um
`git merge`/`git rebase` do upstream nunca precise resolver conflito aqui.
As duas únicas exceções são duas linhas (mais os comentários que as
explicam) em `lib/auth/public-paths.ts`, que precisam existir para o
`proxy.ts` não exigir sessão antes de essas duas rotas rodarem — ver o
comentário ali.

## O fluxo, passo a passo

```
Portal (aal2, TOTP provado)                         CRM (este app)
──────────────────────────────                      ──────────────────────────────
1. window.open("https://crm/…/retrix/entrar")  ───▶  2. app/retrix/entrar/page.tsx
   (o Portal guarda a referência da janela)              lê RETRIX_PORTAL_ORIGIN no
                                                          servidor e entrega como prop
                                                          para entrar-client.tsx
                                                       3. a cada 300ms (até 10s):
                                                          opener.postMessage(
                                                            {type:"retrix-crm-pronto"},
                                                            portalOrigin)
4. ao ouvir "retrix-crm-pronto", o Portal manda:
   janela.postMessage(
     {type:"retrix-crm-sessao", access_token},
     "https://crm")                             ───▶  5. valida event.origin ===
                                                          portalOrigin E event.source
                                                          === window.opener E o formato
                                                          da mensagem; para de escutar
                                                       6. POST /api/retrix/sso
                                                          { access_token }
                                                       7. rota valida tudo (abaixo) e,
                                                          se passar, grava os cookies
                                                          de sessão do CRM na resposta
                                                       8. window.location.replace("/")
                                                          — navegação same-origin, é o
                                                          que faz o cookie
                                                          SameSite=Strict valer
```

Nunca há token na URL, nunca há POST cross-site: tudo passa por
`postMessage` (com origem e `source` checados nos dois sentidos) e por um
`fetch` same-origin de dentro da própria aba do CRM.

## O que `POST /api/retrix/sso` confere, em ordem

1. **Recurso ligado** — sem as 4 variáveis críticas (abaixo), a rota responde
   `404` para qualquer requisição. Instalação que nunca configurou a Retrix
   nunca tem esta porta aberta.
2. **Rate limit por IP**, contando só falhas (`lib/ai/dispatcher/rate-limit.ts`,
   o mesmo mecanismo de `POST /api/v1/tenants/provision`).
3. **Origem do pedido** — o header `Origin` do POST precisa bater com
   `NEXT_PUBLIC_APP_URL` (o próprio CRM). Esta rota não tem cookie de sessão
   prévio para se apoiar (é ela que cria a sessão), então a origem é a única
   barreira contra outro site tentando falar com ela.
4. **Content-Type e tamanho do corpo** (json, corpo pequeno, token de
   tamanho plausível) — antes de gastar CPU tentando decodificar qualquer
   coisa.
5. **O token, verificado contra o Supabase do PORTAL**:
   `GET {RETRIX_CENTRAL_SUPABASE_URL}/auth/v1/user` com
   `apikey: RETRIX_CENTRAL_SUPABASE_ANON_KEY` e
   `Authorization: Bearer <token>`. É o PRÓPRIO GoTrue do Portal validando a
   assinatura e a expiração do JWT que ele mesmo assinou — a única fonte de
   verdade sobre isso nesta ponte. Um 200 aqui, com e-mail confirmado, é o
   que autoriza tudo que vem depois.
6. **`aal2`** — decodificado do PAYLOAD do mesmo token (sem reverificar
   assinatura: já foi verificada no passo 5). `aal2` só existe quando o
   Portal exigiu e confirmou o segundo fator NESTA sessão — é a garantia de
   que quem está do outro lado passou pelo TOTP do Portal, não só pela
   senha.
7. **Domínio do e-mail** em `RETRIX_SSO_DOMINIOS` (lista separada por
   vírgula, case-insensitive, comparada pela fronteira do domínio — não por
   substring).
8. **Identidade no CRM** (`lib/retrix/usuario.ts`): busca o usuário por
   e-mail no Supabase do CRM (service role).
   - Se existe: exige vínculo ATIVO (`user_organizations.revoked_at is
     null`) em alguma organização — senão `403`.
   - Se não existe: só cria se `RETRIX_SSO_AUTOPROVISIONAR=true` — senha
     aleatória (nunca devolvida a ninguém; a sessão sai por magic link, não
     por senha), `email_confirm: true` (o Portal já provou a posse do
     e-mail — pedir confirmação de novo aqui duplicaria uma verificação que
     já aconteceu do outro lado). O vínculo criado usa a organização de
     `RETRIX_SSO_ORG_SLUG` e o papel de `RETRIX_SSO_PAPEL`.
9. **Sessão do CRM**: `admin.auth.admin.generateLink({type:"magiclink",
   email})` → `properties.hashed_token` → o cliente SSR canônico de rota
   (`lib/supabase/server.ts`, o MESMO usado no resto do produto — nome do
   cookie `sb-deskcomm-auth`, `httpOnly`, `Secure`, `SameSite=Strict`
   idênticos) → `supabase.auth.verifyOtp({type:"magiclink", token_hash})`,
   que grava os cookies de sessão na resposta. `generateLink` NUNCA envia
   e-mail — só gera o token; quem enviaria seria `signInWithOtp`, que este
   fluxo nunca chama.

Qualquer falha responde um erro genérico (`{error:{code,message}}`, o
mesmo formato de todo o resto da API) — nunca ecoa o token, nunca ecoa o
e-mail completo (mascarado via `lib/lgpd/mask.ts` nos logs).

## Variáveis de ambiente

Todas opcionais na instalação — sem as quatro primeiras, a integração fica
**desligada** (a rota responde 404, a página cai direto no link para
`/login`). Não existem em `lib/env.ts` de propósito: são lidas direto de
`process.env` dentro de `lib/retrix/env.ts`, para o contrato de env do
produto upstream nunca precisar saber que esta integração existe.

| Variável | Obrigatória | Exemplo | Descrição |
|---|---|---|---|
| `RETRIX_PORTAL_ORIGIN` | sim | `https://central-retrix2-0.vercel.app` | Origem exata do Portal — sem barra final. É a única enviada ao navegador (como prop de Server Component, nunca via `NEXT_PUBLIC_*` — ver o cabeçalho de `app/retrix/entrar/page.tsx`). |
| `RETRIX_CENTRAL_SUPABASE_URL` | sim | `https://xxxx.supabase.co` | URL do projeto Supabase do **Portal** (não é o Supabase deste CRM). |
| `RETRIX_CENTRAL_SUPABASE_ANON_KEY` | sim | — | `anon key` do projeto Supabase do Portal. Só valida token (`GET /auth/v1/user`); nunca abre RLS do Portal a partir daqui. |
| `RETRIX_SSO_DOMINIOS` | sim | `r3xconsultoria.com` | Domínios de e-mail aceitos, separados por vírgula. |
| `RETRIX_SSO_AUTOPROVISIONAR` | não (default `false`) | `true` | Só o literal `"true"` liga. Qualquer outra coisa (`"1"`, ausente, erro de digitação) fica desligado — falha fechada. |
| `RETRIX_SSO_ORG_SLUG` | não (default `retrix`) | `retrix` | Slug da organização (`organizations.slug`) onde o autoprovisionamento cria o vínculo. Precisa existir — senão a rota responde `500` e loga o motivo. |
| `RETRIX_SSO_PAPEL` | não (default `agent`) | `agent` | Papel atribuído ao autoprovisionar. Ver a nota abaixo sobre o default. |

Estas chaves não estão em `.env.example` para manter o merge de upstream
limpo — copie-as para o `.env`/`.env.local` da instalação Retrix.

### Por que o papel default é `agent`, não `admin`

`user_organizations.role` aceita `viewer`, `agent`, `manager`, `admin`
(`lib/auth/types.ts`, espelhando o `CHECK` do banco). `agent` — "Atendente"
— é o menor papel que ainda dá acesso operacional normal ao CRM (conversas,
leads); `viewer` é só leitura e não serviria para um parceiro trabalhar.
`admin` abre convite de time, criação de token de API, LGPD e credenciais —
poder demais para o default de uma conta que nasce sozinha, sem ninguém do
lado do CRM aprovando. Um operador que sabe o que está fazendo pode
sobrescrever com `RETRIX_SSO_PAPEL=admin`; `carregarConfigRetrixSso()`
valida contra os quatro papéis do enum e cai para `agent` (com aviso no log)
se o valor não for um deles — nunca vira `admin` por erro de digitação.

## Sobre o MFA do CRM — o que esta ponte NÃO faz

O CRM tem o **próprio** gate de MFA (`lib/auth/server.ts:mfaEmDivida`,
aplicado por `requireRole()` em toda rota `/api/v1/*` que exige um papel
mínimo): se a pessoa já tem um fator TOTP **cadastrado no CRM** (um fator
totalmente separado do TOTP do Portal — são dois projetos Supabase
diferentes) e a sessão atual está em `aal1`, rotas que exigem papel
suficiente respondem `403 mfa_required` até ela provar o TOTP **do CRM**
de novo.

A sessão que esta ponte cria é sempre `aal1` (magic link não produz `aal2`
neste Supabase — o `aal2` provado foi no Supabase do Portal, um projeto
diferente, e não atravessa). Isto é esperado e correto, não uma falha desta
integração: **esta ponte nunca tenta elevar nem desligar o MFA do CRM** — ela
só entrega a pessoa autenticada, com o papel configurado. Quem nunca
cadastrou TOTP no CRM (o caminho comum para conta autoprovisionada) não
esbarra nisto. Quem já tem TOTP cadastrado no CRM independentemente desta
ponte continua sendo obrigado a prová-lo de novo para ações que exigem papel
alto — dois fatores, dois sistemas, por design.

## Arquivos

| Arquivo | O que é |
|---|---|
| `app/retrix/entrar/page.tsx` | Server Component fino — lê `RETRIX_PORTAL_ORIGIN` em runtime e entrega como prop. |
| `app/retrix/entrar/entrar-client.tsx` | Client Component — o handshake `postMessage` completo. |
| `app/api/retrix/sso/route.ts` | `POST` que fecha a ponte (passos 1–9 acima). |
| `lib/retrix/env.ts` | Lê e valida as variáveis `RETRIX_*` — `null` quando a integração está desligada. |
| `lib/retrix/origem.ts` | Confere o header `Origin` do POST contra `NEXT_PUBLIC_APP_URL`. |
| `lib/retrix/dominio.ts` | Confere se um e-mail termina em um dos domínios permitidos. |
| `lib/retrix/jwt.ts` | Decodifica (sem verificar assinatura — ver o cabeçalho do arquivo) o payload do JWT para ler `aal`. |
| `lib/retrix/portal.ts` | A chamada que verifica o token contra o Supabase do Portal. |
| `lib/retrix/usuario.ts` | Busca/cria o usuário e o vínculo no Supabase do CRM. |
| `*.test.ts` | Testes unitários (`vitest`) de cada peça acima. |

## Questão em aberto

Este README e a implementação assumem que o Portal Central sempre inclui a
claim `aal` no `access_token` que entrega via `postMessage` (comportamento
padrão do GoTrue quando a sessão passou por MFA) e que
`GET /auth/v1/user` do projeto do Portal devolve `email_confirmed_at`. As
duas coisas valem para qualquer projeto Supabase/GoTrue padrão, mas não
foram confirmadas contra o projeto Supabase REAL do Portal Central Retrix
(fora do alcance deste fork) — vale um teste manual ponta a ponta (abrir o
Portal, clicar em "CRM", conferir que a sessão chega `aal2` e que o cookie
`sb-deskcomm-auth` sai gravado) antes de ligar `RETRIX_SSO_AUTOPROVISIONAR`
em produção.
