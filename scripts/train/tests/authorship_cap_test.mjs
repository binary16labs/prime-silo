// L11 acceptance — model-collapse guard (verifier gate + house-fraction cap).
// Scenarios ↔ delivery/tasks/L11.md gherkin. Pure lib; no corpus/network. Run: node --test.
import test from "node:test";
import assert from "node:assert/strict";
import {
  HOUSE,
  verifierGate,
  applyAuthorshipCap,
  guardHouseRows
} from "../lib/authorship_cap.mjs";

// row helper: authorship + a sid, like a built dataset row.
const row = (id, authorship, sid) => ({ id, authorship, source: { sid } });

// ---------------------------------------------------------------------------
test("Scenario: unverified house output is not trained on", () => {
  const rows = [row("h1", HOUSE, "sessA"), row("hum1", "human", "sessH")];
  const { kept } = verifierGate(rows, { verifiedSids: new Set() }); // no passes recorded
  assert.deepEqual(kept.map((r) => r.id), ["hum1"]); // the unverified house row contributes nothing
});

test("Scenario: verified house method is admitted", () => {
  const rows = [row("h1", HOUSE, "sessA"), row("h2", HOUSE, "sessB")];
  const { kept } = verifierGate(rows, { verifiedSids: new Set(["sessA"]) }); // sessA passed the verifier
  assert.deepEqual(kept.map((r) => r.id), ["h1"]); // only the verified house session is admitted
});

test("Scenario: house-origin rows are fraction-capped; human/frontier uncapped", () => {
  // 10 house rows (all verified) + 4 human + 2 frontier; cap house to 30% of the final total.
  const rows = [
    ...Array.from({ length: 10 }, (_, i) => row(`h${i}`, HOUSE, `s${i}`)),
    ...Array.from({ length: 4 }, (_, i) => row(`hum${i}`, "human", `sh${i}`)),
    ...Array.from({ length: 2 }, (_, i) => row(`fr${i}`, "frontier", `sf${i}`))
  ];
  const { kept, capped } = applyAuthorshipCap(rows, { capFraction: 0.3 });
  const keptHouse = kept.filter((r) => r.authorship === HOUSE);
  const keptOther = kept.filter((r) => r.authorship !== HOUSE);
  // all 6 human/frontier rows survive (never capped)...
  assert.equal(keptOther.length, 6);
  // ...and house is bounded to ≤ 30% of the final total.
  assert.ok(keptHouse.length / kept.length <= 0.3 + 1e-9, `house fraction ${keptHouse.length}/${kept.length}`);
  assert.ok(keptHouse.length < 10, "house was actually down-sampled");
  assert.equal(capped, 10 - keptHouse.length);
});

test("Scenario: the cap is deterministic (rebuildable) — same input, same survivors", () => {
  const rows = Array.from({ length: 20 }, (_, i) => row(`h${i}`, HOUSE, `s${i}`));
  const a = applyAuthorshipCap(rows, { maxHouseRows: 5 }).kept.map((r) => r.id);
  const b = applyAuthorshipCap(rows, { maxHouseRows: 5 }).kept.map((r) => r.id);
  assert.deepEqual(a, b);
  assert.equal(a.length, 5);
});

test("provenance: human/frontier rows are never capped even when they dominate", () => {
  const rows = [
    ...Array.from({ length: 100 }, (_, i) => row(`hum${i}`, "human", `s${i}`)),
    row("h1", HOUSE, "sx")
  ];
  const { kept } = applyAuthorshipCap(rows, { maxHouseRows: 0 }); // even cap 0 only bounds house
  assert.equal(kept.filter((r) => r.authorship === "human").length, 100);
  assert.equal(kept.filter((r) => r.authorship === HOUSE).length, 0);
});

test("guardHouseRows: gate THEN cap, reported together", () => {
  const rows = [
    row("h1", HOUSE, "sA"), // verified
    row("h2", HOUSE, "sB"), // verified
    row("h3", HOUSE, "sC"), // UNVERIFIED → excluded by the gate before the cap
    row("hum1", "human", "sh")
  ];
  const g = guardHouseRows(rows, { verifiedSids: new Set(["sA", "sB"]), maxHouseRows: 1 });
  assert.equal(g.excluded_unverified, 1); // h3 gated out
  assert.equal(g.capped, 1); // of the 2 verified house rows, 1 capped
  assert.equal(g.kept.filter((r) => r.authorship === HOUSE).length, 1);
  assert.equal(g.kept.filter((r) => r.authorship === "human").length, 1); // human untouched
});

test("no cap config = pass-through (additive/no-op on an untagged corpus)", () => {
  const rows = [row("a", "human", "s1"), row("b", "human", "s2")];
  const { kept, capped } = applyAuthorshipCap(rows, {}); // no maxHouseRows, no capFraction
  assert.equal(kept.length, 2);
  assert.equal(capped, 0);
});
