from contextlib import asynccontextmanager

from fastapi import FastAPI, File, UploadFile, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
import subprocess
import os
import re
import time
import unicodedata
import uuid
import json

import asyncio
import websockets
from .logging import logger, run_decoder, log_http_requests


# ---------------------------------------------------------------------------
# WeNet WebSocket server health check + auto restart
# ---------------------------------------------------------------------------
WS_HOST = "localhost"
WS_PORT = 10088
WS_URI = f"ws://{WS_HOST}:{WS_PORT}"

PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
START_SCRIPT = os.path.join(PROJECT_ROOT, "api", "start.sh")
WS_RESTART_LOG = os.path.join(PROJECT_ROOT, "logs", "asr_logs", "restart.log")

# Max seconds to wait for `start.sh ws` (model loading can take a while)
WS_RESTART_TIMEOUT = int(os.getenv("WS_RESTART_TIMEOUT", "150"))
# Min seconds between two restart attempts (avoid restart storms)
WS_RESTART_COOLDOWN = int(os.getenv("WS_RESTART_COOLDOWN", "15"))
# Background watchdog: check every N seconds (0 = disabled)
WS_WATCHDOG_INTERVAL = int(os.getenv("WS_WATCHDOG_INTERVAL", "10"))
# Restart after N consecutive failed checks
WS_WATCHDOG_FAILURES = int(os.getenv("WS_WATCHDOG_FAILURES", "3"))

_ws_restart_lock = asyncio.Lock()
_ws_last_restart_at = 0.0


async def check_websocket_alive(timeout: float = 2.0) -> bool:
    """Real WebSocket handshake against the WeNet server (not just a TCP connect)."""
    try:
        async def _probe():
            async with websockets.connect(
                WS_URI, open_timeout=timeout, close_timeout=timeout
            ):
                return True

        return await asyncio.wait_for(_probe(), timeout=timeout + 1)
    except Exception:
        return False


async def ensure_websocket_server() -> bool:
    """
    Restart the WeNet WebSocket server by calling `start.sh ws`, only if it is down.
    Returns True when the WebSocket is alive afterwards.
    """
    global _ws_last_restart_at

    async with _ws_restart_lock:
        # Another caller may have already fixed it while we waited for the lock
        if await check_websocket_alive(timeout=1.0):
            return True

        since_last = time.monotonic() - _ws_last_restart_at
        if since_last < WS_RESTART_COOLDOWN:
            logger.warning("[WS RESTART] Skip: last attempt %.1fs ago (cooldown %ss)",
                           since_last, WS_RESTART_COOLDOWN)
            return False
        _ws_last_restart_at = time.monotonic()

        logger.warning("[WS RESTART] WebSocket down -> running: bash %s ws", START_SCRIPT)
        try:
            os.makedirs(os.path.dirname(WS_RESTART_LOG), exist_ok=True)
            with open(WS_RESTART_LOG, "ab") as log_fp:
                proc = await asyncio.create_subprocess_exec(
                    "bash", START_SCRIPT, "ws",
                    cwd=PROJECT_ROOT,
                    stdout=log_fp,
                    stderr=asyncio.subprocess.STDOUT,
                    start_new_session=True,
                )
                try:
                    await asyncio.wait_for(proc.wait(), timeout=WS_RESTART_TIMEOUT)
                except asyncio.TimeoutError:
                    logger.error("[WS RESTART] start.sh ws timed out after %ss", WS_RESTART_TIMEOUT)
                    proc.kill()
                    await proc.wait()
        except Exception:
            logger.exception("[WS RESTART] Failed to run start.sh")
            return False
        finally:
            _ws_last_restart_at = time.monotonic()

        alive = await check_websocket_alive(timeout=2.0)
        if alive:
            logger.info("[WS RESTART] WebSocket server is back online")
        else:
            logger.error("[WS RESTART] WebSocket server still down after restart")
        return alive


