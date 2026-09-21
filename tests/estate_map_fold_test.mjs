// S3 — nodes push their map, the hub folds one estate map.
// Every Scenario in delivery/tasks/S3.md maps to a test here, plus the rules that keep the widened
// register surface honest: only counts and hashes cross, and a node that goes quiet is never empty.
import assert from "node:assert/strict";
import http from "node:http";
import test from "node:test";

import {
  DEFAULT_MAP_MAX_AGE_MS,
  buildMapPayload,
  foldEstateMap,
  isNewer,
  machineView,
  mapPayloadProblem,
  parseQuarantinePolicy,
  withMap,
  readQuarantinePolicy
} from "../server/coordination/lib/estate_map_fold.mjs";
import { register } from "../server/coordination/lib/estate_register.mjs";
import { createEstateApi } from "../server/coordination/lib/estate_api.mjs";

const T = (h, m = 0) => `2026-09-21T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00.000Z`;

const push = (machine, at, over = {}) => ({
  machine,
  sweep_id: over.sweep_id ?? "01M31Y102Z4631D8992T33C1FW",
  finished_at: at,
  scope: over.scope ?? ["C:\\", "F:\\"],
  collectors: over.collectors ?? [
    { name: "everything", kind: "files", volume: "C:\\", status: "ok", rows: 2_214_964 },
    { name: "everything", kind: "files", volume: "F:\\", status: "ok", rows: 1_117_036 },
    { name: "registry", kind: "apps", volume: null, status: "ok", rows: 65 }
  ],
  counts: over.counts ?? {
    files: 3_331_000, bytes: 1_449_800_000_000, listed_files: 3_331_000,
    apps: 1073, listed_apps: 1073, media: 0, listed_media: 0
  },
  // deliberately NOT in size order: the biggest category must be found by ranking, not by position
  totals: over.totals ?? [
    { kind: "files", collector: "everything", volume: "C:\\", category: "code", items: 900, bytes: 100 },
    { kind: "files", collector: "everything", volume: "F:\\", category: "media", items: 400, bytes: 900 }
  ],
  digest: over.digest ?? "a".repeat(64),
  snapshot: over.snapshot ?? `sha256:${"b".repeat(64)}`
});

// --- Scenario: a node that stops pushing is stale, not empty ---------------------------------------

test("a node that stops pushing is stale since, not empty", () => {
  const fold = foldEstateMap([push("optimus", T(10))], {
    now: Date.parse(T(11)),
    maxAgeMs: 30 * 60_000
  });
  const m = fold.machines.optimus;
  assert.equal(m.stale, true);
  assert.equal(m.since, T(10), "stale SINCE the last thing it said");
  assert.equal(m.ageMs, 3_600_000);
  assert.deepEqual(Object.keys(m.volumes), ["C:\\", "F:\\"], "and its volumes are still shown");
  assert.equal(m.volumes["C:\\"].rows, 2_214_964, "with what it last reported");
  assert.equal(m.counts.apps, 1073);
});

test("a node inside the threshold is not stale and has no since", () => {
  const fold = foldEstateMap([push("t480", T(10, 45))], {
    now: Date.parse(T(11)),
    maxAgeMs: 30 * 60_000
  });
  assert.equal(fold.machines.t480.stale, false);
  assert.equal(fold.machines.t480.since, null);
});

// --- Scenario: a late older sweep does not overwrite a newer one -----------------------------------

test("a delayed older sweep never overwrites a newer one", () => {
  const noon = push("t480", T(12), { sweep_id: "01M31Y102Z4631D8992T33C1FW", digest: "c".repeat(64) });
  const eleven = push("t480", T(11), {
    sweep_id: "01M31Y102Z4631D8992T33C1FV",
    digest: "d".repeat(64),
    collectors: [
      { name: "walker", kind: "files", volume: "F:\\", status: "ok", rows: 7 }
    ]
  });
  for (const order of [[noon, eleven], [eleven, noon]]) {
    const m = foldEstateMap(order, { now: Date.parse(T(12, 1)) }).machines.t480;
    assert.equal(m.at, T(12), `the 12:00 sweep wins, arriving ${order[0] === noon ? "first" : "second"}`);
    assert.equal(m.digest, "c".repeat(64));
    assert.equal(m.volumes["F:\\"].rows, 1_117_036, "F: reflects the 12:00 sweep");
    assert.equal(m.volumes["F:\\"].collector, "everything");
  }
});

