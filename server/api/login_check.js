export const allowAnonymous = true;

export function get(context) {
  const headers = {
    "Cache-Control": "no-store"
  };

  if (
    context.user?.shouldClearSessionCookie &&
    context.auth &&
    typeof context.auth.createClearedSessionCookieHeader === "function"
  ) {
    headers["Set-Cookie"] = context.auth.createClearedSessionCookieHeader();
  }

  return {
    headers,
    status: 200,
    body: {
      authenticated: Boolean(context.user?.isAuthenticated),
      username: context.user?.isAuthenticated ? context.user.username : ""
    }
  };
}
