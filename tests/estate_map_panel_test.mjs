// S4 — the Estate Map panel. Every Scenario in delivery/tasks/S4.md maps to a test here.
//
// The panel's judgements are pure functions, so these run without a DOM. The one thing tested
// about the markup is that it exists and links what it says it links: a view that cannot load its
// own stylesheet is a blank page, and a blank page and an empty estate look identical.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  ageLabel,
  applicationMatrix,
  byteLabel,
  estateView,
  machineCards,
  normalizeProduct,
  storageView,
  storageRects,
  reconcile,
  mediaView,
  treemap,
  versionDrift
} from "../app/L0/_all/mod/_prime_silo/estate_map/fold_view.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = path.join(ROOT, "app/L0/_all/mod/_prime_silo/estate_map");
const FRAMEWORK = path.join(ROOT, "app/L0/_all/mod/_core/framework/js");
const T = (h) => `2026-09-22T${String(h).padStart(2, "0")}:00:00.000Z`;
const NOW = Date.parse(T(11));

const machine = (over = {}) => ({
  sweep_id: "01M31Y102Z4631D8992T33C1FW",
  at: T(10, 45),
  ageMs: 15 * 60_000,
  stale: false,
  since: null,
  counts: { files: 1_117_036, bytes: 1_550_868_580_736, listed_files: 1_117_010, apps: 1073, listed_apps: 1073, media: 0, listed_media: 0 },
  digest: "a".repeat(64),
  snapshot: `sha256:${"b".repeat(64)}`,
  scope: ["F:\\"],
  volumes: { "F:\\": { collector: "everything", status: "ok", rows: 1_117_036, at: T(10, 45), sweep_id: "01M31Y102Z4631D8992T33C1FW" } },
  totals: [],
  ...over
});

// --- Scenario: the panel shows both nodes from the fold alone --------------------------------------

test("a node that stopped pushing is shown stale since, with everything it last said", () => {
  const fold = {
    at: NOW,
    machines: {
      t480: machine({ at: T(10, 45), ageMs: 15 * 60_000 }),
      optimus: machine({
        at: T(10),
        ageMs: 60 * 60_000,
        stale: true,
        since: T(10),
        volumes: { "C:\\": { collector: "walker", status: "ok", rows: 42, at: T(10) } }
      })
    }
  };
  const cards = machineCards(fold, { now: NOW });
  assert.equal(cards.length, 2, "both nodes appear");
  const optimus = cards.find((c) => c.machine === "optimus");
  assert.equal(optimus.stale, true);
  assert.equal(optimus.since, T(10), 'it reads "stale since 10:00"');
  assert.equal(optimus.ageLabel, "1 hour");
  assert.equal(optimus.volumes.length, 1, "and its volumes are still there");
  assert.equal(optimus.volumes[0].rows, 42, "with what it last reported");
  assert.equal(cards[0].machine, "t480", "the live node sorts first, the stale one is not hidden");
});

test("an errored collector is on the card, not swallowed", () => {
  const fold = {
    machines: {
      t480: machine({
        volumes: {
          "C:\\": { collector: "walker", status: "errored", rows: 0, error_code: "WALK_INCOMPLETE", at: T(10, 45) },
          "F:\\": { collector: "everything", status: "ok", rows: 10, at: T(10, 45) }
        }
      })
    }
  };
  const [card] = machineCards(fold, { now: NOW });
  assert.equal(card.errored.length, 1);
  assert.equal(card.errored[0].volume, "C:\\");
  assert.equal(card.errored[0].errorCode, "WALK_INCOMPLETE");
});

test("a volume the newest sweep did not cover carries its own older age", () => {
  const fold = {
    machines: {
      t480: machine({
        at: T(10, 45),
        volumes: {
          "F:\\": { collector: "everything", status: "ok", rows: 10, at: T(10, 45) },
          "D:\\": { collector: "walker", status: "ok", rows: 4, at: T(8) }
        }
      })
    }
  };
  const [card] = machineCards(fold, { now: NOW });
  const d = card.volumes.find((v) => v.volume === "D:\\");
  assert.equal(d.at, T(8));
  assert.equal(ageLabel(d.ageMs), "3 hours", "it does not inherit the sweep's freshness");
});

test("a hub that cannot be reached is not an empty estate", () => {
  for (const bad of [null, undefined, {}, { machines: undefined }, "nope"]) {
    const v = estateView(bad, { now: NOW, reason: "connection refused" });
    assert.equal(v.reachable, false, JSON.stringify(bad));
    assert.equal(v.machines.length, 0);
    assert.match(v.reason, /refused|did not answer/u);
  }
  const good = estateView({ at: NOW, machines: { t480: machine() } }, { now: NOW });
  assert.equal(good.reachable, true);
  assert.equal(good.reason, null);
});

// --- Scenario: version drift is visible --------------------------------------------------------------

test("two machines on different Prime-Silo versions are flagged as drifted", () => {
  const fold = {
    machines: {
      t480: machine({ apps: [{ name: "Prime-Silo 1.24.5", version: "1.24.5", source: "registry" }] }),
      optimus: machine({ apps: [{ name: "Prime-Silo", version: "1.24.4", source: "winget" }] })
    }
  };
  const matrix = applicationMatrix(fold);
  const drift = versionDrift(matrix);
  assert.equal(drift.length, 1, "one product has drifted");
  const [row] = drift;
  assert.equal(normalizeProduct(row.product), "prime-silo");
  assert.deepEqual(row.byMachine.t480, ["1.24.5"]);
  assert.deepEqual(row.byMachine.optimus, ["1.24.4"]);
  assert.deepEqual(row.versions, ["1.24.4", "1.24.5"]);
  assert.deepEqual(row.sources, ["registry", "winget"]);
  assert.equal(matrix.rows[0].drifted, true, "and drifted rows sort to the top");
});

test("the same version on both machines is not drift", () => {
  const fold = {
    machines: {
      t480: machine({ apps: [{ name: "Tailscale", version: "1.102.3", source: "registry" }] }),
      optimus: machine({ apps: [{ name: "Tailscale", version: "1.102.3", source: "winget" }] })
    }
  };
  assert.equal(versionDrift(applicationMatrix(fold)).length, 0);
});

test("a machine that pushed no applications reads not-pushed, never an empty row", () => {
  // S3 pushes counts only; until S14 lands this is EVERY machine, and an empty cell would read as
  // "this machine does not have it", which is a claim the map cannot make.
  const fold = {
    machines: {
      t480: machine({ apps: [{ name: "Prime-Silo", version: "1.24.5", source: "registry" }] }),
      optimus: machine() // counts only, no apps array
    }
  };
  const matrix = applicationMatrix(fold);
  assert.deepEqual(matrix.pushed, ["t480"]);
  assert.deepEqual(matrix.notPushed, ["optimus"]);
  const [row] = matrix.rows;
  assert.deepEqual(Object.keys(row.byMachine), ["t480"]);
  assert.deepEqual(row.missingFrom, [], "optimus is not counted as missing it — it never said");
  assert.equal(row.drifted, false, "and one machine alone cannot drift");
});

test("a machine that pushed apps but not this one IS missing it", () => {
  const fold = {
    machines: {
      t480: machine({ apps: [{ name: "Docker Desktop", version: "4.78.0", source: "registry" }] }),
      optimus: machine({ apps: [{ name: "Tailscale", version: "1.102.3", source: "registry" }] })
    }
  };
  const docker = applicationMatrix(fold).rows.find((r) => r.product.startsWith("Docker"));
  assert.deepEqual(docker.missingFrom, ["optimus"], "both pushed, so absence is a real absence");
});

test("one product spelled two ways is one row", () => {
  // and a name that merely ENDS in a number keeps it: S2 killed a mutation that stripped any
  // version-shaped tail, because "7-Zip 24.09" at version 24.08 is not "7-Zip".
  assert.equal(normalizeProduct("7-Zip 24.09", "24.08"), "7-zip 24.09");
  assert.equal(normalizeProduct("Prime-Silo 1.24.5", "1.24.5"), "prime-silo");
  const fold = {
    machines: {
      t480: machine({
        apps: [
          { name: "Prime-Silo 1.24.5 (x64)", version: "1.24.5", source: "registry" },
          { name: "Prime-Silo", version: "1.24.5", source: "winget" }
        ]
      })
    }
  };
  const rows = applicationMatrix(fold).rows;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].product, "Prime-Silo", "the shortest spelling wins");
  assert.deepEqual(rows[0].sources, ["registry", "winget"]);
  assert.equal(rows[0].drifted, false, "two sources on one machine is not drift");
});

// --- Scenario: the treemap accounts for every byte it shows -------------------------------------------

test("treemap areas are proportional and tile the box exactly", () => {
  const items = [
    { key: "media", value: 500 * 1024 ** 3 },
    { key: "models", value: 212 * 1024 ** 3 },
    { key: "code", value: 100 * 1024 ** 3 }
  ];
  const total = items.reduce((s, i) => s + i.value, 0);
  assert.equal(total, 812 * 1024 ** 3, "812 GB in total");

  const box = { x: 0, y: 0, w: 800, h: 400 };
  const rects = treemap(items, box);
  assert.equal(rects.length, 3);

  const area = rects.reduce((s, r) => s + r.w * r.h, 0);
  assert.ok(Math.abs(area - box.w * box.h) < 1e-6, `areas sum to the box: ${area}`);
  for (const r of rects) {
    const share = (r.w * r.h) / (box.w * box.h);
    const expected = items.find((i) => i.key === r.key).value / total;
    assert.ok(Math.abs(share - expected) < 1e-9, `${r.key} is proportional: ${share} vs ${expected}`);
    assert.ok(r.w > 0 && r.h > 0, `${r.key} is visible`);
    assert.ok(r.x >= box.x - 1e-9 && r.y >= box.y - 1e-9, `${r.key} is inside the box`);
    assert.ok(r.x + r.w <= box.x + box.w + 1e-6 && r.y + r.h <= box.y + box.h + 1e-6);
  }
});

test("a rectangle nobody can see is not drawn at all", () => {
  const rects = treemap(
    [{ key: "a", value: 100 }, { key: "zero", value: 0 }, { key: "negative", value: -5 }],
    { x: 0, y: 0, w: 10, h: 10 }
  );
  assert.deepEqual(rects.map((r) => r.key), ["a"]);
  assert.equal(rects[0].w * rects[0].h, 100, "and the survivor still fills the box");
});

test("an empty or impossible box draws nothing rather than NaN", () => {
  assert.deepEqual(treemap([], { x: 0, y: 0, w: 10, h: 10 }), []);
  assert.deepEqual(treemap([{ key: "a", value: 1 }], { x: 0, y: 0, w: 0, h: 10 }), []);
  for (const r of treemap([{ key: "a", value: 1 }], { x: 0, y: 0, w: 4, h: 4 }))
    assert.ok(Number.isFinite(r.w) && Number.isFinite(r.h));
});

// THESE TWO TESTS USED TO PIN THE DEFECT. The first version of this file asserted that a volume's
// size was the machine's bytes times its share of the files — which is how the panel came to draw a
// 900 GB block labelled C: on a fold whose C: was the small, busy drive. The test passing was the
// reason nobody looked. What is asserted now is the opposite: that no volume is given a byte figure
// at all, because none crosses the wire.

