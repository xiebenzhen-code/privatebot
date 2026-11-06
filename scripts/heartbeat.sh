#!/usr/bin/env bash
# Report this Linux machine's vitals to the workbench (run every minute from cron).
#   WB_URL=http://<服务器IP>:3200 WB_TOKEN=... bash scripts/heartbeat.sh
# Optional: WB_MACHINE (defaults to hostname), WB_MACHINE_META (one-line description).
# Uses only /proc, df, and — if present — nvidia-smi, sensors, docker.
set -euo pipefail

: "${WB_URL:?set WB_URL}"
: "${WB_TOKEN:?set WB_TOKEN}"
NAME="${WB_MACHINE:-$(hostname)}"

cores=$(nproc 2>/dev/null || echo 0)
load=$(cut -d' ' -f1 /proc/loadavg)
mem_total_kb=$(awk '/^MemTotal:/ {print $2}' /proc/meminfo)
mem_avail_kb=$(awk '/^MemAvailable:/ {print $2}' /proc/meminfo)
mem_total=$(awk -v t="$mem_total_kb" 'BEGIN { printf "%.1f", t / 1048576 }')
mem_used=$(awk -v t="$mem_total_kb" -v a="$mem_avail_kb" 'BEGIN { printf "%.1f", (t - a) / 1048576 }')
disk_pct=$(df -P / | awk 'NR == 2 { gsub("%", "", $5); print $5 }')
uptime_h=$(awk '{ printf "%.1f", $1 / 3600 }' /proc/uptime)

temp="null"
if command -v sensors >/dev/null 2>&1; then
  t=$(sensors 2>/dev/null | awk '/^(Package id 0|Tctl|CPU):/ { gsub(/[^0-9.]/, "", $NF); print int($NF); exit }' || true)
  [ -n "${t:-}" ] && temp="$t"
fi
if [ "$temp" = "null" ] && [ -r /sys/class/thermal/thermal_zone0/temp ]; then
  temp=$(( $(cat /sys/class/thermal/thermal_zone0/temp) / 1000 ))
fi

gpus="[]"
if command -v nvidia-smi >/dev/null 2>&1; then
  gpus=$(nvidia-smi --query-gpu=name,temperature.gpu,utilization.gpu,memory.used,memory.total --format=csv,noheader,nounits 2>/dev/null \
    | awk -F', *' 'BEGIN { printf "[" } { gsub(/"/, "", $1); printf "%s{\"name\":\"%s\",\"temp\":%s,\"util\":%s,\"mem_used\":%.1f,\"mem_total\":%.1f}", (NR > 1 ? "," : ""), $1, $2, $3, $4 / 1024, $5 / 1024 } END { printf "]" }' || echo "[]")
fi

containers="null"
if command -v docker >/dev/null 2>&1 && ids=$(docker ps -q 2>/dev/null); then
  containers=$(printf '%s' "$ids" | grep -c . || true)
fi

cpu_model=$(awk -F': ' '/^model name/ { print $2; exit }' /proc/cpuinfo 2>/dev/null | sed 's/(R)//g; s/(TM)//g; s/ CPU//; s/  */ /g' || true)
meta="${WB_MACHINE_META:-${cpu_model:-Linux} · 已运行 ${uptime_h}h}"
meta=${meta//\"/}

body=$(printf '{"meta":"%s","metrics":{"load":%s,"cores":%s,"mem_used_gb":%s,"mem_total_gb":%s,"disk_pct":%s,"temp_c":%s,"uptime_h":%s,"containers":%s,"gpus":%s}}' \
  "$meta" "$load" "$cores" "$mem_used" "$mem_total" "${disk_pct:-null}" "$temp" "$uptime_h" "$containers" "$gpus")

curl -fsS -m 10 -X POST "${WB_URL%/}/api/machines/$(printf %s "$NAME" | sed 's/ /%20/g')/heartbeat" \
  -H "Authorization: Bearer ${WB_TOKEN}" -H 'Content-Type: application/json' -d "$body" >/dev/null
