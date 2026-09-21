// S2 — application, service, task and port collectors, hardened by S11 (display width, registry identity).
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
  displayWidth,
  isLoopback,
  isWideCodePoint,
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

// winget pads by DISPLAY width, so a faithful fixture must too: a CJK name fills two columns per
// character. cell() is how winget itself lays a cell out, and is deliberately not the parser's code.
const cell = (s, width) => s + " ".repeat(Math.max(0, width - displayWidth(s)));

test("a double-width application name is read, not refused", () => {
  const head = cell("Name", 25) + cell("Id", 25) + cell("Version", 15) + "Source";
  const jp = cell("日本語アプリ", 25) + cell("Vendor.JpApp", 25) + cell("2.0.0", 15) + "winget";
  const ko = cell("한글 프로그램", 25) + cell("Vendor.KoApp", 25) + cell("1.2.3", 15) + "winget";
  const ascii = cell("Plain App", 25) + cell("Vendor.Plain", 25) + cell("9.9", 15) + "winget";
  // Padded by HAND to the EAW rule, never by displayWidth: "Focus " is 6 columns, the emoji is 2,
  // " App" is 4, so 13 spaces fill the 25-column Name cell. Padding a fixture with the function
  // under test is what made S11's emoji test agree with a table that was wrong (S12, verifier N2).
  const emoji = "Focus \u{1F642} App" + " ".repeat(13) + cell("Vendor.VeryLongPackageId", 25) + cell("4.5", 15) + "winget";
  // NOT asserted: displayWidth(jp) === displayWidth(ascii). cell() pads USING displayWidth, so that
  // comparison holds for any width table whatsoever and proves nothing (verifier D4). The rows that
  // carry weight are the real captures below; these constructed ones only check that a padded table
  // is cut where its header says.
  assert.notEqual(jp.length, ascii.length, "the code-unit lengths differ, which is the whole bug");
  assert.equal(displayWidth(emoji.slice(0, emoji.indexOf("Vendor"))), 25, "the Name cell really is 25 columns wide");

  assert.deepEqual(parseWingetList([head, "-".repeat(70), jp, ko, emoji, ascii].join("\r\n")), [
    { name: "日本語アプリ", id: "Vendor.JpApp", version: "2.0.0" },
    { name: "한글 프로그램", id: "Vendor.KoApp", version: "1.2.3" },
    { name: "Focus \u{1F642} App", id: "Vendor.VeryLongPackageId", version: "4.5" },
    { name: "Plain App", id: "Vendor.Plain", version: "9.9" }
  ]);
});

test("a column is measured in the widths winget actually uses", () => {
  // winget's UTF8ColumnWidth normalises to NFC and walks GRAPHEME CLUSTERS, adding 2 or 1 per
  // cluster from the East Asian Width of its FIRST code point. The unit is the cluster, not the
  // code point — S12 first shipped the latter and refused five real msstore rows for it.
  assert.equal(displayWidth("Plain"), 5);
  assert.equal(displayWidth("\u65e5\u672c\u8a9e"), 6, "each CJK character fills two columns");
  assert.equal(displayWidth("\uff9e\uff8a\uff9d\uff76\uff78"), 5, "half-width katakana fills one");
  assert.equal(displayWidth("\u{1F642}"), 2, "an emoji is EAW Wide and winget pads it as two");
  assert.equal(displayWidth("Cafe\u0301"), 4, "a combining mark joins its base: one cluster, one column");
  assert.equal(displayWidth("\u2764\ufe0f"), 1, "a variation selector does not widen its cluster");
  // a mark with no base is a cluster of its own, and winget gives every cluster at least one column
  assert.equal(displayWidth("\u0301"), 1, "a lone combining mark still occupies a column");
  assert.equal(displayWidth("\ufe0f"), 1, "and so does a lone variation selector");
  assert.equal(
    displayWidth("\u{1F469}\u200d\u{1F4BB}"),
    2,
    "a ZWJ sequence is ONE cluster, measured by its first code point"
  );
  assert.equal(displayWidth("\u{1F44D}\u{1F3FD}"), 2, "and so is a skin-tone modifier");
  assert.equal(displayWidth("\u0928\u093f"), 1, "a Devanagari syllable is one cluster, one column");
  assert.equal(
    displayWidth("\u4e00\u0301"),
    2,
    "a cluster takes the width of its FIRST code point: a wide base with a narrow mark is still 2"
  );
});

