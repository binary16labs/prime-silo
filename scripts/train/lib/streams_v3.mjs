// Data-plan v3 Stream A pair builders (docs/train/DATA-PLAN-v3.md, Lever 1).
// House voice comes ONLY from real house text — these builders select and frame,
// they never synthesize content. Template phrasing is picked deterministically
// per item (FNV-1a) so rebuilds are stable and the hash split holds.

const clip = (s, n) => {
  const t = String(s || "").trim();
  return t.length <= n ? t : t.slice(0, n - 1).trimEnd() + "…";
};
const firstLine = (s) =>
  String(s || "")
    .split(/\r?\n/)
    .find((l) => l.trim()) || "";

export function fnv(id) {
  let h = 0x811c9dc5;
  for (const ch of String(id)) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}
const pick = (id, templates) => templates[fnv(id) % templates.length];

// --- sessions_v1 JSON cards (intent/applications/capabilities/decisions) -------
export function jsonCardToPairs(card) {
  const intent = firstLine(card.intent);
  if (!intent) return [];
  const topic = clip(intent, 160);
  const parts = [`Intent: ${String(card.intent).trim()}`];
  if (card.project) parts.push(`Project: ${card.project}`);
  if (Array.isArray(card.applications) && card.applications.length)
    parts.push(`What we used: ${card.applications.slice(0, 10).join(", ")}`);
  if (Array.isArray(card.decisions) && card.decisions.length)
    parts.push(
      `Decisions:\n- ${card.decisions
        .slice(0, 8)
        .map((d) => clip(d, 300))
        .join("\n- ")}`
    );
  if (parts.length < 2) return []; // intent alone teaches nothing
  return [
    {
      stream: "A",
      id: `A-jsoncard-${card.sid}`,
      instruction: pick(card.sid, [
        `In the Prime-Silo estate, how did we approach this task and what was the method: "${topic}"?`,
        `Walk me through how this was handled in our estate, in our usual working style: "${topic}"`,
        `What was our approach and reasoning for: "${topic}"?`,
        `Describe the method and key decisions behind this piece of work: "${topic}"`
      ]),
      response: parts.join("\n\n"),
      source: { type: "jsoncard", id: card.sid, sid: card.sid }
    }
  ];
}

// --- delivery LOG entries (root-cause notes, honest deviations, verify discipline) ---
const LOG_MIN_NOTE = 220; // short mechanical moves (claims, promotes) carry no method
export function logToPairs(entry) {
  const note = String(entry.note || "").trim();
  if (note.length < LOG_MIN_NOTE) return [];
  const topic = clip(firstLine(note).replace(/[:.]$/, ""), 140);
  return [
    {
      stream: "A",
      id: `A-log-${entry.ts}-${entry.id}`,
      instruction: pick(entry.ts + entry.id, [
        `From the delivery log: what happened on task ${entry.id} (${entry.event}), and how did we reason about it? Context: "${topic}"`,
        `Write the delivery-log note for task ${entry.id} (${entry.event}) covering: "${topic}" — in our house logging style.`,
        `Explain, the way we log it on the board, how we handled this on ${entry.id}: "${topic}"`
      ]),
      response: note,
      source: { type: "log", id: `${entry.ts}-${entry.id}` }
    }
  ];
}

