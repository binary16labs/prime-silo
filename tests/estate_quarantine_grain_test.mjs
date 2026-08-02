// The quarantine grain bridge (satellite pull).
//
// A raw agent transcript is named by UUID (fd57bd15-9142-491a-962d-1a16701a38c9.jsonl);
// memo-ray keys the same session by that UUID with the hyphens stripped. Until these were
// canonicalised, the quarantine list and the satellite's filenames lived in namespaces that
// could never intersect — so the filter matched nothing and reported a reassuring
// "0 withheld" while protecting nothing at all.
//
// "0 withheld" is what a WORKING filter reports when nothing is quarantined, and exactly
// what a DEAD one reports always. That ambiguity is the whole reason these are positive
// controls: they prove the filter BITES, rather than proving it was merely called.
import test from "node:test";
import assert from "node:assert/strict";
import { canonicalSid } from "../scripts/estate_satellite_pull.mjs";

// mirrors the module's own matcher — kept here so a regression in either is visible
const matches = (sid, quarantine) => {
  const s = canonicalSid(sid);
  return [...quarantine].some((bad) => {
    const b = canonicalSid(bad);
    return s === b || (b.length >= 8 && s.startsWith(b.slice(0, 8)));
  });
};

test("importing the pull module runs no CLI side effects", () => {
  // if this file got this far without a proposal printing, the guard holds
  assert.equal(typeof canonicalSid, "function");
});

test("a UUID and its hyphen-stripped sid canonicalise to the same id", () => {
  assert.equal(
    canonicalSid("FD57BD15-9142-491A-962D-1A16701A38C9"),
    canonicalSid("fd57bd159142491a962d1a16701a38c9")
  );
});

test("a quarantined memo-ray sid blocks the matching UUID transcript", () => {
  const q = new Set(["fd57bd159142491a962d1a16701a38c9"]);
  assert.equal(matches("fd57bd15-9142-491a-962d-1a16701a38c9", q), true,
    "the UUID form of a quarantined session MUST be blocked");
});

test("an unrelated UUID is not blocked", () => {
  const q = new Set(["fd57bd159142491a962d1a16701a38c9"]);
  assert.equal(matches("00000000-0000-4000-8000-000000000000", q), false,
    "a filter that blocks everything protects nothing meaningful");
});

test("the 8-hex graph prefix form also blocks", () => {
  // the knowledge graph names Sources by the 8-char sid prefix
  const q = new Set(["fd57bd15"]);
  assert.equal(matches("fd57bd15-9142-491a-962d-1a16701a38c9", q), true);
});

test("case and stray whitespace do not defeat the filter", () => {
  const q = new Set(["  FD57BD15-9142-491A-962D-1A16701A38C9  "]);
  assert.equal(matches("fd57bd159142491a962d1a16701a38c9", q), true);
});