async def _websocket_watchdog():
    """Background loop: restart the WebSocket server after repeated failed checks."""
    failures = 0
    while True:
        await asyncio.sleep(WS_WATCHDOG_INTERVAL)
        try:
            if await check_websocket_alive(timeout=3.0):
                failures = 0
                continue
            failures += 1
            logger.warning("[WATCHDOG] WebSocket check failed (%s/%s)",
                           failures, WS_WATCHDOG_FAILURES)
            if failures >= WS_WATCHDOG_FAILURES:
                await ensure_websocket_server()
                failures = 0
        except asyncio.CancelledError:
            raise
        except Exception:
            logger.exception("[WATCHDOG] Unexpected error")


@asynccontextmanager
async def lifespan(app: FastAPI):
    task = None
    if WS_WATCHDOG_INTERVAL > 0:
        task = asyncio.create_task(_websocket_watchdog())
        logger.info("[WATCHDOG] started interval=%ss failures=%s",
                    WS_WATCHDOG_INTERVAL, WS_WATCHDOG_FAILURES)
    try:
        yield
    finally:
        if task:
            task.cancel()


app = FastAPI(root_path="/wenet_api", lifespan=lifespan)
app.middleware("http")(log_http_requests)


# Cấu hình model (thay đường dẫn nếu bind từ host)
MODEL_PATH = "./model/final.zip"
UNIT_PATH = "./model/units.txt"
DECODER = "./wenet/libtorch/build/bin/decoder_main"
DECODE_DIR = "./tmp/wenet_decode"
os.makedirs(DECODE_DIR, exist_ok=True)

# Enable CORS for web frontend
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

def _normalize_contexts(value):
    """
    Chuẩn hóa `contexts` (list[str]) cho WeNet: NFC, UPPERCASE, bỏ rỗng/trùng.
    units.txt của model chỉ chứa ký tự IN HOA (vd: ▁TƯ, ▁HÀ, ▁NỘI) nên chữ thường sẽ bị OOV.
    """
    if not isinstance(value, list):
        return []

    result = []
    for item in value:
        text = unicodedata.normalize("NFC", str(item)).strip().upper()
        if text and text not in result:
            result.append(text)
    return result


def _prepare_wenet_start_message(text):
    try:
        payload = json.loads(text)
    except (TypeError, json.JSONDecodeError):
        return text

    if not isinstance(payload, dict) or payload.get("signal") != "start":
        return text

    for key in ("context", "dictionary", "context_words"):
        payload.pop(key, None)

    contexts = _normalize_contexts(payload.get("contexts"))
    payload["contexts"] = contexts
    logger.info("[PROXY] start contexts=%s", contexts)

    return json.dumps(payload, ensure_ascii=False)

@app.get("/health")
async def health(auto_restart: bool = True):
    """
    Hàm kiểm tra sức khỏe hệ thống (Health Check):
    - Kiểm tra xem API WeNet WebSocket (port 10088) còn hoạt động không.
    - Nếu WebSocket không hoạt động, tự động gọi lại (auto restart).
    """
    is_alive = await check_websocket_alive(timeout=1.0)
    was_restarted = False

    if not is_alive and auto_restart:
        logger.warning("[HEALTH CHECK] WebSocket server không phản hồi! Đang tự động gọi lại...")
        was_restarted = await ensure_websocket_server()
        is_alive = await check_websocket_alive(timeout=1.0)

    status = "healthy" if is_alive else "unhealthy"
    # 503 when unhealthy so Docker/load balancers can detect it
    return JSONResponse(
        status_code=200 if is_alive else 503,
        content={
            "status": status,
            "service": "wenet-streaming-asr",
            "websocket": {
                "alive": is_alive,
                "port": WS_PORT,
                "auto_restarted": was_restarted,
            },
            "model_exists": os.path.exists(MODEL_PATH),
            "units_exists": os.path.exists(UNIT_PATH),
        },
    )



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
        "--simulate_streaming", "0",
        "--thread_num", "2",
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

    # Kiểm tra và tự động khởi động WeNet WebSocket server nếu chưa hoạt động
    if not await check_websocket_alive(timeout=0.6):
        logger.warning("[PROXY] WeNet WebSocket server offline! Đang tự động gọi lại...")
        is_ready = await ensure_websocket_server()
        if not is_ready:
            logger.error("[PROXY] Không thể khởi động WeNet WebSocket server!")
            await websocket.close(code=1011)
            return

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
                            await ws_server.send(
                                _prepare_wenet_start_message(msg["text"])
                            )
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