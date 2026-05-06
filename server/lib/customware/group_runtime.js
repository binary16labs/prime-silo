import { SINGLE_USER_APP_USERNAME, isSingleUserApp } from "../utils/runtime_params.js";
import { normalizeEntityId } from "./layout.js";
import { createEmptyGroupIndex } from "./overrides.js";

function sortUniqueStrings(values) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))].sort((left, right) =>
    left.localeCompare(right)
  );
}

function isSingleUser(username) {
  return normalizeEntityId(username) === SINGLE_USER_APP_USERNAME;
}

function createRuntimeGroupIndex(groupIndex, runtimeParams) {
  const baseGroupIndex = groupIndex || createEmptyGroupIndex();

  if (!isSingleUserApp(runtimeParams)) {
    return baseGroupIndex;
  }

  function getOrderedGroupsForUser(username) {
    const groups =
      typeof baseGroupIndex.getOrderedGroupsForUser === "function"
        ? baseGroupIndex.getOrderedGroupsForUser(username)
        : [];

    if (!isSingleUser(username)) {
      return groups;
    }

    return sortUniqueStrings([...groups, "_admin"]);
  }

  function getManagedGroupsForUser(username) {
    const managedGroups =
      typeof baseGroupIndex.getManagedGroupsForUser === "function"
        ? baseGroupIndex.getManagedGroupsForUser(username)
        : [];

    if (!isSingleUser(username)) {
      return managedGroups;
    }

    return sortUniqueStrings([...managedGroups, "_all"]);
  }

  function isUserInGroup(username, groupId) {
    const normalizedGroupId = normalizeEntityId(groupId);

    if (isSingleUser(username) && normalizedGroupId === "_admin") {
      return true;
    }

    return typeof baseGroupIndex.isUserInGroup === "function"
      ? baseGroupIndex.isUserInGroup(username, groupId)
      : normalizedGroupId === "_all";
  }

  const users =
    baseGroupIndex.users && typeof baseGroupIndex.users === "object"
      ? {
          ...baseGroupIndex.users
        }
      : Object.create(null);

  users[SINGLE_USER_APP_USERNAME] = {
    ...(users[SINGLE_USER_APP_USERNAME] || {
      directGroups: [],
      username: SINGLE_USER_APP_USERNAME
    }),
    groups: getOrderedGroupsForUser(SINGLE_USER_APP_USERNAME),
    managedGroups: getManagedGroupsForUser(SINGLE_USER_APP_USERNAME),
    username: SINGLE_USER_APP_USERNAME
  };

  return {
    ...baseGroupIndex,
    getManagedGroupsForUser,
    getOrderedGroupsForUser,
    isUserInGroup,
    users
  };
}

function getRuntimeGroupIndex(watchdog, runtimeParams) {
  const groupIndex =
    watchdog && typeof watchdog.getIndex === "function"
      ? watchdog.getIndex("group_index") || createEmptyGroupIndex()
      : createEmptyGroupIndex();

  return createRuntimeGroupIndex(groupIndex, runtimeParams);
}

export { createRuntimeGroupIndex, getRuntimeGroupIndex };
