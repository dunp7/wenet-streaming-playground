#!/usr/bin/env bash
set -euo pipefail

# # -------------------------------
# # Cài gói hệ thống cần thiết
# # -------------------------------
# sudo apt-get update
# sudo apt-get install -y \
#   build-essential \
#   cmake \
#   wget \
#   unzip \
#   git \
#   python3 \
#   python3-pip \
#   sox \
#   ffmpeg \
#   libsndfile1

# sudo apt-get clean

# # -------------------------------
# # Cài PyTorch CPU
# # 
# # -------------------------------
# python3 -m pip install --upgrade pip
# python3 -m pip install \
#   torch==2.5.1 \
#   torchvision==0.20.1 \
#   torchaudio==2.5.1 \
#   --index-url https://download.pytorch.org/whl/cpu


# Nên command đoạn trên nếu như đã cài được lần đầu tiên


# -------------------------------
# Build decoder_main
# -------------------------------
if [[ ! -d "libtorch" ]]; then
  echo "❌ Không thấy thư mục 'libtorch' ở thư mục hiện tại: $(pwd)"
  echo "Hãy cd tới đúng thư mục project (nơi có ./libtorch) rồi chạy lại."
  exit 1
fi

pushd libtorch >/dev/null
mkdir -p build
pushd build >/dev/null

cmake ..
cmake --build . -j"$(nproc)"

popd >/dev/null
popd >/dev/null


echo "✅ Installation completed. "