#!/bin/bash
set -e

echo "Current working directory: $(pwd)"

LOG_DIR="$(pwd)/logs/asr_logs"
mkdir -p "$LOG_DIR"

cleanup() {
    echo "Stopping Websocket server..."

    if [ -n "$WS_PID" ]; then
        kill "$WS_PID" 2>/dev/null || true
        wait "$WS_PID" 2>/dev/null || true
    fi

    echo "DONE..."
}

trap cleanup EXIT INT TERM

echo "Starting Websocket server..."

stdbuf -oL -eL ./wenet/libtorch/build/bin/websocket_server_main \
    --port 10088 \
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
echo "Waiting for websocket server..."

until (echo > /dev/tcp/localhost/10088) >/dev/null 2>&1; do
    # Also check server is still alive
    if ! kill -0 "$WS_PID" 2>/dev/null; then
        echo "Websocket server exited unexpectedly."
        exit 1
    fi

    sleep 1
done

echo "Websocket ready."

echo "Starting FastAPI app..."

uvicorn api.app:app --host 0.0.0.0 --port 8266

# close websocket server if exists -> kill 

echo "Stopping Websocket server..."
kill $WS_PID 2>/dev/null || true


echo "DONE..."