// --- work contracts: Goal/TDD -> "how we structure work"; gherkin -> "write the scenario" ---
import { splitSections } from "./corpus_v3.mjs";
export function contractToPairs(contract) {
  const sections = splitSections(contract.body);
  const title = (contract.body.match(/^#\s+(.+)$/m) || [])[1] || contract.id;
  const pairs = [];
  const goal = sections.Goal;
  const tdd = sections["TDD plan"];
  if (goal && firstLine(goal)) {
    const resp = [`Goal: ${clip(goal, 900)}`];
    if (tdd) resp.push(`TDD plan: ${clip(tdd, 700)}`);
    pairs.push({
      stream: "A",
      id: `A-contract-${contract.id}`,
      instruction: pick(contract.id, [
        `How do we scope and gate a delivery task like "${clip(title, 120)}"? State the goal and the TDD plan in our contract style.`,
        `Draft the Goal and TDD plan sections of the work contract "${clip(title, 120)}", the way we write them.`
      ]),
      response: resp.join("\n\n"),
      source: { type: "contract", id: contract.id }
    });
  }
  const gherkin = (contract.body.match(/```gherkin\r?\n([\s\S]*?)```/) || [])[1];
  if (gherkin && gherkin.trim()) {
    pairs.push({
      stream: "A",
      id: `A-contract-${contract.id}-bdd`,
      instruction: pick(contract.id + "bdd", [
        `Write the acceptance (BDD) scenarios for the task "${clip(title, 120)}" in our gherkin style.`,
        `Express the acceptance criteria of "${clip(title, 120)}" as gherkin scenarios, the way our contracts do.`
      ]),
      response: gherkin.trim(),
      source: { type: "contract", id: `${contract.id}-bdd` }
    });
  }
  return pairs;
}

// --- sectioned method docs / curated prose -> chunked pairs -----------------------
const CHUNK = 1600;
function chunk(text) {
  const out = [];
  let buf = "";
  for (const para of String(text).split(/\n\s*\n/)) {
    if (buf && buf.length + para.length + 2 > CHUNK) {
      out.push(buf.trim());
      buf = "";
    }
    buf += (buf ? "\n\n" : "") + para;
  }
  if (buf.trim()) out.push(buf.trim());
  // hard-split any paragraph that alone exceeds the budget
  return out.flatMap((c) =>
    c.length <= CHUNK ? [c] : c.match(new RegExp(`[\\s\\S]{1,${CHUNK}}`, "g")) || []
  );
}

function sectionedToPairs(item, type, templates) {
  const pairs = [];
  for (const [section, text] of Object.entries(item.sections || {})) {
    if (!text || text.trim().length < 200) continue;
    chunk(text).forEach((c, i) => {
      const suffix = i === 0 ? "" : `-${i + 1}`;
      pairs.push({
        stream: "A",
        id: `A-${type}-${item.id}-${section
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .slice(0, 40)}${suffix}`,
        instruction: pick(item.id + section + i, templates(item.title, section, i)),
        response: c,
        source: { type, id: `${item.id}#${section}${suffix}` }
      });
    });
  }
  return pairs;
}

export function docToPairs(doc) {
  return sectionedToPairs(doc, "doc", (title, section) => [
    `From our architecture docs — "${clip(title, 110)}", section "${clip(section, 80)}": explain it in our own words.`,
    `What does "${clip(title, 110)}" say under "${clip(section, 80)}"? Write it the way the doc does.`
  ]);
}

export function proseToPairs(item) {
  return sectionedToPairs(item, "prose", (title, section, i) => [
    `Write the "${clip(section, 80)}" narrative for ${clip(title, 110)} in our house long-form voice${i ? " (continued)" : ""}.`,
    `Continue the estate's account of ${clip(title, 110)} — ${clip(section, 80)}${i ? `, part ${i + 1}` : ""}.`
  ]);
}

// --- memo-ray Thought entities: the literal in-flight reasoning voice --------------
const THOUGHT_MIN = 120;
const DECISION_RE =
  /\b(will|should|need to|because|instead|so that|first|then|verify|check|before|rather than)\b/i;
export function thoughtToPairs(t) {
  const content = String(t.content || "").trim();
  if (content.length < THOUGHT_MIN || !DECISION_RE.test(content)) return [];
  const state = String(t.state || "").trim() || "Session context unavailable.";
  return [
    {
      stream: "A",
      id: `A-thought-${t.id}`,
      instruction: pick(t.id, [
        `You are working in the Prime-Silo estate. Given the state below, think through the next step out loud, the way we do.\n\nState:\n${clip(state, 400)}`,
        `Given this situation in the estate, reason about what to do next in our working style.\n\nState:\n${clip(state, 400)}`
      ]),
      response: clip(content, 1600),
      source: { type: "thought", id: t.id, sid: t.sid }
    }
  ];
}
