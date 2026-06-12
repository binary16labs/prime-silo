#!/usr/bin/env node
//
// GET /api/config_defaults — surfaces the wizard manifest's model block so
// the onscreen agent can seed first-run settings.
//
// Covers: missing manifest, invalid JSON, missing/empty model block,
// happy path (local + cloud), and the sanitisation whitelist (unknown and
// secret-looking fields are never forwarded).

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { get, allowAnonymous } from "../server/api/config_defaults.js";

async function withProjectRoot(files, fn) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "ps-configdef-"));
  try {
    for (const [name, content] of Object.entries(files)) {
      await fs.writeFile(path.join(dir, name), content, "utf8");
    }
    return await fn(dir);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
}

function manifest(model) {
  return JSON.stringify({ schema: "aamp.config/1", model }, null, 2);
}

async function testAnonymousAllowed() {
  assert.equal(allowAnonymous, true);
  console.log("  ✓ route allows anonymous (no secrets served)");
}

async function testMissingManifestReturnsNotFound() {
  await withProjectRoot({}, async (projectRoot) => {
    const res = await get({ projectRoot });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
  });
  console.log("  ✓ missing manifest → found:false (200, not an error)");
}

async function testInvalidJsonReturnsNotFound() {
  await withProjectRoot({ "prime-silo.config.json": "{nope" }, async (projectRoot) => {
    const res = await get({ projectRoot });
    assert.equal(res.status, 200);
    assert.equal(res.body.found, false);
  });
  console.log("  ✓ invalid JSON → found:false");
}

async function testMissingModelBlockReturnsNotFound() {
  await withProjectRoot(
    { "prime-silo.config.json": JSON.stringify({ schema: "aamp.config/1" }) },
    async (projectRoot) => {
      const res = await get({ projectRoot });
      assert.equal(res.body.found, false);
    }
  );
  console.log("  ✓ manifest without model block → found:false");
}

async function testEmptyEndpointReturnsNotFound() {
  await withProjectRoot(
    { "prime-silo.config.json": manifest({ endpoint: "", model: "qwen3.5-9b-FLM" }) },
    async (projectRoot) => {
      const res = await get({ projectRoot });
      assert.equal(res.body.found, false);
    }
  );
  console.log("  ✓ empty endpoint → found:false");
}

async function testLocalModelHappyPath() {
  await withProjectRoot(
    {
      "prime-silo.config.json": manifest({
        mode: "local",
        endpoint: "http://localhost:13305/api/v1/chat/completions",
        model: "qwen3.5-9b-FLM",
        local_optimizations: { minimal_system_prompt: true, enable_thinking: false }
      })
    },
    async (projectRoot) => {
      const res = await get({ projectRoot });
      assert.equal(res.status, 200);
      assert.equal(res.body.found, true);
      assert.equal(res.body.schema, "aamp.config/1");
      assert.deepEqual(res.body.model, {
        endpoint: "http://localhost:13305/api/v1/chat/completions",
        model: "qwen3.5-9b-FLM",
        mode: "local"
      });
      assert.equal(res.headers["Cache-Control"], "no-store");
    }
  );
  console.log("  ✓ local model manifest → sanitized model block");
}

async function testCloudModelKeepsEnvVarNameOnly() {
  await withProjectRoot(
    {
      "prime-silo.config.json": manifest({
        mode: "cloud",
        endpoint: "https://openrouter.ai/api/v1/chat/completions",
        model: "anthropic/claude-sonnet-4.6",
        api_key_env_var: "OPENROUTER_API_KEY",
        api_key: "sk-this-should-never-be-here-but-must-not-leak"
      })
    },
    async (projectRoot) => {
      const res = await get({ projectRoot });
      assert.equal(res.body.found, true);
      assert.equal(res.body.model.mode, "cloud");
      assert.equal(res.body.model.api_key_env_var, "OPENROUTER_API_KEY");
      // Whitelist: anything that even smells like a secret is dropped.
      const serialized = JSON.stringify(res.body);
      assert.ok(!serialized.includes("sk-this-should-never"), "secret-looking field leaked");
      assert.equal(res.body.model.api_key, undefined);
    }
  );
  console.log("  ✓ cloud manifest → env var NAME forwarded, secret-shaped fields dropped");
}

async function main() {
  await testAnonymousAllowed();
  await testMissingManifestReturnsNotFound();
  await testInvalidJsonReturnsNotFound();
  await testMissingModelBlockReturnsNotFound();
  await testEmptyEndpointReturnsNotFound();
  await testLocalModelHappyPath();
  await testCloudModelKeepsEnvVarNameOnly();
  console.log("config_defaults_api_test: ok");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
