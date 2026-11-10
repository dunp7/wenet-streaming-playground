/**
 * WeNet Streaming ASR Playground - Web Application
 * Handles Real-time Microphone Streaming, Audio Resampling (16kHz PCM),
 * WebSocket proxy/direct protocols, Audio Visualizer, Hotwords Biasing,
 * and Robust WebSocket Auto-Recovery & Restart Mechanism.
 */

(function () {
  "use strict";

  // ==========================================================================
  // Configuration & State
  // ==========================================================================

  // Check URL params for quick port/host config (e.g. ?port=8266 or ?port=1111)
  const urlParams = new URLSearchParams(window.location.search);
  const paramPort = urlParams.get("port");
  const paramHost = urlParams.get("host");

  if (paramPort) localStorage.setItem("wenet_port", paramPort);
  if (paramHost) localStorage.setItem("wenet_host", paramHost);

  const defaultApiPort = (window.location.port === "1111" || window.location.port === "8266")
    ? window.location.port
    : "1111";

  const state = {
    // Config
    host: localStorage.getItem("wenet_host") || (window.location.hostname || "localhost"),
    port: localStorage.getItem("wenet_port") || defaultApiPort,
    wsPath: "/audio_streaming",
    protocol: window.location.protocol === "https:" ? "wss" : "ws",

    // WebSocket Manager State
    ws: null,
    wsState: "disconnected", // disconnected | connecting | connected | streaming | error
    reconnectTimer: null,
    reconnectAttempts: 0,
    maxReconnectAttempts: 5,
    isManualClosing: false,

    // Runtime Audio
    audioContext: null,
    mediaStream: null,
    audioInput: null,
    scriptProcessor: null,
    analyser: null,
    isRecording: false,
    isFileStreaming: false,

    // Audio Buffer & Resampling
    targetSampleRate: 16000,
    chunkDurationSec: 0.16, // 160ms chunks (~2560 samples = 5120 bytes)
    sampleBuffer: [],

    // Stats
    startTime: 0,
    timerInterval: null,
    packetsSent: 0,
    totalWords: 0,

    // File Demo
    selectedFile: null,
    fileAudioBuffer: null,
    fileStreamInterval: null,

    // Transcript
    sentences: [],
    activeSentenceElem: null,
    activeTimestamp: ""
  };

  // DOM Elements
  const el = {
    // Navbar & Connection
    connBadge: document.getElementById("connBadge"),
    connLabel: document.getElementById("connLabel"),

    // Tabs
    tabButtons: document.querySelectorAll(".tab-btn"),
    tabContents: document.querySelectorAll(".tab-content"),

    // Mic Tab
    btnRecord: document.getElementById("btnRecord"),
    recordBtnText: document.getElementById("recordBtnText"),
    waveformCanvas: document.getElementById("waveformCanvas"),
    visualizerOverlay: document.getElementById("visualizerOverlay"),
    vizStatus: document.getElementById("vizStatus"),

    // File Tab
    dropZone: document.getElementById("dropZone"),
    fileInput: document.getElementById("fileInput"),
    fileInfoCard: document.getElementById("fileInfoCard"),
    fileName: document.getElementById("fileName"),
    fileMeta: document.getElementById("fileMeta"),
    audioPreview: document.getElementById("audioPreview"),
    btnRemoveFile: document.getElementById("btnRemoveFile"),
    btnStreamFile: document.getElementById("btnStreamFile"),
    btnTranscribeRest: document.getElementById("btnTranscribeRest"),

    // Context / Hotwords
    contextWords: document.getElementById("contextWords"),
    contextScore: document.getElementById("contextScore"),
    contextScoreVal: document.getElementById("contextScoreVal"),
    quickTags: document.querySelectorAll(".quick-tag"),

    // Metrics
    metricDuration: document.getElementById("metricDuration"),
    metricPackets: document.getElementById("metricPackets"),
    metricWords: document.getElementById("metricWords"),
    metricLatency: document.getElementById("metricLatency"),

    // Transcript Output
    transcriptViewport: document.getElementById("transcriptViewport"),
    transcriptPlaceholder: document.getElementById("transcriptPlaceholder"),
    finalSentences: document.getElementById("finalSentences"),
    streamStatusMsg: document.getElementById("streamStatusMsg"),
    statusIndicator: document.querySelector(".status-indicator"),

    // Output Tools
    btnRefresh: document.getElementById("btnRefresh"),
    btnCopy: document.getElementById("btnCopy"),
    btnDownload: document.getElementById("btnDownload"),
    btnClear: document.getElementById("btnClear"),
    toast: document.getElementById("toast")
  };

  // Canvas 2D Context
  const canvasCtx = el.waveformCanvas.getContext("2d");
  let animFrameId = null;

  // ==========================================================================
  // Initialization
  // ==========================================================================

  function init() {
    loadSavedHotwords();
    setupEventListeners();
    updateConnectionTargetDisplay();
    startIdleWaveform();

    // Initial WebSocket connection check
    connectWebSocket(false);
  }

  function loadSavedHotwords() {
    let savedWords = localStorage.getItem("wenet_contexts") || "";
    savedWords = savedWords
      .split(/[\n,]+/)
      .map(w => w.trim())
      .filter(w => w && !/aimesoft/i.test(w))
      .join(", ");

    // Nếu rỗng hoặc là danh sách cũ quá dài, reset về 4 từ ngắn gọn mặc định
    if (!savedWords || savedWords.includes("Nhận dạng giọng nói") || savedWords.includes("Chuyển đổi số")) {
      savedWords = "WeNet, AI, Hà Nội, Việt Nam";
    }

    el.contextWords.value = savedWords;
    localStorage.setItem("wenet_contexts", savedWords);

    const savedScore = localStorage.getItem("wenet_context_score");
    if (savedScore) {
      el.contextScore.value = savedScore;
      el.contextScoreVal.textContent = parseFloat(savedScore).toFixed(1);
    }
  }

  function updateConnectionTargetDisplay() {
    // Background connection setup
  }

  function setConnectionBadge(status, label) {
    el.connBadge.classList.remove("connected", "connecting");
    state.wsState = status;

    if (status === "connected") {
      el.connBadge.classList.add("connected");
      el.connLabel.textContent = label || "Đã kết nối";
      el.statusIndicator.classList.add("active");
    } else if (status === "connecting") {
      el.connBadge.classList.add("connecting");
      el.connLabel.textContent = label || "Đang kết nối...";
      el.statusIndicator.classList.remove("active");
    } else {
      el.connLabel.textContent = label || "Mất kết nối";
      el.statusIndicator.classList.remove("active");
    }
  }

  // ==========================================================================
  // Event Listeners
  // ==========================================================================

  function setupEventListeners() {
    // Clickable Connection Badge to reconnect
    if (el.connBadge) {
      el.connBadge.addEventListener("click", () => restartWebSocket(true));
    }

    // Tabs
    el.tabButtons.forEach(btn => {
      btn.addEventListener("click", () => {
        if (state.isRecording || state.isFileStreaming) {
          showToast("Vui lòng dừng thu âm trước khi chuyển tab.");
          return;
        }
        el.tabButtons.forEach(b => b.classList.remove("active"));
        el.tabContents.forEach(c => c.classList.remove("active"));
        btn.classList.add("active");
        document.getElementById(btn.dataset.tab).classList.add("active");
      });
    });

    // Record Button (Mic)
    el.btnRecord.addEventListener("click", toggleRecording);

    // Context / Hotwords
    el.contextScore.addEventListener("input", (e) => {
      el.contextScoreVal.textContent = parseFloat(e.target.value).toFixed(1);
      localStorage.setItem("wenet_context_score", e.target.value);
    });

    el.contextWords.addEventListener("change", (e) => {
      localStorage.setItem("wenet_contexts", e.target.value);
    });

    el.quickTags.forEach(tag => {
      tag.addEventListener("click", () => {
        const word = tag.dataset.word;
        const current = el.contextWords.value.trim();
        if (!current) {
          el.contextWords.value = word;
        } else {
          const currentWords = current.split(/[\n,]+/).map(w => w.trim().toLowerCase());
          if (!currentWords.includes(word.toLowerCase())) {
            el.contextWords.value = current + ", " + word;
          }
        }
        localStorage.setItem("wenet_contexts", el.contextWords.value);
        showToast(`Đã thêm từ khóa: "${word}"`);
      });
    });

    // File Drag & Drop
    el.dropZone.addEventListener("click", () => el.fileInput.click());
    el.fileInput.addEventListener("change", (e) => {
      if (e.target.files.length > 0) handleFileSelected(e.target.files[0]);
    });

    el.dropZone.addEventListener("dragover", (e) => {
      e.preventDefault();
      el.dropZone.classList.add("dragover");
    });
    el.dropZone.addEventListener("dragleave", () => {
      el.dropZone.classList.remove("dragover");
    });
    el.dropZone.addEventListener("drop", (e) => {
      e.preventDefault();
      el.dropZone.classList.remove("dragover");
      if (e.dataTransfer.files.length > 0) handleFileSelected(e.dataTransfer.files[0]);
    });

    // File Actions
    if (el.btnRemoveFile) {
      el.btnRemoveFile.addEventListener("click", removeSelectedFile);
    }
    el.btnStreamFile.addEventListener("click", toggleFileStreaming);
    el.btnTranscribeRest.addEventListener("click", transcribeFileViaRest);

    // Output Tools
    if (el.btnRefresh) {
      el.btnRefresh.addEventListener("click", refreshSession);
    }
    el.btnCopy.addEventListener("click", copyTranscriptToClipboard);
    el.btnDownload.addEventListener("click", downloadTranscriptTxt);
    el.btnClear.addEventListener("click", clearTranscript);
  }

  // ==========================================================================
  // Context Words Parsing (Vietnamese)
  // ==========================================================================

  function parseContextWords() {
    const raw = el.contextWords.value || "";
    const items = raw
      .split(/[\n,]+/)
      .map(s => s.trim().normalize("NFC").toUpperCase())
      .filter(Boolean);
    return Array.from(new Set(items));
  }

  // ==========================================================================
  // Robust WebSocket Manager (Connect, Auto-Reconnect & Restart)
  // ==========================================================================

  async function checkPortHealth(port, proto, host) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 600);
    try {
      const resp = await fetch(`${proto}://${host}:${port}/health`, {
        signal: controller.signal,
        mode: "cors"
      });
      clearTimeout(timeoutId);
      if (resp.ok) return port;
      throw new Error(`HTTP ${resp.status}`);
    } catch (e) {
      clearTimeout(timeoutId);
      throw e;
    }
  }

  async function autoDetectActivePort() {
    const portsToTry = [state.port, "1111", "8266"].filter((v, i, a) => a.indexOf(v) === i);
    const proto = state.protocol === "wss" ? "https" : "http";

    try {
      // Parallel fast probe: all candidate ports probed simultaneously (fastest wins)
      const activePort = await Promise.any(
        portsToTry.map(p => checkPortHealth(p, proto, state.host))
      );
      if (activePort && state.port !== activePort) {
        console.log(`[WeNet WS] Auto-switched to active port: ${activePort}`);
        state.port = activePort;
        localStorage.setItem("wenet_port", activePort);
        updateConnectionTargetDisplay();
      }
      return activePort;
    } catch (e) {
      return state.port;
    }
  }

  async function connectWebSocket(isManualRestart = false) {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }

    // Clean up existing WebSocket if any
    if (state.ws) {
      state.isManualClosing = true;
      try {
        state.ws.onopen = null;
        state.ws.onmessage = null;
        state.ws.onerror = null;
        state.ws.onclose = null;
        state.ws.close();
      } catch (e) {
        // ignore
      }
      state.ws = null;
    }

    state.isManualClosing = false;
    state.isNormalSessionClose = false;

    // Auto-detect active port if manual restart or on failure
    if (isManualRestart || state.reconnectAttempts >= 2) {
      await autoDetectActivePort();
    }

    const wsUrl = `${state.protocol}://${state.host}:${state.port}${state.wsPath}`;
    console.log("[WeNet WS] Connecting to:", wsUrl);

    setConnectionBadge("connecting", "Đang kết nối...");
    el.streamStatusMsg.textContent = "Đang kết nối tới server nhận dạng...";

    try {
      const ws = new WebSocket(wsUrl);
      ws.binaryType = "arraybuffer";
      state.ws = ws;

      ws.onopen = () => {
        console.log("[WeNet WS] Connected successfully to:", wsUrl);
        state.reconnectAttempts = 0;
        setConnectionBadge("connected", "Đã kết nối");
        el.streamStatusMsg.textContent = "Hệ thống sẵn sàng nhận dạng.";

        if (isManualRestart) {
          showToast("✅ Đã khởi động lại kết nối WebSocket thành công!");
        }

        // If currently in recording or file streaming session, send start payload immediately
        if (state.isRecording || state.isFileStreaming) {
          sendStartSignal();
        }
      };

      ws.onmessage = (event) => {
        handleWebSocketMessage(event.data);
      };

      ws.onerror = (err) => {
        console.warn("[WeNet WS] Error event:", err);
        setConnectionBadge("error", "Lỗi kết nối");
        el.streamStatusMsg.textContent = `Không thể kết nối port ${state.port}. Nhấn 'Khởi động lại WebSocket' để thử lại.`;
      };

      ws.onclose = (event) => {
        console.log(`[WeNet WS] Closed (code=${event.code}, clean=${event.wasClean})`);
        state.ws = null;

        if (state.isManualClosing) {
          setConnectionBadge("disconnected", "Mất kết nối");
          return;
        }

        // Normal session finish from WeNet
        if (state.isNormalSessionClose) {
          setConnectionBadge("connected", "Đã hoàn thành");
          el.streamStatusMsg.textContent = "Phiên nhận dạng đã kết thúc.";
          state.isNormalSessionClose = false;
          return;
        }

        // Unexpected disconnect
        setConnectionBadge("disconnected", "Mất kết nối");
        el.streamStatusMsg.textContent = "WebSocket đã ngắt. Đang tự động kết nối lại...";

        // If speech recognition was actively streaming, notify user
        if (state.isRecording || state.isFileStreaming) {
          showToast("⚠️ Mất kết nối WebSocket giữa chừng! Đang tự động kết nối lại...");
        }

        // Schedule auto-reconnect with exponential backoff (1s, 2s, 3s...)
        scheduleAutoReconnect();
      };

    } catch (err) {
      console.error("[WeNet WS] Init exception:", err);
      setConnectionBadge("error", "Lỗi khởi tạo");
      scheduleAutoReconnect();
    }
  }

  function scheduleAutoReconnect() {
    if (state.reconnectTimer) return;
    if (state.reconnectAttempts >= state.maxReconnectAttempts) {
      console.warn("[WeNet WS] Max reconnect attempts reached.");
      el.streamStatusMsg.textContent = `Mất kết nối tới port ${state.port}. Nhấn 'Khởi động lại WebSocket' khi server sẵn sàng.`;
      return;
    }

    state.reconnectAttempts++;
    const delay = Math.min(1000 * state.reconnectAttempts, 4000);
    console.log(`[WeNet WS] Auto-reconnecting in ${delay}ms (attempt ${state.reconnectAttempts}/${state.maxReconnectAttempts})...`);

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectWebSocket(false);
    }, delay);
  }

  async function restartWebSocket(isUserClick = false) {
    if (el.connBadge) el.connBadge.classList.add("connecting");

    if (isUserClick) {
      showToast("🔄 Đang kết nối lại server...");
    }

    // Stop active recording or file stream to reset clean state
    if (state.isRecording) {
      stopRecording();
    }
    if (state.isFileStreaming) {
      stopFileStreaming();
    }

    state.reconnectAttempts = 0;
    await connectWebSocket(true);
  }

  function ensureWebSocketReady() {
    return new Promise((resolve, reject) => {
      if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        resolve(state.ws);
        return;
      }

      console.log("[WeNet WS] Ensuring WebSocket is ready before streaming...");
      connectWebSocket(false);

      const maxWaitMs = 4000;
      const startTime = Date.now();

      const checkInterval = setInterval(() => {
        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          clearInterval(checkInterval);
          resolve(state.ws);
        } else if (Date.now() - startTime > maxWaitMs) {
          clearInterval(checkInterval);
          reject(new Error(`Timeout kết nối tới port ${state.port} sau ${maxWaitMs}ms`));
        }
      }, 100);
    });
  }

  function sendStartSignal() {
    if (!state.ws || state.ws.readyState !== WebSocket.OPEN) return;

    const contexts = parseContextWords();
    const startPayload = {
      signal: "start",
      nbest: 1,
      continuous_decoding: true,
      contexts: contexts,
      context_score: parseFloat(el.contextScore.value) || 3.0
    };

    console.log("[WeNet WS] Sending START payload:", startPayload);
    state.ws.send(JSON.stringify(startPayload));
  }

  function handleWebSocketMessage(data) {
    if (typeof data !== "string") return;

    // FastAPI proxy string format
    if (data.startsWith("partial_result: ")) {
      const sentence = data.substring("partial_result: ".length).trim();
      onPartialResult(sentence);
      return;
    }
    if (data.startsWith("final_result: ")) {
      const sentence = data.substring("final_result: ".length).trim();
      onFinalResult(sentence);
      return;
    }
    if (data === "server_ready") {
      console.log("[WeNet WS] Server ready signal received.");
      return;
    }

    // Direct C++ Server JSON format
    try {
      const json = JSON.parse(data);
      if (json.type === "partial_result") {
        const sentence = extractSentenceFromNbest(json.nbest);
        onPartialResult(sentence);
      } else if (json.type === "final_result") {
        const sentence = extractSentenceFromNbest(json.nbest);
        onFinalResult(sentence);
      }
    } catch (e) {
      // Raw string fallback
    }
  }

  function extractSentenceFromNbest(nbest) {
    if (!nbest) return "";
    let parsed = nbest;
    if (typeof nbest === "string") {
      try {
        parsed = JSON.parse(nbest);
      } catch (e) {
        return "";
      }
    }
    if (Array.isArray(parsed) && parsed.length > 0 && parsed[0].sentence) {
      return parsed[0].sentence.trim();
    }
    return "";
  }

  function onPartialResult(text) {
    if (!text || !text.trim()) return;
    text = text.trim();

    if (el.transcriptPlaceholder) {
      el.transcriptPlaceholder.style.display = "none";
    }

    // Nếu chưa có dòng partial đang chạy, tạo dòng mới
    if (!state.activeSentenceElem) {
      const elapsedSec = Math.floor((Date.now() - (state.startTime || Date.now())) / 1000);
      state.activeTimestamp = formatTimer(elapsedSec);

      const item = document.createElement("div");
      item.className = "sentence-item sentence-partial";

      const timeSpan = document.createElement("span");
      timeSpan.className = "sentence-timestamp";
      timeSpan.textContent = `[${state.activeTimestamp}]`;

      const textSpan = document.createElement("span");
      textSpan.className = "sentence-text";
      textSpan.textContent = text;

      const cursor = document.createElement("span");
      cursor.className = "live-cursor";

      item.appendChild(timeSpan);
      item.appendChild(textSpan);
      item.appendChild(cursor);

      el.finalSentences.appendChild(item);
      state.activeSentenceElem = item;
    } else {
      // Đang có dòng partial -> THAY THẾ trực tiếp trên dòng này, KHÔNG xuống dòng!
      const textSpan = state.activeSentenceElem.querySelector(".sentence-text");
      if (textSpan) {
        textSpan.textContent = text;
      }
    }

    autoScrollTranscript();
  }

  function onFinalResult(text) {
    if (!text || !text.trim()) return;
    text = text.trim();

    if (el.transcriptPlaceholder) {
      el.transcriptPlaceholder.style.display = "none";
    }

    const timestamp = state.activeTimestamp || formatTimer(Math.floor((Date.now() - (state.startTime || Date.now())) / 1000));

    if (state.activeSentenceElem) {
      // Chốt dòng partial hiện tại thành câu final hoàn chỉnh
      state.activeSentenceElem.className = "sentence-item sentence-final";
      const textSpan = state.activeSentenceElem.querySelector(".sentence-text");
      if (textSpan) {
        textSpan.textContent = text;
      }
      const cursor = state.activeSentenceElem.querySelector(".live-cursor");
      if (cursor) {
        cursor.remove();
      }

      state.sentences.push({ text, timestamp });

      // Giải phóng activeSentenceElem để partial TIẾP THEO sẽ tự động XUỐNG DÒNG mới!
      state.activeSentenceElem = null;
      state.activeTimestamp = "";
    } else {
      // Nếu không có dòng partial nào đang chạy, kiểm tra xem câu cuối có trùng lặp không
      const last = state.sentences.length > 0 ? state.sentences[state.sentences.length - 1] : null;
      if (last && (last.text === text || text.startsWith(last.text) || last.text.startsWith(text))) {
        // Cập nhật lại câu cuối thay vì tạo thêm 1 dòng trùng
        last.text = text;
        const allFinals = el.finalSentences.querySelectorAll(".sentence-item.sentence-final");
        if (allFinals.length > 0) {
          const textSpan = allFinals[allFinals.length - 1].querySelector(".sentence-text");
          if (textSpan) textSpan.textContent = text;
        }
      } else {
        appendFinalSentence(text, timestamp);
      }
    }

    updateWordCount();
    autoScrollTranscript();
  }

  function appendFinalSentence(text, timestamp) {
    state.sentences.push({ text, timestamp });

    const item = document.createElement("div");
    item.className = "sentence-item sentence-final";

    const timeSpan = document.createElement("span");
    timeSpan.className = "sentence-timestamp";
    timeSpan.textContent = `[${timestamp}]`;

    const textSpan = document.createElement("span");
    textSpan.className = "sentence-text";
    textSpan.textContent = text;

    item.appendChild(timeSpan);
    item.appendChild(textSpan);
    el.finalSentences.appendChild(item);

    updateWordCount();
    autoScrollTranscript();
  }

  function finalizeActivePartial() {
    if (state.activeSentenceElem) {
      const textSpan = state.activeSentenceElem.querySelector(".sentence-text");
      const text = textSpan ? textSpan.textContent.trim() : "";
      if (text) {
        state.activeSentenceElem.className = "sentence-item sentence-final";
        const cursor = state.activeSentenceElem.querySelector(".live-cursor");
        if (cursor) cursor.remove();
        state.sentences.push({ text, timestamp: state.activeTimestamp });
        updateWordCount();
      } else {
        state.activeSentenceElem.remove();
      }
      state.activeSentenceElem = null;
      state.activeTimestamp = "";
    }
  }

  function updateWordCount() {
    const allWords = state.sentences.reduce((count, s) => {
      const words = s.text.trim().split(/\s+/).filter(Boolean);
      return count + words.length;
    }, 0);
    state.totalWords = allWords;
    el.metricWords.textContent = allWords;
  }

  function autoScrollTranscript() {
    el.transcriptViewport.scrollTop = el.transcriptViewport.scrollHeight;
  }

  // ==========================================================================
  // Live Microphone Streaming
  // ==========================================================================

  async function toggleRecording() {
    if (state.isRecording) {
      stopRecording();
    } else {
      await startRecording();
    }
  }

  async function startRecording() {
    try {
      // 1. Ensure WebSocket is connected & healthy before recording
      await ensureWebSocketReady();

      // 2. Get User Media
      const constraints = {
        audio: {
          channelCount: 1,
          sampleRate: state.targetSampleRate,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      };

      state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      // 3. Init Web Audio Context
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      state.audioContext = new AudioCtx();
      if (state.audioContext.state === "suspended") {
        await state.audioContext.resume();
      }

      state.audioInput = state.audioContext.createMediaStreamSource(state.mediaStream);

      // Setup Analyser for Visualizer
      state.analyser = state.audioContext.createAnalyser();
      state.analyser.fftSize = 512;
      state.audioInput.connect(state.analyser);

      // 4. Send START signal
      sendStartSignal();

      // 5. Setup Audio Processing (ScriptProcessor with Resampler)
      const bufferSize = 4096;
      state.scriptProcessor = state.audioContext.createScriptProcessor(bufferSize, 1, 1);

      state.sampleBuffer = [];
      const samplesPerChunk = Math.round(state.targetSampleRate * state.chunkDurationSec); // ~2560 samples

      state.scriptProcessor.onaudioprocess = (audioProcessingEvent) => {
        if (!state.isRecording) return;

        const inputData = audioProcessingEvent.inputBuffer.getChannelData(0);

        // Resample inputBuffer to 16kHz PCM Int16
        const pcm16 = downsampleBuffer(
          inputData,
          state.audioContext.sampleRate,
          state.targetSampleRate
        );

        for (let i = 0; i < pcm16.length; i++) {
          state.sampleBuffer.push(pcm16[i]);
        }

        while (state.sampleBuffer.length >= samplesPerChunk) {
          const chunkSamples = state.sampleBuffer.splice(0, samplesPerChunk);
          const chunkInt16 = new Int16Array(chunkSamples);

          if (state.ws && state.ws.readyState === WebSocket.OPEN) {
            state.ws.send(chunkInt16.buffer);
            state.packetsSent++;
            el.metricPackets.textContent = state.packetsSent;
          } else {
            console.warn("[WeNet WS] WebSocket dropped while streaming audio!");
            // Auto reconnect in background
            scheduleAutoReconnect();
          }
        }
      };

      state.audioInput.connect(state.scriptProcessor);
      state.scriptProcessor.connect(state.audioContext.destination);

      // 6. Update UI
      state.isRecording = true;
      state.packetsSent = 0;
      el.metricPackets.textContent = "0";
      state.startTime = Date.now();
      startTimer();

      el.btnRecord.classList.add("recording");
      el.recordBtnText.textContent = "Dừng thu âm";
      el.visualizerOverlay.style.display = "none";
      el.streamStatusMsg.textContent = "Đang thu âm & nhận dạng trực tiếp...";

      startActiveWaveform();
      showToast("Đã bắt đầu thu âm từ Microphone!");
    } catch (err) {
      console.error("Failed to start recording:", err);
      showToast("Lỗi: " + err.message);
      stopRecording();
    }
  }

  function stopRecording() {
    state.isRecording = false;
    state.isNormalSessionClose = true;

    // Send END signal to WebSocket
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      console.log("[WeNet WS] Sending END signal");
      try {
        state.ws.send(JSON.stringify({ signal: "end" }));
      } catch (e) {
        // ignore
      }
    }

    // Stop Media tracks
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(track => track.stop());
      state.mediaStream = null;
    }

    // Disconnect audio nodes
    if (state.scriptProcessor) {
      state.scriptProcessor.disconnect();
      state.scriptProcessor = null;
    }
    if (state.audioInput) {
      state.audioInput.disconnect();
      state.audioInput = null;
    }
    if (state.audioContext) {
      state.audioContext.close();
      state.audioContext = null;
    }

    stopTimer();
    finalizeActivePartial();

    // Reset UI
    el.btnRecord.classList.remove("recording");
    el.recordBtnText.textContent = "Bắt đầu nói (Live Mic)";
    el.visualizerOverlay.style.display = "flex";
    el.vizStatus.textContent = "Đã dừng. Nhấn nút để thu âm lại";
    el.streamStatusMsg.textContent = "Đã hoàn thành nhận dạng.";

    startIdleWaveform();
    showToast("Đã dừng thu âm.");
  }

  // ==========================================================================
  // Audio Resampler (Float32 -> Int16 16000Hz)
  // ==========================================================================

  function downsampleBuffer(buffer, inputSampleRate, outputSampleRate = 16000) {
    if (inputSampleRate === outputSampleRate) {
      const result = new Int16Array(buffer.length);
      for (let i = 0; i < buffer.length; i++) {
        const s = Math.max(-1, Math.min(1, buffer[i]));
        result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      return result;
    }

    const sampleRateRatio = inputSampleRate / outputSampleRate;
    const newLength = Math.round(buffer.length / sampleRateRatio);
    const result = new Int16Array(newLength);

    for (let i = 0; i < newLength; i++) {
      const srcIndex = i * sampleRateRatio;
      const index = Math.floor(srcIndex);
      const frac = srcIndex - index;
      const s0 = buffer[index] || 0;
      const s1 = buffer[index + 1] !== undefined ? buffer[index + 1] : s0;
      const sample = s0 + frac * (s1 - s0);
      const s = Math.max(-1, Math.min(1, sample));
      result[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
    }
    return result;
  }

  // ==========================================================================
  // Audio File Tab: Selected, Stream & Transcribe
  // ==========================================================================

  function handleFileSelected(file) {
    if (!file) return;
    state.selectedFile = file;

    el.dropZone.style.display = "none";
    el.fileInfoCard.style.display = "flex";

    el.fileName.textContent = file.name;
    const sizeMb = (file.size / (1024 * 1024)).toFixed(2);
    el.fileMeta.textContent = `${sizeMb} MB • Sẵn sàng phát hoặc stream`;

    const fileUrl = URL.createObjectURL(file);
    el.audioPreview.src = fileUrl;

    showToast(`Đã chọn file: ${file.name}`);
  }

  function removeSelectedFile(e) {
    if (e) e.stopPropagation();
    if (state.isFileStreaming) {
      stopFileStreaming();
    }
    if (el.audioPreview) {
      el.audioPreview.pause();
      el.audioPreview.src = "";
    }
    state.selectedFile = null;
    state.fileAudioBuffer = null;
    if (el.fileInput) {
      el.fileInput.value = "";
    }
    if (el.fileInfoCard) {
      el.fileInfoCard.style.display = "none";
    }
    if (el.dropZone) {
      el.dropZone.style.display = "block";
    }
    showToast("Đã xóa file âm thanh đã tải lên.");
  }

  async function toggleFileStreaming() {
    if (state.isFileStreaming) {
      stopFileStreaming();
    } else {
      await startFileStreaming();
    }
  }

  async function startFileStreaming() {
    if (!state.selectedFile) {
      showToast("Vui lòng chọn file âm thanh trước.");
      return;
    }

    try {
      // 1. Ensure WebSocket is connected & healthy before streaming file
      await ensureWebSocketReady();

      // Reset any previous partial state so new stream starts clean
      finalizeActivePartial();

      el.btnStreamFile.classList.add("btn-danger-outline");
      el.btnStreamFile.classList.remove("btn-primary");
      el.btnStreamFile.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
          <rect x="5" y="5" width="14" height="14" rx="2"/>
        </svg>
        <span>Dừng Stream File</span>
      `;

      state.isFileStreaming = true;
      el.streamStatusMsg.textContent = "Đang giải mã và stream file âm thanh vào WeNet...";

      // Decode audio file to PCM Float32
      const arrayBuffer = await state.selectedFile.arrayBuffer();
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      const decodeCtx = new AudioCtx();
      const decodedBuffer = await decodeCtx.decodeAudioData(arrayBuffer);
      try {
        await decodeCtx.close();
      } catch (e) {
        // ignore
      }

      // Convert channels: mix down to mono if stereo
      let channelData;
      if (decodedBuffer.numberOfChannels === 1) {
        channelData = decodedBuffer.getChannelData(0);
      } else {
        const ch0 = decodedBuffer.getChannelData(0);
        const ch1 = decodedBuffer.getChannelData(1);
        channelData = new Float32Array(ch0.length);
        for (let i = 0; i < ch0.length; i++) {
          channelData[i] = (ch0[i] + ch1[i]) * 0.5;
        }
      }

      // Play audio preview in sync
      el.audioPreview.currentTime = 0;
      el.audioPreview.play().catch(() => {});

      // Setup analyser for file visualizer (attach MediaElementSource only once)
      try {
        if (!state.fileAudioContext) {
          state.fileAudioContext = new AudioCtx();
          state.fileMediaSource = state.fileAudioContext.createMediaElementSource(el.audioPreview);
          state.analyser = state.fileAudioContext.createAnalyser();
          state.analyser.fftSize = 512;
          state.fileMediaSource.connect(state.analyser);
          state.analyser.connect(state.fileAudioContext.destination);
        } else if (state.fileAudioContext.state === "suspended") {
          state.fileAudioContext.resume();
        }
        startActiveWaveform();
      } catch (vizErr) {
        console.warn("[Audio Viz] Could not attach media element source:", vizErr);
      }

      // Convert entire audio buffer to 16kHz PCM Int16
      const resampledPcm16 = downsampleBuffer(
        channelData,
        decodedBuffer.sampleRate,
        state.targetSampleRate
      );

      // Send start signal
      sendStartSignal();

      // Stream chunks over WebSocket at real-time interval (200ms per chunk)
      const samplesPerChunk = Math.round(state.targetSampleRate * 0.2); // 3200 samples = 200ms
      let chunkOffset = 0;
      state.packetsSent = 0;
      state.startTime = Date.now();
      startTimer();

      state.fileStreamInterval = setInterval(() => {
        if (!state.isFileStreaming) {
          return;
        }

        if (chunkOffset >= resampledPcm16.length) {
          // Finished sending all audio chunks
          finishFileStreaming();
          return;
        }

        const chunkSlice = resampledPcm16.subarray(chunkOffset, chunkOffset + samplesPerChunk);
        chunkOffset += samplesPerChunk;

        if (state.ws && state.ws.readyState === WebSocket.OPEN) {
          // CRITICAL: chunkSlice.buffer references the ENTIRE audio file!
          // Must use chunkSlice.slice().buffer so ONLY this 200ms slice is sent!
          state.ws.send(chunkSlice.slice().buffer);
          state.packetsSent++;
          el.metricPackets.textContent = state.packetsSent;
        } else {
          console.warn("[WeNet WS] Dropped connection during file stream.");
          stopFileStreaming(true);
        }
      }, 200);

      showToast("Đang stream file âm thanh theo thời gian thực!");
    } catch (err) {
      console.error("File streaming error:", err);
      showToast("Lỗi khi stream file: " + err.message);
      stopFileStreaming(true);
    }
  }

  function finishFileStreaming() {
    if (state.fileStreamInterval) {
      clearInterval(state.fileStreamInterval);
      state.fileStreamInterval = null;
    }

    // Send end signal to notify server that input is finished
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({ signal: "end" }));
      } catch (e) {
        // ignore
      }
    }

    el.streamStatusMsg.textContent = "Đã gửi hết dữ liệu audio. Đang chờ kết quả chốt...";

    // Give server up to 1.2s to deliver final_result before resetting controls
    setTimeout(() => {
      if (state.isFileStreaming) {
        stopFileStreaming(false);
      }
    }, 1200);
  }

  function stopFileStreaming(isImmediate = false) {
    state.isFileStreaming = false;
    state.isNormalSessionClose = true;

    if (state.fileStreamInterval) {
      clearInterval(state.fileStreamInterval);
      state.fileStreamInterval = null;
    }

    if (isImmediate && state.ws && state.ws.readyState === WebSocket.OPEN) {
      try {
        state.ws.send(JSON.stringify({ signal: "end" }));
      } catch (e) {
        // ignore
      }
    }

    if (el.audioPreview) {
      el.audioPreview.pause();
    }
    stopTimer();

    // Clean up partial line after a short grace period (if final_result arrives, it gets priority)
    setTimeout(() => {
      finalizeActivePartial();
    }, 350);

    el.btnStreamFile.classList.remove("btn-danger-outline");
    el.btnStreamFile.classList.add("btn-primary");
    el.btnStreamFile.innerHTML = `
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polygon points="5 3 19 12 5 21 5 3"/>
      </svg>
      <span>Phát & Nhận dạng Stream (Real-time Demo)</span>
    `;

    el.streamStatusMsg.textContent = "Đã hoàn thành nhận dạng stream file.";
    startIdleWaveform();
  }

  async function transcribeFileViaRest() {
    if (!state.selectedFile) {
      showToast("Vui lòng chọn file âm thanh trước.");
      return;
    }

    const httpProto = state.protocol === "wss" ? "https" : "http";
    const apiUrl = `${httpProto}://${state.host}:${state.port}/transcribe_file`;

    el.btnTranscribeRest.disabled = true;
    el.btnTranscribeRest.textContent = "Đang xử lý trên server...";
    el.streamStatusMsg.textContent = "Đang gửi file qua REST API (/transcribe_file)...";

    const formData = new FormData();
    formData.append("file", state.selectedFile, state.selectedFile.name);

    try {
      const resp = await fetch(apiUrl, {
        method: "POST",
        body: formData
      });

      if (!resp.ok) {
        throw new Error(`HTTP ${resp.status} ${resp.statusText}`);
      }

      const data = await resp.json();
      const resultText = data.result || "[Không có văn bản]";

      el.transcriptPlaceholder.style.display = "none";
      appendFinalSentence(resultText, formatTimer(0));
      showToast("Nhận dạng file thành công!");
      el.streamStatusMsg.textContent = "Đã hoàn tất nhận dạng file.";
    } catch (err) {
      console.error("Transcribe Error:", err);
      showToast("Lỗi khi xử lý file: " + err.message);
      el.streamStatusMsg.textContent = "Lỗi xử lý file!";
    } finally {
      el.btnTranscribeRest.disabled = false;
      el.btnTranscribeRest.innerHTML = `
        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/>
          <polyline points="13 2 13 9 20 9"/>
        </svg>
        <span>Nhận dạng toàn bộ file (Batch)</span>
      `;
    }
  }

  // ==========================================================================
  // Waveform Visualizer (Canvas 60fps)
  // ==========================================================================

  function startIdleWaveform() {
    if (animFrameId) cancelAnimationFrame(animFrameId);

    const canvas = el.waveformCanvas;
    const ctx = canvasCtx;
    let step = 0;

    function drawIdle() {
      if (state.isRecording || state.isFileStreaming) return;

      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      ctx.beginPath();
      ctx.lineWidth = 2;
      ctx.strokeStyle = "rgba(6, 182, 212, 0.25)";

      for (let x = 0; x < width; x += 4) {
        const y = height / 2 + Math.sin((x + step) * 0.03) * 6;
        if (x === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      ctx.stroke();

      step += 1.5;
      animFrameId = requestAnimationFrame(drawIdle);
    }

    drawIdle();
  }

  function startActiveWaveform() {
    if (animFrameId) cancelAnimationFrame(animFrameId);

    const canvas = el.waveformCanvas;
    const ctx = canvasCtx;
    const analyser = state.analyser;

    if (!analyser) return;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);

    function drawActive() {
      if (!state.isRecording && !state.isFileStreaming) return;

      animFrameId = requestAnimationFrame(drawActive);

      analyser.getByteTimeDomainData(dataArray);

      const width = canvas.width;
      const height = canvas.height;

      ctx.clearRect(0, 0, width, height);

      const gradient = ctx.createLinearGradient(0, 0, width, 0);
      gradient.addColorStop(0, "#06b6d4");
      gradient.addColorStop(0.5, "#3b82f6");
      gradient.addColorStop(1, "#c084fc");

      ctx.lineWidth = 3;
      ctx.strokeStyle = gradient;
      ctx.shadowBlur = 12;
      ctx.shadowColor = "rgba(6, 182, 212, 0.6)";

      ctx.beginPath();

      const sliceWidth = (width * 1.0) / bufferLength;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const v = dataArray[i] / 128.0;
        const y = (v * height) / 2;

        if (i === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }

        x += sliceWidth;
      }

      ctx.lineTo(width, height / 2);
      ctx.stroke();

      ctx.shadowBlur = 0;
    }

    drawActive();
  }

  // ==========================================================================
  // Timers & Metrics
  // ==========================================================================

  function startTimer() {
    if (state.timerInterval) clearInterval(state.timerInterval);
    state.timerInterval = setInterval(() => {
      const elapsedSec = Math.floor((Date.now() - state.startTime) / 1000);
      el.metricDuration.textContent = formatTimer(elapsedSec);
    }, 1000);
  }

  function stopTimer() {
    if (state.timerInterval) {
      clearInterval(state.timerInterval);
      state.timerInterval = null;
    }
  }

  function formatTimer(sec) {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
  }

  // ==========================================================================
  // Output Actions (Copy, Download, Clear)
  // ==========================================================================

  function getFullTranscriptText() {
    return state.sentences.map(s => `[${s.timestamp}] ${s.text}`).join("\n");
  }

  function copyTranscriptToClipboard() {
    const text = state.sentences.map(s => s.text).join(" ");
    if (!text) {
      showToast("Chưa có nội dung để sao chép.");
      return;
    }

    navigator.clipboard.writeText(text).then(() => {
      showToast("Đã sao chép toàn bộ văn bản vào bộ nhớ tạm!");
    }).catch(err => {
      console.error("Clipboard copy error:", err);
      showToast("Không thể sao chép văn bản.");
    });
  }

  function downloadTranscriptTxt() {
    const fullText = getFullTranscriptText();
    if (!fullText) {
      showToast("Chưa có nội dung để tải về.");
      return;
    }

    const blob = new Blob([fullText], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `wenet_transcript_${new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
    showToast("Đã tải xuống file transcript .TXT");
  }

  function clearTranscript() {
    state.sentences = [];
    state.totalWords = 0;
    if (state.activeSentenceElem) {
      state.activeSentenceElem.remove();
      state.activeSentenceElem = null;
      state.activeTimestamp = "";
    }
    el.finalSentences.innerHTML = "";
    if (el.transcriptPlaceholder) {
      el.transcriptPlaceholder.style.display = "block";
    }
    el.metricWords.textContent = "0";
    showToast("Đã xóa nội dung nhận dạng.");
  }

  async function refreshSession() {
    // 1. Dừng ngay thu âm hoặc phát file nếu đang chạy
    if (state.isRecording) {
      stopRecording();
    }
    if (state.isFileStreaming) {
      stopFileStreaming();
    }

    // 2. Ngắt WebSocket hiện tại để ngưng ngay lập tức việc nhận text từ server
    if (state.ws) {
      try {
        state.ws.onmessage = null; // Huỷ lắng nghe tin nhắn cũ
        state.ws.close();
      } catch (e) {
        // ignore
      }
      state.ws = null;
    }

    // 3. Xoá dòng partial đang hiển thị dở dang
    if (state.activeSentenceElem) {
      state.activeSentenceElem.remove();
      state.activeSentenceElem = null;
      state.activeTimestamp = "";
    }

    // 4. Cập nhật UI & kết nối lại WebSocket sạch mới
    setConnectionBadge("connecting", "Đang làm mới...");
    el.streamStatusMsg.textContent = "Đã làm mới • Hệ thống sẵn sàng";
    showToast("🔄 Đã làm mới kết nối và dừng nhận kết quả!");

    state.reconnectAttempts = 0;
    await connectWebSocket(true);
  }

  // ==========================================================================
  // Toast Helper
  // ==========================================================================

  let toastTimer = null;
  function showToast(msg) {
    el.toast.textContent = msg;
    el.toast.classList.add("show");
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.toast.classList.remove("show");
    }, 2800);
  }

  // Start app on DOMContentLoaded
  document.addEventListener("DOMContentLoaded", init);
})();
