#!/bin/bash
# Usage:
#   ./api/start.sh        Start Websocket server + FastAPI (default, container entrypoint)
#   ./api/start.sh ws     (Re)start ONLY the Websocket server, then exit.
#                         Called by the API health watchdog when websocket is down.
set -e

# Always run from project root (works from any cwd, and when called by the API)
cd "$(dirname "${BASH_SOURCE[0]}")/.."

MODE="${1:-all}"
WS_PORT=10088
WS_BIN="./wenet/libtorch/build/bin/websocket_server_main"
WS_READY_TIMEOUT="${WS_READY_TIMEOUT:-120}"

echo "Current working directory: $(pwd)"

LOG_DIR="$(pwd)/logs/asr_logs"
mkdir -p "$LOG_DIR"

ws_alive() {
    (echo > /dev/tcp/localhost/$WS_PORT) >/dev/null 2>&1
}

stop_ws() {
    if pgrep -f "websocket_server_main" >/dev/null 2>&1; then
        echo "Stopping Websocket server..."
        pkill -f "websocket_server_main" 2>/dev/null || true
        # wait up to 10s for graceful exit, then force kill
        for _ in $(seq 1 10); do
            pgrep -f "websocket_server_main" >/dev/null 2>&1 || return 0
            sleep 1
        done
        pkill -9 -f "websocket_server_main" 2>/dev/null || true
        sleep 1
    fi
}

start_ws() {
    echo "Starting Websocket server..."
    # setsid: keep the server alive independently of this script / the caller
    setsid stdbuf -oL -eL "$WS_BIN" \
        --port $WS_PORT \
        --chunk_size 32 \
        --beam 20 \
        --nbest 20 \
        --language_type 1 \
        --model_path ./model/final.zip \
        --unit_path ./model/units.txt \
        > >(/usr/bin/rotatelogs -l "$LOG_DIR/server-%Y-%m-%d.log" 86400) \
        2>&1 &
    # --language_type = 1 use for language use space to split words (English, Vietnamese)
    WS_PID=$!
    echo "Websocket server PID: $WS_PID"
}

wait_ws_ready() {
    echo "Waiting for websocket server..."
    local waited=0
    until ws_alive; do
        if ! kill -0 "$WS_PID" 2>/dev/null; then
            echo "Websocket server exited unexpectedly."
            return 1
        fi
        if [ "$waited" -ge "$WS_READY_TIMEOUT" ]; then
            echo "Websocket server not ready after ${WS_READY_TIMEOUT}s."
            return 1
        fi
        sleep 1
        waited=$((waited + 1))
    done
    echo "Websocket ready."
}

# ---------------------------------------------------------------------------
# Mode: restart websocket only
# ---------------------------------------------------------------------------
if [ "$MODE" = "ws" ]; then
    stop_ws
    start_ws
    wait_ws_ready
    echo "DONE..."
    exit 0
fi

# ---------------------------------------------------------------------------
# Mode: full start (websocket + FastAPI)
# ---------------------------------------------------------------------------
cleanup() {
    stop_ws
    echo "DONE..."
}
trap cleanup EXIT INT TERM

stop_ws
start_ws
wait_ws_ready

echo "Starting FastAPI app..."
uvicorn api.app:app --host 0.0.0.0 --port 8266
