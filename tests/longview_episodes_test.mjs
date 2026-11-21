// LONGVIEW episodes: long sessions become one card per stretch of work, with
// real dates, and every window lands in exactly one episode.
import assert from "node:assert/strict";
import {
  planEpisodes,
  episodeId,
  episodeSig,
  inEpisode,
  MIN_EPISODE_INPUTS
} from "../scripts/longview/lib/episodes.mjs";
import { walkSessionWindows } from "../scripts/longview/lib/walk.mjs";

const at = (day, h = 10) => Date.parse(`${day}T${String(h).padStart(2, "0")}:00:00Z`);
const inputs = (day, n) =>
  Array.from({ length: n }, (_, i) => ({ id: `${day}-u${i}`, type: "User Input", timestamp: at(day) + i * 1000, content: `ask ${day} ${i}` }));
const steps = (day, n, type = "Tool Call") =>
  Array.from({ length: n }, (_, i) => ({ id: `${day}-s${i}-${type}`, type, timestamp: at(day, 11) + i * 1000, content: `${type} ${day} ${i}` }));

// 1. A one-day session is not split.
assert.deepEqual(planEpisodes([...inputs("2026-09-03", 40), ...steps("2026-09-03", 100)]), []);

// 2. A session too thin to make two episodes is not split.
assert.deepEqual(planEpisodes([...inputs("2026-09-03", 3), ...inputs("2026-09-04", 3)]), []);

// 3. Days accumulate until an episode holds MIN inputs; a short trailing run merges back.
const tl = [
  ...inputs("2026-09-03", 54),
  ...inputs("2026-09-09", 4),
  ...inputs("2026-09-10", 5), // 4+5 = 9 ≥ 8 → closes episode 2
  ...inputs("2026-11-15", 20),
  ...inputs("2026-11-21", 2), // trailing 2 < 8 → merged into the 11-15 episode
  ...steps("2026-11-21", 5)
];
const eps = planEpisodes(tl);
assert.equal(MIN_EPISODE_INPUTS, 8);
assert.deepEqual(
  eps.map((e) => [e.first_day, e.last_day, e.inputs]),
  [
    ["2026-09-03", "2026-09-03", 54],
    ["2026-09-09", "2026-09-10", 9],
    ["2026-11-15", "2026-11-21", 22]
  ]
);
// Ranges tile the whole timeline: open at both ends, contiguous in between.
assert.equal(eps[0].from, 0);
assert.equal(eps[2].to, Infinity);
assert.equal(eps[0].to, eps[1].from);
assert.equal(eps[1].to, eps[2].from);
for (const e of tl) assert.equal(eps.filter((ep) => inEpisode(e.timestamp, ep)).length, 1);

// 4. Ids: 32 hex chars, distinct sid8 per episode, stable for the same first day.
const ids = eps.map((e) => episodeId("059b4293793384e56047a7c3f77f68e6", e.first_day));
for (const id of ids) assert.match(id, /^[0-9a-f]{32}$/);
assert.equal(new Set(ids.map((i) => i.slice(0, 8))).size, ids.length);
assert.equal(episodeId("p", "2026-09-03"), episodeId("p", "2026-09-03"));
assert.notEqual(episodeId("p", "2026-09-03"), episodeId("q", "2026-09-03"));

// 5. Growth: the open last episode keeps its id but its sig changes; a closed
// episode's sig does not move when later days are added.
const grown = [...tl, ...inputs("2026-11-22", 3)];
const eps2 = planEpisodes(grown);
assert.equal(eps2[2].first_day, eps[2].first_day);
assert.notEqual(episodeSig(eps2[2], grown), episodeSig(eps[2], tl));
assert.equal(episodeSig(eps2[0], grown), episodeSig(eps[0], tl));

// 6. Walk windows carry the first timestamp of their steps, and a supplied
// timeline is walked whole (no 5,000-node cap).
const big = Array.from({ length: 6000 }, (_, i) => ({ id: `s${i}`, type: "Tool Call", timestamp: at("2026-10-01") + i, content: "x".repeat(50) }));
const { windows, stepCount } = walkSessionWindows({ id: "root" }, { inputChars: 7000, timeline: big });
assert.equal(stepCount, 6000);
const covered = new Set(windows.flatMap((w) => w.steps));
assert.equal(covered.size, 6000);
assert.equal(windows[0].firstTs, big[0].timestamp);
for (let i = 1; i < windows.length; i++) assert.ok(windows[i].firstTs >= windows[i - 1].firstTs);

console.log("longview_episodes_test: all assertions passed");