test("no volume is ever labelled with bytes the node did not send", () => {
  // the drive that holds MORE FILES holds FEWER BYTES — the arrangement the old estimate inverted
  const fold = {
    machines: {
      t480: machine({
        counts: { files: 300, bytes: 3000, listed_files: 300, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {
          "C:\\": { collector: "everything", status: "ok", rows: 200, at: T(10) },
          "F:\\": { collector: "everything", status: "ok", rows: 100, at: T(10) }
        }
      })
    }
  };
  const view = storageView(fold, { now: NOW });
  assert.equal(view.machines.length, 1);
  const [m] = view.machines;
  assert.equal(m.value, 3000, "the machine carries the bytes it reported, which are real");
  assert.deepEqual(
    m.volumes.map((v) => [v.volume, v.files]),
    [["C:\\", 200], ["F:\\", 100]],
    "volumes carry file counts, which are also real"
  );
  for (const v of m.volumes)
    assert.ok(!("value" in v) || v.value === undefined, `${v.volume} must not carry a byte size`);
  assert.equal(view.bytes.reported, 3000);
});

test("bytes on a node with no volume to draw are named, never dropped", () => {
  const fold = {
    machines: {
      t480: machine({
        counts: { files: 10, bytes: 4000, listed_files: 10, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "C:\\": { collector: "everything", status: "ok", rows: 10, at: T(10) } }
      }),
      // reported two thousand bytes and folded no volume at all: the case that lost 2 TB silently
      optimus: machine({
        counts: { files: 7, bytes: 2000, listed_files: 7, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {}
      })
    }
  };
  const view = storageView(fold, { now: NOW });
  assert.equal(view.bytes.reported, 6000, "the fold's own figure, and the only one storageView owns");
  // AND THE REST IS COUNTED OFF THE RECTANGLES. reconcile() is given a box big enough to draw both,
  // so the node with no volumes is drawn as a bare block and counted as unsplit rather than lost.
  const r = reconcile(view, storageRects(view, { x: 0, y: 0, w: 800, h: 400 }));
  assert.equal(r.drawn, 6000, "every block the layout drew");
  assert.equal(r.unsplit, 2000, "and the one with nothing inside it is named as such");
  assert.equal(r.missing, 0);
  assert.equal(r.tooSmall, 0);
  const named = view.unaccounted.filter((u) => u.machine === "optimus");
  assert.equal(named.length, 1, "the node is named rather than absent");
  assert.match(named[0].why, /no volume/u);
});

test("a volume the node listed no files on is named, not silently absent", () => {
  const fold = {
    machines: {
      pi: machine({
        counts: { files: 5, bytes: 0, listed_files: 5, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {
          "/": { collector: "walker", status: "ok", rows: 5, at: T(10) },
          "/mnt/nas": { collector: "walker", status: "errored", rows: 0, error_code: "WALK_INCOMPLETE", at: T(10) }
        }
      })
    }
  };
  const view = storageView(fold, { now: NOW });
  const nas = view.unaccounted.find((u) => u.volume === "/mnt/nas");
  assert.ok(nas, "the volume appears beside the map instead of vanishing from it");
  assert.equal(nas.errorCode, "WALK_INCOMPLETE", "and it keeps WHY the sweep saw nothing");
});

test("the bytes a node withheld are a floor under a volume, never its size", () => {
  const fold = {
    machines: {
      t480: machine({
        counts: { files: 100, bytes: 9000, listed_files: 40, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "F:\\": { collector: "everything", status: "ok", rows: 100, at: T(10) } },
        totals: [
          { kind: "files", collector: "everything", volume: "F:\\", category: "documents", items: 50, bytes: 500 },
          { kind: "files", collector: "everything", volume: "F:\\", category: "media", items: 10, bytes: 2500 }
        ]
      })
    }
  };
  const [m] = storageView(fold, { now: NOW }).machines;
  const [f] = m.volumes;
  assert.equal(f.withheldBytes, 3000, "the withheld part is known exactly");
  assert.ok(f.withheldBytes < m.value, "and it is less than the machine's total, which is the point");
  assert.deepEqual(f.categories.map((c) => c.category), ["media", "documents"], "biggest first");
});

test("a rectangle too small to see is listed rather than counted invisibly", () => {
  const view = {
    machines: [
      { key: "t480", machine: "t480", value: 1000, volumes: [
        { key: "t480:C:", machine: "t480", volume: "C:\\", files: 1_000_000 },
        { key: "t480:F:", machine: "t480", volume: "F:\\", files: 1 }
      ] }
    ]
  };
  const rects = storageRects(view, { x: 0, y: 0, w: 200, h: 120 });
  const tiny = rects.find((r) => r.volume === "F:\\");
  assert.ok(tiny, "it is still in the output");
  assert.equal(tiny.tooSmall, true, "and marked as something the map cannot show");
  assert.ok(rects.some((r) => r.level === "machine" && r.machine === "t480"));
});

test("a hub that answered and holds nothing says so, and is not a blank page", () => {
  const v = estateView({ at: NOW, machines: {} }, { now: NOW });
  assert.equal(v.reachable, true, "the hub answered");
  assert.equal(v.empty, true, "and it holds nothing, which is its own state");
  assert.match(v.emptyReason, /quarantine/u, "and the panel names the fail-closed reason");
  assert.deepEqual(v.machines, []);
});

test("an estate where every node is quiet does not read as an estate that is reporting", () => {
  const fold = {
    at: NOW,
    machines: {
      t480: machine({ stale: true, since: T(10), ageMs: 3_600_000 }),
      optimus: machine({ stale: true, since: T(10), ageMs: 3_600_000 })
    }
  };
  assert.equal(estateView(fold, { now: NOW }).allStale, true);
  assert.equal(estateView({ at: NOW, machines: { t480: machine({}) } }, { now: NOW }).allStale, false);
});

test("a node that has not swept media reads not-swept, never zero media", () => {
  const fold = {
    machines: {
      t480: machine({
        counts: { files: 1, bytes: 1, listed_files: 1, apps: 0, listed_apps: 0, media: 40, listed_media: 25 },
        totals: [{ kind: "media", collector: "media", volume: "F:\\", category: "video", items: 15, bytes: 900 }]
      }),
      pi: machine({})
    }
  };
  const media = mediaView(fold);
  assert.deepEqual(media.swept, ["t480"]);
  assert.deepEqual(media.notSwept, ["pi"], "a node that never looked is not a node with no media");
  const t480 = media.machines.find((m) => m.machine === "t480");
  assert.equal(t480.found, 40);
  assert.equal(t480.listed, 25);
  assert.equal(t480.withheld, 15);
  assert.equal(t480.withheldBytes, 900);
  assert.deepEqual(t480.categories.map((c) => c.category), ["video"]);
});

// --- labels and the view itself -----------------------------------------------------------------------

test("ages and sizes read as quantities, not as precision the map does not have", () => {
  assert.equal(ageLabel(30_000), "moments");
  assert.equal(ageLabel(60_000), "1 minute");
  assert.equal(ageLabel(45 * 60_000), "45 minutes");
  assert.equal(ageLabel(2 * 3_600_000), "2 hours");
  assert.equal(ageLabel(3 * 86_400_000), "3 days");
  assert.equal(ageLabel(-1), "unknown");
  assert.equal(ageLabel(NaN), "unknown");
  assert.equal(byteLabel(0), "0 B");
  assert.equal(byteLabel(1536), "1.5 KB");
  assert.equal(byteLabel(1_550_868_580_736), "1.4 TB");
  assert.equal(byteLabel(-1), "—");
});

test("the whole view is one call, and it carries what the panel draws", () => {
  const fold = {
    at: NOW,
    machines: {
      t480: machine({ apps: [{ name: "Prime-Silo", version: "1.24.5", source: "registry" }] }),
      optimus: machine({ stale: true, since: T(10), ageMs: 3_600_000, apps: [{ name: "Prime-Silo", version: "1.24.4", source: "registry" }] })
    }
  };
  const v = estateView(fold, { now: NOW });
  assert.equal(v.reachable, true);
  assert.equal(v.machines.length, 2);
  assert.equal(v.drift.length, 1, "the drift the panel exists to show");
  assert.ok(v.storage.machines.length > 0);
  assert.equal(v.empty, false);
  assert.deepEqual(v.applications.notPushed, []);
});

// --- the panel is registered and can load ---------------------------------------------------------------

test("the panel registers itself and links what it needs", () => {
  const yaml = fs.readFileSync(path.join(PANEL, "ext/panels/estate_map.yaml"), "utf8");
  assert.match(yaml, /^path:\s*_prime_silo\/estate_map$/mu, "registered at the contracted path");
  assert.match(yaml, /^name:\s*\S/mu);
  assert.match(yaml, /^description:\s*\S/mu);

  const view = fs.readFileSync(path.join(PANEL, "view.html"), "utf8");
  // a view that cannot load its own stylesheet is a blank page, and a blank page and an empty
  // estate look identical — which is the one thing this panel must never do
  for (const href of [
    "/mod/_core/framework/css/layout.css",
    "/mod/_core/framework/css/type.css",
    "/mod/_prime_silo/estate_map/estate_map.css"
  ])
    assert.ok(view.includes(href), `view.html links ${href}`);
  assert.ok(view.includes("/mod/_prime_silo/estate_map/estate_map.js"), "and its script");
  for (const f of ["estate_map.js", "estate_map.css", "fold_view.js"])
    assert.ok(fs.existsSync(path.join(PANEL, f)), `${f} exists`);
});

test("the panel reads the map from the estate map API, and talks to nothing but it and Sweep", () => {
  // §5: the panel renders the fold and nothing else. A fetch to any other endpoint would make this
  // surface depend on something the contract did not give it. S17 gave it exactly one more: Sweep.
  // S20 gave it comparisons, and S21 the library and the two Stops — which go through ask(url), so a
  // URL handed to ask is read here as a fetch.
  const js = fs.readFileSync(path.join(PANEL, "estate_map.js"), "utf8");
  const fetched = [...js.matchAll(/(?:fetch|ask)\(\s*[`"']([^`"']+)/gu)].map((m) => m[1]);
  assert.ok(fetched.includes("/api/estate/map"), "it reads the map");
  assert.ok(fetched.includes("/api/estate/library/stop"), "ask's URLs are read too");
  for (const url of fetched)
    assert.match(
      url,
      /^\/api\/estate\/(map|sweep|compare|compare\/stop|library|library\/stop)$/u,
      `${url} is not the map, Sweep, a comparison or the library`
    );
});

test("no colour is written into the panel's stylesheet by hand", () => {
  // Governed CSS (C0): every colour resolves through a token in colors.css.
  const css = fs.readFileSync(path.join(PANEL, "estate_map.css"), "utf8");
  const hex = css.match(/#[0-9a-f]{3,8}\b/giu) ?? [];
  assert.deepEqual(hex, [], "hex colours belong in colors.css, not here");
  for (const fn of ["rgb(", "rgba(", "hsl("])
    assert.ok(!css.includes(fn), `${fn} is a colour written by hand`);
});

// --- the markup, actually rendered ----------------------------------------------------------------
//
// WHY THIS EXISTS, AND WHY IT IS THE LONGEST PART OF THIS FILE. Everything above is a pure function,
// and pure functions are exactly the part of this panel that was never wrong. claude-s4-verifier
// deleted five guards from view.html — the stale machines, the not-pushed notice, the withheld line,
// the WALK_INCOMPLETE code and the whole "Cannot tell" block — and every one of them left the gate
// GREEN at 19/19, because not one test had ever executed the markup. It proved the first on screen:
// one word changed, and a stale node simply vanished under a header still reading "2 nodes
// reporting". A judgement that never reaches the screen is not a judgement.
//
// So these tests load the REAL view.html, the REAL estate_map.js and the REAL vendored Alpine into a
// DOM and read what comes out. No copy of the markup lives here: a test that restates the view is a
// test of itself.
//
// WHAT THIS CANNOT SEE, said plainly rather than left for a verifier to find: jsdom has no layout
// engine. Every getBoundingClientRect is zero, so the harness supplies ONE fixed box (below) to let
// the treemap lay out at all. Sizes, overlap, colour, contrast and anything else a pixel decides are
// outside this file and belong to the screenshot the contract's Handoff still demands.
import { JSDOM } from "jsdom";
import { generate, parse, walk } from "css-tree";
import { register } from "node:module";
import { pathToFileURL } from "node:url";

// estate_map.js imports "/mod/_prime_silo/estate_map/fold_view.js" — the path the SHELL serves it
// at. Rewriting that import to load the file would be testing a copy of the panel, so the panel is
// loaded unmodified and the resolver is taught the shell's one mapping instead.
const MOD = pathToFileURL(path.join(PANEL, "..", "..")).href.replace(/\/?$/u, "/");
register(
  `data:text/javascript,export function resolve(s, c, next) { return s.startsWith("/mod/") ? next(${JSON.stringify(
    MOD
  )} + s.slice(5), c) : next(s, c); }`
);

// The box the harness reports. A browser gives this panel something much wider — the real map box
// measured about 932x416, 2.24:1 — and the area test used to run at ONE shape, so a distortion
// conditioned on the aspect ratio shipped green: at 2.24:1 one block filled the map labelled with a
// file count formatted as bytes while the two largest nodes vanished. Layouts are checked at several
// shapes now, this one included.
const BOX = { width: 640, height: 400 };
// Measured, not guessed: at a 1920-wide window the panel's map box is 1856px, and at 1200 it is
// 1136. The old list topped out at 1400 and the seeded generator at 1660, so the box an ordinary
// 1080p screen actually produces was outside EVERY layout any test performed — and a distortion
// keyed on `box.w > 1700` drew "t480 1.1 MB" for a node holding 1.4 TB with the gate green. Seeding
// had replaced "aim between five points" with "aim outside one box".
const REAL_BOXES = [
  { w: 1856, h: 416 },
  { w: 1136, h: 416 },
  { w: 932, h: 416 },
  { w: 640, h: 400 },
  { w: 1400, h: 300 },
  { w: 300, h: 900 },
  { w: 120, h: 90 },
  { w: 3776, h: 900 }
];

// FIVE FIXED SHAPES IS A LIST, AND A LIST IS SOMETHING TO AIM BETWEEN. A distortion keyed on a 3:1
// box shipped green against them, and at 1263x416 — an ordinary window — the tab drew "t480 1.1 MB"
// for a node holding 1.4 TB. So the layout is also checked at shapes and estate sizes drawn from a
// seeded generator: reproducible when it fails, and not a set anyone can tune around.
function seeded(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

// What GET /api/estate/sweep answers in a render, unless a test says otherwise (S17).
const SWEEP_READY = { machine: "T480", roots: ["C:", "F:"], policy: true, running: null, last: null };
// What GET /api/estate/compare answers in a render, unless a test says otherwise (S20).
const COMPARE_READY = { roots: ["C:", "F:", "G:"], to: "F:", policy: true, running: null, results: { "C:": null, "G:": null } };
// What GET /api/estate/library answers in a render, unless a test says otherwise (S21).
const LIBRARY_READY = { roots: ["C:", "F:", "G:"], policy: true, running: null, last: null, catalogues: { "C:": null, "F:": null, "G:": null } };

async function renderPanel(
  fold,
  { status = 200, malformed = false, fetchTwice = false, sweep = SWEEP_READY, compare = COMPARE_READY, library = LIBRARY_READY, posted = [] } = {}
) {
  // THE PANEL'S OWN STYLESHEET GOES IN. jsdom fetches nothing, so a <link> is inert and the
  // document would have no rules at all — which is how seven one-line CSS mutations hid guards under
  // a green gate. The file is inlined rather than linked, and the shell's x-cloak rule with it,
  // because that rule is what hides the panel until Alpine has run: if Alpine fails, everything is
  // hidden and every test fails loudly instead of quietly passing on a blank page.
  const shell =
    `<style>${fs.readFileSync(path.join(PANEL, "estate_map.css"), "utf8")}</style>` +
    "<style>[x-cloak]{display:none !important}</style>";
  const dom = new JSDOM(fs.readFileSync(path.join(PANEL, "view.html"), "utf8").replace("</head>", `${shell}</head>`), {
    url: "http://localhost/",
    runScripts: "dangerously",
    pretendToBeVisual: true
  });
  const { window } = dom;
  // jsdom has no layout: without a box the treemap lays out into nothing and the storage tab would
  // look empty for a reason that has nothing to do with the panel.
  window.Element.prototype.getBoundingClientRect = function boundingRect() {
    return { ...BOX, x: 0, y: 0, top: 0, left: 0, right: BOX.width, bottom: BOX.height };
  };

  const saved = { window: globalThis.window, fetch: globalThis.fetch, setInterval: globalThis.setInterval };
  globalThis.window = window;
  // Routed by URL since S17: the map answers as the test says, the sweep status as `sweep` says, and
  // a POST is recorded in `posted`. Only MAP fetches are counted, because the count is how this
  // harness proves Alpine started once — a second endpoint must not be able to hide a second start.
  let fetches = 0;
  const intervals = [];
  globalThis.fetch = async (url, init = {}) => {
    if (String(url).startsWith("/api/estate/sweep")) {
      if (init.method === "POST") posted.push(JSON.parse(init.body));
      return { ok: true, status: init.method === "POST" ? 202 : 200, json: async () => sweep };
    }
    if (String(url).startsWith("/api/estate/compare")) {
      if (init.method === "POST") posted.push(JSON.parse(init.body));
      return { ok: true, status: init.method === "POST" ? 202 : 200, json: async () => compare };
    }
    if (String(url).startsWith("/api/estate/library")) {
      if (init.method === "POST") posted.push(JSON.parse(init.body));
      return { ok: true, status: init.method === "POST" ? 202 : 200, json: async () => library };
    }
    return {
      ok: (fetches++, status >= 200 && status < 300),
      status,
      json: async () => {
        if (malformed) throw new SyntaxError("Unexpected token < in JSON");
        return fold;
      }
    };
  };
  // the panel's own slow refresh is not what most of these tests measure, and a live interval would
  // hold the test runner open — so it is captured, not run, and a test can fire it by hand
  globalThis.setInterval = (fn) => (intervals.push(fn), 0);
  try {
    // the real component, loaded once per process and re-registered on each window
    const mod = await import(pathToFileURL(path.join(PANEL, "estate_map.js")).href + `?r=${renders++}`);
    void mod;
    window.eval(fs.readFileSync(path.join(FRAMEWORK, "alpine.min.js"), "utf8"));
    // Alpine starts on DOMContentLoaded, which jsdom has already fired by now
    // THE BUNDLE AUTO-STARTS, ASYNCHRONOUSLY. Checking for the component's data stack immediately
    // after evaluating it is too early — it is always absent, so the old guard called start() again
    // on EVERY render: two init()s and two fetches per test, and a warning per render that nobody
    // read. Wait for the auto-start to walk the tree, and only start it by hand if it never does.
    try {
      await until(() => window.document.querySelector(".em")?._x_dataStack, { timeout: 1000, step: 5 });
    } catch {
      window.Alpine.start();
    }
    // Wait for the panel to have ANSWERED rather than for an arbitrary number of milliseconds:
    // init() awaits a fetch, and a test that gave up early would be asserting against "Reading the
    // estate map…" and reporting a missing notice that is merely a notice that has not arrived.
    // Wait for the panel to have ANSWERED rather than for a number of milliseconds: init() awaits
    // a fetch, and a test that gave up early would assert against "Reading the estate map…" and
    // report a missing notice that had simply not arrived. The states are x-if, so the loading line
    // is REMOVED rather than hidden when it is over.
    // POSITIVE EVIDENCE, not the absence of something. `!document.querySelector(".em__loading")` is
    // satisfied instantly when Alpine never starts at all, because the loading line is itself inside
    // an x-if — the harness would then resolve on an empty page and every test would assert against
    // it. What is waited for is the component existing, having answered, and having rendered the
    // state that answer implies.
    await until(() => {
      const el = window.document.querySelector(".em");
      if (!el?._x_dataStack) return false;
      const data = window.Alpine.$data(el);
      if (data.loading) return false;
      return Boolean(
        window.document.querySelector(".em__body") ||
          window.document.querySelector(".em__blind") ||
          window.document.querySelector(".em__nothing")
      );
    });
    await flush(window);
    // fetchTwice is how the test above proves this assertion can fail; nothing else sets it
    if (fetchTwice) await globalThis.fetch("/api/estate/map");
    if (fetches !== 1)
      throw new Error(`the panel fetched ${fetches} times for one render — Alpine started twice`);
  } finally {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
    globalThis.setInterval = saved.setInterval;
  }
  return { window, document: window.document, dom, intervals };
}

let renders = 0;

// Poll for a condition the DOM is supposed to reach, and FAIL if it never does. A fixed sleep
// either wastes time or lies about what it saw.
async function until(fn, { timeout = 2000, step = 5 } = {}) {
  const deadline = Date.now() + timeout;
  for (;;) {
    if (fn()) return;
    if (Date.now() > deadline) throw new Error("the panel never reached the state the test waited for");
    await new Promise((r) => setTimeout(r, step));
  }
}

// Click a tab by its name and wait for that tab's own section to be the visible one, so a test can
// never assert against the tab it was leaving.
// Wait for Alpine to flush its queued effects. Not a sleep: if the scheduler is wedged this never
// resolves and until()'s deadline reports it.
const flush = (window) =>
  new Promise((resolve) => window.Alpine.nextTick(() => window.Alpine.nextTick(resolve)));

async function openTab(window, name) {
  const tabs = [...window.document.querySelectorAll(".em__tab")];
  const tab = tabs.find((t) => t.textContent.trim() === name);
  if (!tab) throw new Error(`no ${name} tab: the panel offers ${tabs.map((t) => t.textContent.trim()).join(", ")}`);
  tab.click();
  // the panes are x-if, so the new one has to EXIST before anything is asserted about it
  const pane = {
    estate: ".em__cards",
    storage: ".em__storage",
    applications: ".em__apps",
    media: ".em__media:not(.em__backups)",
    library: ".em__library",
    backups: ".em__backups"
  }[name];
  await until(() => tab.dataset.on === "true" && window.document.querySelector(pane));
  // and let Alpine flush what the pane's own layout queued, using its scheduler rather than a sleep:
  // the rectangles appear one tick before the line that describes them
  await flush(window);
}

// What a person would actually read: x-show hides by setting display:none, and an element that is
// present but hidden has not reached the owner's eyes.
// WHAT A PERSON WOULD ACTUALLY READ. The first version of this walker looked only at inline
// style.display, and the document it walked had no stylesheet in it at all — jsdom fetches nothing
// by default, so `document.styleSheets.length` was 0. claude-s4-verifier-2 then hid seven different
// guards with one CSS line each, including `.em__card[data-stale="true"] { display: none }` — the
// stale node gone under a header still reading "3 nodes reporting", which is the exact defect that
// failed the first submission — and the gate stayed green at 33/33.
//
// So the panel's REAL stylesheet is now in the document (see renderPanel), and visibility is judged
// by computed style: display, visibility, opacity, the hidden attribute, a collapsed font, and being
// parked off-screen. jsdom has no layout engine, so it cannot tell you a box is covered by another
// or scrolled out of view — but it does cascade author CSS for these properties, which is what the
// question "did this guard reach the owner's eyes" actually turns on.
// --- the choke point ------------------------------------------------------------------------------
//
// FOUR ROUNDS WERE SPENT ENUMERATING WAYS TO HIDE A GUARD and each round a verifier found more.
// Round five inverted the question — ask the panel's own stylesheet what it says, rather than ask a
// rendered element how it looks — which was the right move implemented the wrong way: a hand-rolled
// `split("}")` and exact-string property matching. That is still an enumeration, of SPELLINGS instead
// of tricks, and thirteen more one-liners walked past it. Native CSS nesting was the flagship —
// `.em__card{&[data-stale="true"]{display:none}}` has no at-rule and the splitter never sees a
// property called `display` — with `display:var(--nope,none)`, a `di; play` escape, the standalone
// `scale`/`translate` properties, `margin-left:-9999px` and `inset` past the viewport behind it.
//
// SO THE SHEET IS PARSED, NOT SCANNED, and judged against an INVENTORY rather than a denylist. css-tree
// walks every rule including nested ones, unescapes nothing but hands back the declaration as written,
// and the question asked of each declaration is not "is this dangerous?" — which requires me to know
// every dangerous spelling — but "is this one of the things this panel has been approved to say?"
// A novel spelling is by construction not in the inventory. An at-rule is refused outright, because a
// rule that applies only sometimes can hide a guard sometimes. `!important` likewise: the panel has
// none, and it exists to beat something else.
//
// The cost is that a legitimate CSS change fails until it is added below, deliberately, in a diff a
// reviewer sees. For a stylesheet whose job is to not hide things, that is the right cost.
const APPROVED_DECLARATIONS = new Set([
  "align-items: baseline",
  "align-items: center",
  "background: var(--color-accent-primary-soft)",
  "background: var(--color-canvas-deep)",
  "background: var(--color-surface-1)",
  "background: var(--color-surface-2)",
  "border-bottom: 1px solid var(--color-border-soft)",
  "border-collapse: collapse",
  "border-color: var(--color-accent-primary)",
  "border-color: var(--color-border-strong)",
  "border-radius: var(--radius-1)",
  "border-radius: var(--radius-2)",
  "border-radius: var(--radius-3)",
  "border-style: dashed",
  "border-top-color: var(--color-status-danger)",
  "border-top: 1px solid var(--color-border-soft)",
  "border: 1px solid var(--color-border-soft)",
  "border: 1px solid var(--color-border-strong)",
  "border: 1px solid var(--color-canvas)",
  "border: 1px solid var(--color-status-danger)",
  "color: var(--color-status-danger)",
  "color: var(--color-status-success)",
  "color: var(--color-status-warning)",
  "color: var(--color-text-primary)",
  "color: var(--color-text-secondary)",
  "color: var(--color-text-tertiary)",
  "cursor: pointer",
  "display: flex",
  "display: grid",
  "flex-direction: column",
  "flex-direction: row",
  "flex-wrap: wrap",
  "font-family: inherit",
  "font-family: var(--font-stack-active)",
  "font-size: var(--font-size-1)",
  "font-size: var(--font-size-2)",
  "font-size: var(--font-size-3)",
  "font-size: var(--font-size-4)",
  "font-size: var(--font-size-6)",
  "font-weight: 400",
  "gap: var(--space-1)",
  "gap: var(--space-2)",
  "gap: var(--space-3)",
  "gap: var(--space-4)",
  "gap: var(--space-5)",
  "grid-template-columns: repeat(auto-fill, minmax(18rem, 1fr))",
  "height: 26rem",
  "justify-content: space-between",
  "letter-spacing: 0.04em",
  "letter-spacing: 0.06em",
  "letter-spacing: 0.08em",
  "list-style: none",
  "margin: 0",
  "opacity: 0.72",
  "overflow-x: auto",
  "overflow: hidden",
  "padding-top: var(--space-2)",
  "padding: 0",
  "padding: var(--space-1) var(--space-2)",
  "padding: var(--space-2)",
  "padding: var(--space-2) var(--space-3)",
  "padding: var(--space-2) var(--space-4)",
  "padding: var(--space-4)",
  "padding: var(--space-6)",
  "position: absolute",
  "position: relative",
  "text-align: left",
  "text-transform: capitalize",
  "text-transform: uppercase",
  "white-space: nowrap",
  "width: 100%"
]);

function stylesheetProblems(css) {
  const problems = [];
  let ast;
  try {
    ast = parse(css, { parseValue: false, parseAtrulePrelude: false, onParseError: (e) => problems.push(`the panel stylesheet does not parse: ${e.message}`) });
  } catch (e) {
    return [`the panel stylesheet does not parse: ${e.message}`];
  }
  // WHERE a declaration is made, for the two properties where that is the whole question. The
  // inventory asks whether the panel may SAY a thing, never whether it may say it HERE — so
  // `.em__cards { height: 26rem; overflow: hidden }`, both strings verbatim in the inventory, clipped
  // ten of fourteen machine cards out of a container nobody can scroll, under a header still reading
  // "14 nodes reporting". Keying the whole inventory on selectors would make every CSS edit a
  // two-place change; keying only the properties that CLIP is small and bounded, and clipping is the
  // only way an approved declaration removes content from reach.
  //
  // `.em__map` is the one element allowed to clip, because it is a fixed-size canvas whose overflow
  // is the treemap's own business. `.em__rect` may clip its label inside its own block. Nothing else
  // may, at all.
  //
  // AND CLIPPING IS NOT THE ONLY WAY AN APPROVED DECLARATION PUTS CONTENT OUT OF REACH — this comment
  // claimed it was, one round after the same mistake was made about at-rules. `.em__card { position:
  // absolute }` is a single approved declaration with no clipping property, and it stacks every card
  // at one point with only the last readable, measured on a fourteen-node fold under a header still
  // reading "14 nodes reporting". So `position` is held to the same rule. What is still uncovered is
  // written out under WHAT THIS FILE DOES NOT COVER at the end of this file.
  const MAY_CLIP = new Set([".em__map", ".em__rect"]);
  const CLIPPING = new Set([
    "height",
    "max-height",
    "min-height",
    "overflow",
    "overflow-y",
    "overflow-x",
    // not a clip, but the same outcome: one approved declaration that puts thirteen cards under the
    // fourteenth
    "position"
  ]);
  let selector = "";
  walk(ast, {
    enter(node) {
      if (node.type === "Rule") selector = generate(node.prelude).trim().toLowerCase();
      if (node.type === "Atrule")
        problems.push(`@${node.name}: a rule that applies only sometimes can hide a guard sometimes`);
      if (node.type !== "Declaration") return;
      const prop = node.property.toLowerCase();
      const decl = `${prop}: ${generate(node.value).trim().toLowerCase()}`;
      if (node.important) {
        problems.push(`${decl} !important — the panel has no need to beat anything`);
        return;
      }
      if (!APPROVED_DECLARATIONS.has(decl)) {
        problems.push(`the panel stylesheet says "${decl}", which is not in its approved inventory`);
        return;
      }
      if (CLIPPING.has(prop) && !MAY_CLIP.has(selector) && !/^overflow(-x)?: (auto|visible)$/u.test(decl))
        problems.push(
          `"${decl}" on ${selector}: only ${[...MAY_CLIP].join(" and ")} may clip, and everything else ` +
            "clipped this way puts content out of the owner's reach with no way to scroll to it"
        );
    }
  });
  return problems;
}

function hiddenBy(el, win) {
  if (el.hasAttribute("hidden")) return "the hidden attribute";
  const cs = win.getComputedStyle(el);
  if (cs.display === "none") return "display:none";
  if (cs.visibility === "hidden" || cs.visibility === "collapse") return `visibility:${cs.visibility}`;
  if (cs.opacity !== "" && Number(cs.opacity) === 0) return "opacity:0";
  if (/^0(px)?$/u.test(cs.fontSize ?? "")) return "font-size:0";
  // Parked out of sight. The first version of this looked only for large NEGATIVE left/top, so an
  // element pushed DOWNWARD past the viewport — `position: fixed; top: 200vh` — counted as visible,
  // and the empty-hub notice went back to being a blank page with the gate green.
  //
  // MEASURED AGAINST THE VIEWPORT, not against a number I picked. `top: 200vh` computes to a plain
  // "1536px" in jsdom, so a rule of thumb like "over 5000px is off-screen" let the empty-hub notice
  // be parked below the fold with the gate green. Anything at or past the viewport edge is out of
  // sight whatever unit it was written in.
  const edge = { left: win.innerWidth, right: win.innerWidth, top: win.innerHeight, bottom: win.innerHeight };
  for (const side of ["left", "top", "right", "bottom"]) {
    const raw = cs[side] ?? "";
    const v = Number.parseFloat(raw);
    if (!Number.isFinite(v)) continue;
    if (v <= -1000) return `${side}:${raw}`;
    if (v >= (edge[side] || 768)) return `${side}:${raw} (past the viewport)`;
  }
  if (/^0(px)?$/u.test(cs.width ?? "") && /^0(px)?$/u.test(cs.height ?? "")) return "a 0x0 box";
  // collapsed by a clipped box rather than by display
  if (/^0(px)?$/u.test(cs.maxHeight ?? "") || /^0(px)?$/u.test(cs.maxWidth ?? "")) return "a clipped box";
  if (/inset\(\s*100%/u.test(cs.clipPath ?? "")) return `clip-path:${cs.clipPath}`;
  if (/scale\(\s*0\s*[,)]/u.test(cs.transform ?? "")) return `transform:${cs.transform}`;
  if (/^-?\d{4,}px$/u.test(cs.textIndent ?? "")) return `text-indent:${cs.textIndent}`;
  if (cs.color === "transparent" || /rgba\(.*,\s*0\s*\)/u.test(cs.color ?? "")) return "transparent text";
  return null;
}

function visibleText(root, win) {
  const out = [];
  const walk = (el) => {
    if (el.nodeType === 3) {
      const t = el.textContent.trim();
      if (t) out.push(t);
      return;
    }
    if (el.nodeType !== 1) return;
    if (hiddenBy(el, win)) return;
    for (const child of el.childNodes) walk(child);
  };
  walk(root);
  return out.join(" ");
}

// Is this element on screen, and are all its ancestors? A guard inside a hidden parent has not
// reached anybody.
function isVisible(el, win) {
  for (let node = el; node && node.nodeType === 1; node = node.parentElement)
    if (hiddenBy(node, win)) return false;
  return true;
}

const visible = (win) => visibleText(win.document.body, win).replace(/\s+/gu, " ");

test("RENDERED: a node that went quiet is still on the screen, labelled and counted", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({}),
      optimus: machine({ stale: true, since: T(10), ageMs: 3_600_000 })
    }
  });
  const text = visible(window);
  assert.match(text, /optimus/u, "the stale node is drawn — this is the mutation that shipped green");
  assert.match(text, /t480/u);
  assert.match(text, /stale since/u, "and it says WHEN it went quiet");
  // THE SENTENCE THE OWNER READS FIRST. Every earlier defect in this panel was damning because of
  // what the header said while the cards were wrong — "3 nodes reporting" over two cards, "14 nodes
  // reporting" over four — and the header itself was asserted nowhere, so hard-coding it shipped
  // green. It is counted here, against the fold.
  const header = window.document.querySelector(".em__age");
  assert.ok(header && isVisible(header, window), "the header is on screen");
  assert.match(header.textContent, /^2 nodes reporting$/u, "it counts the machines the fold holds");
  // BOUND TO THE CARD IT SITS ON, not sorted into a set: sorting proves two badges exist with the
  // right words on them and says nothing about which machine is which, so swapping them passes.
  const badgeOf = (name) =>
    [...window.document.querySelectorAll(".em__card")]
      .find((card) => card.querySelector(".em__machine")?.textContent.trim() === name)
      ?.querySelector(".em__state")
      ?.textContent.trim();
  assert.equal(badgeOf("t480"), "live", "the live node's own card says live");
  assert.equal(badgeOf("optimus"), "stale", "and the quiet node's own card says stale");
  assert.equal(
    window.document.querySelectorAll(".em__card").length,
    2,
    "two machine cards appear — the contract's Scenario 1, finally asserted about cards"
  );
});

test("RENDERED: a node that pushed no application list is named, not blank", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({ apps: [{ name: "Prime-Silo", version: "1.24.5", source: "registry" }] }),
      pi: machine({})
    }
  });
  await openTab(window, "applications");
  const text = visible(window);
  assert.match(text, /No application list pushed by: pi/u);
  assert.match(text, /not because they hold nothing/u);
});

test("RENDERED: what a node withheld is on its card", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        counts: { files: 100, bytes: 1000, listed_files: 60, apps: 0, listed_apps: 0, media: 0, listed_media: 0 }
      })
    }
  });
  assert.match(visible(window), /40 files counted by category, not listed by name/u);
});

