# Inference WeNet

## 1. Overview
**Inference WeNet** is an Automatic Speech Recognition (ASR) inference service built on top of the WeNet Libtorch C++ engine and FastAPI.

- **Libtorch WebSocket Server**: C++ backend engine for real-time streaming speech recognition (running on port `10088`).
- **FastAPI Application**: RESTful API service (running on port `8266`) handling file transcription (`/transcribe_file`), streaming recognition (`/transcribe_stream`), and WebSocket streaming proxy (`/audio_streaming`).
- **Models**: Pre-trained Libtorch ASR models located in `./model/` (`final.zip` and `units.txt`).


---

## 2. Deployment

### Option 1: Local Deployment

#### Prerequisites
- Locate your model into folder `./model/` 

- Install system packages and required Python packages:
```bash
sudo apt-get update && sudo apt-get install -y \
  build-essential cmake wget unzip git python3 python3-pip sox ffmpeg libsndfile1 apache2-bin

python3 -m pip install torch==2.5.1 torchaudio==2.5.1 --index-url https://download.pytorch.org/whl/cpu
python3 -m pip install fastapi uvicorn websockets python-multipart
```

#### Step 1: Build WeNet Decoder
```bash
cd wenet
./install.sh
cd ..
```

#### Step 2: Start Service
Run the startup script to start both the WebSocket server and FastAPI API:
```bash
./api/start.sh
```

---

### Option 2: Docker Deployment

#### Using Docker Compose (Recommended)
Build and start the container in background mode:
```bash
docker-compose up -d --build
```

To stop the container:
```bash
docker-compose down
```

