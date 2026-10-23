from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
import subprocess
import os
import uuid
import json

import asyncio
import websockets
from .logging import logger, run_decoder, log_http_requests

app = FastAPI(root_path="/wenet_api")
app.middleware("http")(log_http_requests)


# Cấu hình model (thay đường dẫn nếu bind từ host)
MODEL_PATH = "./model/final.zip"
UNIT_PATH = "./model/units.txt"
DECODER = "./wenet/libtorch/build/bin/decoder_main"
DECODE_DIR = "./tmp/wenet_decode"
os.makedirs(DECODE_DIR, exist_ok=True)


def _normalize_contexts(value):
    if value is None:
        return []
    if isinstance(value, str):
        if "\n" in value:
            return [item.strip() for item in value.splitlines() if item.strip()]
        return [value.strip()] if value.strip() else []
    if isinstance(value, list):
        return [str(item).strip() for item in value if str(item).strip()]
    return [str(value).strip()] if str(value).strip() else []


def _prepare_wenet_start_message(text):
    try:
        payload = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return text

    if not isinstance(payload, dict) or payload.get("signal") != "start":
        return text

    has_contexts = any(
        key in payload for key in ("context", "contexts", "dictionary")
    )
    if not has_contexts and "context_words" in payload:
        payload["contexts"] = _normalize_contexts(payload.get("context_words"))

    return json.dumps(payload, ensure_ascii=False)

# --- Upload file WAV ---
@app.post("/transcribe_file")
async def transcribe_file(file: UploadFile = File(...)):
    uid = str(uuid.uuid4())
    logger.info(
        "transcribe_file started uid=%s filename=%s content_type=%s",
        uid,
        file.filename,
        file.content_type,
    )
    wav_path = f"{DECODE_DIR}/{uid}.wav"
    result_path = f"{DECODE_DIR}/{uid}.txt"

    with open(wav_path, "wb") as f:
        f.write(await file.read())

    cmd = [
        DECODER,
        "--chunk_size", "32",
        "--num_left_chunks", "-1",
        "--model_path", MODEL_PATH,
        "--wav_path", wav_path,
        "--simulate_streaming", "1",
        "--thread_num", "1",
        "--warmup", "0",
        "--continuous_decoding", "1",
        "--result", result_path,
        "--unit_path", UNIT_PATH
    ]

    result, log_path = run_decoder(cmd, uid)
    logger.info("Decoder finished uid=%s returncode=%s log=%s", uid, result.returncode, log_path)

    try:
        with open(result_path, "r") as res_f:
            output = res_f.read()
            if output:
                output = output.strip().split(" ", 1)[-1]
    except FileNotFoundError:
        output = "[ERROR] Không tìm thấy kết quả."

    preview = " ".join(output.split()[:20])
    logger.info("transcribe_file finished uid=%s preview=%s....", uid, preview)
    return {"result": output}


