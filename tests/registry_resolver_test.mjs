// App-registry resolver tests.
//
// Verifies the decentralized port resolver: topological ordering by the
// `requires` DAG (services before the shells that depend on them), preferred
// ports when free, deterministic auto-bump within portRange on a clash, and a
// well-formed apps.lock.json that the readers consume. Builds a throwaway
// registry under os.tmpdir so no real apps are needed.

import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import {
  loadRegistry,
  topoSortApps,
  isPortFree,
  resolvePorts,
  LOCK_SCHEMA
} from "../server/lib/registry_resolver.js";
import { lockServiceUrl } from "../server/lib/registry_lock.js";

function occupyPort(port, host = "127.0.0.1") {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(port, host, () => resolve(server));
  });
}

async function writeRegistry(dir, members) {
  await fs.writeFile(
    path.join(dir, "apps.registry.json"),
    JSON.stringify(
      {
        schema: "aamp.registry/1",
        name: "test",
        members: members.map((m) => ({ id: m.id, path: `./${m.id}` }))
      },
      null,
      2
    )
  );
  for (const m of members) {
    const appDir = path.join(dir, m.id);
    await fs.mkdir(appDir, { recursive: true });
    await fs.writeFile(
      path.join(appDir, "app.manifest.json"),
      JSON.stringify(
        {
          schema: "aamp.app/1",
          id: m.id,
          name: m.id,
          role: m.role,
          requires: m.requires || [],
          provides: [{ service: m.service, preferredPort: m.preferredPort, portRange: m.portRange }]
        },
        null,
        2
      )
    );
  }
}

async function main() {
  // --- isPortFree sanity ---
  const occupied = await occupyPort(0);
  const occupiedPort = occupied.address().port;
  assert.equal(await isPortFree(occupiedPort), false, "a listening port reports not free");
  await new Promise((r) => occupied.close(r));

  // --- topo order: shell listed first must resolve AFTER its required service ---
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "registry-test-"));
  const env = { ...process.env, BINARY16_REGISTRY_DIR: tmp };

  await writeRegistry(tmp, [
    {
      id: "shell-app",
      role: "shell",
      requires: ["svc-app"],
      service: "ui",
      preferredPort: 39881,
      portRange: [39881, 39890]
    },
    {
      id: "svc-app",
      role: "service",
      requires: [],
      service: "api",
      preferredPort: 39871,
      portRange: [39871, 39880]
    }
  ]);

  const { apps } = loadRegistry(tmp, env);
  const ordered = topoSortApps(apps).map((a) => a.member.id);
  assert.deepEqual(
    ordered,
    ["svc-app", "shell-app"],
    "service resolves before the shell that requires it"
  );

  // --- preferred ports when free ---
  const first = await resolvePorts({ startDir: tmp, env });
  assert.equal(first.lock.schema, LOCK_SCHEMA);
  assert.equal(
    first.lock.services["svc-app/api"].port,
    39871,
    "service takes its preferred port when free"
  );
  assert.equal(
    first.lock.services["shell-app/ui"].port,
    39881,
    "shell takes its preferred port when free"
  );

  // lockfile is written and the reader resolves it
  const urlFromLock = lockServiceUrl({ appId: "svc-app", service: "api", startDir: tmp, env });
  assert.equal(urlFromLock, "http://127.0.0.1:39871", "lock reader returns the resolved url");

  // --- clash → deterministic auto-bump within range ---
  const blocker = await occupyPort(39871);
  try {
    const second = await resolvePorts({ startDir: tmp, env });
    assert.equal(
      second.lock.services["svc-app/api"].port,
      39872,
      "service auto-bumps to the next free port in range"
    );
  } finally {
    await new Promise((r) => blocker.close(r));
  }

  // --- exhausted range → clear error ---
  const blockers = [];
  for (let p = 39871; p <= 39880; p += 1) {
    blockers.push(await occupyPort(p));
  }
  try {
    await assert.rejects(
      resolvePorts({ startDir: tmp, env }),
      /No free port/,
      "an exhausted range fails loudly"
    );
  } finally {
    await Promise.all(blockers.map((b) => new Promise((r) => b.close(r))));
  }

  await fs.rm(tmp, { recursive: true, force: true });
  console.log("registry_resolver_test: all assertions passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
