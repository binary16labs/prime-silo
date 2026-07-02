import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = path.resolve(__dirname, "../../");
const SCRIPT_PATH = path.join(ROOT_DIR, "scripts", "run-workflows.mjs");

export const allowAnonymous = false;

export async function post(context) {
  const { req, res, body } = context;
  const { workspace, workflowCommand } = body || {};

  if (!workspace || !workflowCommand) {
    return {
      status: 400,
      body: { error: "Missing workspace or workflowCommand" }
    };
  }

  // Setup SSE
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive"
  });

  const sendEvent = (event, data) => {
    if (!res.writableEnded) {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    }
  };

  return new Promise((resolve) => {
    // Prevent malicious commands by restricting to known scripts
    // workflowCommand looks like "ingest" or "ingest --deep"
    const args = [SCRIPT_PATH, ...workflowCommand.split(" "), workspace];

    sendEvent("status", `Spawning: node scripts/run-workflows.mjs ${workflowCommand} ${workspace}`);

    const child = spawn("node", args, {
      cwd: ROOT_DIR,
      stdio: ["ignore", "pipe", "pipe"]
    });

    child.stdout.on("data", (chunk) => {
      sendEvent("stdout", chunk.toString());
    });

    child.stderr.on("data", (chunk) => {
      sendEvent("stderr", chunk.toString());
    });

    child.on("close", (code) => {
      sendEvent("close", { code });
      res.end();
      resolve(undefined);
    });

    child.on("error", (error) => {
      sendEvent("error", { message: error.message });
      res.end();
      resolve(undefined);
    });

    req.on("close", () => {
      if (!child.killed) {
        child.kill();
      }
    });
  });
}
