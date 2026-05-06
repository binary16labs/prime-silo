#!/usr/bin/env node
//
// ADR-001 Phase D — runtime proxy tests.
//
// Verifies that /api/runtime/<path> requests are correctly stripped, the
// Benny governance API key is injected, and X-Benny-Agent-Scope flows
// through unchanged. Boots a tiny in-process HTTP server as the fake Benny
// upstream so the test never touches a real Python runtime.

import assert from "node:assert/strict";
import http from "node:http";
import { URL } from "node:url";

import {
  isRuntimeProxyPath,
  proxyToRuntime,
  __testing as runtimeProxyTesting
} from "../server/lib/runtime_proxy.js";

async function main() {
  testIsRuntimeProxyPath();
  testBuildUpstreamUrl();
  await testEndToEndPathStripAndHeaders();
  await testAgentScopeFlowsThrough();
  await testUpstreamErrorPropagated();
  await testUnreachableRuntimeReturns502();
  console.log("runtime_proxy_test: ok");
}

function testIsRuntimeProxyPath() {
  assert.equal(isRuntimeProxyPath("/api/runtime"), true);
  assert.equal(isRuntimeProxyPath("/api/runtime/widgets"), true);
  assert.equal(isRuntimeProxyPath("/api/runtime/agent_sandbox/health"), true);
  assert.equal(isRuntimeProxyPath("/api/runtime_other"), false, "must require slash boundary");
  assert.equal(isRuntimeProxyPath("/api/proxy"), false);
  assert.equal(isRuntimeProxyPath("/api/files/upload"), false);
}

function testBuildUpstreamUrl() {
  const original = process.env.RUNTIME_BASE_URL;
  process.env.RUNTIME_BASE_URL = "http://127.0.0.1:9999";
  try {
    const url = runtimeProxyTesting.buildUpstreamUrl(
      new URL("http://shell.local/api/runtime/agent_sandbox/health?ws=demo")
    );
    assert.equal(url, "http://127.0.0.1:9999/api/agent_sandbox/health?ws=demo");

    const root = runtimeProxyTesting.buildUpstreamUrl(
      new URL("http://shell.local/api/runtime")
    );
    assert.equal(root, "http://127.0.0.1:9999/api/");
  } finally {
    if (original === undefined) {
      delete process.env.RUNTIME_BASE_URL;
    } else {
      process.env.RUNTIME_BASE_URL = original;
    }
  }
}

async function withFakeUpstream(handler) {
  const captured = [];
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      captured.push({
        method: req.method,
        url: req.url,
        headers: { ...req.headers },
        body
      });
      handler(req, res, body);
    });
  });

  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    captured,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () =>
      new Promise((resolve) => server.close(() => resolve()))
  };
}

async function callProxyAgainst(upstreamBaseUrl, requestInit) {
  const original = process.env.RUNTIME_BASE_URL;
  process.env.RUNTIME_BASE_URL = upstreamBaseUrl;

  // Spin up a wrapper server that hands every incoming request to
  // proxyToRuntime. The test uses real fetch against the wrapper, so the
  // entire path strip → upstream call → response stream code runs.
  const wrapper = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url, "http://shell.local");
    await proxyToRuntime(req, res, requestUrl);
  });

  try {
    await new Promise((resolve) => wrapper.listen(0, "127.0.0.1", resolve));
    const { port } = wrapper.address();
    const response = await fetch(
      `http://127.0.0.1:${port}${requestInit.path}`,
      {
        method: requestInit.method || "GET",
        headers: requestInit.headers || {},
        body: requestInit.body
      }
    );
    const text = await response.text();
    return { status: response.status, headers: response.headers, text };
  } finally {
    await new Promise((resolve) => wrapper.close(() => resolve()));
    if (original === undefined) {
      delete process.env.RUNTIME_BASE_URL;
    } else {
      process.env.RUNTIME_BASE_URL = original;
    }
  }
}

async function testEndToEndPathStripAndHeaders() {
  const upstream = await withFakeUpstream((req, res) => {
    res.statusCode = 200;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: true }));
  });

  try {
    const result = await callProxyAgainst(upstream.baseUrl, {
      path: "/api/runtime/widgets"
    });

    assert.equal(result.status, 200);
    assert.deepEqual(JSON.parse(result.text), { ok: true });

    assert.equal(upstream.captured.length, 1);
    const seen = upstream.captured[0];
    assert.equal(seen.url, "/api/widgets", "prefix must be stripped");
    assert.ok(
      seen.headers["x-benny-api-key"],
      "shell must inject the Benny governance API key"
    );
  } finally {
    await upstream.close();
  }
}

async function testAgentScopeFlowsThrough() {
  const upstream = await withFakeUpstream((req, res) => {
    res.statusCode = 200;
    res.end("");
  });

  try {
    await callProxyAgainst(upstream.baseUrl, {
      path: "/api/runtime/agent_sandbox/write",
      method: "POST",
      headers: {
        "content-type": "application/json",
        "X-Benny-Agent-Scope": "sandbox"
      },
      body: JSON.stringify({
        workspace: "default",
        subdir: "notes",
        filename: "hello.md",
        content: "# hi"
      })
    });

    const seen = upstream.captured[0];
    assert.equal(seen.url, "/api/agent_sandbox/write");
    assert.equal(seen.method, "POST");
    assert.equal(
      seen.headers["x-benny-agent-scope"],
      "sandbox",
      "agent scope header must flow through unchanged"
    );
    assert.equal(
      JSON.parse(seen.body).filename,
      "hello.md",
      "request body must reach the upstream"
    );
  } finally {
    await upstream.close();
  }
}

async function testUpstreamErrorPropagated() {
  const upstream = await withFakeUpstream((req, res) => {
    res.statusCode = 403;
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ detail: "Forbidden: sandbox scope" }));
  });

  try {
    const result = await callProxyAgainst(upstream.baseUrl, {
      path: "/api/runtime/files/upload",
      method: "POST",
      headers: { "X-Benny-Agent-Scope": "sandbox" }
    });

    assert.equal(result.status, 403);
    assert.match(result.text, /Forbidden/);
  } finally {
    await upstream.close();
  }
}

async function testUnreachableRuntimeReturns502() {
  // Use a port we know nothing is bound to; OS will refuse the connection.
  const result = await callProxyAgainst("http://127.0.0.1:1", {
    path: "/api/runtime/widgets"
  });

  assert.equal(result.status, 502);
  const body = JSON.parse(result.text);
  assert.equal(body.error, "runtime_proxy_unreachable");
  assert.ok(body.detail);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
