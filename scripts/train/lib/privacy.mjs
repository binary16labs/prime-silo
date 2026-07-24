// T2 privacy layer. The operator does job-application / CV work in the same
// session estate as product work; that personal context must NEVER enter training
// rows (operator privacy constraint; memory longview_memory_teleport). This module:
//   - loads GENERIC personal-context terms (scripts/train/dataset/personal_terms.json)
//     plus any quarantined session ids from <PRIME_SILO_HOME>/longview/quarantine.json
//   - isPersonal(text): build-time filter (mirrors leak_gate's matching rule exactly)
//   - re-exports scanForLeaks (leak_gate) so the gate scans emitted rows authoritatively
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanForLeaks } from "../../longview/lib/leak_gate.mjs";

export { scanForLeaks };

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TERMS_FILE = path.join(HERE, "..", "dataset", "personal_terms.json");

// Same rule as leak_gate.compileNeedles: <4-char terms get word boundaries (so "cv"
// doesn't fire inside "canvas"), 4+ chars match as substrings, sids are substrings.
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
function compileNeedles(terms = [], sids = []) {
  const needles = [];
  for (const t of terms) {
    const term = String(t).trim();
    if (!term) continue;
    needles.push(term.length < 4 ? new RegExp(`\\b${escapeRe(term)}\\b`, "i") : new RegExp(escapeRe(term), "i"));
  }
  for (const s of sids) {
    const sid = String(s).trim();
    if (sid) needles.push(new RegExp(escapeRe(sid), "i"));
  }
  return needles;
}

export function loadTerms({ home = process.env.PRIME_SILO_HOME } = {}) {
  const spec = JSON.parse(fs.readFileSync(TERMS_FILE, "utf8").replace(/^﻿/, ""));
  const terms = [...(spec.terms || [])];
  const sids = [...(spec.sids || [])];
  // Augment with real quarantined sids from the home (never committed to the repo).
  if (home) {
    try {
      const q = JSON.parse(fs.readFileSync(path.join(home, "longview", "quarantine.json"), "utf8"));
      for (const s of q.sids || q.quarantined || []) if (s) sids.push(String(s));
    } catch {
      /* no quarantine file — generic terms still apply */
    }
  }
  // Sessions workspace quarantine (e.g. sessions_v1) — merged HERE so the builder and
  // the gate's authoritative scan see the identical sid list.
  const sessionsWs = (process.env.T2_SESSIONS_WS || "").trim() ||
    "D:\\benny-home\\benny\\workspaces\\sessions_v1";
  try {
    const q = JSON.parse(fs.readFileSync(path.join(sessionsWs, "longview", "quarantine.json"), "utf8"));
    for (const s of q.sids || q.quarantined || []) if (s && !sids.includes(String(s))) sids.push(String(s));
  } catch {
    /* workspace absent (e.g. D: unplugged) — structural card filter still applies */
  }
  return { terms, sids };
}

// Compile once, reuse across the whole build.
export function makeDetector(spec) {
  const needles = compileNeedles(spec.terms, spec.sids);
  return (text) => {
    const s = String(text || "");
    return needles.some((re) => re.test(s));
  };
}
