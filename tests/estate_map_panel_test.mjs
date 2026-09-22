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
  storageItems,
  treemap,
  versionDrift
} from "../app/L0/_all/mod/_prime_silo/estate_map/fold_view.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PANEL = path.join(ROOT, "app/L0/_all/mod/_prime_silo/estate_map");
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

test("storage sizes are split by file share and labelled as the estimate they are", () => {
  // the map reports bytes per MACHINE and rows per VOLUME, so a per-volume size is derived, and
  // the panel must not present a derived number as a measured one
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
  const { items, estimated, unsized } = storageItems(fold);
  assert.equal(estimated, true, "the panel is told this is derived");
  assert.deepEqual(items.map((i) => [i.volume, i.value]), [["C:\\", 2000], ["F:\\", 1000]]);
  assert.deepEqual(unsized, []);
});

test("a machine that reported no bytes is listed, not drawn as nothing", () => {
  const fold = {
    machines: {
      pi: machine({
        counts: { files: 5, bytes: 0, listed_files: 5, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
        volumes: { "/": { collector: "walker", status: "ok", rows: 5, at: T(10) } }
      })
    }
  };
  const { items, unsized } = storageItems(fold);
  assert.deepEqual(items, []);
  assert.equal(unsized.length, 1, "it appears beside the map instead of vanishing from it");
  assert.equal(unsized[0].volume, "/");
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
  assert.ok(v.storage.items.length > 0);
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