test("the width table is the standard's, not a hand-written opinion", () => {
  // the blocks a reviewer of S11 proposed by eye. Hangul Jamo Extended-A is W; Extended-B is N,
  // so adding both by hand — as suggested — would have shipped a new wrong answer.
  assert.equal(isWideCodePoint(0xa960), true, "Hangul Jamo Extended-A is Wide");
  assert.equal(isWideCodePoint(0xd7b0), false, "Hangul Jamo Extended-B is Narrow");
  assert.equal(isWideCodePoint(0x17000), true, "Tangut is Wide");
  assert.equal(isWideCodePoint(0x1f680), true, "so is the rocket");
  assert.equal(isWideCodePoint(0x20000), true, "and the CJK ideographs on plane 2");
  assert.equal(isWideCodePoint(0x3fffd), true, "up to the last code point of the last range");
  assert.equal(isWideCodePoint(0xa97c), true, "a range's final code point is inside it, not past it");
  for (const cp of [0x41, 0x430, 0xae, 0x2013, 0xff61])
    assert.equal(isWideCodePoint(cp), false, `U+${cp.toString(16)} is not wide`);
});

test("a real winget export is read, columns and all", () => {
  // Captured verbatim from `winget search --query <japanese>` on this machine on 2026-09-21. It is
  // real winget padding, not ours: if the width rule is wrong these rows do not line up and the
  // source fails. This is the fixture S11 should have had.
  const CAPTURED = [
    "Name                                      Id                   Version     Source",
    "-----------------------------------------------------------------------------------",
    "\u65e5\u672c\u8a9e \u30ed\u30fc\u30ab\u30eb \u30a8\u30af\u30b9\u30da\u30ea\u30a8\u30f3\u30b9 \u30d1\u30c3\u30af   9N1W692FV4S1         Unknown     msstore",
    "CeVIO AI Voice Package - \u5f26\u5dfb\u30de\u30ad(\u65e5\u672c\u8a9e) AHS.TsurumakiMakiJPN 2.0.0       winget",
    "Google \u65e5\u672c\u8a9e\u5165\u529b                         Google.JapaneseIME   3.34.6260.0 winget"
  ].join("\r\n");
  const head = CAPTURED.split("\r\n")[0];
  for (const row of CAPTURED.split("\r\n").slice(2))
    assert.ok(displayWidth(row) >= displayWidth(head) - 2, "every captured row fills the header's columns");
  assert.deepEqual(parseWingetList(CAPTURED), [
    { name: "\u65e5\u672c\u8a9e \u30ed\u30fc\u30ab\u30eb \u30a8\u30af\u30b9\u30da\u30ea\u30a8\u30f3\u30b9 \u30d1\u30c3\u30af", id: "9N1W692FV4S1", version: "Unknown" },
    { name: "CeVIO AI Voice Package - \u5f26\u5dfb\u30de\u30ad(\u65e5\u672c\u8a9e)", id: "AHS.TsurumakiMakiJPN", version: "2.0.0" },
    { name: "Google \u65e5\u672c\u8a9e\u5165\u529b", id: "Google.JapaneseIME", version: "3.34.6260.0" }
  ]);
});