test("an older sweep still fills a volume the newer one never covered", () => {
  // the newer sweep only swept C:, so the hub's knowledge of D: is old — but it is knowledge
  const newer = push("t480", T(12), {
    scope: ["C:\\"],
    collectors: [{ name: "everything", kind: "files", volume: "C:\\", status: "ok", rows: 10 }]
  });
  const older = push("t480", T(11), {
    sweep_id: "01M31Y102Z4631D8992T33C1FV",
    collectors: [{ name: "walker", kind: "files", volume: "D:\\", status: "ok", rows: 4 }]
  });
  const m = foldEstateMap([newer, older], { now: Date.parse(T(12, 1)) }).machines.t480;
  assert.equal(m.volumes["C:\\"].rows, 10);
  assert.equal(m.volumes["D:\\"].rows, 4, "a drive the newer sweep did not cover is not forgotten");
  assert.equal(m.volumes["D:\\"].at, T(11), "and says how old it is");
});

test("two sweeps in the same millisecond fold the same whichever arrives first", () => {
  const a = push("t480", T(12), { sweep_id: "01AAAAAAAAAAAAAAAAAAAAAAAA", digest: "1".repeat(64) });
  const b = push("t480", T(12), { sweep_id: "01BBBBBBBBBBBBBBBBBBBBBBBB", digest: "2".repeat(64) });
  const one = foldEstateMap([a, b], { now: Date.parse(T(12)) }).machines.t480;
  const two = foldEstateMap([b, a], { now: Date.parse(T(12)) }).machines.t480;
  assert.deepEqual(one, two, "network ordering cannot change the map");
  assert.equal(one.sweep_id, "01BBBBBBBBBBBBBBBBBBBBBBBB");
  assert.equal(isNewer(a, b), false);
  assert.equal(isNewer(b, a), true);
});

// --- Scenario: content cannot ride the register ----------------------------------------------------

const ctx = (over = {}) => ({
  key: "k",
  expectedKey: "k",
  remoteAddress: "192.168.0.108",
  hubHashes: [],
  // an EXPLICIT empty policy: the hub has been told what is private and the answer is "nothing".
  // Leaving this out is a hub with no policy at all, which refuses maps — see the test below.
  quarantine: [],
  ...over
});

test("a map payload carrying a file body is rejected and records nothing", () => {
  const bad = push("t480", T(12));
  bad.files = [{ path: "C:\\Users\\nsdha\\cv.docx", content: "…" }];
  const r = register({ satellites: {}, maps: [] }, { machine: "t480", map: bad }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /unknown field: files/u);
  assert.deepEqual(r.state.maps, [], "nothing recorded");
  assert.deepEqual(r.state.satellites, {}, "and no last-seen either — the whole push is refused");
});

test("any field the allowlist does not name is refused, whatever it is called", () => {
  for (const field of ["paths", "body", "text", "notes", "extra", "__proto__x"]) {
    const bad = push("t480", T(12));
    bad[field] = "C:\\Users\\nsdha\\Documents\\salary.pdf";
    assert.match(
      mapPayloadProblem(bad) ?? "",
      new RegExp(`unknown field: ${field}`, "u"),
      `${field} must not ride the register`
    );
  }
});

