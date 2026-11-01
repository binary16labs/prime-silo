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
  nameFor,
  WITHHELD,
  USER_ROOT_ORDER,
  UUID_PREFIX
} from "../server/coordination/lib/drive_registry.mjs";
import { rootIdentity } from "../server/coordination/lib/estate_compare.mjs";

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "u0-"));
const db = () => openRegistry(path.join(tmp(), "drives.db"));
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
  const here = process.cwd();
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
  const identityOf = (p) => (p.toLowerCase().startsWith("d:") ? "id-d" : "id-c");
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
  assert.equal(
    found.find((r) => r.role === "pictures").identity,
    "id-d",
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
    [vol({ identity: "id-c", root: "C:", system: true }), vol({ identity: "id-f", root: "F:" })],
    {
      now: () => "2026-01-01T00:00:00Z"
    }
  );
  recordUserRoots(d, found);
  const rows = readRegistry(d);
  const c = rows.find((r) => r.identity === "id-c");
  const f = rows.find((r) => r.identity === "id-f");
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
  syncDrives(d, [vol({ identity: "id-c", root: "C:", system: true })], {
    now: () => "2026-01-01T00:00:00Z"
  });

  const ok = addUserRoot(d, "id-c", "C:\\Projects", { identityOf: () => "id-c" });
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
    assert.match(addUserRoot(d, "id-c", bad).refused ?? "", /Windows' own/u, bad);
  assert.match(addUserRoot(d, "id-nope", "C:\\x").refused ?? "", /ever been seen here/u);
  assert.match(
    addUserRoot(d, "id-c", "E:\\elsewhere", { identityOf: () => "id-other" }).refused ?? "",
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
