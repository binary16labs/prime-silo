// U0 acceptance tests — one block per Scenario in delivery/tasks/U0.md.
//
// Every OS call is injected. Nothing here shells out to PowerShell or lsblk: the fixtures are the
// shapes those tools really return, and a test that needs a USB drive plugged in is a test that
// only ever runs on one machine.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  driveIdentity,
  lsblkUuid,
  mediumOf,
  parseWindowsVolumes,
  parseLinuxVolumes,
  fillFromStatfs,
  openRegistry,
  registryPath,
  syncDrives,
  readRegistry,
  userRoots,
  recordUserRoots,
  setOwnerName,
  addUserRoot,
  forbiddenRoot,
  isDriveRoot,
  nameFor,
  WITHHELD,
  USER_ROOT_ORDER,
  UUID_PREFIX,
  sameVolume,
  labelProblem,
  driveEvent
} from "../server/coordination/lib/drive_registry.mjs";
import { rootIdentity } from "../server/coordination/lib/estate_compare.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";
import DriveWatchJob from "../server/jobs/drive_watch.js";
import http from "node:http";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "u0-"));
const db = () => openRegistry(path.join(tmp(), "drives.db"));

// A FOLDER OF OUR OWN, under neither a drive root nor AppData. These tests used process.cwd(),
// and a verifier ran the suite from a drive ROOT where cwd is that root - so "a folder identity
// is not its drive's" failed, which is true of every folder except a root, and the message would
// have sent a reader hunting a product bug that was not there. os.tmpdir() is no good either: on
// Windows it sits inside AppData, which this contract's own forbidden list rightly refuses. So a
// scratch folder beside the repo, which is neither.
const fixtures = [];
// removed at exit, because a folder left beside the repo shows up as untracked and a dirty
// worktree is how a verifier comes to measure something nobody wrote
process.on("exit", () => {
  for (const d of fixtures) fs.rmSync(d, { recursive: true, force: true });
});
const ownFolder = () => {
  const d = fs.mkdtempSync(path.join(process.cwd(), "u0-fixture-"));
  fixtures.push(d);
  return d;
};
const vol = (o) => ({
  label: null,
  filesystem: "NTFS",
  medium: "usb",
  capacity: 1,
  free: 1,
  system: false,
  ...o
});

// --- the OS, as it really answers ---------------------------------------------------------------

test("U0: Windows volumes parse, and the medium comes from the DISK's bus", () => {
  // Get-Volume knows the drive type; only Get-Disk knows whether it is USB. The join is the whole
  // reason this is one PowerShell call rather than two.
  const { rows } = parseWindowsVolumes(
    JSON.stringify([
      {
        DriveLetter: "C",
        FileSystemLabel: "Windows",
        FileSystem: "NTFS",
        Size: 500,
        SizeRemaining: 100,
        BusType: "NVMe",
        DriveType: "Fixed",
        IsSystem: true
      },
      {
        DriveLetter: "F",
        FileSystemLabel: "Elements",
        FileSystem: "NTFS",
        Size: 5000,
        SizeRemaining: 3400,
        BusType: "USB",
        DriveType: "Fixed"
      },
      {
        DriveLetter: "Z",
        FileSystemLabel: "nas",
        FileSystem: "SMB",
        BusType: null,
        DriveType: "Network"
      },
      { DriveLetter: null, FileSystemLabel: "no letter", BusType: "SATA", DriveType: "Fixed" }
    ])
  );
  assert.deepEqual(
    rows.map((r) => r.root),
    ["C:", "F:", "Z:"],
    "a volume with no letter is not a drive the owner has"
  );
  assert.deepEqual(
    rows.map((r) => r.medium),
    ["internal", "usb", "network"]
  );
  assert.equal(rows[0].system, true, "and C: knows it holds Windows");
  assert.equal(rows[1].capacity, 5000);
  assert.equal(rows[1].free, 3400);
  // unparsable is a stated failure, never an empty list pretending the machine has no drives
  assert.match(parseWindowsVolumes("not json").unreadable ?? "", /could not be parsed/u);
});

test("U0: lsblk parses, and the transport is inherited from the disk", () => {
  // lsblk nests partitions under their disk and puts `tran` on the parent, so a flat read would
  // call every partition's medium unknown.
  const { rows } = parseLinuxVolumes(
    JSON.stringify({
      blockdevices: [
        {
          name: "nvme0n1",
          tran: "nvme",
          hotplug: false,
          children: [
            {
              name: "nvme0n1p2",
              mountpoint: "/",
              uuid: "aaa",
              label: "root",
              fstype: "ext4",
              size: 500,
              fsavail: 100
            }
          ]
        },
        {
          name: "sda",
          tran: "usb",
          hotplug: true,
          children: [
            {
              name: "sda1",
              mountpoint: "/mnt/backup",
              uuid: "bbb",
              fstype: "ext4",
              size: 5000,
              fsavail: 3400
            }
          ]
        }
      ]
    })
  );
  assert.deepEqual(
    rows.map((r) => r.root),
    ["/", "/mnt/backup"]
  );
  assert.deepEqual(
    rows.map((r) => r.medium),
    ["internal", "usb"],
    "inherited, not guessed"
  );
  assert.equal(rows[0].system, true, "/ is the system root");
  assert.equal(rows[1].uuid, "bbb");
});