test("a volume name is bounded, so a path cannot hide in one", () => {
  // the one path-shaped string allowed through is the volume a sweep ran on. Unbounded, it is a
  // place to put anything — a whole directory listing, or a file's bytes.
  const long = push("t480", T(12), { scope: ["F:\\" + "a".repeat(300)] });
  assert.match(mapPayloadProblem(long), /scope contains a volume name/u);
  const smuggled = push("t480", T(12), {
    collectors: [
      { name: "walker", kind: "files", volume: "C:\\" + "x".repeat(500), status: "ok", rows: 1 }
    ]
  });
  assert.match(mapPayloadProblem(smuggled), /collector names a volume name/u);
  const empty = push("t480", T(12), { scope: [""] });
  assert.match(mapPayloadProblem(empty), /scope contains a volume name/u);
  const notText = push("t480", T(12), { scope: [{ path: "C:\\secret" }] });
  assert.match(mapPayloadProblem(notText), /scope contains a volume name/u);
});

test("a hub with no privacy policy accepts no map", () => {
  // D2: the rules were never wired in the product, so every quarantine branch was dead code while
  // the comment claimed otherwise. Wiring alone would not hold — a forgotten policy file puts the
  // guard straight back to inert. So no policy means no map. An empty list IS a policy.
  const manifest = { machine: "t480", sessions: [], map: push("t480", T(12)) };
  for (const quarantine of [undefined, null, "cv", { rules: [] }]) {
    const r = register({ satellites: {}, maps: [] }, manifest, ctx({ quarantine }));
    assert.equal(r.ok, false, `a ${typeof quarantine} policy is not a policy`);
    assert.match(r.reason, /no quarantine policy/u);
    assert.deepEqual(r.state.maps, [], "and nothing is recorded");
  }
  assert.equal(register({ maps: [] }, manifest, ctx({ quarantine: [] })).ok, true, "an empty list is");
});

test("an unusable policy file is no policy, never an empty one", () => {
  // W10: a mutation turning a malformed policy into an EMPTY policy survived, because the parsing
  // lived in app.js where only the gate could reach it as text. It lives in the library now.
  for (const raw of ["{", "", "null", "[]", '{"rules": "cv"}', '{"rules": null}', '{"other": []}'])
    assert.equal(parseQuarantinePolicy(raw), null, JSON.stringify(raw));
  assert.deepEqual(parseQuarantinePolicy('{"rules": []}'), [], "an empty list IS a policy");
  const rules = parseQuarantinePolicy('{"rules": ["cv", "/payroll/i"]}');
  assert.equal(rules[0], "cv");
  assert.ok(rules[1] instanceof RegExp);
  assert.equal(rules[1].test("PAYROLL"), true, "and a /…/i rule is a real case-insensitive regexp");
});

test("a policy file that cannot be used says so out loud", () => {
  // The map surface closes either way, but silence would look exactly like a hub that was never
  // given a policy and the operator would have no way to tell the two apart. A gate assertion over
  // app.js's text could never prove this — a mutation keeping the log line and disabling its branch
  // survives any such check — so the reader lives in the library with its io injected.
  const said = [];
  const io = (text) => ({ readFile: () => text, warn: (m) => said.push(m) });

  assert.deepEqual(readQuarantinePolicy("q.json", io('{"rules": ["cv"]}')), ["cv"]);
  assert.deepEqual(said, [], "a usable policy says nothing");

  assert.equal(readQuarantinePolicy("q.json", io("{ not json")), null);
  assert.equal(said.length, 1, "an unusable one warns");
  assert.match(said[0], /q\.json/u);
  assert.match(said[0], /maps refused/u);

  said.length = 0;
  const absent = readQuarantinePolicy("q.json", {
    readFile: () => {
      throw new Error("ENOENT");
    },
    warn: (m) => said.push(m)
  });
  assert.equal(absent, null, "an absent policy is also no policy");
  assert.deepEqual(said, [], "but it is not an error worth shouting about");
});

