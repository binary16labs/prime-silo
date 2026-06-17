#!/usr/bin/env node
//
// Self-awareness bundle generator test.
//
// Runs the build-self-awareness generator against the real project tree into a
// throwaway output dir and asserts the shipped bundle shape: a manifest, a
// static code-graph whose stats match its node list, a skills index, and
// non-empty source/skill/graph counts. This is what makes Benny boot
// self-aware, so a regression here means the desktop package ships blind.

import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..");

const mod = await import("../packaging/scripts/build-self-awareness.js");
const { buildSelfAwarenessBundle } = mod.default || mod;

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "ps-self-aware-"));
try {
  const { bundle } = buildSelfAwarenessBundle({ projectRoot, outDir });

  assert.ok(fs.existsSync(path.join(outDir, "bundle.json")), "bundle.json should exist");
  assert.ok(fs.existsSync(path.join(outDir, "code-graph.json")), "code-graph.json should exist");
  assert.ok(fs.existsSync(path.join(outDir, "skills", "skills-index.json")), "skills-index.json should exist");
  assert.ok(fs.existsSync(path.join(outDir, "source")), "source snapshot should exist");

  assert.equal(bundle.schema, "prime-silo.self-awareness/1");
  assert.equal(bundle.self_workspace, "prime_silo_self");
  assert.ok(bundle.counts.source_files > 0, "expected a non-empty source snapshot");
  assert.ok(bundle.counts.skills > 0, "expected skills to be harvested");
  assert.ok(bundle.counts.graph_nodes > 0, "expected a non-empty code graph");

  const graph = JSON.parse(fs.readFileSync(path.join(outDir, "code-graph.json"), "utf8"));
  assert.equal(graph.nodes.length, graph.stats.nodes, "graph stats should match node list");
  assert.equal(graph.edges.length, graph.stats.edges, "graph stats should match edge list");
  assert.ok(graph.nodes.some((n) => n.type === "File"), "graph should contain File nodes");
  assert.ok(graph.edges.some((e) => e.type === "CONTAINS"), "graph should contain CONTAINS edges");

  console.log("self_awareness_bundle_test: ok");
} finally {
  fs.rmSync(outDir, { recursive: true, force: true });
}
