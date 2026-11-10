#!/bin/bash
# ==============================================================================
# Script khởi động Web Demo (Chạy ở ngoài Docker)
# Giao diện sẽ gọi API Port của WeNet (mặc định Docker port 1111 hoặc 8266)
# ==============================================================================

PORT=${1:-3000}
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
WEB_DIR="$ROOT_DIR/web"

echo "============================================================"
echo "  Khởi động WeNet Streaming ASR Web UI (Ngoài Docker)"
echo "============================================================"
echo "  Web Directory: $WEB_DIR"
echo "  Web URL:       http://localhost:$PORT"
echo "  Target API:    ws://localhost:1111/audio_streaming (Docker)"
echo "                 hoặc ws://localhost:8266/audio_streaming (Local)"
echo "============================================================"
echo "Nhấn Ctrl+C để dừng."
echo ""

cd "$WEB_DIR"

if command -v python3 >/dev/null 2>&1; then
    exec python3 serve.py "$PORT"
else
    echo "Lỗi: Không tìm thấy Python 3 trên hệ thống!"
    exit 1
fi

