// U0 — the drive registry: every drive this machine has ever had, BY IDENTITY, never by letter.
//
// S20's lesson, paid for twice. A backup drive takes the next free letter, so a registry keyed by
// letter showed drive B at G: the facts of drive A; and S26 re-learnt it when a catalogue resolved
// by recorded NAME served one disk's figures for another. A row here belongs to what a drive IS.
//
// THE REGISTRY LIVES ON THE MACHINE, not on a drive. F: comes and goes; a registry on F: would be
// absent exactly when the owner asks which drives they have.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { fileIdentity } from "./estate_compare.mjs";

// --- identity -----------------------------------------------------------------------------------
//
// ON WINDOWS THIS IS S21'S VALUE, UNCHANGED. Every catalogue is named library-<identity>.db, so a
// different spelling here would orphan every catalogue the owner already has. The test that proves
// it is the point of the function existing rather than being inlined.
//
// On Linux the device number S21 uses changes across reboots and USB ports — the same disk, a
// different id, a second catalogue of the same files. The filesystem UUID does not move, so Linux
// identity is `uuid:<UUID>` and nothing else.
export const UUID_PREFIX = "uuid:";

export function driveIdentity(root, { platform = process.platform, uuidOf = linuxUuid } = {}) {
  if (platform !== "linux") return fileIdentity(/^[A-Za-z]:$/u.test(root) ? `${root}\\` : root);
  const uuid = uuidOf(root);
  return uuid ? `${UUID_PREFIX}${uuid}` : null;
}

export const linuxUuid = (root, { read = lsblkJson } = {}) => {
  const rows = read();
  const hit = (rows ?? []).find((r) => r.mountpoint === root && r.uuid);
  return hit ? hit.uuid : null;
};

// --- what the operating system says -------------------------------------------------------------
//
// IT REPORTS WHAT THE OS RETURNED, NEVER A GUESS. A field the call did not give is null here and
// "unknown" on the panel: a capacity invented from a sibling field is worse than an absent one,
// because the owner cannot tell it apart from a real figure.
const MEDIUM_BY_BUS = Object.freeze({
  usb: "usb",
  sata: "internal",
  nvme: "internal",
  scsi: "internal",
  raid: "internal",
  sas: "internal",
  ide: "internal"
});

export const mediumOf = ({ bus = "", driveType = "", transport = "", hotplug = false } = {}) => {
  const t = String(driveType).toLowerCase();
  if (t === "network" || t === "remote") return "network";
  const b = String(bus || transport).toLowerCase();
  if (MEDIUM_BY_BUS[b]) return MEDIUM_BY_BUS[b];
  // a hotpluggable disk on an unknown bus is removable, which is the half that matters to the owner
  return hotplug ? "usb" : null;
};

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : null);

// `Get-Volume` joined to `Get-Partition` and `Get-Disk`: letter, label, file system, type, size,
// remaining space, and the DISK's bus, which is where usb-versus-internal actually lives.
export function parseWindowsVolumes(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { rows: [], unreadable: "the volume list could not be parsed" };
  }
  const rows = (Array.isArray(v) ? v : [v]).filter(Boolean).map((r) => ({
    root: r.DriveLetter ? `${r.DriveLetter}:` : null,
    label: r.FileSystemLabel ?? null,
    filesystem: r.FileSystem ?? null,
    capacity: num(r.Size),
    free: num(r.SizeRemaining),
    medium: mediumOf({ bus: r.BusType, driveType: r.DriveType }),
    system: Boolean(r.IsSystem)
  }));
  return { rows: rows.filter((r) => r.root) };
}

