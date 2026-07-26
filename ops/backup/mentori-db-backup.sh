#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

backup_root=/home/mentori/supabase/backups/daily
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

test -s "$partial_dir/postgres.dump"
test -s "$partial_dir/postgres-globals.sql"
docker exec -i sup-postgres pg_restore --list \
  < "$partial_dir/postgres.dump" >/dev/null

(
  cd "$partial_dir"
  sha256sum postgres.dump postgres-globals.sql > SHA256SUMS
)

printf 'created_at_utc=%s\ncontainer=sup-postgres\nformat=pg_dump_custom\n' \
  "$stamp" > "$partial_dir/METADATA"

mv "$partial_dir" "$final_dir"
trap - EXIT

# Keep one month locally. Off-server retention is configured separately.
find "$backup_root" -mindepth 1 -maxdepth 1 -type d -mtime +30 \
  -name '20??????T??????Z' -exec rm -rf -- {} +

logger -t mentori-db-backup "completed $final_dir"
