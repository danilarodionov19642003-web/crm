#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

backup_root=/home/mentori/supabase/backups/daily
storage_root=/var/lib/docker/volumes/supabase_sup-storage/_data
receipt_state=/var/lib/mentori-receipts/sent-state.json
stamp=$(date -u +%Y%m%dT%H%M%SZ)
partial_dir="$backup_root/.${stamp}.partial"
final_dir="$backup_root/$stamp"

mkdir -p "$backup_root"
chmod 700 "$backup_root"

exec 9>"$backup_root/.backup.lock"
flock -n 9 || exit 0

cleanup() {
  if [[ -d "$partial_dir" ]]; then
    rm -rf -- "$partial_dir"
  fi
}
trap cleanup EXIT

mkdir -m 700 "$partial_dir"
docker inspect sup-postgres >/dev/null

docker exec sup-postgres pg_dump -U postgres -d postgres -Fc \
  > "$partial_dir/postgres.dump"
docker exec sup-postgres pg_dumpall -U postgres --globals-only \
  > "$partial_dir/postgres-globals.sql"

test -d "$storage_root"
storage_ok=0
for attempt in 1 2 3; do
  rm -f -- "$partial_dir/storage.tar.gz"
  if tar -C "$storage_root" -czf "$partial_dir/storage.tar.gz" .; then
    storage_ok=1
    break
  fi
  sleep "$attempt"
done
test "$storage_ok" -eq 1

if [[ -s "$receipt_state" ]]; then
  cp "$receipt_state" "$partial_dir/receipt-telegram-state.json"
fi

test -s "$partial_dir/postgres.dump"
test -s "$partial_dir/postgres-globals.sql"
test -s "$partial_dir/storage.tar.gz"
docker exec -i sup-postgres pg_restore --list \
  < "$partial_dir/postgres.dump" >/dev/null
tar -tzf "$partial_dir/storage.tar.gz" >/dev/null

(
  cd "$partial_dir"
  checksum_files=(postgres.dump postgres-globals.sql storage.tar.gz)
  [[ -s receipt-telegram-state.json ]] && checksum_files+=(receipt-telegram-state.json)
  sha256sum "${checksum_files[@]}" > SHA256SUMS
)

printf 'created_at_utc=%s\ncontainer=sup-postgres\nformat=pg_dump_custom\nstorage=storage.tar.gz\n' \
  "$stamp" > "$partial_dir/METADATA"

mv "$partial_dir" "$final_dir"
trap - EXIT

# Telegram keeps the encrypted off-server copies. Seven verified local copies
# cap disk growth while preserving a fast restore path.
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +7 \
  -name '20??????T??????Z' -exec rm -rf -- {} +

logger -t mentori-db-backup "completed $final_dir"