// `lsblk -J -o UUID,LABEL,FSTYPE,SIZE,FSAVAIL,MOUNTPOINT,TRAN,HOTPLUG`, flattened: lsblk nests
// partitions under their disk and the transport lives on the parent.
export function parseLinuxVolumes(text) {
  let v;
  try {
    v = JSON.parse(text);
  } catch {
    return { rows: [], unreadable: "the volume list could not be parsed" };
  }
  const rows = [];
  const walk = (node, inherited) => {
    const tran = node.tran ?? inherited.tran;
    const hotplug = node.hotplug ?? inherited.hotplug;
    if (node.mountpoint)
      rows.push({
        root: node.mountpoint,
        label: node.label ?? null,
        filesystem: node.fstype ?? null,
        capacity: num(node.size),
        free: num(node.fsavail),
        medium: mediumOf({ transport: tran, hotplug: Boolean(hotplug) }),
        uuid: node.uuid ?? null,
        system: node.mountpoint === "/"
      });
    for (const kid of node.children ?? []) walk(kid, { tran, hotplug });
  };
  for (const d of v?.blockdevices ?? []) walk(d, {});
  return { rows };
}

// Where the OS omitted capacity or free space, ask the filesystem. Still measured, never guessed.
export const fillFromStatfs = (row, { statfs = fs.statfsSync } = {}) => {
  if (row.capacity !== null && row.free !== null) return row;
  try {
    const s = statfs(row.root.endsWith(":") ? `${row.root}\\` : row.root);
    const block = Number(s.bsize) || 0;
    return {
      ...row,
      capacity: row.capacity ?? (block * Number(s.blocks) || null),
      free: row.free ?? (block * Number(s.bavail) || null)
    };
  } catch {
    return row;
  }
};

// --- the registry -------------------------------------------------------------------------------
export const registryPath = (home) => path.join(home, "estate", "drives.db");

