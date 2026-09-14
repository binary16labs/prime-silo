// S0 — estate map model. Each Scenario in delivery/tasks/S0.md maps to a test here, followed by the
// attack corpus of the four verifiers who failed earlier submissions (LOG S0 FAIL lines), re-run
// against the structural privacy model with public roots that COVER the attacked paths, so the
// quarantine rules — not the absence of a root — are what is being tested.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import vm from "node:vm";
import zlib from "node:zlib";

import {
  openMap,
  runSweep,
  publishSweep,
  readSnapshot,
  mapLogFile,
  canonPath
} from "../server/coordination/lib/estate_map.mjs";
import { readKelEvents, validateKelEvent } from "../server/coordination/lib/kel.mjs";
import { resolveBlob } from "../server/coordination/lib/staging.mjs";

const ALL = ["C:/", "D:/", "F:/", "//nas", "//server"];

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "estate-map-"));
  const dbPath = path.join(base, "map", "estate-map.db");
  return { db: openMap(dbPath), dbPath, estate: path.join(base, "estate-store") };
}

const files = (volume, rows, name = "fixture-files") => ({
  name,
  kind: "files",
  volumes: [volume],
  async *collect() {
    for (const r of rows) yield r;
  }
});
const apps = (rows, name = "apps") => ({
  name,
  kind: "apps",
  async *collect() {
    for (const r of rows) yield r;
  }
});
const media = (rows, name = "media") => ({
  name,
  kind: "media",
  async *collect() {
    for (const r of rows) yield r;
  }
});

// Every surface a sweep's output lands on: all tables, the raw database bytes (including WAL),
// the parsed snapshot, the raw gunzipped CAS blob and the event log.
async function allOutput(ctx, sweep) {
  const { db, dbPath, estate } = ctx;
  const { snapshot } = await publishSweep({ db, sweep, estateRoot: estate });
  const tables = ["files", "totals", "apps", "media", "sweeps", "volumes", "meta"]
    .map((t) => JSON.stringify(db.prepare(`SELECT * FROM ${t}`).all()))
    .join("\n");
  const raw = [dbPath, `${dbPath}-wal`]
    .filter((f) => fs.existsSync(f))
    .map((f) => fs.readFileSync(f).toString("utf8"))
    .join("\n");
  const blob = zlib.gunzipSync(fs.readFileSync(snapshot.path)).toString("utf8");
  return [
    tables,
    raw,
    JSON.stringify(await readSnapshot(snapshot.path)),
    blob,
    fs.readFileSync(mapLogFile(estate, sweep.machine), "utf8"),
    JSON.stringify(sweep)
  ].join("\n");
}

async function sweepAndDump({ collectors, scope = ["C:"], publicRoots = ALL, quarantine = [] }) {
  const ctx = setup();
  const sweep = await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors,
    scope,
    publicRoots,
    quarantine
  });
  return { ctx, sweep, out: await allOutput(ctx, sweep) };
}

// --- contract Scenarios ----------------------------------------------------------------------

test("Scenario: a sweep with a failing collector still publishes, and says which failed", async () => {
  const ctx = setup();
  const good = files("F:", [
    { path: "F:/nas/models/qwen.gguf", size: 5000, mtimeMs: 2 },
    { path: "F:/media/Movies/a.mkv", size: 1000, mtimeMs: 1 }
  ]);
  const broken = {
    name: "registry-apps",
    kind: "apps",
    collect: async function* () {
      throw Object.assign(new Error("reg query denied for HKCU\\Software\\x"), { code: "EACCES" });
    }
  };
  const sweep = await runSweep({
    db: ctx.db,
    machine: "t480",
    collectors: [good, broken],
    scope: ["F:"],
    publicRoots: ["F:/nas", "F:/media"]
  });
  const { event, snapshot } = await publishSweep({ db: ctx.db, sweep, estateRoot: ctx.estate });
  const { rows } = await readSnapshot(snapshot.path);
  assert.deepEqual(
    rows.filter((r) => r.t === "file").map((r) => r.path),
    ["F:/media/Movies/a.mkv", "F:/nas/models/qwen.gguf"]
  );
  const failed = event.payload.collectors.find((c) => c.kind === "apps");
  assert.deepEqual(
    [failed.name, failed.status, failed.error_code],
    ["registry-apps", "errored", "EACCES"]
  );
  assert.ok(
    !(await allOutput(ctx, sweep)).includes("reg query denied"),
    "no error text is ever stored"
  );
  assert.ok(readKelEvents(mapLogFile(ctx.estate, "t480")).ok);
});

test("Scenario: outside a public root only totals are recorded", async () => {
  const secret = "C:/Users/x/Documents/cv-2026.docx";
  const { ctx, sweep, out } = await sweepAndDump({
    collectors: [
      files("C:", [
        { path: secret, size: 42000 },
        { path: "C:/Users/x/Documents/plan.txt", size: 8 }
      ])
    ],
    publicRoots: ["F:/nas"]
  });
  for (const leak of ["cv-2026", "plan.txt", "Users/x", canonPath(secret).toLowerCase()])
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.ok(
    !/[0-9a-f]{64}/u.test(ctx.db.prepare("SELECT * FROM totals").all().map(JSON.stringify).join()),
    "no path hash in totals"
  );
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
  assert.deepEqual(
    {
      ...ctx.db
        .prepare("SELECT items, bytes FROM totals WHERE volume = 'C:' AND category = 'documents'")
        .get()
    },
    { items: 2, bytes: 42008 }
  );
  assert.equal(sweep.counts.bytes, 42008);
});

