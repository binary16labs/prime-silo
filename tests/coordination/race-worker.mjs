// Child process for the concurrent-claim race test: one claim attempt, result on stdout.
import { claimTask } from "../../server/coordination/lib/ledger.mjs";

const [dir, taskId, agent] = process.argv.slice(2);
const r = claimTask(dir, taskId, agent);
process.stdout.write(r.ok ? "CLAIMED" : r.reason);
