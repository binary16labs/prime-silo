// T2 dataset row schemas + validators. Two SFT streams:
//   Stream A — method/voice: {instruction -> house-style response} from cards/ADRs
//   Stream B — agent tool-use: {state + goal -> next tool call} from memo-ray traces
// Pure, dependency-free — imported by the builder, the gate, and the unit tests so
// there is one authority for "well-formed row".

export const STREAMS = ["A", "B"];

const isNonEmptyStr = (v) => typeof v === "string" && v.trim().length > 0;

// Every row carries stream, a stable id, and source provenance (so the split can
// be reconstructed and the leak-gate/audit can trace a row back to its origin).
function baseErrors(row) {
  const e = [];
  if (!STREAMS.includes(row?.stream)) e.push("stream must be 'A' or 'B'");
  if (!isNonEmptyStr(row?.id)) e.push("id required");
  if (!row?.source || !isNonEmptyStr(row.source.type) || !isNonEmptyStr(row.source.id))
    e.push("source {type,id} required");
  return e;
}

export function validateRowA(row) {
  const errors = baseErrors(row);
  if (row?.stream !== "A") errors.push("stream must be 'A'");
  if (!isNonEmptyStr(row?.instruction)) errors.push("instruction required");
  if (!isNonEmptyStr(row?.response)) errors.push("response required");
  if (!["card", "adr"].includes(row?.source?.type)) errors.push("source.type must be card|adr");
  return { ok: errors.length === 0, errors };
}

export function validateRowB(row) {
  const errors = baseErrors(row);
  if (row?.stream !== "B") errors.push("stream must be 'B'");
  if (!isNonEmptyStr(row?.state)) errors.push("state required");
  if (!isNonEmptyStr(row?.goal)) errors.push("goal required");
  const tc = row?.tool_call;
  if (!tc || !isNonEmptyStr(tc.name)) errors.push("tool_call.name required");
  if (tc && typeof tc.args !== "object") errors.push("tool_call.args must be an object");
  if (row?.source?.type !== "trace") errors.push("source.type must be trace");
  return { ok: errors.length === 0, errors };
}

export function validateRow(row) {
  if (row?.stream === "A") return validateRowA(row);
  if (row?.stream === "B") return validateRowB(row);
  return { ok: false, errors: [`unknown stream ${row?.stream}`] };
}

// The full flat text of a row, used by the leak gate — every field a leak could
// hide in (instruction/response/state/goal/tool args/source id) is included.
export function rowText(row) {
  const parts = [
    row.instruction,
    row.response,
    row.state,
    row.goal,
    row.tool_call ? JSON.stringify(row.tool_call) : "",
    row.source ? `${row.source.type}:${row.source.id}` : "",
  ];
  return parts.filter(Boolean).join("\n");
}
