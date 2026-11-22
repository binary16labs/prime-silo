// T-017: session close-out stamps the HQ-01 shared-quarantine export (home_code) and FAILS loudly
// when the exporter throws. Runs on fake home_code trees in a temp dir; never touches the real one.
//   node tests/closeout_quarantine_stamp_test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { stampHomeCodeQuarantine } = await import("../scripts/estate_session_closeout.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "t017-"));
const fakeHome = (name, body) => {
  const dir = path.join(tmp, name);
  fs.mkdirSync(path.join(dir, "scripts", "lib"), { recursive: true });
  if (body != null) fs.writeFileSync(path.join(dir, "scripts", "lib", "host-logs.mjs"), body);
  return dir;
};
let pass = 0;
const check = async (name, fn) => {
  await fn();
  pass++;
  console.log(`  ok  ${name}`);
};

try {
  await check("no home_code on this node -> skipped (not an error)", async () => {
    const r = await stampHomeCodeQuarantine({ host: "t480", homeCodeDir: path.join(tmp, "absent") });
    assert.equal(r.status, "skipped");
  });

  await check("exporter succeeds -> ok, carries sha + host", async () => {
    const dir = fakeHome("good", `export function refreshHostQuarantineStamp(h) {
      return { host: h, quarantine_export_sha256: "a".repeat(64), cards: 3, export_unchanged: true, wrote: false };
    }`);
    const r = await stampHomeCodeQuarantine({ host: "t480", homeCodeDir: dir });
    assert.equal(r.status, "ok");
    assert.equal(r.host, "t480");
    assert.equal(r.quarantine_export_sha256, "a".repeat(64));
  });

  await check("exporter throws -> failed with the reason (never ok)", async () => {
    const dir = fakeHome("throws", `export function refreshHostQuarantineStamp() { throw new Error("quarantine.json unreadable"); }`);
    const r = await stampHomeCodeQuarantine({ host: "t480", homeCodeDir: dir });
    assert.equal(r.status, "failed");
    assert.match(r.reason, /quarantine\.json unreadable/);
  });

  await check("home_code too old (no refresh function) -> failed, says update", async () => {
    const dir = fakeHome("old", `export const nothing = 1;`);
    const r = await stampHomeCodeQuarantine({ host: "t480", homeCodeDir: dir });
    assert.equal(r.status, "failed");
    assert.match(r.reason, /update home_code/);
  });

  await check("lib fails to load (syntax error) -> failed", async () => {
    const dir = fakeHome("broken", `export function refreshHostQuarantineStamp( {`);
    const r = await stampHomeCodeQuarantine({ host: "t480", homeCodeDir: dir });
    assert.equal(r.status, "failed");
  });

  // Real home_code code on a COPY (only if home_code sits beside this repo): the stamp makes the
  // hub's freshness check see this host in hash_pointer mode.
  const realHC = path.resolve(HERE, "..", "..", "home_code");
  const realMain = path.resolve(HERE, "..", "..", "..", "OneDrive", "binary16", "home_code");
  const src = [realHC, realMain].find((d) => fs.existsSync(path.join(d, "scripts", "lib", "host-logs.mjs")));
  if (src) {
    await check("real home_code copy: stamp -> freshness check hash_pointer ok for the host", async () => {
      const dst = path.join(tmp, "copy", "binary16", "home_code");
      for (const d of ["scripts/lib", "manifests", "logs"]) fs.mkdirSync(path.join(dst, d), { recursive: true });
      for (const f of ["scripts/map-frankenstein-twin.mjs", "scripts/lib/host-logs.mjs", "scripts/lib/write-if-changed.mjs"])
        fs.copyFileSync(path.join(src, f), path.join(dst, f));
      fs.writeFileSync(path.join(dst, "manifests", "captured-session-cards-t017probe.json"),
        JSON.stringify([{ session_id: "t017probe" + "0".repeat(23), project: "probe" }]));
      const r = await stampHomeCodeQuarantine({ host: "t017probe", homeCodeDir: dst });
      assert.equal(r.status, "ok", r.reason);
      assert.equal(r.cards, 1);
      const twin = await import(new URL(`file:///${path.join(dst, "scripts", "map-frankenstein-twin.mjs").replace(/\\/g, "/")}`).href);
      const fr = twin.checkQuarantineExportFreshness("t017probe");
      const h = fr.hosts?.t017probe || {};
      assert.equal(h.mode || h.check_mode, "hash_pointer", JSON.stringify(h));
      assert.equal(Boolean(h.fresh ?? h.ok), true, JSON.stringify(h));
      // second stamp: nothing moved -> nothing written (no OneDrive churn)
      const r2 = await stampHomeCodeQuarantine({ host: "t017probe", homeCodeDir: dst });
      assert.equal(r2.wrote, false);
      assert.equal(r2.export_unchanged, true);
    });
  } else {
    console.log("  --  real home_code copy: skipped (home_code not beside this checkout)");
  }
  console.log(`PASS ${pass} checks`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
