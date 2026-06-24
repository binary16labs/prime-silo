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
  testComposePromptIncludesLiveData();
  testCreatePublishesSnapshot();
  await testDispatchRoutesToAgent();
  await testDispatchAgentUnavailable();
  await testDispatchAutoLoadsSkill();
  await testDispatchSwallowsSkillLoadError();
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
  const line = describeContext({
    mode: "code",
    selection: { label: "swarm.py" },
    workspace: "c5_test"
  });
  assert.match(line, /mode: code/);
  assert.match(line, /selected: swarm\.py/);
  assert.match(line, /workspace: c5_test/);
}

function testComposePromptGroundsAndPointsAtSkill() {
  const prompt = composePrompt("Explain this graph", {
    mode: "code",
    workspace: "ws",
    selection: { id: "n1" }
  });
  assert.match(prompt, /Explain this graph/);
  assert.match(prompt, /Bridge context/);
  assert.match(prompt, /mode: code/);
  assert.match(prompt, /#\/_prime_silo\/bridge\?mode=code&id=n1/);
  assert.ok(prompt.includes(__testing.SKILL_IMPORT), "prompt includes the benny-pilot import path");
  // Skill must be declared loaded — not ask Benny to load it.
  assert.match(prompt, /is loaded/);
  assert.ok(
    !prompt.includes("space.skills.load"),
    "prompt must not ask Benny to call space.skills.load"
  );
  // Must instruct Benny to answer from real data, not hypothetically.
  assert.match(prompt, /not hypothetically/);
}

function testComposePromptIncludesLiveData() {
  const liveData =
    'Code graph (workspace "ws"): 42 nodes (15 File, 12 Class, 15 Function), 89 edges. No node selected.';
  const prompt = composePrompt("Explain this graph", { mode: "code", workspace: "ws" }, liveData);
  assert.match(prompt, /Live data:/);
  assert.match(prompt, /42 nodes/);
  assert.match(prompt, /89 edges/);
  // Without liveData the Live data line must be absent.
  const promptNoData = composePrompt("Explain this graph", { mode: "code", workspace: "ws" });
  assert.ok(!promptNoData.includes("Live data:"), "no Live data line when liveData is null");
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
    agent: {
      async submitPrompt(text) {
        calls.push(text);
      }
    }
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

async function testDispatchAutoLoadsSkill() {
  // dispatch() must call space.skills.load("benny-pilot") before submitPrompt
  // so the skill is in context before the model sees the prompt.
  const loaded = [];
  const submitted = [];
  const target = {
    space: {
      skills: {
        load: async (id) => {
          loaded.push(id);
        }
      },
      onscreenAgent: {
        submitPrompt: async (p) => {
          submitted.push(p);
        }
      }
    }
  };
  const ctx = createBridgeContext({ globalTarget: target });
  await ctx.dispatch("What am I looking at?");
  assert.deepEqual(loaded, ["benny-pilot"], "must load benny-pilot before submitting");
  assert.equal(submitted.length, 1, "must submit the prompt");
}

async function testDispatchSwallowsSkillLoadError() {
  // If skills.load throws (e.g. skill runtime not up), dispatch must still
  // submit the prompt — the import path in the prompt text is the fallback.
  const submitted = [];
  const target = {
    space: {
      skills: {
        load: async () => {
          throw new Error("skill runtime unavailable");
        }
      },
      onscreenAgent: {
        submitPrompt: async (p) => {
          submitted.push(p);
        }
      }
    }
  };
  const ctx = createBridgeContext({ globalTarget: target });
  const result = await ctx.dispatch("Explain");
  assert.equal(result.ok, true, "dispatch must succeed even when skill load throws");
  assert.equal(submitted.length, 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
