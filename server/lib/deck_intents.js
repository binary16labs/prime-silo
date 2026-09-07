// What the deck understood — a pure function, so it can be tested without a microphone.
//
// Deliberately small and literal. A voice interface in a room needs to be predictable far more
// than it needs to be clever: an operator who cannot guess what a phrase will do stops using
// it, and a router that guesses wrong on a consequential verb is worse than no router.
//
// THERE IS NO SIGNING INTENT, and there is no branch that could grow into one. Asking to sign
// is recognised only so the deck can explain why it will not — a spoken instruction is not an
// authenticated act, and the whole governance model depends on that distinction holding in the
// one place it is most tempting to break.
const SURFACES = {
  gov: "_prime_silo/gov",
  lineage: "_prime_silo/lineage",
  deck: "_prime_silo/deck",
  mission: "_prime_silo/mission_control",
  memory: "_prime_silo/memory",
  files: "file_explorer",
  agent: "agent"
};

const has = (t, ...words) => words.some((w) => t.includes(w));

export function intentOf(text) {
  const t = String(text || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!t) return { kind: "none", say: "I did not catch that." };

  // Recognised in order to refuse it, and to say why rather than just failing.
  if (has(t, "sign", "approve", "authorise", "authorize")) {
    return {
      kind: "refused",
      navigate: SURFACES.gov,
      say: "I have opened the signing queue, but I will not sign. A signature has to be a deliberate act at the keyboard, from an authenticated session — a spoken instruction is not one, and anyone in the room could give it."
    };
  }

  if (has(t, "waiting", "queue", "decide", "to sign", "outstanding")) {
    return { kind: "query", navigate: SURFACES.gov, say: "Showing what is waiting on you." };
  }
  if (has(t, "lineage", "provenance", "where did", "came from", "origin", "trail")) {
    return { kind: "navigate", navigate: SURFACES.lineage, say: "Opening lineage." };
  }
  if (has(t, "health", "nodes", "machines", "estate board", "outage", "up")) {
    return { kind: "navigate", navigate: SURFACES.mission, say: "Opening mission control." };
  }
  if (has(t, "memory", "session", "recall", "last week")) {
    return { kind: "navigate", navigate: SURFACES.memory, say: "Opening memory." };
  }
  if (has(t, "file", "download", "installer", "artifact")) {
    return { kind: "navigate", navigate: SURFACES.files, say: "Opening files." };
  }

  // Raising is the one write voice may perform: it asks for a decision and takes none.
  if (has(t, "raise", "propose", "proposal for", "we should")) {
    return {
      kind: "raise",
      navigate: SURFACES.gov,
      say: "I can raise that as a proposal for you to decide on. Say it again starting with 'raise a proposal to', and I will put it in the queue with your words as the rationale."
    };
  }

  if (has(t, "deck", "home", "dashboard", "board")) {
    return { kind: "navigate", navigate: SURFACES.deck, say: "Back to the deck." };
  }

  return {
    kind: "unknown",
    say: `I heard "${text}", but I do not have an action for it. Try: what is waiting, show lineage, estate health, or raise a proposal.`
  };
}

export const VOICE_SURFACES = SURFACES;
