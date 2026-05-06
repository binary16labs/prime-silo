import assert from "node:assert/strict";
import test from "node:test";
import {
  readBrowserHarnessLogs,
  sendBrowserHarnessCommand,
  startBrowserHarness,
  startHttpServer,
  stopBrowserHarness,
  stopHttpServer
} from "./browser_harness_cli_test_utils.mjs";

test("browser CLI treats localhost hosts like address-bar input instead of app-relative paths", {
  timeout: 2 * 60 * 1000
}, async () => {
  const server = await startHttpServer((request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8"
    });
    response.end(`<!doctype html><html><head><title>Local Browser Address Test</title></head><body>ok</body></html>`);
  });
  const { port } = server.address();
  const harness = await startBrowserHarness();

  try {
    const openResult = await sendBrowserHarnessCommand(harness, "open", [`localhost:${port}`]);
    const stateResult = await sendBrowserHarnessCommand(harness, "state");

    assert.equal(openResult?.id, 1, JSON.stringify({
      openResult,
      ...readBrowserHarnessLogs(harness)
    }, null, 2));
    assert.equal(stateResult?.currentUrl, `http://localhost:${port}/`);
    assert.doesNotMatch(
      stateResult?.currentUrl || "",
      /http:\/\/127\.0\.0\.1:\d+\/localhost:\d+/u
    );
  } finally {
    await stopBrowserHarness(harness);
    await stopHttpServer(server);
  }
});