# --- Streaming từ mic qua WebSocket ---
@app.websocket("/transcribe_stream")
async def transcribe_stream(websocket: WebSocket):
    await websocket.accept()

    uid = str(uuid.uuid4())
    pcm_path = f"{DECODE_DIR}/{uid}.pcm"
    wav_path = f"{DECODE_DIR}/{uid}.wav"
    result_path = f"{DECODE_DIR}/{uid}.txt"

    logger.info("WebSocket connected uid=%s", uid)
    logger.info("Saving PCM uid=%s path=%s", uid, pcm_path)

    total_bytes = 0

    with open(pcm_path, "wb") as pcm_file:
        try:
            while True:
                chunk = await websocket.receive_bytes()

                # Nếu nhận flag kết thúc thì dừng
                if chunk == b"__END__":
                    logger.info("Received __END__; stop recording PCM uid=%s", uid)
                    break

                pcm_file.write(chunk)
                total_bytes += len(chunk)
                logger.debug("Received audio chunk uid=%s bytes=%s total_bytes=%s", uid, len(chunk), total_bytes)
        except Exception as e:
            logger.exception("WebSocket receive error uid=%s", uid)

    # Chuyển PCM → WAV
    sox_cmd = f"sox -t raw -r 16000 -b 16 -e signed-integer -c 1 {pcm_path} {wav_path}"
    logger.info("Converting PCM to WAV uid=%s command=%s", uid, sox_cmd)
    ret = os.system(sox_cmd)
    logger.info("sox finished uid=%s returncode=%s", uid, ret)
    logger.info("WAV exists uid=%s exists=%s path=%s", uid, os.path.exists(wav_path), wav_path)

    # Decode
    cmd = [
        DECODER,
        "--chunk_size", "32",
        "--num_left_chunks", "-1",
        "--model_path", MODEL_PATH,
        "--wav_path", wav_path,
        "--simulate_streaming", "1",
        "--thread_num", "1",
        "--warmup", "0",
        "--continuous_decoding", "1",
        "--result", result_path,
        "--unit_path", UNIT_PATH
    ]

    logger.info("Running decoder uid=%s command=%s", uid, " ".join(cmd))
    result, log_path = run_decoder(cmd, uid)
    logger.info("decoder finished uid=%s returncode=%s", uid, result.returncode)
    logger.info("Result TXT exists uid=%s exists=%s path=%s", uid, os.path.exists(result_path), result_path)
    logger.info("Decoder log uid=%s path=%s", uid, log_path)

    # Đọc kết quả
    try:
        if os.path.exists(result_path):
            with open(result_path, "r") as res_f:
                text = res_f.read().strip()
                logger.info("Decoder result uid=%s text=%s", uid, text)
                if text:
                    text = text.split(" ", 1)[-1]  # Bỏ 'test ' nếu có
                else:
                    text = "[EMPTY RESULT]"
        else:
            text = "[ERROR] Không tìm thấy kết quả"
    except Exception as e:
        text = f"[ERROR] Không đọc được kết quả: {e}"

    await websocket.send_text(text)
    await websocket.close()
    logger.info("WebSocket closed uid=%s", uid)

# --------- API proxy streaming -----------
@app.websocket("/audio_streaming")
async def proxy_streaming(websocket: WebSocket):
    await websocket.accept()
    ws_server_uri = "ws://localhost:10088"   # Nếu websocket_server_main chạy cùng container

    try:
        # Kết nối tới backend WeNet WebSocket server
        async with websockets.connect(ws_server_uri) as ws_server:
            print("[PROXY] Client connected. Bắt đầu relay.")

            async def client_to_server():
                try:
                    while True:
                        msg = await websocket.receive()
                        # print("[PROXY] Nhận từ client:", msg)
                        if "bytes" in msg:
                            await ws_server.send(msg["bytes"])
                        elif "text" in msg:
                            await ws_server.send(msg["text"])
                except WebSocketDisconnect:
                    print("[PROXY] Client disconnect.")
                    await ws_server.close()
                except Exception as e:
                    print("[PROXY] Error (client_to_server):", e)
                    await ws_server.close()

            async def server_to_client():
                try:
                    async for data in ws_server:
                        try:
                            msg = json.loads(data)
                            if msg.get("type") == "partial_result":
                                nbest = json.loads(msg.get("nbest", "[]"))
                                sentence = nbest[0]["sentence"] if nbest else ""
                                await websocket.send_text(f"partial_result: {sentence}")
                            elif msg.get("type") == "final_result":
                                nbest = json.loads(msg.get("nbest", "[]"))
                                sentence = nbest[0]["sentence"] if nbest else ""
                                await websocket.send_text(f"final_result: {sentence}")
                            # Nếu muốn relay thêm các type khác thì thêm vào đây
                        except Exception:
                            # Nếu không parse được JSON thì relay text gốc luôn
                            await websocket.send_text(data)
                except Exception as e:
                    print("[PROXY] Error (server_to_client):", e)
                    await websocket.close()

            # Chạy 2 task đồng thời: nhận từ client, gửi sang server và ngược lại
            await asyncio.gather(
                client_to_server(),
                server_to_client()
            )
    except Exception as e:
        print("[PROXY] Proxy streaming exception:", e)
        await websocket.close()