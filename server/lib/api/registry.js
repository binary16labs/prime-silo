import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SUPPORTED_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

async function loadApiRegistry(apiDir) {
  const registry = new Map();
  const entries = fs
    .readdirSync(apiDir, { withFileTypes: true })
    .slice()
    .sort((left, right) => left.name.localeCompare(right.name));

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".js")) {
      continue;
    }

    const endpointName = entry.name.replace(/\.js$/, "");
    const endpointModule = await import(pathToFileURL(path.join(apiDir, entry.name)).href);
    const handlers = {};

    SUPPORTED_METHODS.forEach((method) => {
      if (typeof endpointModule[method] === "function") {
        handlers[method] = endpointModule[method];
      }
    });

    registry.set(endpointName, {
      allowAnonymous: endpointModule.allowAnonymous === true,
      endpointName,
      handlers
    });
  }

  return registry;
}

export { SUPPORTED_METHODS, loadApiRegistry };
