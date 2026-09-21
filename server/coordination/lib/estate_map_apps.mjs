// Estate map application collectors (S2) — what software this node runs, from every source that knows.
// Plan: architecture/SOLUTION-estate-map.md §3, §7 · Contract: delivery/tasks/S2.md · Model: estate_map.mjs (S0)
//
// Six sources, each an independent S0 apps collector so one failing source can never empty another's
// rows (S0 keeps a failed collector's previous listing and records the error code):
//   registry · winget · appx      installed applications
//   services · tasks · ports      the software that is actually RUNNING, which no installer lists
//
// S0's apps table has four columns (name, version, publisher, location) and stores the collector's own
// name as `source`. The three run-state sources map onto them, and prefix the name so a row says what
// it is even when read without its source:
//   service:<name>   version = run state     publisher = display name   location = image path
//   task:<path+name> version = task state    publisher = author         location = action executable
//   port:tcp/<addr>:<port>  version = "exposed" | "loopback"  publisher = process  location = image
// A listening port whose owning process cannot be read (protected processes, unelevated) is still
// listed with a null process: an unattributable listener is the one you most need to see.
//
// Every source is read as UTF-8 JSON (or text) through a file, never off the console, because the
// console code page silently corrupts non-ASCII names (S1, D3). Every source fails loudly — an absent
// tool, an unreadable hive, an unparsable export or zero rows is an error code, never a short list.
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { run } from "./estate_map_files.mjs";

const failure = (code, detail) =>
  Object.assign(new Error("apps source failed"), { code }, detail ? { detail } : {});

const PS_ARGS = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];
export const defaultPowerShell = () => process.env.ESTATE_POWERSHELL || "powershell.exe";

// Runs a PowerShell snippet that writes UTF-8 to $out and returns what it wrote. A non-zero exit or
// a missing file is the source being unavailable, which is this collector's failure and no other's.
export async function capture(tag, script, { exec = run, timeoutMs = 300_000 } = {}) {
  const dir = await fsp.mkdtemp(path.join(os.tmpdir(), `estate-apps-${tag}-`));
  const out = path.join(dir, "out.txt").replace(/\\/gu, "/");
  try {
    const r = await exec(defaultPowerShell(), [...PS_ARGS, `$out='${out}'; ${script}`], {
      timeoutMs
    });
    const text = await fsp.readFile(out, "utf8").catch(() => null);
    if (r.code !== 0 || text === null)
      throw failure(`${tag.toUpperCase()}_UNAVAILABLE`, { exit: r.code });
    return text.replace(/^﻿/u, "");
  } finally {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

// Every JSON source reports { rows, errors }: a source that could not read part of itself (an
// unreadable hive, a denied WMI namespace) is incomplete, and incomplete is never a shorter list.
function payload(text, tag) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    throw failure(`${tag.toUpperCase()}_UNPARSABLE`);
  }
  const rows = v?.rows == null ? [] : Array.isArray(v.rows) ? v.rows : [v.rows];
  if (Number(v?.errors) > 0) throw failure(`${tag.toUpperCase()}_INCOMPLETE`, { errors: v.errors });
  return rows;
}

const txt = (v) => (typeof v === "string" && v.trim() !== "" ? v.trim() : null);

// S0 keys an app on (name, version, source), so two entries one source reports separately would be
// folded into one row and 55 real installs would vanish from t480's map in silence: Appx frameworks
// shipped once per architecture, and winget listing one product twice. Where the source tells them
// apart by an identity of its own — winget's Id, an Appx package's full name — the colliding rows
// carry it and stay two rows. Rows that do not collide keep their clean name, and normalizeName
// strips the suffix again so reconcile still folds the product into one application.
function disambiguate(rows) {
  const by = new Map();
  for (const r of rows) {
    const k = `${r.name}\u0000${r.version}`;
    by.set(k, [...(by.get(k) ?? []), r]);
  }
  for (const group of by.values())
    if (group.length > 1) for (const r of group) if (r.id) r.name = `${r.name} [${r.id}]`;
  return rows.map(({ id, ...row }) => row);
}

// --- winget -------------------------------------------------------------------------------------

