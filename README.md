# grill

**The interviewer that doesn't believe you yet.**

A voice-based AI mock interviewer. Deepgram for transcription, ElevenLabs for the
voice, Gemma 4 on Cerebras for the brain — fast enough to critique or question you
mid-answer instead of the awkward turn-based lag every other tool has.

The wedge: **latency + a skeptical system prompt.** It interrupts and pushes back on
weak answers like a real interviewer, instead of waiting politely and lobbing
softballs.

---

## Setup (about 5 minutes)

You need three API keys: Cerebras, Deepgram, ElevenLabs.

1. **Install Node** (v18+). Check with `node -v`.

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Add your keys.** Copy the template and paste your real keys in:
   ```bash
   cp .env.example .env
   ```
   Then open `.env` and fill in:
   - `CEREBRAS_API_KEY` — the one you already got working
   - `DEEPGRAM_API_KEY` — from console.deepgram.com
   - `ELEVENLABS_API_KEY` — from elevenlabs.io (Profile → API key)
   - `ELEVENLABS_VOICE_ID` — optional; leave blank for the default voice

4. **Run it:**
   ```bash
   npm start
   ```
   Open **http://localhost:3000** in **Chrome**, click *Start interview*, allow the
   mic, and start talking.

---

## How it works (the loop)

```
your voice → Deepgram (ears) → Gemma 4 on Cerebras (brain) → ElevenLabs (voice) → you hear it
```

Cerebras makes the brain step near-instant — that's the speed the sidebar shows off
live (brain ms / voice ms / total). That number IS the pitch: a real interviewer's
follow-up lands fast enough to feel like pressure.

## De-risking: what's built vs. what's next

- **Built and working now:** the full turn-based voice loop. You talk, it listens,
  it pushes back, it speaks — fast. This alone beats the polite, laggy competitors
  on feel. **This is your safe, always-demoable version.**
- **The showstopper (layered on top):** true mid-answer interruption. The hooks are
  marked in the code — search `INTERRUPTION HOOK` in `server.js` and `public/index.html`.
  Deepgram interim results already stream the candidate's words in real time; to barge
  in, stream partials to the brain, let it decide to cut in, signal the browser to
  pause playback, and speak immediately. Attempt this ONLY once the loop above is
  solid, so you always have something to show.

## Demo-day game plan (60 seconds)

1. Open on the pain: "every AI interviewer waits politely and feeds you softballs."
2. Give a deliberately vague answer ("I led a project that drove a lot of impact…").
3. Let grill cut back instantly: "What did *you* specifically do? What was the number?"
4. Cut to the sidebar speed readout — show the sub-second response.
5. Side-by-side with a slow GPU-hosted version if time allows: theirs pauses, yours
   doesn't. The dead air is the villain; your speed is the hero.

## Tuning the interviewer

The whole personality lives in `SYSTEM_PROMPT` in `server.js`. Make it meaner,
nicer, or domain-specific (swap in "technical coding interview" or "PhD defense")
right there. That's also how you tell the breadth story: same engine, different prompt.