test("RENDERED: an incomplete sweep says so where the owner is looking", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        volumes: {
          "C:\\": { collector: "everything", status: "ok", rows: 10, at: T(10) },
          "D:\\": { collector: "walker", status: "errored", rows: 0, error_code: "WALK_INCOMPLETE", at: T(10) }
        }
      })
    }
  });
  assert.match(visible(window), /WALK_INCOMPLETE/u, "on the estate tab");
  await openTab(window, "storage");
  assert.match(visible(window), /WALK_INCOMPLETE/u, "and again where its bytes are missing from");
});

test("RENDERED: a hub that did not answer reads cannot-tell, never an empty estate", async () => {
  const { window } = await renderPanel(null, { status: 500 });
  const text = visible(window);
  assert.match(text, /Cannot tell/u);
  assert.match(text, /the hub did not answer/u);
  assert.equal(window.document.querySelectorAll(".em__card").length, 0);
  const malformed = await renderPanel(null, { malformed: true });
  assert.match(visible(malformed.window), /Cannot tell/u, "and malformed JSON is not an empty estate either");
});

test("RENDERED: a hub that answered and holds nothing is not a blank page", async () => {
  const { window } = await renderPanel({ at: NOW, machines: {} });
  const text = visible(window);
  assert.match(text, /No node has pushed a map yet/u);
  assert.match(text, /quarantine/u, "and it names the fail-closed reason — the state this estate is in");
});