test("the library brings no policy of its own, and one named staleness threshold", async (t) => {
  // W9: if createEstateApi defaulted quarantine to [] the fail-closed rule would quietly vanish.
  const port = await serve(t, { registerKey: "k" });
  const pushed = await call(port, "/api/estate/register", {
    key: "k",
    manifest: { machine: "t480", map: push("t480", new Date().toISOString()) }
  });
  assert.equal(pushed.status, 401, "an API built without a policy refuses maps");
  assert.match(pushed.body.reason, /no quarantine policy/u);
  // W13: the threshold the plan's only S3 criterion rests on was a literal nobody asserted
  assert.equal(DEFAULT_MAP_MAX_AGE_MS, 30 * 60 * 1000);
});

test("a hub with no policy still registers sessions", () => {
  // N7 is untouched by the map's stricter rule: a hub that cannot accept a map is not a hub that
  // has stopped working.
  const r = register(
    { satellites: {}, maps: [] },
    { machine: "t480", sessions: [{ sid: "s1", contentHash: "h" }] },
    ctx({ quarantine: undefined })
  );
  assert.equal(r.ok, true);
  assert.equal(r.state.satellites.t480.sessionCount, 1);
});

test("a volume must look like a volume, not merely be short", () => {
  // Two verifiers found this guard claiming more than it did. D1: with only a length rule, a real
  // 45-character file path was accepted and served back. E1: with a denylist plus a "looks like a
  // file" test on the LAST segment, a single trailing space made "contract.pdf " a different string
  // and the same file to Windows. A denylist of disguises loses to the next disguise, so segments
  // are now allowlisted and every segment is judged.
  const refused = {
    "a real file path": "F:\\clients\\Acme\\contract-final-signed.pdf",
    "the same path with a trailing space": "F:\\clients\\contract-final-signed.pdf ",
    "a trailing dot": "F:\\clients\\contract-final-signed.pdf.",
    "a trailing non-breaking space": "F:\\clients\\contract-final-signed.pdf\u00a0",
    "an extension longer than eight": "F:\\clients\\notes.longextension",
    "a file name in a middle segment": "F:\\salary-2026.docx\\q1",
    "a real file on a real server": "\\\\fs01\\hr\\2026\\salaries-2026.xlsx ",
    "U+2216 carrying a path inside a segment": "F:\\clients\u2216Acme\u2216contract.pdf",
    "U+FE68 the same way": "F:\\clients\ufe68Acme",
    "U+29F9 the same way": "F:\\clients\u29f9Acme",
    "prose": "MEMO: acquisition price 4.2m GBP and the buyer walked away",
    "three segments deep": "F:\\a\\b\\c",
    "a NUL": "F:\\a\u0000b",
    "a newline": "F:\\a\nb",
    "a data URI": "data:text/plain;base64,SGVsbG8=",
    "a fullwidth separator": "F:\uff3csecret",
    "percent-encoding": "F:\\a%5Cb",
    "a \\\\?\\ prefix": "\\\\?\\C:\\x",
    "a \\\\?\\UNC prefix": "\\\\?\\UNC\\fs01\\hr",
    "forward slashes": "F:/clients/Acme",
    "a dot anywhere in a segment": "F:\\vol.1",
    "a leading space": "F: leading",
    // no dot at all, so only the segment's own shape can refuse these
    "a trailing space on a plain name": "F:\\Backup Drive ",
    "a trailing dot on a plain name": "F:\\Backup Drive.",
    "a UNC host with a space": "\\\\NA S\\backups",
    "a UNC host carrying a separator": "\\\\NAS\u2216evil\\backups",
    "a UNC host of dots": "\\\\..\\backups",
    "a 65-character segment": `F:\\${"a".repeat(65)}`,
    "two legal segments over the length bound": `F:\\${"a".repeat(60)}\\${"b".repeat(60)}`,
    "an empty segment": "F:\\\\x",
    "something that is not text": { path: "C:\\secret" },
    "nothing at all": ""
  };
  for (const [what, value] of Object.entries(refused))
    assert.match(
      mapPayloadProblem(push("t480", T(12), { scope: [value] })) ?? "",
      /scope contains a volume name/u,
      `must not be called a volume: ${what}`
    );

  // and every spelling a real volume on this estate actually takes
  for (const v of [
    "F:\\",
    "F:",
    "F:\\mnt\\vol",
    "F:\\Backup Drive",
    "F:\\data_store-2",
    "\\\\NAS\\backups",
    "\\\\NAS\\private$",
    "\\\\NAS\\backups\\vol"
  ])
    assert.equal(mapPayloadProblem(push("t480", T(12), { scope: [v] })), null, v);
});