test("U0: a hotpluggable disk on an unknown bus is removable; an unknown one stays unknown", () => {
  assert.equal(mediumOf({ bus: "USB" }), "usb");
  assert.equal(mediumOf({ bus: "SATA" }), "internal");
  assert.equal(mediumOf({ driveType: "Network" }), "network");
  assert.equal(
    mediumOf({ bus: "Thunderbolt", hotplug: true }),
    "usb",
    "removable is the half that matters"
  );
  assert.equal(
    mediumOf({ bus: "Thunderbolt" }),
    null,
    "and an unknown bus is UNKNOWN, not a guess"
  );
  assert.equal(mediumOf({}), null);
});

test("U0: capacity missing from the OS is measured, never invented", () => {
  const row = { root: "X:", capacity: null, free: null };
  const filled = fillFromStatfs(row, { statfs: () => ({ bsize: 4096, blocks: 100, bavail: 25 }) });
  assert.equal(filled.capacity, 409_600);
  assert.equal(filled.free, 102_400);
  // and when the filesystem will not answer either, it stays null — "unknown" on the panel
  assert.equal(
    fillFromStatfs(row, {
      statfs: () => {
        throw new Error("no");
      }
    }).capacity,
    null
  );
  // a figure the OS DID give is never overwritten
  assert.equal(
    fillFromStatfs(
      { root: "X:", capacity: 7, free: 3 },
      { statfs: () => ({ bsize: 1, blocks: 9, bavail: 9 }) }
    ).capacity,
    7
  );
});

// --- Scenario: Windows identity is unchanged ----------------------------------------------------

test("Scenario: Windows identity is unchanged, so every catalogue still finds its drive", () => {
  // Every catalogue is named library-<identity>.db. A different spelling here would orphan every
  // catalogue the owner already has, including the 1.1-million-file F:.
  // A FIXTURE FOLDER, NOT cwd. A verifier ran the suite from C:' + chr(92) + ' and two of these failed on
  // "a folder's identity is NOT its drive's" - true of every folder except a drive root, which cwd
  // was there. The message would have sent a future reader hunting a product bug that is not there,
  // so the test makes its own folder and never asks where it happens to be standing.
  const here = ownFolder();
  assert.equal(
    driveIdentity(here, { platform: "win32" }),
    rootIdentity(here),
    "byte-identical to S21's value for the same root"
  );
  const letter = here.slice(0, 2);
  assert.equal(
    driveIdentity(letter, { platform: "win32" }),
    rootIdentity(letter),
    "and for a bare letter"
  );

  // on Linux it is the UUID, and it does NOT move when the device number does
  const uuidOf = () => "1234-ABCD";
  assert.equal(
    driveIdentity("/mnt/backup", { platform: "linux", uuidOf }),
    `${UUID_PREFIX}1234-ABCD`
  );
  assert.equal(
    driveIdentity("/mnt/backup", { platform: "linux", uuidOf: () => null }),
    null,
    "unreadable is null, not a guess"
  );
  // and the reader walks lsblk's nesting: a partition's UUID sits under its disk, not beside it
  assert.equal(
    lsblkUuid("/mnt/backup", {
      exec: () =>
        JSON.stringify({
          blockdevices: [
            { name: "sda", children: [{ mountpoint: "/mnt/backup", uuid: "zzz" }] },
            { name: "nvme0n1", children: [{ mountpoint: "/", uuid: "aaa" }] }
          ]
        })
    }),
    "zzz"
  );
  assert.equal(lsblkUuid("/mnt/backup", { exec: () => "not json" }), null, "unparsable is null");
  assert.equal(lsblkUuid("/mnt/backup"), null, "and with no reader it never shells out");
});

// --- Scenario: a drive at a new letter is the same drive -----------------------------------------

