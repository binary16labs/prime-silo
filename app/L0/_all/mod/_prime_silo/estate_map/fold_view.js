// Estate Map — everything the panel decides, as pure functions over the fold (S4).
// Plan: architecture/SOLUTION-estate-map.md §5 · Contract: delivery/tasks/S4.md · Data: S3's
// GET /api/estate/map and /api/estate/map/:machine, and nothing else.
//
// This file has no DOM in it on purpose. Every judgement the panel makes — what is stale, what
// drifted, how big a rectangle is — is a function the gate can run without a browser, because the
// judgements are the part that can be wrong in a way nobody notices. The view is then only markup.
//
// THE RULE THIS PANEL INHERITS, from §7 and from the Release panel before it: **absence of data is
// never drawn as absence of things.** A node that stopped pushing is stale since a time, with
// everything it last said still on screen. A node that pushed no applications reads "not pushed",
// not an empty list. A hub that cannot be reached says so, and does not render an empty estate.

// --- time ----------------------------------------------------------------------------------------

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

// "4 minutes", "3 hours", "2 days" — coarse on purpose. A map is minutes old at best, and a
// second-by-second age would imply this page is live when it is a fold of pushes.
export function ageLabel(ms) {
  if (!Number.isFinite(ms) || ms < 0) return "unknown";
  if (ms < MINUTE) return "moments";
  const [n, unit] =
    ms < HOUR
      ? [Math.floor(ms / MINUTE), "minute"]
      : ms < DAY
        ? [Math.floor(ms / HOUR), "hour"]
        : [Math.floor(ms / DAY), "day"];
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

const bytes = (n) => {
  if (!Number.isFinite(n) || n < 0) return "—";
  const units = ["B", "KB", "MB", "GB", "TB", "PB"];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v < 10 && i > 0 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
};
export { bytes as byteLabel };

// --- machines -------------------------------------------------------------------------------------

// One card per machine the hub has ever heard from. A stale machine is NEVER dropped and never
// blanked: it carries its last volumes, its last counts, and the time it went quiet.
export function machineCards(fold = {}, { now = Date.now() } = {}) {
  return Object.entries(fold.machines ?? {})
    .map(([machine, m]) => {
      const ageMs = Number.isFinite(m.ageMs) ? m.ageMs : now - (Date.parse(m.at ?? "") || 0);
      const volumes = Object.entries(m.volumes ?? {}).map(([volume, v]) => ({
        volume,
        collector: v.collector ?? null,
        status: v.status ?? "unknown",
        rows: v.rows ?? 0,
        errorCode: v.error_code ?? null,
        // a volume the latest sweep did not cover keeps its own, older, timestamp
        at: v.at ?? m.at ?? null,
        ageMs: now - (Date.parse(v.at ?? m.at ?? "") || 0)
      }));
      return {
        machine,
        stale: m.stale === true,
        since: m.since ?? null,
        at: m.at ?? null,
        ageMs,
        ageLabel: ageLabel(ageMs),
        sweepId: m.sweep_id ?? null,
        snapshot: m.snapshot ?? null,
        counts: m.counts ?? {},
        // what the node DID NOT publish, which is a fact about the map and not about the machine
        withheld: withheldCount(m),
        volumes: volumes.sort((a, b) => a.volume.localeCompare(b.volume)),
        // an errored collector is the loudest thing on the card: it means this machine's map is
        // incomplete and says which volume
        errored: volumes.filter((v) => v.status !== "ok")
      };
    })
    .sort((a, b) => Number(a.stale) - Number(b.stale) || a.machine.localeCompare(b.machine));
}

const withheldCount = (m) =>
  Math.max(0, (m.counts?.files ?? 0) - (m.counts?.listed_files ?? 0));

// --- the treemap ----------------------------------------------------------------------------------

// Squarified treemap (Bruls, Huizing, van Wijk). The contract's Scenario is about accounting, not
// aesthetics: the rectangles must be PROPORTIONAL to the values and must tile the box exactly. The
// squarifying is only so the result can be read; the invariant is that areas sum to the box.
//
// Zero and negative values are dropped rather than drawn at zero width, because a rectangle nobody
// can see is indistinguishable from one that is not there, and the legend would still count it.
export function treemap(items = [], box = { x: 0, y: 0, w: 1, h: 1 }) {
  const values = items
    .map((it) => ({ ...it, value: Number(it.value) }))
    .filter((it) => Number.isFinite(it.value) && it.value > 0)
    .sort((a, b) => b.value - a.value);
  const total = values.reduce((s, it) => s + it.value, 0);
  if (!values.length || total <= 0 || box.w <= 0 || box.h <= 0) return [];

  const area = (box.w * box.h) / total; // square units per unit of value
  const out = [];
  let rect = { ...box };
  let row = [];

  const rowMin = () => Math.min(...row.map((r) => r.value));
  const rowMax = () => Math.max(...row.map((r) => r.value));
  const rowSum = () => row.reduce((s, r) => s + r.value, 0);
  const shortest = () => Math.min(rect.w, rect.h);

  // the worst aspect ratio in the row if `next` joined it
  const worst = (sum, side) => {
    const s = sum * area;
    return Math.max((side * side * rowMax() * area) / (s * s), (s * s) / (side * side * rowMin() * area));
  };

  const flush = () => {
    const side = shortest();
    const thickness = (rowSum() * area) / side;
    let offset = 0;
    for (const r of row) {
      const length = (r.value * area) / thickness;
      out.push(
        rect.w === side
          ? { ...r, x: rect.x + offset, y: rect.y, w: length, h: thickness }
          : { ...r, x: rect.x, y: rect.y + offset, w: thickness, h: length }
      );
      offset += length;
    }
    if (rect.w === side) rect = { x: rect.x, y: rect.y + thickness, w: rect.w, h: rect.h - thickness };
    else rect = { x: rect.x + thickness, y: rect.y, w: rect.w - thickness, h: rect.h };
    row = [];
  };

  for (const item of values) {
    const side = shortest();
    if (!row.length) {
      row.push(item);
      continue;
    }
    if (worst(rowSum(), side) >= worst(rowSum() + item.value, side)) row.push(item);
    else {
      flush();
      row.push(item);
    }
  }
  if (row.length) flush();
  return out;
}

// What the panel puts into the treemap, and — the part that matters — what it refuses to draw.
//
// THE WIRE CANNOT SIZE A VOLUME. The first version of this panel drew one anyway: it split a
// machine's reported bytes across its volumes by the share of FILES each held, and on a fold whose
// C: was small and busy and whose F: was large and sparse it drew them the wrong way round — the
// owner would have read a 900 GB block labelled C:. That is the panel inventing a number the nodes
// never sent, which is worse than showing nothing.
//
// What the fold actually carries, read out of S0 and S3 rather than assumed:
//   - counts.bytes — every file's bytes, PER MACHINE. Authoritative, and the only byte figure that
//     is.
//   - collectors[].rows, folded into volumes[].rows — files PER VOLUME, and no bytes at all:
//     buildMapPayload puts name/kind/volume/status/rows on the wire and stops there.
//   - totals[] — items and bytes per volume and category for the files the node did NOT list, which
//     is the withheld part only (S0: a non-public file "adds only to totals"). Listed files' bytes
//     stay on the node. So totals is a FLOOR under a volume's bytes, never its size.
// So there are two units in one picture, and the panel says which is which: MACHINES are sized by
// bytes, which is real, and the volumes inside a machine are sized by FILE COUNT, which is also
// real. No rectangle is labelled with a byte figure the node did not send, and a volume's
// known-withheld bytes are shown as the floor they are.
//
// The plan's §5 treemap (machine → volume → category, by bytes) is NOT deliverable from this wire.
// That is a gap in S0/S3's payload — the node knows its per-volume bytes at sweep time and does not
// send them — and not something this panel can estimate its way out of.
export function storageView(fold = {}, { now = Date.now() } = {}) {
  const machines = [];
  const unaccounted = [];
  for (const [machine, m] of Object.entries(fold.machines ?? {})) {
    // A node can send a byte count that is not a number, or is negative, or nothing at all. Coercing
    // it makes the problem vanish — Number(null) is 0, and a node that said nothing then reads as a
    // node that said zero — while carrying it makes "reported" a figure that cannot be reconciled.
    // So only an actual, finite, non-negative number counts, and anything else is NAMED.
    const raw = m.counts?.bytes;
    const readable = typeof raw === "number" && Number.isFinite(raw) && raw >= 0;
    const reported = readable ? raw : 0;
    const withheld = byVolume(m.totals);
    const volumes = Object.entries(m.volumes ?? {}).map(([volume, v]) => ({
      key: `${machine}:${volume}`,
      machine,
      volume,
      files: Number(v.rows) || 0,
      status: v.status ?? "unknown",
      // An errored volume carries its code here too. The storage tab was the one place a
      // WALK_INCOMPLETE vanished, and an incomplete volume is precisely the one whose size is a lie
      // by omission.
      errorCode: v.error_code ?? null,
      withheldBytes: withheld.get(volume)?.bytes ?? 0,
      categories: withheld.get(volume)?.categories ?? [],
      stale: m.stale === true
    }));
    for (const v of volumes)
      if (v.files <= 0) unaccounted.push({ ...v, why: "the node listed no files on this volume" });
    const drawable = volumes.filter((v) => v.files > 0);
    if (!readable)
      unaccounted.push({
        key: `${machine}:!bytes`,
        machine,
        volume: "",
        files: 0,
        status: "unknown",
        errorCode: null,
        withheldBytes: 0,
        categories: [],
        stale: m.stale === true,
        why: `this node reported ${JSON.stringify(m.counts?.bytes)} bytes, which the map cannot read`
      });
    if (!drawable.length && reported > 0)
      unaccounted.push({
        key: `${machine}:`,
        machine,
        volume: "",
        files: 0,
        status: "unknown",
        errorCode: null,
        withheldBytes: 0,
        categories: [],
        stale: m.stale === true,
        why: "this node reported bytes and no volume to put them on"
      });
    machines.push({
      key: machine,
      machine,
      value: reported,
      files: volumes.reduce((s, v) => s + v.files, 0),
      stale: m.stale === true,
      ageMs: Number.isFinite(m.ageMs) ? m.ageMs : now - (Date.parse(m.at ?? "") || 0),
      withheldBytes: volumes.reduce((s, v) => s + v.withheldBytes, 0),
      volumes: drawable.sort((a, b) => b.files - a.files)
    });
  }
  machines.sort((a, b) => b.value - a.value || a.machine.localeCompare(b.machine));
  // THE RECONCILIATION THE TAB HAS TO SURVIVE: every byte the nodes reported is either inside a
  // machine rectangle or named in `unaccounted`, and the figures are on screen so the owner can
  // check the subtraction. A machine's 2 TB went missing from this tab before with no total to
  // check it against.
  return {
    machines,
    unaccounted: unaccounted.sort((a, b) => a.key.localeCompare(b.key)),
    // Only what the fold says. Everything the PICTURE says is reconcile()'s, below, because this
    // function has never seen the box and cannot know which blocks the layout could draw.
    bytes: { reported: machines.reduce((s, x) => s + x.value, 0) },
    withheldBytes: machines.reduce((s, x) => s + x.withheldBytes, 0)
  };
}

// totals[] folded per volume: the bytes and categories a node declared it was NOT listing. Rows
// with no volume (an apps collector has none) are kept under "" rather than dropped, because a
// category with bytes behind it is evidence wherever it sits.
function byVolume(totals = []) {
  const out = new Map();
  for (const t of totals ?? []) {
    const volume = String(t?.volume ?? "");
    const held = out.get(volume) ?? { bytes: 0, items: 0, categories: [] };
    held.bytes += Number(t?.bytes) || 0;
    held.items += Number(t?.items) || 0;
    if (t?.category)
      held.categories.push({
        category: String(t.category),
        items: Number(t.items) || 0,
        bytes: Number(t.bytes) || 0
      });
    held.categories.sort((a, b) => b.bytes - a.bytes || a.category.localeCompare(b.category));
    out.set(volume, held);
  }
  return out;
}

// Two levels, laid out with the same squarifier: machines by bytes, and inside each machine its
// volumes by file count. The nesting is the plan's shape; the units differ and the view labels them.
//
// A rectangle under a pixel is not visible, and counting it in the legend while the map does not
// show it is the same lie in a smaller place — so it is marked tooSmall and listed instead.
// THE LINE UNDER THE MAP IS DERIVED FROM THE MAP. It used to be derived from the fold, which meant
// it described a picture that had not been laid out yet: on two machines at a 1000:1 byte ratio the
// smaller block falls under a pixel, the view refuses to draw it, and the line still counted it as
// drawn. On a fifty-node fold that was one rectangle on screen above a line claiming every byte was
// drawn, with 98 "too small to draw" entries printed directly beneath it.
//
// So the only figure that comes from the fold is what the nodes REPORTED. Everything else is counted
// off the rectangles that exist: drawn, too small to see, drawn-but-unsplit, and whatever is left.
export function reconcile(view, rects = []) {
  const reported = (view?.machines ?? []).reduce((s, m) => s + (Number(m.value) || 0), 0);
  const blocks = rects.filter((r) => r.level === "machine");
  const sum = (list) => list.reduce((s, r) => s + (Number(r.value) || 0), 0);
  const visible = blocks.filter((r) => !r.tooSmall);
  const drawn = sum(visible);
  const tooSmall = sum(blocks.filter((r) => r.tooSmall));
  const unsplit = sum(visible.filter((r) => !(r.volumes ?? []).length));
  return {
    reported,
    drawn,
    tooSmall,
    unsplit,
    // bytes that reached neither the picture nor the too-small list: the residue the owner is owed
    // an explanation for, and the reason this is a subtraction rather than a total
    missing: Math.max(0, reported - drawn - tooSmall)
  };
}

export function storageRects(view, box) {
  const rects = [];
  for (const m of treemap(view?.machines ?? [], box)) {
    // A machine block too small to see is counted in the total like any other and shows nothing —
    // the same lie as an invisible volume, one level up, and worth more bytes.
    if (m.w < 1 || m.h < 1) {
      rects.push({ ...m, level: "machine", tooSmall: true });
      for (const v of m.volumes ?? []) rects.push({ ...v, level: "volume", tooSmall: true });
      continue;
    }
    rects.push({ ...m, level: "machine" });
    // The machine's own header — its name AND the bytes it reported — has to stay readable, so the
    // volumes are inset below it rather than over it. Drawn over, the one authoritative byte figure
    // on this tab was the one thing you could not read.
    const pad = Math.min(28, Math.floor(m.h / 3));
    const inner = {
      x: m.x + 1,
      y: m.y + pad,
      w: Math.max(0, m.w - 2),
      h: Math.max(0, m.h - pad - 1)
    };
    if (inner.w <= 0 || inner.h <= 0) {
      for (const v of m.volumes ?? []) rects.push({ ...v, level: "volume", tooSmall: true });
      continue;
    }
    for (const v of treemap((m.volumes ?? []).map((v) => ({ ...v, value: v.files })), inner))
      rects.push({ ...v, level: "volume", ...(v.w >= 1 && v.h >= 1 ? {} : { tooSmall: true }) });
  }
  return rects;
}

// --- media ----------------------------------------------------------------------------------------

// The Goal names media roots. The wire carries counts.media / counts.listed_media per machine and
// totals rows of kind "media" per volume and category, so what can honestly be shown is how much
// media each node found, how much of it it published, and the categories behind what it withheld.
// Per-root listings are S5's. A node that has not swept media reads "not swept", never zero — the
// same rule the applications tab follows for a node that pushed no list.
export function mediaView(fold = {}) {
  const machines = Object.entries(fold.machines ?? {}).map(([machine, m]) => {
    const found = Number(m.counts?.media) || 0;
    const listed = Number(m.counts?.listed_media) || 0;
    const rows = (m.totals ?? []).filter((t) => t?.kind === "media");
    return {
      machine,
      stale: m.stale === true,
      swept: found > 0 || rows.length > 0,
      found,
      listed,
      withheld: Math.max(0, found - listed),
      withheldBytes: rows.reduce((s, t) => s + (Number(t.bytes) || 0), 0),
      categories: rows
        .map((t) => ({
          category: String(t.category ?? "—"),
          items: Number(t.items) || 0,
          bytes: Number(t.bytes) || 0
        }))
        .sort((a, b) => b.bytes - a.bytes || a.category.localeCompare(b.category))
    };
  });
  return {
    machines: machines.sort((a, b) => b.found - a.found || a.machine.localeCompare(b.machine)),
    swept: machines.filter((x) => x.swept).map((x) => x.machine),
    notSwept: machines.filter((x) => !x.swept).map((x) => x.machine)
  };
}

// --- applications ---------------------------------------------------------------------------------

// One row per product, one column per machine. A machine that pushed no applications is NOT an
// empty cell: it is "not pushed", because an empty cell reads as "this machine does not have it"
// and that is a claim the map cannot make. S3 pushes counts only; S14 is the contract that puts
// names on the wire, and until it lands every machine reads not-pushed here.
export function applicationMatrix(fold = {}, { only = null } = {}) {
  const machines = Object.keys(fold.machines ?? {}).sort();
  const pushed = machines.filter((m) => Array.isArray(fold.machines[m]?.apps));
  const notPushed = machines.filter((m) => !pushed.includes(m));

  const products = new Map();
  for (const machine of pushed) {
    for (const app of fold.machines[machine].apps) {
      const name = String(app?.name ?? "").trim();
      if (!name) continue;
      const key = normalizeProduct(name, app.version);
      if (only && !only.test(name)) continue;
      const row = products.get(key) ?? { product: name, byMachine: {}, sources: new Set() };
      // the shortest spelling is the product's own, without a source's decoration
      if (name.length < row.product.length) row.product = name;
      const versions = row.byMachine[machine] ?? [];
      if (!versions.includes(app.version)) versions.push(app.version);
      row.byMachine[machine] = versions;
      if (app.source) row.sources.add(app.source);
      products.set(key, row);
    }
  }

  const rows = [...products.values()]
    .map((r) => {
      const held = Object.entries(r.byMachine);
      const all = new Set(held.flatMap(([, vs]) => vs));
      return {
        product: r.product,
        sources: [...r.sources].sort(),
        byMachine: Object.fromEntries(held.map(([m, vs]) => [m, vs.sort()])),
        missingFrom: pushed.filter((m) => !r.byMachine[m]),
        drifted: held.length > 1 && all.size > 1,
        versions: [...all].sort()
      };
    })
    .sort((a, b) => Number(b.drifted) - Number(a.drifted) || a.product.localeCompare(b.product));

  // WHICH OF THESE COLUMNS IS A QUIET NODE. A stale machine's version is its LAST KNOWN version, and
  // drawn identically to a live one it turns "these two disagree" into a claim the fold cannot make:
  // the disagreement may have been resolved days ago and the node simply stopped saying so.
  const stale = Object.fromEntries(machines.map((m) => [m, fold.machines[m]?.stale === true]));
  return { machines, pushed, notPushed, rows, stale };
}

// "Prime-Silo 1.24.5" from the registry is "Prime-Silo" in winget — the same fold S2's reconcile
// does, and deliberately the SAME RULE: a trailing version is stripped only when it is THIS row's
// version. Stripping any version-shaped tail would turn "7-Zip 24.09" at version 24.08 into
// "7-Zip", and S2 killed a mutation that did exactly that. A product name that happens to end in
// a number is a product name.
export function normalizeProduct(name, version) {
  // decoration first, then the version: "Prime-Silo 1.24.5 (x64)" hides its version behind the
  // bitness suffix, and stripping in the other order leaves the version stranded on the name
  let n = String(name ?? "")
    .trim()
    .replace(/\s+/gu, " ")
    .replace(/\s*\[[^\]]+\]$/u, "")
    .replace(/\s*\((?:64|32)-bit\)$/iu, "")
    .replace(/\s*\((?:x64|x86|user|machine)\)$/iu, "")
    .trim();
  const v = String(version ?? "").trim();
  if (v !== "" && n.toLowerCase().endsWith(` ${v.toLowerCase()}`)) n = n.slice(0, -v.length - 1);
  return n.trim().toLowerCase();
}

