import os
import json
import asyncio
import websockets
import time

WENET_OUTPUT_FOLDER = "output"
URI = "ws://localhost:1111/audio_streaming"

CHUNK_SIZE = 6400
SLEEP_TIME = 0.05
MAX_CONCURRENT = 3

SEM = asyncio.Semaphore(MAX_CONCURRENT)
os.makedirs(WENET_OUTPUT_FOLDER, exist_ok=True)


async def send_pcm(ws, filename, chunk_size):
    try:
        with open(filename, "rb") as f:
            while True:
                chunk = f.read(chunk_size)

                if not chunk:
                    break

                await ws.send(chunk)
                await asyncio.sleep(SLEEP_TIME)

        await ws.send(json.dumps({"signal": "end"}))

    except websockets.exceptions.ConnectionClosedOK:
        print("WebSocket closed by server while sending data")


async def recv_result(ws, output_filename):
    result_lines = []

    try:
        while True:
            msg = await ws.recv()
            print("Proxy trả về:", msg)

            if msg.startswith("final_result:"):
                result = msg[len("final_result:"):].strip()
                print("👉 Final result:", result)
                result_lines.append(result)

    except websockets.exceptions.ConnectionClosed:
        with open(output_filename, "w", encoding="utf-8") as f:
            for line in result_lines:
                f.write(line + "\n")

        print(f"Đã lưu kết quả vào {output_filename}")


async def process_file(config):
    audio_path = config["audio_path"]
    context_words = config.get("context_words", "")
    context_score = config.get("context_score", 0)

    audio_name = os.path.basename(audio_path)

    # để dễ phân biệt kết quả khi cùng audio nhưng khác context
    context_name = (
        context_words
        .replace(" ", "_")
        .replace("/", "_")
        if context_words else "no_context"
    )

    output_path = os.path.join(
        WENET_OUTPUT_FOLDER,
        f"{os.path.splitext(audio_name)[0]}__{context_name}.txt"
    )

    print(
        f"\nBắt đầu xử lí:"
        f"\n  audio   = {audio_path}"
        f"\n  context = {context_words}"
        f"\n  score   = {context_score}"
    )

    start_time = time.time()

    async with websockets.connect(URI) as ws:

        start_message = {
            "signal": "start",
            "nbest": 20,
            "continuous_decoding": True,
            "context_words": context_words,
            "context_score": context_score,
        }

        await ws.send(json.dumps(start_message))

        await asyncio.gather(
            send_pcm(ws, audio_path, CHUNK_SIZE),
            recv_result(ws, output_path),
        )

    print(
        f"Hoàn thành {audio_name} - context={context_words} "
        f"sau {time.time() - start_time:.3f}s"
    )


async def process_file_limited(config):
    async with SEM:
        await process_file(config)


async def main(test_cases):
    print(f"🔊 Found {len(test_cases)} test cases")

    tasks = [
        asyncio.create_task(process_file_limited(config))
        for config in test_cases
    ]

    await asyncio.gather(*tasks)


if __name__ == "__main__":

    test_cases = [
        {
            "audio_path": "/mnt/disk1/free_space/vietnamese-asr-lab/sample/common_voice_vi_25092495.wav",
            "context_words": "tư",
            "context_score": 3.0,
        },
        {
            "audio_path": "/mnt/disk1/free_space/vietnamese-asr-lab/sample/common_voice_vi_25092495.wav",
        },
    ]

    asyncio.run(main(test_cases))