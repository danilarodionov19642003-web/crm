#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

env_file=/etc/mentori/mentor-tg.env
backup_root=/home/mentori/supabase/backups/daily
recipient_cert=/etc/mentori/backup-recipient.pem
state_dir=/var/lib/mentori-infra
max_part_bytes=$((45 * 1024 * 1024))

source "$env_file"
: "${BOT_TOKEN:?BOT_TOKEN is required}"
: "${INFRA_CHAT_ID:?INFRA_CHAT_ID is required}"
: "${INFRA_THREAD_ID:?INFRA_THREAD_ID is required}"
test -s "$recipient_cert"

mkdir -p "$state_dir"
chmod 700 "$state_dir"

latest=$(find "$backup_root" -mindepth 1 -maxdepth 1 -type d \
  -name '20??????T??????Z' | sort | tail -n1)
test -n "$latest"

stamp=$(basename "$latest")
marker="$state_dir/last-telegram-backup"
if [[ "${FORCE_SEND:-0}" != "1" && -s "$marker" && "$(cat "$marker")" == "$stamp" ]]; then
  exit 0
fi

age_seconds=$(( $(date +%s) - $(stat -c %Y "$latest") ))
if (( age_seconds > 21600 )); then
  echo "Latest verified backup is older than six hours: $stamp" >&2
  exit 1
fi

(
  cd "$latest"
  sha256sum -c SHA256SUMS
)
docker exec -i sup-postgres pg_restore --list < "$latest/postgres.dump" >/dev/null
tar -tzf "$latest/storage.tar.gz" >/dev/null

workdir=$(mktemp -d /var/tmp/mentori-backup-send.XXXXXX)
cleanup() {
  rm -rf -- "$workdir"
}
trap cleanup EXIT

database_files=(postgres.dump postgres-globals.sql SHA256SUMS METADATA)
[[ -s "$latest/receipt-telegram-state.json" ]] && database_files+=(receipt-telegram-state.json)
tar -C "$latest" -cf "$workdir/database.tar" "${database_files[@]}"
cp "$latest/storage.tar.gz" "$workdir/storage.tar.gz"

encrypt_file() {
  local input=$1
  local output=$2
  openssl cms -encrypt -binary -aes-256-cbc -outform DER \
    -in "$input" -out "$output" "$recipient_cert"
  test -s "$output"
}

send_message() {
  local message=$1
  local response
  response=$(curl --fail-with-body --silent --show-error \
    --connect-timeout 10 --max-time 60 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${INFRA_CHAT_ID}" \
    -d "message_thread_id=${INFRA_THREAD_ID}" \
    --data-urlencode "text=${message}")
  jq -e '.ok == true' <<<"$response" >/dev/null
}

send_document() {
  local path=$1
  local caption=$2
  local response
  response=$(curl --fail-with-body --silent --show-error \
    --connect-timeout 15 --max-time 300 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendDocument" \
    -F "chat_id=${INFRA_CHAT_ID}" \
    -F "message_thread_id=${INFRA_THREAD_ID}" \
    -F "document=@${path}" \
    -F "caption=${caption}")
  jq -e '.ok == true' <<<"$response" >/dev/null
}

send_encrypted_artifact() {
  local input=$1
  local label=$2
  local display_name=$3
  local encrypted="$workdir/${label}-${stamp}.cms"
  encrypt_file "$input" "$encrypted"

  local size
  size=$(stat -c %s "$encrypted")
  if (( size <= max_part_bytes )); then
    send_document "$encrypted" \
      "🔐 Резервная копия CRM ${stamp}: ${display_name}; файл зашифрован; sha256 $(sha256sum "$encrypted" | cut -d' ' -f1)"
    return
  fi

  split -b "$max_part_bytes" -d -a 3 \
    "$encrypted" "$workdir/${label}-${stamp}.cms.part-"
  local part
  for part in "$workdir/${label}-${stamp}.cms.part-"*; do
    send_document "$part" \
      "🔐 Резервная копия CRM ${stamp}: ${display_name}, $(basename "$part"); зашифрованная часть; sha256 $(sha256sum "$part" | cut -d' ' -f1)"
  done
}

send_message "🔐 Начинаю отправку зашифрованной резервной копии CRM ${stamp}. В ней база данных и загруженные в CRM файлы."
send_encrypted_artifact "$workdir/database.tar" database "база данных"
send_encrypted_artifact "$workdir/storage.tar.gz" storage "файлы CRM"
send_message "✅ Зашифрованная резервная копия CRM ${stamp} доставлена. Исходный снимок проверен на сервере."

printf '%s\n' "$stamp" > "$marker"
printf '%s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" > "$state_dir/last-telegram-backup-at"
