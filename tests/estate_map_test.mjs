// S0 — estate map model. Each Scenario in delivery/tasks/S0.md maps to a test here.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  openMap,
  runSweep,
  publishSweep,
  readSnapshot,
  mapLogFile,
  categorize
} from "../server/coordination/lib/estate_map.mjs";
import { readKelEvents } from "../server/coordination/lib/kel.mjs";
import { resolveBlob } from "../server/coordination/lib/staging.mjs";

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "estate-map-"));
  return {
    db: openMap(path.join(base, "map", "estate-map-t480.db")),
    estate: path.join(base, "estate-store")
  };
}

const files = (volume, rows, { volumes = [volume] } = {}) => ({
  name: "fixture-files",
  kind: "files",
  volumes,
  async *collect({ volume: v }) {
    for (const r of rows) if (r.path.startsWith(v)) yield r;
  }
});

const blobFile = (estate, snapshot) => resolveBlob(estate, snapshot.replace(/^sha256:/u, ""));

test("Scenario: a sweep with a failing collector still publishes, and says which failed", async () => {
  const { db, estate } = setup();
  const good = files("F:", [
    { path: "F:/media/Movies/a.mkv", size: 1000, mtimeMs: 1 },
    { path: "F:/nas/models/qwen.gguf", size: 5000, mtimeMs: 2 }
  ]);
  const broken = {
    name: "registry-apps",
    kind: "apps",
    collect: async function* () {
      throw new Error("reg query denied");
    }
  };

  const sweep = await runSweep({ db, machine: "t480", collectors: [good, broken], scope: ["F:"] });
  const { event, snapshot } = await publishSweep({ db, sweep, estateRoot: estate });

  const { header, rows } = await readSnapshot(snapshot.path);
  assert.equal(header.counts.files, 2);
  assert.deepEqual(
    rows
      .filter((r) => r.t === "file")
      .map((r) => r.path)
      .sort(),
    ["F:/media/Movies/a.mkv", "F:/nas/models/qwen.gguf"]
  );

  const apps = event.payload.collectors.find((c) => c.kind === "apps");
  assert.equal(apps.status, "errored");
  assert.equal(apps.error_code, "UNKNOWN");
  assert.ok(!JSON.stringify(event).includes("reg query denied"), "no error text is ever published");
  assert.equal(event.payload.collectors.find((c) => c.kind === "files").status, "ok");

  const log = readKelEvents(mapLogFile(estate, "t480"));
  assert.ok(log.ok);
  assert.equal(log.events[0].payload.snapshot, `sha256:${snapshot.hash}`);
});

test("Scenario: quarantined paths never leave the node as paths", async () => {
  const { db, estate } = setup();
  const secret = "C:/Users/x/Documents/cv-2026.docx";
  const sweep = await runSweep({
    db,
    machine: "optimus",
    collectors: [
      files("C:", [
        { path: secret, size: 42000 },
        { path: "C:/Users/x/Documents/notes.txt", size: 10 }
      ])
    ],
    scope: ["C:"],
    quarantine: ["cv"]
  });
  const { snapshot, event } = await publishSweep({ db, sweep, estateRoot: estate });

  const row = db.prepare("SELECT * FROM files WHERE private = 1").get();
  assert.equal(row.path, null);
  assert.equal(row.category, "documents");
  assert.match(row.path_hash, /^[0-9a-f]{64}$/u);

  const everywhere = [
    JSON.stringify(db.prepare("SELECT * FROM files").all()),
    fs.readFileSync(mapLogFile(estate, "optimus"), "utf8"),
    JSON.stringify(await readSnapshot(snapshot.path)),
    JSON.stringify(event)
  ].join("\n");
  assert.ok(!everywhere.includes("cv-2026"), "the quarantined path leaked");
  assert.ok(everywhere.includes("notes.txt"), "an unquarantined path must still be mapped");
  assert.equal(sweep.counts.bytes, 42010, "private bytes are still accounted for");
});