// --- S17: Sweep, on the screen ---------------------------------------------------------------------

test("RENDERED: an empty estate offers Sweep for this machine's drives, and pressing one sweeps it", async () => {
  // The empty estate is exactly when the owner needs the button, so it must be on THAT screen.
  const { window } = await renderPanel({ at: NOW, machines: {} });
  const buttons = [...window.document.querySelectorAll(".em__sweepbtn")];
  assert.deepEqual(buttons.map((b) => b.textContent.trim()), ["C:", "F:", "All"]);
  assert.match(visible(window), /Sweep T480:/u);
  // the click happens after the render, so it gets a recording fetch of its own. The sweep it starts
  // has already finished by the time the panel looks — a small root does — so the panel must re-read
  // the MAP itself rather than wait a minute for the slow refresh (claude-s17-verifier).
  const posted = [];
  const read = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") posted.push({ url, body: JSON.parse(init.body) });
    else read.push(url);
    const body = url === "/api/estate/map" ? { at: NOW, machines: {} } : SWEEP_READY;
    return { ok: true, status: init.method === "POST" ? 202 : 200, json: async () => body };
  };
  try {
    buttons[1].click();
    await until(() => read.includes("/api/estate/map"));
  } finally {
    globalThis.fetch = saved;
  }
  assert.deepEqual(posted, [{ url: "/api/estate/sweep", body: { volumes: ["F:"] } }]);
  assert.deepEqual(read, ["/api/estate/sweep", "/api/estate/map"], "status, then the map that changed");
});

