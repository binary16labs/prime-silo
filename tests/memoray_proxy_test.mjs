#!/usr/bin/env node
//
// Phase M1 — Memo-Ray proxy tests.
//
// Verifies path prefix matching, upstream URL building, the method
// whitelist (GET any, POST /files/open only), settings resolution
// (runtime param > wizard manifest > default), the disabled (404) and
// unreachable (502) shapes. Boots a tiny in-process upstream so no real
// Memo-Ray server is needed.

import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";

import {
  isMemorayProxyPath,
  proxyToMemoray,
  resolveMemoraySettings,
  memorayRequest,
  __testing as t
} from "../server/lib/memoray_proxy.js";

// Minimal runtimeParams stub: getEntry(name) → {value, source} | null.
function paramsStub(entries = {}) {
  return {
    getEntry(name) {
      return Object.prototype.hasOwnProperty.call(entries, name) ? entries[name] : null;
    }
  };
}

async function main() {
  t.resetConfigCache();
  testIsMemorayProxyPath();
  testBuildUpstreamUrl();
  testMethodWhitelist();
  await testSettingsPrecedence();
  await testEndToEndPathStrip();
  await testPostFilesOpenAllowed();
  await testPostElsewhereRejected();
  await testDisabledReturns404();
  await testUnreachableReturns502();
  await testMemorayRequestHelper();
  console.log("memoray_proxy_test: ok");
}

function testIsMemorayProxyPath() {
  assert.equal(isMemorayProxyPath("/api/memoray"), true);
  assert.equal(isMemorayProxyPath("/api/memoray/beta/overview"), true);
  assert.equal(isMemorayProxyPath("/api/memoray_other"), false, "must require slash boundary");
  assert.equal(isMemorayProxyPath("/api/runtime/widgets"), false);
}

function testBuildUpstreamUrl() {
  assert.equal(
    t.buildUpstreamUrl(
      new URL("http://shell.local/api/memoray/beta/overview?q=x"),
      "http://127.0.0.1:3001"
    ),
    "http://127.0.0.1:3001/api/beta/overview?q=x"
  );
  assert.equal(
    t.buildUpstreamUrl(new URL("http://shell.local/api/memoray"), "http://127.0.0.1:3001"),
    "http://127.0.0.1:3001/api/"
  );
}

function testMethodWhitelist() {
  const overview = new URL("http://shell.local/api/memoray/beta/overview");
  const filesOpen = new URL("http://shell.local/api/memoray/files/open");
  assert.equal(t.isMethodAllowed("GET", overview), true);
  assert.equal(t.isMethodAllowed("HEAD", overview), true);
  assert.equal(t.isMethodAllowed("POST", overview), false, "POST only allowed to /files/open");
  assert.equal(t.isMethodAllowed("POST", filesOpen), true);
  assert.equal(t.isMethodAllowed("DELETE", filesOpen), false);
  assert.equal(t.isMethodAllowed("PUT", overview), false);
}

async function testSettingsPrecedence() {
  t.resetConfigCache();
  // 1. Runtime param wins.
  const fromParam = await resolveMemoraySettings({
    runtimeParams: paramsStub({ MEMORAY_BASE_URL: { value: "http://param:9", source: "stored" } }),
    projectRoot: undefined
  });
  assert.equal(fromParam.baseUrl, "http://param:9");
  assert.equal(fromParam.sources.baseUrl, "param");

  // 2. A schema default param does NOT shadow config — falls through.
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "memoray-cfg-"));
  await fs.writeFile(
    path.join(tmp, "prime-silo.config.json"),
    JSON.stringify({ memoray: { enabled: true, base_url: "http://config:5" } })
  );
  t.resetConfigCache();
  const fromConfig = await resolveMemoraySettings({
    runtimeParams: paramsStub({ MEMORAY_BASE_URL: { value: "http://default", source: "default" } }),
    projectRoot: tmp
  });
  assert.equal(
    fromConfig.baseUrl,
    "http://config:5",
    "config applies when only a default param exists"
  );
  assert.equal(fromConfig.sources.baseUrl, "config");

  // 3. Default when nothing set.
  t.resetConfigCache();
  const fallback = await resolveMemoraySettings({
    runtimeParams: paramsStub({}),
    projectRoot: undefined
  });
  assert.equal(fallback.baseUrl, t.DEFAULT_MEMORAY_BASE_URL);
  assert.equal(fallback.enabled, true);

  await fs.rm(tmp, { recursive: true, force: true });
  t.resetConfigCache();
}

