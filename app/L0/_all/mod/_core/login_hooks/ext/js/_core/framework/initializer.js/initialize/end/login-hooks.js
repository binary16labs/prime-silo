import { runLoginHooksBootstrap } from "/mod/_core/login_hooks/login-hooks.js";

export default async function loginHooksInitializerEnd() {
  await runLoginHooksBootstrap();
}
