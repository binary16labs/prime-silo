import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const {
  createDesktopUpdaterPersistentLog,
  describeDesktopUpdateError,
  downloadDesktopUpdateAssetToFile
} = require("../packaging/desktop/updater_download.js");

const PAYLOAD = Buffer.alloc(256 * 1024, 7);

async function withServer(handler, run) {
  let requests = 0;
  const server = http.createServer((req, res) => handler(req, res, ++requests));
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  try {
    return await run(`http://127.0.0.1:${port}`, () => requests);
  } finally {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

async function tempDir() {
  return fs.mkdtemp(path.join(os.tmpdir(), "updater-download-"));
}

test("follows the GitHub-style redirect and reports the final URL", async () => {
  const dir = await tempDir();
  await withServer(
    (req, res) => {
      if (req.url === "/asset.exe") {
        res.writeHead(302, { location: "/cdn/asset.exe" });
        return res.end();
      }
      res.writeHead(200, { "content-length": PAYLOAD.length });
      res.end(PAYLOAD);
    },
    async (base) => {
      const destination = path.join(dir, "asset.exe");
      const result = await downloadDesktopUpdateAssetToFile(`${base}/asset.exe`, destination, {
        attempts: 1
      });
      assert.equal(result.size, PAYLOAD.length);
      assert.equal(result.sha512, createHash("sha512").update(PAYLOAD).digest("base64"));
      assert.equal(result.finalUrl, `${base}/cdn/asset.exe`);
      assert.equal((await fs.stat(destination)).size, PAYLOAD.length);
    }
  );
});

test("a connection dropped mid-download is retried and recorded, then succeeds", async () => {
  const dir = await tempDir();
  const failures = [];
  await withServer(
    (req, res, n) => {
      res.writeHead(200, { "content-length": PAYLOAD.length });
      if (n === 1) {
        res.write(PAYLOAD.subarray(0, 1024));
        setTimeout(() => res.socket.destroy(), 20);
        return;
      }
      res.end(PAYLOAD);
    },
    async (base, requestCount) => {
      const destination = path.join(dir, "asset.exe");
      const result = await downloadDesktopUpdateAssetToFile(`${base}/asset.exe`, destination, {
        attempts: 3,
        retryBaseDelayMs: 1,
        onAttemptFailed: (info) => failures.push(info)
      });
      assert.equal(result.attempt, 2);
      assert.equal(requestCount(), 2);
      assert.equal(failures.length, 1);
      assert.equal(failures[0].willRetry, true);
      assert.ok(failures[0].error.bytesReceived >= 1024);
      assert.equal(failures[0].error.expectedBytes, PAYLOAD.length);
      await assert.rejects(fs.stat(path.join(dir, "temp-asset.exe")));
    }
  );
});

test("a stalled download is aborted instead of hanging forever", async () => {
  const dir = await tempDir();
  await withServer(
    (req, res) => {
      res.writeHead(200, { "content-length": PAYLOAD.length });
      res.write(PAYLOAD.subarray(0, 1024));
      // never finish
    },
    async (base) => {
      const error = await downloadDesktopUpdateAssetToFile(
        `${base}/asset.exe`,
        path.join(dir, "asset.exe"),
        { attempts: 1, stallTimeoutMs: 150 }
      ).catch((e) => e);
      assert.equal(error.phase, "stalled");
      assert.match(error.message, /stalled/u);
    }
  );
});

test("a 404 fails fast without retrying and keeps the status code", async () => {
  const dir = await tempDir();
  const failures = [];
  await withServer(
    (req, res) => {
      res.writeHead(404);
      res.end();
    },
    async (base, requestCount) => {
      const error = await downloadDesktopUpdateAssetToFile(
        `${base}/Prime-Silo-9.9-windows-x64.exe`,
        path.join(dir, "asset.exe"),
        { attempts: 4, retryBaseDelayMs: 1, onAttemptFailed: (info) => failures.push(info) }
      ).catch((e) => e);
      assert.equal(error.statusCode, 404);
      assert.equal(requestCount(), 1);
      assert.equal(failures[0].willRetry, false);
    }
  );
});

test("an unreachable host surfaces the underlying socket cause, not just 'fetch failed'", async () => {
  const dir = await tempDir();
  const probe = http.createServer();
  await new Promise((resolve) => probe.listen(0, "127.0.0.1", resolve));
  const closedPort = probe.address().port;
  await new Promise((resolve) => probe.close(resolve));
  const error = await downloadDesktopUpdateAssetToFile(
    `http://127.0.0.1:${closedPort}/asset.exe`,
    path.join(dir, "asset.exe"),
    { attempts: 1 }
  ).catch((e) => e);
  const described = describeDesktopUpdateError(error);
  assert.equal(described.phase, "request");
  assert.ok(JSON.stringify(described.cause).includes("ECONNREFUSED"), JSON.stringify(described));
  assert.match(error.message, /ECONNREFUSED/u);
});

test("persistent log serializes concurrent writes, records details and rotates", async () => {
  const dir = await tempDir();
  const logPath = path.join(dir, "logs", "desktop-updater.log");
  const log = createDesktopUpdaterPersistentLog(logPath, { maxBytes: 400 });

  for (let i = 0; i < 20; i += 1) {
    log.append("error", `event ${i}`, { error: { message: "boom", code: "ECONNRESET" } });
  }
  await log.flush();

  const current = await fs.readFile(logPath, "utf8");
  const rotated = await fs.readFile(`${logPath}.1`, "utf8");
  assert.match(current, /ERROR event 19/u);
  assert.match(rotated + current, /"code":"ECONNRESET"/u);
  for (const line of (rotated + current).trim().split("\n")) {
    assert.ok(line.startsWith("20") || line.startsWith("{"), `interleaved line: ${line}`);
  }
});