// The products two or more machines hold at different versions — the question this panel exists to
// answer without a report script.
export function versionDrift(matrix) {
  return (matrix?.rows ?? []).filter((r) => r.drifted);
}

// --- the producer (S17) ---------------------------------------------------------------------------

// What the Sweep control can honestly offer, from GET /api/estate/sweep. A hub that cannot sweep
// says WHY in words the owner can act on, rather than showing a button that would fail or hiding the
// control and leaving them to wonder where it went. A sweep the hub refused is reported as refused,
// never as a map the owner should expect to see.
export function sweepView(s, { now = Date.now() } = {}) {
  const since = (iso) => `${ageLabel(now - (Date.parse(iso ?? "") || NaN))} ago`;
  const last = !s?.last
    ? null
    : s.last.ok
      ? `Last sweep of ${s.last.volumes.join(", ")} finished ${since(s.last.at)}: ${Number(s.last.files).toLocaleString()} files`
      : `Last sweep of ${s.last.volumes.join(", ")} did not reach the map: ${s.last.reason}`;
  const off = (why) => ({ can: false, why, machine: s?.machine ?? null, roots: [], running: null, last });
  if (!s || typeof s !== "object") return off("The hub did not say whether this machine can sweep.");
  if (s.error) return off(`This machine cannot sweep: ${s.error}.`);
  if (s.policy !== true)
    return off(
      "Sweeping is off: there is no quarantine policy at coordination/estate/quarantine.json, so " +
        "the hub would refuse the map a sweep produced."
    );
  return {
    can: !s.running,
    why: null,
    machine: s.machine ?? null,
    roots: s.roots ?? [],
    running: s.running ? `Sweeping ${s.running.volumes.join(", ")} — started ${since(s.running.since)}` : null,
    last
  };
}

