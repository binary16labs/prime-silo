// Evidence pack (SS1/23) — what ran, who authorised it, and what we cannot yet prove.
// Spec: architecture/SPEC-knowledge-eventlog.md · governance.mjs · artifacts.mjs · heartbeat.mjs
//
// Everything else in the coordination layer produces evidence. This is the thing that hands
// it over: one pack, generated from the logs on disk, that a reviewer can read without a
// tour of the codebase.
//
// The design decision that matters is the one about honesty. Of the four closure defects in
// the traceability matrix, two are computable from the ledgers today (unauthorised runs,
// broken chains) and two are not (orphan artifacts, unrecorded actions) — because nothing
// yet enumerates the deliverables or the state changes to compare against. A pack that
// quietly omitted the unmeasured pair would report a clean bill of health that means far
// less than it appears to, which is precisely the failure mode an audit exists to catch.
//
// So the pack reports three states per defect — clean, defects found, or NOT MEASURABLE —
// and never lets the third masquerade as the first. An honest gap is evidence; a hidden one
// is a liability.
import fs from "node:fs";
import path from "node:path";
import { readKelEvents } from "./kel.mjs";
import { buildGovernance, isAuthorised, GOVERNANCE_TYPES } from "./governance.mjs";
import { buildArtifacts, duplicateSpend, transferAvoided, ARTIFACT_TYPES } from "./artifacts.mjs";
import { buildHealth, outages, HEARTBEAT_TYPES } from "./heartbeat.mjs";

// Read every ledger under a root and verify each chain SEPARATELY. Chains are per-file, so
// one broken log must not invalidate — or be hidden by — the others.
export function collectLedgers(root, { dirs = ["eventlog", "collected"] } = {}) {
  const ledgers = [];
  for (const d of dirs) {
    const dir = path.join(root, d);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith(".jsonl"))) {
      const full = path.join(dir, file);
      const { ok, events, badLine, reason } = readKelEvents(full);
      ledgers.push({
        file: path.join(d, file),
        name: file.replace(/\.jsonl$/, ""),
        ok,
        badLine: badLine ?? null,
        reason: reason ?? null,
        events: events || []
      });
    }
  }
  return ledgers;
}

const MEASURABLE = "measured";
const UNMEASURABLE = "not measurable";

export function buildEvidencePack(ledgers = [], { now = new Date(), runs = null } = {}) {
  const all = ledgers.flatMap((l) => (l.ok ? l.events : []));
  const byType = all.reduce((acc, e) => ((acc[e.type] = (acc[e.type] || 0) + 1), acc), {});

  const gov = buildGovernance(all);
  const artifacts = buildArtifacts(all.filter((e) => String(e.type || "").startsWith("artifact_")));
  const health = buildHealth(all);

  // --- defect 1: unauthorised runs -------------------------------------------------
  // Computable only against a list of runs. Without one we can still report the weaker
  // but still useful fact: how many proposals executed without a human signature.
  const unauthorised = runs
    ? runs.filter((r) => !r.proposal_id || !isAuthorised(all, r.proposal_id))
    : null;

  // --- defect 4: broken chains -----------------------------------------------------
  const broken = ledgers
    .filter((l) => !l.ok)
    .map((l) => ({ file: l.file, badLine: l.badLine, reason: l.reason }));

  const defects = [
    {
      id: "unauthorised-run",
      principle: "2 · governance",
      state: runs ? MEASURABLE : UNMEASURABLE,
      count: runs ? unauthorised.length : null,
      note: runs
        ? unauthorised.map((r) => r.run_id).join(", ") || "every run traces to a human signature"
        : "no run inventory supplied — pass { runs } to measure. Proposals signed: " +
          `${gov.signed.length} of ${gov.proposals.length}`
    },
    {
      id: "orphan-artifact",
      principle: "3 · development & use",
      state: UNMEASURABLE,
      count: null,
      note: "nothing yet enumerates deliverables to compare against the producing runs"
    },
    {
      id: "unrecorded-action",
      principle: "3 · development & use",
      state: UNMEASURABLE,
      count: null,
      note: "state changes outside the ledger cannot be counted from inside it; needs an external inventory"
    },
    {
      id: "broken-chain",
      principle: "5 · risk mitigants",
      state: MEASURABLE,
      count: broken.length,
      note: broken.length
        ? broken.map((b) => `${b.file}@${b.badLine}`).join(", ")
        : "every chain verifies"
    }
  ];

  return {
    generated_at: now.toISOString(),
    ledgers: ledgers.map((l) => ({
      file: l.file,
      ok: l.ok,
      badLine: l.badLine,
      events: l.events.length
    })),
    totals: { events: all.length, by_type: byType, ledgers: ledgers.length },
    governance: {
      proposals: gov.proposals.length,
      signed: gov.signed.length,
      declined: gov.declined.length,
      open: gov.open.length,
      signatures: gov.signed.map((p) => ({
        id: p.id,
        title: p.title,
        signer: p.signature?.signer ?? null,
        at: p.signature?.at ?? null
      }))
    },
    artifacts: {
      distinct: artifacts.length,
      verified: artifacts.filter((a) => a.verified).length,
      placements: artifacts.reduce((n, a) => n + a.placements.length, 0),
      transfer_avoided_bytes: transferAvoided(all).bytes,
      duplicate_spend_bytes: duplicateSpend(all).bytes
    },
    estate: {
      services: health.filter((h) => h.service).length,
      outages: outages(all, { now }).map((o) => ({ key: o.key, since: o.since, downMs: o.downMs }))
    },
    defects,
    // The headline a reviewer reads first, and the one place the honesty rule bites: a pack
    // with unmeasured defects is NOT clean, however green the measured ones look.
    verdict: {
      measured_clean: defects.filter((d) => d.state === MEASURABLE).every((d) => d.count === 0),
      unmeasured: defects.filter((d) => d.state === UNMEASURABLE).length,
      complete: defects.every((d) => d.state === MEASURABLE && d.count === 0)
    }
  };
}