test("Scenario: the scope travels with the result", async () => {
  const { db, estate } = setup();
  const collector = files(
    "F:",
    [
      { path: "F:/a.bin", size: 1 },
      { path: "C:/b.bin", size: 1 }
    ],
    { volumes: ["C:", "F:"] }
  );
  const sweep = await runSweep({ db, machine: "t480", collectors: [collector], scope: ["F:"] });
  const { event } = await publishSweep({ db, sweep, estateRoot: estate });
  assert.deepEqual(event.payload.scope, ["F:"]);
  assert.deepEqual(
    event.payload.collectors.map((c) => c.volume),
    ["F:"]
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files WHERE volume = 'C:'").get().n, 0);
});

test("a collector that dies mid-volume keeps the previous sweep's rows for that volume", async () => {
  const { db } = setup();
  await runSweep({
    db,
    machine: "t480",
    collectors: [files("F:", [{ path: "F:/keep.bin", size: 7 }])],
    scope: ["F:"]
  });
  const dying = {
    name: "flaky",
    kind: "files",
    volumes: ["F:"],
    async *collect() {
      yield { path: "F:/new.bin", size: 1 };
      throw new Error("MFT read interrupted");
    }
  };
  const sweep = await runSweep({ db, machine: "t480", collectors: [dying], scope: ["F:"] });
  assert.equal(sweep.collectors[0].status, "errored");
  assert.deepEqual(
    db
      .prepare("SELECT path FROM files")
      .all()
      .map((r) => r.path),
    ["F:/keep.bin"]
  );
  assert.equal(
    db.prepare("SELECT status FROM volumes WHERE volume = 'F:'").get().status,
    "errored"
  );
});

test("the snapshot re-reads from CAS by its hash, and a re-sweep of a removed file drops it", async () => {
  const { db, estate } = setup();
  await runSweep({
    db,
    machine: "t480",
    collectors: [
      files("F:", [
        { path: "F:/x.gguf", size: 3 },
        { path: "F:/gone.mp4", size: 4 }
      ])
    ],
    scope: ["F:"]
  });
  const sweep = await runSweep({
    db,
    machine: "t480",
    collectors: [files("F:", [{ path: "F:/x.gguf", size: 3 }])],
    scope: ["F:"]
  });
  const { snapshot } = await publishSweep({ db, sweep, estateRoot: estate });
  const { header, rows } = await readSnapshot(blobFile(estate, `sha256:${snapshot.hash}`));
  assert.equal(header.sweep_id, sweep.id);
  assert.deepEqual(
    rows.map((r) => r.path),
    ["F:/x.gguf"]
  );
  assert.equal(categorize("F:/x.gguf"), "models");
});

// --- verifier findings (claude-s0-verifier, 2026-09-13): each test below fails on a leak or a
//     mutation that survived the first submission. ------------------------------------------

// Everywhere a sweep's output lands: the local index, the CAS snapshot, the event log.
async function allOutput(db, estate, sweep, machine) {
  const { snapshot } = await publishSweep({ db, sweep, estateRoot: estate });
  const tables = ["files", "apps", "media", "sweeps", "volumes"]
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))
    .join("\n");
  return [
    tables,
    JSON.stringify(await readSnapshot(snapshot.path)),
    fs.readFileSync(mapLogFile(estate, machine), "utf8")
  ].join("\n");
}

test("a stateful RegExp rule (g or y flag) quarantines every matching path, not every other one", async () => {
  for (const rule of [/job-app/gi, /cv/y, /cv-\d+/g]) {
    const { db, estate } = setup();
    const sweep = await runSweep({
      db,
      machine: "optimus",
      collectors: [
        files("C:", [
          { path: "C:/cv-1/job-app-one.docx", size: 1 },
          { path: "C:/cv-2/job-app-two.docx", size: 1 },
          { path: "C:/cv-3/job-app-three.docx", size: 1 }
        ])
      ],
      scope: ["C:"],
      quarantine: [rule]
    });
    const out = await allOutput(db, estate, sweep, "optimus");
    for (const leak of ["job-app-one", "job-app-two", "job-app-three"])
      assert.ok(!out.includes(leak), `${rule} leaked ${leak}`);
  }
});

test("an error that quotes a quarantined path is withheld everywhere, keeping its code", async () => {
  const { db, estate } = setup();
  const failing = {
    name: "mft",
    kind: "files",
    volumes: ["C:"],
    async *collect() {
      const e = new Error(
        "EPERM: operation not permitted, open 'C:\\Users\\x\\Documents\\cv-2026.docx'"
      );
      e.code = "EPERM";
      throw e;
    }
  };
  const sweep = await runSweep({
    db,
    machine: "optimus",
    collectors: [failing],
    scope: ["C:"],
    quarantine: ["cv-"]
  });
  const out = await allOutput(db, estate, sweep, "optimus");
  assert.ok(!out.includes("cv-2026"), "error text leaked the quarantined path");
  assert.ok(!out.includes("operation not permitted"), "error text of any kind must not be stored");
  assert.equal(sweep.collectors[0].error_code, "EPERM");
});

