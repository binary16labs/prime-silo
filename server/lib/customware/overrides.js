import {
  getLayerOrder,
  isProjectPathWithinMaxLayer,
  normalizeMaxLayer
} from "./layer_limit.js";
import { normalizeEntityId, parseProjectModuleFilePath } from "./layout.js";

function createEmptyGroupIndex() {
  return {
    errors: [],
    getManagedGroupsForUser() {
      return [];
    },
    getOrderedGroupsForUser() {
      return [];
    },
    groups: Object.create(null),
    inclusionCycles: [],
    isUserInGroup(_username, groupId) {
      return groupId === "_all";
    },
    users: Object.create(null)
  };
}

function compareRankedEntries(left, right) {
  if (left.rank !== right.rank) {
    return left.rank - right.rank;
  }

  return left.projectPath.localeCompare(right.projectPath);
}

function buildInheritanceRanks(groupIndex, username, options = {}) {
  const maxLayer = normalizeMaxLayer(options.maxLayer);
  const normalizedUsername = normalizeEntityId(username);
  const orderedGroups =
    groupIndex && typeof groupIndex.getOrderedGroupsForUser === "function"
      ? groupIndex.getOrderedGroupsForUser(normalizedUsername)
      : [];
  const groupRanks = new Map();

  orderedGroups.forEach((groupId, index) => {
    groupRanks.set(groupId, index);
  });

  return {
    getRankForModulePath(modulePathInfo) {
      if (!modulePathInfo) {
        return null;
      }

      const layerOrder = getLayerOrder(modulePathInfo.layer);

      if (layerOrder === null || layerOrder > maxLayer) {
        return null;
      }

      if (modulePathInfo.ownerType === "user") {
        if (!normalizedUsername || modulePathInfo.ownerId !== normalizedUsername) {
          return null;
        }

        return 2 + orderedGroups.length * 2;
      }

      if (modulePathInfo.ownerId === "_all") {
        return modulePathInfo.layer === "L0" ? 0 : 1 + orderedGroups.length;
      }

      const groupRank = groupRanks.get(modulePathInfo.ownerId);

      if (groupRank === undefined) {
        return null;
      }

      if (modulePathInfo.layer === "L0") {
        return 1 + groupRank;
      }

      return 2 + orderedGroups.length + groupRank;
    },
    orderedGroups
  };
}

function collectAccessibleModuleEntries(projectPaths, options = {}) {
  const {
    groupIndex,
    maxLayer,
    parseProjectPath = parseProjectModuleFilePath,
    username
  } = options;
  const ranks = buildInheritanceRanks(groupIndex || createEmptyGroupIndex(), username, {
    maxLayer
  });

  return [...projectPaths]
    .filter((projectPath) => isProjectPathWithinMaxLayer(projectPath, maxLayer))
    .map((projectPath) => {
      const parsedEntry = parseProjectPath(projectPath);

      if (!parsedEntry) {
        return null;
      }

      const rank = ranks.getRankForModulePath(parsedEntry);

      if (rank === null) {
        return null;
      }

      return {
        ...parsedEntry,
        rank
      };
    })
    .filter(Boolean)
    .sort(compareRankedEntries);
}

function selectOverrideEntries(entries, options = {}) {
  const { getOverrideKey = (entry) => entry.requestPath || entry.projectPath } = options;
  const selectedEntries = new Map();

  for (const entry of entries) {
    const overrideKey = String(getOverrideKey(entry) || "");

    if (!overrideKey) {
      continue;
    }

    selectedEntries.set(overrideKey, entry);
  }

  return [...selectedEntries.values()].sort(compareRankedEntries);
}

function filterAccessibleModulePaths(projectPaths, username, groupIndex, options = {}) {
  return collectAccessibleModuleEntries(projectPaths, {
    groupIndex,
    maxLayer: options.maxLayer,
    username
  }).map((entry) => entry.projectPath);
}

export {
  collectAccessibleModuleEntries,
  compareRankedEntries,
  createEmptyGroupIndex,
  filterAccessibleModulePaths,
  selectOverrideEntries
};