test("Scenario: a quarantine rule inside a public root is judged on the stored text", async () => {
  const { ctx, out } = await sweepAndDump({
    collectors: [
      files("F:", [
        { path: "F:/nas/cv-2026/\u2025/notes.txt", size: 1 },
        { path: "F:/nas/tmp/../notes.txt", size: 2 },
        { path: "F:/nas/cv-2026/a.pdf", size: 3 }
      ])
    ],
    scope: ["F:"],
    publicRoots: ["F:/nas"],
    quarantine: ["cv"]
  });
  assert.deepEqual(
    ctx.db
      .prepare("SELECT path FROM files")
      .all()
      .map((r) => r.path),
    ["F:/nas/notes.txt"]
  );
  assert.ok(!out.includes("a.pdf") && !out.includes("cv-2026"), "a quarantined item leaked");
  assert.equal(
    ctx.db.prepare("SELECT items FROM totals WHERE category = 'documents'").get().items,
    2
  );
});

test("Scenario: a later rule removes rows an earlier sweep published — even if that collector now fails", async () => {
  for (const failLater of [false, true]) {
    const ctx = setup();
    const roots = ["F:/nas", "D:/"];
    let fail = false;
    const f = {
      name: "f",
      kind: "files",
      volumes: ["F:"],
      async *collect() {
        yield { path: "F:/nas/cv.pdf", size: 1 };
        yield { path: "F:/nas/menu.pdf", size: 1 };
        if (fail) throw Object.assign(new Error("x"), { code: "EIO" });
      }
    };
    const a = apps([
      { name: "CV Builder", version: "1", location: "D:/Apps/cvb" },
      { name: "Node.js", version: "24" }
    ]);
    const m = media([
      { root: "D:/Private/CV", path: "interview.mp4", title: "my interview", size: 3 }
    ]);
    await runSweep({
      db: ctx.db,
      machine: "vm",
      collectors: [f, a, m],
      scope: ["F:"],
      publicRoots: roots
    });
    fail = failLater;
    const later = await runSweep({
      db: ctx.db,
      machine: "vm",
      collectors: [f],
      scope: ["F:"],
      publicRoots: roots,
      quarantine: ["cv"]
    });
    const out = await allOutput(ctx, later);
    for (const leak of ["cv.pdf", "CV Builder", "cvb", "Private/CV", "my interview"])
      assert.ok(!out.includes(leak), `failLater=${failLater} leaked ${leak}`);
    assert.ok(out.includes("Node.js"), "unaffected rows survive the re-judgement");
  }
});

test("Scenario: the scope travels with the result", async () => {
  const ctx = setup();
  const f = { ...files("F:", [{ path: "F:/nas/a.bin", size: 1 }]), volumes: ["C:", "F:"] };
  const sweep = await runSweep({
    db: ctx.db,
    machine: "t480",
    collectors: [f],
    scope: ["F:"],
    publicRoots: ["F:/nas"]
  });
  const { event } = await publishSweep({ db: ctx.db, sweep, estateRoot: ctx.estate });
  assert.deepEqual(event.payload.scope, ["F:"]);
  assert.deepEqual(
    event.payload.collectors.map((c) => c.volume),
    ["F:"]
  );
});

// --- sweep mechanics ------------------------------------------------------------------------

test("a collector that dies mid-volume keeps the previous rows; a first-sweep failure is recorded", async () => {
  const ctx = setup();
  const roots = ["F:/nas"];
  await runSweep({
    db: ctx.db,
    machine: "t480",
    collectors: [files("F:", [{ path: "F:/nas/keep.bin", size: 7 }])],
    scope: ["F:"],
    publicRoots: roots
  });
  const dying = {
    name: "flaky",
    kind: "files",
    volumes: ["F:"],
    async *collect() {
      yield { path: "F:/nas/new.bin", size: 1 };
      throw new Error("x");
    }
  };
  const s = await runSweep({
    db: ctx.db,
    machine: "t480",
    collectors: [dying],
    scope: ["F:"],
    publicRoots: roots
  });
  assert.deepEqual([s.collectors[0].status, s.collectors[0].rows], ["errored", 0]);
  assert.deepEqual(
    ctx.db
      .prepare("SELECT path FROM files")
      .all()
      .map((r) => r.path),
    ["F:/nas/keep.bin"]
  );
  assert.deepEqual(
    { ...ctx.db.prepare("SELECT status, sweep_id FROM volumes").get() },
    { status: "errored", sweep_id: s.id }
  );
  const dead = {
    name: "mft",
    kind: "files",
    volumes: ["E:"],
    async *collect() {
      throw new Error("not ready");
    }
  };
  await runSweep({
    db: ctx.db,
    machine: "t480",
    collectors: [dead],
    scope: ["E:"],
    publicRoots: roots
  });
  assert.equal(
    ctx.db.prepare("SELECT status FROM volumes WHERE volume = 'E:'").get().status,
    "errored"
  );
});

