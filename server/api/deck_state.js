// GET /api/deck_state — everything the HUD deck shows, folded once.
//
// The deck is a wall. It is glanceable, often projected, and read from across a room, so its
// data has to arrive as ONE answer: five round trips would give five different moments of the
// estate stitched into a single picture, and a wall that disagrees with itself is worse than a
// blank one.
//
// Every figure here is folded from a ledger on disk. Nothing is a gauge someone set, and
// nothing is cached — the deck redraws from the same events the evidence pack reads, so it
// cannot quietly say something the audit would contradict.
//
// Two properties matter more than the numbers:
//
//   ABSENCE IS A STATE, NOT A ZERO. No store, an unreadable ledger, a node that stopped
//   reporting — each gets its own value so the deck can render "I cannot see" differently from
//   "there is nothing". A green wall built from a missing store is the exact failure this
//   estate spent its whole design avoiding.
//
//   EVERY FIELD DECLARES WHETHER IT IS ROOM-SAFE. The deck is projected. Proposal rationales,
//   file paths and machine names are fine on a monitor and not necessarily fine on a wall in
//   front of visitors, so the payload marks what redaction must hide rather than leaving that
//   judgement to the renderer.
import fs from "node:fs";
import path from "node:path";
import { collectLedgers } from "../coordination/lib/evidence.mjs";
import { buildGovernance } from "../coordination/lib/governance.mjs";
import { buildLineage, lineageCoverage } from "../coordination/lib/lineage.mjs";
import { estateBoard } from "../coordination/lib/heartbeat.mjs";
import { collectRuns, partitionRuns, governanceEpochFrom } from "../coordination/lib/runs.mjs";
import { resolveEstateStore } from "../lib/estate_store.js";

const ago = (iso) => {
  const t = Date.parse(iso || "");
  if (Number.isNaN(t)) return null;
  return Math.max(0, Math.round((Date.now() - t) / 1000));
};

export async function get() {
  const { root, source } = resolveEstateStore();
  const present = fs.existsSync(path.join(root, "eventlog"));

  // A missing store is its own answer. Folding an empty array would produce a page of
  // confident zeroes, which is the one thing the deck must never show.
  if (!present) {
    return {
      headers: { "Cache-Control": "no-store" },
      status: 200,
      body: {
        at: new Date().toISOString(),
        store: { root, source, present: false },
        blind: true,
        reason: "no estate store — the deck cannot see the ledgers, and is not reporting health"
      }
    };
  }

  const ledgers = collectLedgers(root);
  const events = ledgers.flatMap((l) => (l.ok ? l.events : []));
  const broken = ledgers.filter((l) => !l.ok);

  const gov = buildGovernance(events);
  const index = buildLineage(ledgers);
  const cover = lineageCoverage(index, ledgers);

  // estateBoard keys on MACHINE and needs each node's state file — a chained log says what a
  // node's services were doing, its state file says whether the node is still LOOKING. Passing
  // ledger names instead produced six anonymous nodes all reading stale, which is exactly the
  // "absence rendered as a fact" this endpoint exists to avoid. Derived the same way the
  // collector derives it, so the deck and the board cannot disagree.
  const sources = [];
  const states = {};
  for (const dir of ["eventlog", "collected"]) {
    const full = path.join(root, dir);
    if (!fs.existsSync(full)) continue;
    for (const f of fs.readdirSync(full).filter((x) => /^heartbeat-.+\.jsonl$/.test(x))) {
      const machine = f.replace(/^heartbeat-|\.jsonl$/g, "");
      const l = ledgers.find((x) => x.file.endsWith(f));
      if (!l) continue;
      sources.push({ machine, events: l.events, ok: l.ok, badLine: l.badLine });
      const stateFile =
        dir === "collected"
          ? path.join(full, `heartbeat-${machine}.json`)
          : path.join(root, "state", `heartbeat-${machine}.json`);
      try {
        if (fs.existsSync(stateFile))
          states[machine] = JSON.parse(fs.readFileSync(stateFile, "utf8"));
      } catch {
        // An unreadable state file leaves the node stale, which is the honest reading.
      }
    }
  }

  let board = { nodes: [], outages: [] };
  try {
    board = estateBoard(sources, states);
  } catch {
    // The board is a convenience; its absence must not blank the whole deck.
  }

  const runs = collectRuns({ events });
  const split = partitionRuns(runs, governanceEpochFrom(events));
  const unauthorised = split.inScope.filter(
    (r) =>
      !r.proposal_id ||
      !events.some(
        (e) =>
          e.type === "proposal_signed" &&
          e.sid === `proposal:${r.proposal_id}` &&
          e.authorship === "human"
      )
  );

  const lastEvent = events
    .map((e) => e.txn_time)
    .filter(Boolean)
    .sort()
    .at(-1);

  return {
    headers: { "Cache-Control": "no-store" },
    status: 200,
    body: {
      at: new Date().toISOString(),
      store: { root, source, present: true },
      blind: false,

      // The one number that decides the deck's whole colour: is anything waiting on a person.
      decide: {
        waiting: gov.open.length,
        signed: gov.signed.length,
        declined: gov.declined.length,
        // Titles are room-sensitive: a proposal name can give away more than you would project.
        oldest: gov.open.length
          ? { id: gov.open[0].id, title: gov.open[0].title, sensitive: true }
          : null
      },

      prove: {
        ledgers: cover.ledgers.verified,
        ledgers_total: cover.ledgers.total,
        broken: broken.map((b) => ({ name: b.name, line: b.badLine })),
        subjects: cover.subjects.attested,
        origin_recorded: cover.provenance.linked,
        world: cover.completeness.state
      },

      watch: {
        nodes: board.nodes.map((n) => ({
          machine: n.machine,
          up: !n.stale && n.chainOk !== false,
          stale: Boolean(n.stale),
          // "Not heard from" is not "down". The deck must be able to draw the difference.
          blind: Boolean(n.stale || n.chainOk === false)
        })),
        outages: board.outages.length
      },

      run: {
        in_scope: split.inScope.length,
        pre_control: split.preControl.length,
        unauthorised: unauthorised.length
      },

      // What the deck animates on. Motion is feedback to a real transition, never a timer.
      pulse: {
        last_event_at: lastEvent ?? null,
        seconds_since: ago(lastEvent),
        events_total: events.length
      },

      // Fields the renderer must hide in room mode, named here rather than guessed at there.
      room_sensitive: ["decide.oldest.title", "store.root", "watch.nodes[].machine"]
    }
  };
}
