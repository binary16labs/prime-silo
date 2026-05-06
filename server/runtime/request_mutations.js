import { captureProjectPathMutations } from "./mutation_capture.js";

async function commitProjectPathMutations(context = {}, projectPaths = []) {
  const normalizedProjectPaths = Array.isArray(projectPaths)
    ? [...new Set(projectPaths.map((value) => String(value || "").trim()).filter(Boolean))]
    : [];

  if (normalizedProjectPaths.length === 0) {
    return;
  }

  if (context.mutationSync && typeof context.mutationSync.commitProjectPaths === "function") {
    await context.mutationSync.commitProjectPaths(normalizedProjectPaths);
    return;
  }

  if (context.watchdog && typeof context.watchdog.applyProjectPathChanges === "function") {
    await context.watchdog.applyProjectPathChanges(normalizedProjectPaths);
    return;
  }

  if (context.watchdog && typeof context.watchdog.refresh === "function") {
    await context.watchdog.refresh();
  }
}

async function runTrackedMutation(context = {}, callback) {
  const capture = await captureProjectPathMutations(callback);
  await commitProjectPathMutations(context, capture.projectPaths);
  return capture.result;
}

function createLocalMutationSync(watchdog) {
  return {
    async commitProjectPaths(projectPaths = []) {
      await commitProjectPathMutations(
        {
          watchdog
        },
        projectPaths
      );
    }
  };
}

export { commitProjectPathMutations, createLocalMutationSync, runTrackedMutation };
