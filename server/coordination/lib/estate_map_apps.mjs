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

// `winget list` is fixed-width: column starts come from the header, and every value is left-aligned
// at one. A value too long for its column pushes into the next, which would silently report the
// wrong version — so a row whose column boundary is not blank is malformed and fails the source.
export function parseWingetList(text) {
  const lines = text.split(/\r?\n/u).filter((l) => !/^[\s\u0008\-\\|/]*$/u.test(l));
  const h = lines.findIndex(
    (l) => l.indexOf("Name") === 0 && l.includes("Id") && l.includes("Version")
  );
  if (h < 0) throw failure("WINGET_NO_HEADER");
  const head = lines[h];
  const at = ["Name", "Id", "Version", "Available", "Source"]
    .map((c) => head.indexOf(c))
    .filter((i) => i >= 0)
    .sort((a, b) => a - b);
  const rows = [];
  let malformed = 0;
  for (const line of lines.slice(h + 1)) {
    if (at.some((o) => o > 0 && line.length > o && line[o - 1] !== " ")) {
      malformed++;
      continue;
    }
    const cut = (i) => line.slice(at[i], at[i + 1] ?? line.length).trim();
    const name = cut(0);
    // the Id is winget's own identity for the entry, and tells two same-named rows apart
    if (name !== "") rows.push({ name, id: cut(1), version: cut(2) });
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
      "DisplayName,DisplayVersion,Publisher,InstallLocation,SystemComponent,ReleaseType,ParentKeyName"
    ),
    rows: (data) =>
      data.filter(isApplication).map((r) => ({
        name: txt(r.DisplayName),
        version: txt(r.DisplayVersion) ?? "",
        publisher: txt(r.Publisher),
        location: txt(r.InstallLocation)
      }))
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
