// `node space registry <subcommand>` — the decentralized app-registry CLI.
//
// The binary16 app registry lets prime-silo and memo-ray (and future apps)
// discover each other's ports through a shared lockfile instead of hard-coded
// values — the fix for "port clashing/matching is a pain". This command is the
// operator entry point; it delegates to server/lib/registry_resolver.js so the
// resolver logic has one home, shared with scripts/registry/resolve-ports.mjs.
//
// Subcommands:
//   resolve [--print]   resolve every member's preferred port into a free port
//                       and write apps.lock.json (the contract both apps read)
//   status              show the current registry members + resolved lock
//   ls                  list registry members and their declared ports

import { loadRegistry, resolvePorts, findRegistry } from "../server/lib/registry_resolver.js";
import { readLock } from "../server/lib/registry_lock.js";

export const help = {
  name: "registry",
  summary: "Resolve and inspect the binary16 app registry (decentralized port management).",
  usage: [
    "node space registry resolve [--print]",
    "node space registry status",
    "node space registry ls"
  ],
  description:
    "Manages the decentralized app registry: each app self-describes in app.manifest.json (schema aamp.app/1), the parent apps.registry.json (aamp.registry/1) references members, and `resolve` writes apps.lock.json (aamp.lock/1) mapping each service to a free, non-clashing port. prime-silo and memo-ray read that lock at boot so they find each other automatically.",
  arguments: [{ name: "<subcommand>", description: "resolve | status | ls" }],
  options: [{ name: "--print", description: "Print the resolved lock JSON to stdout (resolve)." }],
  examples: ["node space registry resolve", "node space registry status"]
};

export async function execute({ args, projectRoot }) {
  const sub = (args[0] || "status").toLowerCase();
  const startDir = projectRoot || process.cwd();

  if (sub === "resolve") {
    const { lock, lockPath, warnings } = await resolvePorts({ startDir });
    for (const warning of warnings) {
      console.warn(`warning: ${warning}`);
    }
    console.log(`Resolved ${Object.keys(lock.services).length} service(s) -> ${lockPath}`);
    for (const [key, svc] of Object.entries(lock.services)) {
      console.log(`  ${key.padEnd(28)} ${svc.url}`);
    }
    if (args.includes("--print")) {
      console.log(JSON.stringify(lock, null, 2));
    }
    return 0;
  }

  if (sub === "ls") {
    const { registryPath, apps } = loadRegistry(startDir);
    console.log(`Registry: ${registryPath}`);
    for (const app of apps) {
      const provides = (app.manifest && app.manifest.provides) || [];
      const ports =
        provides.map((p) => `${p.service}:${p.preferredPort}`).join(", ") || "(no services)";
      const role = (app.manifest && app.manifest.role) || "?";
      console.log(`  ${app.member.id.padEnd(14)} [${role}] ${ports}`);
    }
    return 0;
  }

  // status (default)
  const registryPath = findRegistry(startDir);
  if (!registryPath) {
    console.log("No apps.registry.json found. Create one at the parent deployment root.");
    return 1;
  }
  console.log(`Registry: ${registryPath}`);
  const lock = readLock(startDir);
  if (!lock) {
    console.log("No apps.lock.json yet. Run `node space registry resolve`.");
    return 0;
  }
  console.log(`Lock generated: ${lock.generatedAt}`);
  for (const [key, svc] of Object.entries(lock.services)) {
    console.log(`  ${key.padEnd(28)} ${svc.url}`);
  }
  return 0;
}
