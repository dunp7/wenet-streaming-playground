"""Daily folder logging for WeNet API. Run: uvicorn api.app:app."""
import fcntl
import logging
import os
import time
from datetime import datetime
from pathlib import Path

from fastapi import Request

# Resolve project root independently of current working directory.
LOG_DIR = Path(__file__).resolve().parent.parent / "logs" / "api_logs"
LOG_LEVEL = getattr(logging, os.getenv("LOG_LEVEL", "INFO").upper(), logging.INFO)


def daily_path(filename):
    """Create today's folder as needed, including when midnight passes."""
    folder = LOG_DIR / datetime.now().strftime("%Y-%m-%d")
    folder.mkdir(parents=True, exist_ok=True)
    return folder / filename


def append_locked(path, contents):
    """Append a whole batch under a cross-process Linux lock."""
    data = contents.encode("utf-8", errors="replace") if isinstance(contents, str) else contents
    with open(path, "ab") as fp:
        fcntl.flock(fp, fcntl.LOCK_EX)
        try:
            fp.write(data)
            fp.flush()
        finally:
            fcntl.flock(fp, fcntl.LOCK_UN)


class DailyFolderHandler(logging.Handler):
    def emit(self, record):
        try:
            append_locked(daily_path("api.log"), self.format(record) + "\n")
        except Exception:
            self.handleError(record)


handler = DailyFolderHandler()
handler.setLevel(LOG_LEVEL)
handler.setFormatter(logging.Formatter(
    "%(asctime)s | %(levelname)s | pid=%(process)d | %(name)s | %(message)s"
))

logger = logging.getLogger("wenet_api")
logger.setLevel(LOG_LEVEL)
logger.propagate = False
if not any(isinstance(h, DailyFolderHandler) for h in logger.handlers):
    logger.addHandler(handler)

for name in ("uvicorn.error", "uvicorn.access"):
    target = logging.getLogger(name)
    if handler not in target.handlers:
        target.addHandler(handler)


def run_decoder(cmd, uid):
    """Keep concurrent decoder outputs separated, then append each complete run."""
    import subprocess
    import tempfile

    with tempfile.TemporaryFile(mode="w+b") as temp:
        result = subprocess.run(cmd, stdout=temp, stderr=subprocess.STDOUT)
        temp.seek(0)
        output = temp.read().decode("utf-8", errors="replace")
    entry = (
        f"{datetime.now().isoformat(timespec='seconds')} | uid={uid} | "
        f"decoder returncode={result.returncode} | BEGIN\n"
        f"{output}"
        f"{' ' if output and not output.endswith(chr(10)) else ''}"
        f"\nuid={uid} | END\n"
    )
    log_path = daily_path("decoder.log")
    append_locked(log_path, entry)
    return result, log_path


async def log_http_requests(request: Request, call_next):
    started = time.perf_counter()
    client = request.client.host if request.client else "-"
    try:
        response = await call_next(request)
    except Exception:
        elapsed = (time.perf_counter() - started) * 1000
        logger.exception("HTTP %s %s client=%s failed duration_ms=%.2f",
                         request.method, request.url.path, client, elapsed)
        raise
    elapsed = (time.perf_counter() - started) * 1000
    logger.info("HTTP %s %s status=%s client=%s duration_ms=%.2f",
                request.method, request.url.path, response.status_code, client, elapsed)
    return response