async function withUpstream(handler) {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => {
      body += c;
    });
    req.on("end", () => {
      captured.push({ method: req.method, url: req.url, headers: { ...req.headers }, body });
      handler(req, res, body);
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const { port } = server.address();
  return {
    captured,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((r) => server.close(() => r()))
  };
}

async function callProxy(baseUrl, requestInit, { enabled = true } = {}) {
  const runtimeParams = paramsStub({
    MEMORAY_BASE_URL: { value: baseUrl, source: "stored" },
    MEMORAY_ENABLED: { value: enabled, source: "stored" }
  });
  const wrapper = http.createServer(async (req, res) => {
    await proxyToMemoray(req, res, new URL(req.url, "http://shell.local"), {
      runtimeParams,
      projectRoot: undefined
    });
  });
  try {
    await new Promise((r) => wrapper.listen(0, "127.0.0.1", r));
    const { port } = wrapper.address();
    const response = await fetch(`http://127.0.0.1:${port}${requestInit.path}`, {
      method: requestInit.method || "GET",
      headers: requestInit.headers || {},
      body: requestInit.body
    });
    return { status: response.status, text: await response.text() };
  } finally {
    await new Promise((r) => wrapper.close(() => r()));
  }
}

async function testEndToEndPathStrip() {
  const upstream = await withUpstream((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ totalNodes: 42 }));
  });
  try {
    const result = await callProxy(upstream.baseUrl, { path: "/api/memoray/ecosystem/manifest" });
    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { totalNodes: 42 });
    assert.equal(upstream.captured[0].url, "/api/ecosystem/manifest", "prefix must be stripped");
    assert.equal(
      upstream.captured[0].headers.origin,
      undefined,
      "no Origin → memo-ray CORS never engages"
    );
  } finally {
    await upstream.close();
  }
}

async function testPostFilesOpenAllowed() {
  const upstream = await withUpstream((req, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ status: "ok" }));
  });
  try {
    const result = await callProxy(upstream.baseUrl, {
      path: "/api/memoray/files/open",
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ filePath: "C:/x/y.txt" })
    });
    assert.equal(result.status, 200);
    assert.equal(upstream.captured[0].url, "/api/files/open");
    assert.equal(JSON.parse(upstream.captured[0].body).filePath, "C:/x/y.txt");
  } finally {
    await upstream.close();
  }
}

async function testPostElsewhereRejected() {
  const upstream = await withUpstream((req, res) => {
    res.statusCode = 200;
    res.end("{}");
  });
  try {
    const result = await callProxy(upstream.baseUrl, { path: "/api/memoray/sync", method: "POST" });
    assert.equal(result.status, 405);
    assert.equal(JSON.parse(result.text).error, "memoray_method_not_allowed");
    assert.equal(upstream.captured.length, 0, "rejected before reaching upstream");
  } finally {
    await upstream.close();
  }
}

async function testDisabledReturns404() {
  const result = await callProxy(
    "http://127.0.0.1:1",
    { path: "/api/memoray/sessions" },
    { enabled: false }
  );
  assert.equal(result.status, 404);
  assert.equal(JSON.parse(result.text).error, "memoray_disabled");
}

async function testUnreachableReturns502() {
  const result = await callProxy("http://127.0.0.1:1", { path: "/api/memoray/sessions" });
  assert.equal(result.status, 502);
  const body = JSON.parse(result.text);
  assert.equal(body.error, "memoray_unreachable");
  assert.ok(body.hint, "must carry a boot hint");
}

async function testMemorayRequestHelper() {
  const upstream = await withUpstream((req, res) => {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: 1 }));
  });
  try {
    const runtimeParams = paramsStub({
      MEMORAY_BASE_URL: { value: upstream.baseUrl, source: "stored" }
    });
    const result = await memorayRequest("/ecosystem/manifest", { runtimeParams });
    assert.equal(result.ok, true);
    assert.deepEqual(result.body, { ok: 1 });
    assert.equal(upstream.captured[0].url, "/api/ecosystem/manifest");

    const disabled = await memorayRequest("/sessions", {
      runtimeParams: paramsStub({ MEMORAY_ENABLED: { value: false, source: "stored" } })
    });
    assert.equal(disabled.ok, false);
    assert.equal(disabled.error, "memoray_disabled");
  } finally {
    await upstream.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
