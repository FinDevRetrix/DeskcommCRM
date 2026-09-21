/**
 * O RÓTULO DO BOTÃO DO GOOGLE NÃO PODE COMEÇAR COM "Entrar".
 *
 * ─── O defeito que este arquivo existe para não deixar voltar ────────────────
 *
 * 107 arquivos de `tests/e2e` fazem login com
 * `getByRole("button", { name: /entrar/i })` (117 ocorrências, medidas com
 * `grep -rn -F 'name: /entrar/i' tests/e2e`). O Playwright falha em STRICT MODE
 * quando um locator resolve a mais de um elemento — então, no dia em que a tela
 * de login ganhou um segundo botão chamado "Entrar com Google", o helper de
 * login da suíte parou de funcionar e TODA spec caiu antes da primeira
 * asserção. Medido no run 35537469070 da branch do PR #1401: 316 das 317
 * mensagens `Error:` eram literalmente essa colisão, e as cinco partes do e2e
 * somaram 304 casos reprovados.
 *
 * ─── Por que este teste, e não confiar no e2e ────────────────────────────────
 *
 * O e2e PEGA o defeito — foi ele que pegou. O que ele não faz é explicar: a
 * saída é um muro de 300 falhas em specs que não têm nada a ver com Google, e
 * quem lê conclui que o PR quebrou o produto inteiro. Este caso falha sozinho,
 * em segundos, dentro do `verify`, dizendo a palavra exata que não pode voltar.
 *
 * Mede o NOME ACESSÍVEL renderizado, pela mesma API que o Playwright usa
 * (`getByRole` + `name`), e não o texto-fonte: um rótulo montado por
 * concatenação, ou vindo do dicionário, escaparia de um `grep` e não escapa
 * daqui.
 */
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("@/app/actions/auth/signInWithGoogle", () => ({
  signInWithGoogle: vi.fn(async () => undefined),
}));

import { EntrarComGoogle } from "./EntrarComGoogle";

describe("rótulo do botão de entrada com Google", () => {
  it("não casa com o `/entrar/i` que 107 specs usam para logar", () => {
    render(<EntrarComGoogle />);

    // `hidden: true`: mede PRESENÇA no DOM, não exposição — o mesmo conjunto
    // que o strict mode do Playwright conta.
    const colisoes = screen.queryAllByRole("button", { name: /entrar/i, hidden: true });

    expect(
      colisoes.map((b) => b.textContent),
      'o botão do Google voltou a se chamar com a palavra "Entrar". Na tela de ' +
        "login isso faz `getByRole(\"button\", { name: /entrar/i })` resolver a DOIS " +
        "elementos, o Playwright falha em strict mode dentro do helper de login e a " +
        "suíte e2e inteira cai antes da primeira asserção (medido: 316 de 317 erros). " +
        'Use "Continuar com Google" — que também é a palavra certa, porque o mesmo ' +
        "botão CRIA conta na tela de cadastro.",
    ).toEqual([]);
  });

  it("o botão existe e se chama 'Continuar com Google' (controle positivo)", () => {
    // Sem este caso, apagar o botão deixaria o de cima verde: uma tela sem
    // botão nenhum também não colide com locator nenhum.
    render(<EntrarComGoogle />);
    expect(screen.getByRole("button", { name: "Continuar com Google" })).toBeInTheDocument();
  });
});
