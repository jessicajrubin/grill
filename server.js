// grill — voice-based AI mock interviewer
// Architecture: browser mic --(audio)--> server --> Deepgram (STT, streaming)
//               transcript --> Cerebras/Gemma 4 (brain) --> Deepgram Aura-2 (TTS)
//               audio --> browser (plays interviewer's voice)
//
// The loop is built turn-based FIRST (de-risked), with clearly marked hooks
// where streaming-interruption logic layers on top. See INTERRUPTION HOOKS below.

import "dotenv/config";
import express from "express";
import { WebSocketServer } from "ws";
import { createClient, LiveTranscriptionEvents } from "@deepgram/sdk";
import http from "http";
import { spawn } from "child_process";
import { createRequire } from "module";
const require = createRequire(import.meta.url);

const {
  CEREBRAS_API_KEY,
  DEEPGRAM_API_KEY,
  ELEVENLABS_API_KEY,
  ELEVENLABS_VOICE_ID,
} = process.env;

// A clear, friendly fail if a key is missing — errors give direction (per design notes).
function requireKeys() {
  const missing = [];
  if (!CEREBRAS_API_KEY || CEREBRAS_API_KEY.includes("your-")) missing.push("CEREBRAS_API_KEY");
  if (!DEEPGRAM_API_KEY || DEEPGRAM_API_KEY.includes("your-")) missing.push("DEEPGRAM_API_KEY");
  // ElevenLabs no longer required — Deepgram handles voice now.
  if (missing.length) {
    console.error("\n  Missing API keys in .env: " + missing.join(", "));
    console.error("  Copy .env.example to .env and paste your real keys in.\n");
    process.exit(1);
  }
}
requireKeys();

// Default ElevenLabs voice (Rachel) if user didn't pick one — calm, clear, professional.
const VOICE_ID = ELEVENLABS_VOICE_ID || "21m00Tcm4TlvDq8ikWAM";

const app = express();
app.use(express.json({ limit: "10mb" }));
app.use(express.static("public"));

// Holds the most recently uploaded resume text (single-user demo simplicity).
let lastResumeText = "";

// Resume upload: accepts a PDF (base64) or plain text, extracts text.
app.post("/upload-resume", async (req, res) => {
  try {
    const { filename, dataBase64, mime } = req.body || {};
    if (!dataBase64) return res.status(400).json({ error: "No file data." });
    const buf = Buffer.from(dataBase64, "base64");
    let text = "";
    if ((mime && mime.includes("pdf")) || (filename || "").toLowerCase().endsWith(".pdf")) {
      const { PDFParse } = require("pdf-parse");
      const parser = new PDFParse({ data: buf });
      const out = await parser.getText();
      text = out.text || "";
      try { await parser.destroy(); } catch {}
    } else {
      text = buf.toString("utf8");
    }
    text = text.replace(/\s+\n/g, "\n").trim();
    lastResumeText = text;
    console.log(`[resume] uploaded "${filename}" -> ${text.length} chars`);
    res.json({ ok: true, chars: text.length, preview: text.slice(0, 200) });
  } catch (err) {
    console.error("[resume] parse error:", err.message);
    res.status(500).json({ error: "Could not read that file. Try a PDF or .txt." });
  }
});
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const deepgram = createClient(DEEPGRAM_API_KEY);

// ---- The interviewer's brain: the skeptical system prompt ----
// This is the SOUL of the product. It's not a generic helpful assistant —
// it's an interviewer that doesn't believe you yet.
const SYSTEM_PROMPT = `You are a warm, sharp, deeply curious job interviewer conducting a mock interview. Your goal is to make the candidate think hard and go deep, so they leave genuinely prepared.

Your personality:
- You are genuinely curious and encouraging. You make the candidate feel comfortable enough to open up.
- You ask thoughtful, in-depth follow-up questions that get beneath the surface of their answers.
- When an answer is vague, you gently draw out specifics: "Tell me more about your role in that" or "What was going through your mind when you decided that?"
- You explore their reasoning, their decisions, and what they learned. You are interested in the person, not just the resume.
- You ask one focused question at a time and let them talk.

Your style:
- Keep responses SHORT — one or two sentences. This is spoken aloud, so be warm, natural, and conversational.
- Sound like a real, engaged person who is genuinely interested.
- Be supportive and professional. Curiosity, not interrogation.
- Never break character. Never mention you are an AI.

Start by warmly introducing yourself and asking your first question.`

