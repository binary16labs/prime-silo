// GET /api/lineage_index — every subject in the estate, and how much of it is provable.
//
// Read side of SS1/23 Principle 1 (lineage). The response deliberately leads with coverage
// rather than rows: a list of subjects invites the reader to assume it is the whole estate,
// and it is not — it is everything that happened to be written down.
//
// `ledger.exists` is carried for the same reason the Gov queue carries it. An absent store
// folds to zero subjects, and "0 subjects, 0 broken chains" would render as a perfect score
// for a system that is not recording anything at all.
import fs from "node:fs";
import path from "node:path";
import { buildLineage, lineageCoverage, lineageIndex } from "../coordination/lib/lineage.mjs";
import { collectLedgers } from "../coordination/lib/evidence.mjs";
import { resolveEstateStore } from "../lib/estate_store.js";

export async function get() {
  const { root, source } = resolveEstateStore();
  const exists = fs.existsSync(path.join(root, "eventlog"));

  const ledgers = collectLedgers(root);
  const index = buildLineage(ledgers);

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      store: { root, source, exists },
      // one row per ledger, each verified on its own chain
      ledgers: ledgers.map((l) => ({
        name: l.name,
        file: l.file,
        ok: l.ok,
        badLine: l.badLine,
        reason: l.reason,
        events: l.events.length
      })),
      coverage: lineageCoverage(index, ledgers),
      dangling: index.dangling,
      subjects: lineageIndex(index)
    }
  };
}
