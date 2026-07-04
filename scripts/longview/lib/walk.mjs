// Deterministic graph walk of a session timeline (ADR-005, graph-walk extraction).
//
// The map phase used to flatten a whole session into one ≤7500-char evidence pack
// and ask the 9B model for a 12-field card in a single call. qwen3.5-9b self-limits
// output to ~415 tokens regardless of budget, so large sessions truncated (fields
// dropped, card rejected). Instead we walk EVERY step of the session's timeline in
// deterministic order and cut it into short windows; the map phase extracts a tiny
// fragment per window and assembles the card losslessly in code.
//
// Guarantees (verified by the walk unit test):
//   • every timeline step is covered by at least one window (no step skipped —
//     sessions can exceed 1000 steps),
//   • window order is deterministic (readTimeline is a BFS + timestamp sort),
//   • each window's text is ≤ inputChars (a single over-long step is split into
//     contiguous chunks rather than dropped or overflowing the model's context).
import { readTimeline } from "./store.mjs";

const DEFAULT_INPUT_CHARS = 7000;

// Render one timeline entity as a compact, labelled line. Always non-empty (the
// label alone guarantees the step is represented even when its content is blank),
// so coverage is total.
function renderStep(e) {
  const label = e.type || "Step";
  const meta = e.metadata || {};
  const tag = meta.toolName
    ? ` ${meta.toolName}`
    : meta.fileName
      ? ` ${meta.fileName}`
      : meta.model && meta.model !== "user"
        ? ` ${meta.model}`
        : "";
  const body = (e.content || "").replace(/\s+/g, " ").trim();
  return `[${label}${tag}]${body ? " " + body : ""}`;
}

export function walkSessionWindows(session, { inputChars = DEFAULT_INPUT_CHARS } = {}) {
  const timeline = readTimeline(session.id);
  // Drop the root Session node (it carries only the title); keep every step.
  const steps = timeline.filter((e) => e.id !== session.id);

  const windows = [];
  let text = "";
  let stepIdxs = [];

  const push = () => {
    if (!text) return;
    windows.push({ index: windows.length, steps: stepIdxs.slice(), text });
    text = "";
    stepIdxs = [];
  };

  for (let i = 0; i < steps.length; i++) {
    let piece = renderStep(steps[i]);
    // Emit the piece, splitting a single over-long step across contiguous windows.
    while (piece.length) {
      const room = inputChars - text.length - (text ? 1 : 0);
      // If almost no room is left in the current window, seal it and start fresh.
      if (room <= 0 || (room < 400 && room < piece.length && text.length > 0)) {
        push();
        continue;
      }
      const take = piece.slice(0, room);
      text += (text ? "\n" : "") + take;
      if (!stepIdxs.includes(i)) stepIdxs.push(i);
      piece = piece.slice(take.length);
      if (piece.length) push(); // remainder overflows → continue in a new window
    }
  }
  push();

  return { windows, stepCount: steps.length };
}
