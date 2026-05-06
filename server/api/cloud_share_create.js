import { createHostedCloudShare } from "../lib/share/service.js";

export const allowAnonymous = true;

function buildUploadMeta(query = {}) {
  return {
    cipher: query.cipher,
    encrypted: query.encrypted,
    iv: query.iv,
    iterations: query.iterations,
    kdf: query.kdf,
    salt: query.salt
  };
}

export async function post(context) {
  const result = await createHostedCloudShare({
    meta: buildUploadMeta(context.query),
    payloadBuffer: context.rawBody,
    projectRoot: context.projectRoot,
    requestUrl: context.requestUrl,
    runtimeParams: context.runtimeParams
  });

  return {
    headers: {
      "Cache-Control": "no-store"
    },
    status: 200,
    body: result
  };
}
