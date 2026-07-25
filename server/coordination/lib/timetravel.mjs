// Time-travel query (L8 / EP-L) — answer "what was true at T" (valid-time) and "what did we know at
// T" (transaction-time) off the KEL, and reconstruct the exact knowledge state that produced an
// artifact (e.g. the corpus a model trained on) from its knowledge_watermark.
// Design: SOLUTION §4.1 + §5.4 (knowledge_watermark) + §5.6; steers 1/10. R1–R3, R7, R32.
import { rebuild, cardSink, projectionHash } from "./projector.mjs";

// --- valid-time: "what was true in the world at T" (ignores later corrections, whose valid_time > T)
export function queryValidTime(logFile, asOfValidTime, { converters = {}, sink = cardSink } = {}) {
  return rebuild(logFile, { asOfValidTime, converters, sink });
}

// --- transaction-time: "what had been RECORDED by T" (facts recorded later, txn_time > T, excluded)
export function queryTxnTime(logFile, asOfTxnTime, { converters = {}, sink = cardSink } = {}) {
  return rebuild(logFile, { asOfTxnTime, converters, sink });
}

// --- bi-temporal point query -------------------------------------------------
export function queryAt(logFile, { asOfValidTime, asOfTxnTime, converters = {}, sink = cardSink } = {}) {
  return rebuild(logFile, { asOfValidTime, asOfTxnTime, converters, sink });
}

// --- knowledge_watermark: a self-describing, verifiable stamp of a bi-temporal input state --------
// Format: `wm1|vt=<iso|inf>|tt=<iso|inf>|sha256:<hash>`. It carries BOTH the bi-temporal coordinates
// (so the state can be re-folded) AND the content hash (so reconstruction is verifiable, R13/R32).
const INF = "inf";
const iso = (t) => (t == null ? INF : t);

export function computeWatermark(logFile, { asOfValidTime, asOfTxnTime, converters = {} } = {}) {
  const store = rebuild(logFile, { asOfValidTime, asOfTxnTime, converters, sink: cardSink });
  return `wm1|vt=${iso(asOfValidTime)}|tt=${iso(asOfTxnTime)}|sha256:${projectionHash(store)}`;
}

export function parseWatermark(watermark) {
  const m = /^wm1\|vt=([^|]+)\|tt=([^|]+)\|(sha256:[0-9a-f]+)$/.exec(watermark);
  if (!m) throw new Error(`unparseable knowledge_watermark: ${watermark}`);
  return {
    asOfValidTime: m[1] === INF ? undefined : m[1],
    asOfTxnTime: m[2] === INF ? undefined : m[2],
    contentHash: m[3]
  };
}

// --- reconstruct the exact corpus a model trained on -------------------------
// Given an execution record carrying `config.knowledge_watermark`, re-fold the KEL at that
// bi-temporal point and verify the rebuilt store hashes to the watermark's committed content hash.
// Throws if the watermark is missing or the reconstruction does not match (integrity — R7/R32).
export function reconstructCorpus(logFile, execRecord, { converters = {} } = {}) {
  const watermark = execRecord?.config?.knowledge_watermark;
  if (!watermark) throw new Error("execution record has no config.knowledge_watermark");
  const { asOfValidTime, asOfTxnTime, contentHash } = parseWatermark(watermark);
  const store = rebuild(logFile, { asOfValidTime, asOfTxnTime, converters, sink: cardSink });
  const got = `sha256:${projectionHash(store)}`;
  if (got !== contentHash)
    throw new Error(`corpus reconstruction mismatch: watermark ${contentHash} != rebuilt ${got}`);
  return { store, watermark, verified: true };
}
