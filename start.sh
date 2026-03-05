#!/bin/bash
set -e # exit when any command fails

# check current pwd
echo "Current working directory: $(pwd)"

# create log dir
mkdir -p logs

# Start Websocket server
echo "Starting Websocket server..."
stdbuf -oL -eL ./libtorch/build/bin/websocket_server_main \
    --port 10088 \
    --chunk_size 32 \
    --beam 12 \
    --nbest 1 \
    --model_path ./model/final.zip \
    --unit_path ./model/units.txt \
    > logs/server.log 2>&1 &

WS_PID=$!
echo "Websocket server PID: $WS_PID"

echo "Waiting for websocket server..."

until (echo > /dev/tcp/localhost/10088) >/dev/null 2>&1; do
    sleep 1
done

echo "Websocket ready."
# close websocket server if exists -> kill 

# echo "Stopping Websocket server..."
# kill $WS_PID 2>/dev/null || true


# echo "DONE..."