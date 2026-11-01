#!/usr/bin/env bash
set -euo pipefail

# Plugin initialization is lazy in serve/web mode. Warm the configured directory
# after listening so a cloud deployment receives TG messages before a browser visits.
MODE=${oc_mode:-${OPENCODE_MODE:-serve}}
PORT=${oc_port:-${OPENCODE_PORT:-4096}}
DIRECTORY=${tg_dir:-${TELEGRAM_DIRECTORY:-$PWD}}
BIN=${OPENCODE_BIN:-opencode}
if [[ "$MODE" != "web" && "$MODE" != "serve" ]]; then
    echo "start-opencode: oc_mode must be web or serve" >&2
    exit 1
fi
AUTH=()
if [[ -n "${OPENCODE_SERVER_PASSWORD:-}" ]]; then
    AUTH=(-u "${OPENCODE_SERVER_USERNAME:-opencode}:${OPENCODE_SERVER_PASSWORD}")
fi
"$BIN" "$MODE" --port "$PORT" --hostname "${oc_host:-${OPENCODE_HOST:-0.0.0.0}}" "$@" &
OC_PID=$!
cleanup() {
    kill -TERM "$OC_PID" 2>/dev/null || true
    wait "$OC_PID" 2>/dev/null || true
}
trap cleanup EXIT
trap 'exit 143' TERM
trap 'exit 130' INT
for ((attempt=0; attempt<120; attempt++)); do
    if ! kill -0 "$OC_PID" 2>/dev/null; then
        wait "$OC_PID"
        exit $?
    fi
    if curl -fsS "${AUTH[@]}" --max-time 2 -G --data-urlencode "directory=$DIRECTORY" \
        "http://127.0.0.1:$PORT/experimental/tool/ids" -o /dev/null 2>/dev/null; then
        break
    fi
    sleep 1
done
wait "$OC_PID"
