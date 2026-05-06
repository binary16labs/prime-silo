const TEXT_ENCODER = new TextEncoder();
const DEFAULT_CLOUD_SHARE_KDF_ITERATIONS = 210000;

function ensureWebCrypto() {
  if (
    typeof globalThis.crypto?.getRandomValues !== "function" ||
    typeof globalThis.crypto?.subtle?.importKey !== "function" ||
    typeof globalThis.crypto?.subtle?.deriveKey !== "function" ||
    typeof globalThis.crypto?.subtle?.encrypt !== "function" ||
    typeof globalThis.crypto?.subtle?.decrypt !== "function"
  ) {
    throw new Error("This browser does not expose the Web Crypto APIs required for protected cloud shares.");
  }
}

function toUint8Array(value) {
  if (value instanceof Uint8Array) {
    return value;
  }

  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value);
  }

  if (ArrayBuffer.isView(value)) {
    return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  }

  throw new Error("Expected binary share payload bytes.");
}

function toBase64Url(bytes) {
  let text = "";
  toUint8Array(bytes).forEach((value) => {
    text += String.fromCharCode(value);
  });
  return btoa(text).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}

function fromBase64Url(value) {
  const normalized = String(value || "").replace(/-/gu, "+").replace(/_/gu, "/");
  const padding = normalized.length % 4 === 0 ? "" : "=".repeat(4 - (normalized.length % 4));
  const decoded = atob(normalized + padding);
  return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
}

async function deriveShareKey(password, saltBytes, iterations) {
  ensureWebCrypto();
  const passwordText = String(password || "");

  if (!passwordText) {
    throw new Error("A password is required.");
  }

  const passwordKey = await crypto.subtle.importKey(
    "raw",
    TEXT_ENCODER.encode(passwordText),
    "PBKDF2",
    false,
    ["deriveKey"]
  );

  return crypto.subtle.deriveKey(
    {
      name: "PBKDF2",
      hash: "SHA-256",
      iterations: Number(iterations) || DEFAULT_CLOUD_SHARE_KDF_ITERATIONS,
      salt: toUint8Array(saltBytes)
    },
    passwordKey,
    {
      name: "AES-GCM",
      length: 256
    },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptSharePayload(payloadBytes, password, options = {}) {
  ensureWebCrypto();
  const saltBytes = new Uint8Array(16);
  const ivBytes = new Uint8Array(12);
  crypto.getRandomValues(saltBytes);
  crypto.getRandomValues(ivBytes);
  const iterations = Number(options.iterations) || DEFAULT_CLOUD_SHARE_KDF_ITERATIONS;
  const key = await deriveShareKey(password, saltBytes, iterations);
  const encryptedBuffer = await crypto.subtle.encrypt(
    {
      name: "AES-GCM",
      iv: ivBytes
    },
    key,
    toUint8Array(payloadBytes)
  );

  return {
    encryption: {
      cipher: "AES-GCM",
      encrypted: true,
      iv: toBase64Url(ivBytes),
      iterations,
      kdf: "PBKDF2-SHA-256",
      salt: toBase64Url(saltBytes)
    },
    payloadBytes: new Uint8Array(encryptedBuffer)
  };
}

async function decryptSharePayload(payloadBytes, encryption, password) {
  ensureWebCrypto();

  if (!encryption || encryption.encrypted !== true) {
    return toUint8Array(payloadBytes);
  }

  const key = await deriveShareKey(password, fromBase64Url(encryption.salt), encryption.iterations);
  const decryptedBuffer = await crypto.subtle.decrypt(
    {
      name: "AES-GCM",
      iv: fromBase64Url(encryption.iv)
    },
    key,
    toUint8Array(payloadBytes)
  );

  return new Uint8Array(decryptedBuffer);
}

export {
  DEFAULT_CLOUD_SHARE_KDF_ITERATIONS,
  decryptSharePayload,
  encryptSharePayload,
  ensureWebCrypto
};
