#!/usr/bin/env node
//
// ADR-001 Phase C — text.markdown widget tests.
//
// Two layers: the pure renderer (no DOM, no fetch) and the widget factory
// (uses a tiny fake host because Node has no built-in DOM and we don't want
// to pull jsdom in just for this).

import assert from "node:assert/strict";

import {
  renderMarkdown,
  __testing as renderTesting
} from "../app/L0/_all/mod/_prime_silo/widgets/text/markdown/render.js";
import { createMarkdownWidget } from "../app/L0/_all/mod/_prime_silo/widgets/text/markdown/index.js";

async function main() {
  testRendererBasics();
  testRendererEscapesHtml();
  testRendererInlineEmphasisAndLinks();
  testRendererCodeAndLists();
  testRendererRejectsUnsafeHrefs();
  await testWidgetMountReadsSource();
  await testWidgetHandles404AsEmpty();
  await testWidgetSaveUsesAgentScope();
  await testWidgetUpdateReloadsOnSourceChange();
  await testWidgetSurfacesNon404Errors();
  console.log("widgets_text_markdown_test: ok");
}

function testRendererBasics() {
  assert.equal(renderMarkdown(""), "");
  assert.equal(renderMarkdown("# Hello"), "<h1>Hello</h1>");
  assert.equal(renderMarkdown("## Sub"), "<h2>Sub</h2>");
  assert.equal(
    renderMarkdown("paragraph one\n\nparagraph two"),
    "<p>paragraph one</p>\n<p>paragraph two</p>"
  );
  assert.equal(renderMarkdown("---"), "<hr />");
}

function testRendererEscapesHtml() {
  const out = renderMarkdown("a <b>bold</b> attempt");
  assert.match(out, /&lt;b&gt;/);
  assert.doesNotMatch(out, /<b>bold<\/b>/);
}

function testRendererInlineEmphasisAndLinks() {
  const strong = renderMarkdown("**bold**");
  assert.match(strong, /<strong>bold<\/strong>/);

  const em = renderMarkdown("an *italic* word");
  assert.match(em, /<em>italic<\/em>/);

  const link = renderMarkdown("[home](https://example.com)");
  assert.match(
    link,
    /<a href="https:\/\/example\.com" target="_blank" rel="noopener noreferrer">home<\/a>/
  );
}

function testRendererCodeAndLists() {
  const code = renderMarkdown("use `foo()` here");
  assert.match(code, /<code>foo\(\)<\/code>/);

  const fence = renderMarkdown("```js\nconst x = 1;\n```");
  assert.match(fence, /<pre><code class="language-js">const x = 1;<\/code><\/pre>/);

  const list = renderMarkdown("- one\n- two\n- three");
  assert.match(list, /<ul><li>one<\/li><li>two<\/li><li>three<\/li><\/ul>/);
}

function testRendererRejectsUnsafeHrefs() {
  // javascript: hrefs are passed through as literal text rather than rendered
  // as anchors. We assert that no <a> tag appears.
  const out = renderMarkdown("[click](javascript:alert(1))");
  assert.doesNotMatch(out, /<a /);
  assert.equal(renderTesting.isSafeHref("javascript:alert(1)"), false);
  assert.equal(renderTesting.isSafeHref("data:text/html,foo"), false);
  assert.equal(renderTesting.isSafeHref("https://x.com"), true);
  assert.equal(renderTesting.isSafeHref("./relative.md"), true);
  assert.equal(renderTesting.isSafeHref("/absolute"), true);
}

// ---------------------------------------------------------------------------
// Widget factory tests — uses a tiny fake host element.
// ---------------------------------------------------------------------------

class FakeClassList {
  constructor() {
    this._set = new Set();
  }
  add(...names) {
    names.forEach((n) => this._set.add(n));
  }
  remove(...names) {
    names.forEach((n) => this._set.delete(n));
  }
  toggle(name, force) {
    if (force === true) {
      this._set.add(name);
      return true;
    }
    if (force === false) {
      this._set.delete(name);
      return false;
    }
    if (this._set.has(name)) {
      this._set.delete(name);
      return false;
    }
    this._set.add(name);
    return true;
  }
  has(name) {
    return this._set.has(name);
  }
}

function createFakeHost() {
  const host = {
    classList: new FakeClassList(),
    dataset: {},
    innerHTML: ""
  };
  // Minimal querySelector — enough to find the body div the widget creates
  // after a successful load. Returns a writable shim.
  host.querySelector = (selector) => {
    if (selector === ".prime-silo-md__body" && /prime-silo-md__body/.test(host.innerHTML)) {
      return {
        innerHTML: "",
        classList: new FakeClassList()
      };
    }
    return null;
  };
  return host;
}

