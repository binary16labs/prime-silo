// Estate sync engine (EP-N / N0) — enumerate a source (a machine's sessions, a drive),
// content-address every session via L1 CAS (identical content → one blob, deduped),
// process only the delta via L4 cursors (idempotent / resumable), and emit estate KEL
// events for what actually changed. The D: portable copy and the F: backup share most
// content, so the overlap collapses to one blob and one session subject; a re-sync with
// nothing changed writes no blob and no new estate event. Spec: SOLUTION-estate.md §3.2.
import crypto from "node:crypto";
import { casStore } from "./staging.mjs";
import { processDelta } from "./delta.mjs";
import { appendKelEvent } from "./kel.mjs";
import { estateSessionEvent, estateDriveEvent, estateMachineEvent } from "./estate.mjs";

const sha256Hex = (s) => crypto.createHash("sha256").update(s).digest("hex");

// source = {
//   machine, driveLabel, driveRole, machineRole,
//   sessions: [{ sid, content, project?, quarantined? }]
// }
// Reuses L1 casStore (dedup), L4 processDelta (delta-only), L0 appendKelEvent (truth).
export function syncSource(kelLog, stagingRoot, source, { codeCommit = "", configHash = "" } = {}) {
  const {
    machine,
    driveLabel,
    driveRole = "replica",
    machineRole = "satellite",
    sessions = []
  } = source;
  if (!machine || !driveLabel)
    throw new Error("syncSource: source.machine and source.driveLabel are required");

  // 1. content-address every session (L1 CAS dedup)
  let stored = 0;
  let deduped = 0;
  const byHash = new Map(); // contentHash -> { content_hash, sid, project, quarantined }
  for (const s of sessions) {
    const blob = casStore(stagingRoot, s.content);
    blob.deduped ? deduped++ : stored++;
    const contentHash = `sha256:${blob.hash}`;
    if (!byHash.has(contentHash))
      byHash.set(contentHash, {
        content_hash: contentHash,
        sid: s.sid,
        project: s.project ?? null,
        quarantined: !!s.quarantined
      });
  }
  const sessionInputs = [...byHash.values()];
  const sessionHashes = sessionInputs.map((i) => i.content_hash);

  // 2. delta-only session events (L4): emit estate_session ONLY for new content
  const sess = processDelta(kelLog, sessionInputs, {
    stage: "estate-session",
    codeCommit,
    configHash,
    machine,
    run: (input) => {
      appendKelEvent(
        kelLog,
        estateSessionEvent({
          machine,
          contentHash: input.content_hash,
          sid: input.sid,
          project: input.project,
          quarantined: input.quarantined
        })
      );
      return [input.content_hash];
    }
  });

  // 3. drive manifest — fingerprint the drive; emit estate_drive ONLY when it changed
  const fingerprint =
    "sha256:" + sha256Hex([machine, driveLabel, ...[...sessionHashes].sort()].join("|"));
  const drive = processDelta(kelLog, [{ content_hash: fingerprint }], {
    stage: "estate-drive",
    codeCommit,
    configHash,
    machine,
    run: () => {
      appendKelEvent(
        kelLog,
        estateDriveEvent({
          machine,
          label: driveLabel,
          role: driveRole,
          fingerprint,
          sessionHashes
        })
      );
      return [fingerprint];
    }
  });

  // 4. machine registry — emit estate_machine only when the machine/role first appears or changes
  const machineFp = "sha256:" + sha256Hex(`${machine}|${machineRole}`);
  const mach = processDelta(kelLog, [{ content_hash: machineFp }], {
    stage: "estate-machine",
    codeCommit,
    configHash,
    machine,
    run: () => {
      appendKelEvent(kelLog, estateMachineEvent({ machine, role: machineRole }));
      return [machineFp];
    }
  });

  return {
    machine,
    driveLabel,
    stored,
    deduped,
    sessionsNew: sess.processed.length,
    sessionsSkipped: sess.skipped.length,
    driveChanged: drive.processed.length > 0,
    machineChanged: mach.processed.length > 0,
    fingerprint
  };
}
