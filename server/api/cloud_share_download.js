import { readHostedCloudShareArchive } from "../lib/share/service.js";
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

  const shareInfo = await readHostedCloudShareArchive(
    context.projectRoot,
    context.runtimeParams,
    context.query?.token
  );

  return {
    headers: {
      "Cache-Control": "no-store",
      "Content-Type": "application/octet-stream",
      "X-Space-Share-Encrypted": shareInfo.metadata.encrypted === true ? "true" : "false"
    },
    status: 200,
    body: shareInfo.payloadBuffer
  };
}