export function openRegistry(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new DatabaseSync(dbPath, { timeout: 2_000 });
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS drives (
      identity TEXT PRIMARY KEY,
      label TEXT, owner_name TEXT, filesystem TEXT, medium TEXT,
      capacity INTEGER, free INTEGER, root TEXT,
      first_seen TEXT NOT NULL, last_seen TEXT NOT NULL,
      attached INTEGER NOT NULL DEFAULT 0,
      system INTEGER NOT NULL DEFAULT 0,
      -- reserved for U9: a retired drive is remembered, never deleted, and always null here
      retired_at TEXT
    );
    CREATE TABLE IF NOT EXISTS user_roots (
      identity TEXT NOT NULL, root TEXT NOT NULL, role TEXT NOT NULL,
      in_onedrive INTEGER NOT NULL DEFAULT 0, added_by_owner INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (identity, root)
    );
  `);
  return db;
}

// --- user roots, on the Windows system drive ----------------------------------------------------
//
// A SYSTEM DRIVE IS NEVER OFFERED WHOLE (owner direction, 2026-10-11). What the estate catalogues
// on C: is the owner's own folders, and WHERE THEY ACTUALLY ARE: these come from the User Shell
// Folders key, which follows redirection into OneDrive or onto another disk. A guessed
// C:\Users\<name>\Downloads would be wrong on this very machine, where Documents, Desktop and
// Pictures live in OneDrive.
//
// Downloads is first because it is where the owner's unsorted weight collects.
export const USER_ROOT_ORDER = Object.freeze([
  "downloads",
  "documents",
  "desktop",
  "pictures",
  "videos",
  "music",
  "onedrive"
]);

const SHELL_FOLDER_ROLES = Object.freeze({
  "{374DE290-123F-4565-9164-39C4925E467B}": "downloads",
  Personal: "documents",
  Desktop: "desktop",
  "My Pictures": "pictures",
  "My Video": "videos",
  "My Music": "music"
});

// NEVER a user root, and never addable as one. Windows and its programs are not the owner's data,
// and AppData is where an application's own state lives — cataloguing it would fingerprint caches
// and credential stores the owner never chose to hand over (the Windows user-data scope, 10-11).
export const FORBIDDEN_ROOTS = Object.freeze([
  "windows",
  "program files",
  "program files (x86)",
  "programdata",
  "appdata"
]);

export const forbiddenRoot = (p) => {
  const parts = String(p).replace(/\\/gu, "/").split("/").filter(Boolean);
  return parts.some((seg) => FORBIDDEN_ROOTS.includes(seg.toLowerCase()));
};

// `folders` is the User Shell Folders key as name -> value, variables already expanded.
export function userRoots(folders = {}, { oneDrive = null, identityOf = driveIdentity } = {}) {
  const found = new Map();
  for (const [name, value] of Object.entries(folders)) {
    const role = SHELL_FOLDER_ROLES[name];
    if (!role || !value || forbiddenRoot(value)) continue;
    found.set(role, String(value));
  }
  if (oneDrive && !forbiddenRoot(oneDrive)) found.set("onedrive", String(oneDrive));

  const one = oneDrive ? String(oneDrive).toLowerCase() : null;
  return USER_ROOT_ORDER.filter((r) => found.has(r)).map((role) => {
    const root = found.get(role);
    return {
      role,
      root,
      identity: identityOf(root) ?? null,
      in_onedrive: Boolean(one && root.toLowerCase().startsWith(one))
    };
  });
}

// --- privacy ------------------------------------------------------------------------------------
//
// A VOLUME LABEL IS THE OWNER'S OWN TEXT, and so is a display name they type. Both are judged by
// the quarantine rules, the same judgement the library makes, and a label a rule matches is shown,
// logged and served as "label withheld" — counted, never named, which is the invariant this estate
// has had to repair in three separate surfaces.
export const WITHHELD = "label withheld";

export const nameFor = (row, judge) => {
  const own = row.owner_name || null;
  const label = row.label || null;
  if (own) return judge(own) ? WITHHELD : own;
  if (label) return judge(label) ? WITHHELD : label;
  return null;
};

// lsblk, read once per tick. Injected everywhere above so no test ever shells out.
export const lsblkJson = ({ exec = null } = {}) => {
  if (!exec) return [];
  const { rows } = parseLinuxVolumes(exec());
  return rows;
};

// --- the tick -----------------------------------------------------------------------------------
//
// ONE EVENT PER CHANGE, NOT PER TICK. The job runs every sixty seconds; a drive that has sat there
// all week must produce silence, or the estate's own log becomes the noise it exists to cut through.
// So the comparison is against the registry's `attached` column, and only a transition writes.
//
// A drive whose identity cannot be read is "attached, identity unknown" and is NEVER merged into
// another row: guessing which drive an unreadable root belongs to is how one disk's facts end up
// under another's name, which is the defect this whole contract is keyed by identity to avoid.
export function syncDrives(db, volumes = [], { now = () => new Date().toISOString() } = {}) {
  const at = now();
  const events = [];
  const unknown = [];
  const seen = new Set();

  for (const v of volumes) {
    if (!v.identity) {
      unknown.push({ root: v.root, medium: v.medium ?? null });
      continue;
    }
    seen.add(v.identity);
    const had = db
      .prepare("SELECT identity, attached FROM drives WHERE identity = ?")
      .get(v.identity);
    if (!had) {
      db.prepare(
        `INSERT INTO drives
           (identity, label, owner_name, filesystem, medium, capacity, free, root,
            first_seen, last_seen, attached, system, retired_at)
         VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, 1, ?, NULL)`
      ).run(
        v.identity,
        v.label ?? null,
        v.filesystem ?? null,
        v.medium ?? null,
        v.capacity ?? null,
        v.free ?? null,
        v.root ?? null,
        at,
        at,
        v.system ? 1 : 0
      );
      events.push({
        type: "drive_attached",
        identity: v.identity,
        root: v.root,
        medium: v.medium ?? null,
        first: true
      });
      continue;
    }
    // THE SAME ROW AT ANOTHER LETTER. The root is updated, the identity is the key, and the only
    // thing that makes this an event is that it was not attached a moment ago.
    db.prepare(
      `UPDATE drives SET label = ?, filesystem = ?, medium = ?, capacity = ?, free = ?, root = ?,
         last_seen = ?, attached = 1, system = ? WHERE identity = ?`
    ).run(
      v.label ?? null,
      v.filesystem ?? null,
      v.medium ?? null,
      v.capacity ?? null,
      v.free ?? null,
      v.root ?? null,
      at,
      v.system ? 1 : 0,
      v.identity
    );
    if (!had.attached)
      events.push({
        type: "drive_attached",
        identity: v.identity,
        root: v.root,
        medium: v.medium ?? null
      });
  }

  for (const row of db
    .prepare("SELECT identity, root, medium FROM drives WHERE attached = 1")
    .all())
    if (!seen.has(row.identity)) {
      db.prepare("UPDATE drives SET attached = 0 WHERE identity = ?").run(row.identity);
      events.push({
        type: "drive_detached",
        identity: row.identity,
        root: row.root,
        medium: row.medium
      });
    }

  return { events, unknown, at };
}

// --- reading it ---------------------------------------------------------------------------------
//
// `catalogue` answers when that identity's catalogue last finished, or null for never. Nothing is
// started from here: this surface tells the owner what is, and S21 is what acts.
export function readRegistry(
  db,
  { judge = () => false, freshDays = 30, now = Date.now, catalogue = () => null } = {}
) {
  const stale = (lastSeen) => {
    const t = Date.parse(lastSeen);
    return Number.isFinite(t) ? now() - t > freshDays * 86_400_000 : false;
  };
  const roots = db.prepare("SELECT * FROM user_roots WHERE identity = ? ORDER BY rowid");
  return db
    .prepare("SELECT * FROM drives ORDER BY attached DESC, last_seen DESC")
    .all()
    .map((r) => ({
      identity: r.identity,
      name: nameFor(r, judge),
      medium: r.medium,
      filesystem: r.filesystem,
      capacity: r.capacity,
      free: r.free,
      root: r.attached ? r.root : null,
      attached: Boolean(r.attached),
      system: Boolean(r.system),
      first_seen: r.first_seen,
      last_seen: r.last_seen,
      stale: !r.attached && stale(r.last_seen),
      retired_at: r.retired_at,
      catalogued_at: catalogue(r.identity) ?? null,
      // the system drive offers its USER ROOTS and never itself; a data drive offers itself
      offers: r.system ? "user-roots" : "whole",
      user_roots: roots.all(r.identity).map((u) => ({
        root: u.root,
        role: u.role,
        in_onedrive: Boolean(u.in_onedrive),
        added_by_owner: Boolean(u.added_by_owner)
      }))
    }));
}

export function recordUserRoots(db, found = []) {
  for (const u of found) {
    if (!u.identity || forbiddenRoot(u.root)) continue;
    db.prepare(
      `INSERT INTO user_roots (identity, root, role, in_onedrive, added_by_owner)
       VALUES (?, ?, ?, ?, 0)
       ON CONFLICT(identity, root) DO UPDATE SET role = excluded.role, in_onedrive = excluded.in_onedrive`
    ).run(u.identity, u.root, u.role, u.in_onedrive ? 1 : 0);
  }
}

// The two things the owner may set, both loopback-only at the route and both judged by the rules.
export const setOwnerName = (db, identity, name) =>
  db.prepare("UPDATE drives SET owner_name = ? WHERE identity = ?").run(name || null, identity)
    .changes > 0;

export function addUserRoot(db, identity, root, { identityOf = driveIdentity } = {}) {
  if (forbiddenRoot(root)) return { refused: `${root} is Windows' own, not the owner's data` };
  if (!db.prepare("SELECT 1 FROM drives WHERE identity = ?").get(identity))
    return { refused: "no drive of that identity has ever been seen here" };
  const on = identityOf(root);
  if (on && on !== identity)
    return { refused: "that folder is on a different drive from the one it was added to" };
  db.prepare(
    `INSERT INTO user_roots (identity, root, role, in_onedrive, added_by_owner)
     VALUES (?, ?, 'added', 0, 1) ON CONFLICT(identity, root) DO UPDATE SET added_by_owner = 1`
  ).run(identity, root);
  return { added: root };
}
