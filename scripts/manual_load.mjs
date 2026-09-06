#!/usr/bin/env node
// Load the operating manual into the agent's memory — graph facts and retrievable chunks.
//
// manual_build.mjs produces the artefacts; this puts them where Benny can reach them, so
// "how do I onboard an application?" is answered from the manual rather than from whatever
// the model happens to believe about a product it was never trained on.
//
// Two stores, two shapes, one source:
//   the knowledge graph gets triples  — traversable: what is on the Gov arc, what precedes
//                                       step 3, what enforces this invariant
//   retrieval gets chunks             — one self-contained paragraph per feature and per
//                                       workflow step, because a chunk that only makes sense
//                                       beside its neighbour retrieves badly
//
// The rule that keeps this honest is the same one the estate uses everywhere else:
//
//   A LOAD THAT DID NOT HAPPEN IS REPORTED, NEVER ASSUMED.
//
// If Benny is not serving, this says so and exits non-zero. It does not "queue" the load or
// print a hopeful success — an agent confidently answering from a manual it never received is
// worse than one that says it does not know.
//
// Usage:
//   node scripts/manual_load.mjs [--base http://127.0.0.1:8005] [--workspace default]
//                                [--dry-run] [--quiet]
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const has = (n) => argv.includes(`--${n}`);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};

const BASE = arg("base", process.env.BENNY_API_BASE || "http://127.0.0.1:8005");
// Benny mounts its routers under /api — confirmed against the live openapi.json rather than
// guessed, because a 404 here looks exactly like "the manual loaded fine" to a careless reader.
const API = `${BASE.replace(/\/$/, "")}/api`;
const WORKSPACE = arg("workspace", process.env.LONGVIEW_WORKSPACE || "default");
const KEY = process.env.BENNY_API_KEY || "";
const say = (...m) => {
  if (!has("quiet")) console.log(...m);
};

const triplesFile = path.join(repo, "manual", "manual.triples.json");
const ragFile = path.join(repo, "manual", "manual.rag.jsonl");
for (const f of [triplesFile, ragFile])
  if (!fs.existsSync(f)) {
    console.error(`missing ${path.relative(repo, f)} — run: node scripts/manual_build.mjs`);
    process.exit(2);
  }

const { triples } = JSON.parse(fs.readFileSync(triplesFile, "utf8"));
const chunks = fs
  .readFileSync(ragFile, "utf8")
  .split("\n")
  .filter(Boolean)
  .map((l) => JSON.parse(l));

// The graph's shape is Source -> Concept, so each manual entry becomes a Source hub and its
// facts radiate from it. Predicates are carried through verbatim: they are the vocabulary the
// manual already uses, and renaming them here would make the graph disagree with the page.
const asKnowledgeTriple = (t) => ({
  subject: t.s,
  subject_type: t.p === "IS_A" ? "Concept" : "Concept",
  predicate: t.p,
  object: t.o,
  object_type: "Concept",
  citation: "manual/manual.json",
  confidence: 1.0, // deterministic, not extracted — there is nothing to be unsure about
  section_title: "Prime-Silo Operating Manual",
  model_id: "none/deterministic",
  strategy: "safe"
});

say(`manual: ${chunks.length} chunks, ${triples.length} triples`);
say(`target: ${BASE} (workspace ${WORKSPACE})`);

if (has("dry-run")) {
  say(`\ndry run — nothing sent. First triple would be:`);
  say(JSON.stringify(asKnowledgeTriple(triples[0]), null, 2));
  process.exit(0);
}

const headers = { "Content-Type": "application/json" };
if (KEY) headers["X-Benny-API-Key"] = KEY;

