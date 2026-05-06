const path = require("node:path");

const DESKTOP_UPDATER_LOG_RELATIVE_PATH = path.join("logs", "desktop-updater.log");

function resolveDesktopUpdaterLogPath(options = {}) {
  const userDataPath = String(options.userDataPath || "").trim();
  if (!userDataPath) {
    return "";
  }

  const platform = String(options.platform || "").trim();
  const pathModule = platform === "win32" || /\\/u.test(userDataPath) ? path.win32 : path;

  return pathModule.join(userDataPath, DESKTOP_UPDATER_LOG_RELATIVE_PATH);
}

function resolveWindowsUpdaterInstallerArgs(options = {}) {
  const args = ["--updated"];
  const isSilent = options.isSilent === true;
  const shouldForceRunAfter = isSilent
    ? options.isForceRunAfter === true
    : options.autoRunAppAfterInstall !== false;
  const packagePath = String(options.packagePath || "").trim();

  if (isSilent) {
    args.push("/S");
  }

  if (shouldForceRunAfter) {
    args.push("--force-run");
  }

  if (packagePath) {
    args.push(`--package-file=${packagePath}`);
  }

  return args;
}

module.exports = {
  DESKTOP_UPDATER_LOG_RELATIVE_PATH,
  resolveDesktopUpdaterLogPath,
  resolveWindowsUpdaterInstallerArgs
};
