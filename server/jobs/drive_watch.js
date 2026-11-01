// U0 — the drive watch. Every minute, compare what is attached with the registry.
//
// ONE EVENT PER CHANGE, NOT PER TICK. The comparison lives in syncDrives and is against the
// registry's own `attached` column, so a drive that has sat there all week produces silence. A job
// that narrated every tick would bury the one event the owner came to the log for.
//
// IT COSTS WHAT A LIST COSTS. The tick reads the volume table and nothing else: no file is opened,
// no directory walked, no hash taken. The pre-registered criterion is 2 s of CPU per hour for an
// idle hub, and the only way to meet that is for the tick to be a list and not a scan.
import os from "node:os";
import path from "node:path";
import {
  openRegistry,
  registryPath,
  syncDrives,
  driveEvent,
  fillFromStatfs,
  parseWindowsVolumes,
  parseLinuxVolumes,
  driveIdentity,
  userRoots,
  recordUserRoots
} from "../coordination/lib/drive_registry.mjs";
import { appendKelEvents } from "../coordination/lib/kel.mjs";
import { capture } from "../coordination/lib/estate_map_apps.mjs";
import { JobBase } from "./job_base.js";

const JOB_LOCK_TTL_MS = 5 * 60_000;
const DEFAULT_SECONDS = 60;

// Get-Volume joined to Get-Partition and Get-Disk: the volume knows its letter and label, only the
// DISK knows whether it arrived over USB, and that join is why this is one call rather than three.
const WINDOWS_SCRIPT = `
$v = Get-Volume | Where-Object { $_.DriveLetter } | ForEach-Object {
  $p = Get-Partition -Volume $_ -ErrorAction SilentlyContinue | Select-Object -First 1
  $d = if ($p) { Get-Disk -Number $p.DiskNumber -ErrorAction SilentlyContinue } else { $null }
  [pscustomobject]@{
    DriveLetter = [string]$_.DriveLetter; FileSystemLabel = $_.FileSystemLabel
    FileSystem = $_.FileSystem; DriveType = [string]$_.DriveType
    Size = $_.Size; SizeRemaining = $_.SizeRemaining
    BusType = if ($d) { [string]$d.BusType } else { $null }
    IsSystem = ($_.DriveLetter -eq ($env:SystemDrive -replace ':',''))
  }
}
ConvertTo-Json -InputObject @($v) -Depth 3 | Out-File -FilePath $out -Encoding utf8`;

// The owner's own folders, from the key that FOLLOWS redirection. A guessed Users\<name>\Documents
// is wrong on this very machine, where Documents, Desktop and Pictures live in OneDrive.
const SHELL_SCRIPT = `
$k = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders'
$p = Get-ItemProperty -Path $k
$o = @{}
foreach ($n in $p.PSObject.Properties.Name) {
  if ($n -notlike 'PS*') { $o[$n] = [Environment]::ExpandEnvironmentVariables([string]$p.$n) }
}
$o['OneDrive'] = [string]$env:OneDrive
ConvertTo-Json -InputObject $o -Depth 2 | Out-File -FilePath $out -Encoding utf8`;

export async function readVolumes({ platform = process.platform, run = capture } = {}) {
  if (platform === "linux") {
    const text = await run(
      "lsblk",
      "lsblk -J -o UUID,LABEL,FSTYPE,SIZE,FSAVAIL,MOUNTPOINT,TRAN,HOTPLUG > $out"
    );
    const { rows, unreadable } = parseLinuxVolumes(text);
    return {
      rows: rows.map((r) => ({ ...r, identity: r.uuid ? `uuid:${r.uuid}` : null })),
      unreadable
    };
  }
  const { rows, unreadable } = parseWindowsVolumes(await run("volumes", WINDOWS_SCRIPT));
  return {
    rows: rows.map((r) => ({ ...fillFromStatfs(r), identity: driveIdentity(r.root) })),
    unreadable
  };
}

export async function readUserRoots({ platform = process.platform, run = capture } = {}) {
  if (platform === "linux") {
    const home = process.env.HOME;
    return home
      ? [{ role: "documents", root: home, identity: driveIdentity(home), in_onedrive: false }]
      : [];
  }
  let folders = {};
  try {
    folders = JSON.parse(await run("shell-folders", SHELL_SCRIPT)) ?? {};
  } catch {
    return []; // the key is unreadable: no user roots is honest, a guessed list is not
  }
  const { OneDrive, ...rest } = folders;
  return userRoots(rest, { oneDrive: OneDrive || null });
}

// One tick: read, compare, record. Exported so a test drives it without an interval or a drive.
export async function tick({ home, machine, logFile, read = readVolumes, roots = readUserRoots }) {
  const db = openRegistry(registryPath(home));
  try {
    const { rows, unreadable } = await read();
    if (unreadable) return { unreadable, events: 0 };
    const { events, unknown, at } = syncDrives(db, rows);
    recordUserRoots(db, await roots());

    // THE APPEND'S REFUSAL IS REPORTED, NEVER SWALLOWED. A dead worker that looked alive cost this
    // estate 45 minutes once; a ledger write that silently fails is the same mistake with a longer
    // fuse, because the owner would only find out when they asked the log what had happened.
    let written = 0;
    let refused = null;
    for (const e of events) {
      const r = appendKelEvents(logFile, [driveEvent({ machine, at, ...e })]);
      if (r.ok) written += r.written ?? 1;
      else refused = r.reason;
    }
    return { events: events.length, written, refused, unknown: unknown.length };
  } finally {
    db.close();
  }
}

export default class DriveWatchJob extends JobBase {
  // DISABLED WITHOUT A HOME. The registry lives at BENNY_HOME/estate/drives.db because F: comes and
  // goes and a registry on F: is absent exactly when the owner asks which drives they have.
  isEnabled() {
    return Boolean(process.env.BENNY_HOME);
  }

  getSchedule() {
    const s = Number(process.env.ESTATE_DRIVE_WATCH_SECONDS) || DEFAULT_SECONDS;
    return { everyMs: Math.max(5, s) * 1_000, lockTtlMs: JOB_LOCK_TTL_MS };
  }

  // no context: the runner passes no logger, so there is nothing here to report THROUGH - the
  // refusal is thrown instead, which is the one channel it reads
  async run() {
    const home = process.env.BENNY_HOME;
    if (!home) return { skipped: "no BENNY_HOME" };
    // `require` in an ES module throws on EVERY tick. server/package.json is type: module, this was
    // the only require in server/jobs, and with ESTATE_MACHINE unset - the default - the job failed
    // before it did anything, so the registry was never written on a default install. Every test
    // drove the exported tick() and nothing called run(), which is exactly the gap that hid it.
    const machine = (process.env.ESTATE_MACHINE || "").toLowerCase() || os.hostname().toLowerCase();
    const r = await tick({
      home,
      machine,
      logFile: path.join(home, "estate", "eventlog", `drives-${machine}.jsonl`)
    });
    // THROWN, because the runner has no logger to warn through: context carries auth, jobId,
    // projectRoot, runTrackedMutation, runtimeParams, stateSystem and watchdog and no logger, so
    // the optional chaining I wrote made "reports rather than swallows" a silent no-op - and
    // run()'s return value is discarded too. Throwing is the one channel the runner reads: it
    // catches, records that the job failed, and reschedules. A ledger write that fails quietly is
    // the dead-worker defect with a longer fuse.
    if (r.refused) throw new Error(`the estate ledger refused a drive event: ${r.refused}`);
    return r;
  }
}
