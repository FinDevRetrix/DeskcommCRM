#!/usr/bin/env bash
# Atualiza ESTA VPS para o commit que o GitHub Actions acabou de publicar
# em ghcr.io/<dono>/…:develop. Não builda nada aqui — só puxa imagem pronta.
#
# Variáveis (vêm do job, não ficam no disco):
#   GH_TOKEN  GITHUB_TOKEN do job (login no GHCR + fetch do fork, se privado)
#   GH_USER   github.actor
#   SHA       commit que acabou de construir
#   DONO      dono do GHCR em minúsculas (ex.: iancouto)
#
# NÃO chame gravar_imagens: ela pinaria o namespace do upstream, que
# não é o registro deste fork.
set -euo pipefail

PROJECT_DIR="${PROJECT_DIR:-/root/deskcommcrm}"
SHA="${SHA:?falta SHA}"
DONO="${DONO:?falta DONO}"
GH_USER="${GH_USER:?falta GH_USER}"
GH_TOKEN="${GH_TOKEN:?falta GH_TOKEN}"

cleanup() {
  docker logout ghcr.io >/dev/null 2>&1 || true
}
trap cleanup EXIT

cd "$PROJECT_DIR"

# Uma atualização por vez. O mesmo arquivo que o agent.sh usa: se alguém
# clicar em "Atualizar agora" no meio, o segundo espera ou recusa.
exec 9> "${PROJECT_DIR}/.update.lock"
if ! flock -n 9; then
  echo "outro update já está rodando neste servidor — tente de novo em alguns minutos"
  exit 1
fi

# shellcheck source=../../hostgator-setup-kit/_common.sh
source "${PROJECT_DIR}/hostgator-setup-kit/_common.sh"
enter_project
recusar_projeto_de_outra_arvore \
  || die "Atualização interrompida para não quebrar a instalação que está no ar."

step "Backup de segurança (antes de mexer no banco)"
if bash "${PROJECT_DIR}/hostgator-setup-kit/backup.sh"; then
  c_grn "✓ backup feito"
else
  c_ylw "⚠ o backup falhou — sigo, mas o ideal é ter um. Continuo em 5s."
  sleep 5
fi

step "Login no registro de imagens"
printf '%s' "$GH_TOKEN" | docker login ghcr.io -u "$GH_USER" --password-stdin

step "Código deste commit"
# Repo público: fetch pela URL, sem token. Bearer no extraHeader faz o git
# cair no prompt de usuário na VPS (exit 128, "No such device or address").
GIT_TERMINAL_PROMPT=0 git fetch --depth 1 \
  "https://github.com/${DONO}/DeskcommCRM.git" "$SHA"
git reset --hard FETCH_HEAD

# Relê o kit DEPOIS do reset: o _common.sh deste commit é o que vale.
# shellcheck source=../../hostgator-setup-kit/_common.sh
source "${PROJECT_DIR}/hostgator-setup-kit/_common.sh"
enter_project

step "Apontar o app para as imagens deste fork"
set_env_var .env APP_IMAGE             "ghcr.io/${DONO}/deskcommcrm:develop"
set_env_var .env WORKER_IMAGE          "ghcr.io/${DONO}/deskcomm-worker:develop"
set_env_var .env SCHEDULER_IMAGE       "ghcr.io/${DONO}/deskcomm-scheduler:develop"
# Tag móvel: tem que puxar. Depois do pull, voltamos para missing — senão um
# `up -d` à mão, sem login no GHCR, morre quando o pacote ainda é privado.
set_env_var .env APP_PULL_POLICY       always
set_env_var .env WORKER_PULL_POLICY    always
set_env_var .env SCHEDULER_PULL_POLICY always
load_env .env

step "Atualizando o banco de dados"
if [ -f supabase/baseline.sql ]; then
  docker run --rm postgres:17-alpine psql "$(url_do_schema)" -c \
    "create extension if not exists vector with schema public; create extension if not exists citext with schema public; create extension if not exists pg_trgm with schema public;" \
    >/dev/null 2>&1 || true
  raw="$(docker run --rm -i -v "$PROJECT_DIR/supabase/baseline.sql:/b.sql:ro" \
        postgres:17-alpine psql "$(url_do_schema)" -f /b.sql 2>&1 || true)"
  benign='already exists|multiple primary keys|multiple default values|is already a member|already a partition'
  unexpected="$(printf '%s\n' "$raw" | grep -iE 'ERROR|FATAL' | grep -viE "$benign" || true)"
  if [ -n "$unexpected" ]; then
    c_ylw "⚠ avisos inesperados no banco:"
    printf '%s\n' "$unexpected" | head -20
  else
    c_grn "✓ banco atualizado"
  fi
else
  c_ylw "⚠ supabase/baseline.sql não encontrado — pulei a parte do banco."
fi

step "Baixando a imagem nova e reiniciando"
if ! dc pull; then
  die "Não consegui puxar as imagens ghcr.io/${DONO}/*:develop. O job publicou?"
fi
garantir_rede_do_proxy
dc up -d

if [ "${REVERSE_PROXY:-caddy}" = "traefik" ]; then
  c_grn "✓ proxy externo (Traefik): o Caddy não é usado aqui"
else
  dc up -d --force-recreate --no-deps caddy >/dev/null 2>&1 \
    && c_grn "✓ proxy recarregado" \
    || c_ylw "⚠ não consegui recriar o proxy"
fi

# Já está no disco desta VPS. Sem always, um up -d posterior não depende do GHCR.
set_env_var .env APP_PULL_POLICY       missing
set_env_var .env WORKER_PULL_POLICY    missing
set_env_var .env SCHEDULER_PULL_POLICY missing

step "Conferindo se o app voltou no ar"
if wait_app_healthy 20 3 >/dev/null; then
  c_grn "✓ deploy do ${SHA:0:7} no ar e saudável"
else
  c_ylw "⚠ atualizei, mas o app não respondeu ok. Veja: docker compose $(dc_files) logs --tail=50 app"
  exit 1
fi