async function reachable() {
  try {
    const r = await fetch(`${BASE}/docs`, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch {
    return false;
  }
}

if (!(await reachable())) {
  console.error(
    `Benny is not serving at ${BASE}.\n` +
      `  The manual was NOT loaded. Start Benny, then re-run — nothing has been queued, and\n` +
      `  the agent will keep answering without the manual until this succeeds.`
  );
  process.exit(1);
}

// Graph first: the triples are the skeleton the chunks hang from, and if only one of the two
// lands it should be the one that is traversable.
let graphOk = false;
try {
  const res = await fetch(`${API}/rag/graph-upsert`, {
    method: "POST",
    headers,
    body: JSON.stringify({
      workspace: WORKSPACE,
      source_file: "prime-silo-operating-manual",
      triples: triples.map(asKnowledgeTriple)
    })
  });
  const body = await res.json().catch(() => null);
  if (res.ok) {
    graphOk = true;
    say(
      `graph: ${body?.status ?? "ok"} — ${body?.nodes ?? "?"} nodes, ${body?.edges ?? "?"} edges ` +
        `from ${body?.triples ?? triples.length} triples`
    );
  } else {
    console.error(`graph upsert failed (HTTP ${res.status}): ${body?.detail ?? "no detail"}`);
  }
} catch (e) {
  console.error(`graph upsert failed: ${e.message}`);
}

// The document HIERARCHY (PIX-001 / ADR-002) — Benny's vectorless path. build_tree_from_markdown
// turns headings into a tree with no LLM, writes (:Document)-[:HAS_SECTION]->(:Section)… to
// Neo4j, and anchors everything to a node_id rather than a filename. manual.pageindex.md is
// emitted with heading levels that mirror manual.json exactly, so the tree Benny builds is the
// tree we meant — the structure is not inferred, it is transcribed.
//
// This is what gives the agent state awareness rather than just recall: the outline is a small
// map it reads first to decide which section to open, and the finest section is a single
// invariant.
//
// extract_triples is OFF deliberately. That step asks a model to invent triples from each leaf,
// and we already hold exact ones derived from the manifest. Letting it run would put a second,
// guessed account of the same facts into the same graph, and nothing downstream could tell
// which of the two to believe.
let indexOk = false;
const pxName = "PRIME-SILO-MANUAL-PAGEINDEX.md";
{
  const bh = (process.env.BENNY_HOME || "F:/benny-home/app").replace(/\\/g, "/");
  const di = path.join(bh, "workspaces", WORKSPACE, "data_in");
  if (fs.existsSync(di)) {
    fs.copyFileSync(path.join(repo, "manual", "manual.pageindex.md"), path.join(di, pxName));
    try {
      const res = await fetch(`${API}/rag/pageindex/ingest`, {
        method: "POST",
        headers,
        body: JSON.stringify({
          workspace: WORKSPACE,
          files: [pxName],
          use_llm_summaries: false, // deterministic first-sentence summaries; offline-reproducible
          write_graph: true,
          extract_triples: false // see above — we already have exact triples
        }),
        signal: AbortSignal.timeout(600000)
      });
      const body = await res.json().catch(() => null);
      if (res.ok) {
        indexOk = true;
        say(
          `hierarchy: ${body?.total_sections ?? "?"} sections written as ` +
            `(:Document)-[:HAS_SECTION]->(:Section) for ${body?.documents ?? "?"} document(s)`
        );
      } else {
        console.error(`pageindex ingest failed (HTTP ${res.status}): ${body?.detail ?? "?"}`);
      }
    } catch (e) {
      console.error(`pageindex ingest failed: ${e.message}`);
    }
  } else {
    console.error(`no data_in for workspace '${WORKSPACE}' — hierarchy NOT written`);
  }
}

// Retrieval. The ingest route takes files from the workspace's own data_in, not raw chunks,
// so the manual document is copied there and ingested by name. deep_synthesis is OFF on
// purpose: the triples above were derived deterministically from the manifest, and letting an
// LLM re-extract them would put a second, guessed account of the same facts in the same graph.
let ragOk = false;
const bennyHome = (process.env.BENNY_HOME || "F:/benny-home/app").replace(/\\/g, "/");
const dataIn = path.join(bennyHome, "workspaces", WORKSPACE, "data_in");
// The RETRIEVAL document, not the human one. OPERATING-MANUAL.md is written for a reader and
// its headings become their own useless chunks when a splitter meets it; manual.rag.md carries
// the same facts as self-contained paragraphs, which is the unit we want returned.
const mdSource = path.join(repo, "manual", "manual.rag.md");
const docName = "PRIME-SILO-OPERATING-MANUAL.md";

if (!fs.existsSync(dataIn)) {
  console.error(
    `no data_in for workspace '${WORKSPACE}' at ${dataIn} — chunks NOT ingested.
` + `  Pass --workspace <name> matching a real workspace, or set BENNY_HOME.`
  );
} else {
  fs.copyFileSync(mdSource, path.join(dataIn, docName));
  try {
    const res = await fetch(`${API}/rag/ingest`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        workspace: WORKSPACE,
        files: [docName],
        deep_synthesis: false,
        use_docling: false,
        force_reingest: true
      }),
      // Embedding a document is minutes of work, not seconds, and Benny serves it on the
      // request thread — the whole API stops answering while it runs. Twenty minutes is the
      // wait, not an expectation.
      signal: AbortSignal.timeout(Number(arg("timeout-ms", "1200000")))
    });
    const body = await res.json().catch(() => null);
    if (res.ok) {
      ragOk = true;
      say(`retrieval: ingested ${docName} — ${JSON.stringify(body).slice(0, 160)}`);
    } else {
      console.error(`ingest failed (HTTP ${res.status}): ${body?.detail ?? "no detail"}`);
    }
  } catch (e) {
    // A client timeout is NOT a server failure: the ingest goes on running and may well
    // succeed after we stop listening. Reporting "failed" here would be the same lie in the
    // other direction — claiming something did not happen when we simply stopped watching.
    const gaveUp = /abort|timeout/i.test(e.message);
    console.error(
      gaveUp
        ? `stopped waiting for the ingest after ${arg("timeout-ms", "1200000")}ms — it is probably\n` +
            `  STILL RUNNING on the server (Benny blocks while embedding). This run cannot confirm\n` +
            `  it either way; re-run once /api/rag/query answers, and believe that rather than this.`
        : `ingest failed: ${e.message}`
    );
  }
}
say(
  `chunks: ${chunks.length} also written to manual/manual.rag.jsonl (stable ids: ${chunks[0].id} …)`
);

// Both halves must land. An earlier version checked only the graph and printed "Loaded" while
// retrieval had failed on an unreachable embedding host — the exact thing this file's header
// forbids, committed by the file itself. Partial success is reported as partial.
// Both halves must land. Two earlier versions of this block each claimed success on a partial
// load — the first checked only the graph, the second reported the failure and then printed
// "Loaded" underneath it because switching process.exit to exitCode let execution fall through.
// The success line now lives in the else branch, where it cannot be reached by accident.
if (!graphOk || !ragOk || !indexOk) {
  console.error(
    `\nPARTLY LOADED — facts ${graphOk ? "ok" : "FAILED"}, ` +
      `hierarchy ${indexOk ? "ok" : "FAILED"}, retrieval ${ragOk ? "ok" : "FAILED"}.\n` +
      `  The agent can use what loaded and cannot use what did not. Do not assume it knows the\n` +
      `  manual until this reports all three.`
  );
  process.exitCode = 1;
} else {
  say(`\nLoaded. Ask Benny "how do I onboard an application?" and he answers from the manual.`);
}
