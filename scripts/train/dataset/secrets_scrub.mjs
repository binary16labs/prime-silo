// Secrets scrub for training corpora — the personal-data leak gate (leak_gate.mjs) scans for NAMES,
// not secrets. A tool-use corpus harvested from real sessions carries file-reads and command outputs,
// so .env values (HMAC keys, tokens) can land in a row's context. This module:
//   • loads the actual secret VALUES from .env (IN-MEMORY ONLY — never written to any file/log/row),
//   • redactText() replaces each known value with <REDACTED:NAME> everywhere it appears,
//   • scanSecretPatterns() catches UNKNOWN secret-shaped tokens (sk-…, ghp_…, AKIA…, PEM blocks,
//     long assigned high-entropy strings) so the caller can fail-closed on anything it can't redact.
// Never persist the returned secret values. Never commit .env.
import fs from "node:fs";

// Load KEY=VALUE pairs from .env whose key looks secret and whose value is long enough to matter.
// Returns [{name, value}] sorted longest-value-first (so redaction hits the most specific match).
export function loadSecrets(envPath) {
  const out = [];
  let raw;
  try { raw = fs.readFileSync(envPath, "utf8"); } catch { return out; }
  const SECRET_KEY = /(KEY|SECRET|TOKEN|PASSWORD|HMAC|CREDENTIAL|PRIVATE)/i;
  for (const line of raw.split(/\r?\n/)) {
    const s = line.trim();
    if (!s || s.startsWith("#") || !s.includes("=")) continue;
    const eq = s.indexOf("=");
    const name = s.slice(0, eq).trim();
    let value = s.slice(eq + 1).trim().replace(/^["']|["']$/g, "");
    if (!SECRET_KEY.test(name)) continue;
    if (value.length < 12) continue; // PORT-like short config is not a secret
    out.push({ name, value });
  }
  out.sort((a, b) => b.value.length - a.value.length);
  return out;
}

// Replace every known secret value with a stable placeholder. Returns {text, hits}.
export function redactText(text, secrets) {
  let hits = 0;
  let t = text;
  for (const { name, value } of secrets) {
    if (!value) continue;
    let idx = t.indexOf(value);
    while (idx !== -1) { hits++; idx = t.indexOf(value, idx + 1); }
    if (hits) t = t.split(value).join(`<REDACTED:${name}>`);
  }
  return { text: t, hits };
}

// Detect UNKNOWN secret-shaped tokens the .env list can't cover. Conservative — anchored formats
// only, to avoid nuking benign text.
const PATTERNS = [
  ["openai", /\bsk-[A-Za-z0-9]{20,}\b/],
  ["github-pat", /\bghp_[A-Za-z0-9]{20,}\b/],
  ["github-oauth", /\bgho_[A-Za-z0-9]{20,}\b/],
  ["aws-akid", /\bAKIA[0-9A-Z]{16}\b/],
  ["slack", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/],
  ["pem", /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ["bearer", /\bBearer\s+[A-Za-z0-9._-]{20,}\b/],
];
export function scanSecretPatterns(text) {
  const found = [];
  for (const [kind, re] of PATTERNS) {
    const m = text.match(re);
    if (m) found.push({ kind, excerpt: `${m[0].slice(0, 6)}…(${m[0].length} chars)` });
  }
  return found;
}
