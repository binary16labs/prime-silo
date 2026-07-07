#!/usr/bin/env node
// Gate Q0 — security remediation: vulnerable deps gone, mesh credential burned
// with fail-fast resolution, loopback bind by default, ADR-003 residual pinned.
//
// Hermetic except scenario 1 (`npm audit` needs the registry). No live services.
// Reports `[q0] GATE GREEN | GATE FAILED`; exit 0 = pass.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BURNED = ["benny-mesh-2026", "auth"].join("-"); // split so this file can drop off the allowlist someday
const failures = [];

function check(name, ok, detail = "") {
  console.log(`[q0] ${ok ? "PASS" : "FAIL"} — ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures.push(name);
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, {
    cwd: ROOT,
    shell: process.platform === "win32",
    encoding: "utf8",
    ...opts,
  });
}

// ── Scenario 1: dependency audit is clean ─────────────────────────────────────
{
  const p = run("npm", ["audit", "--audit-level=moderate"]);
  check("scenario 1: npm audit --audit-level=moderate exits 0", p.status === 0,
    p.status === 0 ? "" : (p.stdout || p.stderr || "").trim().split("\n").slice(-4).join(" | "));
}

// ── Scenario 2a: burned credential is gone (tracked files, minus historical) ──
{
  const allowlist = fs
    .readFileSync(path.join(ROOT, "scripts", "gates", "q0-historical-allowlist.txt"), "utf8")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
  const allowed = (file) =>
    allowlist.some((entry) =>
      entry.endsWith("/") ? file.startsWith(entry) : file === entry,
    );
  const p = run("git", ["grep", "-l", BURNED, "--", "."]);
  // git grep exits 1 on zero matches — that is success for us.
  const hits = (p.stdout || "")
    .split(/\r?\n/)
    .map((l) => l.trim().replaceAll("\\", "/"))
    .filter(Boolean)
    .filter((f) => !allowed(f));
  check("scenario 2a: burned credential absent outside historical allowlist", hits.length === 0,
    hits.length ? `still in: ${hits.join(", ")}` : "");
}

// ── Scenario 2b: absence of a key fails fast, naming BENNY_API_KEY + keystore ─
{
  // Node consumers: the proxy's resolver must throw an actionable error when
  // neither BENNY_API_KEY nor a per-install keystore is reachable.
  const probe = `
    const mod = await import(${JSON.stringify(
      "file://" + path.join(ROOT, "server", "lib", "runtime_proxy.js").replaceAll("\\", "/"),
    )});
    try {
      mod.resolveBennyApiKey({ env: {} });
      console.log("NO-THROW");
    } catch (err) {
      console.log("THREW:" + err.message);
    }
  `;
  const p = run(process.execPath, ["--input-type=module", "-e", probe], { shell: false });
  const out = (p.stdout || "") + (p.stderr || "");
  const threw = out.includes("THREW:");
  const actionable = out.includes("BENNY_API_KEY") && /state[\\/]hmac-key/.test(out);
  check("scenario 2b (node): missing key fails fast naming BENNY_API_KEY + keystore path",
    threw && actionable, out.trim().split("\n")[0] || "no output");
}
{
  // Python consumers: pytest scenario tests (named after the contract scenarios).
  const p = run("python", ["-m", "pytest", "tests/api/test_q0_key_resolution.py", "-q"], {
    cwd: path.join(ROOT, "runtime"),
  });
  check("scenario 2b (python): key-resolution fail-fast pytest green", p.status === 0,
    p.status === 0 ? "" : (p.stdout || "").trim().split("\n").slice(-3).join(" | "));
}

// ── Scenario 3: local development still boots (documented resolution path) ────
{
  const envExample = path.join(ROOT, ".env.example");
  const text = fs.existsSync(envExample) ? fs.readFileSync(envExample, "utf8") : "";
  check("scenario 3: .env.example documents BENNY_API_KEY and HOST",
    text.includes("BENNY_API_KEY") && text.includes("HOST"));
  const probe = `
    const mod = await import(${JSON.stringify(
      "file://" + path.join(ROOT, "server", "lib", "runtime_proxy.js").replaceAll("\\", "/"),
    )});
    const key = mod.resolveBennyApiKey({ env: { BENNY_API_KEY: "q0-fixture-key" } });
    console.log(key === "q0-fixture-key" ? "ENV-OK" : "ENV-BAD:" + key);
  `;
  const p = run(process.execPath, ["--input-type=module", "-e", probe], { shell: false });
  check("scenario 3: env BENNY_API_KEY is honoured first", (p.stdout || "").includes("ENV-OK"));
}

// ── Scenario 4: server is loopback by default ─────────────────────────────────
{
  const p = run(process.execPath, ["tests/server_bind_default_test.mjs"], { shell: false });
  check("scenario 4: bind-default unit test green (127.0.0.1 default, opt-in warning)",
    p.status === 0, p.status === 0 ? "" : (p.stdout || p.stderr || "").trim().split("\n").slice(-3).join(" | "));
}

// ── Scenario 5: ADR-003 residual follow-up test ───────────────────────────────
{
  const p = run(process.execPath, ["tests/adr003_same_origin_followup_test.mjs"], { shell: false });
  check("scenario 5: ADR-003 same-origin follow-up test green", p.status === 0,
    p.status === 0 ? "" : (p.stdout || p.stderr || "").trim().split("\n").slice(-3).join(" | "));
}

console.log(failures.length === 0 ? "[q0] GATE GREEN" : `[q0] GATE FAILED — ${failures.length} failing: ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
