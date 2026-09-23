/**
 * "Este e-mail pode entrar pela ponte SSO?" — só quem termina em um dos
 * domínios de `RETRIX_SSO_DOMINIOS` (ver `lib/retrix/env.ts`).
 *
 * Confere a FRONTEIRA do domínio (`@dominio`), não substring: sem isso
 * `r3xconsultoria.com` "aceitaria" `alguem@nao-r3xconsultoria.com` (contém a
 * string) ou `alguem@r3xconsultoria.com.evil.test` (termina em coisa
 * diferente, mas contém). As duas são domínios DIFERENTES — negá-los aqui é
 * o mesmo trabalho que os schemas de e-mail deste repo fazem, só que contra
 * uma lista dinâmica de domínios em vez de literal.
 */
export function dominioPermitido(email: string, dominios: readonly string[]): boolean {
  const emailNormalizado = email.trim().toLowerCase();
  const arroba = emailNormalizado.lastIndexOf("@");
  if (arroba <= 0 || arroba === emailNormalizado.length - 1) return false;
  const dominioDoEmail = emailNormalizado.slice(arroba + 1);
  return dominios.some((d) => dominioDoEmail === d.trim().toLowerCase());
}