const KB = (n) => `${(Number(n || 0) / 1048576).toFixed(1)} MB`;

export function renderPack(pack) {
  const L = [];
  L.push(`# Estate evidence pack`);
  L.push(``);
  L.push(
    `Generated ${pack.generated_at} · ${pack.totals.events} events across ${pack.totals.ledgers} ledgers`
  );
  L.push(``);
  L.push(`## Verdict`);
  L.push(``);
  if (pack.verdict.complete) {
    L.push(`**Complete.** Every closure defect is measured and zero.`);
  } else if (pack.verdict.measured_clean) {
    L.push(
      `**Clean on what is measured; ${pack.verdict.unmeasured} of 4 defects are NOT YET MEASURABLE.** ` +
        `This pack does not claim completeness — see the gaps below.`
    );
  } else {
    L.push(`**Defects found.** See the table below.`);
  }
  L.push(``);
  L.push(`## Closure defects`);
  L.push(``);
  L.push(`| Defect | SS1/23 | State | Count | Note |`);
  L.push(`| --- | --- | --- | --- | --- |`);
  for (const d of pack.defects) {
    L.push(`| ${d.id} | ${d.principle} | ${d.state} | ${d.count ?? "—"} | ${d.note} |`);
  }
  L.push(``);
  L.push(`## Chain integrity`);
  L.push(``);
  for (const l of pack.ledgers) {
    L.push(
      `- \`${l.file}\` — ${l.ok ? "verifies" : `**BROKEN at line ${l.badLine}**`} · ${l.events} events`
    );
  }
  L.push(``);
  L.push(`## Authorisation (Principle 2)`);
  L.push(``);
  L.push(
    `${pack.governance.signed} signed · ${pack.governance.declined} declined · ${pack.governance.open} open ` +
      `(of ${pack.governance.proposals} proposals)`
  );
  if (pack.governance.signatures.length) {
    L.push(``);
    for (const s of pack.governance.signatures)
      L.push(`- **${s.title || s.id}** — signed by ${s.signer} at ${s.at}`);
  }
  L.push(``);
  L.push(`## Artifacts`);
  L.push(``);
  L.push(
    `${pack.artifacts.distinct} distinct · ${pack.artifacts.verified} verified · ${pack.artifacts.placements} placements · ` +
      `transfer avoided ${KB(pack.artifacts.transfer_avoided_bytes)} · duplicate spend ${KB(pack.artifacts.duplicate_spend_bytes)}`
  );
  L.push(``);
  L.push(`## Estate health`);
  L.push(``);
  L.push(
    pack.estate.outages.length === 0
      ? `${pack.estate.services} services tracked · no outages`
      : `${pack.estate.services} services tracked · OUTAGES: ` +
          pack.estate.outages.map((o) => `${o.key} since ${o.since}`).join(", ")
  );
  L.push(``);
  L.push(`## Event census`);
  L.push(``);
  for (const [t, n] of Object.entries(pack.totals.by_type).sort((a, b) => b[1] - a[1]))
    L.push(`- ${t}: ${n}`);
  L.push(``);
  return L.join("\n");
}

export const EVIDENCE_TYPES = Object.freeze({
  ...GOVERNANCE_TYPES,
  ...ARTIFACT_TYPES,
  ...HEARTBEAT_TYPES
});
