// S2 — application, service, task and port collectors.
// Every Scenario in delivery/tasks/S2.md maps to a test here, plus the integrity rules the sources
// share: a source that cannot answer fails loudly and alone, and is never a shorter list.
import assert from "node:assert/strict";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  APP_SOURCES,
  appCollectors,
  capture,
  isLoopback,
  normalizeName,
  parseWingetList,
  reconcile,
  serviceImagePath,
  versionConflicts
} from "../server/coordination/lib/estate_map_apps.mjs";
import { openMap, runSweep } from "../server/coordination/lib/estate_map.mjs";

const tempDir = (t, prefix) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// A PowerShell that never runs: it writes what the test says this source would have written, to the
// very path the library told it to use, so the file plumbing is exercised rather than stubbed out.
function fakeExec(answers) {
  return async (_cmd, args) => {
    const script = args[args.length - 1];
    const out = /\$out='([^']+)'/u.exec(script)[1];
    const tag = /estate-apps-([a-z]+)-/u.exec(out)[1];
    const answer = answers[tag] ?? { code: 0, text: JSON.stringify({ rows: [], errors: 0 }) };
    if (answer.text !== undefined) await fsp.writeFile(out, answer.text, "utf8");
    return { code: answer.code ?? 0, stdout: "" };
  };
}

const json = (rows, errors = 0) => ({ text: JSON.stringify({ rows, errors }) });

const collect = async (collector) => {
  const rows = [];
  for await (const r of collector.collect({ machine: "t480", volume: null })) rows.push(r);
  return rows;
};

const collectorNamed = (name, options) => appCollectors(options).find((c) => c.name === name);

const rejects = (fn, code) =>
  assert.rejects(fn, (e) => {
    assert.equal(e.code, code, `expected ${code}, got ${e.code}`);
    return true;
  });

// `winget list` as it really comes out: five left-aligned columns of fixed width, then a rule line.
const WIDTHS = [25, 24, 13, 13, 0];
const wingetLine = (cells) => cells.map((c, i) => String(c).padEnd(WIDTHS[i])).join("").trimEnd();
const wingetTable = (rows) =>
  [
    wingetLine(["Name", "Id", "Version", "Available", "Source"]),
    "-".repeat(84),
    ...rows.map(wingetLine)
  ].join("\r\n");

const WINGET = wingetTable([
  ["Prime-Silo 1.24.5", "ARP\\Machine\\X64\\{p-s}", "1.24.5", "", ""],
  ["Tailscale", "Tailscale.Tailscale", "1.102.3", "1.102.4", "winget"],
  ["Node.js", "OpenJS.NodeJS", "24.18.0", "", "winget"]
]);

// --- winget's fixed-width export ------------------------------------------------------------------

test("winget columns are read at the header's offsets", () => {
  const rows = parseWingetList(WINGET);
  assert.deepEqual(rows, [
    { name: "Prime-Silo 1.24.5", id: "ARP\\Machine\\X64\\{p-s}", version: "1.24.5" },
    { name: "Tailscale", id: "Tailscale.Tailscale", version: "1.102.3" },
    { name: "Node.js", id: "OpenJS.NodeJS", version: "24.18.0" }
  ]);
});

test("a value overflowing its column fails the source instead of reporting a wrong version", () => {
  const bled = wingetTable([
    ["Tailscale", "Tailscale.Tailscale", "1.102.3", "1.102.4", "winget"],
    // a name one character too long for its column: its last letter sits where Id must start
    ["A".repeat(25), "Some.Package", "9.9", "", "winget"]
  ]);
  assert.throws(
    () => parseWingetList(bled),
    (e) => e.code === "WINGET_MALFORMED" && e.detail.rows === 1
  );
});

