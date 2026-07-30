// Thin CLI over lib/record.mjs so the standalone dashboard (:8788) can reuse the
// EXACT same disk-truth lineage/step-through logic the app's benny_record player
// uses — one implementation, no drift. Workspace comes from LONGVIEW_WORKSPACE
// (record.mjs reads it via config at import), so the dashboard's workspace filter
// maps straight onto the --workspace the server sets before spawning this.
//
//   node scripts/longview/record_cli.mjs --scope card:ab12cd34
//   node scripts/longview/record_cli.mjs --scope section:p1c1s1
//   node scripts/longview/record_cli.mjs --scope dossier:Benny --record-only
//
// Prints ONE JSON object: { scope, workspace, lineage:{nodes,links}, record:{actions} }.
import { recordFor, lineageFor } from "./lib/record.mjs";
import { config } from "./lib/config.mjs";

const args = process.argv.slice(2);
const opt = (n, d = null) => {
  const i = args.indexOf(`--${n}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : d;
};
const has = (n) => args.includes(`--${n}`);

const scope = opt("scope");
if (!scope) {
  console.error(
    "usage: record_cli.mjs --scope <card:sid|section:id|dossier:name|book|run> [--lineage-only|--record-only]"
  );
  process.exit(1);
}

const out = { scope, workspace: config.WORKSPACE };
try {
  if (!has("record-only")) out.lineage = lineageFor(scope);
  if (!has("lineage-only")) out.record = recordFor(scope);
  process.stdout.write(JSON.stringify(out));
} catch (e) {
  process.stdout.write(
    JSON.stringify({ scope, workspace: config.WORKSPACE, error: String(e.message || e) })
  );
  process.exit(2);
}
