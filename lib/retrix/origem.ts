/**
 * `POST /api/retrix/sso` não carrega cookie de sessão (é ele que CRIA a
 * sessão) — então a proteção contra CSRF do resto do produto (cookie
 * `sameSite: "strict"`) não se aplica aqui, e o corpo carrega um access_token
 * de verdade. A defesa é o cabeçalho `Origin`: navegador manda em toda
 * requisição POST (inclusive same-origin, desde a revisão do Fetch standard
 * que passou a incluí-lo sempre — não é exclusividade de CORS), e só o
 * PRÓPRIO CRM pode gerar uma navegação cujo `Origin` bate com o dele mesmo.
 *
 * Falha fechada: `Origin` ausente (cliente antigo, curl sem o header,
 * requisição forjada que omite de propósito) NÃO passa. Um site legítimo
 * nunca deixaria de mandar o header — a ausência é, ela mesma, o sinal.
 */

/** `origin` cru do header contra a origem canônica do próprio app (`NEXT_PUBLIC_APP_URL`). */
export function origemBateComOApp(origemDoPedido: string | null, appUrl: string): boolean {
  if (!origemDoPedido) return false;
  try {
    const pedido = new URL(origemDoPedido);
    const app = new URL(appUrl);
    // `.origin` normaliza porta default (443/80) e ignora path/query — dois
    // jeitos de escrever a MESMA origem (`https://x` vs `https://x/`) não
    // podem divergir por causa disso.
    return pedido.origin === app.origin;
  } catch {
    // Origin malformado (não é URL válida) nunca é a origem certa.
    return false;
  }
}