test("columns are followed, not assumed: a narrower table reads the same", () => {
  const narrow = [
    "Name        Id             Version   Source",
    "-".repeat(44),
    "Tailscale   Tailscale.Tai  1.102.3   winget",
    "Node.js     OpenJS.NodeJS  24.18.0   winget"
  ].join("\r\n");
  assert.deepEqual(parseWingetList(narrow), [
    { name: "Tailscale", id: "Tailscale.Tai", version: "1.102.3" },
    { name: "Node.js", id: "OpenJS.NodeJS", version: "24.18.0" }
  ]);
});

test("winget output with no header is a failure, not an empty list", () => {
  assert.throws(() => parseWingetList("a progress spinner and nothing else\n"), (e) => e.code === "WINGET_NO_HEADER");
});

test("the rule line and progress characters are not applications", () => {
  const rows = parseWingetList(`${WINGET}\r\n  -\r\n   \\\r\n`);
  assert.equal(rows.length, 3);
});

// --- what each source calls an application --------------------------------------------------------

test("registry components and patches are not applications", () => {
  const rows = APP_SOURCES.registry.rows([
    { DisplayName: "Prime-Silo 1.24.5", DisplayVersion: "1.24.5", Publisher: "binary16", InstallLocation: "C:\\ps" },
    { DisplayName: "Python 3.12 Core Interpreter", DisplayVersion: "3.12", SystemComponent: 1 },
    { DisplayName: "Security Update KB1", DisplayVersion: "1", ReleaseType: "Security Update" },
    { DisplayName: "Some Patch", DisplayVersion: "1", ParentKeyName: "{other-product}" },
    { DisplayVersion: "9", Publisher: "nameless" }
  ]);
  assert.deepEqual(rows, [
    { name: "Prime-Silo 1.24.5", version: "1.24.5", publisher: "binary16", location: "C:\\ps" }
  ]);
});

test("a service carries its run state, display name and image path", () => {
  assert.deepEqual(
    APP_SOURCES.services.rows([
      { Name: "Tailscale", DisplayName: "Tailscale", State: "Running", PathName: '"C:\\Program Files\\Tailscale\\tailscaled.exe"' }
    ]),
    [{ name: "service:Tailscale", version: "Running", publisher: "Tailscale", location: "C:\\Program Files\\Tailscale\\tailscaled.exe" }]
  );
});

test("a service image path is read whether or not it is quoted", () => {
  assert.equal(serviceImagePath('"C:\\Program Files\\Everything\\Everything.exe" -svc'), "C:\\Program Files\\Everything\\Everything.exe");
  assert.equal(serviceImagePath("C:\\Windows\\system32\\svchost.exe -k netsvcs -p"), "C:\\Windows\\system32\\svchost.exe");
  assert.equal(serviceImagePath(null), null);
});

test("a scheduled task is named by its full path and carries its state", () => {
  assert.deepEqual(
    APP_SOURCES.tasks.rows([
      { TaskName: "PrimeSiloUpdate", TaskPath: "\\binary16\\", StateName: "Ready", Author: "binary16", Run: "C:\\ps\\update.exe" }
    ]),
    [{ name: "task:\\binary16\\PrimeSiloUpdate", version: "Ready", publisher: "binary16", location: "C:\\ps\\update.exe" }]
  );
});

test("two installs one source names alike stay two rows in the map", () => {
  const appx = APP_SOURCES.appx.rows([
    { Name: "Microsoft.VCLibs.140.00", Version: "14.0.33519.0", PackageFullName: "Microsoft.VCLibs.140.00_14.0.33519.0_x64__8w", InstallLocation: "C:\\x64" },
    { Name: "Microsoft.VCLibs.140.00", Version: "14.0.33519.0", PackageFullName: "Microsoft.VCLibs.140.00_14.0.33519.0_x86__8w", InstallLocation: "C:\\x86" },
    { Name: "Microsoft.Paint", Version: "11.0", PackageFullName: "Microsoft.Paint_11.0_x64__8w", InstallLocation: "C:\\paint" }
  ]);
  // S0 keys on (name, version, source), so colliding rows carry the identity that tells them apart —
  // and the one that collides with nothing keeps its clean name
  assert.deepEqual(appx.map((r) => r.name), [
    "Microsoft.VCLibs.140.00 [Microsoft.VCLibs.140.00_14.0.33519.0_x64__8w]",
    "Microsoft.VCLibs.140.00 [Microsoft.VCLibs.140.00_14.0.33519.0_x86__8w]",
    "Microsoft.Paint"
  ]);
  assert.equal(new Set(appx.map((r) => `${r.name}|${r.version}`)).size, 3, "no two rows share S0's key");
  assert.deepEqual(Object.keys(appx[0]), ["name", "version", "publisher", "location"], "the identity is not a stored field");
  assert.equal(reconcile(appx.map((r) => ({ ...r, source: "appx" }))).length, 2, "but they are still one product");
});

