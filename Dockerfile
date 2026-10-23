FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8
ENV PYTHONUNBUFFERED=1

# -------------------------------
# Cài gói hệ thống cần thiết
# -------------------------------
RUN apt-get update && apt-get install -y\
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
  apache2-utils

# -------------------------------
# Cài PyTorch CPU
# -------------------------------
RUN python3 -m pip install --upgrade pip && \
    python3 -m pip install \
    torch==2.5.1 \
    torchvision==0.20.1 \
    torchaudio==2.5.1 \
    --index-url https://download.pytorch.org/whl/cpu

# -------------------------------
# Cài Python packages
# -------------------------------

RUN python3 -m pip install fastapi uvicorn websockets python-multipart

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

CMD ["/app/api/start.sh"]