test("a successful re-sweep drops vanished files, apps, media and totals from the index", async () => {
  const ctx = setup();
  const run = (fileRows, appRows, mediaRows) =>
    runSweep({
      db: ctx.db,
      machine: "vm",
      collectors: [files("F:", fileRows), apps(appRows), media(mediaRows)],
      scope: ["F:"],
      publicRoots: ["F:/nas"]
    });
  await run(
    [
      { path: "F:/nas/a", size: 1 },
      { path: "F:/nas/b", size: 1 },
      { path: "F:/private/x.pdf", size: 1 }
    ],
    [{ name: "Old", version: "1" }],
    [{ root: "F:/nas", path: "old.mkv" }]
  );
  await run([{ path: "F:/nas/a", size: 1 }], [{ name: "New", version: "2" }], []);
  assert.deepEqual(
    ctx.db
      .prepare("SELECT path FROM files")
      .all()
      .map((r) => r.path),
    ["F:/nas/a"]
  );
  assert.deepEqual(
    ctx.db
      .prepare("SELECT name FROM apps")
      .all()
      .map((r) => r.name),
    ["New"]
  );
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM media").get().n, 0);
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM totals WHERE kind = 'files'").get().n, 0);
});

test("snapshot: re-reads from CAS by hash, digest covers what is published, event validates and chains", async () => {
  const ctx = setup();
  const collectors = [
    files("F:", [
      { path: "F:/nas/x.gguf", size: 3 },
      { path: "C:/secret.pdf", size: 9 }
    ]),
    apps([{ name: "Node.js", version: "24" }]),
    media([{ root: "F:/nas", path: "y.mkv", size: 2 }])
  ];
  const sweep = await runSweep({
    db: ctx.db,
    machine: "t480",
    collectors,
    scope: ["F:"],
    publicRoots: ["F:/nas"]
  });
  const { snapshot, event } = await publishSweep({ db: ctx.db, sweep, estateRoot: ctx.estate });
  assert.equal(resolveBlob(ctx.estate, snapshot.hash), snapshot.path);
  const { header, rows } = await readSnapshot(snapshot.path);
  assert.equal(header.sweep_id, sweep.id);
  assert.deepEqual(
    header.collectors.map((c) => c.name),
    ["fixture-files", "apps", "media"]
  );
  assert.deepEqual([...new Set(rows.map((r) => r.t))].sort(), ["app", "file", "media", "total"]);
  assert.equal(
    ctx.db.prepare("SELECT snapshot FROM sweeps WHERE id = ?").get(sweep.id).snapshot,
    `sha256:${snapshot.hash}`
  );
  assert.equal(event.subject.id, `sweep:t480:map:${sweep.finishedAt}`);
  assert.ok(validateKelEvent(event).ok);
  assert.deepEqual(
    [sweep.counts.files, sweep.counts.listed_files, sweep.counts.apps, sweep.counts.media],
    [2, 1, 1, 1]
  );
  const digestOf = async (rowsIn) =>
    (
      await runSweep({
        db: setup().db,
        machine: "t480",
        collectors: [files("F:", rowsIn)],
        scope: ["F:"],
        publicRoots: ["F:/nas"]
      })
    ).digest;
  const base = await digestOf([{ path: "F:/nas/a.bin", size: 10 }]);
  assert.notEqual(base, await digestOf([{ path: "F:/nas/b.bin", size: 10 }]));
  assert.notEqual(base, await digestOf([{ path: "F:/nas/a.bin", size: 11 }]));
  assert.notEqual(base, await digestOf([{ path: "F:/nas/a.gguf", size: 10 }]));
});

test("storage form: NFC and case variants of one file are one row; UNC keeps //; \\\\?\\ prefixes stripped", async () => {
  const ctx = setup();
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [
      files("F:", [
        { path: "F:/nas/Beyonce\u0301/halo.mp3", size: 1 },
        { path: "F:/NAS/Beyonc\u00e9/halo.mp3", size: 1 }
      ]),
      files(
        "//server/share",
        [{ path: "\\\\?\\UNC\\server\\share\\public\\menu.pdf", size: 1 }],
        "unc"
      )
    ],
    scope: ["F:", "//server/share"],
    publicRoots: ["F:/nas", "//server/share"]
  });
  const paths = ctx.db
    .prepare("SELECT path FROM files ORDER BY path")
    .all()
    .map((r) => r.path);
  assert.deepEqual(paths, ["//server/share/public/menu.pdf", "F:/NAS/Beyonc\u00e9/halo.mp3"]);
});

test("apps: identity is listed, a location outside public roots is withheld, a quarantined app is only counted", async () => {
  const { ctx, out } = await sweepAndDump({
    collectors: [
      apps([
        {
          name: "LM Studio",
          version: "0.3",
          publisher: "Element Labs",
          location: "C:\\Users\\x\\AppData\\LM Studio"
        },
        { name: "Tool", version: "cv2026/.." },
        { name: "Secret", version: "1", publisher: "CV Corp/.." }
      ])
    ],
    scope: [],
    publicRoots: ["F:/nas"],
    quarantine: ["cv"]
  });
  assert.deepEqual(
    { ...ctx.db.prepare("SELECT name, publisher, location FROM apps").get() },
    { name: "LM Studio", publisher: "Element Labs", location: null }
  );
  for (const leak of ["AppData", "cv2026", "CV Corp", "Secret"])
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.equal(ctx.db.prepare("SELECT items FROM totals WHERE kind = 'apps'").get().items, 2);
});

// --- configuration refusals -------------------------------------------------------------------

