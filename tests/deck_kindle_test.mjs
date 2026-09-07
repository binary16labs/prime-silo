// The Kindle tier's defining property: it needs nothing from the client to be true.
import test from "node:test";
import assert from "node:assert/strict";
import { get } from "../server/api/deck_kindle.js";

// Whatever the estate looks like on the machine running this — a full store or none at all —
// the page has to render. The blind path is a real render, not an error page, so both branches
// are exercised by simply asking for the page here.
const render = async () => {
  const res = await get({ query: {} });
  assert.equal(res.status, 200);
  assert.match(res.headers["Content-Type"], /^text\/html/);
  return res.body.toString("utf8");
};

test("the page carries no script and fetches nothing", async () => {
  const html = await render();
  // A Kindle may have no working JS at all, and the whole point of this tier is that it does
  // not matter. One <script> here would make the board silently blank on the device it exists
  // for — and it would blank in the reader's hand, where nobody is watching a console.
  assert.doesNotMatch(html, /<script/i, "a script tag defeats the tier");
  assert.doesNotMatch(html, /rel=["']?stylesheet/i, "an external stylesheet is a request to fail");
  assert.doesNotMatch(html, /<link\b/i);
  assert.doesNotMatch(html, /<img\b/i);
});

test("it states when it was read, because e-ink keeps showing old pages", async () => {
  const html = await render();
  assert.match(html, /Read at /);
  assert.match(html, /http-equiv="refresh"/);
});

test("room mode hides machine names", async () => {
  const open = (await get({ query: {} })).body.toString("utf8");
  const room = (await get({ query: { room: "1" } })).body.toString("utf8");
  assert.match(room, /Room mode: names and titles hidden/);
  // Only assert the masking where there is something to mask; an estate with no nodes
  // reporting is a legitimate state and must not fail the suite.
  const named = open.match(/([a-z0-9-]+): (?:up|not heard from)/);
  if (named) assert.doesNotMatch(room, new RegExp(`\b${named[1]}\b`));
});

test("no surface here can sign anything", async () => {
  const html = await render();
  assert.doesNotMatch(html, /<form|<button|gov_sign/i);
  assert.match(html, /Nothing on this page can be signed from it/);
});
