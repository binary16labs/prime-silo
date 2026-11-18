// U8 — THE SIGNED COPY. Stage 3b of the signed PLAN-consolidate-first: a U7 proposal THE OWNER SIGNED
// is carried out exactly as shown. robocopy (PATH D12) stages each batch on F:, every staged file is
// read back against its planned sha256, and only then is it placed - by a hard link to its final name,
// which fails on an existing name, so nothing on F: is ever overwritten, even in a race. The source is
// only read: robocopy never runs with /MOV, /MIR or /PURGE. A file only in OneDrive's cloud is never
// opened (robocopy would download it); a file that changed since the plan is skipped, so the bytes
// copied are always the bytes signed (the owner's answers, 2026-11-18).
import fs from "node:fs";
import path from "node:path";
import { spawn as spawnFile } from "node:child_process";
import { Worker, isMainThread, parentPort, workerData } from "node:worker_threads";
import { CLOUD_MASK } from "./library.mjs";
import { hashFile } from "./nas_catalog.mjs";
import { rootIdentity } from "./estate_compare.mjs";

export const WRITER = "t480"; // the signed plan: the T480 is the only node that writes to F:
export const HEADROOM = 10e9; // free space must cover the copy and 10 GB besides
const FLAGS = Object.freeze(["/COPY:DAT", "/DCOPY:T", "/Z", "/R:1", "/W:1", "/NP", "/NJH", "/NJS", "/NFL", "/NDL"]);

// The one place robocopy's arguments are made. A NAME IS NEVER A SWITCH: robocopy reads "-MOV" as
// well as "/MOV", so a file named "-MOV" moved a whole batch out of the source and lost a file
// (claude-u8-verifier, round 1, B1). Such a name is never handed to robocopy; runCopy skips it.
export const switchLike = (n) => /^[-/]/u.test(n) || /[*?]/u.test(n);
export function robocopyArgs(from, to, names) {
  if (names.some(switchLike) || FLAGS.some((f) => /^[-/](MOV|MOVE|MIR|PURGE)$/iu.test(f)))
    throw new Error("U8 never moves, mirrors or purges, and a file name is never a switch");
  return [from, to, ...names, ...FLAGS];
}

// robocopy's exit code is ANSWERED, not thrown: 0-7 is success, 8 and above means some file failed
// (one locked file is exit 9). Which files made it is read from the staging folder, file by file, so
// one locked file no longer fails the whole run (round 1, B2).
export function robocopy(from, to, names, { spawn = spawnFile } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn("robocopy", robocopyArgs(from, to, names), { windowsHide: true });
    p.on("error", reject);
    p.on("close", (code) => resolve(code));
  });
}

// Which files in ONE folder are only in the cloud, from the listing's attributes - never opening one.
// U1's probe walks a whole tree; a batch needs its own folder only, just before it is read.
const PROBE = [
  "[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)",
  `Get-ChildItem -LiteralPath $env:U8_DIR -File -Force -ErrorAction Stop | ForEach-Object { if (([int64]$_.Attributes -band ${CLOUD_MASK}) -ne 0) { $_.Name } }`
].join("\n");
export function folderCloudOnly(dir, { spawn = spawnFile } = {}) {
  if (process.platform !== "win32") return Promise.resolve(new Set());
  return new Promise((resolve, reject) => {
    let out = "";
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", PROBE], { env: { ...process.env, U8_DIR: dir }, windowsHide: true });
    p.stdout.setEncoding("utf8").on("data", (s) => (out += s));
    p.on("error", reject);
    p.on("close", (code) =>
      code === 0 ? resolve(new Set(out.split(/\r?\n/u).filter(Boolean).map((n) => n.toLowerCase()))) : reject(new Error(`the listing exited ${code}`))
    );
  });
}

