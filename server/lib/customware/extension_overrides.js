import { globToRegExp, normalizePathSegment } from "../utils/app_files.js";
import { parseProjectModuleExtensionFilePath } from "./layout.js";
import {
  collectProjectPathsFromFileIndexShards,
  collectReadableModuleShardIds,
  getRuntimeGroupIndexFromStateSystem
} from "./module_state.js";
import { collectAccessibleModuleEntries, compareRankedEntries } from "./overrides.js";

function normalizeExtensionPattern(value) {
  try {
    return normalizePathSegment(value);
  } catch {
    return "";
  }
}

function normalizeExtensionPatterns(patterns) {
  return Array.isArray(patterns)
    ? patterns
        .map((pattern) => normalizeExtensionPattern(pattern))
        .filter(Boolean)
    : [];
}

function compileExtensionPatterns(patterns) {
  return normalizeExtensionPatterns(patterns).map((pattern) => ({
    matcher: globToRegExp(pattern),
    pattern
  }));
}

function matchesExtensionPattern(entry, compiledPatterns) {
  return compiledPatterns.some(({ matcher }) => matcher.test(entry.extensionPath));
}

function listResolvedExtensionRequests(options = {}) {
  const { maxLayer, requests = [], runtimeParams, stateSystem, username } = options;

  if (!stateSystem) {
    return [];
  }

  const normalizedRequests = requests
    .map((request) => {
      const patterns = normalizeExtensionPatterns(request && request.patterns);
      const compiledPatterns = compileExtensionPatterns(patterns);

      if (compiledPatterns.length === 0) {
        return null;
      }

      return {
        compiledPatterns,
        patterns
      };
    })
    .filter(Boolean);

  if (normalizedRequests.length === 0) {
    return [];
  }

  const groupIndex = getRuntimeGroupIndexFromStateSystem(stateSystem, runtimeParams);
  const accessibleEntries = collectAccessibleModuleEntries(
    collectProjectPathsFromFileIndexShards(
      stateSystem,
      collectReadableModuleShardIds({
        groupIndex,
        maxLayer,
        username
      })
    ),
    {
      groupIndex,
      maxLayer,
      parseProjectPath: parseProjectModuleExtensionFilePath,
      username
    }
  );

  const selectedEntriesByRequestIndex = normalizedRequests.map(() => new Map());

  for (const entry of accessibleEntries) {
    for (const [index, request] of normalizedRequests.entries()) {
      if (!matchesExtensionPattern(entry, request.compiledPatterns)) {
        continue;
      }

      selectedEntriesByRequestIndex[index].set(entry.requestPath, entry);
    }
  }

  return normalizedRequests.map((request, index) => ({
    extensions: [...selectedEntriesByRequestIndex[index].values()]
      .sort(compareRankedEntries)
      .map((entry) => entry.requestPath),
    patterns: [...request.patterns]
  }));
}

function listResolvedExtensionRequestPaths(options = {}) {
  const { maxLayer, patterns = [], runtimeParams, stateSystem, username } = options;
  const results = listResolvedExtensionRequests({
    maxLayer,
    requests: [
      {
        patterns
      }
    ],
    runtimeParams,
    stateSystem,
    username,
  });

  return results[0]?.extensions || [];
}

export {
  listResolvedExtensionRequests,
  listResolvedExtensionRequestPaths
};