// A character's width in terminal columns, which is how winget fills its fixed-width ones:
// East Asian Width W or F is two columns, everything else is one, counted per CODE POINT.
// That rule was measured against real winget output by claude-s11-verifier (Han, Hangul and U+FF1A
// pad as 2; Cyrillic, U+00AE and U+2013 as 1), and it is the whole rule — a combining mark, a
// variation selector and a ZWJ each occupy one column here, not zero.
//
// The ranges below are GENERATED from the Unicode Character Database's own EastAsianWidth.txt
// (Unicode 17.0.0, matching this Node's ICU), never hand-listed: S11 hand-wrote them, shipped an
// emoji as narrow when the standard has said W since Unicode 9, and a reviewer reading the same
// list proposed adding Hangul Jamo Extended-B, which the standard classes N. A hand-kept table
// drifts silently and is only ever corrected one missing block at a time (S12).
//
// Encoding: space-separated "<gap>.<span>" pairs in base 36, gap measured from the previous
// range's last code point, span being the range's length. 293 declared ranges merge to 123.
const EAW_WIDE =
  "3cw.2n 3i2.1 d.1 5a.3 3.0 2.0 eh.1 l.1 q.7 g.b 17.0 a.5 3.0 d.0 8.1 h.1 5.1 8.0 5.0 l.0 7.1 " +
  "1.0 4.0 2.0 7.0 4.1 s.0 z.0 1.0 4.2 1.0 1p.2 o.0 e.0 nv.1 1f.0 4.0 mi.p 1.2g c.5x q.26 2.2d " +
  "2.2u 5.16 1.2l 1.2d 9.1b 1.13 8.mkc 3.1i wp.s hv.8mb 6l8.e7 ls.9 m.y 1.i 1.3 45.2n 3j.6 m49.4 " +
  "b.6 9.5p1 15.v 2p.36 6pp.3 1.6 1.1 1.82 f.0 t.2 2.0 e.3 8.az 6bo.2e 9.m 5n1.0 5m.0 5a.0 2.9 " +
  "2t.2 d.17 4.8 7.1 e.5 4a.w c.8 1.1x 1.l c.16 4.4 c.g 3.0 3.1y 1.0 1.56 2.1q d.3 1.n i.0 q.1 " +
  "d.0 2e.2c 1c.1x 6.0 3.2 2.3 3.3 b.1 7.8 6b.b 4.0 7v.1a 1.9 1.54 34.c 3.a 3.1k 1.0 4.f 2.b 4.9 " +
  "zr.1ekd 2.1ekd ";

// Decoded once, as a flat [lo, hi, lo, hi, …] for a binary search.
const WIDE_RANGES = (() => {
  const out = [];
  let at = -1;
  for (const pair of EAW_WIDE.trim().split(" ")) {
    const dot = pair.indexOf(".");
    const lo = at + parseInt(pair.slice(0, dot), 36) + 1;
    at = lo + parseInt(pair.slice(dot + 1), 36);
    out.push(lo, at);
  }
  return out;
})();

export function isWideCodePoint(cp) {
  let lo = 0;
  let hi = WIDE_RANGES.length / 2 - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cp < WIDE_RANGES[mid * 2]) hi = mid - 1;
    else if (cp > WIDE_RANGES[mid * 2 + 1]) lo = mid + 1;
    else return true;
  }
  return false;
}

const charWidth = (ch) => (isWideCodePoint(ch.codePointAt(0)) ? 2 : 1);
export const displayWidth = (s) => [...String(s)].reduce((w, ch) => w + charWidth(ch), 0);

// Cuts one fixed-width line at the header's display columns, or returns null when it cannot be cut
// there: a value that overflowed its column (the column before a boundary is not blank), a
// double-width character straddling a boundary, or a line too short to reach the Version column.
// All three mean the row's fields cannot be trusted, and an untrustworthy row is never a guess.
function cutColumns(line, at) {
  const chars = [...line];
  const startAt = new Map();
  let w = 0;
  for (const [i, ch] of chars.entries()) {
    startAt.set(w, i);
    w += charWidth(ch);
  }
  startAt.set(w, chars.length);
  if (w <= at[2]) return null; // a notice or a wrapped fragment, never an application
  const cells = [];
  for (const [i, col] of at.entries()) {
    if (col >= w) {
      cells.push("");
      continue;
    }
    const from = startAt.get(col);
    if (from === undefined || (col > 0 && chars[from - 1] !== " ")) return null;
    const next = at[i + 1];
    const to = next === undefined ? chars.length : (startAt.get(next) ?? chars.length);
    cells.push(chars.slice(from, to).join("").trim());
  }
  return cells;
}

