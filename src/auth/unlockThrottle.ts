import * as SecureStore from 'expo-secure-store';

/**
 * Persistent back-off for wrong unlock passwords.
 *
 * Without it the unlock screen accepts guesses as fast as they can be typed or
 * scripted. The state lives in the keychain so killing the app does not reset
 * the counter.
 */
const STORAGE_KEY = 'unlock-throttle-v1';

/** Wrong passwords allowed before the first lockout. */
export const FREE_ATTEMPTS = 4;
const BASE_LOCKOUT_MS = 30_000;
const MAX_LOCKOUT_MS = 60 * 60_000;

interface ThrottleState {
  failures: number;
  lockedUntil: number;
}

const EMPTY: ThrottleState = { failures: 0, lockedUntil: 0 };

async function readState(): Promise<ThrottleState> {
  const stored = await SecureStore.getItemAsync(STORAGE_KEY);
  if (!stored) {
    return EMPTY;
  }
  try {
    const value = JSON.parse(stored) as Partial<ThrottleState>;
    return {
      failures:
        typeof value.failures === 'number' && value.failures > 0
          ? Math.floor(value.failures)
          : 0,
      lockedUntil:
        typeof value.lockedUntil === 'number' ? value.lockedUntil : 0,
    };
  } catch {
    return EMPTY;
  }
}

/** Lockout length after the given number of consecutive failures. */
export function lockoutDuration(failures: number): number {
  if (failures <= FREE_ATTEMPTS) {
    return 0;
  }
  return Math.min(
    BASE_LOCKOUT_MS * 2 ** (failures - FREE_ATTEMPTS - 1),
    MAX_LOCKOUT_MS,
  );
}

/** Milliseconds until another password attempt is allowed; 0 when allowed. */
export async function getUnlockLockout(): Promise<number> {
  const { lockedUntil } = await readState();
  return Math.max(0, lockedUntil - Date.now());
}

/** Records a wrong password and returns the lockout it triggered, if any. */
export async function recordUnlockFailure(): Promise<number> {
  const state = await readState();
  const failures = state.failures + 1;
  const duration = lockoutDuration(failures);
  await SecureStore.setItemAsync(
    STORAGE_KEY,
    JSON.stringify({
      failures,
      lockedUntil: duration > 0 ? Date.now() + duration : 0,
    }),
  );
  return duration;
}

/** Clears the counter after a successful unlock or an account reset. */
export async function clearUnlockThrottle(): Promise<void> {
  await SecureStore.deleteItemAsync(STORAGE_KEY);
}
