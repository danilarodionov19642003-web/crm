#!/usr/bin/env bash
set -Eeuo pipefail

umask 077

source /etc/mentori/mentor-tg.env
: "${BOT_TOKEN:?BOT_TOKEN is required}"
: "${INFRA_CHAT_ID:?INFRA_CHAT_ID is required}"
: "${INFRA_THREAD_ID:?INFRA_THREAD_ID is required}"

state_dir=/var/lib/mentori-infra
state_file="$state_dir/monitor-state"
repeat_seconds=86400
mkdir -p "$state_dir"
chmod 700 "$state_dir"

codes=()
details=()
critical=0

add_problem() {
  codes+=("$1")
  details+=("$2")
  case "$1" in
    *_critical|service_*|failed_*|container_*|postgres_health|backup_missing)
      critical=1
      ;;
  esac
}

disk_pct=$(df -P / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
disk_free_kb=$(df -Pk / | awk 'NR==2 {print $4}')
disk_free_h=$(df -hP / | awk 'NR==2 {print $4}')
if (( disk_pct >= 90 || disk_free_kb < 1572864 )); then
  add_problem disk_critical "💾 Диск: КРИТИЧНО, занято ${disk_pct}%, свободно ${disk_free_h}"
elif (( disk_pct >= 80 || disk_free_kb < 3145728 )); then
  add_problem disk_warning "💾 Диск: занято ${disk_pct}%, свободно ${disk_free_h}"
fi

inode_pct=$(df -Pi / | awk 'NR==2 {gsub(/%/, "", $5); print $5}')
if (( inode_pct >= 95 )); then
  add_problem inode_critical "🗂 Файловая система: КРИТИЧНО, занято ${inode_pct}% inode"
elif (( inode_pct >= 85 )); then
  add_problem inode_warning "🗂 Файловая система: занято ${inode_pct}% inode"
fi

mem_total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_available_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
mem_available_pct=$((mem_available_kb * 100 / mem_total_kb))
if (( mem_available_pct <= 5 )); then
  add_problem memory_critical "🧠 Память: КРИТИЧНО, доступно только ${mem_available_pct}%"
elif (( mem_available_pct <= 10 )); then
  add_problem memory_warning "🧠 Память: доступно только ${mem_available_pct}%"
fi

for service in mentori-db-backup.timer mentori-backup-telegram.timer \
  mentori-tg-bot.service mentori-tg-notifier.service \
  mentori-receipts-telegram.timer; do
  if ! systemctl is-active --quiet "$service"; then
    add_problem "service_${service}" "🔴 Сервис не активен: ${service}"
  fi
done

for job in mentori-db-backup.service mentori-backup-telegram.service \
  mentori-receipts-telegram.service; do
  if systemctl is-failed --quiet "$job"; then
    add_problem "failed_${job}" "⛔ Задание завершилось ошибкой: ${job}"
  fi
done

for container in sup-postgres sup-postgrest sup-storage sup-gotrue mentori-payments; do
  status=$(docker inspect -f '{{.State.Status}}' "$container" 2>/dev/null || true)
  if [[ "$status" != "running" ]]; then
    case "$status" in
      exited|dead) status_ru=остановлен ;;
      restarting) status_ru=перезапускается ;;
      created) status_ru="создан, но не запущен" ;;
      paused) status_ru=приостановлен ;;
      '') status_ru=отсутствует ;;
      *) status_ru="$status" ;;
    esac
    add_problem "container_${container}" "🔴 Контейнер не работает: ${container} (${status_ru})"
  fi
done

pg_health=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}' \
  sup-postgres 2>/dev/null || true)
if [[ "$pg_health" != "healthy" ]]; then
  case "$pg_health" in
    unhealthy) pg_health_ru=ошибка ;;
    starting) pg_health_ru=запускается ;;
    none) pg_health_ru="нет отдельной проверки" ;;
    '') pg_health_ru=неизвестно ;;
    *) pg_health_ru="$pg_health" ;;
  esac
  add_problem postgres_health "🗄 PostgreSQL не в норме: ${pg_health_ru}"
fi

latest=$(find /home/mentori/supabase/backups/daily -mindepth 1 -maxdepth 1 \
  -type d -name '20??????T??????Z' | sort | tail -n1)
if [[ -z "$latest" ]]; then
  add_problem backup_missing "📦 Не найдена ни одна проверенная резервная копия CRM"
else
  backup_age=$(( $(date +%s) - $(stat -c %Y "$latest") ))
  if (( backup_age > 108000 )); then
    add_problem backup_stale "📦 Последняя копия CRM старше 30 часов: $(basename "$latest")"
  fi
fi

if [[ -s "$state_dir/last-telegram-backup-at" ]]; then
  sent_epoch=$(date -d "$(cat "$state_dir/last-telegram-backup-at")" +%s 2>/dev/null || echo 0)
  if (( sent_epoch == 0 || $(date +%s) - sent_epoch > 108000 )); then
    add_problem telegram_backup_stale "📨 Бэкап не доставлялся в Telegram более 30 часов"
  fi
fi

if ((${#codes[@]} == 0)); then
  signature=ok
  message=$'✅ CRM В НОРМЕ\n'
  message+="Все проверки снова проходят. Диск занят на ${disk_pct}%, свободно ${disk_free_h}."
else
  signature=$(printf '%s\n' "${codes[@]}" | sort | sha256sum | cut -d' ' -f1)
  if (( critical )); then
    message="🚨 КРИТИЧЕСКАЯ ПРОБЛЕМА CRM ($(date '+%d.%m.%Y %H:%M %Z'))"
  else
    message="⚠️ ПРЕДУПРЕЖДЕНИЕ CRM ($(date '+%d.%m.%Y %H:%M %Z'))"
  fi
  for detail in "${details[@]}"; do
    message+=$'\n- '
    message+="$detail"
  done
  message+=$'\n🔒 Автоматически данные не удаляются.'
fi

previous_signature=
last_sent=0
if [[ -s "$state_file" ]]; then
  previous_signature=$(sed -n '1p' "$state_file")
  last_sent=$(sed -n '2p' "$state_file")
fi

now=$(date +%s)
should_send=0
if [[ "$signature" != "$previous_signature" ]]; then
  if [[ "$signature" != ok || -n "$previous_signature" ]]; then
    should_send=1
  fi
elif [[ "$signature" != ok && $((now - last_sent)) -ge $repeat_seconds ]]; then
  should_send=1
fi

if (( should_send )); then
  response=$(curl --fail-with-body --silent --show-error \
    --connect-timeout 10 --max-time 60 \
    -X POST "https://api.telegram.org/bot${BOT_TOKEN}/sendMessage" \
    -d "chat_id=${INFRA_CHAT_ID}" \
    -d "message_thread_id=${INFRA_THREAD_ID}" \
    --data-urlencode "text=${message}")
  jq -e '.ok == true' <<<"$response" >/dev/null
  last_sent=$now
fi

tmp=$(mktemp "$state_dir/monitor-state.XXXXXX")
printf '%s\n%s\n' "$signature" "$last_sent" > "$tmp"
mv "$tmp" "$state_file"
