# WeNet Streaming ASR Demo Website
Giao diện web trực quan cho mô hình nhận diện giọng nói thời gian thực (Streaming ASR) dựa trên WeNet Libtorch C++ Engine & FastAPI.

---

## 🌟 Tính năng nổi bật

1. **🎙️ Live Microphone Streaming (Nhận diện thời gian thực từ Mic)**:
   - Thu âm trực tiếp từ trình duyệt qua Web Audio API.
   - Tự động downsample âm thanh chuẩn **16,000 Hz, 16-bit PCM Mono**.
   - Stream từng chunk (160ms - 200ms) qua WebSocket tới backend WeNet.
   - Hiển thị kết quả tạm thời (**Interim Partial Result**) ngay khi đang nói và chốt câu hoàn chỉnh (**Final Result**) kèm mốc thời gian (timestamp).
   - Canvas Audio Waveform Visualizer 60fps mượt mà, đổi màu gradient bắt mắt khi nói.

2. **📁 Audio File Streaming & Benchmark (Demo file âm thanh)**:
   - Hỗ trợ kéo thả file WAV, MP3, M4A, FLAC.
   - **Stream File qua WebSocket**: Phát file âm thanh và stream giả lập thời gian thực để người xem thấy chữ hiển thị khớp với lời nói 
   - **Batch Transcribe**: Gọi REST API `POST /transcribe_file` để nhận diện toàn bộ file.

3. **🎯 Hotwords & Context Biasing (Tính năng cao cấp của WeNet)**:
   - Thêm danh sách từ khóa ưu tiên (proper nouns, tên riêng, thương hiệu công ty như *WeNet, Deep Learning, Trí tuệ nhân tạo*...).
   - Tinh chỉnh `context_score` (1.0 - 10.0) trực tiếp trên giao diện để chứng minh khả năng nhận diện chính xác các từ hiếm gặp.

4. **📋 Xuất & Chia sẻ kết quả**:
   - 1-click Copy toàn bộ văn bản vào Clipboard.
   - Tải file Transcript `.txt` kèm timestamp.
   - Thống kê thời lượng, số gói tin stream, tổng số từ.

---

## 🚀 Hướng dẫn khởi chạy Web ở ngoài Docker

Web UI chạy hoàn toàn độc lập ở máy host bên ngoài Docker, chỉ cần gọi đến API port của backend WeNet:

### Bước 1: Chạy backend WeNet trong Docker (hoặc Local)
```bash
docker-compose up -d
```
*(Backend WeNet sẽ lắng nghe tại cổng `1111` cho API/WebSocket và `1112` cho C++ WebSocket).*

### Bước 2: Khởi động Web ở ngoài Docker
Chạy script tại thư mục gốc:
```bash
./start_web.sh 3000
```
Hoặc:
```bash
python3 web/serve.py 3000
```

Mở trình duyệt truy cập:
👉 **`http://localhost:3000`**

Giao diện sẽ tự động kết nối ngầm tới WeNet API tại `localhost:1111` (hoặc cổng local `8266`).