// Stub the runtime client. The object is built first and returned directly so
// its method closures reference the same `stub` (no closure-over-self issue).
function createRuntimeClientStub() {
  const calls = [];

  function jsonResponse(body, status = 200) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" }
    });
  }

  const stub = {
    calls,
    runtimeHandler: null,
    agentHandler: null,
    jsonResponse,
    runtimeFetch: null,
    fetchAsAgent: null,
    readRuntimeJson: async (response) => {
      const text = await response.text();
      return text ? JSON.parse(text) : null;
    }
  };

  stub.runtimeFetch = async (path, init = {}) => {
    calls.push({ kind: "runtimeFetch", path, init });
    if (!stub.runtimeHandler) {
      throw new Error("no runtimeHandler installed for path " + path);
    }
    const result = stub.runtimeHandler(path, init);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  };

  stub.fetchAsAgent = async (path, init = {}, options = {}) => {
    calls.push({ kind: "fetchAsAgent", path, init, options });
    if (stub.agentHandler) {
      const result = stub.agentHandler(path, init, options);
      if (result instanceof Error) {
        throw result;
      }
      return result;
    }
    return jsonResponse({ status: "written" });
  };

  return stub;
}

function makeRuntimeError(status, detail) {
  const err = new Error(detail);
  err.name = "RuntimeError";
  err.status = status;
  err.body = { detail };
  return err;
}

async function settle() {
  // Microtask flush — the widget's load() runs asynchronously after mount.
  for (let i = 0; i < 5; i += 1) {
    await Promise.resolve();
  }
}

async function testWidgetMountReadsSource() {
  const host = createFakeHost();
  const stub = createRuntimeClientStub();
  stub.runtimeHandler = (path) => {
    assert.match(path, /\/agent_sandbox\/read\/default\/notes\/exposure\.md$/);
    return stub.jsonResponse({
      workspace: "default",
      subdir: "notes",
      filename: "exposure.md",
      content: "# Exposure\n\nBody text."
    });
  };

  createMarkdownWidget(host, { source: "exposure.md" }, { runtimeClient: stub });
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /<h1>Exposure<\/h1>/);
  assert.match(host.innerHTML, /<p>Body text\.<\/p>/);
  assert.equal(stub.calls.length, 1);
}

async function testWidgetHandles404AsEmpty() {
  const host = createFakeHost();
  const stub = createRuntimeClientStub();
  stub.runtimeHandler = () => makeRuntimeError(404, "missing");

  createMarkdownWidget(host, { source: "absent.md" }, { runtimeClient: stub });
  await settle();

  assert.equal(host.dataset.widgetState, "ready");
  assert.match(host.innerHTML, /prime-silo-md__body--empty/);
}

async function testWidgetSaveUsesAgentScope() {
  const host = createFakeHost();
  const stub = createRuntimeClientStub();
  stub.runtimeHandler = () => stub.jsonResponse({ content: "" });

  const widget = createMarkdownWidget(host, { source: "draft.md" }, { runtimeClient: stub });
  await settle();

  const callsBefore = stub.calls.length;
  await widget.save("# new content");

  const saveCall = stub.calls[callsBefore];
  assert.equal(saveCall.kind, "fetchAsAgent");
  assert.equal(saveCall.path, "/agent_sandbox/write");
  assert.equal(saveCall.init.method, "POST");
  assert.equal(saveCall.options.scope, "sandbox", "default scope must be sandbox");

  const body = JSON.parse(saveCall.init.body);
  assert.equal(body.workspace, "default");
  assert.equal(body.subdir, "notes");
  assert.equal(body.filename, "draft.md");
  assert.equal(body.content, "# new content");
  assert.equal(body.agent_id, "text.markdown");
}

async function testWidgetUpdateReloadsOnSourceChange() {
  const host = createFakeHost();
  const stub = createRuntimeClientStub();
  let nthLoad = 0;
  stub.runtimeHandler = (path) => {
    nthLoad += 1;
    if (nthLoad === 1) {
      assert.match(path, /\/notes\/first\.md$/);
      return stub.jsonResponse({ content: "# first" });
    }
    assert.match(path, /\/notes\/second\.md$/);
    return stub.jsonResponse({ content: "# second" });
  };

  const widget = createMarkdownWidget(host, { source: "first.md" }, { runtimeClient: stub });
  await settle();
  widget.update({ source: "second.md" });
  await settle();

  assert.equal(nthLoad, 2);
  assert.match(host.innerHTML, /<h1>second<\/h1>/);
}

async function testWidgetSurfacesNon404Errors() {
  const host = createFakeHost();
  const stub = createRuntimeClientStub();
  stub.runtimeHandler = () => makeRuntimeError(403, "forbidden by AgentScopeMiddleware");

  createMarkdownWidget(host, { source: "blocked.md" }, { runtimeClient: stub });
  await settle();

  assert.equal(host.dataset.widgetState, "error");
  assert.match(host.innerHTML, /forbidden by AgentScopeMiddleware/);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