test("unusable rules, public roots, collector names and scope volumes are refused before any write", async () => {
  class Sub extends RegExp {
    test() {
      return false;
    }
  }
  const bad = [
    [{ quarantine: [""] }, /empty or a bare separator/u],
    [{ quarantine: ["."] }, /empty or a bare separator/u],
    [{ quarantine: ["..."] }, /empty or a bare separator/u],
    [{ quarantine: [". ."] }, /empty or a bare separator/u],
    [{ quarantine: ["/./"] }, /empty or a bare separator/u],
    [{ quarantine: ["\\\\?\\"] }, /empty or a bare separator/u],
    [{ quarantine: ["\\\\.\\"] }, /empty or a bare separator/u],
    [{ quarantine: ["\\"] }, /empty or a bare separator/u],
    [{ quarantine: [{ source: "cv" }] }, /strings or RegExps/u],
    [{ quarantine: [new Sub("cv")] }, /strings or RegExps/u],
    [{ quarantine: [vm.runInNewContext("/cv/i")] }, /strings or RegExps/u],
    [{ quarantine: "cv" }, /list of rules/u],
    [{ publicRoots: ["nas/share"] }, /absolute path/u],
    [{ publicRoots: ["F:/cv-archive"], quarantine: ["cv"] }, /matching no rule/u],
    [{ scope: ["  "] }, /empty or quarantined volume/u],
    [{ scope: ["C:/Users/x/cv-2026"], quarantine: ["cv-2026"] }, /empty or quarantined volume/u],
    [{ collectors: [{ ...files("C:", []), name: "C:/Users/x/cv" }] }, /plain identifier/u],
    [
      { collectors: [{ ...files("C:", []), name: "cv_2026" }], quarantine: ["cv_2026"] },
      /plain identifier/u
    ]
  ];
  for (const [opts, message] of bad) {
    const ctx = setup();
    await assert.rejects(
      runSweep({ db: ctx.db, machine: "vm", collectors: [], scope: [], ...opts }),
      message
    );
    assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM sweeps").get().n, 0);
  }
});

test("row values: non-text fields fail the collector; bad numbers become null; bigint and Date are accepted", async () => {
  const shifty = () => {
    let i = 0;
    return { toString: () => (i++ ? "F:/nas/cv-2026.docx" : "F:/nas/ok") };
  };
  for (const badPath of [
    ["F:/nas", "cv-2026.docx"],
    shifty(),
    new URL("file:///F:/nas/cv-2026.docx")
  ]) {
    const { sweep, out } = await sweepAndDump({
      collectors: [files("F:", [{ path: badPath, size: 1 }])],
      scope: ["F:"],
      quarantine: ["cv-2026"]
    });
    assert.equal(sweep.collectors[0].status, "errored");
    assert.ok(!out.includes("cv-2026"));
  }
  const ctx = setup();
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [
      files("F:", [
        { path: "F:/nas/a", size: 5n, mtimeMs: new Date(1700000000000) },
        { path: "F:/nas/b", size: Infinity, mtimeMs: "F:/nas/cv.docx" },
        { path: "F:/nas/c", size: -4, mtimeMs: Number.NaN }
      ])
    ],
    scope: ["F:"],
    publicRoots: ["F:/nas"]
  });
  assert.deepEqual(
    ctx.db
      .prepare("SELECT path, size, mtime_ms FROM files ORDER BY path")
      .all()
      .map((r) => ({ ...r })),
    [
      { path: "F:/nas/a", size: 5, mtime_ms: 1700000000000 },
      { path: "F:/nas/b", size: null, mtime_ms: null },
      { path: "F:/nas/c", size: null, mtime_ms: null }
    ]
  );
});

// --- the attack corpus: verifiers 1-4, with public roots covering every attacked path -------------