test("winget's Id tells two same-named entries apart", () => {
  const rows = APP_SOURCES.winget.rows(
    wingetTable([
      ["Adobe Acrobat Reader", "MSIX\\Reader_26_x64__33q", "26.0.0.1", "", ""],
      ["Adobe Acrobat Reader", "MSIX\\Reader_26_x64__pc7", "26.0.0.1", "", ""],
      ["Tailscale", "Tailscale.Tailscale", "1.102.3", "", "winget"]
    ])
  );
  assert.deepEqual(rows.map((r) => r.name), [
    "Adobe Acrobat Reader [MSIX\\Reader_26_x64__33q]",
    "Adobe Acrobat Reader [MSIX\\Reader_26_x64__pc7]",
    "Tailscale"
  ]);
});

// --- Scenario: loopback services are recorded as loopback -------------------------------------------

test("a loopback listener is not reported as exposed", () => {
  const rows = APP_SOURCES.ports.rows([
    { LocalAddress: "127.0.0.1", LocalPort: 8005, Process: "python", Image: "C:\\benny\\python.exe" },
    { LocalAddress: "0.0.0.0", LocalPort: 1234, Process: "LM Studio", Image: "C:\\lms\\lms.exe" },
    { LocalAddress: "::1", LocalPort: 8005, Process: "python", Image: null },
    { LocalAddress: "::", LocalPort: 3030, Process: "Prime-Silo", Image: null },
    { LocalAddress: "192.168.0.108", LocalPort: 139, Process: "System", Image: null }
  ]);
  assert.deepEqual(
    rows.map((r) => [r.name, r.version]),
    [
      ["port:tcp/127.0.0.1:8005", "loopback"],
      ["port:tcp/0.0.0.0:1234", "exposed"],
      ["port:tcp/[::1]:8005", "loopback"],
      ["port:tcp/[::]:3030", "exposed"],
      ["port:tcp/192.168.0.108:139", "exposed"]
    ]
  );
  assert.equal(rows[0].publisher, "python");
});

test("every address that is not the loopback is exposed", () => {
  for (const a of ["127.0.0.1", "127.9.9.9", "::1", "[::1]"]) assert.equal(isLoopback(a), true, a);
  // a loopback address STARTS 127.: an address that merely contains it is somebody else's
  for (const a of ["0.0.0.0", "::", "192.168.0.108", "10.127.0.1", "100.99.229.31", "", null])
    assert.equal(isLoopback(a), false, String(a));
});

test("a listener whose process cannot be read is still listed", () => {
  const [row] = APP_SOURCES.ports.rows([{ LocalAddress: "0.0.0.0", LocalPort: 4444, Process: null, Image: null }]);
  assert.deepEqual(row, { name: "port:tcp/0.0.0.0:4444", version: "exposed", publisher: null, location: null });
});

// --- Scenario: one product reported by two sources is one app ----------------------------------------