// `winget list` is fixed-width: column starts come from the header, and every value is left-aligned
// at one. A value too long for its column pushes into the next, which would silently report the
// wrong version, so a row that cannot be cut at those columns is malformed and fails the source.
export function parseWingetList(text) {
  const lines = text.split(/\r?\n/u).filter((l) => !/^[\s\u0008\-\\|/]*$/u.test(l));
  const h = lines.findIndex(
    (l) => l.indexOf("Name") === 0 && l.includes("Id") && l.includes("Version")
  );
  if (h < 0) throw failure("WINGET_NO_HEADER");
  const head = lines[h];
  // the header is ASCII, so its code-unit offsets are also its display columns
  const at = ["Name", "Id", "Version", "Available", "Source"]
    .map((c) => head.indexOf(c))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  const rows = [];
  let malformed = 0;
  for (const line of lines.slice(h + 1)) {
    const cells = cutColumns(line, at);
    if (cells === null) {
      malformed++;
      continue;
    }
    // the Id is winget's own identity for the entry, and tells two same-named rows apart
    if (cells[0] !== "") rows.push({ name: cells[0], id: cells[1], version: cells[2] });
  }
  if (malformed > 0) throw failure("WINGET_MALFORMED", { rows: malformed });
  return rows;
}

// --- sources ------------------------------------------------------------------------------------

const REG_KEYS = [
  "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKLM:\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*",
  "HKCU:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*"
];

// Wraps a PowerShell pipeline as { rows, errors } so a suppressed error is still counted.
const emit = (expr, select) =>
  `$r = ${expr} -ErrorAction SilentlyContinue -ErrorVariable e; ` +
  `@{ rows = @($r | Select-Object ${select}); errors = @($e).Count } | ` +
  `ConvertTo-Json -Depth 5 -Compress | Out-File -LiteralPath $out -Encoding utf8`;

// An Uninstall entry is an application when it has a display name and is not a component or a patch
// of another product: SystemComponent, an update ReleaseType and ParentKeyName all say "not an app".
const isApplication = (r) =>
  txt(r.DisplayName) !== null &&
  Number(r.SystemComponent || 0) !== 1 &&
  !/update|hotfix/iu.test(String(r.ReleaseType ?? "")) &&
  txt(r.ParentKeyName) === null;

// The executable inside a service PathName, which is quoted only when it needs to be.
export function serviceImagePath(pathName) {
  const m = /^\s*"([^"]+)"|^\s*(\S+)/u.exec(String(pathName ?? ""));
  return m ? (m[1] ?? m[2]) : null;
}

// A listener nobody outside this machine can reach. Anything else — 0.0.0.0, ::, a LAN address —
// is reachable from the network and is reported as exposed.
export const isLoopback = (address) =>
  /^127\./u.test(String(address ?? "")) || String(address ?? "").replace(/^\[|\]$/gu, "") === "::1";

export const APP_SOURCES = {
  registry: {
    script: emit(
      `Get-ItemProperty @('${REG_KEYS.join("','")}')`,
      "DisplayName,DisplayVersion,Publisher,InstallLocation,SystemComponent,ReleaseType," +
        // the key an entry lives under is the registry's own identity for it: without it, one
        // product installed in two hives under one display name and version folds away in silence
        "ParentKeyName,@{n='Key';e={$_.PSPath -replace '^.*::',''}}"
    ),
    rows: (data) =>
      disambiguate(
        data.filter(isApplication).map((r) => ({
          name: txt(r.DisplayName),
          id: txt(r.Key),
          version: txt(r.DisplayVersion) ?? "",
          publisher: txt(r.Publisher),
          location: txt(r.InstallLocation)
        }))
      )
  },
  winget: {
    text: true,
    script:
      "[Console]::OutputEncoding=[Text.Encoding]::UTF8; " +
      "winget list --disable-interactivity --accept-source-agreements | " +
      "Out-File -LiteralPath $out -Encoding utf8",
    rows: (data) =>
      disambiguate(
        parseWingetList(data).map((r) => ({
          name: r.name,
          id: r.id,
          version: r.version,
          publisher: null,
          location: null
        }))
      )
  },
  appx: {
    script: emit("Get-AppxPackage", "Name,Version,Publisher,PackageFullName,InstallLocation"),
    rows: (data) =>
      disambiguate(
        data.map((r) => ({
          name: txt(r.Name),
          id: txt(r.PackageFullName),
          version: txt(r.Version) ?? "",
          publisher: txt(r.Publisher),
          location: txt(r.InstallLocation)
        }))
      )
  },
  services: {
    script: emit("Get-CimInstance Win32_Service", "Name,DisplayName,State,PathName"),
    rows: (data) =>
      data.map((r) => ({
        name: `service:${txt(r.Name) ?? ""}`,
        version: txt(r.State) ?? "",
        publisher: txt(r.DisplayName),
        location: serviceImagePath(r.PathName)
      }))
  },
  tasks: {
    script: emit(
      "Get-ScheduledTask",
      "TaskName,TaskPath,Author,@{n='StateName';e={$_.State.ToString()}}," +
        "@{n='Run';e={@($_.Actions.Execute)[0]}}"
    ),
    rows: (data) =>
      data.map((r) => ({
        name: `task:${txt(r.TaskPath) ?? "\\"}${txt(r.TaskName) ?? ""}`,
        version: txt(r.StateName) ?? "",
        publisher: txt(r.Author),
        location: txt(r.Run)
      }))
  },
  ports: {
    script:
      "$procs=@{}; Get-Process -ErrorAction SilentlyContinue | ForEach-Object { $procs[$_.Id]=$_ }; " +
      emit(
        "Get-NetTCPConnection -State Listen",
        "LocalAddress,LocalPort,@{n='Process';e={$procs[[int]$_.OwningProcess].ProcessName}}," +
          "@{n='Image';e={$procs[[int]$_.OwningProcess].Path}}"
      )
  }
};