test("files: every spelling a rule or a filesystem can produce stays hidden", async () => {
  const cases = [
    // verifier-1: stateful RegExp flags
    ["C:/cv-1/job-app-one.docx", /job-app/gi, "job-app-one"],
    ["C:/cv-2/job-app-two.docx", /cv/y, "job-app-two"],
    // verifier-2/3: slashes, prefixes, anchors, lookbehind, case, doubled separators
    [
      "C:\\Users\\x\\Documents\\Applications\\cv-2026.docx",
      /\\Documents\\Applications\\/iu,
      "cv-2026"
    ],
    ["C:\\Users\\x\\Documents\\cv-2026.docx", /^C:\\Users\\x\\Documents\\/iu, "cv-2026"],
    [
      "C:\\Users\\x\\Documents\\Applications\\cv-2026.docx",
      /(?<=Documents\\Applications\\)cv/u,
      "cv-2026"
    ],
    ["\\\\?\\UNC\\nas\\home\\HR\\cv-2026.docx", "\\\\nas\\home\\HR\\", "cv-2026"],
    ["\\\\?\\C:\\Users\\x\\Documents\\cv-2026.docx", /^c:\/users\/x\/documents\//iu, "cv-2026"],
    ["\\\\.\\C:\\Users\\x\\Documents\\cv-2026.docx", /^c:\/users\/x\/documents\//iu, "cv-2026"],
    ["c:\\users\\x\\documents\\cv-2026.docx", /^C:\/Users\/x\/Documents/u, "cv-2026"],
    ["C:\\Users\\x\\Documents\\cv-2026.docx", /cv-2026\.docx$/u, "cv-2026"],
    ["C:\\Users\\x\\Documents\\\\cv-2026.docx", /Documents\/\/cv/iu, "cv-2026"],
    ["C:\\Users\\x\\.\\Documents\\\\cv.docx", /^C:\/Users\/x\/Documents\/cv/u, "cv.docx"],
    ["C:\\Users\\x\\Documents\\cv-2026.docx", "..\\Documents", "cv-2026"],
    ["C:\\USERS\\X\\DOCUMENTS\\APPLICATIONS\\Offer.PDF", "documents/applications/", "Offer"],
    // Unicode: NFD/NFC, compatibility forms, folding, invisible characters
    ["C:/Users/x/Bewerbung/Lebensla\u0308uf.docx", "lebensl\u00e4uf", "Lebensla"],
    ["C:/Users/x/STRASSE/cv-2026.docx", "straße", "cv-2026"],
    ["C:/Users/x/İş Başvuru/cv-2026.docx", "iş başvuru", "cv-2026"],
    ["C:/Users/x/Doc\u200Buments/cv-2026.docx", "x/documents/", "cv-2026"],
    ["C:\uFF0FUsers\uFF0Fx\uFF0FDocuments\uFF0Fcv-2026.docx", "x/documents/", "cv-2026"],
    ["C:/Users/x/ΟΔΟΣ/a.docx", "οδος", "ΟΔΟΣ"],
    // verifier-4: characters that fold into "..", which must not delete the rule's term
    ["C:/Users/x/Documents/cv-2026/\u2025/notes.txt", "cv", "cv-2026"],
    ["C:\\Users\\x\\Documents\\cv-2026\\\uFF0E\uFF0E\\a.docx", "cv", "cv-2026"]
  ];
  for (const [p, rule, needle] of cases) {
    const { out } = await sweepAndDump({
      collectors: [files("C:", [{ path: p, size: 1 }])],
      quarantine: [rule]
    });
    assert.ok(!out.includes(needle), `${JSON.stringify(p)} with ${rule} leaked ${needle}`);
  }
});

test("media and apps: titles, names, roots and relative paths stay hidden on every spelling", async () => {
  const mediaCases = [
    [{ root: "D:/Videos", path: "a.mp4", title: "My CV/.." }, "cv", "My CV"],
    [{ root: "D:/Videos", path: "a.mp4", title: "Job CV/../Final" }, "cv", "Job CV"],
    [{ root: "D:/Videos", path: "cv-2026/\u2025/a.mp4", title: "t" }, "cv", "cv-2026"],
    [
      { root: "D:\\Private\\CV", path: "interview.mp4", title: "my interview" },
      "private/cv",
      "interview"
    ],
    [
      { root: "D:/Private/", path: "cv/interview.mp4", title: "secret title" },
      "private/cv",
      "secret title"
    ],
    [
      { root: "D:/Private", path: "./cv/interview.mp4", title: "secret title" },
      "private/cv",
      "secret title"
    ],
    [{ root: "D:\\Private", path: "cv\\\\talk.mp4", title: "Talk" }, /cv\/\/talk/iu, "talk.mp4"],
    [
      { root: "F:/media/Home", path: "clip-0042.mp4", title: "Acme job interview" },
      "job interview",
      "clip-0042"
    ]
  ];
  for (const [row, rule, needle] of mediaCases) {
    const { out } = await sweepAndDump({
      collectors: [media([{ ...row, size: 5 }])],
      scope: [],
      quarantine: [rule]
    });
    assert.ok(!out.includes(needle), `${JSON.stringify(row)} leaked ${needle}`);
  }
  const appCases = [
    [{ name: "CV Builder/..", version: "1" }, "cv", "CV Builder"],
    [{ name: "Resume Wizard", publisher: "C:/Users/x/cv-2026.docx" }, "cv-2026", "Resume Wizard"],
    [
      { name: "ok", location: "C:\\Users\\x\\Documents\\Applications\\cv-builder" },
      /\\Documents\\Applications\\/iu,
      "cv-builder"
    ]
  ];
  for (const [row, rule, needle] of appCases) {
    const { out } = await sweepAndDump({
      collectors: [apps([row])],
      scope: [],
      quarantine: [rule]
    });
    assert.ok(!out.includes(needle), `${JSON.stringify(row)} leaked ${needle}`);
  }
});

test("errors: no encoding of a path in an error, and no code matching a rule, reaches any output", async () => {
  const thrown = [
    Object.assign(new Error("open 'C:\\Users\\x\\Documents\\cv-2026.docx'"), { code: "EPERM" }),
    new Error(`stat failed ${JSON.stringify("C:\\Users\\x\\Documents\\cv-2026.docx")}`),
    new Error("fetch file:///C:/Users/x/My%20Documents/cv-2026.docx"),
    Object.assign(new Error("x"), { code: "C:/Users/x/cv-2026.docx" }),
    Object.assign(new Error("wrapped"), { cause: new Error("C:/Users/x/cv-2026.docx") }),
    Object.assign(new Error("x"), { code: "CV_2026" }),
    { path: "C:/Users/x/cv-2026.docx" },
    "C:\\Users\\x\\cv-2026.docx"
  ];
  for (const err of thrown) {
    const boom = {
      name: "boom",
      kind: "files",
      volumes: ["C:"],
      async *collect() {
        throw err;
      }
    };
    const { sweep, out } = await sweepAndDump({
      collectors: [boom],
      quarantine: [/^C:\/Users\/x\/Documents\//iu, "cv_2026"]
    });
    assert.ok(
      !out.toLowerCase().includes("cv-2026") && !out.includes("CV_2026"),
      `leaked via ${String(err?.message ?? err)}`
    );
    assert.match(sweep.collectors[0].error_code, /^(EPERM|UNKNOWN)$/u);
  }
});

// --- matcher, with every path genuinely under a public root after canonicalisation --------------
// (a spelling that is NOT under a root is hidden by structure, which would mask a matcher defect)

async function listedUnder(root, fileRows, rule) {
  const ctx = setup();
  const volume = root.slice(0, 2);
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [files(volume, fileRows)],
    scope: [volume],
    publicRoots: [root],
    quarantine: rule === undefined ? [] : [rule]
  });
  return ctx.db
    .prepare("SELECT path FROM files ORDER BY path")
    .all()
    .map((r) => r.path);
}

test("a public root is matched at a segment boundary, never as a string prefix", async () => {
  assert.deepEqual(
    await listedUnder("F:/nas", [
      { path: "F:/nas/ok.pdf", size: 1 },
      { path: "F:/nasty/secret.pdf", size: 1 },
      { path: "F:/nas-private/secret.pdf", size: 1 }
    ]),
    ["F:/nas/ok.pdf"]
  );
});

test("media outside every public root is counted, not listed", async () => {
  const ctx = setup();
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [
      media([
        { root: "F:/media", path: "film.mkv", size: 1 },
        { root: "D:/Private", path: "home.mp4", title: "Home", size: 2 }
      ])
    ],
    scope: [],
    publicRoots: ["F:/media"]
  });
  assert.deepEqual(
    ctx.db
      .prepare("SELECT path FROM media")
      .all()
      .map((r) => r.path),
    ["F:/media/film.mkv"]
  );
  assert.equal(ctx.db.prepare("SELECT items FROM totals WHERE kind = 'media'").get().items, 1);
});

