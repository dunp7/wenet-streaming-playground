FROM ubuntu:22.04

ENV DEBIAN_FRONTEND=noninteractive
ENV LANG=C.UTF-8

# -------------------------------
# Cài gói hệ thống cần thiết
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
    && apt-get clean

# -------------------------------
# Cài PyTorch CPU (Torch 2.6.0)
# -------------------------------
RUN pip install --upgrade pip
RUN pip install torch==2.5.1 torchvision==0.20.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu

# -------------------------------
# Build decoder_main
# -------------------------------
WORKDIR /app
COPY . /app

# Clone mã nguồn
RUN cd libtorch && mkdir -p build && cd build && cmake .. && cmake --build .

# -------------------------------
# Expose API và chạy
# -------------------------------
EXPOSE 10088

RUN chmod +x /app/start.sh

CMD ["/app/start.sh"]