test("the real rows this parser once refused are read", () => {
  // Captured verbatim from `winget search` on this machine on 2026-09-21: Hindi, Bengali, Tamil,
  // Malayalam and Sinhala msstore titles. claude-s12-verifier found S12's first, per-code-point
  // rule threw WINGET_MALFORMED on every one of them. They are fixtures now so it cannot recur.
  const CAPTURED = [
    {
      script: "Sinhala",
      text: "Name               Id           Version Source\r\n------------------------------------------------\r\n\u0dc3\u0dd2\u0d82\u0dc4\u0dbd \u0db4\u0dd9\u0daf\u0dd9\u0dc3\u0dd2 \u0d85\u0dad\u0dca\u0daf\u0dd0\u0d9a\u0dd3\u0db8\u0dca \u0d87\u0dc3\u0dd4\u0dbb\u0dd4\u0db8 9NVF9QSLGTL0 Unknown msstore",
      name: "\u0dc3\u0dd2\u0d82\u0dc4\u0dbd \u0db4\u0dd9\u0daf\u0dd9\u0dc3\u0dd2 \u0d85\u0dad\u0dca\u0daf\u0dd0\u0d9a\u0dd3\u0db8\u0dca \u0d87\u0dc3\u0dd4\u0dbb\u0dd4\u0db8",
      id: "9NVF9QSLGTL0"
    },
    {
      script: "Tamil",
      text: "Name                Id           Version Source\r\n-------------------------------------------------\r\n\u0ba4\u0bae\u0bbf\u0bb4\u0bcd \u0b89\u0bb3\u0bcd\u0bb3\u0bc2\u0bb0\u0bcd \u0b85\u0ba9\u0bc1\u0baa\u0bb5\u0bae\u0bcd \u0ba4\u0bca\u0b95\u0bc1\u0baa\u0bcd\u0baa\u0bc1 9PDZB1WT1B34 Unknown msstore",
      name: "\u0ba4\u0bae\u0bbf\u0bb4\u0bcd \u0b89\u0bb3\u0bcd\u0bb3\u0bc2\u0bb0\u0bcd \u0b85\u0ba9\u0bc1\u0baa\u0bb5\u0bae\u0bcd \u0ba4\u0bca\u0b95\u0bc1\u0baa\u0bcd\u0baa\u0bc1",
      id: "9PDZB1WT1B34"
    },
    {
      script: "Malayalam",
      text: "Name             Id           Version Source\r\n----------------------------------------------\r\n\u0d2e\u0d32\u0d2f\u0d3e\u0d33\u0d02 \u0d32\u0d4b\u0d15\u0d4d\u0d15\u0d32\u0d4d\u200d \u0d05\u0d28\u0d41\u0d2d\u0d35\u0d02 \u0d2a\u0d3e\u0d2f\u0d4d\u0d15\u0d4d\u0d15\u0d4d 9NWDTV8FFV7L Unknown msstore",
      name: "\u0d2e\u0d32\u0d2f\u0d3e\u0d33\u0d02 \u0d32\u0d4b\u0d15\u0d4d\u0d15\u0d32\u0d4d\u200d \u0d05\u0d28\u0d41\u0d2d\u0d35\u0d02 \u0d2a\u0d3e\u0d2f\u0d4d\u0d15\u0d4d\u0d15\u0d4d",
      id: "9NWDTV8FFV7L"
    },
    {
      script: "Hindi",
      text: "Name                           Id           Version Source\r\n------------------------------------------------------------\r\n\u0939\u093f\u0902\u0926\u0940 \u091f\u093e\u0907\u092a\u093f\u0902\u0917 \u091f\u0947\u0938\u094d\u091f - Hindi Typing Test 9MVKLP2L8KC1 Unknown msstore",
      name: "\u0939\u093f\u0902\u0926\u0940 \u091f\u093e\u0907\u092a\u093f\u0902\u0917 \u091f\u0947\u0938\u094d\u091f - Hindi Typing Test",
      id: "9MVKLP2L8KC1"
    },
    {
      script: "Bengali",
      text: "Name                    Id           Version Source\r\n-----------------------------------------------------\r\n\u09ac\u09be\u0982\u09b2\u09be (\u09ac\u09be\u0982\u09b2\u09be\u09a6\u09c7\u09b6) \u09b8\u09cd\u09a5\u09be\u09a8\u09c0\u09df \u0985\u09ad\u09bf\u099c\u09cd\u099e\u09a4\u09be\u09b0 \u09b8\u09ae\u09cd\u09ad\u09be\u09b0 9PH7TKVXGGM8 Unknown msstore",
      name: "\u09ac\u09be\u0982\u09b2\u09be (\u09ac\u09be\u0982\u09b2\u09be\u09a6\u09c7\u09b6) \u09b8\u09cd\u09a5\u09be\u09a8\u09c0\u09df \u0985\u09ad\u09bf\u099c\u09cd\u099e\u09a4\u09be\u09b0 \u09b8\u09ae\u09cd\u09ad\u09be\u09b0",
      id: "9PH7TKVXGGM8"
    }
  ];
  for (const capture of CAPTURED) {
    const rows = parseWingetList(capture.text);
    assert.ok(rows.length >= 1, `${capture.script}: at least one row`);
    assert.equal(rows[0].name, capture.name, `${capture.script}: the name is read whole`);
    assert.equal(rows[0].id, capture.id, `${capture.script}: and the id lands in its column`);
  }
});