test("string rules written as any path spelling match the canonical stored path", async () => {
  const stored = { path: "C:/Users/x/Documents/cv-2026.docx", size: 1 };
  for (const rule of [
    "C:\\Users\\x\\..\\x\\Documents",
    "x/y/../Documents",
    "./Documents/./cv",
    "\\\\?\\C:\\Users\\x\\Documents",
    "C:\\\\Users\\\\x\\\\Documents"
  ])
    assert.deepEqual(await listedUnder("C:/Users", [stored], rule), [], `${rule} missed`);
});

test("folding under a public root: trailing dots and spaces, compatibility forms, final sigma", async () => {
  const cases = [
    [{ path: "C:/Users/x/Jobs. /cv.docx", size: 1 }, "x/jobs/"],
    [{ path: "C:/Users/x/Jobs./cv.docx", size: 1 }, "x/jobs/"],
    // only the trailing-dot/space fold can match here: the rule continues past the segment
    [{ path: "C:/Users/x/Jobs./cv.docx", size: 1 }, "x/jobs/cv"],
    [{ path: "C:/Users/x/Jobs /cv.docx", size: 1 }, "x/jobs/cv"],
    [{ path: "C:/Users/x/\uFF23\uFF36-2026.docx", size: 1 }, "cv-2026"],
    [{ path: "C:/Users/x/Documents\uFF0Fcv-2026.docx", size: 1 }, "documents/cv"],
    [{ path: "C:/Users/x/ΟΔΟΣ/a.docx", size: 1 }, "οδοσ"]
  ];
  for (const [row, rule] of cases)
    assert.deepEqual(await listedUnder("C:/Users", [row], rule), [], `${row.path} vs ${rule}`);
  assert.deepEqual(
    await listedUnder("C:/Users", [{ path: "C:/Users/x/menu.pdf", size: 1 }], "οδοσ"),
    ["C:/Users/x/menu.pdf"]
  );
});

test("RegExp rules see the original spelling and the backslash spelling of a forward-slash path", async () => {
  // the original: Win32 would drop the trailing dot, but an operator may have written it
  assert.deepEqual(
    await listedUnder("C:/Users", [{ path: "C:/Users/x/Jobs./cv.docx", size: 1 }], /jobs\.\//u),
    []
  );
  // the backslash spelling of a path the collector gave with forward slashes
  assert.deepEqual(
    await listedUnder(
      "C:/Users",
      [{ path: "C:/Users/x/Documents/Applications/cv-2026.docx", size: 1 }],
      /\\Documents\\Applications\\/u
    ),
    []
  );
});

test("a title-only rule added later removes an already listed media row, even without that collector", async () => {
  const ctx = setup();
  const m = media([{ root: "F:/media", path: "a.mp4", title: "Acme interview", size: 1 }]);
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [m],
    scope: [],
    publicRoots: ["F:/media"]
  });
  const later = await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [],
    scope: [],
    publicRoots: ["F:/media"],
    quarantine: ["interview"]
  });
  assert.ok(!(await allOutput(ctx, later)).includes("Acme interview"));
});

// --- verifier-5 findings (claude-s0-verifier-5) -----------------------------------------------------

