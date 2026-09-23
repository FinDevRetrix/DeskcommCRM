/**
 * PUBLIC_PATHS decide quem atravessa o proxy sem sessão em toda a aplicação
 * (`proxy.ts`). Sem teste, uma âncora `$` trocada por prefixo, ou uma entrada
 * larga demais, some em silêncio do CI — foi exatamente o bug achado provando
 * a Task 6 (heartbeat do agente bloqueado por faltar aqui).
 */
import { describe, it, expect } from "vitest";

import { isPublicPath } from "@/lib/auth/public-paths";

describe("isPublicPath", () => {
  it("libera o heartbeat do agente do host (bearer, sem cookie)", () => {
    expect(isPublicPath("/api/v1/system/agent")).toBe(true);
  });

  it("libera o tick do relógio Hobby (bearer, sem cookie)", () => {
    expect(isPublicPath("/api/v1/system/relogio/tick")).toBe(true);
    expect(isPublicPath("/api/v1/system/relogio")).toBe(false);
    expect(isPublicPath("/api/v1/system/relogio/tick/extra")).toBe(false);
  });

  it("a âncora `$` impede que um sub-path passe de carona", () => {
    expect(isPublicPath("/api/v1/system/agent/qualquer")).toBe(false);
  });

  it("não libera a rota de pedido de atualização (exige sessão do dono)", () => {
    expect(isPublicPath("/api/v1/system/update")).toBe(false);
  });

  it("não libera a rota de estado da versão (exige sessão)", () => {
    expect(isPublicPath("/api/v1/system/version")).toBe(false);
  });

  /**
   * Os documentos legais são linkados do checkbox OBRIGATÓRIO da primeira tela
   * do produto (`/onboarding/welcome`). Fora daqui, `proxy.ts` manda o visitante
   * para `/login?next=/legal/terms` — e um aceite de termos que só se lê depois
   * de ter conta é um aceite que ninguém pode conferir antes de aceitar.
   */
  it("libera os documentos legais — o aceite acontece antes de existir conta", () => {
    expect(isPublicPath("/legal/terms")).toBe(true);
    expect(isPublicPath("/legal/privacy")).toBe(true);
  });

  it("e só esses dois: /legal não é um portão aberto", () => {
    // Entrada larga aqui é furo de auth em toda a aplicação, não só nesta tela.
    expect(isPublicPath("/legal")).toBe(false);
    expect(isPublicPath("/legal/terms/interno")).toBe(false);
    expect(isPublicPath("/legal/qualquer-outra")).toBe(false);
  });

  /**
   * Ponte de login com o Portal Central Retrix (`lib/retrix/`). As duas rotas
   * nunca têm cookie de sessão nossa por definição — é o handshake delas que
   * cria a sessão — e a auth de verdade mora DENTRO de cada uma.
   */
  it("libera a tela e a rota da ponte de login Retrix", () => {
    expect(isPublicPath("/retrix/entrar")).toBe(true);
    expect(isPublicPath("/api/retrix/sso")).toBe(true);
  });

  it("a âncora `$` das duas rotas Retrix impede sub-path de carona", () => {
    expect(isPublicPath("/retrix/entrar/qualquer")).toBe(false);
    expect(isPublicPath("/retrix")).toBe(false);
    expect(isPublicPath("/api/retrix/sso/qualquer")).toBe(false);
    expect(isPublicPath("/api/retrix")).toBe(false);
  });
});
