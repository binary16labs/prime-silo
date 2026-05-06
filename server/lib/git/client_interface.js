export const REQUIRED_GIT_CLIENT_METHOD_NAMES = [
  "ensureCleanTrackedFiles",
  "fetchRemote",
  "readCurrentBranch",
  "hasLocalBranch",
  "hasRemoteBranch",
  "readConfig",
  "writeConfig",
  "readHeadCommit",
  "readShortCommit",
  "resolveTagRevision",
  "resolveCommitRevision",
  "checkoutBranch",
  "fastForward",
  "hardReset",
  "checkoutDetached"
];

export function assertGitClient(client, backendName = "unknown") {
  if (!client || typeof client !== "object") {
    throw new Error(`Git backend "${backendName}" returned an invalid client.`);
  }

  if (typeof client.name !== "string" || !client.name.trim()) {
    throw new Error(`Git backend "${backendName}" did not provide a valid client name.`);
  }

  if (typeof client.label !== "string" || !client.label.trim()) {
    throw new Error(`Git backend "${backendName}" did not provide a valid client label.`);
  }

  for (const methodName of REQUIRED_GIT_CLIENT_METHOD_NAMES) {
    if (typeof client[methodName] !== "function") {
      throw new Error(`Git backend "${backendName}" is missing required method "${methodName}".`);
    }
  }
}
