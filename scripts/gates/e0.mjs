#!/usr/bin/env node
// Gate E0 — website design brief + claims registry (words locked before code).
//
// Two things must be true for E0 to be DONE:
//   (a) website/DESIGN-BRIEF.md exists AND carries the OWNER's approval line (human-signed — the
//       brief locks the copy, and only the owner signs it off). Until the owner replaces the PENDING
//       placeholder with a real sign-off, this stays RED by design.
//   (b) website/claims.json is a schema-valid truth registry, and the claims checker is ARMED —
//       proven by a self-test (a synthetic unregistered numeric claim is flagged; a registered one
//       passes). The armed checker STAYS armed for E2, which cleans the live site.
//
// A separate `--scan` mode runs the checker against the CURRENT public site and exits non-zero,
// listing every unregistered numeric claim (gherkin scenario 1 — it fails today, as designed, until
// E2 registers the verified claims and REMOVES the invalidated token-economics numbers).
//
// Hermetic: reads repo files only. Contract: delivery/tasks/E0.md
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

// --- the claims checker (exported shape; used by the gate self-test and --scan) --------------------
// A "numeric/comparative claim" in visible prose: a percentage or an Nx multiplier. HTML tags and
// style attributes (e.g. width:80%) are stripped first, so CSS bar widths are NOT treated as claims.
export function stripToText(s) {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/style="[^"]*"/gi, " ") // drop inline style attrs (width:80% etc.)
    .replace(/<[^>]+>/g, " "); // drop tags
}
export function extractClaims(text) {
  const out = [];
  const re = /(?<![\w.])(\d+(?:\.\d+)?\s*(?:%|x\b))/gi;
  let m;
  while ((m = re.exec(text)) !== null) out.push(m[1].replace(/\s+/g, ""));
  return out;
}
export function registeredValues(registry) {
  const set = new Set();
  for (const c of registry.claims || []) if (c && c.claim) set.add(String(c.claim).replace(/\s+/g, ""));
  return set;
}
// Returns the unregistered numeric claims found in the given files' visible text.
export function scanUnregistered(files, registry) {
  const reg = registeredValues(registry);
  const violations = [];
  for (const rel of files) {
    if (!exists(rel)) continue;
    const claims = extractClaims(stripToText(read(rel)));
    for (const c of claims) if (!reg.has(c)) violations.push({ file: rel, claim: c });
  }
  return violations;
}

// The public surface E2 must keep honest.
const PUBLIC_FILES = ["website/index.html", "website/concept.md"];
const APPROVAL_RE = /^Owner-Approved:\s*(?!PENDING\b|pending\b|\s*$)(\S.*)$/m;

function loadRegistry() {
  if (!exists("website/claims.json")) return null;
  try {
    return JSON.parse(read("website/claims.json"));
  } catch {
    return undefined; // malformed
  }
}

function runScan() {
  const registry = loadRegistry() || { claims: [] };
  const violations = scanUnregistered(PUBLIC_FILES, registry);
  if (violations.length === 0) {
    console.log("[e0:scan] no unregistered numeric claims in the public site — clean.");
    process.exit(0);
  }
  console.error(`[e0:scan] ${violations.length} UNREGISTERED numeric claim(s) — every public claim must be in claims.json (claim/source/verified_date):`);
  for (const v of violations) console.error(`  - ${v.claim}  (${v.file})`);
  process.exit(1);
}

function runGate() {
  const fails = [];
  const check = (cond, msg) => { if (!cond) fails.push(msg); };

  // (a) brief exists + owner-approved.
  check(exists("website/DESIGN-BRIEF.md"), "website/DESIGN-BRIEF.md is missing");
  if (exists("website/DESIGN-BRIEF.md")) {
    const brief = read("website/DESIGN-BRIEF.md");
    check(APPROVAL_RE.test(brief),
      "DESIGN-BRIEF.md has no OWNER approval line — add `Owner-Approved: <your sign-off>` (replace PENDING). Human-signed: awaiting owner.");
    check(/A local-first AI workbench\. Your documents, your models, your machine\./.test(brief),
      "the brief must lock the hero copy verbatim");
    check(/wireframe|page structure|section order/i.test(brief), "the brief must contain the page structure / wireframe order");
    check(/constraint/i.test(brief), "the brief must contain checkable design constraints");
  }

  // (b) claims registry schema-valid.
  const registry = loadRegistry();
  check(registry !== null, "website/claims.json is missing");
  check(registry !== undefined, "website/claims.json is not valid JSON");
  if (registry && typeof registry === "object") {
    check(Array.isArray(registry.claims), "claims.json must have a `claims` array");
    for (const c of registry.claims || []) {
      check(c && c.claim && c.source && c.verified_date,
        `every registered claim needs claim/source/verified_date (offending: ${JSON.stringify(c).slice(0, 60)})`);
    }
  }

  // (b) the checker is ARMED — synthetic self-test, decoupled from the live-site state.
  const armedFinds = extractClaims(stripToText('<p>up <b>42%</b> and <span style="width:80%">3x</span> faster</p>'));
  check(armedFinds.includes("42%") && armedFinds.includes("3x"), "checker fails to extract prose numeric claims");
  check(!armedFinds.includes("80%"), "checker wrongly treats a CSS width as a claim");
  const flagged = scanUnregisteredText("<p>growth of 42%</p>", { claims: [] });
  const passed = scanUnregisteredText("<p>growth of 42%</p>", { claims: [{ claim: "42%", source: "test", verified_date: "2026-07-25" }] });
  check(flagged.length === 1, "checker does not flag an unregistered claim");
  check(passed.length === 0, "checker does not clear a registered claim");

  if (fails.length) {
    console.error("[e0] GATE FAILED:");
    for (const f of fails) console.error("  - " + f);
    process.exit(1);
  }
  console.log("[e0] brief locked + owner-approved; claims.json schema-valid; claims checker armed (stays armed for E2)");
  console.log("[e0] GATE GREEN");
  process.exit(0);
}

// helper for the self-test (scan arbitrary text, not a file)
function scanUnregisteredText(text, registry) {
  const reg = registeredValues(registry);
  return extractClaims(stripToText(text)).filter((c) => !reg.has(c)).map((claim) => ({ claim }));
}

if (process.argv.includes("--scan")) runScan();
else runGate();
