import { describe, expect, it } from "vitest";

import {
  horaLocal,
  inicioDoDiaDaCampanha,
  podeMandarAgora,
  proximaTentativa,
  type RitmoDaCampanha,
} from "./ritmo";

const FUSO = "America/Sao_Paulo";
/** 10h em São Paulo (UTC-3). */
const DEZ_DA_MANHA = new Date("2026-09-18T13:00:00.000Z");
/** 23h em São Paulo. */
const ONZE_DA_NOITE = new Date("2026-09-19T02:00:00.000Z");

const SEM_RITMO: RitmoDaCampanha = {
  intervaloSegundos: null,
  janelaInicioHora: null,
  janelaFimHora: null,
  tetoDiario: null,
  tetoHorario: null,
};

const PARADO = { ultimoEnvio: null, enviadasHoje: 0, enviadasNaUltimaHora: 0 };

describe("ritmo próprio da campanha", () => {
  it("sem configuração nenhuma, não veta: quem não configurou herda o canal", () => {
    expect(podeMandarAgora(SEM_RITMO, PARADO, DEZ_DA_MANHA, FUSO)).toEqual({ pode: true });
  });

  it("teto diário fecha o dia", () => {
    const r = podeMandarAgora(
      { ...SEM_RITMO, tetoDiario: 30 },
      { ...PARADO, enviadasHoje: 30 },
      DEZ_DA_MANHA,
      FUSO,
    );
    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.motivo).toBe("teto_diario");
  });

  it("teto horário segura sem fechar o dia", () => {
    const r = podeMandarAgora(
      { ...SEM_RITMO, tetoHorario: 10 },
      { ...PARADO, enviadasNaUltimaHora: 10 },
      DEZ_DA_MANHA,
      FUSO,
    );
    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.motivo).toBe("teto_horario");
  });

  it("a janela é avaliada no FUSO do canal, não no do servidor", () => {
    const ritmo = { ...SEM_RITMO, janelaInicioHora: 8, janelaFimHora: 20 };
    expect(podeMandarAgora(ritmo, PARADO, DEZ_DA_MANHA, FUSO)).toEqual({ pode: true });
    const fora = podeMandarAgora(ritmo, PARADO, ONZE_DA_NOITE, FUSO);
    expect(fora.pode).toBe(false);
    if (!fora.pode) expect(fora.motivo).toBe("fora_da_janela");
    // Mesmo instante, outro fuso: 02h em UTC também está fora, mas 23h em SP
    // seria DENTRO de uma janela até 24 — a régua tem de ser o fuso pedido.
    expect(horaLocal(ONZE_DA_NOITE, FUSO)).toBe(23);
    expect(horaLocal(ONZE_DA_NOITE, "UTC")).toBe(2);
  });

  it("a hora de FIM é exclusiva: às 20h em punto já está fora de 8h-20h", () => {
    const vinteEmPunto = new Date("2026-09-18T23:00:00.000Z");
    const r = podeMandarAgora(
      { ...SEM_RITMO, janelaInicioHora: 8, janelaFimHora: 20 },
      PARADO,
      vinteEmPunto,
      FUSO,
    );
    expect(r.pode).toBe(false);
  });

  it("intervalo mínimo conta do último envio", () => {
    const ritmo = { ...SEM_RITMO, intervaloSegundos: 300 };
    const ha100s = new Date(DEZ_DA_MANHA.getTime() - 100_000);
    const r = podeMandarAgora(ritmo, { ...PARADO, ultimoEnvio: ha100s }, DEZ_DA_MANHA, FUSO);
    expect(r.pode).toBe(false);
    if (!r.pode) {
      expect(r.motivo).toBe("intervalo");
      expect(r.detalhe).toContain("200s");
    }
    const ha400s = new Date(DEZ_DA_MANHA.getTime() - 400_000);
    expect(podeMandarAgora(ritmo, { ...PARADO, ultimoEnvio: ha400s }, DEZ_DA_MANHA, FUSO).pode).toBe(true);
  });

  it("primeiro envio do dia não espera intervalo nenhum", () => {
    const ritmo = { ...SEM_RITMO, intervaloSegundos: 3600 };
    expect(podeMandarAgora(ritmo, PARADO, DEZ_DA_MANHA, FUSO).pode).toBe(true);
  });

  it("o teto diário é verificado ANTES da janela — 'hoje acabou' é mais útil que 'fora do horário'", () => {
    const r = podeMandarAgora(
      { ...SEM_RITMO, tetoDiario: 5, janelaInicioHora: 8, janelaFimHora: 20 },
      { ...PARADO, enviadasHoje: 5 },
      ONZE_DA_NOITE,
      FUSO,
    );
    expect(r.pode).toBe(false);
    if (!r.pode) expect(r.motivo).toBe("teto_diario");
  });

  it("espera não é falha: cada motivo devolve um horário para tentar de novo", () => {
    const agora = DEZ_DA_MANHA;
    expect(proximaTentativa({ pode: true }, agora)).toBeNull();
    const intervalo = proximaTentativa({ pode: false, motivo: "intervalo", detalhe: "" }, agora)!;
    const janela = proximaTentativa({ pode: false, motivo: "fora_da_janela", detalhe: "" }, agora)!;
    expect(intervalo.getTime()).toBeGreaterThan(agora.getTime());
    // Quem espera a janela não precisa ser reconsultado de minuto em minuto.
    expect(janela.getTime()).toBeGreaterThan(intervalo.getTime());
  });
});

