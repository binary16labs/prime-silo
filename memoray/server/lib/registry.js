// Decentralized app-registry lockfile reader (Mem0Ray side).
//
// Mem0Ray runs standalone, but when it is deployed alongside prime-silo under
// the binary16 app registry, the resolver writes apps.lock.json (schema
// aamp.lock/1) with the port it assigned this service. Reading that lock lets
// Mem0Ray honour a registry-resolved port (e.g. auto-bumped after a clash)
// without anyone hand-editing config — the peer apps stay in sync.
//
// Read-only, zero dependencies, fully best-effort: a missing or malformed lock
// returns null and Mem0Ray falls back to its own PORT default (3030), so the
// standalone binary never depends on the registry being present.
//
// Discovery: $BINARY16_REGISTRY_DIR/apps.lock.json, else the nearest
// apps.lock.json walking up from the current working directory.

const fs = require('fs');
const path = require('path');

const LOCK_FILENAME = 'apps.lock.json';
const LOCK_SCHEMA = 'aamp.lock/1';

function findLockfile(startDir, env) {
    const e = env || process.env;
    const override = e.BINARY16_REGISTRY_DIR && String(e.BINARY16_REGISTRY_DIR).trim();
    if (override) {
        const candidate = path.join(path.resolve(override), LOCK_FILENAME);
        return fs.existsSync(candidate) ? candidate : null;
    }

    let dir = path.resolve(startDir || process.cwd());
    // eslint-disable-next-line no-constant-condition
    while (true) {
        const candidate = path.join(dir, LOCK_FILENAME);
        if (fs.existsSync(candidate)) {
            return candidate;
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return null;
        }
        dir = parent;
    }
}

function readLock(startDir, env) {
    const lockPath = findLockfile(startDir, env);
    if (!lockPath) {
        return null;
    }
    try {
        const parsed = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
        if (parsed && parsed.schema === LOCK_SCHEMA && parsed.services && typeof parsed.services === 'object') {
            return parsed;
        }
    } catch (e) {
        return null;
    }
    return null;
}

// Resolve the port the registry assigned to appId/service, or null.
function lockedPort(appId, service, startDir, env) {
    const lock = readLock(startDir, env);
    if (!lock) {
        return null;
    }
    const entry = lock.services[`${appId}/${service}`];
    if (entry && Number.isFinite(Number(entry.port))) {
        return Number(entry.port);
    }
    return null;
}

module.exports = { findLockfile, readLock, lockedPort, LOCK_FILENAME, LOCK_SCHEMA };