test("a map a node cannot send does not cost it its sessions", () => {
  // F3: the agent used to abort its WHOLE announce when its own map was refused, so a bad payload
  // took the session manifest down with it — the opposite of the rule the hub keeps on its side.
  // The decision lives in the library now, because a decision inside a script with top-level side
  // effects can only be asserted about as text, and text assertions are what this contract's
  // findings were all made of.
  const manifest = { machine: "t480", at: 1, sessions: [{ sid: "s1", contentHash: "h" }] };
  const bad = push("t480", T(12), { scope: ["F:\\clients\\Acme\\contract.pdf"] });
  const refused = withMap(manifest, bad);
  assert.equal(refused.manifest, manifest, "the manifest is untouched");
  assert.ok(!("map" in refused.manifest), "no map rides along");
  assert.equal(refused.manifest.sessions.length, 1, "and the sessions are still there to register");
  assert.match(refused.problem, /volume name/u, "with the reason reported");

  const good = withMap(manifest, push("t480", T(12)));
  assert.equal(good.problem, null);
  assert.deepEqual(good.manifest.sessions, manifest.sessions);
  assert.ok(good.manifest.map, "a sendable map is attached");

  const none = withMap(manifest, null);
  assert.equal(none.problem, null, "no map at all is not a problem");
  assert.equal(none.manifest, manifest);

  // and the node judges with the hub's rules when it is given them
  assert.match(withMap(manifest, push("t480", T(12)), [/^F:/u]).problem ?? "", /quarantined/u);
});

test("the segment allowlist admits the characters it names, and only those", () => {
  // F2 of the third verification: /iu/ folds U+017F to s and U+212A to k, so a rule whose comment
  // said "ASCII only" took two characters that are not. No path could hide in them, but they would
  // give one volume two keys, and a hub rule written as the string "users" would miss one of them.
  for (const v of ["F:\\u\u017Fers", "F:\\\u212Aelvin", "F:\\\u017F", "\\\\NA\u017F\\backups"])
    assert.match(
      mapPayloadProblem(push("t480", T(12), { scope: [v] })) ?? "",
      /volume name/u,
      `must not be admitted: ${JSON.stringify(v)}`
    );
  // the ASCII spellings they fold to are of course fine
  for (const v of ["F:\\users", "F:\\Kelvin", "\\\\NAS\\backups"])
    assert.equal(mapPayloadProblem(push("t480", T(12), { scope: [v] })), null, v);
});

test("what the volume rule does NOT promise is written down", () => {
  // A folder-mounted volume and an ordinary folder are the same shape, so this name is well formed
  // and only the hub's quarantine rules can refuse it. The comment says so; this pins it, so nobody
  // later reads the guard as broader than it is — which is the fault both FAILs were about.
  assert.equal(mapPayloadProblem(push("t480", T(12), { scope: ["F:\\Users\\id_rsa"] })), null);
  assert.match(
    mapPayloadProblem(push("t480", T(12), { scope: ["F:\\Users\\id_rsa"] }), [/id_rsa/u]) ?? "",
    /quarantined volume/u,
    "the policy is the layer that refuses it, which is why the map fails closed without one"
  );
});

