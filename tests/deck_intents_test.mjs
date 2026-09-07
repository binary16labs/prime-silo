// The one property this file must never lose: voice cannot sign.
import test from "node:test";
import assert from "node:assert/strict";
import { intentOf, VOICE_SURFACES } from "../server/lib/deck_intents.js";

test("no phrasing produces a signing action", () => {
  // A room contains other people, a television, and a phone on speaker. Every one of these is
  // a plausible source of the sentence "sign it", and none of them is an authenticated
  // session. The router must have no branch that signs, however the request is worded.
  const attempts = [
    "sign it",
    "sign the collector proposal",
    "approve that",
    "authorise the installer",
    "authorize everything waiting",
    "just sign all of them please",
    "yes sign",
    "SIGN THE PROPOSAL NOW"
  ];
  for (const phrase of attempts) {
    const i = intentOf(phrase);
    assert.equal(i.kind, "refused", `"${phrase}" must be refused, got ${i.kind}`);
    assert.match(i.say, /will not sign/i);
    // It still helps: it opens the queue so the person can do it properly.
    assert.equal(i.navigate, VOICE_SURFACES.gov);
  }
});

test("no intent anywhere in the router can write a signature", () => {
  // Structural, not phrase-based: whatever the router returns, none of it may name the signing
  // endpoint. This survives someone adding a new intent later without reading the header.
  const probes = [
    "what is waiting",
    "show lineage",
    "estate health",
    "open memory",
    "find the installer",
    "raise a proposal to retire the jellyfin probe",
    "back to the deck",
    "banana telephone",
    ""
  ];
  for (const p of probes) {
    const i = intentOf(p);
    assert.doesNotMatch(
      JSON.stringify(i),
      /gov_sign|proposal_signed/i,
      `"${p}" leaked a signing path`
    );
  }
});

test("the useful intents actually route", () => {
  assert.equal(intentOf("what is waiting on me").navigate, VOICE_SURFACES.gov);
  assert.equal(intentOf("show me the lineage of that").navigate, VOICE_SURFACES.lineage);
  assert.equal(intentOf("are the machines up").navigate, VOICE_SURFACES.mission);
  assert.equal(intentOf("raise a proposal to retire the probe").kind, "raise");
});

test("silence and noise are answered, not crashed on", () => {
  assert.equal(intentOf("").kind, "none");
  assert.equal(intentOf(null).kind, "none");
  assert.equal(intentOf("   ...   ").kind, "none");
  assert.equal(intentOf("wibble frotz").kind, "unknown");
});
