const fs = require("node:fs");
const fsPromises = require("node:fs/promises");
const { createHash } = require("node:crypto");
const path = require("node:path");
const { Readable, Transform } = require("node:stream");
const { pipeline } = require("node:stream/promises");

// A single installer is ~130 MB, so a laptop that sleeps or roams Wi-Fi mid-download is the
// normal case, not the edge case. Retry, and treat "no bytes for a minute" as a failure
// instead of hanging forever on a dead socket.
const DEFAULT_DOWNLOAD_ATTEMPTS = 4;
const DEFAULT_STALL_TIMEOUT_MS = 60_000;
const DEFAULT_RETRY_BASE_DELAY_MS = 2_000;
const DESKTOP_UPDATER_LOG_MAX_BYTES = 5 * 1024 * 1024;

class DesktopUpdateDownloadError extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = "DesktopUpdateDownloadError";
    Object.assign(this, details);
  }
}

function describeDesktopUpdateError(error) {
  if (!error) {
    return { message: "Unknown error." };
  }

  if (typeof error !== "object") {
    return { message: String(error) };
  }

  const described = {
    name: error.name || undefined,
    message: String(error.message || error),
    code: error.code || undefined
  };

  for (const key of [
    "statusCode",
    "url",
    "finalUrl",
    "bytesReceived",
    "expectedBytes",
    "attempt",
    "phase"
  ]) {
    if (error[key] !== undefined && error[key] !== null && error[key] !== "") {
      described[key] = error[key];
    }
  }

  // undici wraps the real socket failure (ECONNRESET, ENOTFOUND, cert errors) in `cause`,
  // leaving only "fetch failed" on the outer error. The cause is the actual "why".
  if (error.cause && error.cause !== error) {
    described.cause = describeDesktopUpdateError(error.cause);
  }

  if (error.stack) {
    described.stack = String(error.stack).split("\n").slice(0, 6).join("\n");
  }

  return described;
}

function createDesktopUpdaterPersistentLog(
  logPath,
  { maxBytes = DESKTOP_UPDATER_LOG_MAX_BYTES } = {}
) {
  const resolvedLogPath = String(logPath || "").trim();
  let writeChain = Promise.resolve();

  async function rotateIfNeeded() {
    try {
      const stats = await fsPromises.stat(resolvedLogPath);
      if (stats.size < maxBytes) {
        return;
      }
      await fsPromises.rm(`${resolvedLogPath}.1`, { force: true });
      await fsPromises.rename(resolvedLogPath, `${resolvedLogPath}.1`);
    } catch {
      // Missing file or a rotation race: appending below still works.
    }
  }

  function append(level, message, details = null) {
    const normalizedMessage = String(message || "").trim();
    if (!resolvedLogPath || !normalizedMessage) {
      return writeChain;
    }

    const lines = [
      `${new Date().toISOString()} [space-desktop/updater] ${String(level || "log").toUpperCase()} ${normalizedMessage}`
    ];

    if (details !== null && details !== undefined) {
      try {
        lines.push(JSON.stringify(details));
      } catch {
        // Keep logging best effort only.
      }
    }

    // Serialize writes so concurrent events never interleave lines or race the rotation.
    writeChain = writeChain
      .then(async () => {
        await fsPromises.mkdir(path.dirname(resolvedLogPath), { recursive: true });
        await rotateIfNeeded();
        await fsPromises.appendFile(resolvedLogPath, `${lines.join("\n")}\n`, "utf8");
      })
      .catch(() => {
        // Persistent updater logging must never block launch or install handoff.
      });

    return writeChain;
  }

  return {
    logPath: resolvedLogPath,
    append,
    flush: () => writeChain
  };
}

