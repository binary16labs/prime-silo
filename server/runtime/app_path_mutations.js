let runtimeAppPathMutationHandler = null;

function setRuntimeAppPathMutationHandler(handler) {
  runtimeAppPathMutationHandler = typeof handler === "function" ? handler : null;
}

function handleRuntimeAppPathMutations(options = {}, projectPaths = []) {
  if (!runtimeAppPathMutationHandler) {
    return false;
  }

  return runtimeAppPathMutationHandler(options, projectPaths) === true;
}

export { handleRuntimeAppPathMutations, setRuntimeAppPathMutationHandler };