test("RENDERED: a root the map could never carry is named with its reason, and no roots means no button", async () => {
  const unusable = [{ root: "F:\\a\\b\\c", reason: "volume name" }];
  const some = await renderPanel({ at: NOW, machines: {} }, { sweep: { ...SWEEP_READY, roots: ["C:"], unusable } });
  assert.deepEqual([...some.document.querySelectorAll(".em__sweepbtn")].map((b) => b.textContent.trim()), ["C:"]);
  assert.match(visible(some.window), /F:\\a\\b\\c cannot be swept: volume name/u);
  const none = await renderPanel({ at: NOW, machines: {} }, { sweep: { ...SWEEP_READY, roots: [], unusable } });
  assert.equal(none.document.querySelectorAll(".em__sweepbtn").length, 0);
  assert.doesNotMatch(visible(none.window), /Sweep T480:/u, "no label introducing buttons that are not there");
  assert.match(visible(none.window), /offers no volume the map can carry/u);
});

// --- S20: Backups, on the screen --------------------------------------------------------------------

test("RENDERED: the Backups tab names each drive against F:, and pressing Compare asks for that pair", async () => {
  const { window } = await renderPanel({ at: NOW, machines: { t480: machine({}) } });
  await openTab(window, "backups");
  const rows = [...window.document.querySelectorAll(".em__backups .em__mediarow")];
  assert.deepEqual(rows.map((r) => r.querySelector("b").textContent), ["C:", "G:"], "every root but F: itself");
  assert.match(visible(window), /G: Not compared yet\./u);
  const posted = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: init.method === "POST" ? 202 : 200, json: async () => COMPARE_READY };
  };
  try {
    [...rows[1].querySelectorAll("button")].find((b) => /Compare with F:/u.test(b.textContent)).click();
    await until(() => posted.length > 0);
  } finally {
    globalThis.fetch = saved;
  }
  assert.deepEqual(posted, [{ url: "/api/estate/compare", body: { from: "G:", to: "F:" } }]);
});

test("RENDERED: a finished comparison says what is only on the drive, its folders, and offers the list", async () => {
  const t = () => ({ files: 0, bytes: 0 });
  const done = {
    ok: true,
    at: new Date().toISOString(),
    drive: { files: 150, bytes: 5_000_000 },
    onlyHere: { files: 120, bytes: 4_000_000 },
    onTarget: { files: 30, bytes: 1_000_000 },
    unconfirmed: t(),
    unreadable: t(),
    privateCounted: { files: 2, bytes: 10 },
    folders: [{ folder: "G:\\Photos\\2019", files: 100, bytes: 3_500_000 }],
    listed: 118
  };
  const { window } = await renderPanel(
    { at: NOW, machines: { t480: machine({}) } },
    { compare: { ...COMPARE_READY, results: { "C:": null, "G:": done } } }
  );
  await openTab(window, "backups");
  const text = visible(window);
  assert.match(text, /Only on G:: 120 files, 3\.8 MB, 2 of them private and not listed\./u);
  assert.match(text, /Already on F:, by full hash: 30\./u);
  assert.match(text, /G:\\Photos\\2019 100 files · 3\.3 MB/u);
  const link = window.document.querySelector(".em__backups a[download]");
  assert.equal(link.getAttribute("href"), "/api/estate/compare.csv?from=G%3A&to=F%3A");
});

// --- S21: the Library, on the screen ---------------------------------------------------------------

// Press a button found by its words with fetch recording what the page POSTs, and return those POSTs.
async function pressing(window, root, words, answer) {
  const posted = [];
  const saved = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    if (init.method === "POST") posted.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: init.method === "POST" ? 202 : 200, json: async () => answer };
  };
  try {
    const button = [...window.document.querySelectorAll(`${root} button`)].find((b) => words.test(b.textContent));
    if (!button) throw new Error(`no button matching ${words} in ${root}`);
    button.click();
    await until(() => posted.length > 0);
  } finally {
    globalThis.fetch = saved;
  }
  return posted;
}

test("RENDERED: the Library tab says F: was never catalogued, and Catalogue F: asks for F:", async () => {
  const { window } = await renderPanel({ at: NOW, machines: { t480: machine({}) } });
  await openTab(window, "library");
  assert.match(visible(window), /F: Never catalogued\./u);
  const posted = await pressing(window, ".em__library", /Catalogue F:/u, LIBRARY_READY);
  assert.deepEqual(posted, [{ url: "/api/estate/library", body: { root: "F:" } }]);
});

test("RENDERED: a pass running shows its progress and a Stop, and no second Catalogue", async () => {
  const running = { root: "F:", since: new Date().toISOString(), phase: "cataloguing", seen: 4000, hashed: 3900, bytes_hashed: 2_000_000, rate: 80, estimate: 12000 };
  const { window } = await renderPanel({ at: NOW, machines: { t480: machine({}) } }, { library: { ...LIBRARY_READY, running } });
  await openTab(window, "library");
  const text = visible(window);
  assert.match(text, /Cataloguing F:: 4,000 files read, 3,900 hashed \(1\.9 MB\), 80 files\/s, about 1 minute left\./u);
  assert.ok(![...window.document.querySelectorAll(".em__library button")].some((b) => /Catalogue/u.test(b.textContent)));
  const posted = await pressing(window, ".em__library", /^Stop$/u, LIBRARY_READY);
  assert.deepEqual(posted, [{ url: "/api/estate/library/stop", body: {} }]);
});

test("RENDERED: a finished catalogue shows its kinds, its duplicates and the list, and counts private copies", async () => {
  const at = new Date().toISOString();
  const cat = {
    last: { finished_at: at, seen: 9, unreadable_dirs: 2 },
    finishedAt: at,
    files: 9,
    bytes: 9_000,
    kinds: [{ kind: "images", files: 6, bytes: 8_000 }],
    duplicates: { sets: 2, wasted: 3_000, private: 2, top: [{ sha256: "ab", size: 3_000, copies: 2, paths: ["F:\\Photos\\a.jpg", "F:\\Old\\a.jpg"] }] }
  };
  const { window } = await renderPanel(
    { at: NOW, machines: { t480: machine({}) } },
    { library: { ...LIBRARY_READY, catalogues: { ...LIBRARY_READY.catalogues, "F:": cat } } }
  );
  await openTab(window, "library");
  const text = visible(window);
  assert.match(text, /Catalogued moments ago: 9 files/u);
  assert.match(text, /2 folders could not be read, so their files were kept as they were\./u);
  assert.match(text, /images 6 files · 7\.8 KB/u);
  assert.match(text, /2 sets of duplicates, 2\.9 KB that one copy each would free, 2 private copies counted and not listed\./u);
  assert.match(text, /F:\\Old\\a\.jpg/u);
  assert.equal(window.document.querySelector(".em__library a[download]").getAttribute("href"), "/api/estate/library.csv?root=F%3A");
});

test("RENDERED: while the hub works the duplicates out, the tab says so and offers no stale list", async () => {
  const at = new Date().toISOString();
  // the last answer under the same rules is shown, but its list describes an older pass
  const older = { sets: 2, wasted: 3_000, private: 0, top: [] };
  const cat = { last: { finished_at: at, seen: 9 }, finishedAt: at, files: 9, bytes: 9, kinds: [], duplicates: older, computing: true };
  const { window } = await renderPanel(
    { at: NOW, machines: { t480: machine({}) } },
    { library: { ...LIBRARY_READY, catalogues: { ...LIBRARY_READY.catalogues, "F:": cat } } }
  );
  await openTab(window, "library");
  assert.match(visible(window), /2 sets of duplicates, 2\.9 KB that one copy each would free\. Working out the duplicates of the latest pass…/u);
  assert.equal(window.document.querySelector(".em__library a[download]"), null);
});

test("RENDERED: a stopped pass says Catalogue resumes it", async () => {
  const cat = { last: { stopped_at: new Date().toISOString(), seen: 1234 }, finishedAt: null, files: 1200, bytes: 1, kinds: [], duplicates: { sets: 0, wasted: 0, private: 0, top: [] } };
  const { window } = await renderPanel(
    { at: NOW, machines: { t480: machine({}) } },
    { library: { ...LIBRARY_READY, catalogues: { ...LIBRARY_READY.catalogues, "F:": cat } } }
  );
  await openTab(window, "library");
  assert.match(visible(window), /Stopped moments ago after 1,234 files: Catalogue again resumes where it stopped\./u);
  assert.match(visible(window), /\(of the files catalogued so far\)/u);
});