// Every condition of a run, in one place; the first that fails is the answer, in words.
export function copyRefusal(s) {
  const p = s.plan ?? {};
  if (String(s.machine).toLowerCase() !== (s.writer ?? WRITER)) return `only the T480 writes to ${s.target}`;
  if (s.copying) return "a copy is already running";
  if (s.targetPass) return `${s.target} is being catalogued: copy when its pass ends`;
  if (!p.digest) return p.why || (p.never ? "this source is never proposed" : "the plan is still being worked out");
  if (p.attached === false) return "the source is away: attach it first";
  if (s.asked && s.asked !== p.proposal?.id) return "the plan has changed since that proposal: the current one is not signed";
  if (s.chainOk === false) return "the governance log does not verify: nothing runs until it does";
  if (!p.proposal?.authorised)
    return p.proposal?.state === "signed"
      ? "signed, but not by a human: only the owner's signature authorises a copy"
      : p.proposal?.state === "open"
        ? "raised and waiting for your signature in Governance"
        : `the plan is ${p.proposal?.state ?? "not raised"}: raise it and sign it first`;
  if (s.rehashed !== p.digest || s.claimed !== p.digest) return "the file list does not match what was signed";
  if (s.free == null) return `${s.target}'s free space cannot be read`;
  if (s.free < p.copy.bytes + HEADROOM) return `${s.target} needs room for the copy and 10 GB besides: free space first`;
  return null;
}

// Batches: one source folder each, at most `size` files, so Stop is never far away.
function batchesOf(items, size) {
  const by = new Map();
  for (const it of items) {
    const dir = path.posix.dirname(it.from);
    (by.get(dir) ?? by.set(dir, []).get(dir)).push(it);
  }
  const out = [];
  for (const [dir, list] of by) for (let i = 0; i < list.length; i += size) out.push([dir, list.slice(i, i + size)]);
  return out;
}

