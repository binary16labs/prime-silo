// Evidence pack (SS1/23) — what ran, who authorised it, and what we cannot yet prove.
// Spec: architecture/SPEC-knowledge-eventlog.md · governance.mjs · artifacts.mjs · heartbeat.mjs
//
// Everything else in the coordination layer produces evidence. This is the thing that hands
// it over: one pack, generated from the logs on disk, that a reviewer can read without a
// tour of the codebase.
//
// The design decision that matters is the one about honesty. A pack that quietly omitted what
// it could not measure would report a clean bill of health meaning far less than it appears
// to, which is precisely the failure mode an audit exists to catch. So the pack reports three
// states per defect — clean, defects found, or NOT MEASURABLE — and never lets the third
// masquerade as the first. An honest gap is evidence; a hidden one is a liability.
//
// Orphan artifacts and unrecorded actions were both NOT MEASURABLE until inventory.mjs, which
// looks at the disk and reconciles it against the ledger; pass { inventory } to measure them.
//
// That same rule then bites one level in. A gauge can be MEASURED, report zero, and still
// prove nothing — because its population was empty. Zero unauthorised runs out of zero runs
// in scope is not assurance, and it renders identically to zero out of two hundred unless the
// pack says otherwise. So every defect carries `population`, the verdict names any gauge with
// nothing under it, and only `substantiated` — measured, zero, AND non-empty everywhere — is
// an unqualified pass.
import fs from "node:fs";
import path from "node:path";
import { readKelEvents } from "./kel.mjs";
import { buildGovernance, isAuthorised, GOVERNANCE_TYPES } from "./governance.mjs";
import { buildArtifacts, duplicateSpend, transferAvoided, ARTIFACT_TYPES } from "./artifacts.mjs";
import { buildHealth, outages, HEARTBEAT_TYPES } from "./heartbeat.mjs";
import { governanceEpochFrom, partitionRuns } from "./runs.mjs";

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