test("RENDERED: a comparison names the catalogue it asked, and one running can be stopped", async () => {
  const t = () => ({ files: 0, bytes: 0 });
  const done = {
    ok: true, at: new Date().toISOString(), catalogueAt: new Date().toISOString(),
    drive: { files: 1, bytes: 1 }, onlyHere: t(), onTarget: { files: 1, bytes: 1 }, unconfirmed: t(), unreadable: t(), privateCounted: t(), folders: [], listed: 0
  };
  const running = { from: "C:", to: "F:", since: new Date().toISOString(), phase: "hashing the drive", done: 1, total: 5 };
  const { window } = await renderPanel(
    { at: NOW, machines: { t480: machine({}) } },
    { compare: { ...COMPARE_READY, running, results: { "C:": null, "G:": done } } }
  );
  await openTab(window, "backups");
  assert.match(visible(window), /Against the catalogue of F: from moments ago\./u);
  const posted = await pressing(window, ".em__backups", /^Stop$/u, COMPARE_READY);
  assert.deepEqual(posted, [{ url: "/api/estate/compare/stop", body: {} }]);
});

test("RENDERED: a page left open keeps the sweep's age current, as the map card does", async () => {
  // Found on the owner's own screen: an hour after a sweep the line still said "finished moments
  // ago", read once at load, while the card beside it had refreshed to "swept 1 hour ago".
  const at = new Date(Date.now() - 75 * 60_000).toISOString();
  const swept = { ...SWEEP_READY, last: { ok: true, at: new Date().toISOString(), volumes: ["C:"], files: 9 } };
  const { window, intervals } = await renderPanel({ at: NOW, machines: {} }, { sweep: swept });
  assert.match(visible(window), /finished moments ago/u);
  const saved = globalThis.fetch;
  globalThis.fetch = async (url) => ({
    ok: true,
    status: 200,
    json: async () => (url === "/api/estate/map" ? { at: NOW, machines: {} } : { ...swept, last: { ...swept.last, at } })
  });
  try {
    for (const tick of intervals) await tick();
    await until(() => /finished 1 hour ago/u.test(visible(window)));
  } finally {
    globalThis.fetch = saved;
  }
});

test("RENDERED: with no policy the panel says why it cannot sweep, and offers no button", async () => {
  const { window } = await renderPanel(
    { at: NOW, machines: {} },
    { sweep: { machine: "T480", roots: ["C:"], policy: false, running: null, last: null } }
  );
  assert.equal(window.document.querySelectorAll(".em__sweepbtn").length, 0, "no button that would fail");
  assert.match(visible(window), /Sweeping is off: there is no quarantine policy at coordination\/estate\/quarantine\.json/u);
});

test("RENDERED: the storage tab draws machines in bytes and volumes in files, and reconciles", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        counts: { files: 300, bytes: 4000, listed_files: 300, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {
          "C:\\": { collector: "everything", status: "ok", rows: 200, at: T(10) },
          "F:\\": { collector: "everything", status: "ok", rows: 100, at: T(10) }
        }
      }),
      optimus: machine({
        counts: { files: 7, bytes: 2000, listed_files: 7, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {}
      })
    }
  });
  await openTab(window, "storage");
  const text = visible(window);
  // the panel lays out one tick after the tab appears, so this waits for the rectangles rather than
  // racing them — and still fails loudly, with until()'s message, if they never arrive
  await until(() => window.document.querySelectorAll(".em__rect").length >= 3);
  assert.match(text, /files/u, "volumes are labelled in files");
  assert.match(text, /reported by the nodes/u, "the reconciliation is on screen");
  assert.match(text, /no volume inside it/u, "and the node drawn as a bare block is described as one");
  // THE LINE AND THE PICTURE MUST AGREE. Whatever the wording, the bytes called drawn are the bytes
  // the rectangles carry — that is the invariant the previous version of this tab broke.
  const data = window.Alpine.$data(window.document.querySelector(".em"));
  const drawnRects = data.rects.filter((r) => r.level === "machine" && !r.tooSmall);
  assert.equal(
    drawnRects.reduce((sum, r) => sum + r.value, 0),
    data.recon.drawn,
    "the bytes the line calls drawn are exactly the bytes the machine rectangles carry"
  );
  for (const r of window.document.querySelectorAll(".em__rect"))
    assert.ok(isVisible(r, window), "a rectangle the map counts must be one the owner can see");
  for (const r of window.document.querySelectorAll('.em__rect[data-level="volume"]'))
    assert.doesNotMatch(
      r.textContent,
      /\d+(\.\d+)?\s?(B|KB|MB|GB|TB)\b(?!.*withheld)/u,
      "no volume rectangle claims a byte size the node never sent"
    );
});

test("RENDERED: media says what each node swept, and does not read as no media", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        counts: { files: 1, bytes: 1, listed_files: 1, apps: 0, listed_apps: 0, media: 40, listed_media: 25 }
      }),
      pi: machine({})
    }
  });
  await openTab(window, "media");
  const text = visible(window);
  assert.match(text, /25 of 40 published/u);
  assert.match(text, /has not swept media/u, "the node that never looked says so");
});

// The three above are pure-function tests; the ones below are about what survives contact with the
// markup, the stylesheet and a mouse.

test("RENDERED: the panel's own stylesheet is in the document under test", async () => {
  // If this ever fails, every visibility assertion in this file silently becomes an assertion about
  // an unstyled document — which is precisely how seven CSS one-liners hid guards under a green gate.
  const { window } = await renderPanel({ at: NOW, machines: { t480: machine({}) } });
  assert.ok(window.document.styleSheets.length > 0, "no stylesheet loaded: the visibility tests would be vacuous");
  const rules = [...window.document.styleSheets].flatMap((sheet) => [...sheet.cssRules].map((r) => r.cssText));
  assert.ok(rules.some((r) => r.includes(".em__card")), "the panel's own rules are the ones loaded");
});

test("RENDERED: clicking the tab you are already on does not wipe the map", async () => {
  // layout() used to be called from the tab button's own expression scope, where $el is the BUTTON.
  // It found no .em__map, measured zero, and set rects to [] — so a second click on the open Storage
  // tab left an empty box while the line beneath it still said how many bytes were drawn. The panel
  // contradicting itself about the same bytes is the one thing this surface must never do.
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        counts: { files: 300, bytes: 4000, listed_files: 300, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {
          "C:\\": { collector: "everything", status: "ok", rows: 200, at: T(10) },
          "F:\\": { collector: "everything", status: "ok", rows: 100, at: T(10) }
        }
      })
    }
  });
  await openTab(window, "storage");
  await until(() => window.document.querySelectorAll(".em__rect").length >= 3);
  const drawn = window.document.querySelectorAll(".em__rect").length;

  const storage = [...window.document.querySelectorAll(".em__tab")].find((t) => t.textContent.trim() === "storage");
  storage.click();
  storage.click();
  await new Promise((r) => setTimeout(r, 30));
  assert.equal(
    window.document.querySelectorAll(".em__rect").length,
    drawn,
    "the map is still drawn after clicking the tab it is already on"
  );
});

test("RENDERED: a drifted product is flagged where the owner can see it", async () => {
  // Scenario 2 says the row must be FLAGGED. The flag is an attribute the stylesheet colours, so a
  // pure-function test that checks row.drifted proves nothing about the screen.
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({ apps: [{ name: "Prime-Silo", version: "1.24.5", source: "registry" }] }),
      optimus: machine({ apps: [{ name: "Prime-Silo", version: "1.24.4", source: "winget" }] })
    }
  });
  await openTab(window, "applications");
  const rows = [...window.document.querySelectorAll(".em__matrix tbody tr")];
  assert.equal(rows.length, 1);
  assert.equal(rows[0].dataset.drifted, "true", "the drifted row carries its flag in the rendered DOM");
  assert.ok(isVisible(rows[0], window), "and the row itself is on screen");
  const drift = window.document.querySelector(".em__drift");
  assert.ok(drift && isVisible(drift, window), "and the count of drifted products is visible too");
  assert.match(drift.textContent, /1 product at different versions/u);
});

test("RENDERED: a volume too small to draw is named on screen, not just in the data", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        counts: { files: 1_000_001, bytes: 4000, listed_files: 1_000_001, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {
          "C:\\": { collector: "everything", status: "ok", rows: 1_000_000, at: T(10) },
          "Z:\\": { collector: "everything", status: "ok", rows: 1, at: T(10) }
        }
      })
    }
  });
  await openTab(window, "storage");
  await until(() => window.document.querySelectorAll(".em__rect").length >= 2);
  const text = visible(window);
  assert.match(text, /Z:\\/u, "the sliver that cannot be drawn is named");
  assert.match(text, /too small to draw/u, "and the panel says why it is not in the picture");
});

test("RENDERED: the not-pushed notice is on screen, not merely in the document", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({ apps: [{ name: "Prime-Silo", version: "1.24.5", source: "registry" }] }),
      pi: machine({})
    }
  });
  await openTab(window, "applications");
  const notice = [...window.document.querySelectorAll(".em__note")].find((p) => /No application list/u.test(p.textContent));
  assert.ok(notice, "the notice exists");
  assert.ok(isVisible(notice, window), "and nothing — attribute or stylesheet — is hiding it");
});

test("RENDERED: what a node withheld, and what the estate could not account for, are both on screen", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        counts: { files: 100, bytes: 4000, listed_files: 60, apps: 0, listed_apps: 0, media: 0, listed_media: 0 }
      }),
      optimus: machine({
        counts: { files: 7, bytes: 2000, listed_files: 7, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {}
      })
    }
  });
  const card = [...window.document.querySelectorAll(".em__withheld")].find((p) => /40 files counted by category/u.test(p.textContent));
  assert.ok(card && isVisible(card, window), "the withheld count is visible on the card");
  await openTab(window, "storage");
  const recon = window.document.querySelector(".em__recon");
  assert.ok(recon && isVisible(recon, window), "the reconciliation is visible");
  assert.match(visible(window), /no volume inside it/u, "and the node drawn as a bare block is described as one");
});

test("RENDERED: a layout that cannot measure anything keeps what is on screen", async () => {
  // The bug behind C1 was not the tab button; it was that a failed measurement was turned into
  // "there is nothing to draw". This asserts the class rather than the instance: whatever goes wrong
  // with the element lookup, the map that is already drawn survives it.
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        counts: { files: 300, bytes: 4000, listed_files: 300, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: {
          "C:\\": { collector: "everything", status: "ok", rows: 200, at: T(10) },
          "F:\\": { collector: "everything", status: "ok", rows: 100, at: T(10) }
        }
      })
    }
  });
  await openTab(window, "storage");
  await until(() => window.document.querySelectorAll(".em__rect").length >= 3);
  const drawn = window.document.querySelectorAll(".em__rect").length;

  // measure nothing at all, the way a lookup from the wrong scope does
  const real = window.Element.prototype.getBoundingClientRect;
  window.Element.prototype.getBoundingClientRect = () => ({ width: 0, height: 0, x: 0, y: 0, top: 0, left: 0, right: 0, bottom: 0 });
  try {
    window.Alpine.$data(window.document.querySelector(".em")).layout();
    await new Promise((r) => setTimeout(r, 20));
    assert.equal(
      window.document.querySelectorAll(".em__rect").length,
      drawn,
      "the map is still there after a layout that could measure nothing"
    );
  } finally {
    window.Element.prototype.getBoundingClientRect = real;
  }
});

