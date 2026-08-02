// The shared registration key that gates POST /api/estate/register (EP-N / N7).
//
// The route shipped with expectedKey:null, so register() refused every satellite as
// "unauthenticated" — wired and dead. These pin the two properties that matter once it is
// alive: it FAILS CLOSED when unconfigured, and a blank key never authenticates anyone.
//
// The blank case is the sharp one. register() compares `key !== expectedKey`, so an
// expectedKey of "" would authenticate any client that also sent "" (or omitted it, if a
// caller ever coerced undefined to ""). A whitespace-only key file must therefore resolve
// to null — refusing everyone — not to an empty string that lets everyone in.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveRegisterKey, initRegisterKey, keyPath } from "../server/coordination/lib/estate_register_key.mjs";
import { register } from "../server/coordination/lib/estate_register.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "estate-key-"));
const write = (v) => {
  const p = keyPath(tmp);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, v);
};

test("no key configured resolves to null (fail closed)", () => {
  assert.equal(resolveRegisterKey({ home: tmp, env: {} }), null);
});

test("a blank or whitespace-only key file resolves to null, never an empty string", () => {
  write("   \n");
  assert.equal(resolveRegisterKey({ home: tmp, env: {} }), null,
    'an empty expectedKey would authenticate any client sending ""');
});

test("an unconfigured hub refuses every registration", () => {
  const r = register({}, { machine: "ASUS", sessions: [] }, {
    key: "anything", expectedKey: resolveRegisterKey({ home: tmp, env: {} }), remoteAddress: "192.168.1.9"
  });
  assert.equal(r.ok, false);
  assert.equal(r.reason, "unauthenticated");
});

test("env beats the keystore file", () => {
  write("from-file\n");
  assert.equal(resolveRegisterKey({ home: tmp, env: { ESTATE_REGISTER_KEY: "from-env" } }), "from-env");
});

test("a real key round-trips and then authenticates", () => {
  fs.rmSync(keyPath(tmp), { force: true });
  const r = initRegisterKey({ home: tmp });
  assert.equal(r.ok, true);
  const key = resolveRegisterKey({ home: tmp, env: {} });
  assert.equal(typeof key, "string");
  assert.equal(key.length, 64, "32 random bytes, hex-encoded");
  const reg = register({}, { machine: "ASUS", sessions: [] }, {
    key, expectedKey: key, remoteAddress: "192.168.1.9"
  });
  assert.equal(reg.ok, true);
});

test("init refuses to silently rotate an existing key", () => {
  const again = initRegisterKey({ home: tmp });
  assert.equal(again.ok, false, "rotating would lock out every satellite holding the old key");
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
