// GET /api/gov_proposals — the signing queue, folded from the governance ledger.
//
// Read side of SS1/23 Principle 2. Returns the proposals a human has yet to rule on, plus the
// ones already ruled on, plus the chain's integrity state.
//
// That last field is not decoration. A queue rendered from a ledger whose hash chain no longer
// verifies is showing you a story, not a record — so the surface is told, and the UI says so
// rather than presenting tampered rows as if they were evidence.
import { loadGovernance } from "../coordination/lib/governance.mjs";
import { governanceLogPath } from "../lib/estate_store.js";

export async function get() {
  const { file, root, source, exists } = governanceLogPath();
  const gov = loadGovernance(file);

  const shape = (p) => ({
    id: p.id,
    title: p.title ?? p.id,
    rationale: p.rationale ?? "",
    evidence: Array.isArray(p.evidence) ? p.evidence : [],
    domain: p.domain ?? "work",
    cost: p.cost ?? null,
    reversible: p.reversible ?? null,
    raised_at: p.raised_at ?? null,
    raised_by: p.raised_by ?? null,
    state: p.state,
    signature: p.signature ?? null
  });

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      // where the evidence came from — the operator can always check the source
      ledger: { file, root, source, exists },
      chain: { ok: gov.ok !== false, badLine: gov.badLine ?? null, reason: gov.reason ?? null },
      open: gov.open.map(shape),
      settled: [...gov.signed, ...gov.declined]
        .map(shape)
        .sort((a, b) => String(b.signature?.at || "").localeCompare(String(a.signature?.at || ""))),
      counts: {
        open: gov.open.length,
        signed: gov.signed.length,
        declined: gov.declined.length
      }
    }
  };
}