describe("o dia do teto diário é o dia do CLIENTE, não o dia UTC", () => {
  // 21h30 em São Paulo (UTC-3) é 00h30 do dia seguinte em UTC. É o instante
  // exato do defeito: o dia UTC já virou, o dia local não, e a janela de
  // 7h-22h ainda está aberta — sobra meia hora de envio.
  const VINTE_E_UMA_E_MEIA = new Date("2026-09-19T00:30:00.000Z");
  const JANELA_E_TETO: RitmoDaCampanha = {
    intervaloSegundos: null,
    janelaInicioHora: 7,
    janelaFimHora: 22,
    tetoDiario: 100,
    tetoHorario: null,
  };

  /** O que a rodada faz: conta o que saiu desde o começo do dia e pergunta ao ritmo. */
  function vetoDaRodada(envios: Date[], agora: Date, fuso: string) {
    const inicio = inicioDoDiaDaCampanha(agora, fuso);
    const hoje = envios.filter((d) => d.getTime() >= inicio.getTime());
    return podeMandarAgora(
      JANELA_E_TETO,
      { ultimoEnvio: hoje[hoje.length - 1] ?? null, enviadasHoje: hoje.length, enviadasNaUltimaHora: 0 },
      agora,
      fuso,
    );
  }

  it("às 21h30 o dia local ainda não virou: o começo do dia é 00h LOCAL, não a meia-noite UTC", () => {
    // 2026-09-19T00:30Z é 18/09 às 21h30 em São Paulo ⇒ o dia começou
    // em 18/09 00h local = 2026-09-18T03:00Z. A meia-noite UTC do
    // instante (2026-09-19T00:00Z) é 30 minutos ATRÁS — dentro do dia local.
    expect(inicioDoDiaDaCampanha(VINTE_E_UMA_E_MEIA, FUSO).toISOString()).toBe(
      "2026-09-18T03:00:00.000Z",
    );
  });

  it("uma campanha que bateu o teto diário NÃO volta a enviar às 21h30", () => {
    // 100 envios ao longo do dia local de 18/09, o último às 20h (23h UTC),
    // todos ANTES da meia-noite UTC — é isso que o contador em UTC perde.
    const envios = Array.from(
      { length: 100 },
      (_, i) => new Date(Date.UTC(2026, 8, 18, 13, 0, 0) + i * 60_000),
    );
    const veto = vetoDaRodada(envios, VINTE_E_UMA_E_MEIA, FUSO);

    expect(veto.pode).toBe(false);
    if (!veto.pode) expect(veto.motivo).toBe("teto_diario");
  });

  it("no dia local SEGUINTE o teto realmente zera — o conserto não trava a campanha para sempre", () => {
    const envios = Array.from(
      { length: 100 },
      (_, i) => new Date(Date.UTC(2026, 8, 18, 13, 0, 0) + i * 60_000),
    );
    // 19/09 às 10h em São Paulo: dia local novo, teto zerado.
    const amanha = new Date("2026-09-19T13:00:00.000Z");
    expect(vetoDaRodada(envios, amanha, FUSO)).toEqual({ pode: true });
  });
});
