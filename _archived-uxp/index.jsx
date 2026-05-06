import React, { useState, useRef } from "react";
import { render } from "react-dom";
import "./styles.css";

/**
 * Kalakar Auto Captions - Main UXP Plugin Panel
 * React-based UI for uploading audio and applying viral-style captions
 */
function KalakarPanel() {
  const [isLoading, setIsLoading] = useState(false);
  const [uploadStatus, setUploadStatus] = useState("");
  const [selectedStyle, setSelectedStyle] = useState("Bold Viral");
  const [audioFile, setAudioFile] = useState(null);
  const [transcriptionData, setTranscriptionData] = useState(null);
  const fileInputRef = useRef(null);

  const styleOptions = [
    {
      id: "bold-viral",
      label: "Bold Viral",
      description: "Yellow highlight · snappy pop-in",
    },
    {
      id: "clean-medical",
      label: "Clean Medical",
      description: "Amber highlight · gentle pop-in",
    },
    {
      id: "tech-minimal",
      label: "Tech Minimal",
      description: "Cyan highlight · medium pop-in",
    },
  ];

  /**
   * Handle file upload
   */
  const handleFileSelect = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = [
      "audio/mpeg",
      "audio/wav",
      "audio/mp4",
      "audio/aac",
      "audio/flac",
    ];
    if (!validTypes.includes(file.type)) {
      setUploadStatus(
        "❌ Invalid file type. Please upload audio (MP3, WAV, M4A, AAC, FLAC)"
      );
      return;
    }

    setAudioFile(file);
    setUploadStatus("✓ File selected: " + file.name);
  };

  /**
   * Trigger file upload dialog
   */
  const openFileBrowser = () => {
    fileInputRef.current?.click();
  };

  /**
   * Upload audio to backend for Whisper transcription
   */
  const handleUploadAndTranscribe = async () => {
    if (!audioFile) {
      setUploadStatus("❌ Please select an audio file first");
      return;
    }

    setIsLoading(true);
    setUploadStatus("⏳ Uploading and transcribing...");

    try {
      // Create FormData for multipart upload
      const formData = new FormData();
      formData.append("audio", audioFile);
      formData.append("model", "whisper-1");
      formData.append("language", "en");
      formData.append("timestamp_granularity", "word");

      // Send to backend Node.js/Python bridge
      // This bridge will forward to OpenAI Whisper API with your API key
      const response = await fetch(
        "http://localhost:3000/api/transcribe", // Your backend server
        {
          method: "POST",
          body: formData,
        }
      );

      if (!response.ok) {
        throw new Error(`Server error: ${response.statusText}`);
      }

      const result = await response.json();

      if (!result.success) {
        throw new Error(result.error || "Transcription failed");
      }

      // Store transcription data for timeline application
      setTranscriptionData(result.whisper_response);

      // Auto-apply to timeline if in Premiere Pro context
      await applyTranscriptionToTimeline(result.whisper_response);

      setUploadStatus(
        `✓ Transcribed ${result.whisper_response.words.length} words successfully!`
      );
    } catch (error) {
      setUploadStatus(`❌ Error: ${error.message}`);
      console.error("Transcription error:", error);
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * Apply transcription to Premiere Pro timeline
   */
  const applyTranscriptionToTimeline = async (whisperData) => {
    try {
      // Access Premiere Pro API
      const { bccSP } = window;

      if (!bccSP || !bccSP.getAppVersion) {
        console.warn("Premiere Pro API not available - offline mode");
        return;
      }

      // Send data to main.js via Premiere Pro ExtendScript bridge
      // This would be handled by a separate ExtendScript file
      const styleConfig = {
        styleTemplate: selectedStyle,
        fontSize: 72,
        enableHighlight: true,
      };

      // Dispatch event to ExtendScript handler
      window.postMessage(
        {
          type: "APPLY_CAPTIONS",
          whisperData,
          styleConfig,
        },
        "*"
      );

      setUploadStatus("✓ Captions applied to timeline!");
    } catch (error) {
      console.error("Timeline application error:", error);
      setUploadStatus("⚠️ Timeline application failed - check console");
    }
  };

  /**
   * Send project metadata to n8n webhook
   */
  const sendToWebhook = async () => {
    if (!transcriptionData) {
      setUploadStatus("❌ No transcription data to send");
      return;
    }

    try {
      const webhookData = {
        timestamp: new Date().toISOString(),
        plugin: "kalakar-auto-captions",
        version: "1.0.0",
        style: selectedStyle,
        transcription: {
          language: transcriptionData.language,
          duration: transcriptionData.duration,
          wordCount: transcriptionData.words.length,
          text: transcriptionData.text,
        },
        metadata: {
          audioFileName: audioFile?.name,
          processingTime: new Date().getTime(), // Would track actual processing time
        },
      };

      // Send to n8n webhook
      const response = await fetch(
        process.env.N8N_WEBHOOK_URL || "https://webhook.site/your-webhook-id",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(webhookData),
        }
      );

      if (response.ok) {
        setUploadStatus("✓ Project metadata sent to n8n");
      } else {
        setUploadStatus("⚠️ Webhook delivery failed");
      }
    } catch (error) {
      console.error("Webhook error:", error);
      setUploadStatus("❌ Webhook error: " + error.message);
    }
  };

  return (
    <div className="kalakar-panel">
      <header className="panel-header">
        <h1>🎬 Kalakar Auto Captions</h1>
        <p>Transform your medical/tech videos with viral-style captions</p>
      </header>

      {/* File Upload Section */}
      <section className="upload-section">
        <h2>Step 1: Upload Audio</h2>
        <div className="file-input-wrapper">
          <input
            ref={fileInputRef}
            type="file"
            accept="audio/*"
            onChange={handleFileSelect}
            style={{ display: "none" }}
          />
          <button className="btn btn-primary" onClick={openFileBrowser}>
            📁 Select Audio File
          </button>
          {audioFile && (
            <span className="file-name">
              {audioFile.name} ({(audioFile.size / 1024 / 1024).toFixed(2)} MB)
            </span>
          )}
        </div>
      </section>

      {/* Style Selection */}
      <section className="style-section">
        <h2>Step 2: Choose Caption Style</h2>
        <div className="style-grid">
          {styleOptions.map((style) => (
            <div
              key={style.id}
              className={`style-card ${
                selectedStyle === style.label ? "selected" : ""
              }`}
              onClick={() => setSelectedStyle(style.label)}
            >
              <div className="style-name">{style.label}</div>
              <div className="style-description">{style.description}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Action Buttons */}
      <section className="action-section">
        <h2>Step 3: Generate Captions</h2>
        <button
          className="btn btn-primary btn-large"
          onClick={handleUploadAndTranscribe}
          disabled={isLoading || !audioFile}
        >
          {isLoading ? "⏳ Processing..." : "🚀 Upload & Transcribe"}
        </button>

        {transcriptionData && (
          <button className="btn btn-secondary" onClick={sendToWebhook}>
            📤 Send to n8n
          </button>
        )}
      </section>

      {/* Status Display */}
      <section className="status-section">
        <div className="status-message">{uploadStatus}</div>
        {transcriptionData && (
          <div className="transcription-preview">
            <details>
              <summary>📋 Transcription Preview</summary>
              <div className="preview-content">
                <p>
                  <strong>Text:</strong> {transcriptionData.text}
                </p>
                <p>
                  <strong>Words:</strong> {transcriptionData.words.length}
                </p>
                <p>
                  <strong>Duration:</strong> {transcriptionData.duration.toFixed(2)}s
                </p>
                <p>
                  <strong>Language:</strong> {transcriptionData.language}
                </p>
              </div>
            </details>
          </div>
        )}
      </section>

      {/* Info Section */}
      <footer className="panel-footer">
        <p>
          💡 <strong>Tip:</strong> Your audio is processed securely via OpenAI
          Whisper API
        </p>
        <p>🔗 Webhook integration ready for automation workflows</p>
      </footer>
    </div>
  );
}

// Render the component
const container = document.getElementById("root");
if (container) {
  render(<KalakarPanel />, container);
}

export default KalakarPanel;
