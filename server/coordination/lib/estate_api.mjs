// Estate HTTP API (EP-N / N2) — the N0 estate model served live over /api/estate/*,
// mounted by app.js AHEAD of the generic handler (like B1's coordination API) so its
// nested paths win, returning true when it owns the request and false to fall through.
// Reuses the N0 projection (buildEstate over the estate KEL log) and the B1 bus for SSE.
// Design: architecture/SOLUTION-estate.md §3.4.
import fs from "node:fs";
import { readKelEvents } from "./kel.mjs";
import { buildEstate } from "./estate.mjs";
import { proposeSync, applySync } from "./estate_govern.mjs";
import { planNextCycle, readPlanInputs } from "./estate_plan.mjs";
import { acceptMap, register as registerSatellite } from "./estate_register.mjs";
import { createSweeper, latestLocalPush } from "./estate_map_producer.mjs";
import { createComparer, listRoot, rootIdentity } from "./estate_compare.mjs";
import { everythingAdapter } from "./estate_map_files.mjs";
import { createLibrarian, finishedAtOf, libraryPathFor, windowsCloudOnly } from "./library.mjs";
import {
  openRegistry,
  registryPath,
  readRegistry,
  setOwnerName,
  addUserRoot,
  labelProblem,
  offeredRoots,
  forbiddenRoot
} from "./drive_registry.mjs";
import path from "node:path";
import {
  DEFAULT_MAP_MAX_AGE_MS,
  foldEstateMap,
  machineView,
  volumeNameProblem
} from "./estate_map_fold.mjs";

const PREFIX = "/api/estate";
const EMPTY = { machines: {}, drives: {}, sessions: {}, snapshots: {} };

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Content-Length": Buffer.byteLength(data)
  });
  res.end(data);
}

// Always-fresh: fold the estate KEL log on read (cheap; the log is small). Falls back to a
// prebuilt estate.jsonl, then to an empty model — the API never throws for a missing source.
function loadEstate({ kelLog, estateFile }) {
  try {
    if (kelLog && fs.existsSync(kelLog)) {
      const r = readKelEvents(kelLog);
      if (r.ok) return buildEstate(r.events);
    }
    if (estateFile && fs.existsSync(estateFile))
      return JSON.parse(fs.readFileSync(estateFile, "utf8"));
  } catch {
    /* fall through to empty — a governance surface must render, not 500 */
  }
  return { ...EMPTY };
}

function summarize(est) {
  return {
    machines: Object.keys(est.machines || {}).length,
    drives: Object.keys(est.drives || {}).length,
    sessions: Object.keys(est.sessions || {}).length,
    quarantined: Object.values(est.sessions || {}).filter((s) => s.quarantined).length
  };
}

// --- N3 tie-ins (pure, exported for direct unit tests) --------------------------

// Fold delivery/board/BOARD.md into a lane summary: per-column counts + the topmost
// READY items (what to work next). Column headers are "## READY|CLAIMED|VERIFY|DONE".
export function boardLanes(boardText = "") {
  const lanes = { READY: [], CLAIMED: [], VERIFY: [], DONE: [] };
  let section = null;
  for (const line of boardText.split(/\r?\n/)) {
    const h = line.match(/^##\s+(READY|CLAIMED|VERIFY|DONE)\b/);
    if (h) {
      section = h[1];
      continue;
    }
    if (h === null && /^##\s/.test(line)) {
      section = null;
      continue;
    } // left the tracked columns
    if (!section) continue;
    const m = line.match(/^-\s+([A-Z]\d+|M2-\d+)\s+—\s+([^·]+?)\s+·/);
    if (m) lanes[section].push({ id: m[1], title: m[2].trim() });
  }
  return {
    ready: { count: lanes.READY.length, top: lanes.READY.slice(0, 3) },
    claimed: { count: lanes.CLAIMED.length, items: lanes.CLAIMED },
    verify: { count: lanes.VERIFY.length },
    done: { count: lanes.DONE.length }
  };
}

// Drill-down payload for one machine. PRIVACY (R31): a quarantined session contributes
// ONLY to the count + a flag — never its sid, project, or any identifying content.
export function drillMachine(estate = {}, machine) {
  const sessions = [];
  let quarantined = 0;
  const timeline = [];
  for (const [hash, s] of Object.entries(estate.sessions || {})) {
    const onMachine = (s.drives || []).some((d) => String(d).split(":")[0] === machine);
    if (!onMachine) continue;
    if (s.quarantined) {
      quarantined++;
      continue;
    } // flag + count only; nothing identifying leaves
    sessions.push({ content_hash: hash, project: s.project ?? null });
    timeline.push({ kind: "session", ref: hash, project: s.project ?? null });
  }
  return { machine, sessions, quarantined, total: sessions.length + quarantined, timeline };
}

// LONGVIEW pipeline progress for the Dial — the REAL fractions from progress.json, or a
// null shape when there is no active run. Never fabricates a fraction.
export function longviewProgress(progressFile) {
  try {
    if (progressFile && fs.existsSync(progressFile)) {
      const p = JSON.parse(fs.readFileSync(progressFile, "utf8"));
      return { present: true, ...p };
    }
  } catch {
    /* unreadable/corrupt progress → treat as absent, never guess */
  }
  return { present: false, stages: null };
}

// Read + JSON-parse a POST body; resolves {} on empty/invalid (a governance route never 500s on shape).
// "Invalid" includes valid JSON that is not an object: a body of `null` used to resolve null, and
// the first property read on it threw inside the promise and took the whole hub down — through
// /register from the LAN, and through /sweep from any page a browser had open (claude-s17-verifier).
function readBody(req) {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      try {
        const b = raw ? JSON.parse(raw) : {};
        resolve(b !== null && typeof b === "object" && !Array.isArray(b) ? b : {});
      } catch {
        resolve({});
      }
    });
  });
}