test("the volume rule binds collectors and totals, not just scope", () => {
  const viaCollector = push("t480", T(12), {
    collectors: [
      { name: "walker", kind: "files", volume: "\\\\NAS\\private$\\hr\\payroll.xlsx", status: "ok", rows: 1 }
    ]
  });
  assert.match(mapPayloadProblem(viaCollector), /collector names a volume name/u);
  const viaTotal = push("t480", T(12), {
    totals: [
      { kind: "files", collector: "walker", volume: "F:\\clients\\Acme\\contract.pdf", category: "docs", items: 1, bytes: 2 }
    ]
  });
  assert.match(mapPayloadProblem(viaTotal), /total names a volume name/u);
});

test("a sweep cannot have finished in the future", () => {
  // D3: a future timestamp wins the fold for ever, never goes stale, and silently discards every
  // real sweep that follows. It is the one bogus value that is also well formed.
  const now = Date.parse(T(12));
  for (const at of ["2099-01-01T00:00:00.000Z", T(13)])
    assert.equal(
      mapPayloadProblem(push("t480", at), [], { now }),
      "map finished in the future",
      at
    );
  assert.equal(mapPayloadProblem(push("t480", T(12)), [], { now }), null, "now is fine");
  // well formed to the regex, meaningless as a time: the shape check cannot catch this one either
  assert.equal(
    mapPayloadProblem(push("t480", "9999-99-99T99:99:99Z"), [], { now }),
    "map field finished_at is not well formed"
  );
  assert.equal(
    mapPayloadProblem(push("t480", new Date(now + 60_000).toISOString()), [], { now }),
    null,
    "and a minute of clock skew between nodes is normal"
  );
});

test("a payload cannot be made arbitrarily large", () => {
  // 50,000 scope entries of 260 characters travelled as one 13 MB payload and were accepted
  assert.equal(
    mapPayloadProblem(push("t480", T(12), { scope: Array(50_000).fill("F:\\") })),
    "map scope is too long"
  );
  assert.equal(
    mapPayloadProblem(
      push("t480", T(12), {
        collectors: Array(10_000).fill({ name: "w", kind: "files", volume: "F:\\", status: "ok", rows: 1 })
      })
    ),
    "map collectors is too long"
  );
});

test("the shared key must be a string, not merely equal to one", () => {
  // D6: under a loose comparison ["secret"] == "secret", and a caller controls the JSON types
  const manifest = { machine: "t480", map: push("t480", T(12)) };
  for (const key of [["k"], { toString: () => "k" }, 0, null, undefined])
    assert.equal(
      register({ maps: [] }, manifest, ctx({ key })).ok,
      false,
      `a ${typeof key} key must not authenticate`
    );
});

test("a rejection names the field, never the value", () => {
  const bad = push("t480", T(12));
  bad.secrets = "C:\\Users\\nsdha\\Documents\\cv.docx";
  const reason = mapPayloadProblem(bad);
  assert.match(reason, /secrets/u);
  assert.ok(!reason.includes("cv.docx"), "the rejection is not a side channel");
});

test("a volume the HUB calls private cannot be named by a node", () => {
  const p = push("t480", T(12), { scope: ["C:\\", "F:\\clients\\cv-archive"] });
  assert.equal(mapPayloadProblem(p, []), null, "the node's own rules let it through");
  assert.match(mapPayloadProblem(p, [/cv/iu]), /quarantined volume/u, "the hub's rules do not");
  const r = register({ satellites: {}, maps: [] }, { machine: "t480", map: p }, ctx({ quarantine: [/cv/iu] }));
  assert.equal(r.ok, false);
  assert.deepEqual(r.state.maps, []);
});

test("a collector or total naming a quarantined volume is refused too", () => {
  const byCollector = push("t480", T(12), {
    collectors: [{ name: "walker", kind: "files", volume: "F:\\cv-archive", status: "ok", rows: 1 }]
  });
  assert.match(mapPayloadProblem(byCollector, [/cv/iu]), /collector names a quarantined volume/u);
  const byTotal = push("t480", T(12), {
    totals: [{ kind: "files", collector: "walker", volume: "F:\\cv-archive", category: "docs", items: 1, bytes: 2 }]
  });
  assert.match(mapPayloadProblem(byTotal, [/cv/iu]), /total names a quarantined volume/u);
});