test("a string rule found literally in stored free text always matches, whatever path-like characters it holds", async () => {
  const appCases = [
    [{ name: "Scout", publisher: "https://recruit.example/jobs" }, "https://recruit.example"],
    [{ name: "Job//Hunter", version: "1" }, "job//hunter"],
    [{ name: "Tool", version: "C:/../cv" }, "C:/../cv"],
    [{ name: "Job\\\\Hunter", version: "1" }, "job\\\\hunter"]
  ];
  for (const [row, rule] of appCases) {
    const ctx = setup();
    await runSweep({
      db: ctx.db,
      machine: "vm",
      collectors: [apps([row])],
      scope: [],
      publicRoots: ["F:/nas"],
      quarantine: [rule]
    });
    assert.equal(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM apps").get().n,
      0,
      `${JSON.stringify(row)} vs ${rule}`
    );
  }
  const ctx = setup();
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [media([{ root: "F:/media", path: "a.mp4", title: "cv/./draft final", size: 1 }])],
    scope: [],
    publicRoots: ["F:/media"],
    quarantine: ["cv/./draft"]
  });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM media").get().n, 0);
});

test("an accented title (precomposed) is still matched by the unaccented rule", async () => {
  const ctx = setup();
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [
      media([{ root: "F:/media", path: "a.mp4", title: "R\u00e9sum\u00e9 2026", size: 1 }])
    ],
    scope: [],
    publicRoots: ["F:/media"],
    quarantine: ["resume"]
  });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM media").get().n, 0);
});

test("changing a string rule to the RegExp with the same text is a policy change, even if the collector fails", async () => {
  const ctx = setup();
  let fail = false;
  const f = {
    name: "f",
    kind: "files",
    volumes: ["F:"],
    async *collect() {
      if (fail) throw new Error("x");
      yield { path: "F:/nas/acvb/report.pdf", size: 1 };
    }
  };
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [f],
    scope: ["F:"],
    publicRoots: ["F:/nas"],
    quarantine: ["/cv/"]
  });
  assert.equal(
    ctx.db.prepare("SELECT COUNT(*) AS n FROM files").get().n,
    1,
    "string rule '/cv/' does not match acvb"
  );
  fail = true;
  const later = await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [f],
    scope: ["F:"],
    publicRoots: ["F:/nas"],
    quarantine: [/cv/]
  });
  assert.ok(!(await allOutput(ctx, later)).includes("acvb"));
});

test("removing or narrowing a root while every collector fails still removes files, media and app locations", async () => {
  const ctx = setup();
  let fail = false;
  const boom = (kind, name, rows) => ({
    name,
    kind,
    volumes: ["F:"],
    async *collect() {
      if (fail) throw new Error("x");
      for (const r of rows) yield r;
    }
  });
  const collectors = [
    boom("files", "f", [{ path: "F:/nas/private/a.pdf", size: 1 }]),
    boom("media", "m", [{ root: "F:/nas/private", path: "b.mp4", size: 1 }]),
    boom("apps", "a", [{ name: "Tool", version: "1", location: "F:/nas/private/tool" }])
  ];
  await runSweep({ db: ctx.db, machine: "vm", collectors, scope: ["F:"], publicRoots: ["F:/nas"] });
  fail = true;
  const later = await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors,
    scope: ["F:"],
    publicRoots: ["F:/nas/public"]
  });
  const out = await allOutput(ctx, later);
  for (const leak of ["a.pdf", "b.mp4", "private/tool"])
    assert.ok(!out.includes(leak), `leaked ${leak}`);
  assert.equal(
    ctx.db.prepare("SELECT name FROM apps").get()?.name,
    "Tool",
    "the app identity itself is not path-private"
  );
});

test("a rule added against a public root is refused, but only after the index is cleaned", async () => {
  const ctx = setup();
  const f = files("F:", [{ path: "F:/nas/cv-archive/a.pdf", size: 1 }]);
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [f],
    scope: ["F:"],
    publicRoots: ["F:/nas/cv-archive"]
  });
  await assert.rejects(
    runSweep({
      db: ctx.db,
      machine: "vm",
      collectors: [f],
      scope: ["F:"],
      publicRoots: ["F:/nas/cv-archive"],
      quarantine: ["cv"]
    }),
    /matching no rule/u
  );
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
});

test("an absolute media path outside its public root is never joined under the root", async () => {
  const ctx = setup();
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [media([{ root: "F:/media", path: "C:/Users/x/secret.mp4", title: "t", size: 1 }])],
    scope: [],
    publicRoots: ["F:/media"]
  });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM media").get().n, 0);
});

test("totals categories come from the path, never from a collector-supplied category", async () => {
  const { ctx, out } = await sweepAndDump({
    collectors: [
      files("C:", [{ path: "C:/Users/x/a.pdf", size: 1, category: "C:/Users/x/cv-2026" }])
    ],
    publicRoots: ["F:/nas"]
  });
  assert.equal(ctx.db.prepare("SELECT category FROM totals").get().category, "documents");
  assert.ok(!out.includes("cv-2026"));
});

test("a leading ../ in a string rule still matches the folder it names", async () => {
  assert.deepEqual(
    await listedUnder(
      "C:/Users",
      [{ path: "C:/Users/x/Documents/cv.docx", size: 1 }],
      "..\\Documents\\cv"
    ),
    []
  );
});

test("a UNC path cannot climb from one server to another", async () => {
  assert.equal(canonPath("//evil/../srv/x"), "//evil/srv/x");
  assert.equal(canonPath("\\\\srv\\share\\..\\..\\x"), "//srv/share/x");
  const ctx = setup();
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [
      files("//srv/share", [{ path: "//evil/../srv/share/secret.pdf", size: 1 }], "unc")
    ],
    scope: ["//srv/share"],
    publicRoots: ["//srv/share"]
  });
  assert.equal(ctx.db.prepare("SELECT COUNT(*) AS n FROM files").get().n, 0);
});

