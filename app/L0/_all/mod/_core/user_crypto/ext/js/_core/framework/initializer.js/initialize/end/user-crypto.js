import { initializeUserCrypto } from "/mod/_core/user_crypto/user-crypto.js";

export default async function userCryptoInitializerEnd() {
  await initializeUserCrypto();
}
