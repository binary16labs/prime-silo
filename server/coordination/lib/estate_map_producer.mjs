// The estate map's producer (S17): a node sweeps its own volumes, and its latest finished sweep
// becomes a push. Before this, runSweep had no caller in the product — S0 built the sweep, S1 the
// collectors, S3 the wire and S4 the panel, and the panel said "No node has pushed a map yet"
// because nothing ever did.
//
// ONE READER of the node's map database, used by the hub for its own sweeps and by the satellite
// agent for its pushes, so the two cannot read it two different ways.
import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { openMap, publishSweep, runSweep } from "./estate_map.mjs";
import { fileCollectors } from "./estate_map_files.mjs";
import { buildMapPayload } from "./estate_map_fold.mjs";

export const mapDbPath = (home, machine) => path.join(home, "estate", `estate-map-${machine}.db`);

// The latest FINISHED sweep in the node's database, as the payload the wire carries — or null. An
// unreadable index sends no map; it never sends a guessed one.
export function latestLocalPush(dbPath) {
  if (!fs.existsSync(dbPath)) return null;
  let conn = null;
  try {
    conn = new DatabaseSync(dbPath, { readOnly: true });
    const sweep = conn
      .prepare(
        "SELECT id, machine, finished_at, scope, collectors, counts, digest, snapshot FROM sweeps" +
          " WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, id DESC LIMIT 1"
      )
      .get();
    if (!sweep) return null;
    const totals = conn
      .prepare(
        "SELECT kind, collector, volume, category, items, bytes FROM totals WHERE sweep_id = ?"
      )
      .all(sweep.id)
      .map((r) => ({ ...r }));
    const json = (v, d) => {
      try {
        return JSON.parse(v);
      } catch {
        return d;
      }
    };
    return buildMapPayload(
      {
        machine: sweep.machine,
        id: sweep.id,
        finishedAt: sweep.finished_at,
        scope: json(sweep.scope, []),
        collectors: json(sweep.collectors, []),
        counts: json(sweep.counts, {}),
        digest: sweep.digest
      },
      { snapshot: sweep.snapshot, totals }
    );
  } catch {
    return null;
  } finally {
    conn?.close();
  }
}

// The volumes this machine can be asked to sweep: every drive letter whose root exists (C to Z — A
// and B can stall on a floppy prompt), plus the roots the owner configures. Nothing is offered that
// the machine does not have, so a request cannot name a path of its choosing.
export function sweepRoots({ configured = [], exists = fs.existsSync, platform = process.platform } = {}) {
  const drives =
    platform === "win32"
      ? [..."CDEFGHIJKLMNOPQRSTUVWXYZ"].map((l) => `${l}:`).filter((r) => exists(`${r}\\`))
      : [];
  return [...new Set([...drives, ...configured.filter((r) => exists(r))])];
}

// ONE SWEEP AT A TIME PER DATABASE, across processes as well as within one: a clustered hub's
// workers and a satellite agent on the same machine all write the same file. The exclusion is a
// socket bound on a port derived from the database path, because a socket dies with its holder — the
// S15 lesson — so a killed sweep never leaves behind a lock that refuses the next one.
const lockPort = (dbPath) =>
  20000 +
  (crypto.createHash("sha256").update(`sweep:${path.resolve(dbPath).toLowerCase()}`).digest().readUInt16BE(0) %
    20000);
const bindLock = (port) =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once("error", () => resolve(null));
    s.listen(port, "127.0.0.1", () => resolve(s.unref()));
  });

// createSweeper — runs a sweep without holding up its caller, and says honestly what it is doing:
// running over which volumes since when, and how the last one ended. `onFinished(push)` receives the
// sweep as the wire would carry it and returns the hub's verdict, which is kept: a sweep the hub
// refused is reported as refused, never as a map the owner should expect to see.
export function createSweeper({
  dbPath,
  machine,
  quarantine,
  publicRoots = [],
  onFinished = () => ({ ok: true }),
  collectors = fileCollectors,
  now = Date.now
}) {
  let running = null;
  let last = null;
  return {
    status: () => ({ running, last }),
    async start(volumes) {
      if (running) return { started: false, since: running.since };
      running = { volumes: [...volumes], since: new Date(now()).toISOString() };
      const lock = await bindLock(lockPort(dbPath));
      if (!lock) {
        running = null;
        return { started: false, since: null }; // another process is sweeping this database
      }
      const mine = running;
      const done = (async () => {
        let db = null;
        try {
          db = openMap(dbPath);
          const sweep = await runSweep({
            db,
            machine,
            collectors: await collectors(mine.volumes),
            scope: mine.volumes,
            publicRoots,
            quarantine
          });
          // A map travels only with the content-addressed snapshot of its sweep (S0), so the sweep
          // is published beside its index: the snapshot into this node's CAS, an event into its own
          // map log. Everything a sweep writes stays under the node's estate directory.
          await publishSweep({ db, sweep, estateRoot: path.dirname(dbPath) });
          db.close();
          db = null;
          const verdict = onFinished(latestLocalPush(dbPath)) ?? { ok: false, reason: "no verdict" };
          last = {
            ok: verdict.ok === true,
            at: new Date(now()).toISOString(),
            volumes: mine.volumes,
            files: sweep.counts.files,
            reason: verdict.ok ? null : verdict.reason
          };
        } catch (e) {
          last = { ok: false, at: new Date(now()).toISOString(), volumes: mine.volumes, reason: String(e?.message || e) };
        } finally {
          db?.close();
          lock.close();
          running = null;
        }
      })();
      return { started: true, since: mine.since, done };
    }
  };
}