// --- the whole page -------------------------------------------------------------------------------

// One call, so the view has no logic of its own. `reachable` is false when the hub did not answer,
// and the view must render that as "cannot tell" rather than as an estate with nothing in it.
export function estateView(fold, { now = Date.now(), reason = null } = {}) {
  if (!fold || typeof fold !== "object" || !fold.machines)
    return { reachable: false, empty: false, reason: reason ?? "the hub did not answer", machines: [] };
  const matrix = applicationMatrix(fold);
  const machines = machineCards(fold, { now });
  return {
    reachable: true,
    reason: null,
    at: fold.at ?? null,
    // A HUB THAT HOLDS NOTHING IS ITS OWN STATE, not the absence of one. Reachable-and-empty used to
    // render as a title, a tab strip and blank space below — indistinguishable from a panel that had
    // failed to draw, which is the single thing this surface must never be. It is also the state this
    // estate is in right now: the hub ships fail-closed, so until coordination/estate/quarantine.json
    // exists it refuses every push and holds nothing. The panel says that, in those words, rather
    // than leaving the owner to guess whether the page is broken.
    empty: machines.length === 0,
    emptyReason:
      machines.length === 0
        ? "The hub answered and holds no pushed maps. A hub with no quarantine policy refuses every " +
          "map (R31), so check that coordination/estate/quarantine.json exists and that a node has run a sweep."
        : null,
    // stale is a fact about the whole estate too: "3 nodes reporting" while every one of them is
    // quiet is a true sentence that reads as a false one
    allStale: machines.length > 0 && machines.every((m) => m.stale),
    machines,
    storage: storageView(fold, { now }),
    media: mediaView(fold),
    applications: matrix,
    drift: versionDrift(matrix)
  };
}
