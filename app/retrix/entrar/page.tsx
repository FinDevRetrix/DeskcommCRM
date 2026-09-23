import { origemDoPortal } from "@/lib/retrix/env";
import { EntrarClient } from "./entrar-client";

/**
 * `/retrix/entrar` — o lado do CRM da "ponte de login" com o Portal Central
 * Retrix. Ver `lib/retrix/README.md` para o desenho completo do handshake.
 *
 * ── Por que este arquivo é um Server Component fino, e não a tela inteira ──
 *
 * A tela em si (o handshake `postMessage`, o fetch, o redirect) só pode
 * rodar no navegador — por isso vive em `entrar-client.tsx` ("use client").
 * Este arquivo existe só para entregar `RETRIX_PORTAL_ORIGIN` a ela como
 * PROP, lido no SERVIDOR.
 *
 * A variável não pode ganhar o prefixo `NEXT_PUBLIC_`: neste repo (self-host,
 * imagem Docker pré-buildada — ver o cabeçalho de `lib/branding.ts` e de
 * `app/public-env-script.tsx`) toda `NEXT_PUBLIC_*` é QUEIMADA no bundle
 * durante `next build`, com o valor do BUILD da imagem genérica — nunca o da
 * instalação de quem a roda. `RETRIX_PORTAL_ORIGIN` muda por operador (cada
 * instalação Retrix aponta para o portal dela), então precisa ser lida em
 * RUNTIME, no servidor, a cada request — exatamente o que este componente
 * faz (`lib/retrix/env.ts` lê `process.env` direto, sem passar por
 * `lib/env.ts`, para manter esta integração isolada do contrato de env do
 * upstream).
 *
 * `dynamic = "force-dynamic"` é o que garante o "a cada request": sem ele o
 * Next poderia pré-renderizar esta página como HTML estático em BUILD TIME
 * (não usa nenhuma API dinâmica por si só) e congelar para sempre o valor
 * lido durante a build da imagem — o mesmo problema que `<PublicEnvScript/>`
 * resolve para a URL do Supabase com `await headers()`.
 */
export const dynamic = "force-dynamic";

export default function EntrarPage() {
  const portalOrigin = origemDoPortal();
  return <EntrarClient portalOrigin={portalOrigin} />;
}