test("one product reported by two sources is one app naming both", () => {
  const folded = reconcile([
    { name: "Prime-Silo 1.24.5", version: "1.24.5", publisher: "binary16", location: "C:\\ps", source: "registry" },
    { name: "Prime-Silo", version: "1.24.5", publisher: null, location: null, source: "winget" }
  ]);
  assert.equal(folded.length, 1);
  assert.deepEqual(folded[0].sources, ["registry", "winget"]);
  assert.equal(folded[0].name, "Prime-Silo");
  assert.equal(folded[0].publisher, "binary16", "a source that knows the publisher supplies it");
});

test("sources disagreeing about a version are kept side by side, never merged", () => {
  const folded = reconcile([
    { name: "Python 3.12.10 (64-bit)", version: "3.12.10150.0", source: "registry" },
    { name: "Python 3.12.10 (64-bit)", version: "3.12.10", source: "winget" }
  ]);
  assert.equal(folded.length, 2);
  assert.deepEqual(folded.map((e) => e.version).sort(), ["3.12.10", "3.12.10150.0"]);
  const [conflict] = versionConflicts(folded);
  assert.equal(conflict.length, 2, "and the disagreement is reported as one");
});

test("only decoration is stripped from a name, never the product", () => {
  assert.equal(normalizeName("Prime-Silo 1.24.5", "1.24.5"), "prime-silo");
  assert.equal(normalizeName("Everything 1.5.0.1423b (x64)", "1.5.0.1423"), "everything 1.5.0.1423b");
  assert.equal(normalizeName("Git  for   Windows (64-bit)", "2.46.1"), "git for windows");
  assert.equal(normalizeName("Node.js", "24.18.0"), "node.js");
  assert.equal(normalizeName("7-Zip 24.09", "24.08"), "7-zip 24.09", "a version that is not this row's is part of the name");
});

test("different products are never folded together", () => {
  const folded = reconcile([
    { name: "Python Launcher", version: "3.12.10", source: "winget" },
    { name: "Python 3.12", version: "3.12.10", source: "winget" }
  ]);
  assert.equal(folded.length, 2);
});

// --- Scenario: a missing source is a warning, not an empty estate --------------------------------------

test("an absent source fails alone: the other sources still list their apps", async () => {
  const exec = fakeExec({
    registry: json([{ DisplayName: "Prime-Silo 1.24.5", DisplayVersion: "1.24.5" }]),
    winget: { code: 1, text: undefined },
    appx: json([{ Name: "Microsoft.Paint", Version: "11.0" }]),
    services: json([{ Name: "Tailscale", State: "Running", PathName: "t.exe" }]),
    tasks: json([{ TaskName: "T", TaskPath: "\\", StateName: "Ready" }]),
    ports: json([{ LocalAddress: "127.0.0.1", LocalPort: 8005 }])
  });
  const results = [];
  for (const c of appCollectors({ exec })) {
    try {
      results.push([c.name, (await collect(c)).length]);
    } catch (e) {
      results.push([c.name, e.code]);
    }
  }
  assert.deepEqual(results, [
    ["registry", 1],
    ["winget", "WINGET_UNAVAILABLE"],
    ["appx", 1],
    ["services", 1],
    ["tasks", 1],
    ["ports", 1]
  ]);
});