export async function runCopy({
  items,
  sourceRoot,
  targetRoot,
  staging,
  cloudOnly = folderCloudOnly,
  copy = robocopy,
  hash = hashFile,
  record = () => {},
  progress = () => {},
  stopped = () => false,
  targetOk = () => true,
  size = 50
}) {
  const counts = { copied: 0, bytes: 0, already: 0, refused: 0, changed: 0, cloud_only: 0, unreadable: 0, unsafe_name: 0, pointers: 0, repeats_unplaced: 0 };
  const note = (it, result, key) => {
    if (key) counts[key]++;
    record({ from: it.from, to: it.to, ...(it.same_as ? { same_as: it.same_as } : {}), result });
  };
  const there = new Set(); // planned paths (folded) that hold the planned content after this run
  const at = (it) => path.join(targetRoot, ...it.to.split("/"));
  // what is already in place, right or wrong, is judged before anything is staged (a re-run resumes);
  // a folder at the planned name is that name holding other content, never a crash
  const placed = async (it, final) => {
    if (!fs.statSync(final).isDirectory() && (await hash(final)) === it.sha256) {
      there.add(it.to.toLowerCase());
      return note(it, "already there", "already");
    }
    return note(it, "refused: the name on F: holds other content", "refused");
  };
  fs.rmSync(staging, { recursive: true, force: true }); // a killed run's leftovers: only ever ours
  const batches = batchesOf(items.filter((i) => i.to), size);
  const end = (outcome, why) => {
    // a repeat is a pointer only to a copy that is there (round 1 note: never to one that was skipped)
    for (const it of items.filter((i) => i.same_as))
      there.has(it.same_as.toLowerCase()) ? note(it, "pointer", "pointers") : note(it, "skipped: its first copy was not placed", "repeats_unplaced");
    return { counts, outcome, ...(why ? { why } : {}) };
  };
  try {
    for (let step = 0; step < batches.length; step++) {
      progress({ step: step + 1, steps: batches.length, counts: { ...counts } });
      if (stopped()) return end("stopped");
      if (!targetOk()) return end("stopped", "the drive at the target is not the one the plan was made for");
      const [dir, group] = batches[step];
      const from = path.join(sourceRoot, ...dir.split("/").filter((d) => d !== "."));
      const todo = [];
      for (const it of group) {
        if (fs.existsSync(at(it))) await placed(it, at(it));
        else if (switchLike(path.posix.basename(it.from))) note(it, "skipped: robocopy would read its name as a switch (rename it)", "unsafe_name");
        else todo.push(it);
      }
      if (!todo.length) continue;
      let cloud;
      try {
        cloud = await cloudOnly(from);
      } catch {
        for (const it of todo) note(it, "skipped: the folder's listing could not be read", "unreadable");
        continue;
      }
      const go = todo.filter((it) => !cloud.has(path.posix.basename(it.from).toLowerCase()) || note(it, "skipped: only in the cloud", "cloud_only"));
      if (!go.length) continue;
      const stage = path.join(staging, String(step + 1));
      fs.mkdirSync(stage, { recursive: true });
      const failed = (await copy(from, stage, go.map((it) => path.posix.basename(it.from)))) >= 8;
      for (const it of go) {
        const staged = path.join(stage, path.posix.basename(it.from));
        try {
          if (!fs.existsSync(staged)) note(it, "skipped: could not be read (in use or locked?)", "unreadable");
          else if ((await hash(staged)) !== it.sha256)
            failed ? note(it, "skipped: could not be copied whole", "unreadable") : note(it, "skipped: changed since the plan", "changed");
          else {
            fs.mkdirSync(path.dirname(at(it)), { recursive: true });
            try {
              fs.linkSync(staged, at(it)); // fails on an existing name: never an overwrite
              counts.bytes += it.size;
              there.add(it.to.toLowerCase());
              note(it, "copied", "copied");
            } catch (e) {
              if (e.code !== "EEXIST") throw e;
              await placed(it, at(it));
            }
          }
        } finally {
          fs.rmSync(staged, { force: true });
        }
      }
      fs.rmSync(stage, { recursive: true, force: true });
    }
    return end("ok");
  } catch (e) {
    // an unexpected failure still says what was done before it (round 1, B2: counts were null)
    return end("failed", String(e?.message || e));
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// The hub's side: the run happens off its thread, in a worker, unless a test hands in its own copier.
export function startCopy(job, { inline = null, onProgress = () => {} } = {}) {
  let stop = false;
  if (inline) {
    const done = runCopy({ ...job, ...inline, record: recorder(job.recordFile), progress: onProgress, stopped: () => stop, targetOk: targetCheck(job) });
    return { stop: () => (stop = true), done };
  }
  const w = new Worker(new URL(import.meta.url), { workerData: { u8: job } });
  const done = new Promise((resolve, reject) => {
    w.on("message", (m) => (m.progress ? onProgress(m.progress) : m.done ? resolve(m.done) : m.failed && reject(new Error(m.failed))));
    w.on("error", reject);
    w.on("exit", (code) => code !== 0 && reject(new Error(`the copy stopped unexpectedly (${code})`)));
  });
  return { stop: () => w.postMessage({ stop: true }), done };
}
const recorder = (file) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  return (line) => fs.appendFileSync(file, `${JSON.stringify(line)}\n`);
};
// the drive at the target letter is checked again before every batch: a swapped drive stops the run
export const targetCheck = (job) => () => !job.targetIdentity || rootIdentity(job.targetRoot) === job.targetIdentity;

if (!isMainThread && workerData?.u8) {
  const job = workerData.u8;
  let stop = false;
  parentPort.on("message", (m) => m.stop && (stop = true));
  runCopy({ ...job, record: recorder(job.recordFile), progress: (p) => parentPort.postMessage({ progress: p }), stopped: () => stop, targetOk: targetCheck(job) })
    .then((r) => parentPort.postMessage({ done: r }))
    .catch((e) => parentPort.postMessage({ failed: String(e?.message || e) }))
    .finally(() => parentPort.close());
}
