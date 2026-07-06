#!/usr/bin/env node
//
// ADR-003 same-origin follow-up test (Q0, scenario 5).
//
// The full same-origin closure (agent JS isolated in a worker/iframe) remains
// the ADR-001 follow-up. This suite pins every isolation invariant that IS
// server-side enforceable, so none of them can silently regress:
//   a. human and agent keys derived from the same keystore always differ
//   b. cross-language derivation parity (Node here == Python in
//      runtime/tests/api/test_q0_key_resolution.py — same fixture, same digest)
//   c. the human facade strips a client-sent X-Benny-Agent-Scope header
//   d. the agent facade forces sandbox scope even when the caller asserts more
//   e. encoded dot-segments cannot escape a facade prefix (400, never proxied)
//   f. no dev-fallback key constants are exported anymore
//
// Hermetic: fake in-process upstream, tmp keystore, no live services.

import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

process.env.BENNY_API_KEY = "q0-test-fixture-human-key";
process.env.BENNY_AGENT_API_KEY = "q0-test-fixture-agent-key";

const proxyModule = await import("../server/lib/runtime_proxy.js");
const {
  hasPathTraversal,
  proxyToAgentRuntime,
  proxyToRuntime,
  resolveBennyAgentApiKey,
  resolveBennyApiKey
} = proxyModule;

// ── a. key separation from a shared keystore ─────────────────────────────────
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "q0-adr003-"));
  fs.mkdirSync(path.join(tmp, "state"), { recursive: true });
  fs.writeFileSync(path.join(tmp, "state", "hmac-key"), "ab".repeat(32), "utf8");
  const env = { BENNY_HOME: tmp };
  const humanKey = resolveBennyApiKey({ env });
  const agentKey = resolveBennyAgentApiKey({ env });
  assert.notEqual(humanKey, agentKey, "human and agent keys must never collapse into one");

  // ── b. cross-language derivation parity (pinned digest, see pytest twin) ──
  const expected = crypto
    .createHmac("sha256", Buffer.from("ab".repeat(32), "hex"))
    .update("benny-agent-scope")
    .digest("hex");
  assert.equal(agentKey, expected);
  assert.equal(
    agentKey,
    "eb8eaf640b7c05686f1da81b432bdd4ba9cc7e466fff704a209dd6693dfaaa70",
    "derivation must stay byte-for-byte identical to agent_scope.py"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
}

// ── f. no dev-fallback constants are exported anymore ────────────────────────
{
  const exported = JSON.stringify(Object.keys(proxyModule));
  assert.ok(!exported.includes("DEV_FALLBACK"), "dev fallback constants must be gone");
  const source = fs.readFileSync(
    new URL("../server/lib/runtime_proxy.js", import.meta.url),
    "utf8"
  );
  assert.ok(!source.includes("DEV_FALLBACK"), "no dev-fallback identifiers left in the proxy");
}

// ── facade behaviour against a fake upstream ─────────────────────────────────
function withFakeUpstream() {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      captured.push({ url: req.url, headers: req.headers, body });
      res.statusCode = 200;
      res.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address();
      resolve({
        captured,
        baseUrl: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(r))
      });
    });
  });
}

function fakeReqRes(pathWithQuery, headers = {}) {
  const req = Object.assign(new http.IncomingMessage(null), {
    method: "GET",
    url: pathWithQuery,
    headers: { host: "shell.local", ...headers }
  });
  req.push(null); // no body
  const chunks = [];
  let statusCode = null;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const res = {
    writeHead(code) {
      statusCode = code;
      return this;
    },
    setHeader() {},
    getHeader() {
      return undefined;
    },
    write(chunk) {
      chunks.push(String(chunk));
      return true;
    },
    end(chunk) {
      if (chunk) chunks.push(String(chunk));
      resolveDone();
    },
    on() {},
    once() {},
    emit() {},
    get statusCode() {
      return statusCode;
    },
    set statusCode(v) {
      statusCode = v;
    }
  };
  return { req, res, done, body: () => chunks.join(""), status: () => statusCode };
}

const upstream = await withFakeUpstream();
process.env.RUNTIME_BASE_URL = upstream.baseUrl;

// ── c. human facade strips client-sent agent scope ───────────────────────────
{
  const { req, res, done } = fakeReqRes("/api/runtime/agent_sandbox/health", {
    "x-benny-agent-scope": "sandbox"
  });
  await proxyToRuntime(req, res, new URL(req.url, "http://shell.local"));
  await done;
  const seen = upstream.captured.at(-1);
  assert.equal(
    seen.headers["x-benny-agent-scope"],
    undefined,
    "human facade must strip the client-supplied agent scope"
  );
  assert.equal(seen.headers["x-benny-api-key"], "q0-test-fixture-human-key");
}

// ── d. agent facade forces sandbox even when the caller asserts more ─────────
{
  const { req, res, done } = fakeReqRes("/api/agent-runtime/agent_sandbox/health", {
    "x-benny-agent-scope": "trusted"
  });
  await proxyToAgentRuntime(req, res, new URL(req.url, "http://shell.local"));
  await done;
  const seen = upstream.captured.at(-1);
  assert.equal(
    seen.headers["x-benny-agent-scope"],
    "sandbox",
    "agent facade must force sandbox scope server-side"
  );
  assert.equal(seen.headers["x-benny-api-key"], "q0-test-fixture-agent-key");
}

// ── e. encoded dot-segments are rejected, never proxied ──────────────────────
{
  // `%2e%2e/` is normalised away by the WHATWG URL parser BEFORE prefix
  // matching, so it can never reach a facade handler with an escaped path:
  assert.equal(
    new URL("http://shell.local/api/agent-runtime/%2e%2e/admin").pathname,
    "/api/admin",
    "URL normalisation strips decodable dot-segments pre-routing"
  );
  // …but `..%2f` / `%2e%2e%2f` survive as literal path text (the encoded slash
  // is not a separator to the parser) and would be decoded by the upstream —
  // the guard must catch exactly these:
  assert.equal(hasPathTraversal("/api/agent-runtime/..%2fadmin"), true);
  assert.equal(hasPathTraversal("/api/agent-runtime/%2e%2e%2fadmin"), true);
  assert.equal(hasPathTraversal("/api/runtime/agent_sandbox/health"), false);
  assert.equal(hasPathTraversal("/api/runtime/%zz"), true, "undecodable = rejected");

  const before = upstream.captured.length;
  const { req, res, done, status } = fakeReqRes("/api/agent-runtime/..%2fadmin");
  await proxyToAgentRuntime(req, res, new URL(req.url, "http://shell.local"));
  await done;
  assert.equal(status(), 400, "traversal must be rejected with 400");
  assert.equal(upstream.captured.length, before, "traversal must never reach the upstream");
}

await upstream.close();
console.log("adr003_same_origin_followup_test: ok");