export function createEstateApi({
  kelLog = null,
  estateFile = null,
  boardFile = null,
  longviewProgressFile = null,
  bus,
  syncSource = null,
  stagingRoot = null,
  datasetManifestFile = null,
  evalReportFile = null,
  statusFile = null,
  planThinRate = 0.25,
  registerKey = null,
  // NOT [] — a library that invents an empty policy is a guard that is never on. null means the
  // hub has not been told what is private, and a hub that has not been told refuses maps (W9).
  quarantine = null,
  mapMaxAgeMs = DEFAULT_MAP_MAX_AGE_MS,
  // S17: this machine's own map — { machine, dbPath, roots: () => [...], collectors? }, or null
  producer = null,
  prefix = PREFIX
} = {}) {
  // In-memory satellite reachability (last-seen + live drift), updated by POST /register (N7).
  // PER PROCESS: a clustered hub's workers each build their own (server/runtime/cluster.js passes
  // no estateApi), so under WORKERS>1 a push lands in one worker's map. True since S3; declared.
  let satelliteState = { satellites: {}, maps: [] };
  // The hub's own sweeps enter through acceptMap like any satellite's, so no policy means no map
  // here too. On boot the hub folds what it last swept, and re-hears it every five minutes for as
  // long as it runs — the in-process twin of the agent's heartbeat. That keeps it live only while its
  // LATEST sweep is accepted: if that one is refused, nothing is re-heard, and the last map that was
  // accepted goes stale thirty minutes on while the Sweep section says why the newer one was refused.
  const own = (push) => {
    if (!push) return { ok: false, reason: "this machine has not finished a sweep" };
    const r = acceptMap(satelliteState, push, { machine: producer.machine, quarantine });
    if (r.ok) satelliteState = r.state;
    return r;
  };
  const sweeper =
    producer &&
    createSweeper({
      dbPath: producer.dbPath,
      machine: producer.machine,
      quarantine,
      collectors: producer.collectors,
      onFinished: own
    });
  if (producer) {
    own(latestLocalPush(producer.dbPath));
    setInterval(() => own(latestLocalPush(producer.dbPath)), 5 * 60_000).unref();
  }
  // What this machine offers, split by whether the map could ever carry it: a root the volume rule or
  // the policy refuses is named with its reason, never offered as a button whose sweep would fail.
  const offered = () => {
    const roots = [];
    const unusable = [];
    for (const r of producer.roots()) {
      const reason = volumeNameProblem(r, Array.isArray(quarantine) ? quarantine : []);
      if (reason) unusable.push({ root: r, reason });
      else roots.push(r);
    }
    return { roots, unusable };
  };
  // S21: the librarian's catalogues live in the estate store, beside the drive they describe
  // (owner, 2026-10-10). The WHOLE store is skipped when the drive catalogued holds it — its event
  // logs and catalogues are not the owner's files (claude-s21-verifier: skipping only <store>/library
  // made 25 store files rows, and the source of every re-hash in a rescan).
  // S22 point 6: the store is a DECLARED PARAMETER, never a literal. A machine path shipped as a
  // default is wrong on every machine but one (the ASUS and the Pi have no F:), and raw process.env
  // bypassed Prime-Silo's precedence. app.js resolves it; unset is SAID, not guessed (point 7).
  const store = producer?.estateStore ?? "";
  // null, never "": the comparer below holds this and an empty string answers `librarian.lookup
  // is not a function` inside an uncaught promise, which took the hub PROCESS down on every install
  // where ESTATE_STORE is unset - the shipped state until the owner sets it (D3).
  // U1: WHERE CATALOGUES LIVE. User roots and internal drives in BENNY_HOME; a removable drive in the
  // store when it is set (S21), else on the machine (the ASUS). Lookups check both.
  const home = producer?.dbPath ? path.dirname(path.dirname(producer.dbPath)) : null;
  const homeLib = home ? path.join(home, "estate", "library") : null;
  const storeLib = store ? path.join(store, "library") : null;
  const cloudProbe =
    producer && "cloudOnly" in producer
      ? producer.cloudOnly
      : process.platform === "win32"
        ? windowsCloudOnly
        : null;
  const librarian =
    producer && (storeLib || homeLib)
      ? createLibrarian({
          dir: storeLib ?? homeLib,
          also: storeLib && homeLib ? [homeLib] : [],
          placeFor: (root) => {
            const e = entryOf(root);
            return storeLib && !(e && (e.kind === "user" || !e.removable)) ? storeLib : (homeLib ?? storeLib);
          },
          // U1: every user root is asked which of its files are only in the cloud; a drive never is
          cloudOnlyFor: (root) => (entryOf(root)?.kind === "user" ? cloudProbe : null),
          skip: store ? [store] : [],
          rules: Array.isArray(quarantine) ? quarantine : [],
          // S23: Everything lists the drive when it can; the walk is the fallback, and the pass
          // records which and why. Only Windows has Everything.
          lister:
            "lister" in producer
              ? producer.lister
              : process.platform === "win32"
                ? everythingAdapter()
                : null,
          walkDays: Number(producer.libraryWalkDays) || 7
        })
      : null;
  // S23: WHICH DRIVE THE SCHEDULE RESCANS, AND WHY EVERY OTHER IS SKIPPED. Only a drive that is here,
  // that this store already catalogues under its own identity, and whose last finished pass is older
  // than the interval. A different drive at the same letter has no catalogue under ITS identity, so it
  // is never started; an unplugged one is never counted as rescanned. One pass per tick: the next tick
  // takes the next drive. The hub's own librarian runs it, so it is single flight with the button.
  const rescanDue = ({ hours, now = Date.now() } = {}) => {
    const out = { started: [], skipped: [] };
    if (!librarian)
      return { ...out, skipped: [{ root: null, why: "this machine keeps no catalogues" }] };
    for (const { root } of shelf()) {
      if (!rootIdentity(root)) {
        out.skipped.push({ root, why: "not attached" });
        continue;
      }
      const db = librarian.dbFor(root);
      const at = db && fs.existsSync(db) ? finishedAtOf(db) : null;
      if (!at) {
        out.skipped.push({
          root,
          why: "not catalogued here - the schedule only rescans a drive already catalogued"
        });
        continue;
      }
      if (now - Date.parse(at) < hours * 3_600_000) {
        out.skipped.push({ root, why: "not due" });
        continue;
      }
      const s = librarian.start(root, { startedBy: "schedule" });
      if (!s.started) {
        out.skipped.push({ root, why: "a pass is already running" });
        break;
      }
      out.started.push(root);
      out.done = s.done;
      break;
    }
    return out;
  };
  // U1: what the Library and Compare offer: the registry's roots in the owner's order, or, before the
  // registry has seen a drive, the sweep's configured roots as S21 offered them.
  const shelf = () => {
    if (producer.offered) return producer.offered();
    const db = registry();
    try {
      const list = db ? offeredRoots(readRegistry(db)) : [];
      if (list.length) return list;
    } finally {
      db?.close();
    }
    return producer.roots().map((root) => ({ root, kind: "drive", role: null, removable: true, sections: [] }));
  };
  const entryOf = (root) => shelf().find((e) => e.root === root) ?? null;
  // a read of a OneDrive root's files would download every one that is only in the cloud
  const CLOUD_READ =
    "this folder is in OneDrive, where reading a file that is only in the cloud downloads it: compare or check it from its catalogue once U5 lands";
  // U1: CATALOGUE MY DATA, one root at a time through the one librarian; a failure is recorded and
  // skipped; Stop clears the queue. In memory only: after a restart every pass resumes (S21).
  let queue = null;
  const nextInQueue = (q) => {
    while (q === queue && q.next < q.roots.length) {
      const root = q.roots[q.next++];
      const s = librarian.start(root);
      if (!s.started) {
        q.done.push({ root, why: s.reason || "another pass was running" });
        continue;
      }
      q.current = root;
      s.done.then((r) => {
        if (q !== queue) return;
        q.done.push({ root, ...(r.failed ? { why: r.failed } : { finished: Boolean(r.finished) }) });
        q.current = null;
        nextInQueue(q); // Stop's route has already cleared the queue, so a stopped pass ends here
      });
      return;
    }
    if (q === queue) Object.assign(q, { current: null, finished: true }); // kept, to say what was skipped
  };
  const queueState = () =>
    queue && {
      current: queue.current,
      waiting: queue.roots.slice(queue.next),
      done: queue.done,
      finished: Boolean(queue.finished)
    };

  // S20: a backup drive against F:, on this machine. Results hold file names, so every compare route
  // answers this machine only, and they are kept beside its own map, in BENNY_HOME. Since S21 it asks
  // F:'s catalogue where there is one, and reads only the backup drive.
  const comparer =
    producer &&
    createComparer({
      dir: path.join(path.dirname(producer.dbPath), "compare"),
      rules: Array.isArray(quarantine) ? quarantine : [],
      list: producer.list ?? listRoot,
      // S20 compared drives before S21 existed, so no catalogue is an ordinary answer here
      catalogue: (to) => (librarian ? librarian.lookup(to) : null)
    });
  const SURFACES = new Set(["panel", "skill", "mcp"]);
  const NO_POLICY = "no quarantine policy — the catalogue would list private files (R31)";
  const local = (req) =>
    ["127.0.0.1", "::1"].includes(String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/u, ""));
  // U0 — the drive registry. Opened lazily and per request: this is read far less often than the
  // library, the file is small, and a handle held open across a sleep is a handle held on a drive
  // the owner may be unplugging. Null when there is no home to put it in.
  const registry = () => {
    const home = producer?.dbPath ? path.dirname(path.dirname(producer.dbPath)) : null;
    return home ? openRegistry(registryPath(home)) : null;
  };
  const judgeName = () => {
    const rules = Array.isArray(quarantine) ? quarantine : [];
    // labelProblem, NOT volumeNameProblem: that one validates a volume PATH and refuses anything
    // which is not one, so every label on this machine read "withheld" with no rule matching -
    // fail-safe in direction and useless in fact, because the owner could never see a drive's name.
    return (text) => Boolean(labelProblem(text, rules));
  };

  function handle(req, res, rest) {
    // GET /api/estate — the whole estate model (machines, drives, sessions, snapshots) + a summary.
    if (req.method === "GET" && (rest === "/" || rest === "")) {
      const est = loadEstate({ kelLog, estateFile });
      return sendJson(res, 200, { ...est, summary: summarize(est) });
    }

    // GET /api/estate/stream — subscribe to live estate events over SSE (reuse the B1 bus).
    if (req.method === "GET" && rest === "/stream") {
      if (!bus) return sendJson(res, 503, { error: "no event bus configured" });
      bus.subscribe(res);
      return; // response stays open, owned by the bus
    }

    // GET /api/estate/plan — the next-cycle flywheel projection (N6): what's coming if the pending
    // drift is synced+mapped, and whether the dataset crosses its rebuild threshold. Read-only; the
    // same shape the :8788 flywheel banner uses. No live satellite drift until N7 → the dataset-drift
    // projection (cardsNow vs the cards baked into the last build) is what it renders today.
    if (req.method === "GET" && rest === "/plan") {
      const { manifest, evalReport } = readPlanInputs({
        manifestFile: datasetManifestFile,
        evalFile: evalReportFile
      });
      let cardsNow = null;
      try {
        if (statusFile && fs.existsSync(statusFile))
          cardsNow = JSON.parse(fs.readFileSync(statusFile, "utf8")).cards_ok ?? null;
      } catch {
        /* absent → null */
      }
      return sendJson(
        res,
        200,
        planNextCycle({ cleanCount: 0 }, manifest, evalReport, { cardsNow, thinRate: planThinRate })
      );
    }

    // POST /api/estate/register — a satellite starting on the LAN pushes a hashes-only fingerprint
    // manifest (N7). Authenticate (shared key) + LAN-gate + R31-guard, record last-seen/reachability,
    // recompute drift vs the hub's content-hashes, and publish a reachability event on the bus.
    if (req.method === "POST" && rest === "/register") {
      const remoteAddress = req.socket?.remoteAddress || "127.0.0.1";
      readBody(req).then((b) => {
        const est = loadEstate({ kelLog, estateFile });
        const hubHashes = Object.keys(est.sessions || {});
        const r = registerSatellite(satelliteState, b.manifest || {}, {
          key: b.key,
          expectedKey: registerKey,
          remoteAddress,
          hubHashes,
          quarantine
        });
        if (r.ok) {
          satelliteState = r.state;
          bus?.publish?.("estate", {
            kind: "estate.satellite.online",
            machine: (b.manifest || {}).machine,
            drift: r.drift,
            at: Date.now()
          });
        }
        sendJson(res, r.ok ? 200 : 401, r);
      });
      return;
    }

    // GET /api/estate/satellites — current live reachability + drift per satellite (N7).
    if (req.method === "GET" && rest === "/satellites") {
      return sendJson(res, 200, satelliteState.satellites || {});
    }

    // GET /api/estate/map — every node's latest sweep folded into one estate map (S3). A machine
    // that has stopped pushing is stale SINCE a time, with its last map intact, never empty (§7).
    if (req.method === "GET" && rest === "/map") {
      return sendJson(
        res,
        200,
        foldEstateMap(satelliteState.maps || [], { maxAgeMs: mapMaxAgeMs })
      );
    }

    // GET /api/estate/map/:machine — that machine's volumes and what it WITHHELD (not its biggest
    // categories: S0 only tallies rows it did NOT list). A machine the hub has never heard from is
    // 404, not an empty map: absence of a push is not absence of files.
    const mapMachine = rest.match(/^\/map\/([^/]+)$/u);
    if (req.method === "GET" && mapMachine) {
      const fold = foldEstateMap(satelliteState.maps || [], { maxAgeMs: mapMaxAgeMs });
      const view = machineView(fold, decodeURIComponent(mapMachine[1]));
      return view
        ? sendJson(res, 200, view)
        : sendJson(res, 404, { error: "no map pushed for that machine" });
    }

    // GET /api/estate/sweep — what this machine can sweep, and what its sweeper is doing (S17).
    if (req.method === "GET" && rest === "/sweep") {
      if (!sweeper) return sendJson(res, 503, { error: "this hub has no producer configured" });
      return sendJson(res, 200, {
        machine: producer.machine,
        ...offered(),
        policy: Array.isArray(quarantine),
        ...sweeper.status()
      });
    }

    // POST /api/estate/sweep { volumes } — sweep this machine (S17). LOOPBACK ONLY: a sweep reads
    // every file on a disk, and on a hub bound to the LAN anyone who could reach it could otherwise
    // make it do that. It moves nothing — it reads the disks and writes this node's own map files under BENNY_HOME/estate — and
    // with no policy it does not start, because the hub would refuse the map it produced.
    if (req.method === "POST" && rest === "/sweep") {
      const from = String(req.socket?.remoteAddress ?? "").replace(/^::ffff:/u, "");
      if (from !== "127.0.0.1" && from !== "::1")
        return sendJson(res, 403, { error: "a sweep can only be started from this machine" });
      if (!sweeper) return sendJson(res, 503, { error: "this hub has no producer configured" });
      if (!Array.isArray(quarantine))
        return sendJson(res, 412, {
          error: "no quarantine policy — the hub would refuse the map, so no sweep is started (R31)"
        });
      readBody(req).then(async (b) => {
        const { roots } = offered();
        const volumes = Array.isArray(b.volumes) ? b.volumes : [];
        if (!volumes.length || volumes.some((v) => !roots.includes(v)))
          return sendJson(res, 400, { error: "volumes must be roots this machine offers", roots });
        const r = await sweeper.start(volumes);
        sendJson(
          res,
          r.started ? 202 : 409,
          r.started ? { since: r.since } : { error: "a sweep is running", since: r.since }
        );
      });
      return;
    }

    // U0 — the drive registry: every drive this machine has ever had, by identity. LOOPBACK ONLY,
    // like the library: a volume label is the owner's own text and a user root names where their
    // documents live, which is not something to serve to a LAN the hub binds 0.0.0.0 on.
    if (rest === "/drives" || rest.startsWith("/drives/")) {
      if (!local(req))
        return sendJson(res, 403, { error: "the drive registry is only shown on this machine" });
      if (!Array.isArray(quarantine)) return sendJson(res, 412, { error: NO_POLICY });
      const db = registry();
      if (!db) return sendJson(res, 503, { error: "this hub has no home, so it has no registry" });
      try {
        if (req.method === "GET" && rest === "/drives")
          return sendJson(res, 200, {
            drives: readRegistry(db, {
              judge: judgeName(),
              freshDays: Number(process.env.ESTATE_COPY_FRESH_DAYS) || 30,
              // U11: THREE ANSWERS, NEVER A FOURTH. A date; "never catalogued" when the store is
              // here and holds no catalogue of this drive; or cannot tell. An attached drive is
              // asked who it is, a detached one is found by the identity the registry kept. And
              // the store's own drive can be the one that is away - on the T480 the store is ON
              // F: - in which case absence proves nothing, and saying "never catalogued" of
              // every drive would be false of all of them.
              catalogue: ({ identity, root, attached }) => {
                if (!librarian) return { unknown: "this machine keeps no catalogues" };
                // U1: a catalogue may be in the store or on the machine, so both are looked in
                const db =
                  attached && root
                    ? librarian.dbFor(root)
                    : [storeLib, homeLib]
                        .filter(Boolean)
                        .map((d) => libraryPathFor(d, identity))
                        .find((f) => fs.existsSync(f));
                if (!db || !fs.existsSync(db))
                  return storeLib && !fs.existsSync(storeLib)
                    ? { unknown: "the estate store is not attached, so its catalogues cannot be read" }
                    : { at: null };
                const at = finishedAtOf(db);
                return at ? { at } : { unknown: "its catalogue has never finished" };
              }
            })
          });
        if (req.method === "PATCH" && rest.startsWith("/drives/")) {
          const identity = decodeURIComponent(rest.slice("/drives/".length));
          return readBody(req)
            .then((body) => {
              // ONLY these two, and the name is judged by the same rules as a volume label: a
              // display name is the owner's own text arriving by a different door.
              if (typeof body?.owner_name === "string")
                return setOwnerName(db, identity, body.owner_name.slice(0, 120))
                  ? sendJson(res, 200, { identity, owner_name: true })
                  : sendJson(res, 400, { error: "no drive of that identity has been seen here" });
              if (typeof body?.add_user_root === "string") {
                const r = addUserRoot(db, identity, body.add_user_root);
                return r.refused
                  ? sendJson(res, 409, { error: r.refused })
                  : sendJson(res, 200, { identity, ...r });
              }
              return sendJson(res, 400, { error: "owner_name or add_user_root is required" });
            })
            .catch((e) => {
              if (!res.headersSent)
                sendJson(res, 500, { error: `the drive could not be changed: ${e?.message || e}` });
            })
            .finally(() => db.close());
        }
        return sendJson(res, 405, { error: "GET or PATCH" });
      } finally {
        // the PATCH branch closes its own handle after the body arrives; everything else is done
        if (!(req.method === "PATCH" && rest.startsWith("/drives/"))) db.close();
      }
    }

    // S21 — the librarian. GET /library: each root's catalogue (last pass, kinds, duplicates) and the
    // pass running. POST /library { root } starts or resumes one; POST /library/stop stops it, keeping
    // what it committed. GET /library.csv?root= is every duplicate set. POST /compare/stop stops a
    // comparison. All answer this machine only: the catalogue names files.
    if (
      rest === "/library" ||
      rest === "/library/stop" ||
      rest === "/library/all" ||
      rest === "/library.csv" ||
      rest === "/library/find" ||
      rest === "/library/duplicates" ||
      rest === "/library/check" ||
      rest === "/library/folder" ||
      rest === "/library/neighbours" ||
      rest === "/compare/stop"
    ) {
      if (!local(req))
        return sendJson(res, 403, { error: "the library is only shown on this machine" });
      if (!librarian) return sendJson(res, 503, { error: "this hub has no producer configured" });
      // ONE SHAPER FOR ALL THREE QUESTIONS, because handling a refusal at one route and not
      // another is exactly D5: duplicatesPage learnt to refuse and its route fell through into
      // d.sets.length, answering 500 - or exiting the process where the API is embedded bare.
      // AN AGENT'S QUESTION IS AUDITED WHETHER OR NOT IT WAS ANSWERED. Design point 10 audits the
      // questions an agent asks, and a refused question is still a question asked — "did anything
      // ask about that folder" had the wrong answer for every refusal, which is precisely the gap
      // a tamper-evident log exists to not have. The panel's own navigation stays unaudited: it is
      // the agent surfaces that carry an event, and `event` is undefined for the rest.
      const answer = (to, root, r, event) => {
        const audit = (extra) => {
          if (!event) return; // navigation, not a question
          try {
            // the response goes IN, so the listening check cannot be separated from the write:
            // see library.mjs's audit(). A client that hung up mid-check was audited as answered.
            librarian.audit(root, { ...event(), ...extra }, to);
          } catch {
            // an audit that cannot be written must not take the answer with it
          }
        };
        if (!r) {
          audit({ refused: true });
          return sendJson(to, 404, { error: `${root} has no catalogue: catalogue it first` });
        }
        if (r.refused) {
          audit({ refused: true });
          return sendJson(to, 409, { error: r.refused });
        }
        if (r.missing) return sendJson(to, 404, { error: "no such folder in this catalogue" });
        if (r.computing)
          return sendJson(to, 202, {
            // the hub's OWN sentence when it has one. "The duplicates" is substantively wrong for
            // a folder route waiting on the folder ROLLUP, and the composed `why` was reaching
            // nobody but the test that asserted it existed.
            error: r.why || "the duplicates are still being worked out: try again in a minute"
          });
        audit(); // the panel's own navigation passes no event and so writes none
        return sendJson(to, 200, r);
      };

      const offer = shelf();
      const roots = offer.map((e) => e.root);
      if (req.method === "GET" && rest === "/library") {
        const catalogues = Object.fromEntries(
          roots.map((r) => [r, Array.isArray(quarantine) ? librarian.state(r) : null])
        );
        return sendJson(res, 200, {
          roots,
          policy: Array.isArray(quarantine),
          ...librarian.status(),
          // S23: the panel says when the next rescan is due, or that rescans are off
          rescanHours: Number(producer.rescanHours) || 0,
          // U1: what is offered, in order, with OneDrive's sections, and Catalogue my data's queue
          offered: offer,
          queue: queueState(),
          catalogues
        });
      }
      if (req.method === "GET" && rest === "/library.csv") {
        const root = new URL(req.url, "http://localhost").searchParams.get("root");
        if (!roots.includes(root) || !Array.isArray(quarantine))
          return sendJson(res, 404, { error: "no catalogue of that root" });
        if (!librarian.state(root))
          return sendJson(res, 404, { error: "no catalogue of that root" });
        // written by the librarian's worker, never built on this thread (claude-s21-verifier: 92 s)
        const csv = librarian.csvPath(root);
        if (!csv)
          return sendJson(res, 202, {
            error: "the duplicates are still being worked out: try again in a minute"
          });
        // opened before any header is sent: a list removed in between is "try again", never a crash
        const stream = fs.createReadStream(csv);
        stream.once("error", () =>
          res.headersSent
            ? res.destroy()
            : sendJson(res, 202, { error: "the list changed: try again" })
        );
        stream.once("open", () => {
          res.writeHead(200, {
            "Content-Type": "text/csv; charset=utf-8",
            "Content-Disposition": `attachment; filename="duplicates-${root.replace(/[^A-Za-z0-9]+/gu, "")}.csv"`
          });
          stream.pipe(res);
        });
        return;
      }
      // S22 — the three questions Benny asks. The panel's guards (this machine only, a policy must
      // exist) and the SAME JUDGE, so neither the skill nor an outside MCP client can be told a
      // name the panel would withhold.
      if (rest === "/library/find" || rest === "/library/duplicates") {
        if (req.method !== "GET") return sendJson(res, 405, { error: "GET" });
        if (!Array.isArray(quarantine)) return sendJson(res, 412, { error: NO_POLICY });
        const u = new URL(req.url, "http://localhost");
        const root = u.searchParams.get("root");
        if (!roots.includes(root))
          return sendJson(res, 400, { error: "root must be one this machine offers", roots });
        const num = (k, d, max) =>
          Math.min(Math.max(Number(u.searchParams.get(k) ?? d) || 0, 0), max);
        // for the audit event only - a label, not a guard: every caller gets the same answer
        const surface = SURFACES.has(u.searchParams.get("surface"))
          ? u.searchParams.get("surface")
          : "unknown";
        if (rest === "/library/find") {
          const r = librarian.find(root, {
            q: u.searchParams.get("q") ?? "",
            kind: u.searchParams.get("kind") ?? "",
            limit: num("limit", 50, 500) || 50
          });
          return answer(res, root, r, () => ({
            surface,
            kind: "find",
            // refusal-safe, because the event is now built on the refusal path too: reading
            // r.matches.length there threw INSIDE the audit's own try and wrote nothing at all,
            // which looked exactly like the gap this was meant to close
            returned: r?.matches?.length ?? 0, // 0 only on a refusal, which has no matches
            withheld: r?.withheld ?? 0
          }));
        }
        const d = librarian.duplicatesPage(root, {
          offset: num("offset", 0, 1e6),
          limit: num("limit", 20, 200) || 20
        });
        // withheld is null, not 0: the worker's list has already dropped private copies and their
        // count is not carried here, so a figure would be invented
        return answer(res, root, d, () => ({
          surface,
          kind: "duplicates",
          returned: d?.sets?.length ?? 0,
          withheld: null
        }));
      }
      // S26 — walking the tree. The panel's own route: it reads the rollup the worker built and
      // never the drive, so it answers with the drive detached. NOT audited, unlike find, duplicates
      // and check: S22's design point 10 audits the questions an AGENT asks, and an event per folder
      // click would bury the ones that matter in a tamper-evident log.
      // S26 — where the copies are. A separate route from the folder itself because the owner
      // asks for it, and it costs a query over the folder's subtree rather than a stored figure.
      if (rest === "/library/neighbours") {
        if (req.method !== "GET") return sendJson(res, 405, { error: "GET" });
        if (!Array.isArray(quarantine)) return sendJson(res, 412, { error: NO_POLICY });
        const u = new URL(req.url, "http://localhost");
        const root = u.searchParams.get("root");
        if (!roots.includes(root))
          return sendJson(res, 400, { error: "root must be one this machine offers", roots });
        const at = String(u.searchParams.get("path") ?? "").replace(/^[/\\]+|[/\\]+$/gu, "");
        return answer(res, root, librarian.neighbours(root, { path: at }), null);
      }
      if (rest === "/library/folder") {
        if (req.method !== "GET") return sendJson(res, 405, { error: "GET" });
        if (!Array.isArray(quarantine)) return sendJson(res, 412, { error: NO_POLICY });
        const u = new URL(req.url, "http://localhost");
        const root = u.searchParams.get("root");
        if (!roots.includes(root))
          return sendJson(res, 400, { error: "root must be one this machine offers", roots });
        const num = (k, d, max) =>
          Math.min(Math.max(Number(u.searchParams.get(k) ?? d) || 0, 0), max);
        const at = String(u.searchParams.get("path") ?? "").replace(/^[/\\]+|[/\\]+$/gu, "");
        return answer(
          res,
          root,
          librarian.folder(root, {
            path: at,
            offset: num("offset", 0, 1e7),
            limit: num("limit", 200, 1000) || 200
          }),
          null
        );
      }
      if (rest === "/library/check") {
        if (req.method !== "POST") return sendJson(res, 405, { error: "POST" });
        if (!Array.isArray(quarantine)) return sendJson(res, 412, { error: NO_POLICY });
        readBody(req)
          .then(async (b) => {
            const root = b.root ?? roots[0];
            if (!roots.includes(root))
              return sendJson(res, 400, { error: "root must be one this machine offers", roots });
            if (entryOf(root)?.in_onedrive) return sendJson(res, 400, { error: CLOUD_READ });
            const paths = (Array.isArray(b.paths) ? b.paths : [b.path]).filter(
              (x) => typeof x === "string" && x
            );
            if (!paths.length) return sendJson(res, 400, { error: "path (or paths) is required" });
            const r = await librarian.check(root, { paths });
            // the answer's own figure, counting BOTH channels: paths the rules kept the walk out of
            // and catalogued locations not named. Re-deriving it per-file audited 0 of 6 (D6).
            answer(res, root, r, () => ({
              surface: SURFACES.has(b.surface) ? b.surface : "unknown",
              kind: "check",
              // a refusal has no files and no withheld figure; the event still records the ASKING,
              // which is the thing design point 10 is about
              returned: r?.files?.length ?? 0,
              withheld: r?.withheld ?? 0,
              asked: r?.paths_given ?? paths.length
            }));
          })
          .catch((e) => {
            // the shaper maps shapes; it contains nothing. A request must END, with a body the
            // caller can read - an unhandled rejection here took the whole hub process with it.
            if (!res.headersSent)
              sendJson(res, 500, { error: `the check could not be completed: ${e?.message || e}` });
          });
        return;
      }
      if (req.method !== "POST") return sendJson(res, 405, { error: "GET or POST" });
      if (rest === "/library/stop") queue = null; // U1: Stop clears Catalogue my data's queue too
      if (rest === "/library/stop" || rest === "/compare/stop") {
        const stopped = (rest === "/library/stop" ? librarian : comparer).stop();
        return sendJson(
          res,
          stopped ? 202 : 409,
          stopped ? { stopping: true } : { error: "nothing is running" }
        );
      }
      if (!Array.isArray(quarantine)) return sendJson(res, 412, { error: NO_POLICY });
      if (rest === "/library/all") {
        if (librarian.status().running || (queue && !queue.finished))
          return sendJson(res, 409, { error: "a catalogue pass is running" });
        queue = { roots: [...roots], next: 0, current: null, done: [] };
        nextInQueue(queue);
        return sendJson(res, 202, { queue: queueState() });
      }
      readBody(req).then((b) => {
        // U1: Windows' own folders are never offered, and asked for directly they are refused by name
        if (!roots.includes(b.root) && forbiddenRoot(b.root))
          return sendJson(res, 400, { error: `${b.root} is Windows' own, not the owner's data: never catalogued` });
        if (!roots.includes(b.root))
          return sendJson(res, 400, { error: "root must be one this machine offers", roots });
        const r = librarian.start(b.root);
        if (!r.started && r.reason) return sendJson(res, 400, { error: r.reason });
        sendJson(
          res,
          r.started ? 202 : 409,
          r.started ? { since: r.since } : { error: "a catalogue pass is running", since: r.since }
        );
      });
      return;
    }

    // GET /api/estate/compare?to=F: — the roots, the comparison running, and the latest result of each
    // root against `to` (S20). POST { from, to } starts one. GET /compare.csv?from&to is the list of
    // files only on `from`. All three answer this machine only: the results name files.
    if (rest === "/compare" || rest === "/compare.csv") {
      if (!local(req))
        return sendJson(res, 403, { error: "comparisons are only shown on this machine" });
      if (!comparer) return sendJson(res, 503, { error: "this hub has no producer configured" });
      const q = new URL(req.url, "http://localhost").searchParams;
      const offer = shelf();
      const roots = offer.map((e) => e.root);
      if (req.method === "GET" && rest === "/compare") {
        const to = q.get("to") || (roots.includes("F:") ? "F:" : null);
        const results = Object.fromEntries(
          roots.filter((r) => r !== to).map((r) => [r, to ? comparer.latest(r, to) : null])
        );
        return sendJson(res, 200, {
          roots,
          to,
          policy: Array.isArray(quarantine),
          running: comparer.status(),
          // U1: the panel names a user root by what it is ("Downloads"), not by its path
          labels: Object.fromEntries(offer.filter((e) => e.role).map((e) => [e.root, e.role])),
          results
        });
      }
      if (req.method === "GET") {
        const csv = comparer.csvPath(q.get("from") ?? "", q.get("to") ?? "");
        if (!csv || !fs.existsSync(csv))
          return sendJson(res, 404, { error: "no comparison of the drives there now" });
        res.writeHead(200, {
          "Content-Type": "text/csv; charset=utf-8",
          "Content-Disposition": `attachment; filename="${path.basename(csv)}"`
        });
        return void fs.createReadStream(csv).pipe(res);
      }
      if (req.method !== "POST") return sendJson(res, 405, { error: "GET or POST" });
      if (!Array.isArray(quarantine))
        return sendJson(res, 412, {
          error: "no quarantine policy — a comparison would list private files (R31)"
        });
      readBody(req).then((b) => {
        if (!roots.includes(b.from) || !roots.includes(b.to) || b.from === b.to)
          return sendJson(res, 400, {
            error: "from and to must be two different roots this machine offers",
            roots
          });
        if (entryOf(b.from)?.in_onedrive) return sendJson(res, 400, { error: CLOUD_READ });
        // one inside the other would list the same files on both sides (claude-s20-verifier)
        const key = (r) => {
          const k = path.resolve(`${r}${path.sep}`);
          return (k.endsWith(path.sep) ? k : k + path.sep).toLowerCase(); // F:\x is not inside F:\xy
        };
        if (key(b.from).startsWith(key(b.to)) || key(b.to).startsWith(key(b.from)))
          return sendJson(res, 400, { error: "the two roots overlap: one is inside the other" });
        const r = comparer.start(b.from, b.to);
        if (!r.started && r.reason) return sendJson(res, 400, { error: r.reason });
        sendJson(
          res,
          r.started ? 202 : 409,
          r.started ? { since: r.since } : { error: "a comparison is running", since: r.since }
        );
      });
      return;
    }

    // GET /api/estate/board — the delivery board folded into a lane summary (N3 tie-in).
    if (req.method === "GET" && rest === "/board") {
      const text = boardFile && fs.existsSync(boardFile) ? fs.readFileSync(boardFile, "utf8") : "";
      return sendJson(res, 200, boardLanes(text));
    }

    // GET /api/estate/longview — real LONGVIEW pipeline progress for the Dial (or a null shape).
    if (req.method === "GET" && rest === "/longview") {
      return sendJson(res, 200, longviewProgress(longviewProgressFile));
    }

    // GET /api/estate/drill/:machine — drill-down payload; quarantine never leaks (R31).
    const drill = rest.match(/^\/drill\/([^/]+)$/);
    if (req.method === "GET" && drill) {
      const est = loadEstate({ kelLog, estateFile });
      return sendJson(res, 200, drillMachine(est, decodeURIComponent(drill[1])));
    }

    // POST /api/estate/sync/propose — build an UNAPPROVED sync proposal from a drift delta (N5).
    // Body: { delta:{clean,quarantined}, satellite, quarantine? }. Never moves data.
    if (req.method === "POST" && rest === "/sync/propose") {
      readBody(req).then((b) =>
        sendJson(
          res,
          200,
          proposeSync(b.delta || {}, {
            satellite: b.satellite ?? null,
            quarantine: b.quarantine || []
          })
        )
      );
      return;
    }

    // POST /api/estate/sync/apply — apply an OWNER-APPROVED proposal (human-signed). Idempotent
    // via N0 syncSource; emits a B1 approval event only when content actually moved.
    if (req.method === "POST" && rest === "/sync/apply") {
      if (typeof syncSource !== "function")
        return sendJson(res, 503, { error: "no syncSource configured" });
      readBody(req).then((b) => {
        try {
          const r = applySync(b.proposal || {}, b.source || {}, {
            syncSource,
            bus,
            kelLog,
            stagingRoot
          });
          sendJson(res, r.applied ? 200 : 403, r);
        } catch (e) {
          sendJson(res, 400, { error: String(e?.message || e) });
        }
      });
      return;
    }

    return sendJson(res, 404, { error: `unknown estate route: ${req.method} ${rest}` });
  }

  return {
    // S23: for the library_rescan job, through the job runner's services - never a second librarian
    rescanDue,
    // true → this request is /api/estate/* (handled here, app.js stops); false → fall through.
    tryHandle(req, res) {
      const url = new URL(req.url, "http://localhost");
      const p = url.pathname;
      if (p !== prefix && !p.startsWith(prefix + "/")) return false;
      const rest = p.slice(prefix.length) || "/";
      handle(req, res, rest);
      return true;
    }
  };
}
