"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

/** Repete o "estou pronto" a cada 300ms — o Portal pode montar a resposta antes ou depois deste listener existir. */
const INTERVALO_PRONTO_MS = 300;
/** Sem resposta do Portal neste prazo, é engano assumir que ela ainda vai chegar. */
const TIMEOUT_MS = 10_000;

type MensagemDeSessao = { type: "retrix-crm-sessao"; access_token: string };

/** Forma exata esperada — qualquer campo a mais/a menos, ou tipo errado, é ignorado (não tratado como erro: pode ser ruído de outra mensagem `postMessage` na mesma aba). */
function ehMensagemDeSessao(data: unknown): data is MensagemDeSessao {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.type === "retrix-crm-sessao" && typeof d.access_token === "string" && d.access_token.length > 0;
}

type Estado = "aguardando" | "entrando" | "falhou";

/**
 * O handshake completo do lado do CRM:
 *
 *  1. Anuncia "pronto" pro `window.opener` (o Portal), repetindo — sem saber
 *     se o listener do Portal já está de pé quando este componente monta.
 *  2. Escuta `message`, validando origem E `source` (não confia em conteúdo
 *     de mensagem sem confirmar QUEM mandou) antes de olhar o formato.
 *  3. Ao receber a sessão, para de escutar/anunciar imediatamente — a
 *     mensagem é de uso único — e troca o token por sessão via
 *     `POST /api/retrix/sso`.
 *  4. Sucesso: navegação same-origin (`location.replace`, nunca `fetch` ou
 *     `router.push`) — é o que faz o cookie `SameSite=Strict` recém-gravado
 *     valer na navegação seguinte.
 *  5. Qualquer desvio (sem `opener`, sem `portalOrigin` configurado, timeout,
 *     mensagem de formato errado, POST que falhou) cai no MESMO fallback:
 *     link para o `/login` normal. Nunca trava a pessoa numa tela muda.
 */
export function EntrarClient({ portalOrigin }: { portalOrigin: string | null }) {
  // Derivado da PROP (mesmo valor no servidor e no cliente — sem isso o
  // primeiro render do cliente divergiria do HTML do servidor): sem
  // `portalOrigin` configurado não há handshake possível, e isto já se sabe
  // antes de qualquer efeito rodar.
  const [estado, setEstado] = useState<Estado>(portalOrigin ? "aguardando" : "falhou");
  // Guarda contra tratar a MESMA sessão duas vezes (mensagem duplicada,
  // timeout disparando depois de já ter recebido) — sem isto, um evento tardio
  // reabriria o POST já em voo ou sobrescreveria "entrando" de volta.
  const concluidoRef = useRef(false);

  useEffect(() => {
    if (!portalOrigin) return; // estado inicial já é "falhou" — nada a fazer.
    if (typeof window === "undefined" || !window.opener) {
      // Ninguém abriu esta aba via `window.open` — não há para quem pedir a
      // sessão. Acontece com link direto, aba recarregada, ou robô.
      setEstado("falhou");
      return;
    }
    const opener = window.opener as Window;

    function pararDeEscutar() {
      window.clearInterval(intervalId);
      window.clearTimeout(timeoutId);
      window.removeEventListener("message", aoReceberMensagem);
    }

    async function trocarPorSessao(accessToken: string) {
      setEstado("entrando");
      try {
        const resposta = await fetch("/api/retrix/sso", {
          method: "POST",
          credentials: "same-origin",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ access_token: accessToken }),
        });
        if (!resposta.ok) {
          setEstado("falhou");
          return;
        }
        // `location.replace`, não `router.push`: precisa ser navegação de
        // verdade para o cookie `sb-deskcomm-auth` (SameSite=Strict, acabou
        // de ser gravado pelo `Set-Cookie` da resposta) valer no próximo GET.
        window.location.replace("/");
      } catch {
        setEstado("falhou");
      }
    }

    function aoReceberMensagem(event: MessageEvent) {
      if (concluidoRef.current) return;
      // As DUAS provas de quem mandou — origem E a referência exata da janela
      // que abriu esta aba. Confiar só em `event.origin` aceitaria mensagem de
      // QUALQUER aba/iframe daquela origem, não só do Portal que nos abriu.
      if (event.origin !== portalOrigin) return;
      if (event.source !== opener) return;
      if (!ehMensagemDeSessao(event.data)) return;

      concluidoRef.current = true;
      pararDeEscutar();
      void trocarPorSessao(event.data.access_token);
    }

    function anunciarPronto() {
      try {
        opener.postMessage({ type: "retrix-crm-pronto" }, portalOrigin as string);
      } catch {
        // `portalOrigin` malformado como target origin nunca deveria
        // acontecer (vem de env já validado em `lib/retrix/env.ts`), mas um
        // `postMessage` que lança não pode derrubar a tela.
      }
    }

    window.addEventListener("message", aoReceberMensagem);
    anunciarPronto(); // primeira tentativa já no mount, sem esperar 300ms
    const intervalId = window.setInterval(anunciarPronto, INTERVALO_PRONTO_MS);
    const timeoutId = window.setTimeout(() => {
      if (concluidoRef.current) return;
      concluidoRef.current = true;
      pararDeEscutar();
      setEstado("falhou");
    }, TIMEOUT_MS);

    return pararDeEscutar;
  }, [portalOrigin]);

  return (
    <main className="flex min-h-screen items-center justify-center p-8">
      <Card className="w-full max-w-sm">
        <CardHeader className="items-center text-center">
          <CardTitle>
            {estado === "falhou" ? "Não foi possível entrar automaticamente" : "Entrando…"}
          </CardTitle>
        </CardHeader>
        <CardContent className="text-center">
          {estado === "falhou" ? (
            <>
              <p className="text-sm text-text-muted">
                Não conseguimos confirmar sua sessão do Portal Central Retrix. Você pode entrar
                normalmente com seu e-mail e senha.
              </p>
              <Button asChild className="mt-6">
                <Link href="/login">Ir para o login</Link>
              </Button>
            </>
          ) : (
            <p className="text-sm text-text-muted">Conectando com o Portal Central Retrix…</p>
          )}
        </CardContent>
      </Card>
    </main>
  );
}
