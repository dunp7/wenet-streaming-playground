# wenet-streaming-playground

An experimental C++ streaming ASR project based on WeNet. This repository is dedicated to analyzing the streaming inference workflow, decoding mechanisms, chunk-based processing, and latency optimization. It includes custom modifications and performance experiments aimed at improving real-time speech recognition efficiency and flexibility.

## Source & Upstream Reference

This project is built against the upstream [WeNet](https://github.com/wenet-e2e/wenet) repository:

- **Repository:** https://github.com/wenet-e2e/wenet
- **Base Commit:** `015469960db73eb19c49a48c020d5ac9db69bae5`
- **Dependencies Patch:** Pin `wetextprocessing` in `runtime/core/cmake/wetextprocessing.cmake` to commit `64761cba3894b9a4d9143618ac3a800e90bc8a61` to avoid breaking changes on master.

### Clone & Checkout

```bash
git clone [https://github.com/wenet-e2e/wenet.git](https://github.com/wenet-e2e/wenet.git)
cd wenet
git checkout 015469960db73eb19c49a48c020d5ac9db69bae5
```

---

## Web Demo UI (LinkedIn Demo)

Giao diện Web demo tương tác thời gian thực chạy độc lập ở ngoài Docker:

```bash
# Khởi động Web UI (mặc định port 3000):
./start_web.sh 3000
```

Sau đó truy cập: **`http://localhost:3000`** (giao diện sẽ tự động gọi tới backend WeNet Docker tại port `1111` hoặc local port `8266`).

