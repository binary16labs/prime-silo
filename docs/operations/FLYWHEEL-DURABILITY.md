# Flywheel durability — backup, integrity check, and restore drill

The flywheel substrate on **D:** (`D:\flywheel-staging\`: `blobs`, `eventlog`, `index`, `manifests`)
is the single point of truth (R17). Append-only is **not** the same as backed up — a single-drive
failure without a replica loses the corpus. L3 makes durability a rehearsed procedure, not a hope.
Backup is a **local copy** (a second drive/path), never a cloud dependency — local-first stays intact
(R21/R34). Reference impl: `server/coordination/lib/durability.mjs`. Extends R41.

## What is protected

- **Blobs** are content-addressed, so integrity is self-checking: a blob must re-hash to its filename.
- **The KEL** is chain-hashed (L0), so a tampered/lost log line is detectable by chain verification.
- **Index + manifests** are copied so the replica is a complete, self-describing substrate on its own.

## 1. Replicate (run on a cadence — e.g. after each loop turn, and nightly)

```bash
node -e "import('./server/coordination/lib/durability.mjs').then(m=>console.log(m.replicate(process.env.PRIMARY, process.env.REPLICA)))"
# PRIMARY=D:\flywheel-staging   REPLICA=<second local drive>\flywheel-staging
```

Copies all four subtrees byte-identically. Because blobs are content-addressed, re-replication is
cheap and idempotent (unchanged blobs already exist on the replica).

## 2. Integrity check (run on the replica periodically)

```bash
node -e "import('./server/coordination/lib/durability.mjs').then(m=>{const r=m.integrityCheck(process.env.REPLICA); if(!r.ok){console.error('CORRUPT',r); process.exit(1)} console.log('OK')})"
```

Fails naming any blob whose bytes no longer match its content-addressed name, and flags a broken KEL
chain (`kelBroken`). A silent bit-rot on the replica is thus caught before it is ever relied on.

## 3. Restore drill (rehearse — do NOT wait for a real failure)

Simulate primary loss and rebuild the projection from the replica alone:

```bash
node -e "import('./server/coordination/lib/durability.mjs').then(m=>console.log(m.restoreFromReplica(process.env.REPLICA)))"
```

The restored staged-session inventory (sid + blob refs) must equal the pre-failure inventory. In a real
failure: point `PRIME_SILO_HOME` / the staging root at the replica, run the integrity check, then resume
the loop — projections rebuild from the replicated KEL (L8), so no synthesized knowledge is lost.

## Cadence & ownership

- Replicate after every loop turn (L10 can invoke it) **and** on a nightly schedule.
- Integrity-check the replica nightly; alert on any mismatch.
- **Rehearse the restore drill on a fixed cadence** (e.g. monthly) — an untested backup is not a backup.
  A fresh agent must be able to execute steps 1–3 from this doc alone.