function rootCauseMessage(error) {
  let current = error;
  while (current?.cause && current.cause !== current) {
    current = current.cause;
  }
  const code = current?.code ? ` (${current.code})` : "";
  return `${current?.message || current || "unknown error"}${code}`;
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function downloadDesktopUpdateAssetOnce(assetUrl, destinationPath, options = {}) {
  const {
    fetchImpl = fetch,
    onProgress,
    stallTimeoutMs = DEFAULT_STALL_TIMEOUT_MS,
    attempt = 1
  } = options;
  const controller = new AbortController();
  let stallTimer = null;
  let stalled = false;
  let downloadedBytes = 0;
  let totalBytes = 0;
  let finalUrl = assetUrl;

  const armStallTimer = () => {
    clearTimeout(stallTimer);
    stallTimer = setTimeout(() => {
      stalled = true;
      controller.abort();
    }, stallTimeoutMs);
  };

  const destinationDir = path.dirname(destinationPath);
  const temporaryPath = path.join(destinationDir, `temp-${path.basename(destinationPath)}`);
  const hash = createHash("sha512");

  const failure = (message, error, phase) =>
    new DesktopUpdateDownloadError(message, {
      cause: error,
      url: assetUrl,
      finalUrl,
      bytesReceived: downloadedBytes,
      expectedBytes: totalBytes || undefined,
      attempt,
      phase
    });

  armStallTimer();
  let response;
  try {
    response = await fetchImpl(assetUrl, {
      headers: { accept: "application/octet-stream, */*" },
      redirect: "follow",
      signal: controller.signal
    });
  } catch (error) {
    clearTimeout(stallTimer);
    throw failure(
      stalled
        ? `No response from ${assetUrl} within ${Math.round(stallTimeoutMs / 1000)}s.`
        : `Request for ${assetUrl} failed: ${rootCauseMessage(error)}`,
      error,
      "request"
    );
  }

  finalUrl = response.url || assetUrl;
  if (!response.ok || !response.body) {
    clearTimeout(stallTimer);
    const error = failure(
      `Could not download desktop update asset ${assetUrl} (${response.status} ${response.statusText || "Unknown"}).`,
      null,
      "response"
    );
    error.statusCode = response.status;
    throw error;
  }

  totalBytes = Number(response.headers.get("content-length")) || 0;

  await fsPromises.mkdir(destinationDir, { recursive: true });
  await fsPromises.rm(temporaryPath, { force: true });
  await fsPromises.rm(destinationPath, { force: true });

  const hashAndProgress = new Transform({
    transform(chunk, _encoding, callback) {
      armStallTimer();
      hash.update(chunk);
      downloadedBytes += chunk.length;
      onProgress?.({
        downloadedBytes,
        totalBytes,
        progress: totalBytes > 0 ? downloadedBytes / totalBytes : null
      });
      callback(null, chunk);
    }
  });

  try {
    await pipeline(
      Readable.fromWeb(response.body),
      hashAndProgress,
      fs.createWriteStream(temporaryPath)
    );
    clearTimeout(stallTimer);

    if (totalBytes > 0 && downloadedBytes !== totalBytes) {
      throw failure(
        `Download of ${assetUrl} ended early: ${downloadedBytes} of ${totalBytes} bytes.`,
        null,
        "truncated"
      );
    }

    await fsPromises.rename(temporaryPath, destinationPath);
  } catch (error) {
    clearTimeout(stallTimer);
    await fsPromises.rm(temporaryPath, { force: true });
    if (error instanceof DesktopUpdateDownloadError) {
      throw error;
    }
    throw failure(
      stalled
        ? `Download of ${assetUrl} stalled: no data for ${Math.round(stallTimeoutMs / 1000)}s after ${downloadedBytes} bytes.`
        : `Download of ${assetUrl} failed after ${downloadedBytes} bytes: ${rootCauseMessage(error)}`,
      error,
      stalled ? "stalled" : "stream"
    );
  }

  return {
    sha512: hash.digest("base64"),
    size: downloadedBytes,
    finalUrl,
    attempt
  };
}

async function downloadDesktopUpdateAssetToFile(assetUrl, destinationPath, options = {}) {
  const {
    attempts = DEFAULT_DOWNLOAD_ATTEMPTS,
    retryBaseDelayMs = DEFAULT_RETRY_BASE_DELAY_MS,
    onAttemptFailed
  } = options;
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await downloadDesktopUpdateAssetOnce(assetUrl, destinationPath, {
        ...options,
        attempt
      });
    } catch (error) {
      lastError = error;
      // A 4xx means the asset is wrong or missing; retrying cannot fix that.
      const statusCode = Number(error?.statusCode);
      const retryable = !(statusCode >= 400 && statusCode < 500 && statusCode !== 429);
      const willRetry = retryable && attempt < attempts;
      await onAttemptFailed?.({ attempt, attempts, error, willRetry });
      if (!willRetry) {
        break;
      }
      await wait(retryBaseDelayMs * 2 ** (attempt - 1));
    }
  }

  throw lastError;
}

module.exports = {
  DEFAULT_DOWNLOAD_ATTEMPTS,
  DEFAULT_STALL_TIMEOUT_MS,
  DESKTOP_UPDATER_LOG_MAX_BYTES,
  DesktopUpdateDownloadError,
  createDesktopUpdaterPersistentLog,
  describeDesktopUpdateError,
  downloadDesktopUpdateAssetToFile
};
