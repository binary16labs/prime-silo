import assert from "node:assert/strict";
import test from "node:test";

import { createStateSystem } from "../server/runtime/state_system.js";
import { SHARED_STATE_AREA } from "../server/runtime/state_areas.js";

test("state system stores cloned primary-only entries and respects entry ttl", async () => {
  const stateSystem = createStateSystem();
  const inputValue = {
    nested: {
      count: 1
    }
  };
  const storedEntry = stateSystem.setEntry(SHARED_STATE_AREA, "runtime.test.entry", inputValue, {
    expiresInMs: 25,
    replicate: false
  });

  assert.equal(storedEntry.area, SHARED_STATE_AREA);
  assert.equal(storedEntry.id, "runtime.test.entry");
  assert.equal(storedEntry.replicated, false);
  assert.deepEqual(storedEntry.value, inputValue);

  inputValue.nested.count = 2;

  const readEntry = stateSystem.getEntry(SHARED_STATE_AREA, "runtime.test.entry");
  assert.deepEqual(readEntry?.value, {
    nested: {
      count: 1
    }
  });

  await new Promise((resolve) => setTimeout(resolve, 40));
  assert.equal(stateSystem.getEntry(SHARED_STATE_AREA, "runtime.test.entry"), null);
});

test("state system prunes old replicated deltas and falls back to snapshot sync", () => {
  const stateSystem = createStateSystem({
    deltaRetention: 2
  });

  const firstEntry = stateSystem.setEntry("file_index", "L0", {
    "/app/L0/": {
      isDirectory: true,
      mtimeMs: 1,
      sizeBytes: 0
    }
  });
  const secondEntry = stateSystem.setEntry("file_index", "L1/group_a", {
    "/app/L1/group_a/": {
      isDirectory: true,
      mtimeMs: 2,
      sizeBytes: 0
    }
  });
  const thirdEntry = stateSystem.setEntry("file_index", "L2/user", {
    "/app/L2/user/": {
      isDirectory: true,
      mtimeMs: 3,
      sizeBytes: 0
    }
  });

  assert.equal(firstEntry.delta?.toVersion, 1);
  assert.equal(secondEntry.delta?.toVersion, 2);
  assert.equal(thirdEntry.delta?.toVersion, 3);
  assert.equal(stateSystem.getVersion(), 3);
  assert.equal(stateSystem.getDeltaSince(0), null);

  const recentDelta = stateSystem.getDeltaSince(2);
  assert.equal(recentDelta?.fromVersion, 2);
  assert.equal(recentDelta?.toVersion, 3);
  assert.equal(recentDelta?.changes.length, 1);

  const snapshot = stateSystem.getReplicatedSnapshot();
  assert.equal(snapshot.version, 3);
  assert.ok(snapshot.state.file_index);
});

test("state system exposes named locks with release and retry semantics", async () => {
  const stateSystem = createStateSystem();
  const firstLock = await stateSystem.acquireLock(SHARED_STATE_AREA, "runtime.lock.entry", {
    waitMs: 0
  });

  assert.equal(firstLock.acquired, true);
  assert.ok(firstLock.lockToken);

  const secondLock = await stateSystem.acquireLock(SHARED_STATE_AREA, "runtime.lock.entry", {
    waitMs: 0
  });

  assert.equal(secondLock.acquired, false);
  assert.equal(
    stateSystem.releaseLock(SHARED_STATE_AREA, "runtime.lock.entry", "wrong-token"),
    false
  );
  assert.equal(
    stateSystem.releaseLock(SHARED_STATE_AREA, "runtime.lock.entry", firstLock.lockToken),
    true
  );

  const thirdLock = await stateSystem.acquireLock(SHARED_STATE_AREA, "runtime.lock.entry", {
    waitMs: 0
  });

  assert.equal(thirdLock.acquired, true);
  assert.ok(thirdLock.lockToken);
});
