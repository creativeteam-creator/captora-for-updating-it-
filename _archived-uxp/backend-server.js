/**
 * Kalakar Auto Captions - Backend Bridge Server
 * Node.js server that interfaces with OpenAI Whisper API
 * Runs alongside Premiere Pro as a local service
 *
 * START SERVER: node backend-server.js
 * REQUIRES: OPENAI_API_KEY environment variable
 */

const express = require("express");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const fs = require("fs");
const path = require("path");
const cors = require("cors");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// File upload configuration
const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: {
    fileSize: 25 * 1024 * 1024, // 25MB max (Whisper API limit)
  },
  fileFilter: (req, file, cb) => {
    const validMimes = [
      "audio/mpeg",
      "audio/wav",
      "audio/mp4",
      "audio/aac",
      "audio/flac",
      "audio/ogg",
      "audio/webm",
    ];
    if (validMimes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid audio format"));
    }
  },
});

/**
 * Health check endpoint
 */
app.get("/health", (req, res) => {
  res.json({
    status: "healthy",
    service: "kalakar-backend-bridge",
    version: "1.0.0",
    timestamp: new Date().toISOString(),
  });
});

/**
 * Transcribe audio using OpenAI Whisper API
 * POST /api/transcribe
 *
 * Expected form data:
 * - audio: Audio file
 * - language: Language code (optional)
 * - model: Whisper model (default: whisper-1)
 *
 * Returns:
 * {
 *   success: boolean,
 *   whisper_response: { words: [...], text: "...", duration: ... },
 *   processing_time_ms: number,
 *   metadata: { filename, size, ... }
 * }
 */
app.post("/api/transcribe", upload.single("audio"), async (req, res) => {
  const startTime = Date.now();

  try {
    // Validate file upload
    if (!req.file) {
      return res.status(400).json({
        success: false,
        error: "No audio file provided",
      });
    }

    const filePath = req.file.path;
    const fileName = req.file.originalname;
    const fileSize = req.file.size;

    console.log(`[Transcribe] Processing: ${fileName} (${fileSize} bytes)`);

    // Validate OpenAI API key
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) {
      throw new Error("OPENAI_API_KEY environment variable not set");
    }

    // Create form data for Whisper API
    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));
    formData.append("model", req.body.model || "whisper-1");

    // Optional parameters
    if (req.body.language) {
      formData.append("language", req.body.language);
    }

    // Request word-level timestamps
    formData.append("timestamp_granularities[]", "word");
    formData.append("response_format", "json");

    // Call OpenAI Whisper API
    console.log("[Whisper API] Sending request...");
    const whisperResponse = await axios.post(
      "https://api.openai.com/v1/audio/transcriptions",
      formData,
      {
        headers: {
          ...formData.getHeaders(),
          Authorization: `Bearer ${apiKey}`,
        },
        timeout: 120000, // 2 minutes timeout
      }
    );

    const whisperData = whisperResponse.data;

    console.log(
      `[Whisper API] Success - ${whisperData.words?.length || 0} words`
    );

    // Validate word-level timestamps
    if (!whisperData.words || whisperData.words.length === 0) {
      console.warn("[Warning] No word-level timestamps returned by Whisper");
    }

    // Cleanup uploaded file
    fs.unlink(filePath, (err) => {
      if (err) console.error("[Cleanup] File deletion failed:", err.message);
    });

    const processingTime = Date.now() - startTime;

    return res.json({
      success: true,
      whisper_response: {
        text: whisperData.text,
        duration: whisperData.duration,
        language: whisperData.language || "en",
        words: whisperData.words || [],
      },
      processing_time_ms: processingTime,
      metadata: {
        filename: fileName,
        size_bytes: fileSize,
        word_count: whisperData.words?.length || 0,
        model: req.body.model || "whisper-1",
      },
    });
  } catch (error) {
    // Cleanup file on error
    if (req.file) {
      fs.unlink(req.file.path, (err) => {
        if (err) console.error("[Cleanup] Error deleting file:", err.message);
      });
    }

    console.error("[Error] Transcription failed:", error.message);

    const statusCode = error.response?.status || 500;
    const errorMessage =
      error.response?.data?.error?.message || error.message;

    return res.status(statusCode).json({
      success: false,
      error: errorMessage,
      error_type: error.response?.data?.error?.type || "unknown",
      details: {
        message: error.message,
        status_code: statusCode,
      },
    });
  }
});

