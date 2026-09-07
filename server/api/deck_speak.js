// POST /api/deck_speak — the deck's mouth. Text in, spoken audio out.
//
// The browser never talks to Voicebox directly. Three reasons, in order of how much they cost
// when ignored: the deck is served from the app origin and :17493 is a different one, so a
// direct call is a CORS negotiation on every utterance; Voicebox's contract is a three-step
// dance (generate, poll, fetch audio) that has no business being duplicated in a view; and the
// profile/engine pairing below is a rule about Voicebox, not about decks.
//
// THE ENGINE IS NOT A DETAIL. A preset profile refuses any engine but its own, and the request
// schema defaults to "qwen" — so omitting the engine sends a kokoro profile a qwen job and gets
// a 400. Worse, a *cloned* profile really does run on qwen, at roughly ten times real time on
// this CPU: a spoken sentence would arrive a minute after the question. A deck that answers a
// minute late is not a slow deck, it is a wrong one, so preset profiles are preferred and their
// declared engine is always sent explicitly.
//
// SILENCE IS AN ANSWER, NOT A HANG. The first kokoro utterance downloads a model. This endpoint
// spends a fixed budget and then returns "not yet", because the deck already has the reply in
// text and a person waiting on a wall would rather read it than watch a button think.
const VOICEBOX = process.env.VOICEBOX_BASE_URL || "http://127.0.0.1:17493";
const BUDGET_MS = Number(process.env.DECK_SPEAK_BUDGET_MS || 20000);
const MAX_CHARS = 600;

async function vb(path, init = {}, ms = 8000) {
  return fetch(`${VOICEBOX}${path}`, { ...init, signal: AbortSignal.timeout(ms) });
}

// Chosen per request, never cached: profiles are edited in Voicebox's own UI, and a deck that
// keeps speaking in a voice the operator retired is a small lie that is hard to trace.
async function chooseProfile() {
  if (process.env.VOICEBOX_PROFILE_ID) {
    const r = await vb(`/profiles/${process.env.VOICEBOX_PROFILE_ID}`);
    if (!r.ok) throw new Error(`VOICEBOX_PROFILE_ID is set but Voicebox does not have it`);
    return await r.json();
  }
  const r = await vb("/profiles");
  if (!r.ok) throw new Error(`Voicebox listed no profiles (HTTP ${r.status})`);
  const list = await r.json();
  const ids = (Array.isArray(list) ? list : list.profiles || []).map((p) => p.id);
  const full = await Promise.all(
    ids.map((id) =>
      vb(`/profiles/${id}`)
        .then((x) => (x.ok ? x.json() : null))
        .catch(() => null)
    )
  );
  const usable = full.filter(Boolean);
  const preset = usable.find((p) => p.voice_type === "preset" && p.preset_engine);
  if (preset) return preset;
  if (!usable.length) throw new Error("Voicebox has no voice profiles configured");
  // A cloned voice is slow but real. Say so; do not pretend the estate has no voice at all.
  return usable[0];
}

export async function post(context) {
  const text = String(context?.body?.text ?? "")
    .trim()
    .slice(0, MAX_CHARS);
  if (!text) return { status: 400, body: { ok: false, error: "no text to speak" } };

  const started = Date.now();
  let profile;
  try {
    profile = await chooseProfile();
  } catch (e) {
    return { status: 200, body: { ok: false, spoken: false, reason: e.message } };
  }

  const engine = profile.preset_engine || profile.default_engine || undefined;
  let gen;
  try {
    const r = await vb(
      "/generate",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ profile_id: profile.id, text, ...(engine ? { engine } : {}) })
      },
      15000
    );
    gen = await r.json().catch(() => null);
    if (!r.ok) throw new Error(gen?.detail || `HTTP ${r.status}`);
  } catch (e) {
    return {
      status: 200,
      body: { ok: false, spoken: false, reason: `Voicebox refused the job: ${e.message}` }
    };
  }

  // Poll the record rather than the status stream: this is one short utterance, and a plain
  // JSON read cannot leave a half-parsed event behind when the budget runs out.
  let state = gen;
  while (Date.now() - started < BUDGET_MS) {
    if (state?.status === "completed") break;
    if (state?.status === "failed") {
      return {
        status: 200,
        body: { ok: false, spoken: false, reason: state.error || "generation failed" }
      };
    }
    await new Promise((r) => setTimeout(r, 600));
    try {
      const r = await vb(`/history/${gen.id}`);
      state = r.ok ? await r.json() : state;
    } catch {
      // A dropped poll is not a failed generation; keep spending the budget.
    }
  }

  if (state?.status !== "completed") {
    return {
      status: 200,
      body: {
        ok: false,
        spoken: false,
        pending: true,
        generation_id: gen.id,
        state: state?.status ?? "unknown",
        // Named precisely, because "loading_model" on a first run means a download of a few
        // hundred megabytes and the operator should know to expect voice later, not never.
        reason:
          state?.status === "loading_model" || state?.status === "generating"
            ? `the voice is still warming up (${state.status}) — this reply stays in text`
            : `no audio within ${Math.round(BUDGET_MS / 1000)}s — this reply stays in text`
      }
    };
  }

  try {
    const a = await vb(`/audio/${gen.id}`, {}, 20000);
    if (!a.ok) throw new Error(`HTTP ${a.status}`);
    const buf = Buffer.from(await a.arrayBuffer());
    return {
      headers: {
        "Cache-Control": "no-store",
        "Content-Type": a.headers.get("content-type") || "audio/wav",
        "X-Deck-Voice": `${profile.name}/${engine || "default"}`
      },
      status: 200,
      body: buf
    };
  } catch (e) {
    return {
      status: 200,
      body: {
        ok: false,
        spoken: false,
        reason: `audio was generated but not readable: ${e.message}`
      }
    };
  }
}
