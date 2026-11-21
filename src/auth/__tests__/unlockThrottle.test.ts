const mockStore = new Map<string, string>();

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(async (key: string) => mockStore.get(key) ?? null),
  setItemAsync: jest.fn(async (key: string, value: string) => {
    mockStore.set(key, value);
  }),
  deleteItemAsync: jest.fn(async (key: string) => {
    mockStore.delete(key);
  }),
}));

import {
  clearUnlockThrottle,
  FREE_ATTEMPTS,
  getUnlockLockout,
  lockoutDuration,
  recordUnlockFailure,
} from '../unlockThrottle';

beforeEach(() => {
  mockStore.clear();
  jest.useFakeTimers({ now: 1_700_000_000_000 });
});

afterEach(() => jest.useRealTimers());

test('allows the free attempts without a lockout', async () => {
  for (let i = 0; i < FREE_ATTEMPTS; i += 1) {
    await expect(recordUnlockFailure()).resolves.toBe(0);
  }
  await expect(getUnlockLockout()).resolves.toBe(0);
});

test('locks out after the free attempts and backs off exponentially', async () => {
  for (let i = 0; i < FREE_ATTEMPTS; i += 1) {
    await recordUnlockFailure();
  }
  await expect(recordUnlockFailure()).resolves.toBe(30_000);
  await expect(getUnlockLockout()).resolves.toBe(30_000);

  jest.advanceTimersByTime(30_000);
  await expect(getUnlockLockout()).resolves.toBe(0);
  await expect(recordUnlockFailure()).resolves.toBe(60_000);
});

test('caps the lockout at one hour', () => {
  expect(lockoutDuration(100)).toBe(60 * 60_000);
});

test('survives a restart and is cleared by a success', async () => {
  for (let i = 0; i <= FREE_ATTEMPTS; i += 1) {
    await recordUnlockFailure();
  }
  // Nothing is held in memory: the state comes back from the keychain.
  await expect(getUnlockLockout()).resolves.toBeGreaterThan(0);

  await clearUnlockThrottle();
  await expect(getUnlockLockout()).resolves.toBe(0);
});