test("RENDERED: machine rectangle AREAS are proportional to the bytes each node reported", async () => {
  // SCENARIO 3, first clause, which had no test at all until claude-s4-verifier-3 pointed at it —
  // and the test that was supposed to carry the Scenario fed three abstract keys to the bare
  // squarifier and never touched a fold, a machine or the panel. Four mutations that destroy this
  // shipped GREEN: sizing machines by file count, equal rectangles, sqrt(bytes), and labelling the
  // machine block in files. The first is B1 all over again one level up — the treemap inventing a
  // number — and on the verifier's fold it made a node holding half the estate's bytes VANISH.
  const B = { t480: 1_400_000_000_000, optimus: 640_000_000_000, pi: 2_000_000_000_000 };
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({
        counts: { files: 3_000_000, bytes: B.t480, listed_files: 3_000_000, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "C:\\": { collector: "everything", status: "ok", rows: 3_000_000, at: T(10) } }
      }),
      optimus: machine({
        counts: { files: 10, bytes: B.optimus, listed_files: 10, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "C:\\": { collector: "everything", status: "ok", rows: 10, at: T(10) } }
      }),
      // the node with the MOST bytes and the FEWEST files: sizing by file count would shrink it to
      // nothing, which is exactly what the owner would not notice
      pi: machine({
        counts: { files: 1, bytes: B.pi, listed_files: 1, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "/": { collector: "walker", status: "ok", rows: 1, at: T(10) } }
      })
    }
  });
  await openTab(window, "storage");
  await until(() => window.document.querySelectorAll('.em__rect[data-level="machine"]').length >= 3);

  const data = window.Alpine.$data(window.document.querySelector(".em"));
  const blocks = data.rects.filter((r) => r.level === "machine");
  assert.equal(blocks.length, 3, "every node that reported bytes has a block");
  const area = (r) => r.w * r.h;
  const total = blocks.reduce((s, r) => s + area(r), 0);
  const reported = Object.values(B).reduce((s, b) => s + b, 0);
  for (const r of blocks) {
    const share = area(r) / total;
    const truth = B[r.machine] / reported;
    assert.ok(
      Math.abs(share - truth) < 0.02,
      `${r.machine} takes ${(share * 100).toFixed(1)}% of the map for ${(truth * 100).toFixed(1)}% of the bytes`
    );
  }
  // pi is the largest thing on screen because it holds the most bytes, whatever its file count says
  const biggest = blocks.slice().sort((a, b) => area(b) - area(a))[0];
  assert.equal(biggest.machine, "pi", "the node holding the most bytes is the biggest block");
  // and the block is labelled in bytes the node actually sent
  const pi = [...window.document.querySelectorAll('.em__rect[data-level="machine"]')].find((el) =>
    el.textContent.includes("pi")
  );
  assert.match(pi.textContent, /1\.8 TB/u, "labelled with the bytes reported, not a file count");
});

test("RENDERED: a machine block too small to draw is named, like any other lost bytes", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      whale: machine({
        counts: { files: 10, bytes: 900_000_000_000_000, listed_files: 10, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "C:\\": { collector: "everything", status: "ok", rows: 10, at: T(10) } }
      }),
      // a rounding error beside the whale: its block cannot reach a pixel, and bytes the map counts
      // but cannot show are the same lie as a volume nobody can see, one level up
      mouse: machine({
        counts: { files: 1, bytes: 1000, listed_files: 1, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "D:\\": { collector: "everything", status: "ok", rows: 1, at: T(10) } }
      })
    }
  });
  await openTab(window, "storage");
  await until(() => window.document.querySelectorAll(".em__rect").length >= 2);
  assert.match(visible(window), /mouse — .*too small to draw/u, "the block nobody can see is named");
});

test("RENDERED: a quiet node's column in the matrix says it is quiet", async () => {
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({ apps: [{ name: "Prime-Silo", version: "1.24.5", source: "registry" }] }),
      optimus: machine({
        stale: true,
        since: T(10),
        ageMs: 3_600_000,
        apps: [{ name: "Prime-Silo", version: "1.24.4", source: "winget" }]
      })
    }
  });
  await openTab(window, "applications");
  const headers = [...window.document.querySelectorAll(".em__matrix thead th")];
  const optimus = headers.find((h) => h.textContent.includes("optimus"));
  assert.ok(optimus, "the quiet node still has a column — it is not dropped");
  assert.equal(optimus.dataset.stale, "true");
  assert.match(optimus.textContent, /stale/u, "and the column says so, so 1.24.4 reads as its LAST known version");
  const cell = [...window.document.querySelectorAll(".em__matrix tbody td")].find((td) => td.dataset.stale === "true");
  assert.ok(cell && isVisible(cell, window), "the cells under it carry the same mark");
});

// --- the apparatus is pinned by its own tests -----------------------------------------------------
//
// claude-s4-verifier-4's E5: blinding hiddenBy(), deleting the stylesheet check and making until()
// return quietly on timeout each shipped GREEN. Every guard this file adds to the panel was itself
// unguarded — B4's class applied to the thing built to answer B4. These tests fail if the machinery
// stops working, so the machinery cannot be removed silently.

test("the panel's stylesheet carries nothing that could hide a guard", () => {
  const problems = stylesheetProblems(fs.readFileSync(path.join(PANEL, "estate_map.css"), "utf8"));
  assert.deepEqual(problems, [], `the panel stylesheet may not hide anything: ${problems.join(" | ")}`);
});

test("the stylesheet check refuses every way of hiding that has been used against this panel", () => {
  // Each of these was written by a verifier, survived a green gate, and was measured hiding its
  // guard in Chrome. They are cases of the check now, so it cannot quietly stop catching them. The
  // last thirteen are why the check parses the sheet instead of scanning it: none of them contains a
  // property the previous string matcher could see.
  const attacks = [
    '@scope (.em) { .em__card[data-stale="true"] { display: none } }',
    "@layer hide { @scope (.em) { .em__recon { display: none } } }",
    "@media (min-width: 1px) { .em__withheld { display: none } }",
    "@supports (display: grid) { .em__recon { display: none } }",
    "@container (min-width: 1px) { .em__drift { display: none } }",
    ".em__recon { height: 0; overflow: hidden }",
    ".em__drift { transform: scaleX(0) }",
    ".em__drift { transform: scale3d(0, 0, 1) }",
    ".em__blind { clip-path: circle(0) }",
    ".em__blind { clip: rect(0, 0, 0, 0) }",
    ".em__nothing { filter: opacity(0) }",
    ".em__nothing { content-visibility: hidden }",
    ".em__card { transform: translateY(5000px) }",
    ".em__withheld { font-size: 0.01px }",
    ".em__withheld { font: 0/0 a }",
    ".em__note { -webkit-text-fill-color: transparent }",
    ".em__note { color: transparent }",
    ".em__note { color: rgba(255, 255, 255, 0) }",
    ".em__note { letter-spacing: -1em }",
    ".em__note { text-indent: -100px }",
    ".em__unsized { position: fixed; top: 200vh }",
    ".em__unsized { width: 0; overflow: hidden }",
    ".em__matrix { opacity: 0.004 }",
    '.em__rect[data-level="volume"] { width: 0 !important; height: 0 !important }',
    // the thirteen that beat the string matcher
    '.em__card { &[data-stale="true"] { display: none } }',
    ".em { & .em__recon { display: none } }",
    ":root { --h: none } .em__card { display: var(--h) }",
    ".em__card { display: var(--nope, none) }",
    `.em__card { di${String.fromCharCode(92)}73 play: none }`,
    ".em__card { scale: 0 }",
    ".em__card { translate: 0 5000px }",
    ".em__note { margin-left: -9999px }",
    ".em__note { font-size: .0001px }",
    ".em__note { line-height: 0; overflow: hidden; max-height: 1px }",
    ".em__note { position: absolute; inset: auto auto auto 5000px }",
    ".em__note { zoom: 0 }",
    ".em__card { opacity: 0.49999 }",
    // AN APPROVED DECLARATION, IN AN APPROVED PLACE, that only the at-rule and !important refusals
    // can catch. Without these two the table never exercised either refusal — every other attack
    // also carries something the inventory rejects, so deleting them both shipped green.
    "@media (min-width: 1px) { .em__map { height: 26rem } }",
    ".em__map { height: 26rem !important }",
    // and the clipping rule needs its own case that the inventory alone would wave through
    ".em__cards { height: 26rem; overflow: hidden }"
  ];
  const real = fs.readFileSync(path.join(PANEL, "estate_map.css"), "utf8");
  // COUNTED, so that gutting the loop's assertion is not silent: a verifier replaced the assert with
  // a void and the gate stayed green. The count is what the table is for.
  let caught = 0;
  for (const attack of attacks) {
    const problems = stylesheetProblems(`${real}
${attack}
`);
    if (problems.length > 0) caught++;
    else assert.fail(`not caught: ${attack}`);
  }
  assert.equal(caught, attacks.length, "every attack in the table must be refused");
  assert.ok(attacks.length >= 40, "the table must still hold every attack that has been used here");
  // a brace inside a string is a parser's problem, not a splitter's, and the parser has it
  assert.ok(
    stylesheetProblems(`${real}
.em::before { content: "{" }
.em__card { display: none }
`).length > 0,
    "a brace inside a string must not stop the check"
  );
  // and the check is not vacuous in the other direction: the real sheet passes, and a declaration
  // the panel legitimately makes is accepted when it is in the inventory
  assert.deepEqual(stylesheetProblems(real), []);
});

test("the visibility walker actually detects the things it claims to", async () => {
  const { JSDOM } = await import("jsdom");
  const cases = [
    ["display", "display: none"],
    ["visibility", "visibility: hidden"],
    ["opacity", "opacity: 0"],
    ["font-size", "font-size: 0"],
    ["off-screen", "position: absolute; left: -99999px"],
    ["below the fold", "position: fixed; top: 20000px"],
    ["clipped", "max-height: 0"]
  ];
  for (const [name, rule] of cases) {
    const dom = new JSDOM(`<p id="t" style="${rule}">x</p>`);
    assert.ok(hiddenBy(dom.window.document.getElementById("t"), dom.window), `${name} went unnoticed`);
  }
  const plain = new JSDOM(`<p id="t">x</p>`);
  assert.equal(hiddenBy(plain.window.document.getElementById("t"), plain.window), null, "a plain element is visible");
});

test("until() fails when the condition never comes true", async () => {
  await assert.rejects(() => until(() => false, { timeout: 60, step: 10 }), /never reached/u);
});

test("machine areas stay proportional at every box shape, not just the harness's", () => {
  // The rendered test above lays out at ONE box, which is what let a distortion keyed on the aspect
  // ratio through. This one runs the real layout at five shapes, including the one a browser gives
  // the panel, and at several estate sizes.
  const sizes = [
    { a: 1_400_000_000_000, b: 640_000_000_000, c: 2_000_000_000_000 },
    { a: 4_000_000_000_000, b: 4_000_000_000, c: 40_000_000_000 },
    { a: 1, b: 1, c: 1 }
  ];
  for (const bytes of sizes) {
    const view = {
      machines: Object.entries(bytes).map(([machine, value]) => ({
        key: machine,
        machine,
        value,
        files: 1,
        volumes: [{ key: `${machine}:C`, machine, volume: "C:\\", files: 1 }]
      }))
    };
    for (const box of REAL_BOXES) {
      const blocks = storageRects(view, { x: 0, y: 0, ...box }).filter((r) => r.level === "machine");
      const drawn = blocks.filter((r) => !r.tooSmall);
      const area = drawn.reduce((s, r) => s + r.w * r.h, 0);
      // again: the shares are judged against the FOLD's bytes, never against the block's own
      const truthOf = (m) => bytes[m];
      const total = drawn.reduce((s, r) => s + truthOf(r.machine), 0);
      for (const r of drawn) {
        const share = (r.w * r.h) / area;
        const truth = truthOf(r.machine) / total;
        assert.ok(
          Math.abs(share - truth) < 0.03,
          `at ${box.w}x${box.h} ${r.machine} takes ${(share * 100).toFixed(1)}% of the drawn area for ${(truth * 100).toFixed(1)}% of the drawn bytes`
        );
      }
      // and whatever the layout could not draw is marked, never silently absent
      const marked = blocks.filter((r) => r.tooSmall).length;
      assert.equal(
        blocks.length,
        drawn.length + marked,
        `at ${box.w}x${box.h} a block is neither drawn nor marked too small`
      );
    }
  }
});

