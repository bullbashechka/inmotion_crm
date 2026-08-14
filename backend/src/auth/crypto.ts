const encoder = new TextEncoder();
const decoder = new TextDecoder();

function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/u, "");
}

function base64UrlToBytes(value: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]+$/u.test(value)) throw new Error("Недопустимое кодирование секрета.");
  const padded = value.replaceAll("-", "+").replaceAll("_", "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (value) => value.toString(16).padStart(2, "0")).join("");
}

export function createOpaqueToken(bytesLength = 32): string {
  const bytes = new Uint8Array(bytesLength);
  crypto.getRandomValues(bytes);
  return bytesToBase64Url(bytes);
}

export async function hashSecret(value: string): Promise<string> {
  return hex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}

export async function createPkceChallenge(verifier: string): Promise<string> {
  return bytesToBase64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(verifier))));
}

/** Constant-time comparison for equal-length hash strings. */
export function secretsEqual(left: string, right: string): boolean {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

export type AuthTokenCipher = {
  encrypt(plaintext: string): Promise<string>;
  decrypt(ciphertext: string): Promise<string>;
};

/**
 * Encrypts provider refresh tokens at rest. The 32-byte key is a Worker secret
 * encoded as base64url and must never be browser-accessible.
 */
export async function createAuthTokenCipher(encodedKey: string): Promise<AuthTokenCipher> {
  const rawKey = base64UrlToBytes(encodedKey);
  if (rawKey.byteLength !== 32) throw new Error("AUTH_TOKEN_ENCRYPTION_KEY должен содержать 32 байта в base64url.");
  const key = await crypto.subtle.importKey("raw", rawKey, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);

  return {
    async encrypt(plaintext: string): Promise<string> {
      const iv = new Uint8Array(12);
      crypto.getRandomValues(iv);
      const encrypted = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext));
      return `${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
    },
    async decrypt(ciphertext: string): Promise<string> {
      const [encodedIv, encodedPayload, extra] = ciphertext.split(".");
      if (encodedIv === undefined || encodedPayload === undefined || extra !== undefined) throw new Error("Недопустимый зашифрованный токен.");
      const iv = base64UrlToBytes(encodedIv);
      if (iv.byteLength !== 12) throw new Error("Недопустимый зашифрованный токен.");
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, key, base64UrlToBytes(encodedPayload));
      return decoder.decode(plaintext);
    },
  };
}

/** A provider email is never used as the employee's visible CRM login. */
export function canonicalizeEmail(value: string): string | null {
  const canonical = value.trim().toLowerCase();
  if (canonical.length === 0 || canonical.length > 320 || /[^\x21-\x7e]/u.test(canonical)) return null;
  const at = canonical.lastIndexOf("@");
  if (at < 1 || at === canonical.length - 1) return null;
  const local = canonical.slice(0, at);
  const domain = canonical.slice(at + 1);
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/u.test(local)) return null;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/u.test(domain)) return null;
  return canonical;
}

/**
 * CRM logins are deliberately short, memorable usernames. They never contain
 * an email separator, which prevents accidental exposure of the recovery
 * address on a shared sign-in screen.
 */
export function canonicalizeUsername(value: string): string | null {
  const canonical = value.trim().toLowerCase();
  if (canonical.length < 3 || canonical.length > 64) return null;
  return /^[a-z0-9](?:[a-z0-9._-]{1,62}[a-z0-9])?$/u.test(canonical) ? canonical : null;
}

/** @deprecated Use canonicalizeEmail or canonicalizeUsername explicitly. */
export const canonicalizeLogin = canonicalizeEmail;
