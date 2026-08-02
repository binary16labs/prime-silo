// Retry-policy controls for scripts/longview/lib/llm.mjs.
//
// These are NEGATIVE controls, and they earn their keep: the first implementation of the
// retry classifier matched on the error MESSAGE, and the LM Studio engine wedge returns a
// 400 whose body reads "Engine protocol predict request failed: fetch failed". It retried
// the wedge three times — hammering a wedged eGPU, the precise failure the halt-don't-retry
// doctrine exists to prevent. The rule that fixed it: an HTTP response means the request
// reached the server, so STATUS decides and the body is never consulted.
//
// Runs entirely against a local stub. It must never touch the real LM host: a second
// concurrent request is what wedges RDNA4/ROCm in the first place.
import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";

let mode = "wedge";
const hits = { wedge: 0, busy: 0, ok: 0 };

const srv = http.createServer((req, res) => {
  hits[mode]++;
  if (mode === "wedge") {
    res.writeHead(400, { "Content-Type": "application/json" });
    // the wedge body deliberately contains "fetch failed" — the text-matching trap
    res.end(JSON.stringify({ error: "Engine protocol predict request failed: fetch failed" }));
  } else if (mode === "busy") {
    res.writeHead(503);
    res.end("overloaded");
  } else {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "OK" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  }
});

await new Promise((r) => srv.listen(0, "127.0.0.1", r));
const port = srv.address().port;

// config reads the endpoint once at import — pin it BEFORE llm.mjs is first imported
process.env.LONGVIEW_LLM_BASE_URL = `http://127.0.0.1:${port}/v1`;
process.env.LONGVIEW_LLM_RETRIES = "3";
process.env.LONGVIEW_LLM_TIMEOUT_MS = "5000";
const { chat } = await import("../scripts/longview/lib/llm.mjs");

const call = async () => { try { return await chat({ user: "hi", maxTokens: 10 }); } catch (e) { return e; } };

test("the engine wedge (400) is never retried", async () => {
  mode = "wedge";
  await call();
  assert.equal(hits.wedge, 1, "a wedged engine must be hit exactly once, then halted on");
});

test("a 503 is retried up to the configured limit", async () => {
  mode = "busy";
  await call();
  assert.equal(hits.busy, 3, "server-side overload is transient — retry with backoff");
});

test("a healthy call succeeds on the first attempt", async () => {
  mode = "ok";
  const r = await call();
  assert.equal(hits.ok, 1);
  assert.equal(r.content, "OK");
});

test.after(() => srv.close());