test("the reconciliation closes at every box shape, including one where blocks vanish", () => {
  // Two machines at a 1000:1 ratio is enough for the smaller block to fall under a pixel — an
  // ordinary pairing here. The line must then say so rather than counting it as drawn.
  const view = {
    machines: [
      { key: "whale", machine: "whale", value: 4_000_000_000_000, files: 1, volumes: [] },
      { key: "mouse", machine: "mouse", value: 4_000_000_000, files: 1, volumes: [] }
    ]
  };
  for (const box of REAL_BOXES) {
    const rects = storageRects(view, { x: 0, y: 0, ...box });
    const r = reconcile(view, rects);
    assert.equal(
      r.reported,
      r.drawn + r.tooSmall + r.missing,
      `at ${box.w}x${box.h} the subtraction does not close: ${JSON.stringify(r)}`
    );
    const visible = rects.filter((x) => x.level === "machine" && !x.tooSmall);
    assert.equal(
      visible.reduce((s, x) => s + x.value, 0),
      r.drawn,
      `at ${box.w}x${box.h} "drawn" is not what the rectangles carry`
    );
  }
});

test("a fifty-node estate does not claim to have drawn what it could not", () => {
  // Measured by a verifier on the real panel: one block on the map, the line reading "3.6 TB drawn",
  // and 98 "too small to draw" entries printed directly beneath it.
  // 3.5 TB beside forty-nine nodes holding a megabyte each: their share of the map is a fraction of
  // one pixel, so they cannot be drawn however the layout squarifies them.
  const machines = [{ key: "big", machine: "big", value: 3_500_000_000_000, files: 1, volumes: [] }];
  for (let i = 1; i <= 49; i++)
    machines.push({ key: `n${i}`, machine: `n${i}`, value: 1_000_000, files: 1, volumes: [] });
  const view = { machines };
  const rects = storageRects(view, { x: 0, y: 0, w: 932, h: 416 });
  const r = reconcile(view, rects);
  assert.equal(r.reported, r.drawn + r.tooSmall + r.missing, "the subtraction closes");
  const shown = rects.filter((x) => x.level === "machine" && !x.tooSmall);
  assert.equal(shown.reduce((s, x) => s + x.value, 0), r.drawn);
  assert.ok(r.tooSmall > 0, "the blocks the map could not show are counted as such, not as drawn");
});

test("a byte count the map cannot read is named, not silently treated as zero", () => {
  for (const bad of [-500, Number.NaN, "lots", null, undefined, Infinity]) {
    const fold = {
      machines: {
        t480: machine({
          counts: { files: 1, bytes: bad, listed_files: 1, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
          volumes: { "C:\\": { collector: "everything", status: "ok", rows: 1, at: T(10) } }
        })
      }
    };
    const view = storageView(fold, { now: NOW });
    assert.equal(view.bytes.reported, 0, `${String(bad)} must not become a reported byte count`);
    const named = view.unaccounted.find((u) => /cannot read/u.test(u.why));
    assert.ok(named, `${String(bad)} bytes went unnamed`);
    const r = reconcile(view, storageRects(view, { x: 0, y: 0, w: 640, h: 400 }));
    assert.equal(r.reported, r.drawn + r.tooSmall + r.missing, `the subtraction must still close for ${String(bad)}`);
  }
});

test("a volume really named — keeps its name", () => {
  const fold = {
    machines: {
      t480: machine({
        counts: { files: 0, bytes: 10, listed_files: 0, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "—": { collector: "everything", status: "ok", rows: 0, at: T(10) } }
      })
    }
  };
  const entry = storageView(fold, { now: NOW }).unaccounted.find((u) => u.volume === "—");
  assert.ok(entry, "the volume is named, not folded into the machine");
});

test("the treemap tiles its box exactly, whatever shape the box is", () => {
  // A layout that used HALF the box kept every proportion intact and survived every other test:
  // areas were still in the right ratio to each other, labels still right, the subtraction still
  // closed. What it broke is the claim the tab makes by drawing at all — that this rectangle IS the
  // estate. The squarifier's own invariant is that the blocks tile the box, so that is asserted.
  const view = {
    machines: [
      { key: "a", machine: "a", value: 5, files: 1, volumes: [] },
      { key: "b", machine: "b", value: 3, files: 1, volumes: [] },
      { key: "c", machine: "c", value: 2, files: 1, volumes: [] }
    ]
  };
  for (const box of REAL_BOXES) {
    const blocks = storageRects(view, { x: 0, y: 0, ...box }).filter((r) => r.level === "machine");
    const covered = blocks.reduce((s, r) => s + r.w * r.h, 0);
    assert.ok(
      Math.abs(covered - box.w * box.h) < box.w * box.h * 0.01,
      `at ${box.w}x${box.h} the blocks cover ${Math.round((covered / (box.w * box.h)) * 100)}% of the map`
    );
    // and they start at the box's origin rather than being stacked somewhere inside it
    assert.ok(blocks.every((r) => r.x >= 0 && r.y >= 0 && r.x + r.w <= box.w + 1 && r.y + r.h <= box.h + 1));
    assert.ok(blocks.some((r) => r.x === 0 && r.y === 0), "the layout starts in the corner of its box");
  }
});

test("machine areas stay proportional at shapes and sizes nobody chose", () => {
  // 200 layouts from a seeded generator. A distortion conditioned on an aspect ratio, a machine
  // count or a call number has nowhere to hide between them, and a failure reports its seed so it
  // can be replayed exactly.
  // The ranges reach past any screen the owner is likely to have — a 4K window gives the panel about
  // 3776px — and the round count is high enough that a distortion keyed on a call counter has to
  // survive hundreds of layouts. Neither bound is unbounded, and the limits block says so.
  const rand = seeded(20260927);
  for (let round = 0; round < 500; round++) {
    const w = 60 + Math.floor(rand() * 4000);
    const h = 60 + Math.floor(rand() * 2200);
    const count = 1 + Math.floor(rand() * 24);
    const machines = [];
    for (let i = 0; i < count; i++)
      machines.push({
        key: `m${i}`,
        machine: `m${i}`,
        value: Math.max(1, Math.floor(rand() * 4_000_000_000_000)),
        files: Math.max(1, Math.floor(rand() * 5_000_000)),
        volumes: []
      });
    const view = { machines };
    const blocks = storageRects(view, { x: 0, y: 0, w, h }).filter((r) => r.level === "machine");
    const drawn = blocks.filter((r) => !r.tooSmall);
    const area = drawn.reduce((s, r) => s + r.w * r.h, 0);
    // THE TRUTH COMES FROM THE FOLD, NOT FROM THE RECTANGLE. Reading `r.value` back off the block
    // and calling it the answer is the self-reference this whole epic keeps producing: a layout that
    // rewrites the values it was given then agrees with itself perfectly, and two mutations that did
    // exactly that passed this test before it was written this way.
    const reported = new Map(machines.map((m) => [m.machine, m.value]));
    const bytes = drawn.reduce((s, r) => s + reported.get(r.machine), 0);
    const where = `seed round ${round} at ${w}x${h} with ${count} machines`;
    assert.equal(blocks.length, count, `${where}: a machine is missing from the layout entirely`);
    for (const r of drawn) {
      const share = (r.w * r.h) / area;
      const truth = reported.get(r.machine) / bytes;
      assert.ok(
        Math.abs(share - truth) < 0.05,
        `${where}: ${r.machine} takes ${(share * 100).toFixed(1)}% of the drawn area for ${(truth * 100).toFixed(1)}% of the drawn bytes`
      );
    }
    const r = reconcile(view, storageRects(view, { x: 0, y: 0, w, h }));
    assert.equal(r.reported, r.drawn + r.tooSmall + r.missing, `${where}: the subtraction does not close`);
  }
});

test("the apparatus cannot be blinded without the gate noticing", async () => {
  // claude-s4-verifier-5's advisory: blinding isVisible(), disabling the one-fetch assertion and
  // gutting the attack table each still shipped green. Every one of those is a guard on a guard, and
  // an unguarded guard is how this panel got here. Each is now exercised directly.
  const { JSDOM } = await import("jsdom");

  // isVisible must judge ancestors, not merely exist
  const dom = new JSDOM('<div style="display:none"><p id="child">x</p></div><p id="loose">y</p>');
  assert.equal(isVisible(dom.window.document.getElementById("child"), dom.window), false, "a hidden ancestor hides its children");
  assert.equal(isVisible(dom.window.document.getElementById("loose"), dom.window), true);

  // the attack table must actually be non-empty and must actually be checked
  assert.ok(
    stylesheetProblems(".em__card { display: none }").length > 0,
    "the checker must refuse a bare hide"
  );
  assert.deepEqual(
    stylesheetProblems(fs.readFileSync(path.join(PANEL, "estate_map.css"), "utf8")),
    [],
    "and must accept the panel's real stylesheet, or every other assertion here is vacuous"
  );

  // the fetch counter must be able to fail: a render that fetches twice is refused
  await assert.rejects(
    () => renderPanel({ at: NOW, machines: {} }, { fetchTwice: true }),
    /fetched 2 times/u,
    "the one-fetch assertion must fire when a render fetches twice"
  );
});

test("RENDERED: an estate where every node is quiet does not say it is reporting", async () => {
  // reportingLine() has the judgement; nothing asserted it reaches the page. Making it ignore
  // allStale — so a wholly silent estate reads as reporting — shipped green.
  const { window } = await renderPanel({
    at: NOW,
    machines: {
      t480: machine({ stale: true, since: T(10), ageMs: 3_600_000 }),
      optimus: machine({ stale: true, since: T(10), ageMs: 3_600_000 })
    }
  });
  const header = window.document.querySelector(".em__age");
  assert.ok(header && isVisible(header, window));
  assert.match(header.textContent, /2 nodes, all of them stale/u);
  const badges = [...window.document.querySelectorAll(".em__state")].map((b) => b.textContent.trim());
  assert.deepEqual(badges, ["stale", "stale"], "and no card claims to be live");
});

// --- WHAT THIS FILE DOES NOT COVER ------------------------------------------------------------------
//
// Written here because a comment above points at it, and because the previous version of that comment
// pointed at a declaration that did not exist — a claim wider than its code, inside the sentence that
// was deleting a claim wider than its code. This is the list, in the place the reader is sent to.
//
//   - NO LAYOUT ENGINE. jsdom computes styles but lays nothing out, so nothing here sees one box
//     covering another, a colour, a contrast ratio, a scroll position, or a font that fails to load.
//     The contract's Handoff screenshot carries those.
//   - STACKING AND DISPLACEMENT BY MEANS OTHER THAN `position`. That one is refused because it was
//     measured stacking fourteen cards at a point. The inventory happens to exclude `z-index`,
//     `order`, `flex`, `float`, `transform` and negative margins today, so they are refused as
//     unapproved declarations rather than by any rule that understands them — add one of those to the
//     inventory for a legitimate reason and nothing here will notice what else it can do. MEASURED
//     examples that survive today: `.em__cards { display: flex }` puts fourteen cards in one 2747px
//     row (degraded, still reachable by scrolling), and seven stacked approved `opacity: 0.72`
//     declarations multiply to an effective 0.139 on a badge — a ghost, but present.
//   - AN OVERLAY DRAWN BY THE SHELL AROUND THIS PANEL, which is outside this file entirely. NOT a
//     pseudo-element from the panel's own sheet: `content` is not in the inventory, so
//     `.em__card::before { content: "x" }` is refused today — an earlier wording of this bullet named
//     that as a hole and it is shut. It reopens the moment `content` is approved for some legitimate
//     reason, which is the previous bullet's warning applied to this one.
//   - THE FRAMEWORK STYLESHEETS. `view.html` links `layout.css` and `type.css`; only the panel's own
//     sheet is inventoried, so a rule reaching this panel from either of those is unchecked.
//   - THE MARKUP AND THE COMPONENT. An inline `style`, a `hidden` attribute, a class applied
//     conditionally, or a notice moved inside an element that never renders — the stylesheet check
//     cannot see any of it. The render tests catch the cases they were written for and no others.
//   - A LIVE FOLD. Every fold in this file is one this file authored. The hub is fail-closed and
//     `coordination/estate/quarantine.json` does not exist, so nothing here has been measured against
//     real estate data.