export function buildEvidencePack(
  ledgers = [],
  { now = new Date(), runs = null, governanceEpoch = null, inventory = null } = {}
) {
  const all = ledgers.flatMap((l) => (l.ok ? l.events : []));
  const byType = all.reduce((acc, e) => ((acc[e.type] = (acc[e.type] || 0) + 1), acc), {});

  const gov = buildGovernance(all);
  const artifacts = buildArtifacts(all.filter((e) => String(e.type || "").startsWith("artifact_")));
  const health = buildHealth(all);

  // --- defect 1: unauthorised runs -------------------------------------------------
  // Measurable once a run inventory is supplied — but only fairly against the control's
  // effective date. Every run in this estate predates the governance layer, because signing
  // did not exist until it was built; failing a July run for lacking a September mechanism
  // would produce a wall of red that teaches an operator to ignore the gauge. So the epoch
  // splits the population, and BOTH halves are reported: pre-control runs are visible and
  // excluded from the defect, in-scope runs must carry a human signature.
  const epoch = governanceEpochFrom(all, governanceEpoch);
  const split = runs ? partitionRuns(runs, epoch) : null;
  const unauthorised = split
    ? split.inScope.filter((r) => !r.proposal_id || !isAuthorised(all, r.proposal_id))
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
      // How many things this gauge actually looked at. Zero defects out of zero candidates
      // is not a pass — it is a gauge with nothing under it, and it must not read the same
      // as a gauge that examined a hundred and found them all clean.
      population: runs ? split.inScope.length : null,
      note: runs
        ? `${split.inScope.length} in scope since ${epoch || "n/a"}, ` +
          `${split.preControl.length} pre-control (excluded, not defects)` +
          (unauthorised.length
            ? ` — unauthorised: ${unauthorised.map((r) => r.run_id).join(", ")}`
            : " — all in-scope runs carry a human signature")
        : "no run inventory supplied — pass { runs } to measure. Proposals signed: " +
          `${gov.signed.length} of ${gov.proposals.length}`
    },
    // --- defects 2 and 3: measurable only against an inventory sweep ------------------
    // Both need a look at the world, and both are reported WITH the boundary that look
    // reached. A count of zero from a sweep that walked two directories is a true statement
    // about two directories and nothing else, so the scope travels into the note rather than
    // being dropped once the number looks good.
    {
      id: "orphan-artifact",
      principle: "3 · development & use",
      state: inventory ? MEASURABLE : UNMEASURABLE,
      count: inventory ? inventory.orphans.count : null,
      population: inventory ? inventory.counts.blobs_held + inventory.counts.files_seen : null,
      note: inventory
        ? `${inventory.orphans.count} unaccounted object(s) (${KB(inventory.orphans.bytes)}) ` +
          `within ${inventory.scope.walked.length} swept root(s): ${inventory.scope.walked.join(", ")}`
        : "nothing yet enumerates deliverables to compare against the producing runs — run scripts/inventory_sweep.mjs"
    },
    {
      id: "unrecorded-action",
      principle: "3 · development & use",
      state: inventory ? MEASURABLE : UNMEASURABLE,
      count: inventory ? inventory.unrecorded.count : null,
      population: inventory ? inventory.counts.placements_in_scope : null,
      note: inventory
        ? `${inventory.unrecorded.count} ledger claim(s) the disk contradicts` +
          // Unseen placements are neither present nor missing. Reporting the count beside a
          // clean result is what stops "0" reading as "the whole estate is accounted for".
          (inventory.unseen.length
            ? ` — ${inventory.unseen.length} further placement(s) were out of this sweep's reach and are NOT included`
            : " — every claimed placement was reachable")
        : "state changes outside the ledger cannot be counted from inside it; needs an external inventory"
    },
    {
      id: "broken-chain",
      principle: "5 · risk mitigants",
      state: MEASURABLE,
      count: broken.length,
      population: ledgers.length,
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
    control: {
      governance_epoch: epoch,
      runs_total: runs ? runs.length : null,
      runs_in_scope: split ? split.inScope.length : null,
      runs_pre_control: split ? split.preControl.length : null,
      runs_undated: split ? split.undated.length : null
    },
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
    inventory: inventory
      ? {
          swept_at: inventory.swept_at,
          scope: inventory.scope.walked,
          counts: inventory.counts,
          orphans: inventory.orphans.count,
          orphan_bytes: inventory.orphans.bytes,
          unrecorded: inventory.unrecorded.count,
          unseen: inventory.unseen.length
        }
      : null,
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
      // A gauge that examined nothing reports zero defects and looks identical to one that
      // examined a hundred and found them all clean. Counting those separately is the same
      // rule as NOT MEASURABLE, applied one level in: "we looked and found nothing wrong" and
      // "there was nothing to look at" are different claims, and only the first is assurance.
      vacuous: defects.filter((d) => d.state === MEASURABLE && d.population === 0).map((d) => d.id),
      complete: defects.every((d) => d.state === MEASURABLE && d.count === 0),
      // The only unqualified pass: everything measured, everything zero, and every gauge had
      // something under it.
      substantiated: defects.every(
        (d) => d.state === MEASURABLE && d.count === 0 && d.population > 0
      )
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
  if (pack.verdict.substantiated) {
    L.push(`**Complete.** Every closure defect is measured, zero, and had something to measure.`);
  } else if (pack.verdict.complete) {
    // Measured and zero, but at least one gauge had an empty population. Saying "complete"
    // here would let "nothing to check" pass for "checked and clean".
    L.push(
      `**Measured and zero — but ${pack.verdict.vacuous.length} of ${pack.defects.length} ` +
        `gauge(s) had nothing to measure: ${pack.verdict.vacuous.join(", ")}.** ` +
        `Those report clean because their population is empty, not because anything was ` +
        `examined and passed. This is not yet an assurance.`
    );
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
  L.push(`| Defect | SS1/23 | State | Count | Of | Note |`);
  L.push(`| --- | --- | --- | --- | --- | --- |`);
  for (const d of pack.defects) {
    // "Of" is the population. A count without it cannot be read: 0 of 0 and 0 of 200 are the
    // same digit and utterly different assurances.
    L.push(
      `| ${d.id} | ${d.principle} | ${d.state} | ${d.count ?? "—"} | ` +
        `${d.population ?? "—"}${d.population === 0 ? " ⚠ nothing to measure" : ""} | ${d.note} |`
    );
  }
  L.push(``);
  if (pack.control?.governance_epoch || pack.control?.runs_total != null) {
    L.push(`## Control scope`);
    L.push(``);
    L.push(
      `Governance came into force at **${pack.control.governance_epoch || "not yet — no proposals recorded"}**.`
    );
    if (pack.control.runs_total != null) {
      L.push(``);
      L.push(
        `${pack.control.runs_total} runs known · **${pack.control.runs_in_scope} in scope** · ` +
          `${pack.control.runs_pre_control} pre-control` +
          (pack.control.runs_undated
            ? ` · ${pack.control.runs_undated} undated (treated as in scope)`
            : "")
      );
      L.push(``);
      L.push(
        `Pre-control runs are reported, not failed: a run cannot be signed by a mechanism that ` +
          `did not exist when it executed. They are excluded from the defect count and shown here so ` +
          `the exclusion is visible rather than silent.`
      );
    }
    L.push(``);
  }
  // The sweep's boundary is printed before its findings, because a count without its scope is
  // the exact overclaim this pack exists to avoid.
  if (pack.inventory) {
    L.push(`## Inventory sweep`);
    L.push(``);
    L.push(`Swept ${pack.inventory.swept_at} across:`);
    for (const r of pack.inventory.scope) L.push(`- \`${r}\``);
    L.push(``);
    L.push(
      `${pack.inventory.counts.blobs_held} blobs · ${pack.inventory.counts.files_seen} files · ` +
        `${pack.inventory.counts.placements_claimed} placements claimed ` +
        `(${pack.inventory.counts.placements_in_scope} reconciled, ${pack.inventory.counts.placements_unseen} out of reach)`
    );
    L.push(``);
    L.push(
      pack.inventory.unseen
        ? `**${pack.inventory.unseen} placement(s) lie outside this sweep.** They are neither ` +
            `present nor missing — nothing here counts them either way. Sweep those nodes, or ` +
            `pass --include, before reading the two figures above as estate-wide.`
        : `Every claimed placement was reachable from this sweep, so the two defects above are ` +
            `measured against the full set of claims the ledger makes.`
    );
    L.push(``);
  }
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