// --- verifier-2 findings (claude-s0-verifier-2): the classes, not the instances ----------------

test("no encoding of a path inside an error reaches any output, and a bad code is not kept", async () => {
  const thrown = [
    Object.assign(new Error("open 'C:\\Users\\x\\Documents\\cv-2026.docx'"), { code: "EPERM" }),
    new Error(`stat failed ${JSON.stringify("C:\\Users\\x\\Documents\\cv-2026.docx")}`),
    new Error("fetch file:///C:/Users/x/My%20Documents/cv-2026.docx"),
    Object.assign(new Error("x"), { code: "C:/Users/x/cv-2026.docx" }),
    Object.assign(new Error("wrapped"), { cause: new Error("C:/Users/x/cv-2026.docx") }),
    { path: "C:/Users/x/cv-2026.docx" },
    "C:\\Users\\x\\cv-2026.docx"
  ];
  for (const err of thrown) {
    const { db, estate } = setup();
    const boom = {
      name: "boom",
      kind: "files",
      volumes: ["C:"],
      async *collect() {
        throw err;
      }
    };
    const sweep = await runSweep({
      db,
      machine: "vm",
      collectors: [boom],
      scope: ["C:"],
      quarantine: [/^C:\/Users\/x\/Documents\//iu]
    });
    const out = await allOutput(db, estate, sweep, "vm");
    assert.ok(
      !out.toLowerCase().includes("cv-2026"),
      `leaked via ${JSON.stringify(String(err?.message ?? err))}`
    );
    assert.match(sweep.collectors[0].error_code, /^(EPERM|UNKNOWN)$/u);
  }
});

test("one normaliser: trailing slashes, ./, .., repeated separators, doubled backslashes and NFD all match", async () => {
  const cases = [
    { root: "D:/Private/", path: "cv/interview.mp4" },
    { root: "D:/Private", path: "./cv/interview.mp4" },
    { root: "D:/Private/other/..", path: "cv//interview.mp4" },
    { root: "D:\\\\Private", path: "cv\\\\interview.mp4" },
    // NFD path (e + combining acute) against an NFC rule; only the NFC rule is given for this
    // case, so a missing normalize("NFC") cannot hide behind the broader "private/cv" rule.
    { root: "D:/Private", path: "cve\u0301s/interview.mp4", rule: "private/cvés" }
  ];
  for (const c of cases) {
    const { db, estate } = setup();
    const media = {
      name: "m",
      kind: "media",
      async *collect() {
        yield { root: c.root, path: c.path, title: "secret title", size: 5 };
      }
    };
    const sweep = await runSweep({
      db,
      machine: "vm",
      collectors: [media],
      scope: [],
      quarantine: [c.rule ?? "private/cv"]
    });
    const out = await allOutput(db, estate, sweep, "vm");
    for (const leak of ["interview", "secret title"])
      assert.ok(!out.includes(leak), `${JSON.stringify(c)} leaked ${leak}`);
  }
});

test("every free-text field is tested: app name, publisher, version, and a collector-supplied category", async () => {
  const { db, estate } = setup();
  const apps = {
    name: "a",
    kind: "apps",
    async *collect() {
      yield { name: "Resume Wizard", publisher: "C:/Users/x/cv-2026.docx", version: "1" };
    }
  };
  const f = files("C:", [{ path: "C:/data/a.bin", size: 1, category: "C:/Users/x/cv-2026.docx" }]);
  const sweep = await runSweep({
    db,
    machine: "vm",
    collectors: [apps, f],
    scope: ["C:"],
    quarantine: ["cv-2026"]
  });
  const out = await allOutput(db, estate, sweep, "vm");
  for (const leak of ["cv-2026", "Resume Wizard"]) assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.equal(db.prepare("SELECT private FROM apps").get().private, 1);
});

test("collector names and volumes cannot carry data: bad names and quarantined volumes are refused before any write", async () => {
  const { db } = setup();
  const bad = files("C:", [{ path: "C:/a", size: 1 }]);
  bad.name = "C:/Users/x/cv-2026.docx";
  await assert.rejects(
    runSweep({ db, machine: "vm", collectors: [bad], scope: ["C:"] }),
    (e) => !String(e.message).includes("cv-2026")
  );
  await assert.rejects(
    runSweep({
      db,
      machine: "vm",
      collectors: [],
      scope: ["C:/Users/x/cv-2026"],
      quarantine: ["cv-2026"]
    }),
    (e) => !String(e.message).includes("cv-2026")
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sweeps").get().n, 0);
});

test("bookkeeping the gate did not check: hash case, errored sweep id, digest fields, snapshot record, counts, header, absolute media, subject", async () => {
  const { db, estate } = setup();
  // path hash is case-insensitive: two spellings of one Windows path are one row
  await runSweep({
    db,
    machine: "t480",
    collectors: [
      files("F:", [
        { path: "F:/A.bin", size: 1 },
        { path: "F:/a.bin", size: 1 }
      ])
    ],
    scope: ["F:"]
  });
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 1);
  // an errored re-sweep records its own sweep id and reports zero rows
  const dying = {
    name: "flaky",
    kind: "files",
    volumes: ["F:"],
    async *collect() {
      yield { path: "F:/b", size: 1 };
      throw new Error("x");
    }
  };
  const errored = await runSweep({ db, machine: "t480", collectors: [dying], scope: ["F:"] });
  assert.equal(
    db.prepare("SELECT sweep_id FROM volumes WHERE volume = 'F:'").get().sweep_id,
    errored.id
  );
  assert.equal(errored.collectors[0].rows, 0);
  // digest covers category and app version
  const d = async (collectors) =>
    (await runSweep({ db: setup().db, machine: "t480", collectors, scope: ["F:"] })).digest;
  assert.notEqual(
    await d([files("F:", [{ path: "F:/a.bin", size: 1, category: "models" }])]),
    await d([files("F:", [{ path: "F:/a.bin", size: 1, category: "video" }])])
  );
  const app = (version) => ({
    name: "w",
    kind: "apps",
    async *collect() {
      yield { name: "Node.js", version };
    }
  });
  assert.notEqual(await d([app("22")]), await d([app("24")]));
  // counts, snapshot record, header collectors, absolute media path, subject id
  const media = {
    name: "m",
    kind: "media",
    async *collect() {
      yield { root: "F:/media", path: "D:/elsewhere/x.mkv", size: 2 };
      yield { root: "F:/media", path: "y.mkv", size: 3 };
    }
  };
  const sweep = await runSweep({ db, machine: "t480", collectors: [media], scope: [] });
  assert.equal(sweep.counts.media, 2);
  const { snapshot, event } = await publishSweep({ db, sweep, estateRoot: estate });
  assert.equal(
    db.prepare("SELECT snapshot FROM sweeps WHERE id = ?").get(sweep.id).snapshot,
    `sha256:${snapshot.hash}`
  );
  const { header, rows } = await readSnapshot(snapshot.path);
  assert.deepEqual(
    header.collectors.map((c) => c.name),
    ["m"]
  );
  assert.ok(
    rows.some((r) => r.path === "D:/elsewhere/x.mkv"),
    "an absolute media path must not be joined to its root"
  );
  assert.equal(event.subject.id, `sweep:t480:map:${sweep.finishedAt}`);
});

test("app locations and media roots obey the rules; a relative media path under a private root is private", async () => {
  const { db, estate } = setup();
  const apps = {
    name: "registry",
    kind: "apps",
    async *collect() {
      yield { name: "CV Builder", version: "2", location: "C:\\Users\\x\\JobHunt\\cvbuilder" };
      yield { name: "LM Studio", version: "0.3", location: "C:\\Program Files\\LM Studio" };
    }
  };
  const media = {
    name: "jellyfin",
    kind: "media",
    async *collect() {
      yield {
        root: "D:\\Private\\JobHunt",
        path: "interview-acme.mp4",
        title: "Interview Acme",
        size: 9
      };
      yield { root: "F:\\media\\Movies", path: "Heat (1995).mkv", title: "Heat", size: 8 };
    }
  };
  const sweep = await runSweep({
    db,
    machine: "optimus",
    collectors: [apps, media],
    scope: [],
    quarantine: ["jobhunt"]
  });
  const out = await allOutput(db, estate, sweep, "optimus");
  for (const leak of ["JobHunt", "cvbuilder", "interview-acme", "Interview Acme"])
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.ok(out.includes("C:/Program Files/LM Studio"), "an unquarantined app location is kept");
  assert.ok(
    out.includes("Heat (1995).mkv") && out.includes("F:/media/Movies"),
    "unquarantined media is kept"
  );
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM media WHERE private = 1").get().n, 1);
});

test("string rules are case-insensitive and written with either slash", async () => {
  const { db, estate } = setup();
  const sweep = await runSweep({
    db,
    machine: "optimus",
    collectors: [files("C:", [{ path: "C:\\Users\\X\\DOCUMENTS\\Jobs\\offer.pdf", size: 1 }])],
    scope: ["C:"],
    quarantine: ["documents\\jobs"]
  });
  const out = await allOutput(db, estate, sweep, "optimus");
  assert.ok(!out.toLowerCase().includes("offer.pdf"), "a backslash rule missed a mixed-case path");
});

test("the digest changes when only a path or only a size changes", async () => {
  const digestOf = async (rows) => {
    const { db } = setup();
    return (await runSweep({ db, machine: "t480", collectors: [files("F:", rows)], scope: ["F:"] }))
      .digest;
  };
  const base = await digestOf([{ path: "F:/a.bin", size: 10 }]);
  assert.notEqual(base, await digestOf([{ path: "F:/b.bin", size: 10 }]), "digest ignores path");
  assert.notEqual(base, await digestOf([{ path: "F:/a.bin", size: 11 }]), "digest ignores size");
});

test("the snapshot holds this sweep's apps and media, and nothing from other sweeps", async () => {
  const { db, estate } = setup();
  await runSweep({
    db,
    machine: "t480",
    collectors: [files("C:", [{ path: "C:/old.bin", size: 1 }])],
    scope: ["C:"]
  });
  const sweep = await runSweep({
    db,
    machine: "t480",
    scope: ["F:"],
    collectors: [
      files("F:", [{ path: "F:/new.bin", size: 2 }]),
      {
        name: "winget",
        kind: "apps",
        async *collect() {
          yield { name: "Node.js", version: "24" };
        }
      },
      {
        name: "roots",
        kind: "media",
        async *collect() {
          yield { root: "F:/media", path: "a.mkv", size: 3 };
        }
      }
    ]
  });
  const { snapshot } = await publishSweep({ db, sweep, estateRoot: estate });
  const { rows } = await readSnapshot(snapshot.path);
  assert.deepEqual(rows.map((r) => r.t).sort(), ["app", "file", "media"]);
  assert.ok(!JSON.stringify(rows).includes("old.bin"), "another sweep's rows entered the snapshot");
});

test("a re-sweep removes vanished files from the index itself, not just from the snapshot", async () => {
  const { db } = setup();
  await runSweep({
    db,
    machine: "t480",
    collectors: [
      files("F:", [
        { path: "F:/a", size: 1 },
        { path: "F:/b", size: 1 }
      ])
    ],
    scope: ["F:"]
  });
  await runSweep({
    db,
    machine: "t480",
    collectors: [files("F:", [{ path: "F:/a", size: 1 }])],
    scope: ["F:"]
  });
  assert.deepEqual(
    db
      .prepare("SELECT path FROM files")
      .all()
      .map((r) => r.path),
    ["F:/a"]
  );
});

test("a volume whose very first sweep errors is recorded as errored", async () => {
  const { db } = setup();
  const dead = {
    name: "mft",
    kind: "files",
    volumes: ["E:"],
    async *collect() {
      throw new Error("volume not ready");
    }
  };
  await runSweep({ db, machine: "t480", collectors: [dead], scope: ["E:"] });
  assert.equal(
    db.prepare("SELECT status FROM volumes WHERE volume = 'E:'").get()?.status,
    "errored"
  );
});

test("a quarantined media title alone makes the row private", async () => {
  const { db, estate } = setup();
  const media = {
    name: "jellyfin",
    kind: "media",
    async *collect() {
      yield { root: "F:/media/Home", path: "clip-0042.mp4", title: "Acme job interview", size: 7 };
    }
  };
  const sweep = await runSweep({
    db,
    machine: "t480",
    collectors: [media],
    scope: [],
    quarantine: ["job interview"]
  });
  const out = await allOutput(db, estate, sweep, "t480");
  for (const leak of ["Acme job interview", "clip-0042"])
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.equal(db.prepare("SELECT private FROM media").get().private, 1);
});

// --- verifier-3 findings (claude-s0-verifier-3) ---------------------------------------------------

test("RegExp rules written with Windows backslashes match, including anchors and lookbehind", async () => {
  const rules = [
    /\\Documents\\Applications\\/iu,
    /^C:\\Users\\x\\Documents\\/iu,
    /(?<=Documents\\Applications\\)cv/u
  ];
  for (const rule of rules) {
    const { db, estate } = setup();
    const f = files("C:", [
      { path: "C:\\Users\\x\\Documents\\Applications\\cv-2026.docx", size: 1 }
    ]);
    const apps = {
      name: "a",
      kind: "apps",
      async *collect() {
        yield {
          name: "CV Builder",
          version: "3",
          location: "C:\\Users\\x\\Documents\\Applications\\cv-builder"
        };
      }
    };
    const media = {
      name: "m",
      kind: "media",
      async *collect() {
        yield {
          root: "C:\\Users\\x\\Documents\\Applications",
          path: "cv-talk.mp4",
          title: "Talk",
          size: 1
        };
      }
    };
    const sweep = await runSweep({
      db,
      machine: "vm",
      collectors: [f, apps, media],
      scope: ["C:"],
      quarantine: [rule]
    });
    const out = await allOutput(db, estate, sweep, "vm");
    // The lookbehind rule targets cv* items inside the folder, not the folder itself, so only the
    // two rules that cover the folder must also hide its name.
    const needles = ["cv-2026", "CV Builder", "cv-talk"];
    if (!rule.source.startsWith("(?<=")) needles.push("Applications");
    for (const leak of needles) assert.ok(!out.includes(leak), `${rule} leaked ${leak}`);
  }
});

test("Win32 namespace prefixes (\\\\?\\ and \\\\.\\) name the same path and cannot dodge a rule", async () => {
  const cases = [
    {
      path: "\\\\?\\UNC\\nas\\home\\HR\\cv-2026.docx",
      rule: "\\\\nas\\home\\HR\\",
      volume: "//nas/home"
    },
    {
      path: "\\\\?\\C:\\Users\\x\\Documents\\cv-2026.docx",
      rule: /^c:\/users\/x\/documents\//iu,
      volume: "C:"
    },
    {
      path: "\\\\.\\C:\\Users\\x\\Documents\\cv-2026.docx",
      rule: /^c:\/users\/x\/documents\//iu,
      volume: "C:"
    }
  ];
  for (const c of cases) {
    const { db, estate } = setup();
    const f = {
      name: "f",
      kind: "files",
      volumes: [c.volume],
      async *collect() {
        yield { path: c.path, size: 1 };
      }
    };
    const sweep = await runSweep({
      db,
      machine: "vm",
      collectors: [f],
      scope: [c.volume],
      quarantine: [c.rule]
    });
    const out = await allOutput(db, estate, sweep, "vm");
    assert.ok(!out.includes("cv-2026"), `${c.path} leaked`);
  }
});

test("a UNC path keeps its // root so an anchored UNC rule still matches", async () => {
  const { db, estate } = setup();
  const f = {
    name: "f",
    kind: "files",
    volumes: ["//server/share"],
    async *collect() {
      yield { path: "\\\\server\\share\\HR\\offer-letter.pdf", size: 1 };
      yield { path: "\\\\server\\share\\public\\menu.pdf", size: 1 };
    }
  };
  const sweep = await runSweep({
    db,
    machine: "vm",
    collectors: [f],
    scope: ["//server/share"],
    quarantine: [/^\/\/server\/share\/hr\//iu]
  });
  assert.ok(!(await allOutput(db, estate, sweep, "vm")).includes("offer-letter"));
  assert.equal(
    db.prepare("SELECT path FROM files WHERE private = 0").get().path,
    "//server/share/public/menu.pdf",
    "the stored UNC path keeps its // root"
  );
});

test("the media matcher sees the original spelling of root + path, not only the canonical join", async () => {
  const { db, estate } = setup();
  const media = {
    name: "m",
    kind: "media",
    async *collect() {
      yield { root: "D:\\Private", path: "cv\\\\talk.mp4", title: "Talk", size: 1 };
    }
  };
  const sweep = await runSweep({
    db,
    machine: "vm",
    collectors: [media],
    scope: [],
    quarantine: [/cv\/\/talk/iu]
  });
  assert.ok(!(await allOutput(db, estate, sweep, "vm")).includes("talk.mp4"));
});

test("a RegExp rule sees the canonical path, so ./ and doubled separators cannot dodge it", async () => {
  const { db, estate } = setup();
  const f = files("C:", [{ path: "C:\\Users\\x\\.\\Documents\\\\cv.docx", size: 1 }]);
  const sweep = await runSweep({
    db,
    machine: "vm",
    collectors: [f],
    scope: ["C:"],
    quarantine: [/^C:\/Users\/x\/Documents\/cv/u]
  });
  assert.ok(!(await allOutput(db, estate, sweep, "vm")).includes("cv.docx"));
});

test("a quarantined app version alone privatises the app; private apps keep distinct rows, versionless", async () => {
  const { db, estate } = setup();
  const apps = {
    name: "a",
    kind: "apps",
    async *collect() {
      yield { name: "Tool", version: "cv-2026-edition" };
      yield { name: "Secret", version: "1", publisher: "cv-2026 corp" };
      yield { name: "Secret", version: "2", publisher: "cv-2026 corp" };
    }
  };
  const sweep = await runSweep({
    db,
    machine: "vm",
    collectors: [apps],
    scope: [],
    quarantine: ["cv-2026"]
  });
  const out = await allOutput(db, estate, sweep, "vm");
  for (const leak of ["cv-2026", "Secret", "Tool"])
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  const rows = db.prepare("SELECT name, version, private FROM apps").all();
  assert.equal(rows.length, 3, "private apps of different versions must not collapse into one row");
  assert.ok(rows.every((r) => r.private === 1 && r.version === ""));
});

test("empty, '.' and bare-separator rules are refused; absent optional fields are never 'matched'", async () => {
  for (const rule of ["", ".", "/", "\\"]) {
    const { db } = setup();
    // no scope, so only the rule check itself can refuse this sweep
    await assert.rejects(
      runSweep({ db, machine: "vm", collectors: [], scope: [], quarantine: [rule] }),
      /quarantine rule is empty or a bare separator/u
    );
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM sweeps").get().n, 0);
  }
  const { db } = setup();
  const apps = {
    name: "a",
    kind: "apps",
    async *collect() {
      yield { name: "Node.js", version: "24" };
    }
  };
  await runSweep({ db, machine: "vm", collectors: [apps], scope: [], quarantine: [/^$/u] });
  assert.deepEqual(
    { ...db.prepare("SELECT name, publisher, private FROM apps").get() },
    { name: "Node.js", publisher: null, private: 0 }
  );
});

test("numeric fields are stored as numbers or null, never as collector-supplied text", async () => {
  const { db } = setup();
  const f = files("F:", [
    { path: "F:/a.bin", size: 5, mtimeMs: 1700000000000 },
    { path: "F:/b.bin", size: 6, mtimeMs: "C:/Users/x/cv-2026.docx" }
  ]);
  const media = {
    name: "m",
    kind: "media",
    async *collect() {
      yield { root: "F:/m", path: "x.mkv", size: 42 };
      yield { root: "F:/m", path: "y.mkv", size: "C:/Users/x/cv-2026.docx" };
    }
  };
  await runSweep({ db, machine: "vm", collectors: [f, media], scope: ["F:"] });
  assert.deepEqual(
    db
      .prepare("SELECT path, mtime_ms FROM files ORDER BY path")
      .all()
      .map((r) => ({ ...r })),
    [
      { path: "F:/a.bin", mtime_ms: 1700000000000 },
      { path: "F:/b.bin", mtime_ms: null }
    ]
  );
  assert.deepEqual(
    db
      .prepare("SELECT path, size FROM media ORDER BY path")
      .all()
      .map((r) => ({ ...r })),
    [
      { path: "F:/m/x.mkv", size: 42 },
      { path: "F:/m/y.mkv", size: null }
    ]
  );
});

// --- round 3 self-review: every spelling an operator or a filesystem can produce ---------------

async function leaksFor(pathValue, rule, needle = "cv-2026") {
  const { db, estate } = setup();
  const f = {
    name: "f",
    kind: "files",
    volumes: ["C:"],
    async *collect() {
      yield { path: pathValue, size: 1 };
    }
  };
  const sweep = await runSweep({
    db,
    machine: "vm",
    collectors: [f],
    scope: ["C:"],
    quarantine: [rule]
  });
  return (await allOutput(db, estate, sweep, "vm")).includes(needle);
}

test("string rules match across Unicode compatibility, case folding and invisible characters", async () => {
  const cases = [
    ["C:/Users/x/STRASSE/cv-2026.docx", "straße"],
    ["C:/Users/x/Straße/cv-2026.docx", "STRASSE"],
    ["C:/Users/x/İş Başvuru/cv-2026.docx", "iş başvuru"],
    ["C:/Users/x/Doc\u200Buments/cv-2026.docx", "x/documents/"],
    ["C:\uFF0FUsers\uFF0Fx\uFF0FDocuments\uFF0Fcv-2026.docx", "x/documents/"]
  ];
  for (const [p, rule] of cases) assert.equal(await leaksFor(p, rule), false, `${p} vs ${rule}`);
  assert.equal(await leaksFor("\uFF23\uFF36-2026.docx", "cv-2026", "\uFF23\uFF36-2026"), false);
});

test(".. cannot climb above a drive or root, and a leading .. in a string rule still matches", async () => {
  assert.equal(
    await leaksFor(
      "C:\\Users\\x\\Documents\\..\\..\\..\\..\\Documents\\cv-2026.docx",
      "C:/Documents/"
    ),
    false
  );
  assert.equal(
    await leaksFor("C:/../../Users/x/Documents/cv-2026.docx", "C:/Users/x/Documents"),
    false
  );
  assert.equal(await leaksFor("C:\\Users\\x\\Documents\\cv-2026.docx", "..\\Documents"), false);
  assert.equal(
    await leaksFor("C:cv-2026.docx", "C:/cv"),
    false,
    "a drive-relative path is matched as rooted"
  );
});

test("RegExp rules: case-insensitive, $-anchored, and written against the original doubled separator", async () => {
  assert.equal(
    await leaksFor("c:\\users\\x\\documents\\cv-2026.docx", /^C:\/Users\/x\/Documents/u),
    false
  );
  assert.equal(await leaksFor("C:\\Users\\x\\Documents\\cv-2026.docx", /cv-2026\.docx$/u), false);
  assert.equal(
    await leaksFor("C:\\Users\\x\\Documents\\\\cv-2026.docx", /Documents\/\/cv/iu),
    false
  );
});

test("non-text row fields fail the collector instead of being stringified into the map", async () => {
  const shifty = () => {
    let i = 0;
    return { toString: () => (i++ ? "C:/Users/x/cv-2026.docx" : "C:/public") };
  };
  for (const bad of [
    ["C:/Users/x/Documents", "cv-2026.docx"],
    shifty(),
    new URL("file:///C:/Users/x/cv-2026.docx")
  ]) {
    const { db, estate } = setup();
    const f = {
      name: "f",
      kind: "files",
      volumes: ["C:"],
      async *collect() {
        yield { path: bad, size: 1 };
      }
    };
    const apps = {
      name: "a",
      kind: "apps",
      async *collect() {
        yield { name: "ok", location: shifty() };
      }
    };
    const sweep = await runSweep({
      db,
      machine: "vm",
      collectors: [f, apps],
      scope: ["C:"],
      quarantine: ["cv-2026"]
    });
    assert.deepEqual(
      sweep.collectors.map((c) => c.status),
      ["errored", "errored"]
    );
    assert.ok(!(await allOutput(db, estate, sweep, "vm")).includes("cv-2026"));
  }
});

test("a collector name or an error code that matches a rule is refused or replaced", async () => {
  const { db, estate } = setup();
  const named = files("C:", [{ path: "C:/a", size: 1 }]);
  named.name = "cv-2026";
  await assert.rejects(
    runSweep({ db, machine: "vm", collectors: [named], scope: ["C:"], quarantine: ["cv-2026"] }),
    TypeError
  );
  const boom = {
    name: "boom",
    kind: "files",
    volumes: ["C:"],
    async *collect() {
      throw Object.assign(new Error("x"), { code: "CV_2026" });
    }
  };
  const sweep = await runSweep({
    db,
    machine: "vm",
    collectors: [boom],
    scope: ["C:"],
    quarantine: ["cv_2026"]
  });
  assert.equal(sweep.collectors[0].error_code, "UNKNOWN");
  assert.ok(!(await allOutput(db, estate, sweep, "vm")).includes("CV_2026"));
});

test("stored paths are NFC, so one file spelled NFD and NFC is one row", async () => {
  const { db } = setup();
  const nfd = "F:/music/Beyonce\u0301/halo.mp3";
  const nfc = "F:/music/Beyonc\u00e9/halo.mp3";
  await runSweep({
    db,
    machine: "vm",
    collectors: [
      files("F:", [
        { path: nfd, size: 1 },
        { path: nfc, size: 1 }
      ])
    ],
    scope: ["F:"]
  });
  const rows = db.prepare("SELECT path FROM files").all();
  assert.equal(rows.length, 1);
  assert.equal(rows[0].path, nfc);
});
