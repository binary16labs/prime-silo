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
  assert.equal(view.bytes.drawn, 3000, "every reported byte is inside a drawn machine");
  assert.equal(view.bytes.missing, 0);
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
  assert.equal(view.bytes.reported, 6000);
  assert.equal(view.bytes.drawn, 4000);
  assert.equal(view.bytes.missing, 2000, "the tab can be reconciled by subtraction on screen");
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

test("the panel reads only the estate map API", () => {
  // §5: the panel renders the fold and nothing else. A fetch to any other endpoint would make this
  // surface depend on something the contract did not give it.
  const js = fs.readFileSync(path.join(PANEL, "estate_map.js"), "utf8");
  const fetched = [...js.matchAll(/fetch\(\s*[`"']([^`"']+)/gu)].map((m) => m[1]);
  assert.ok(fetched.length > 0, "it does fetch something");
  for (const url of fetched)
    assert.match(url, /^\/api\/estate\/map/u, `${url} is not the estate map API`);
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

const BOX = { width: 640, height: 400 };

async function renderPanel(fold, { status = 200, malformed = false } = {}) {
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
  globalThis.fetch = async () => ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (malformed) throw new SyntaxError("Unexpected token < in JSON");
      return fold;
    }
  });
  // the panel's own slow refresh is not what these tests measure, and a live interval would hold the
  // test runner open
  globalThis.setInterval = () => 0;
  try {
    // the real component, loaded once per process and re-registered on each window
    const mod = await import(pathToFileURL(path.join(PANEL, "estate_map.js")).href + `?r=${renders++}`);
    void mod;
    window.eval(fs.readFileSync(path.join(FRAMEWORK, "alpine.min.js"), "utf8"));
    // Alpine starts on DOMContentLoaded, which jsdom has already fired by now
    if (window.Alpine?.started !== true) window.Alpine.start();
    // Wait for the panel to have ANSWERED rather than for an arbitrary number of milliseconds:
    // init() awaits a fetch, and a test that gave up early would be asserting against "Reading the
    // estate map…" and reporting a missing notice that is merely a notice that has not arrived.
    // Wait for the panel to have ANSWERED rather than for a number of milliseconds: init() awaits
    // a fetch, and a test that gave up early would assert against "Reading the estate map…" and
    // report a missing notice that had simply not arrived. The states are x-if, so the loading line
    // is REMOVED rather than hidden when it is over.
    await until(() => !window.document.querySelector(".em__loading"));
  } finally {
    globalThis.window = saved.window;
    globalThis.fetch = saved.fetch;
    globalThis.setInterval = saved.setInterval;
  }
  return { window, document: window.document, dom };
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
async function openTab(window, name) {
  const tabs = [...window.document.querySelectorAll(".em__tab")];
  const tab = tabs.find((t) => t.textContent.trim() === name);
  if (!tab) throw new Error(`no ${name} tab: the panel offers ${tabs.map((t) => t.textContent.trim()).join(", ")}`);
  tab.click();
  // the panes are x-if, so the new one has to EXIST before anything is asserted about it
  const pane = { estate: ".em__cards", storage: ".em__storage", applications: ".em__apps", media: ".em__media" }[name];
  await until(() => tab.dataset.on === "true" && window.document.querySelector(pane));
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
function hiddenBy(el, win) {
  if (el.hasAttribute("hidden")) return "the hidden attribute";
  const cs = win.getComputedStyle(el);
  if (cs.display === "none") return "display:none";
  if (cs.visibility === "hidden" || cs.visibility === "collapse") return `visibility:${cs.visibility}`;
  if (cs.opacity !== "" && Number(cs.opacity) === 0) return "opacity:0";
  if (/^0(px)?$/u.test(cs.fontSize ?? "")) return "font-size:0";
  // parked off-screen: the classic way to keep an element "present" and unreadable
  for (const side of ["left", "top"]) {
    const v = Number.parseFloat(cs[side] ?? "");
    if (Number.isFinite(v) && v <= -1000) return `${side}:${cs[side]}`;
  }
  if (/^0(px)?$/u.test(cs.width ?? "") && /^0(px)?$/u.test(cs.height ?? "")) return "a 0x0 box";
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
  assert.match(visible(window), /40 files withheld/u);
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
  assert.match(text, /no volume to draw/u, "and the node whose bytes cannot be drawn is named");
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
  const card = [...window.document.querySelectorAll(".em__withheld")].find((p) => /40 files withheld/u.test(p.textContent));
  assert.ok(card && isVisible(card, window), "the withheld count is visible on the card");
  await openTab(window, "storage");
  const recon = window.document.querySelector(".em__recon");
  assert.ok(recon && isVisible(recon, window), "the reconciliation is visible");
  assert.match(visible(window), /no volume to draw/u, "and the node whose bytes cannot be drawn is named");
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
