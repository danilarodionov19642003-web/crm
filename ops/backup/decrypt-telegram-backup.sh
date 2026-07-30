#!/usr/bin/env bash
set -Eeuo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <encrypted .cms or first .part-000> <output file>" >&2
  exit 2
fi

input=$1
output=$2
key_dir=${MENTORI_BACKUP_KEY_DIR:-$HOME/.config/mentori-backup}
private_key="$key_dir/private-key.pem"
certificate="$key_dir/certificate.pem"

test -s "$private_key"
test -s "$certificate"

work_input=$input
tmp=
cleanup() {
  [[ -n "$tmp" ]] && rm -f -- "$tmp"
}
trap cleanup EXIT

if [[ "$input" == *.part-* ]]; then
  prefix=${input%.part-*}
  tmp=$(mktemp)
  cat "${prefix}.part-"* > "$tmp"
  work_input=$tmp
fi

openssl cms -decrypt -binary -inform DER \
  -in "$work_input" -recip "$certificate" -inkey "$private_key" \
  -out "$output"

echo "Decrypted to: $output"