// IPv6 is bracketed, so the port is always what follows the LAST colon ("::" is an address, not one).
const endpoint = (address) => {
  const a = txt(address) ?? "?";
  return a.includes(":") ? `[${a}]` : a;
};

APP_SOURCES.ports.rows = (data) =>
  data.map((r) => ({
    name: `port:tcp/${endpoint(r.LocalAddress)}:${r.LocalPort ?? "?"}`,
    version: isLoopback(r.LocalAddress) ? "loopback" : "exposed",
    publisher: txt(r.Process),
    location: txt(r.Image)
  }));

// --- collectors ---------------------------------------------------------------------------------

// One S0 apps collector per source. A source that yields nothing has not proved the estate is empty —
// every one of these always has rows on a live Windows node — so zero rows fails the collector too.
export function appCollectors(options = {}) {
  return Object.entries(APP_SOURCES).map(([name, source]) => ({
    name,
    kind: "apps",
    async *collect() {
      const text = await capture(name, source.script, options);
      const rows = source.rows(source.text ? text : payload(text, name));
      if (rows.length === 0) throw failure(`${name.toUpperCase()}_EMPTY`);
      for (const row of rows) yield row;
    }
  }));
}

// --- reconciliation (a view over what was collected, never a rewrite of it) -----------------------

// Two sources naming one product must fold to one application. Names differ only decoratively:
// case and spacing, a bitness or scope suffix, and the version repeated in the display name
// ("Prime-Silo 1.24.5" from the registry is "Prime-Silo" in winget).
export function normalizeName(name, version) {
  let n = String(name ?? "")
    .trim()
    .replace(/\s+/gu, " ");
  const v = String(version ?? "").trim();
  if (v !== "" && n.toLowerCase().endsWith(` ${v.toLowerCase()}`)) n = n.slice(0, -v.length - 1);
  return n
    .replace(/\s*\[[^\]]+\]$/u, "") // the source's own identity, added only where names collided
    .replace(/\s*\((?:64|32)-bit\)$/iu, "")
    .replace(/\s*\((?:x64|x86|user|machine)\)$/iu, "")
    .trim()
    .toLowerCase();
}

// Folds collected rows into one entry per (product, version), listing every source that saw it.
// Versions are NEVER merged: two sources disagreeing about a version is a fact about the estate.
export function reconcile(rows) {
  const by = new Map();
  for (const r of rows) {
    const key = `${normalizeName(r.name, r.version)}\u0000${String(r.version ?? "")}`;
    const e = by.get(key) ?? {
      name: String(r.name ?? "").trim(),
      version: String(r.version ?? ""),
      publisher: null,
      location: null,
      sources: []
    };
    if (!e.sources.includes(r.source)) e.sources.push(r.source);
    e.publisher ??= txt(r.publisher);
    e.location ??= txt(r.location);
    // the shortest display name is the product's own, without a source's decoration
    const n = String(r.name ?? "").trim();
    if (n !== "" && (e.name === "" || n.length < e.name.length)) e.name = n;
    by.set(key, e);
  }
  return [...by.values()].sort(
    (a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version)
  );
}

// The products that more than one source saw at DIFFERENT versions — a node mid-upgrade, or an
// installer that left an old registry entry behind.
export function versionConflicts(reconciled) {
  const by = new Map();
  for (const e of reconciled) {
    const k = normalizeName(e.name, e.version);
    by.set(k, [...(by.get(k) ?? []), e]);
  }
  return [...by.values()].filter((g) => g.length > 1);
}