test("a failing source keeps the rows it listed last time; the sweep records the error", async (t) => {
  const db = openMap(path.join(tempDir(t, "s2map-"), "map.db"));
  const answers = {
    registry: json([{ DisplayName: "Prime-Silo 1.24.5", DisplayVersion: "1.24.5", InstallLocation: "C:\\ps" }]),
    winget: { text: WINGET },
    appx: json([{ Name: "Microsoft.Paint", Version: "11.0" }]),
    services: json([{ Name: "Tailscale", State: "Running", PathName: "C:\\t\\tailscaled.exe" }]),
    tasks: json([{ TaskName: "T", TaskPath: "\\", StateName: "Ready" }]),
    ports: json([{ LocalAddress: "127.0.0.1", LocalPort: 8005, Process: "python" }])
  };
  const sweep = (exec) =>
    runSweep({ db, machine: "t480", scope: [], publicRoots: ["C:\\"], collectors: appCollectors({ exec }) });
  const count = (sql, ...args) => db.prepare(`SELECT COUNT(*) n FROM apps ${sql}`).get(...args).n;

  const first = await sweep(fakeExec(answers));
  assert.equal(first.counts.listed_apps, 8, "1 registry + 3 winget + 1 each from appx, services, tasks, ports");
  assert.equal(count("WHERE source = 'winget' AND sweep_id = ?", first.id), 3);

  const second = await sweep(fakeExec({ ...answers, winget: { code: 1 } }));
  const failed = second.collectors.find((c) => c.name === "winget");
  assert.equal(failed.status, "errored");
  assert.equal(failed.error_code, "WINGET_UNAVAILABLE");
  assert.equal(second.counts.listed_apps, 5, "the failed source contributes nothing to the counts");
  assert.equal(count("WHERE source = 'winget'"), 3, "the apps winget listed last time are still in the map");
  assert.equal(count("WHERE source = 'winget' AND sweep_id = ?", second.id), 0, "and none is claimed for this sweep");
  db.close();
});

test("a source that answers with nothing has not proved the estate is empty", async () => {
  await rejects(() => collect(collectorNamed("registry", { exec: fakeExec({ registry: json([]) }) })), "REGISTRY_EMPTY");
  await rejects(() => collect(collectorNamed("ports", { exec: fakeExec({ ports: json([]) }) })), "PORTS_EMPTY");
});

test("a source that could not read part of itself is incomplete, not shorter", async () => {
  await rejects(
    () => collect(collectorNamed("registry", { exec: fakeExec({ registry: json([{ DisplayName: "A" }], 1) }) })),
    "REGISTRY_INCOMPLETE"
  );
});

test("a source that failed is not believed, however much it managed to write", async () => {
  // winget prints its table and then exits non-zero when a source is unreachable: the part it wrote
  // is not the estate, so the collector fails rather than report a list that may be missing rows.
  await rejects(
    () => collect(collectorNamed("winget", { exec: fakeExec({ winget: { code: 1, text: WINGET } }) })),
    "WINGET_UNAVAILABLE"
  );
});

test("an unreadable answer is a failure, never a guess", async () => {
  await rejects(() => collect(collectorNamed("appx", { exec: fakeExec({ appx: { text: "<html>error</html>" } }) })), "APPX_UNPARSABLE");
  await rejects(() => collect(collectorNamed("appx", { exec: fakeExec({ appx: { code: 0 } }) })), "APPX_UNAVAILABLE");
});

test("a source is read as UTF-8, whatever the console code page would have done", async () => {
  const rows = await collect(
    collectorNamed("registry", { exec: fakeExec({ registry: json([{ DisplayName: "Müller Röntgen 日本", DisplayVersion: "1" }]) }) })
  );
  assert.equal(rows[0].name, "Müller Röntgen 日本");
});

test("every collector is shaped for the S0 model", () => {
  const cs = appCollectors();
  assert.deepEqual(cs.map((c) => c.name), ["registry", "winget", "appx", "services", "tasks", "ports"]);
  for (const c of cs) assert.equal(c.kind, "apps");
});

test("a source leaves no temporary directory behind, whether it answers or fails", async (t) => {
  const own = tempDir(t, "s2own-");
  const saved = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR };
  process.env.TEMP = process.env.TMP = process.env.TMPDIR = own;
  t.after(() => Object.assign(process.env, saved));
  assert.equal(os.tmpdir(), own, "the sources write their exports here");

  await collect(collectorNamed("registry", { exec: fakeExec({ registry: json([{ DisplayName: "A", DisplayVersion: "1" }]) }) }));
  await rejects(() => collect(collectorNamed("registry", { exec: fakeExec({ registry: { code: 1 } }) })), "REGISTRY_UNAVAILABLE");
  await assert.rejects(() => capture("boom", "throw", { exec: async () => { throw new Error("spawn failed"); } }));
  assert.deepEqual(fs.readdirSync(own), []);
});