test("a double-width character straddling a column boundary is malformed", () => {
  // the name is 24 columns of ASCII plus one CJK character, so the character starts at column 24
  // and ends at 26: there is no character beginning at the Id column and the row cannot be cut
  const head = cell("Name", 25) + cell("Id", 25) + cell("Version", 15) + "Source";
  const straddle = "A".repeat(24) + "語" + cell("Vendor.X", 25) + cell("1.0", 15) + "winget";
  assert.throws(
    () => parseWingetList([head, "-".repeat(70), straddle].join("\r\n")),
    (e) => e.code === "WINGET_MALFORMED" && e.detail.rows === 1
  );
});

test("a line too short to reach the Version column is not an application", () => {
  const head = cell("Name", 25) + cell("Id", 25) + cell("Version", 15) + "Source";
  const good = cell("Plain App", 25) + cell("Vendor.Plain", 25) + cell("9.9", 15) + "winget";
  // a trailing notice from a future winget must fail loudly, never become an app with no version
  assert.throws(
    () => parseWingetList([head, "-".repeat(70), good, "1 package has an update"].join("\r\n")),
    (e) => e.code === "WINGET_MALFORMED" && e.detail.rows === 1
  );
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

test("one product installed in two hives stays two rows", () => {
  // S0 keys on (name, version, source) and the registry is the one source with no identity of its
  // own, so without the key these two 32/64-bit installs fold into one and one of them vanishes
  const key = (k) => `HKEY_LOCAL_MACHINE\\SOFTWARE\\${k}\\Microsoft\\Windows\\CurrentVersion\\Uninstall`;
  const rows = APP_SOURCES.registry.rows([
    { DisplayName: "Acme Tool", DisplayVersion: "3.1", Key: `${key("")}\\{acme-64}` },
    { DisplayName: "Acme Tool", DisplayVersion: "3.1", Key: `${key("WOW6432Node")}\\{acme-32}` },
    { DisplayName: "Prime-Silo 1.24.5", DisplayVersion: "1.24.5", Key: `${key("")}\\{p-s}` }
  ]);
  assert.equal(new Set(rows.map((r) => `${r.name}|${r.version}`)).size, 3, "no two rows share S0's key");
  assert.equal(rows[2].name, "Prime-Silo 1.24.5", "the entry that collides with nothing keeps its clean name");
  assert.ok(rows[0].name.endsWith("{acme-64}]") && rows[1].name.endsWith("{acme-32}]"), rows[0].name);
  assert.deepEqual(Object.keys(rows[0]), ["name", "version", "publisher", "location"]);
  assert.equal(
    reconcile(rows.map((r) => ({ ...r, source: "registry" }))).length,
    2,
    "and the two installs are still one product"
  );
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

test("a source asks for every field its parser reads", () => {
  // the PowerShell scripts are the largest integrity surface in the library and nothing else tests
  // them: a field dropped from a Select-Object would silently empty that column for every row
  for (const [name, source] of Object.entries(APP_SOURCES)) {
    // winget's rows() reads a row THIS file parsed, not a PowerShell object, so only the JSON
    // sources have a Select-Object to check their fields against
    const reads = source.text
      ? []
      : new Set([...String(source.rows).matchAll(/\br\.([A-Za-z]\w*)/gu)].map((m) => m[1]));
    for (const field of reads)
      // as a selected name of its own, not as a substring of another one ("Key" in "ParentKeyName")
      assert.match(
        source.script,
        new RegExp(`(^|[,\\s(])${field}\\b|n='${field}'`, "u"),
        `${name} reads r.${field} but never asks for it`
      );
    assert.match(source.script, /Out-File -LiteralPath \$out -Encoding utf8/u, `${name} must write UTF-8 to $out`);
  }
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
