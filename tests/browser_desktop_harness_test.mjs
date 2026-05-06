import assert from "node:assert/strict";
import test from "node:test";

import { runDesktopBrowserHarnessTest } from "./desktop_browser_harness.mjs";

test("desktop browser harness navigates Novinky and clears the consent page", {
  timeout: 7 * 60 * 1000
}, async () => {
  const result = await runDesktopBrowserHarnessTest({
    verbose: true
  });

  assert.equal(result.success, true);
  assert.equal(typeof result.browserId, "number");
  assert.equal(typeof result.articleReferenceId, "number");
  assert.equal(typeof result.consentReferenceId, "number");
  assert.match(String(result.finalState?.currentUrl || ""), /https:\/\/www\.novinky\.cz\/clanek\//u);
});
