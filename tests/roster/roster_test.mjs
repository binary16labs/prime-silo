// P0 acceptance — rosters are declarative and fail closed.
// Scenarios ↔ delivery/tasks/P0.md gherkin. The validator is pure, so these need no fixtures on disk.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PERSONAS,
  resolveSubject,
  rubricHash,
  validateRoster
} from "../../server/coordination/lib/roster.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A minimal valid roster; each test bends exactly one thing. */
const ok = () => ({
  kind: "model_roster",
  models: [
    { label: "big", id: "vendor/big", tier: ["planner", "architect", "implementer", "reviewer"] },
    { label: "small", id: "vendor/small", tier: ["reviewer"] }
  ],
  subjects: [{ label: "incumbent", assign: { "*": "big" } }],
  judge: { model: "vendor/judge" },
  primary_metric: "tool_selection_accuracy"
});

// --- Scenario 1 -------------------------------------------------------------
test("Scenario: an out-of-tier assignment is rejected", () => {
  const r = ok();
  r.subjects = [{ label: "s", assign: { implementer: "small", planner: "big", architect: "big", reviewer: "big" } }];
  const v = validateRoster(r);
  assert.equal(v.ok, false);
  assert.ok(
    v.errors.some((e) => e.includes("small") && e.includes("implementer")),
    `the refusal must name the persona AND the model, got: ${v.errors.join("; ")}`
  );
});

test("a wildcard must satisfy EVERY persona it expands to, not just one", () => {
  const r = ok();
  r.subjects = [{ label: "s", assign: { "*": "small" } }]; // small is reviewer-only
  const v = validateRoster(r);
  assert.equal(v.ok, false, "a wildcard is a hole in tiering unless every target is checked");
  assert.ok(v.errors.some((e) => e.includes("implementer")));
});

// --- Scenario 2 -------------------------------------------------------------
test("Scenario: self-judging is refused", () => {
  const r = ok();
  r.judge = { model: "vendor/big" }; // same id as a model under test
  const v = validateRoster(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /self-judging/.test(e)));
});

test("self-judging is caught on id, not label — relabelling the same weights does not evade it", () => {
  const r = ok();
  r.models.push({ label: "disguised", id: "vendor/judge", tier: ["reviewer"] });
  const v = validateRoster(r);
  assert.equal(v.ok, false, "the same id under a second label is still the judge competing");
});

// --- unknown references ----------------------------------------------------
test("an unknown model label is rejected", () => {
  const r = ok();
  r.subjects = [{ label: "s", assign: { "*": "ghost" } }];
  assert.equal(validateRoster(r).ok, false);
});

test("an unknown persona is rejected", () => {
  const r = ok();
  r.subjects = [{ label: "s", assign: { "*": "big", sorcerer: "big" } }];
  const v = validateRoster(r);
  assert.ok(v.errors.some((e) => e.includes("sorcerer")));
});

test("a subject leaving a persona unassigned is rejected, not silently defaulted", () => {
  const r = ok();
  r.subjects = [{ label: "s", assign: { implementer: "big" } }];
  const v = validateRoster(r);
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /unassigned/.test(e)), "a hole would fall back to the registry default");
});

// --- rubric freeze (R10) ---------------------------------------------------
test("a rubric-hash mismatch invalidates the roster", () => {
  const r = ok();
  r.rubric_hash = rubricHash("the rubric as frozen");
  assert.equal(validateRoster(r, { rubricText: "the rubric as frozen" }).ok, true);
  const v = validateRoster(r, { rubricText: "the rubric, quietly edited after seeing results" });
  assert.equal(v.ok, false);
  assert.ok(v.errors.some((e) => /rubric_hash mismatch/.test(e)));
});

test("rubricHash is deterministic and order-sensitive", () => {
  assert.equal(rubricHash("abc"), rubricHash("abc"));
  assert.notEqual(rubricHash("abc"), rubricHash("acb"));
});

// --- misc rules ------------------------------------------------------------
test("a missing primary_metric is rejected — ranking would otherwise be ad hoc", () => {
  const r = ok();
  delete r.primary_metric;
  assert.ok(validateRoster(r).errors.some((e) => /primary_metric/.test(e)));
});

test("duplicate model labels are rejected", () => {
  const r = ok();
  r.models.push({ label: "big", id: "vendor/other", tier: ["reviewer"] });
  assert.ok(validateRoster(r).errors.some((e) => /duplicate/.test(e)));
});

test("every error is reported, not just the first", () => {
  const v = validateRoster({ kind: "wrong", models: [], subjects: [] });
  assert.ok(v.errors.length >= 3, `expected several errors, got: ${v.errors.join("; ")}`);
});

test("resolveSubject expands the wildcard across the non-judge personas", () => {
  const r = resolveSubject({ assign: { "*": "big", reviewer: "small" } });
  assert.equal(r.implementer, "big");
  assert.equal(r.reviewer, "small", "an explicit persona overrides the wildcard");
  assert.equal(Object.keys(r).length, PERSONAS.length - 1, "judge is not a subject persona");
});

// --- the shipped template --------------------------------------------------
test("the shipped template validates against its own validator", () => {
  const t = JSON.parse(
    fs.readFileSync(path.join(ROOT, "runtime/manifests/templates/model_roster.json"), "utf8")
  );
  const v = validateRoster(t);
  assert.equal(v.ok, true, `template invalid: ${v.errors.join("; ")}`);
});