test("combined folds, and a RegExp that needs the raw collected text", async () => {
  // fullwidth J (NFKC) + accent + trailing dot + doubled separator in one value and one rule
  assert.deepEqual(
    await listedUnder(
      "C:/Users",
      [{ path: "C:/Users/x/\uFF2A\u00f6b.//cv.docx", size: 1 }],
      "j\u00f6b.//cv"
    ),
    []
  );
  // raw only: folding turns ß into ss, so a RegExp written with ß needs the text as collected
  assert.deepEqual(
    await listedUnder(
      "C:/Users",
      [{ path: "C:/Users/x/Stra\u00dfe/cv.docx", size: 1 }],
      /stra\u00dfe/u
    ),
    []
  );
});

// --- verifier-6 findings (claude-s0-verifier-6) -----------------------------------------------------

test("a RegExp spanning a canonicalised part AND a folded character matches the stored canonical path", async () => {
  const cases = [
    ["F:/nas//Wei\u00df/secretw1.pdf", /nas\/Wei\u00df/u, "secretw1"],
    ["\\\\?\\F:\\nas\\Stra\u00dfe\\secretw2.pdf", /^F:\/nas\/Stra\u00dfe/u, "secretw2"],
    ["F:/nas/\u0130stanbul/./secretw3.pdf", /\u0130stanbul\/secretw3/u, "secretw3"],
    ["F:/nas/x/../Wei\u00df/secretw4.pdf", /nas\/Wei\u00df/u, "secretw4"],
    ["F:/nas/\uFB01nance//secretw5.pdf", /\uFB01nance\/secretw5/u, "secretw5"]
  ];
  for (const [p, rule, needle] of cases) {
    const ctx = setup();
    const policy = { scope: ["F:"], publicRoots: ["F:/nas"], quarantine: [rule] };
    const f = files("F:", [{ path: p, size: 1 }]);
    await runSweep({ db: ctx.db, machine: "vm", collectors: [f], ...policy });
    // twice with the same policy: the unchanged fingerprint must not let a second sweep list it
    const again = await runSweep({ db: ctx.db, machine: "vm", collectors: [f], ...policy });
    assert.ok(!(await allOutput(ctx, again)).includes(needle), `${p} with ${rule} leaked`);
  }
  const ctx = setup();
  const m = media([{ root: "F:/media/", path: "./Wei\u00df/secretm1.mp4", title: "t", size: 1 }]);
  const sweep = await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [m],
    scope: [],
    publicRoots: ["F:/media"],
    quarantine: [/media\/Wei\u00df/u]
  });
  assert.ok(!(await allOutput(ctx, sweep)).includes("secretm1"));
});

test("a global RegExp rule hides every matching row, not every other one", async () => {
  const rows = ["a", "b", "c", "d"].map((d) => ({ path: `F:/nas/${d}/\uFB01le`, size: 1 }));
  assert.deepEqual(await listedUnder("F:/nas", rows, /\/\uFB01le$/gu), []);
});

test("a later rule on a stored app location removes the app, even if the apps collector fails", async () => {
  const ctx = setup();
  let fail = false;
  const a = {
    name: "a",
    kind: "apps",
    async *collect() {
      if (fail) throw new Error("x");
      yield { name: "Harmless", version: "1", location: "F:/nas/apps/jobhunt/tool" };
    }
  };
  await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [a],
    scope: [],
    publicRoots: ["F:/nas"]
  });
  assert.equal(
    ctx.db.prepare("SELECT location FROM apps").get().location,
    "F:/nas/apps/jobhunt/tool"
  );
  fail = true;
  const later = await runSweep({
    db: ctx.db,
    machine: "vm",
    collectors: [a],
    scope: [],
    publicRoots: ["F:/nas"],
    quarantine: ["jobhunt"]
  });
  const out = await allOutput(ctx, later);
  assert.ok(!out.includes("Harmless") && !out.includes("jobhunt/tool"));
});

test("every refused configuration still cleans the index with the valid part of the policy first", async () => {
  const refusals = [
    { collectors: [{ ...files("F:", []), name: "cvfiles" }] },
    { scope: ["F:/cv-volume"] },
    { quarantine: ["cv", "..."] },
    { collectors: [{ ...files("F:", []), kind: "bogus" }] }
  ];
  for (const bad of refusals) {
    const ctx = setup();
    const f = files("F:", [{ path: "F:/nas/cv-2026.pdf", size: 1 }]);
    await runSweep({
      db: ctx.db,
      machine: "vm",
      collectors: [f],
      scope: ["F:"],
      publicRoots: ["F:/nas"]
    });
    await assert.rejects(
      runSweep({
        db: ctx.db,
        machine: "vm",
        collectors: [],
        scope: [],
        publicRoots: ["F:/nas"],
        quarantine: ["cv"],
        ...bad
      }),
      TypeError
    );
    const out = [ctx.dbPath, `${ctx.dbPath}-wal`]
      .filter((x) => fs.existsSync(x))
      .map((x) => fs.readFileSync(x).toString("utf8"))
      .join("");
    assert.ok(
      ctx.db.prepare("SELECT COUNT(*) AS n FROM files").get().n === 0 && !out.includes("cv-2026"),
      `refusal ${JSON.stringify(Object.keys(bad))} kept a row the valid rule hides`
    );
  }
});