test("a map cannot be pushed on another machine's behalf", () => {
  const r = register({ satellites: {}, maps: [] }, { machine: "optimus", map: push("t480", T(12)) }, ctx());
  assert.equal(r.ok, false);
  assert.match(r.reason, /another machine/u);
  assert.deepEqual(r.state.maps, []);
});

test("the existing authentication and LAN gate still guard the map", () => {
  const manifest = { machine: "t480", map: push("t480", T(12)) };
  const unauth = register({ maps: [] }, manifest, ctx({ key: "wrong" }));
  assert.equal(unauth.ok, false);
  assert.equal(unauth.reason, "unauthenticated");
  const wan = register({ maps: [] }, manifest, ctx({ remoteAddress: "203.0.113.9" }));
  assert.equal(wan.ok, false);
  assert.match(wan.reason, /non-LAN/u);
  for (const r of [unauth, wan]) assert.deepEqual(r.state.maps ?? [], []);
});

// --- the shape of what may cross -------------------------------------------------------------------

test("a well-formed map is accepted and kept, not replaced", () => {
  let state = { satellites: {}, maps: [] };
  for (const at of [T(10), T(11), T(12)]) {
    const r = register(state, { machine: "t480", map: push("t480", at) }, ctx());
    assert.equal(r.ok, true, `push at ${at}`);
    state = r.state;
  }
  assert.equal(state.maps.length, 3, "every push is kept; the FOLD decides which sweep wins");
  assert.equal(state.satellites.t480.reachable, true);
});

test("counts must be counts and hashes must be hashes", () => {
  const cases = {
    "map field digest is not well formed": { digest: "not-a-hash" },
    "map field snapshot is not well formed": { snapshot: "file:///C:/Users/nsdha/cv.docx" },
    "map field machine is not well formed": { machine: "../../etc/passwd" },
    "map field sweep_id is not well formed": { sweep_id: "1" }
  };
  for (const [reason, over] of Object.entries(cases)) {
    const p = { ...push("t480", T(12)), ...over };
    assert.equal(mapPayloadProblem(p), reason);
  }
  const negative = push("t480", T(12));
  negative.counts = { ...negative.counts, files: -1 };
  assert.match(mapPayloadProblem(negative), /count files must be a count/u);
  const fractional = push("t480", T(12));
  fractional.collectors = [{ name: "e", kind: "files", volume: "C:\\", status: "ok", rows: 1.5 }];
  assert.match(mapPayloadProblem(fractional), /rows must be a count/u);
});

test("a map missing what the hub needs is refused, not folded half-known", () => {
  for (const key of ["machine", "sweep_id", "finished_at", "digest", "snapshot"]) {
    const p = push("t480", T(12));
    delete p[key];
    assert.equal(mapPayloadProblem(p), `map is missing ${key}`);
  }
});

test("the payload is built by enumerating fields, so a new sweep field cannot start travelling", () => {
  const sweep = {
    machine: "t480",
    id: "01M31Y102Z4631D8992T33C1FW",
    finishedAt: T(12),
    scope: ["C:\\"],
    collectors: [
      { name: "everything", kind: "files", volume: "C:\\", status: "ok", rows: 3, note: "x" },
      // a collector that knows a file path and no volume: the payload must not reach for it
      { name: "walker", kind: "files", status: "ok", rows: 1, path: "C:\\Users\\nsdha\\cv.docx" }
    ],
    counts: { files: 3, bytes: 4, listed_files: 3, apps: 0, listed_apps: 0, media: 0, listed_media: 0 },
    digest: "e".repeat(64),
    // a field somebody adds to the sweep later; it must NOT appear on the wire
    workspacePath: "C:\\Users\\nsdha\\OneDrive\\binary16"
  };
  const payload = buildMapPayload(sweep, { snapshot: `sha256:${"f".repeat(64)}` });
  assert.ok(!("workspacePath" in payload));
  assert.ok(!("note" in payload.collectors[0]));
  assert.equal(payload.collectors[1].volume, null, "a collector's file path is not its volume");
  assert.ok(!JSON.stringify(payload).includes("cv.docx"), "and it is nowhere else either");
  assert.equal(mapPayloadProblem(payload), null, "and what it does build passes the guard");
  assert.equal(payload.counts.listed_media, 0, "every count is present, defaulting to 0");
});

