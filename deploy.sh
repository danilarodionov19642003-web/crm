#!/usr/bin/env bash
# ===========================================================================
#  Деплой CRM на Yandex VPS.
#  Usage:   ./deploy.sh
#  Что делает: rsync-ит локальную папку на сервер и перезагружает nginx.
# ===========================================================================
set -euo pipefail

VPS_USER="mentori"
VPS_HOST="111.88.145.253"
VPS_PATH="/var/www/crm"
KEY="$HOME/.ssh/yandex_mentori"

echo "→ rsync $(pwd)  →  $VPS_USER@$VPS_HOST:$VPS_PATH"
rsync -az --delete \
  --exclude='.git' \
  --exclude='.DS_Store' \
  --exclude='node_modules' \
  --exclude='deploy.sh' \
  --exclude='*.md' \
  -e "ssh -i $KEY" \
  ./ "$VPS_USER@$VPS_HOST:$VPS_PATH/"

echo "→ reload nginx"
ssh -i "$KEY" "$VPS_USER@$VPS_HOST" 'sudo systemctl reload nginx'

echo "✓ Готово.  http://$VPS_HOST/"
