#!/usr/bin/env node
// Generate the estate evidence pack.
//
// Reads every ledger under the store, verifies each chain, and writes a pack a reviewer can
// read without a tour of the codebase. Exit code is the headline: 0 only when every closure
// defect is both MEASURED and zero — an unmeasured defect is not a pass.
//
// Usage:
//   node scripts/evidence_pack.mjs --root F:/estate-store [--out F:/estate-store/evidence.md] [--json]
import fs from "node:fs";
import path from "node:path";
import {
  collectLedgers,
  buildEvidencePack,
  renderPack
} from "../server/coordination/lib/evidence.mjs";
import { collectRuns } from "../server/coordination/lib/runs.mjs";

const argv = process.argv.slice(2);
const arg = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

const ROOT = arg("root", process.env.ESTATE_STORE || "F:/estate-store");
const OUT = arg("out", path.join(ROOT, "evidence-pack.md"));

const ledgers = collectLedgers(ROOT);
if (ledgers.length === 0) {
  console.error(`no ledgers found under ${ROOT} — is the root correct?`);
  process.exit(2);
}

// The run inventory is what turns "unauthorised runs" from an assertion into a count. Both
// sources are execution evidence that already exists on disk; --no-runs falls back to the
// unmeasured state rather than pretending an empty list means zero runs.
const repo = path.resolve(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
const runs = argv.includes("--no-runs")
  ? null
  : collectRuns({
      runRecordsDir: arg("runs-dir", path.join(repo, "runtime", "workspace", "manifests", "runs")),
      openLineagePath: arg(
        "lineage",
        path.join(repo, "scratch", "longview_run", "dashboard", "openlineage.json")
      )
    });

const pack = buildEvidencePack(ledgers, { runs, governanceEpoch: arg("epoch", null) });

if (argv.includes("--json")) {
  console.log(JSON.stringify(pack, null, 2));
} else {
  const md = renderPack(pack);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, md);
  console.log(md);
  console.log(`\nwritten to ${OUT}`);
}

process.exit(pack.verdict.complete ? 0 : 1);
