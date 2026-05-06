import { isSingleUserApp } from "../lib/utils/runtime_params.js";
import { runTrackedMutation } from "../runtime/request_mutations.js";

export const allowAnonymous = true;

const FAILED_LOGIN_MIN_DURATION_MS = 1000;

function createHttpError(message, statusCode) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function wait(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function waitForMinimumDuration(startedAtMs, minimumDurationMs) {
  const elapsedMs = Date.now() - startedAtMs;

  if (elapsedMs < minimumDurationMs) {
    await wait(minimumDurationMs - elapsedMs);
  }
}

export async function post(context) {
  if (isSingleUserApp(context.runtimeParams)) {
    throw createHttpError("Password login is disabled in single-user mode.", 403);
  }

  const startedAtMs = Date.now();
  const payload =
    context.body && typeof context.body === "object" && !Buffer.isBuffer(context.body)
      ? context.body
      : {};
  let response;

  try {
    const loginResult = await runTrackedMutation(context, async () =>
      context.auth.completeLogin({
        challengeToken: payload.challengeToken,
        clientProof: payload.clientProof,
        userCryptoProvisioning: payload.userCryptoProvisioning,
        req: context.req
      })
    );

    response = {
      status: 200,
      headers: {
        "Cache-Control": "no-store",
        "Set-Cookie": context.auth.createSessionCookieHeader(
          loginResult.sessionToken,
          loginResult.username
        )
      },
      body: {
        authenticated: true,
        serverSignature: loginResult.serverSignature,
        sessionId: loginResult.sessionId,
        userCrypto: loginResult.userCrypto,
        username: loginResult.username
      }
    };
  } catch (error) {
    await waitForMinimumDuration(startedAtMs, FAILED_LOGIN_MIN_DURATION_MS);
    throw createHttpError(error.message || "Login failed.", Number(error.statusCode) || 401);
  }

  return response;
}
