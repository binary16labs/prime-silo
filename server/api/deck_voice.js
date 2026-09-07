// /api/deck_voice — the deck's ear and mouth.
//
// GET  reports what is actually reachable right now.
// POST takes recorded audio, transcribes it, decides what was meant, and answers.
//
// THE ROUTER HAS NO PATH TO A SIGNATURE. Not "it refuses to sign" — there is no branch that
// could. The estate's entire model rests on a signature being a deliberate act by an
// authenticated person, and this endpoint runs in a room where anyone can speak and a
// television can too. Voice may navigate, ask, and raise a proposal (frontier authorship,
// which asks for a decision and takes none). Signing stays at a keyboard.
//
// CAPABILITY IS PROBED, NEVER ASSUMED. The deck disables its microphone when there is nothing
// to hear it, and says why. A talk button that does nothing teaches an operator to distrust
// the whole surface, which costs more than the feature is worth.
import { intentOf } from "../lib/deck_intents.js";

const VOICEBOX = process.env.VOICEBOX_BASE_URL || "http://127.0.0.1:17493";
const BENNY = process.env.RUNTIME_BASE_URL || "http://127.0.0.1:8005";

async function reachable(url, ms = 2500) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(ms) });
    return r.ok;
  } catch {
    return false;
  }
}

export async function get() {
  const [speak, hear] = await Promise.all([
    reachable(`${VOICEBOX}/docs`),
    reachable(`${BENNY}/docs`)
  ]);
  const note = speak
    ? hear
      ? "Voicebox is speaking; Benny is listening."
      : "Voicebox can speak, but nothing can transcribe — start Benny to use the microphone."
    : hear
      ? "Benny can listen, but Voicebox is not running — replies will be text only."
      : "No voice service is reachable. Start Voicebox (:17493) and Benny (:8005).";

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: { speak, hear, voicebox: VOICEBOX, runtime: BENNY, note }
  };
}

export async function post(context) {
  const audio = context?.files?.audio ?? context?.body?.audio;
  if (!audio) return { status: 400, body: { ok: false, error: "no audio was sent" } };

  // 1. Hear.
  let heard = "";
  try {
    const fd = new FormData();
    fd.append(
      "file",
      new Blob([audio.data ?? audio], { type: audio.mimetype ?? "audio/webm" }),
      "speech.webm"
    );
    fd.append("workspace", "prime_silo_self");
    const res = await fetch(`${BENNY}/api/audio/transcribe`, {
      method: "POST",
      body: fd,
      signal: AbortSignal.timeout(120000)
    });
    const j = await res.json().catch(() => null);
    if (!res.ok) throw new Error(j?.detail || `HTTP ${res.status}`);
    heard = String(j?.text || j?.transcript || "").trim();
  } catch (e) {
    return {
      status: 200,
      body: { ok: false, heard: "", said: `I could not transcribe that: ${e.message}` }
    };
  }

  // 2. Decide what it meant. Pure and testable, and — see the header — signature-free.
  const intent = intentOf(heard);

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      ok: true,
      heard,
      intent: intent.kind,
      navigate: intent.navigate ?? null,
      said: intent.say,
      // The deck speaks this through Voicebox when it is up; when it is not, the text stands
      // on its own rather than the interaction silently doing nothing.
      speak_url: `${VOICEBOX}/generate`
    }
  };
}
