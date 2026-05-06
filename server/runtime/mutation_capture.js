import { AsyncLocalStorage } from "node:async_hooks";

const mutationCaptureStorage = new AsyncLocalStorage();

function normalizeProjectPath(value) {
  const normalizedValue = String(value || "").trim();
  return normalizedValue ? normalizedValue : "";
}

function recordCapturedProjectPathMutations(projectPaths = []) {
  const activeCapture = mutationCaptureStorage.getStore();

  if (!activeCapture || !Array.isArray(projectPaths)) {
    return;
  }

  projectPaths.forEach((projectPath) => {
    const normalizedProjectPath = normalizeProjectPath(projectPath);

    if (!normalizedProjectPath) {
      return;
    }

    activeCapture.projectPaths.add(normalizedProjectPath);
  });
}

async function captureProjectPathMutations(callback) {
  const capture = {
    projectPaths: new Set()
  };

  const result = await mutationCaptureStorage.run(capture, callback);

  return {
    projectPaths: [...capture.projectPaths],
    result
  };
}

export { captureProjectPathMutations, recordCapturedProjectPathMutations };