// --- the per-machine view ---------------------------------------------------------------------------

test("the category breakdown is named for what it actually counts: what was withheld", () => {
  // S0 tallies a category ONLY for a row it did NOT list (outside the public roots, or matching a
  // quarantine rule). Serving that as "top categories" would put a real number under a wrong name.
  const fold = foldEstateMap([push("t480", T(12))], { now: Date.parse(T(12)) });
  const view = machineView(fold, "t480", { topCategories: 1 });
  assert.ok(!("categories" in view), "there is no unqualified category list to misread");
  assert.equal(view.withheld.items, 1300, "every withheld row is counted");
  assert.equal(view.withheld.categories.length, 1, "ranked, so the biggest is first");
  assert.deepEqual(view.withheld.categories[0], { category: "media", items: 400, bytes: 900 });
  assert.deepEqual(Object.keys(view.volumes), ["C:\\", "F:\\"]);
});

test("a machine the hub never heard from is unknown, not empty", () => {
  const fold = foldEstateMap([push("t480", T(12))], { now: Date.parse(T(12)) });
  assert.equal(machineView(fold, "optimus"), null);
});

// --- the route, over a real socket -------------------------------------------------------------------

function serve(t, options) {
  const api = createEstateApi(options);
  const server = http.createServer((req, res) => {
    if (!api.tryHandle(req, res)) res.writeHead(404).end("{}");
  });
  server.listen(0, "127.0.0.1");
  t.after(() => server.close());
  return new Promise((resolve) => server.on("listening", () => resolve(server.address().port)));
}

const call = (port, path, body) =>
  new Promise((resolve) => {
    const req = http.request(
      { host: "127.0.0.1", port, path, method: body ? "POST" : "GET" },
      (res) => {
        let raw = "";
        res.on("data", (c) => (raw += c));
        res.on("end", () => resolve({ status: res.statusCode, body: JSON.parse(raw || "{}") }));
      }
    );
    req.end(body ? JSON.stringify(body) : undefined);
  });

test("a pushed map is served at /api/estate/map and per machine", async (t) => {
  const port = await serve(t, { registerKey: "k", quarantine: [], mapMaxAgeMs: 30 * 60_000 });
  const pushed = await call(port, "/api/estate/register", {
    key: "k",
    manifest: { machine: "t480", map: push("t480", new Date().toISOString()) }
  });
  assert.equal(pushed.status, 200);

  const map = await call(port, "/api/estate/map");
  assert.equal(map.status, 200);
  assert.equal(map.body.machines.t480.stale, false);
  assert.equal(map.body.machines.t480.counts.apps, 1073);

  const machine = await call(port, "/api/estate/map/t480");
  assert.equal(machine.status, 200);
  assert.equal(machine.body.volumes["F:\\"].rows, 1_117_036);
  assert.equal(machine.body.withheld.categories[0].category, "media");

  const missing = await call(port, "/api/estate/map/optimus");
  assert.equal(missing.status, 404, "a machine that never pushed is not an empty machine");
});

test("a refused push leaves the served map untouched", async (t) => {
  const port = await serve(t, { registerKey: "k", quarantine: [/cv/iu] });
  const bad = push("t480", new Date().toISOString(), { scope: ["F:\\cv-archive"] });
  const refused = await call(port, "/api/estate/register", {
    key: "k",
    manifest: { machine: "t480", map: bad }
  });
  assert.equal(refused.status, 401);
  const map = await call(port, "/api/estate/map");
  assert.deepEqual(map.body.machines, {}, "nothing was recorded");
});
