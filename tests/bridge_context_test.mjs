#!/usr/bin/env node
//
// Phase B-Bridge — Benny context provider tests.
//
// bridge-context.js has no DOM dependency, so it imports clean. We test the
// deep-link builder, the grounded-prompt composer, snapshot publishing to an
// injected global target, and dispatch routing to an injected agent (including
// the agent-unavailable path).

import assert from "node:assert/strict";

import {
  bridgeDeepLink,
  describeContext,
  composePrompt,
  createBridgeContext,
  __testing
} from "../app/L0/_all/mod/_prime_silo/bridge/bridge-context.js";

async function main() {
  testDeepLink();
  testDescribeContext();
  testComposePromptGroundsAndPointsAtSkill();
  testCreatePublishesSnapshot();
  await testDispatchRoutesToAgent();
  await testDispatchAgentUnavailable();
  console.log("bridge_context_test: ok");
}

function testDeepLink() {
  assert.equal(bridgeDeepLink({}), "#/_prime_silo/bridge");
  assert.equal(bridgeDeepLink({ mode: "code" }), "#/_prime_silo/bridge?mode=code");
  assert.equal(
    bridgeDeepLink({ mode: "memory", selection: { id: "s1" } }),
    "#/_prime_silo/bridge?mode=memory&id=s1"
  );
}

function testDescribeContext() {
  const line = describeContext({ mode: "code", selection: { label: "swarm.py" }, workspace: "c5_test" });
  assert.match(line, /mode: code/);
  assert.match(line, /selected: swarm\.py/);
  assert.match(line, /workspace: c5_test/);
}

function testComposePromptGroundsAndPointsAtSkill() {
  const prompt = composePrompt("Explain this graph", { mode: "code", workspace: "ws", selection: { id: "n1" } });
  assert.match(prompt, /Explain this graph/);
  assert.match(prompt, /Bridge context/);
  assert.match(prompt, /mode: code/);
  assert.match(prompt, /#\/_prime_silo\/bridge\?mode=code&id=n1/);
  assert.ok(prompt.includes(__testing.SKILL_IMPORT), "prompt points the agent at the benny-pilot skill");
}

function testCreatePublishesSnapshot() {
  const target = {};
  const ctx = createBridgeContext({ globalTarget: target, agent: { submitPrompt() {} } });
  assert.ok(target[__testing.GLOBAL_KEY], "publishes on create");
  ctx.set({ mode: "documents", workspace: "c5_test" });
  assert.equal(target[__testing.GLOBAL_KEY].mode, "documents");
  assert.equal(target[__testing.GLOBAL_KEY].workspace, "c5_test");
  assert.equal(ctx.snapshot().route, "#/_prime_silo/bridge?mode=documents");
}

async function testDispatchRoutesToAgent() {
  const calls = [];
  const ctx = createBridgeContext({
    globalTarget: {},
    agent: { async submitPrompt(text) { calls.push(text); } }
  });
  ctx.set({ mode: "memory" });
  const result = await ctx.dispatch("What did I work on?");
  assert.equal(result.ok, true);
  assert.equal(calls.length, 1);
  assert.match(calls[0], /What did I work on\?/);
  assert.match(calls[0], /mode: memory/);
}

async function testDispatchAgentUnavailable() {
  const ctx = createBridgeContext({ globalTarget: {}, agent: null });
  const result = await ctx.dispatch("Explain");
  assert.equal(result.ok, false);
  assert.equal(result.reason, "agent_unavailable");
  assert.ok(result.prompt, "still returns the prompt it would have sent");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