test("Scenario: a drive at a new letter is the same drive", () => {
  const d = db();
  const first = syncDrives(d, [vol({ identity: "id-backup", root: "G:", label: "Backup" })], {
    now: () => "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(
    first.events.map((e) => e.type),
    ["drive_attached"]
  );

  // unplugged, then back at a different letter
  syncDrives(d, [], { now: () => "2026-01-02T00:00:00Z" });
  const again = syncDrives(d, [vol({ identity: "id-backup", root: "H:", label: "Backup" })], {
    now: () => "2026-01-03T00:00:00Z"
  });
  assert.deepEqual(
    again.events.map((e) => e.type),
    ["drive_attached"],
    "exactly one, not one per tick"
  );
  assert.equal(again.events[0].root, "H:");

  const rows = readRegistry(d);
  assert.equal(rows.length, 1, "ONE row: the letter changed, the drive did not");
  assert.equal(rows[0].root, "H:");
  assert.equal(
    rows[0].first_seen,
    "2026-01-01T00:00:00Z",
    "and it remembers when it first appeared"
  );
});

test("Scenario: an unplugged drive is remembered, not forgotten", () => {
  const d = db();
  syncDrives(d, [vol({ identity: "id-f", root: "F:" })], { now: () => "2026-01-01T00:00:00Z" });
  const gone = syncDrives(d, [], { now: () => "2026-01-02T00:00:00Z" });
  assert.deepEqual(
    gone.events.map((e) => e.type),
    ["drive_detached"]
  );

  const [row] = readRegistry(d);
  assert.equal(row.attached, false);
  assert.equal(row.root, null, "no letter is claimed for a drive that is not there");
  assert.equal(row.last_seen, "2026-01-01T00:00:00Z", "last seen is when it was last SEEN");

  // and a quiet tick is quiet: the job runs every sixty seconds and must not narrate
  assert.deepEqual(syncDrives(d, [], { now: () => "2026-01-03T00:00:00Z" }).events, []);
  const stillThere = syncDrives(d, [vol({ identity: "id-f", root: "F:" })], {
    now: () => "2026-01-04T00:00:00Z"
  });
  assert.deepEqual(
    stillThere.events.map((e) => e.type),
    ["drive_attached"]
  );
  assert.deepEqual(
    syncDrives(d, [vol({ identity: "id-f", root: "F:" })], { now: () => "2026-01-05T00:00:00Z" })
      .events,
    [],
    "nothing changed, nothing said"
  );
});

test("U0: an unreadable identity is reported, and never merged with another drive", () => {
  // Guessing which drive an unreadable root belongs to is how one disk's facts end up under
  // another's name — the defect this registry is keyed by identity to avoid.
  const d = db();
  syncDrives(d, [vol({ identity: "id-a", root: "F:" })], { now: () => "2026-01-01T00:00:00Z" });
  const r = syncDrives(
    d,
    [vol({ identity: "id-a", root: "F:" }), vol({ identity: null, root: "G:" })],
    {
      now: () => "2026-01-02T00:00:00Z"
    }
  );
  assert.deepEqual(
    r.unknown,
    [{ root: "G:", medium: "usb" }],
    "reported as attached, identity unknown"
  );
  assert.equal(readRegistry(d).length, 1, "and never folded into the drive that IS known");
});

// --- Scenario: stale --------------------------------------------------------------------------

test("Scenario: a drive not seen for longer than the freshness window is stale", () => {
  const d = db();
  const DAY = 86_400_000;
  const base = Date.parse("2026-02-01T00:00:00Z");
  syncDrives(d, [vol({ identity: "id-old", root: "G:" })], {
    now: () => new Date(base).toISOString()
  });
  syncDrives(d, [], { now: () => new Date(base).toISOString() });

  const at = (days) => () => base + days * DAY;
  assert.equal(readRegistry(d, { freshDays: 30, now: at(31) })[0].stale, true);
  assert.equal(readRegistry(d, { freshDays: 30, now: at(29) })[0].stale, false);
  assert.equal(
    readRegistry(d, { freshDays: 60, now: at(31) })[0].stale,
    false,
    "the window is a parameter, not a constant"
  );

  // an ATTACHED drive is never stale: it is right here
  syncDrives(d, [vol({ identity: "id-old", root: "G:" })], {
    now: () => new Date(base).toISOString()
  });
  assert.equal(readRegistry(d, { freshDays: 30, now: at(999) })[0].stale, false);
});

// --- Scenario: the Windows system drive ---------------------------------------------------------

test("Scenario: on the Windows system drive only the user's data is offered", () => {
  // A guessed C:\Users\<name>\Documents is wrong on this very machine, where Documents, Desktop
  // and Pictures live in OneDrive. The User Shell Folders key follows the redirection.
  // SHAPED LIKE THE REAL THING: <volume serial>-<file id>. On this machine C:\ is
  // 1579050461-1407374883553285 and C:\Users\nsdha\Downloads is 1579050461-1970324837089507 — the
  // SAME drive, a different file. A fixture using opaque labels like "id-c" could not see that the
  // first version compared WHOLE identities, so every user root was filed under its own file id and
  // the Drives tab showed none of them.
  let file = 0;
  const identityOf = (pp) => (pp.toLowerCase().startsWith("d:") ? "222" : "111") + "-" + ++file;
  const found = userRoots(
    {
      "{374DE290-123F-4565-9164-39C4925E467B}": "C:\\Users\\nsdha\\Downloads",
      Personal: "C:\\Users\\nsdha\\OneDrive\\Documents",
      Desktop: "C:\\Users\\nsdha\\OneDrive\\Desktop",
      "My Pictures": "D:\\Pictures",
      "My Music": "C:\\Windows\\Media",
      Favorites: "C:\\Users\\nsdha\\Favorites"
    },
    { oneDrive: "C:\\Users\\nsdha\\OneDrive", identityOf }
  );

  assert.equal(
    found[0].role,
    "downloads",
    "DOWNLOADS IS FIRST: it is where unsorted weight collects"
  );
  assert.deepEqual(
    found.map((r) => r.role),
    ["downloads", "documents", "desktop", "pictures", "onedrive"]
  );
  assert.equal(
    found.find((r) => r.role === "documents").in_onedrive,
    true,
    "redirection is followed, not guessed"
  );
  assert.equal(found.find((r) => r.role === "downloads").in_onedrive, false);
  assert.match(
    found.find((r) => r.role === "pictures").identity,
    /^222-/u,
    "and Pictures is recorded against the drive it is really on"
  );
  assert.equal(
    found.some((r) => r.role === "music"),
    false,
    "a folder redirected into Windows is not the owner's data"
  );
  assert.equal(
    found.some((r) => r.root.includes("Favorites")),
    false,
    "and a key with no role is not invented one"
  );

  // NEVER the drive whole, and never these
  for (const bad of [
    "C:\\Windows",
    "C:\\Program Files",
    "C:\\Program Files (x86)",
    "C:\\ProgramData",
    "C:\\Users\\nsdha\\AppData\\Local",
    "/home/x/AppData"
  ])
    assert.equal(forbiddenRoot(bad), true, `${bad} is never the owner's data`);
  for (const ok of ["C:\\Users\\nsdha\\Downloads", "F:\\", "/mnt/backup"])
    assert.equal(forbiddenRoot(ok), false, `${ok} is`);

  const d = db();
  syncDrives(
    d,
    [
      vol({ identity: "111-root", root: "C:", system: true }),
      vol({ identity: "999-root", root: "F:" })
    ],
    {
      now: () => "2026-01-01T00:00:00Z"
    }
  );
  recordUserRoots(d, found);
  const rows = readRegistry(d);
  const c = rows.find((r) => r.identity === "111-root");
  const f = rows.find((r) => r.identity === "999-root");
  assert.equal(c.offers, "user-roots", "the system drive is offered only through its user roots");
  assert.equal(f.offers, "whole", "a data drive is offered whole");
  assert.deepEqual(
    c.user_roots.map((u) => u.role),
    ["downloads", "documents", "desktop", "onedrive"],
    "and only the ones on C:"
  );
  assert.equal(c.user_roots[0].role, "downloads");
});

test("U0: the owner may add a folder, and may not add Windows' own", () => {
  const d = db();
  syncDrives(d, [vol({ identity: "111-root", root: "C:", system: true })], {
    now: () => "2026-01-01T00:00:00Z"
  });

  const ok = addUserRoot(d, "111-root", "C:\\Projects", { identityOf: () => "111-9" });
  assert.deepEqual(ok, { added: "C:\\Projects" });
  const added = readRegistry(d)[0].user_roots.find((u) => u.root === "C:\\Projects");
  assert.equal(
    added.added_by_owner,
    true,
    "and it is recorded as the owner's choice, not discovered"
  );

  for (const bad of [
    "C:\\Windows\\Temp",
    "C:\\Program Files\\x",
    "C:\\ProgramData",
    "C:\\Users\\x\\AppData\\Roaming"
  ])
    assert.match(addUserRoot(d, "111-root", bad).refused ?? "", /Windows' own/u, bad);
  assert.match(addUserRoot(d, "999-nope", "C:\\x").refused ?? "", /ever been seen here/u);
  assert.match(
    addUserRoot(d, "111-root", "E:\\elsewhere", { identityOf: () => "333-7" }).refused ?? "",
    /different drive/u,
    "a folder on another disk is not this drive's user root"
  );
});

// --- Scenario: a private label ------------------------------------------------------------------

test("Scenario: a private label is withheld", () => {
  // A volume label is the owner's own text, and so is a display name they type. Both are judged by
  // the same rules the library uses: counted, never named.
  const judge = (t) => /passport/iu.test(t);
  assert.equal(nameFor({ label: "Elements" }, judge), "Elements");
  assert.equal(nameFor({ label: "passport scans" }, judge), WITHHELD);
  assert.equal(
    nameFor({ label: "Elements", owner_name: "my passport drive" }, judge),
    WITHHELD,
    "an owner name is judged too"
  );
  assert.equal(
    nameFor({ label: "passport scans", owner_name: "Backup" }, judge),
    "Backup",
    "and a clean name replaces a private label"
  );
  assert.equal(
    nameFor({}, judge),
    null,
    "no name is null, not an empty string pretending to be one"
  );

  const d = db();
  syncDrives(d, [vol({ identity: "id-p", root: "G:", label: "passport scans" })], {
    now: () => "2026-01-01T00:00:00Z"
  });
  const [row] = readRegistry(d, { judge });
  assert.equal(row.name, WITHHELD);
  assert.equal(
    JSON.stringify(row).includes("passport"),
    false,
    "the label itself is nowhere in the answer"
  );

  assert.equal(setOwnerName(d, "id-p", "Old Backup"), true);
  assert.equal(readRegistry(d, { judge })[0].name, "Old Backup");
  assert.equal(setOwnerName(d, "id-nope", "x"), false, "and an unknown identity sets nothing");
});

test("U0: the catalogue column reads S21's pass and starts nothing", () => {
  const d = db();
  syncDrives(d, [vol({ identity: "id-f", root: "F:" }), vol({ identity: "id-new", root: "G:" })], {
    now: () => "2026-01-01T00:00:00Z"
  });
  const asked = [];
  const rows = readRegistry(d, {
    catalogue: (row) => {
      asked.push(row);
      return row.identity === "id-f" ? { at: "2026-10-25T12:00:00Z" } : { at: null };
    }
  });
  // the whole ROW, because an attached drive's catalogue is found by its ROOT and a detached one
  // cannot be found at all without a second spelling of S21's naming rule
  assert.deepEqual(asked.map((r) => r.identity).sort(), ["id-f", "id-new"]);
  assert.ok(
    asked.every((r) => r.attached && r.root),
    "with the root it is attached at"
  );
  assert.equal(rows.find((r) => r.identity === "id-f").catalogued_at, "2026-10-25T12:00:00Z");
  assert.equal(
    rows.find((r) => r.identity === "id-new").catalogued_at,
    null,
    "never catalogued is null, not zero"
  );

  // A DETACHED DRIVE'S DATE IS UNKNOWN, NOT NEVER. Conflating the two would tell the owner that a
  // drive they have catalogued never was, which is worse than admitting it cannot be read.
  syncDrives(d, [], { now: () => "2026-01-02T00:00:00Z" });
  const away = readRegistry(d, {
    catalogue: ({ attached }) => (attached ? { at: "x" } : { unknown: "the drive is not here" })
  });
  assert.equal(away[0].catalogued_at, null);
  assert.match(away[0].catalogue_unknown ?? "", /not here/u);
});

test("U0: retired_at is reserved for U9 and is always null here", () => {
  const d = db();
  syncDrives(d, [vol({ identity: "id-f", root: "F:" })], { now: () => "2026-01-01T00:00:00Z" });
  assert.equal(readRegistry(d)[0].retired_at, null);
  assert.deepEqual(
    USER_ROOT_ORDER[0],
    "downloads",
    "and the order is a declared list, not an accident of iteration"
  );
  assert.match(
    registryPath("C:\\home"),
    /estate[\\/]drives\.db$/u,
    "the registry lives on the machine, not on a drive"
  );
});

// --- the defaults, which is where all four live defects were ------------------------------------
//
// A verifier found D3, D4 and D5 with one observation: every guard in this contract was tested only
// through an INJECTED STUB that behaved as I had assumed, and the real function was wired in
// nowhere. Each defect needed exactly one test calling the thing WITH ITS OWN DEFAULTS. These are
// those tests, and they are the ones that would have caught the three things that did not work.

test("U0: a user root reaches the drive it is on, WITH ITS OWN DEFAULTS", async () => {
  // THE CONTRACT'S WHOLE POINT, and it was broken: recordUserRoots keyed each root by the FOLDER's
  // identity while readRegistry looked them up by the DRIVE's. A Windows identity is
  // <volume>-<file>, so those never matched and `GET /drives` returned offers:"user-roots" with
  // user_roots: [] — the roots read correctly from Windows and shown to nobody.
  // A FIXTURE FOLDER, NOT cwd. A verifier ran the suite from C:' + chr(92) + ' and two of these failed on
  // "a folder's identity is NOT its drive's" - true of every folder except a drive root, which cwd
  // was there. The message would have sent a future reader hunting a product bug that is not there,
  // so the test makes its own folder and never asks where it happens to be standing.
  const here = ownFolder();
  const driveRoot = `${here.slice(0, 2)}\\`;
  const d = db();

  // the real driveIdentity, on real paths, with no stub anywhere
  const driveId = driveIdentity(driveRoot);
  const folderId = driveIdentity(here);
  assert.ok(driveId && folderId, "both are readable on this machine");
  assert.notEqual(driveId, folderId, "a folder's identity is NOT its drive's — that is the defect");
  assert.ok(sameVolume(driveId, folderId), "but they share the volume, which is how it is found");

  syncDrives(d, [vol({ identity: driveId, root: here.slice(0, 2), system: true })], {
    now: () => "2026-01-01T00:00:00Z"
  });
  recordUserRoots(d, [{ role: "downloads", root: here, identity: folderId, in_onedrive: false }]);

  const [row] = readRegistry(d);
  assert.equal(row.offers, "user-roots");
  assert.deepEqual(
    row.user_roots.map((u) => u.root),
    [here],
    `the root reaches its drive: ${JSON.stringify(row.user_roots)}`
  );

  // and a root on a drive this machine has never seen is skipped, not filed under its own file id
  const other = db();
  syncDrives(other, [vol({ identity: "999-root", root: "Q:" })], {
    now: () => "2026-01-01T00:00:00Z"
  });
  recordUserRoots(other, [
    { role: "downloads", root: here, identity: folderId, in_onedrive: false }
  ]);
  assert.deepEqual(readRegistry(other)[0].user_roots, []);
});

test("U0: the owner may add a real folder, WITH ITS OWN DEFAULTS", async () => {
  // The same inversion from the other side: `on !== identity` was true for every folder that
  // exists, so every real path was refused with "that folder is on a different drive" — and a path
  // that does NOT exist made identityOf null, the guard fell open, and it was added.
  // A FIXTURE FOLDER, NOT cwd. A verifier ran the suite from C:' + chr(92) + ' and two of these failed on
  // "a folder's identity is NOT its drive's" - true of every folder except a drive root, which cwd
  // was there. The message would have sent a future reader hunting a product bug that is not there,
  // so the test makes its own folder and never asks where it happens to be standing.
  const here = ownFolder();
  const d = db();
  syncDrives(
    d,
    [
      vol({
        identity: driveIdentity(`${here.slice(0, 2)}\\`),
        root: here.slice(0, 2),
        system: true
      })
    ],
    {
      now: () => "2026-01-01T00:00:00Z"
    }
  );
  const identity = readRegistry(d)[0].identity;

  // no identityOf injected: the real one, on a real folder
  assert.deepEqual(addUserRoot(d, identity, here), { added: here });
  assert.ok(readRegistry(d)[0].user_roots.some((u) => u.root === here && u.added_by_owner));

  // and the one that used to slip through: a path that cannot be read
  assert.match(
    addUserRoot(d, identity, `${here.slice(0, 2)}\\no-such-place-91af`).refused ?? "",
    /cannot be read/u
  );
});

test("U0: the label judge is the estate's own rule match, not a path validator", () => {
  // D5: the first version called volumeNameProblem, which validates a volume PATH and refuses
  // anything that is not one — so EVERY label read "withheld" with no rule matching, on a machine
  // whose drives are called Elements and WD_BLACK. Fail-safe in direction and useless in fact.
  for (const plain of ["Elements", "WD_BLACK", "Backup", "F:", "my stuff", ""])
    assert.equal(labelProblem(plain, ["passport"]), null, `${plain} is not private`);
  for (const private_ of ["passport scans", "My Passport", "old passports"])
    assert.ok(labelProblem(private_, ["passport"]), `${private_} is`);
  assert.ok(labelProblem("holiday snaps", [/snaps/u]), "a RegExp rule works too");
  assert.equal(labelProblem("anything", []), null, "and with no rules, nothing is private");

  // through the registry's own read, with the real judge rather than a stub
  const d = db();
  syncDrives(d, [vol({ identity: "111-root", root: "G:", label: "Elements" })], {
    now: () => "2026-01-01T00:00:00Z"
  });
  const judge = (text) => Boolean(labelProblem(text, ["passport"]));
  assert.equal(
    readRegistry(d, { judge })[0].name,
    "Elements",
    "the owner can see their drive's name"
  );
});

test("U0: the ledger event carries the drive, never its label", () => {
  // The one surface where this estate has repaired privacy before (S22's D11), and a mutation
  // putting the label into the payload died nowhere, because driveEvent was imported by no test.
  const e = driveEvent({
    machine: "t480",
    type: "drive_attached",
    identity: "111-root",
    root: "G:",
    medium: "usb",
    at: "2026-01-01T00:00:00Z"
  });
  assert.deepEqual(Object.keys(e.payload).sort(), ["identity", "medium", "root", "scope"]);
  assert.equal(e.payload.identity, "111-root");
  assert.equal(e.subject.kind, "drive");
  // nothing a caller hands it can add a field, and a label is not among the ones it has
  const sneaky = driveEvent({
    machine: "t480",
    type: "drive_attached",
    identity: "111-root",
    root: "G:",
    medium: "usb",
    label: "passport scans",
    owner_name: "my passport drive"
  });
  const body = JSON.stringify(sneaky);
  for (const leak of ["passport", "owner_name", "label"])
    assert.equal(body.includes(leak), false, `no ${leak} in the ledger`);
});

test("U0: a root the rules forbid is never recorded, whatever asks", () => {
  // A mutation deleting recordUserRoots' own guard died nowhere: the only coverage was through
  // userRoots, which filters first, so the registry's own door was unguarded.
  const d = db();
  syncDrives(d, [vol({ identity: "111-root", root: "C:", system: true })], {
    now: () => "2026-01-01T00:00:00Z"
  });
  recordUserRoots(d, [
    { role: "downloads", root: "C:\\Windows\\Temp", identity: "111-2", in_onedrive: false },
    {
      role: "documents",
      root: "C:\\Users\\x\\AppData\\Roaming",
      identity: "111-3",
      in_onedrive: false
    },
    { role: "added", root: "C:\\Projects", identity: "111-4", in_onedrive: false }
  ]);
  assert.deepEqual(
    readRegistry(d)[0].user_roots.map((u) => u.root),
    ["C:\\Projects"],
    "only the one that is the owner's own data"
  );
});

test("U0: a folder's real spelling is what the forbidden list judges", () => {
  // D7: the list was textual, so a verifier walked past it with an 8.3 name, a trailing dot, a
  // trailing space, an alternate-data-stream spelling, and a junction pointing into C:\Windows —
  // through which they listed all 120 of its entries.
  for (const bad of [
    "C:\\PROGRA~1",
    "C:\\Windows.",
    "C:\\Windows ",
    "C:\\WINDOWS",
    "C:\\Windows::$INDEX_ALLOCATION",
    "C:\\Users\\x\\AppData\\Local",
    "C:/Windows/System32",
    "\\\\?\\C:\\Windows"
  ])
    assert.equal(forbiddenRoot(bad), true, `${bad} is never the owner's data`);
  for (const ok of ["C:\\Users\\nsdha\\Downloads", "F:\\", "C:\\Projects", "/mnt/backup"])
    assert.equal(forbiddenRoot(ok), false, `${ok} is`);
});

// --- the job and the route: TDD items 3 and 2, which had no tests at all ------------------------
//
// A verifier's sharpest line about this contract: "the three things with no test are the three
// things that do not work." The job could not run at all — `require` in an ES module, throwing on
// every tick — and nothing in this suite ever called run(); every test drove the exported tick().

test("U0: the job is disabled without a home, and runs when it has one", async (ctx) => {
  const job = new DriveWatchJob({ jobId: "drive_watch" });
  const had = process.env.BENNY_HOME;
  try {
    delete process.env.BENNY_HOME;
    assert.equal(
      job.isEnabled(),
      false,
      "no home, no registry: F: comes and goes, the home does not"
    );
    assert.deepEqual(await job.run({}), { skipped: "no BENNY_HOME" });

    process.env.BENNY_HOME = tmp();
    assert.equal(job.isEnabled(), true);
    assert.ok(job.getSchedule().everyMs >= 5_000, "and it has a schedule");
  } finally {
    if (had === undefined) delete process.env.BENNY_HOME;
    else process.env.BENNY_HOME = had;
  }
  ctx.diagnostic("run() is exercised with the real os.hostname path in the next test");
});

test("U0: run() reaches the registry rather than throwing on its own imports", async () => {
  // THE DEFECT THIS TEST EXISTS FOR: `require("node:os")` in a type:module package threw
  // ReferenceError on EVERY tick with ESTATE_MACHINE unset, which is the default — so the registry
  // was never written on a default install, and the runner logged a failure nobody read.
  const had = { home: process.env.BENNY_HOME, machine: process.env.ESTATE_MACHINE };
  const home = tmp();
  try {
    process.env.BENNY_HOME = home;
    delete process.env.ESTATE_MACHINE; // the default, and the only path that used `require`
    const job = new DriveWatchJob({ jobId: "drive_watch" });
    let thrown = null;
    try {
      await job.run({});
    } catch (e) {
      thrown = e;
    }
    // it must NOT fail on its own imports
    assert.equal(
      /require is not defined|is not a function/u.test(String(thrown?.message ?? "")),
      false,
      `the job must reach its work, not die on its imports: ${thrown?.message}`
    );
    // it reached the registry: the file exists whether or not the ledger would take the events
    assert.ok(fs.existsSync(registryPath(home)), "the registry was opened and written");
    // AND IF THE LEDGER REFUSES, THAT IS THROWN, not whispered to a logger the runner does not pass
    if (thrown) assert.match(thrown.message, /ledger refused/u, thrown.message);
  } finally {
    if (had.home === undefined) delete process.env.BENNY_HOME;
    else process.env.BENNY_HOME = had.home;
    if (had.machine !== undefined) process.env.ESTATE_MACHINE = had.machine;
  }
});

test("U0: the route answers the registry, loopback only, with the user roots attached", async () => {
  // TDD item 2 had no tests, so nothing noticed that the answer's user_roots were always empty.
  // A FIXTURE FOLDER, NOT cwd. A verifier ran the suite from C:' + chr(92) + ' and two of these failed on
  // "a folder's identity is NOT its drive's" - true of every folder except a drive root, which cwd
  // was there. The message would have sent a future reader hunting a product bug that is not there,
  // so the test makes its own folder and never asks where it happens to be standing.
  const here = ownFolder();
  const letter = here.slice(0, 2);
  const store = tmp();
  const home = tmp();
  fs.mkdirSync(path.join(home, "estate"), { recursive: true });

  const d = openRegistry(registryPath(home));
  syncDrives(
    d,
    [vol({ identity: driveIdentity(`${letter}\\`), root: letter, system: true, label: "Windows" })],
    {
      now: () => "2026-01-01T00:00:00Z"
    }
  );
  recordUserRoots(d, [
    { role: "downloads", root: here, identity: driveIdentity(here), in_onedrive: false }
  ]);
  d.close();

  const api = createEstateApi({
    quarantine: ["passport"],
    producer: {
      machine: "t480",
      dbPath: path.join(home, "estate", "estate-map-t480.db"),
      roots: () => [letter],
      estateStore: store
    }
  });
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end();
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  try {
    const base = `http://127.0.0.1:${server.address().port}/api/estate`;
    const r = await fetch(`${base}/drives`);
    assert.equal(r.status, 200);
    const { drives } = await r.json();
    assert.equal(drives.length, 1);
    assert.equal(drives[0].name, "Windows", "a plain label is SHOWN, not withheld");
    assert.equal(drives[0].offers, "user-roots");
    assert.deepEqual(
      drives[0].user_roots.map((u) => u.root),
      [here],
      `the roots reach the answer: ${JSON.stringify(drives[0].user_roots)}`
    );

    // PATCH sets the name, and the name is judged by the same rules
    const named = await fetch(`${base}/drives/${encodeURIComponent(drives[0].identity)}`, {
      method: "PATCH",
      body: JSON.stringify({ owner_name: "my passport drive" })
    });
    assert.equal(named.status, 200);
    const after = (await (await fetch(`${base}/drives`)).json()).drives[0];
    assert.equal(after.name, WITHHELD, "an owner-typed name is the owner's own text too");
    assert.equal(JSON.stringify(after).includes("passport"), false);

    assert.equal((await fetch(`${base}/drives`, { method: "DELETE" })).status, 405);
  } finally {
    await new Promise((r) => server.close(r));
  }
});

// --- round 3: the three fixes that shipped with nothing holding them ----------------------------
//
// A verifier deleted each of these and all 113 tests stayed green — in the contract whose round-1
// finding was "the three things with no test are the three things that do not work". Each needed
// one assertion.

test("U0: a refused ledger write reaches the runner", async () => {
  // The throw was the fix for D2 and nothing held it. Driven through an injected step so the test
  // does not depend on the KEL schema's enum, which is what refuses today and which the owner may
  // fix tomorrow — an assertion resting on that would stop testing anything the day it lands.
  const had = process.env.BENNY_HOME;
  try {
    process.env.BENNY_HOME = tmp();
    const job = new DriveWatchJob({ jobId: "drive_watch" });
    await assert.rejects(
      () =>
        job.run(
          {},
          { step: async () => ({ events: 1, written: 0, refused: "'type' not one of …" }) }
        ),
      /ledger refused/u,
      "a ledger that refused must reach the one channel the runner reads"
    );
    // and a clean tick returns rather than throwing
    const ok = await job.run({}, { step: async () => ({ events: 0, written: 0, refused: null }) });
    assert.equal(ok.refused, null);
  } finally {
    if (had === undefined) delete process.env.BENNY_HOME;
    else process.env.BENNY_HOME = had;
  }
});

test("U0: the whole drive cannot be added however it is spelt", async () => {
  // Five spellings got the system drive in as a user root — every one resolving to C:\ — which
  // hands U1 and the Library 2,261,759 files and 494 GB, the exact overhead the owner's direction
  // of 2026-10-11 exists to cut. My first guard was a textual regex on the GIVEN spelling, two
  // lines below an identity check on the RESOLVED thing: what forbiddenRoot had just been fixed for.
  // A FIXTURE FOLDER, NOT cwd. A verifier ran the suite from C:' + chr(92) + ' and two of these failed on
  // "a folder's identity is NOT its drive's" - true of every folder except a drive root, which cwd
  // was there. The message would have sent a future reader hunting a product bug that is not there,
  // so the test makes its own folder and never asks where it happens to be standing.
  const here = ownFolder();
  const letter = here.slice(0, 2);
  const d = db();
  syncDrives(d, [vol({ identity: driveIdentity(`${letter}\\`), root: letter, system: true })], {
    now: () => "2026-01-01T00:00:00Z"
  });
  const identity = readRegistry(d)[0].identity;

  for (const whole of [letter, `${letter}\\`, `${letter}\\.`, `${letter}\\.\\`, ` ${letter}\\ `])
    assert.match(
      addUserRoot(d, identity, whole).refused ?? "",
      /the whole drive/u,
      `${whole} is the drive, not a folder on it`
    );
  // and the ones that resolve UP to the root, which the regex could never see
  assert.equal(
    isDriveRoot(`${letter}\\Users\\..`),
    true,
    "a path that resolves to the root IS the root"
  );
  assert.equal(isDriveRoot(`${letter}\\Users`), false, "and a real folder is not");
});

test("U0: the panel asks the hub for the drives", async () => {
  // D6's fix was one call and nothing held it: a verifier deleted this.loadDrives() from the page
  // and every test stayed green, so the tab could go back to reading "no drive has been seen yet"
  // for ever — this contract's Goal sentence — without a single failure.
  const js = fs.readFileSync(
    new URL("../app/L0/_all/mod/_prime_silo/estate_map/estate_map.js", import.meta.url),
    "utf8"
  );
  assert.match(js, /fetch\(\s*"\/api\/estate\/drives"\s*\)/u, "it reads the drives route");
  assert.match(js, /this\.loadDrives\(\)/u, "and calls it with the rest of the page, not never");

  // AND THE VIEW SAYS CANNOT-TELL RATHER THAN EMPTY. drivesProblem was written in three places and
  // read in none, so a 503 told the owner no drive had ever been seen — as a fact.
  const html = fs.readFileSync(
    new URL("../app/L0/_all/mod/_prime_silo/estate_map/view.html", import.meta.url),
    "utf8"
  );
  assert.match(html, /x-if="drivesProblem"/u, "a hub that could not answer says so");
  assert.match(html, /!drivesProblem && !drives\.length/u, "and empty means empty, not unasked");
});