// Build the full system prompt, optionally grounded in the candidate's resume.
function buildSystemPrompt(resumeText) {
  if (resumeText && resumeText.trim()) {
    return SYSTEM_PROMPT +
      "\n\nHere is the candidate's resume. Use it to ask specific, personalized questions about their actual experience, projects, and skills. Reference real details from it.\n\n--- RESUME ---\n" +
      resumeText.trim() +
      "\n--- END RESUME ---";
  }
  return SYSTEM_PROMPT;
}

// ---- Cerebras / Gemma 4: the brain ----
// Keeps a running transcript and asks for the interviewer's next short line.
async function getInterviewerReply(history, systemPrompt) {
  const messages = [
    { role: "system", content: systemPrompt || SYSTEM_PROMPT },
    ...history,
  ];

  const res = await fetch("https://api.cerebras.ai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${CEREBRAS_API_KEY}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: "gemma-4-31b",
      messages,
      // Short, fast replies — this is the speed wedge. Small max keeps latency tiny.
      max_completion_tokens: 120,
      temperature: 0.8,
    }),
  });

  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Cerebras error ${res.status}: ${txt}`);
  }
  const data = await res.json();
  return data.choices[0].message.content.trim();
}

// ---- Deepgram Aura-2: the voice ----
// Same Deepgram key as the ears — one provider for the whole voice loop = lower latency.
async function synthesizeSpeech(text) {
  const res = await fetch(
    "https://api.deepgram.com/v1/speak?model=aura-2-thalia-en&encoding=mp3",
    {
      method: "POST",
      headers: {
        "Authorization": `Token ${DEEPGRAM_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ text }),
    }
  );
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Deepgram TTS error ${res.status}: ${txt}`);
  }
  return Buffer.from(await res.arrayBuffer());
}

// ---- Per-connection session ----
wss.on("connection", (browser) => {
  console.log("Browser connected.");

  // Running interview transcript (what the brain sees).
  const history = [];
  let activeSystemPrompt = lastResumeText
    ? buildSystemPrompt(lastResumeText)
    : SYSTEM_PROMPT; // grounded in uploaded resume if one exists

  // Deepgram live transcription connection (the ears).
  const dgLive = deepgram.listen.live({
    model: "nova-2",
    encoding: "linear16",
    sample_rate: 16000,
    channels: 1,
    language: "en-US",
    smart_format: true,
    interim_results: true, // <-- INTERRUPTION HOOK: interim results let us see words AS they speak
    utterance_end_ms: 1000, // how long a pause means "they're done talking"
    vad_events: true,
  });

  let currentUtterance = "";
  let speaking = false; // is the interviewer currently talking?
  let listening = false; // push-to-talk: only true while user holds the talk button

  // Keep the Deepgram socket alive during silences so it doesn't drop.
  const keepAlive = setInterval(() => {
    try { dgLive.keepAlive(); } catch {}
  }, 8000);

  // ---- Terminal mic capture via ffmpeg (bypasses flaky browser audio) ----
  // Spawns ffmpeg to grab the Mac mic and pipe raw 16kHz PCM straight to Deepgram.
  // Set MIC_DEVICE in .env to your ffmpeg avfoundation audio index (default ":0").
  let ffmpeg = null;
  function startMicCapture() {
    const device = process.env.MIC_DEVICE || ":0";
    ffmpeg = spawn("ffmpeg", [
      "-f", "avfoundation",
      "-i", device,
      "-ac", "1",
      "-ar", "16000",
      "-acodec", "pcm_s16le",
      "-f", "s16le",
      "pipe:1",
    ]);
    ffmpeg.stdout.on("data", (chunk) => {
      if (!listening) return; // push-to-talk: only stream audio while user holds the button
      if (speaking) return;   // never listen while the interviewer is speaking
      try { dgLive.send(chunk); } catch {}
    });
    ffmpeg.stderr.on("data", (d) => {
      const s = d.toString();
      if (s.includes("Error") || s.includes("error") || s.includes("denied")) {
        console.error("[ffmpeg]", s.trim().split("\n").pop());
      }
    });
    ffmpeg.on("close", (code) => console.log(`[ffmpeg] exited (${code})`));
    console.log(`[mic] ffmpeg capturing from device "${device}"`);
  }

  dgLive.on(LiveTranscriptionEvents.Open, () => {
    console.log("Deepgram connection open.");
    startMicCapture(); // begin listening as soon as Deepgram is ready
  });

  // Shared trigger: take the interviewer's turn with whatever we've heard.
  async function finishAnswerAndReply(reason) {
    const answer = currentUtterance.trim();
    if (!answer || speaking) return;
    currentUtterance = "";
    console.log(`[turn] (${reason}) candidate said: "${answer}"`);
    history.push({ role: "user", content: answer });
    browser.send(JSON.stringify({ type: "you_said", text: answer }));
    await runInterviewerTurn();
  }

  dgLive.on(LiveTranscriptionEvents.Transcript, (data) => {
    const alt = data.channel?.alternatives?.[0];
    const transcript = alt?.transcript || "";
    if (!transcript) return;

    // Log every final piece so we can SEE it hearing us.
    if (data.is_final) {
      currentUtterance += " " + transcript;
      console.log(`[heard] ${transcript}${data.speech_final ? "  <speech_final>" : ""}`);
    }

    // speech_final = Deepgram thinks the speaker finished a sentence/pause.
    // This is more reliable than UtteranceEnd alone, so trigger the turn here.
    if (data.speech_final) {
      finishAnswerAndReply("speech_final");
    }

    // ===== INTERRUPTION HOOK (Phase 2) — unchanged, see notes above =====
  });

  // Backup trigger: utterance end (longer pause) also takes the turn.
  dgLive.on(LiveTranscriptionEvents.UtteranceEnd, async () => {
    await finishAnswerAndReply("utterance_end");
  });

  dgLive.on(LiveTranscriptionEvents.Error, (err) => {
    console.error("Deepgram error:", err);
  });

  // Produce the interviewer's next line: brain -> voice -> browser.
  async function runInterviewerTurn() {
    try {
      speaking = true;
      const t0 = Date.now();
      setTimeout(() => { speaking = false; }, 12000); // safety: never stay muted >12s

      const reply = await getInterviewerReply(history, activeSystemPrompt);
      const tBrain = Date.now();

      history.push({ role: "assistant", content: reply });
      browser.send(JSON.stringify({ type: "interviewer_said", text: reply }));

      const audio = await synthesizeSpeech(reply);
      const tVoice = Date.now();

      // Send timing so the UI can SHOW the speed (this is the demo's proof).
      browser.send(JSON.stringify({
        type: "timing",
        brain_ms: tBrain - t0,
        voice_ms: tVoice - tBrain,
        total_ms: tVoice - t0,
      }));

      // Send the audio (base64) for the browser to play.
      browser.send(JSON.stringify({
        type: "audio",
        data: audio.toString("base64"),
      }));
    } catch (err) {
      console.error("Turn error:", err);
      browser.send(JSON.stringify({ type: "error", text: String(err.message || err) }));
    } finally {
      speaking = false;
    }
  }

  // Browser sends raw audio chunks from the mic -> forward to Deepgram.
  browser.on("message", async (msg, isBinary) => {
    if (isBinary) {
      dgLive.send(msg);
      return;
    }
    // Control messages from the browser (JSON).
    try {
      const evt = JSON.parse(msg.toString());
      if (evt.type === "resume") {
        // Candidate loaded their resume text — ground the interviewer in it.
        activeSystemPrompt = buildSystemPrompt(evt.text || "");
        console.log(`[resume] loaded (${(evt.text || "").length} chars)`);
      } else if (evt.type === "start") {
        // Kick off the interview with the interviewer's opening line.
        await runInterviewerTurn();
      } else if (evt.type === "talk_start") {
        listening = true;
        currentUtterance = "";
        console.log("[ptt] listening...");
      } else if (evt.type === "talk_end") {
        listening = false;
        console.log("[ptt] done, processing answer");
        // Give Deepgram a moment to flush final words, then take the turn.
        setTimeout(() => { finishAnswerAndReply("push_to_talk"); }, 600);
      } else if (evt.type === "playback_done") {
        // Browser finished playing the interviewer's audio — safe to listen again.
        currentUtterance = "";
        setTimeout(() => { speaking = false; }, 400); // small buffer for speaker tail
      }
    } catch {
      // ignore
    }
  });

  browser.on("close", () => {
    console.log("Browser disconnected.");
    clearInterval(keepAlive);
    try { if (ffmpeg) ffmpeg.kill("SIGKILL"); } catch {}
    try { dgLive.finish(); } catch {}
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n  grill is running.  Open  http://localhost:${PORT}\n`);
});