/**
 * Batch transcribe multiple files
 * POST /api/transcribe-batch
 *
 * Expected form data:
 * - audio: Multiple audio files
 * - language: Language code (optional)
 *
 * Returns: Array of transcription results
 */
app.post("/api/transcribe-batch", upload.array("audio", 10), async (req, res) => {
  try {
    const results = [];

    if (!req.files || req.files.length === 0) {
      return res.status(400).json({
        success: false,
        error: "No audio files provided",
      });
    }

    console.log(`[Batch] Processing ${req.files.length} files`);

    // Process each file
    for (const file of req.files) {
      const mockResult = {
        filename: file.originalname,
        status: "pending",
        // In production, implement actual parallel processing
      };
      results.push(mockResult);
    }

    // Cleanup files
    req.files.forEach((file) => {
      fs.unlink(file.path, (err) => {
        if (err) console.error("[Cleanup] Error:", err.message);
      });
    });

    return res.json({
      success: true,
      batch_id: Date.now(),
      files_queued: results.length,
      results,
    });
  } catch (error) {
    console.error("[Batch Error]:", error.message);
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Send project metadata to n8n webhook
 * POST /api/webhook/n8n
 *
 * Expected body:
 * {
 *   webhook_url: string,
 *   payload: { ... }
 * }
 */
app.post("/api/webhook/n8n", express.json(), async (req, res) => {
  try {
    const { webhook_url, payload } = req.body;

    if (!webhook_url || !payload) {
      return res.status(400).json({
        success: false,
        error: "webhook_url and payload required",
      });
    }

    console.log(`[Webhook] Sending to: ${webhook_url}`);

    const response = await axios.post(webhook_url, payload, {
      timeout: 10000,
    });

    return res.json({
      success: true,
      status_code: response.status,
      message: "Webhook delivered successfully",
    });
  } catch (error) {
    console.error("[Webhook Error]:", error.message);
    res.status(error.response?.status || 500).json({
      success: false,
      error: error.message,
    });
  }
});

/**
 * Get server status and configuration
 * GET /api/status
 */
app.get("/api/status", (req, res) => {
  const hasApiKey = !!process.env.OPENAI_API_KEY;

  res.json({
    status: "running",
    version: "1.0.0",
    uptime_ms: process.uptime() * 1000,
    timestamp: new Date().toISOString(),
    config: {
      port: PORT,
      openai_api_key_configured: hasApiKey,
      max_file_size_mb: 25,
      supported_formats: [
        "mp3",
        "wav",
        "m4a",
        "aac",
        "flac",
        "ogg",
        "webm",
      ],
    },
  });
});

/**
 * Error handling middleware
 */
app.use((err, req, res, next) => {
  console.error("[Middleware Error]:", err.message);

  if (err instanceof multer.MulterError) {
    if (err.code === "FILE_TOO_LARGE") {
      return res.status(413).json({
        success: false,
        error: "File too large (max 25MB)",
      });
    }
    return res.status(400).json({
      success: false,
      error: err.message,
    });
  }

  res.status(500).json({
    success: false,
    error: err.message || "Internal server error",
  });
});

/**
 * 404 handler
 */
app.use((req, res) => {
  res.status(404).json({
    success: false,
    error: "Endpoint not found",
    available_endpoints: [
      "GET /health",
      "GET /api/status",
      "POST /api/transcribe",
      "POST /api/transcribe-batch",
      "POST /api/webhook/n8n",
    ],
  });
});

/**
 * Start server
 */
app.listen(PORT, () => {
  console.log("━".repeat(60));
  console.log("🎬 Kalakar Backend Bridge Server");
  console.log("━".repeat(60));
  console.log(`✓ Server running on http://localhost:${PORT}`);
  console.log(`✓ Health check: GET http://localhost:${PORT}/health`);
  console.log(`✓ Transcribe endpoint: POST http://localhost:${PORT}/api/transcribe`);
  console.log("━".repeat(60));

  // Verify OpenAI API key
  if (!process.env.OPENAI_API_KEY) {
    console.warn("⚠️  WARNING: OPENAI_API_KEY not set");
    console.warn("   Set it: export OPENAI_API_KEY=sk-...");
  } else {
    console.log("✓ OpenAI API key configured");
  }

  console.log("━".repeat(60));
});

// Graceful shutdown
process.on("SIGTERM", () => {
  console.log("Server shutting down...");
  process.exit(0);
});

module.exports = app;
