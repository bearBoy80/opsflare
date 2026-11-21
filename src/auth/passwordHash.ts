import * as Crypto from 'expo-crypto';
import { pbkdf2Async } from '@noble/hashes/pbkdf2';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, utf8ToBytes } from '@noble/hashes/utils';

/**
 * Version 2 was a single salted SHA-256, which a GPU can test billions of
 * times per second once the keychain blob leaks. Version 3 stretches the
 * password with PBKDF2 so every guess costs real work. Version 2 hashes are
 * still verified and upgraded on the next successful unlock.
 */
export const CURRENT_PASSWORD_HASH_VERSION = 3;

export type PasswordHashVersion = 2 | 3;

export function isPasswordHashVersion(
  value: unknown,
): value is PasswordHashVersion {
  return value === 2 || value === 3;
}

/**
 * PBKDF2-HMAC-SHA256 rounds for version 3. The derivation runs in JS on the
 * device, so this trades brute-force cost against unlock latency.
 */
export const PBKDF2_ITERATIONS = 100_000;

const V3_DOMAIN = 'opsflare-local-account:v3';

export async function derivePasswordHash(
  password: string,
  saltHex: string,
  version: PasswordHashVersion = CURRENT_PASSWORD_HASH_VERSION,
): Promise<string> {
  if (version === 2) {
    return Crypto.digestStringAsync(
      Crypto.CryptoDigestAlgorithm.SHA256,
      `opsflare-local-account:v2\0${saltHex}\0${password}`,
      { encoding: Crypto.CryptoEncoding.HEX },
    );
  }

  const salt = new Uint8Array([
    ...utf8ToBytes(`${V3_DOMAIN}\0`),
    ...hexToBytes(saltHex),
  ]);
  const derived = await pbkdf2Async(sha256, utf8ToBytes(password), salt, {
    c: PBKDF2_ITERATIONS,
    dkLen: 32,
  });
  return bytesToHex(derived);
}
