FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV PYTHONUNBUFFERED=1

# -------------------------------
# Cài gói hệ thống cần thiết
# (procps: pkill/pgrep dùng trong api/start.sh để restart websocket)
# -------------------------------
RUN apt-get update && apt-get install -y \
    build-essential \
    cmake \
    wget \
    unzip \
    git \
    python3 \
    python3-pip \
    sox \
    ffmpeg \
    libsndfile1 \
    apache2-bin \
    apache2-utils \
    procps \
    && rm -rf /var/lib/apt/lists/*

# -------------------------------
# Cài PyTorch CPU
# -------------------------------
# RUN python3 -m pip install --no-cache-dir --upgrade pip && \
#     python3 -m pip install --no-cache-dir \
#     torch==2.5.1 \
#     torchvision==0.20.1 \
#     torchaudio==2.5.1 \
#     --index-url https://download.pytorch.org/whl/cpu

# -------------------------------
# Cài Python packages
# -------------------------------
RUN python3 -m pip install --no-cache-dir fastapi uvicorn websockets python-multipart

# -------------------------------
# Build Decoder
# -------------------------------
COPY wenet/ /app/wenet/
WORKDIR /app/wenet

RUN chmod +x install.sh && ./install.sh

# -------------------------------
# Copy source
# -------------------------------
WORKDIR /app
COPY api/ /app/api/

# -------------------------------
# Expose API và chạy
# -------------------------------
EXPOSE 8266 10088

RUN chmod +x /app/api/start.sh

# Health check: /health trả 503 nếu WeNet websocket (port 10088) không hoạt động.
# auto_restart=false: chỉ kiểm tra, việc tự restart do watchdog trong API đảm nhiệm.
# start-period dài vì load model mất thời gian.
HEALTHCHECK --interval=60s --timeout=10s --start-period=120s --retries=3 \
    CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8266/health?auto_restart=false', timeout=8)" || exit 1

# start.sh: chạy websocket server + FastAPI (uvicorn, port 8266)
CMD ["/app/api/start.sh"]
