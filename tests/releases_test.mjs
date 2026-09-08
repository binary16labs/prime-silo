// Pinned against the feed that was actually live on 2026-09-08, not an invented one.
import test from "node:test";
import assert from "node:assert/strict";
import {
  parseFeed,
  archOf,
  feedCoverage,
  releaseHealth,
  unpublishedTags,
  compareTags
} from "../server/coordination/lib/releases.mjs";

// Verbatim from https://github.com/binary16labs/prime-silo/releases/download/v1.24.0/
const LIVE_WINDOWS_FEED = `version: 1.24.0
releaseDate: 2026-09-07T06:43:24.408Z
files:
  - url: Prime-Silo-1.24-windows-arm64.exe
    sha512: "+NOzBU6/NHYf6D9reS26yfhgVoGZbV9F+V+aebIUJ/bD/WRSWjpf68//jiS04MtMZGKlp9OVPCMxfs60NpN7uA=="
    size: 131556759
path: Prime-Silo-1.24-windows-arm64.exe
sha512: "+NOzBU6/NHYf6D9reS26yfhgVoGZbV9F+V+aebIUJ/bD/WRSWjpf68//jiS04MtMZGKlp9OVPCMxfs60NpN7uA=="
`;

const LIVE_ASSETS = [
  "metadata-latest-windows.yml",
  "Prime-Silo-1.24-windows-arm64.exe",
  "Prime-Silo-1.24-windows-x64.exe"
];

test("arm64 is not read as x64 — the substring trap", () => {
  assert.equal(archOf("Prime-Silo-1.24-windows-arm64.exe"), "arm64");
  assert.equal(archOf("Prime-Silo-1.24-windows-x64.exe"), "x64");
  assert.equal(archOf("metadata-latest-windows.yml"), null);
});

test("the live feed parses to exactly one arm64 entry", () => {
  const feed = parseFeed(LIVE_WINDOWS_FEED);
  assert.equal(feed.version, "1.24.0");
  assert.deepEqual(
    feed.files.map((f) => f.url),
    ["Prime-Silo-1.24-windows-arm64.exe"]
  );
});

test("the real defect is graded mitigated, not stranded", () => {
  // The x64 installer IS published; only the feed omits it. The desktop host's arch fallback
  // reaches the canonical asset, so this degrades the update path without stranding anyone.
  // Grading it "broken" would have put a cosmetic defect and an outage in the same colour.
  const c = feedCoverage({
    feed: parseFeed(LIVE_WINDOWS_FEED),
    assets: LIVE_ASSETS,
    platform: "windows"
  });
  assert.equal(c.state, "gap");
  assert.deepEqual(c.listed, ["arm64"]);
  assert.deepEqual(c.published, ["arm64", "x64"]);
  assert.equal(c.gaps.length, 1);
  assert.equal(c.gaps[0].arch, "x64");
  assert.equal(c.gaps[0].severity, "mitigated");
});

test("a feed pointing at an asset that does not exist strands the machine it names", () => {
  const c = feedCoverage({
    feed: parseFeed(`version: 9.9.9\nfiles:\n  - url: Prime-Silo-9.9-windows-x64.exe\n`),
    assets: ["Prime-Silo-9.9-windows-arm64.exe"],
    platform: "windows"
  });
  const stranded = c.gaps.filter((g) => g.severity === "stranded");
  assert.equal(stranded.length, 1);
  assert.equal(stranded[0].arch, "x64");
  assert.equal(stranded[0].mitigation, null);
});

test("an unreadable feed is unknown, never a gap", () => {
  // "I could not look" and "I looked and it is wrong" must never render the same.
  const c = feedCoverage({ feed: null, assets: LIVE_ASSETS, platform: "windows" });
  assert.equal(c.state, "unknown");
  assert.deepEqual(c.gaps, []);
  assert.match(c.reason, /could not be read/);
});

test("a tag with no release behind it is reported by name", () => {
  // The exact state of this repository on 2026-09-08: v1.24.1 tagged, never published.
  assert.deepEqual(
    unpublishedTags({ tags: ["v1.24.1", "v1.24.0"], releases: [{ tag_name: "v1.24.0" }] }),
    ["v1.24.1"]
  );
  // A non-release tag is not a missing release.
  assert.deepEqual(unpublishedTags({ tags: ["t0-trainer-proven"], releases: [] }), []);
});

test("no release at all is its own state, not a healthy zero", () => {
  const h = releaseHealth({ release: null, tags: [], releases: [] });
  assert.equal(h.state, "none");
  assert.equal(h.latest, null);
});

test("the whole fold grades the live estate as degraded", () => {
  const h = releaseHealth({
    release: {
      tag_name: "v1.24.0",
      published_at: "2026-09-07T06:49:36Z",
      assets: LIVE_ASSETS.map((name) => ({ name }))
    },
    feeds: { windows: parseFeed(LIVE_WINDOWS_FEED) },
    tags: ["v1.24.1", "v1.24.0"],
    releases: [{ tag_name: "v1.24.0" }]
  });
  assert.equal(h.state, "degraded");
  assert.equal(h.counts.stranded, 0);
  assert.equal(h.counts.mitigated, 1);
  assert.deepEqual(h.unpublished, ["v1.24.1"]);
});

test("the same gap on Linux is stranded, because the fallback is Windows-only", () => {
  // This is the live v1.24.0 Linux feed: it lists x64 while both arches are published. The
  // first version of this module graded it "mitigated" by crediting a fallback whose very
  // first line is `if (process.platform !== "win32") return null`. An arm64 Linux machine gets
  // electron-updater's own `?? filteredFiles.shift()` — an installer for the wrong CPU.
  const c = feedCoverage({
    feed: parseFeed(`version: 1.24.0
files:
  - url: Prime-Silo-1.24-linux-x64.AppImage
`),
    assets: ["Prime-Silo-1.24-linux-x64.AppImage", "Prime-Silo-1.24-linux-arm64.AppImage"],
    platform: "linux"
  });
  assert.equal(c.state, "gap");
  assert.equal(c.gaps.length, 1);
  assert.equal(c.gaps[0].arch, "arm64");
  assert.equal(c.gaps[0].severity, "stranded");
  assert.equal(c.gaps[0].mitigation, null);
});

test("tag order is numeric per segment, not lexical", () => {
  // v1.10.0 must outrank v1.9.0. Sorting these as strings is how the window below would have
  // picked the wrong floor and reported a live tag as historical.
  assert.ok(compareTags("v1.10.0", "v1.9.0") > 0);
  assert.ok(compareTags("v1.24.1", "v1.24.0") > 0);
  assert.equal(compareTags("v1.2.3", "v1.2.3"), 0);
});

test("unpublished tags are bounded by the window actually examined", () => {
  // Eighty historical tags are absent from a ten-release page for reasons that have nothing to
  // do with publishing. Reporting them all was a gauge wrong eighty times out of eighty-one.
  const tags = ["v1.0.0", "v1.9.0", "v1.23.0", "v1.24.0", "v1.24.1"];
  const releases = [{ tag_name: "v1.24.0" }, { tag_name: "v1.23.0" }];
  assert.deepEqual(unpublishedTags({ tags, releases }), ["v1.24.1"]);
});
