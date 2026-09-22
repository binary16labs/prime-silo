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

// What the panel puts INTO the treemap: one rectangle per machine/volume, sized by the bytes that
// machine reported. Volumes carry row counts, not bytes, so size comes from the machine's counts —
// and a machine that reported no bytes is listed beside the map rather than drawn as nothing.
export function storageItems(fold = {}) {
  const items = [];
  const unsized = [];
  for (const [machine, m] of Object.entries(fold.machines ?? {})) {
    const total = m.counts?.bytes ?? 0;
    const volumes = Object.entries(m.volumes ?? {});
    const rows = volumes.reduce((s, [, v]) => s + (v.rows ?? 0), 0);
    for (const [volume, v] of volumes) {
      // bytes are reported per machine, so a machine's total is split across its volumes by the
      // share of files each holds. That is an ESTIMATE and the panel labels it as one.
      const share = rows > 0 ? (v.rows ?? 0) / rows : 0;
      const value = Math.round(total * share);
      if (value > 0) items.push({ key: `${machine}:${volume}`, machine, volume, value, rows: v.rows ?? 0 });
      else unsized.push({ key: `${machine}:${volume}`, machine, volume, rows: v.rows ?? 0 });
    }
  }
  return { items: items.sort((a, b) => b.value - a.value), unsized, estimated: true };
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

  return { machines, pushed, notPushed, rows };
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

// --- the whole page -------------------------------------------------------------------------------

// One call, so the view has no logic of its own. `reachable` is false when the hub did not answer,
// and the view must render that as "cannot tell" rather than as an estate with nothing in it.
export function estateView(fold, { now = Date.now(), reason = null } = {}) {
  if (!fold || typeof fold !== "object" || !fold.machines)
    return { reachable: false, reason: reason ?? "the hub did not answer", machines: [] };
  const matrix = applicationMatrix(fold);
  return {
    reachable: true,
    reason: null,
    at: fold.at ?? null,
    machines: machineCards(fold, { now }),
    storage: storageItems(fold),
    applications: matrix,
    drift: versionDrift(matrix)
  };
}
