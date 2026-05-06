import { readHostedCloudShareMeta } from "../lib/share/service.js";
import { areGuestUsersAllowed } from "../lib/utils/runtime_params.js";

export const allowAnonymous = true;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

export async function get(context) {
  if (!areGuestUsersAllowed(context.runtimeParams)) {
    throw createHttpError("Cloud share not found.", 404);
  }

  const shareInfo = await readHostedCloudShareMeta(
    context.projectRoot,
    context.runtimeParams,
    context.query?.token
  );
  const isEncrypted = shareInfo.metadata.encrypted === true;

  return {
    headers: {
      "Cache-Control": "no-store"
    },
    status: 200,
    body: {
      createdAt: String(shareInfo.metadata.createdAt || ""),
      encrypted: isEncrypted,
      encryption:
        shareInfo.metadata.encryption && typeof shareInfo.metadata.encryption === "object"
          ? {
              ...shareInfo.metadata.encryption,
              encrypted: isEncrypted
            }
          : null,
      lastUsedAt: String(shareInfo.metadata.lastUsedAt || ""),
      sizeBytes: Number(shareInfo.metadata.sizeBytes || 0),
      token: shareInfo.shareToken
    }
  };
}
