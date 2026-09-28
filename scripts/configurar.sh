#!/usr/bin/env bash
#
# Só Armação — configura as variáveis de ambiente do checkout.
#
#   bash scripts/configurar.sh
#
# Gera os segredos, pergunta o resto sem ecoar na tela, grava o
# vercel-env.txt com permissão 600 e (se você quiser) envia pra Vercel.
# Nenhum valor passa pelo histórico do shell.

set -euo pipefail
umask 077

verde() { printf '\033[32m%s\033[0m\n' "$1"; }
verm()  { printf '\033[31m%s\033[0m\n' "$1"; }
cinza() { printf '\033[90m%s\033[0m\n' "$1"; }

[ -f package.json ] && [ -d api ] || {
  verm "Rode de dentro da pasta do projeto (onde estão package.json e api/)."
  exit 1
}

command -v openssl >/dev/null || { verm "openssl não encontrado."; exit 1; }

printf '\n'
verde "Configuração do checkout Asaas"
cinza "O que você digitar não aparece na tela nem fica no histórico."
printf '\n'

# ---------- 1. segredos gerados aqui ----------
ASAAS_WEBHOOK_TOKEN="$(openssl rand -hex 32)"
CPF_HASH_SALT="$(openssl rand -hex 32)"
verde "✓ ASAAS_WEBHOOK_TOKEN e CPF_HASH_SALT gerados"

# ---------- 2. valores que vêm de fora ----------
perguntar_secreto() {
  local var="$1" rotulo="$2" valor=""
  while [ -z "$valor" ]; do
    printf '%s: ' "$rotulo"
    read -r -s valor
    printf '\n'
    [ -z "$valor" ] && verm "  não pode ficar vazio"
  done
  printf -v "$var" '%s' "$valor"
}

perguntar_visivel() {
  local var="$1" rotulo="$2" valor=""
  while [ -z "$valor" ]; do
    printf '%s: ' "$rotulo"
    read -r valor
    [ -z "$valor" ] && verm "  não pode ficar vazio"
  done
  printf -v "$var" '%s' "$valor"
}

printf '\n'
perguntar_secreto ASAAS_API_KEY "Chave de API do Asaas sandbox (começa com \$aact_hmlg_)"
case "$ASAAS_API_KEY" in
  \$aact_hmlg_*) verde "✓ chave de sandbox" ;;
  \$aact_prod_*) verm  "⚠ essa é a chave de PRODUÇÃO — cobranças serão reais" ;;
  *) verm "⚠ formato incomum; confira se copiou a chave inteira" ;;
esac

printf '\n'
perguntar_visivel SUPABASE_URL "URL do projeto Supabase (https://xxxx.supabase.co)"
case "$SUPABASE_URL" in
  https://*.supabase.co*) verde "✓ URL ok" ;;
  *) verm "⚠ esperava algo como https://xxxx.supabase.co" ;;
esac

printf '\n'
perguntar_secreto SUPABASE_SERVICE_ROLE_KEY "Service role key do Supabase (NÃO a anon)"

printf '\n'
printf 'Domínio do site em produção [https://soarmacao.com.br]: '
read -r SITE_URL
SITE_URL="${SITE_URL:-https://soarmacao.com.br}"

# ---------- 3. grava o arquivo ----------
ARQ="vercel-env.txt"
{
  echo "# Gerado por scripts/configurar.sh em $(date '+%d/%m/%Y %H:%M')"
  echo "# Contém segredos. Não comite, não mande por e-mail."
  echo
  echo "ASAAS_ENV=sandbox"
  echo "ASAAS_API_KEY='${ASAAS_API_KEY}'"
  echo "ASAAS_USER_AGENT=SoArmacao-Checkout/1.0"
  echo "ASAAS_WEBHOOK_TOKEN='${ASAAS_WEBHOOK_TOKEN}'"
  echo
  echo "SUPABASE_URL=${SUPABASE_URL}"
  echo "SUPABASE_SERVICE_ROLE_KEY='${SUPABASE_SERVICE_ROLE_KEY}'"
  echo
  echo "SITE_URL=${SITE_URL}"
  echo "ALLOWED_ORIGINS=${SITE_URL}"
  echo "CORS_LIBERADO=true"
  echo
  echo "CPF_HASH_SALT='${CPF_HASH_SALT}'"
  echo
  echo "LEVE2_PCT=30"
  echo "# Sem frete gratis por padrao. Promocao: FRETE_GRATIS_PROMO_ACIMA_DE=<centavos>"
  echo
  echo "GOOGLE_ADS_ENABLED=false"
} > "$ARQ"
chmod 600 "$ARQ"

printf '\n'
verde "✓ $ARQ gravado (só você consegue ler)"
printf '\n'
printf '  Token do webhook, pra colar no painel do Asaas:\n\n'
printf '    %s\n\n' "$ASAAS_WEBHOOK_TOKEN"
cinza "  (é o único valor que você precisa ver — os outros ficam só no arquivo)"

# ---------- 4. manda pra Vercel ----------
printf '\n'
printf 'Enviar as variáveis pra Vercel agora? [s/N]: '
read -r RESP
case "$RESP" in
  s|S|sim|y|Y)
    command -v npx >/dev/null || { verm "npx não encontrado."; exit 1; }
    enviar() {
      local nome="$1" valor="$2"
      npx --yes vercel@latest env rm "$nome" production --yes >/dev/null 2>&1 || true
      if printf '%s' "$valor" | npx --yes vercel@latest env add "$nome" production >/dev/null 2>&1; then
        verde "  ✓ $nome"
      else
        verm  "  ✗ $nome — envie manualmente pelo painel"
      fi
    }
    printf '\n'
    enviar ASAAS_ENV                  "sandbox"
    enviar ASAAS_API_KEY              "$ASAAS_API_KEY"
    enviar ASAAS_USER_AGENT           "SoArmacao-Checkout/1.0"
    enviar ASAAS_WEBHOOK_TOKEN        "$ASAAS_WEBHOOK_TOKEN"
    enviar SUPABASE_URL               "$SUPABASE_URL"
    enviar SUPABASE_SERVICE_ROLE_KEY  "$SUPABASE_SERVICE_ROLE_KEY"
    enviar SITE_URL                   "$SITE_URL"
    enviar ALLOWED_ORIGINS            "$SITE_URL"
    enviar CORS_LIBERADO              "true"
    enviar CPF_HASH_SALT              "$CPF_HASH_SALT"
    enviar LEVE2_PCT                  "30"
    enviar GOOGLE_ADS_ENABLED         "false"
    printf '\n'
    verde "Pronto. Agora suba o deploy:"
    printf '\n    npx vercel@latest --prod\n\n'
    ;;
  *)
    printf '\n'
    cinza "Ok. Importe o $ARQ em: Vercel > Settings > Environment Variables > Import .env"
    printf '\n'
    ;;
esac
