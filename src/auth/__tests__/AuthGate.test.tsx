import React from 'react';
import { act, renderHook, waitFor } from '@testing-library/react-native';
import { AppState, type AppStateStatus } from 'react-native';
import * as SecureStore from 'expo-secure-store';
import { AuthGateProvider, useAuth } from '../AuthGate';
import { resetAutoLock, suspendAutoLock } from '../autoLock';
import {
  advanceOnboarding,
  completeOnboarding,
  createAccount,
  createOnboardingAccount,
} from '../localAccount';

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

jest.mock('expo-crypto', () => ({
  ...(() => {
    const { createHash } = jest.requireActual('crypto') as {
      createHash: (algorithm: 'sha256') => {
        update: (input: string, encoding: 'utf8') => {
          digest: (encoding: 'hex') => string;
        };
      };
    };

    return {
      getRandomBytes: jest.fn((length: number) =>
        new Uint8Array(length).fill(0xab),
      ),
      CryptoDigestAlgorithm: { SHA256: 'SHA-256' },
      CryptoEncoding: { HEX: 'hex' },
      digestStringAsync: jest.fn(
        async (
          algorithm: string,
          input: string,
          options?: { encoding?: string },
        ) => {
          if (algorithm !== 'SHA-256' || options?.encoding !== 'hex') {
            throw new Error('Unexpected Expo Crypto digest options');
          }

          return createHash('sha256').update(input, 'utf8').digest('hex');
        },
      ),
    };
  })(),
}));

const wrapper = ({ children }: { children: React.ReactNode }) => (
  <AuthGateProvider>{children}</AuthGateProvider>
);

let appStateListener: ((state: AppStateStatus) => void) | undefined;
const appStateSpy = jest.spyOn(AppState, 'addEventListener');

beforeEach(() => {
  mockStore.clear();
  resetAutoLock();
  appStateListener = undefined;
  appStateSpy.mockImplementation((_type, listener) => {
    appStateListener = listener;
    return { remove: jest.fn() };
  });
});

afterAll(() => appStateSpy.mockRestore());

test('moves from loading to no-account when no local account exists', async () => {
  const { result } = renderHook(() => useAuth(), { wrapper });

  expect(result.current.status).toBe('loading');
  await waitFor(() => expect(result.current.status).toBe('no-account'));
});

test('loads an existing account as locked and supports lock transitions', async () => {
  await createAccount('Ada', 'hunter2secret', false);
  const { result } = renderHook(() => useAuth(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('locked'));

  act(() => result.current.unlock());
  expect(result.current.status).toBe('unlocked');

  act(() => result.current.lock());
  expect(result.current.status).toBe('locked');
});

test('an unfinished onboarding launches locked and resumes after unlock', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  const { result } = renderHook(() => useAuth(), { wrapper });

  // The Connect step may already have stored a Cloudflare credential, so the
  // password comes before onboarding picks up where it stopped.
  await waitFor(() => expect(result.current.status).toBe('locked'));

  act(() => result.current.unlock());

  expect(result.current.status).toBe('onboarding');
});

test('a credential bound before "Enter console" is not reachable without unlocking', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  await advanceOnboarding('done');
  const { result } = renderHook(() => useAuth(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('locked'));
});

test('locks onboarding on background once the account exists', async () => {
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('no-account'));

  // Nothing to protect before an account exists.
  act(() => appStateListener?.('background'));
  expect(result.current.status).toBe('no-account');
  act(() => appStateListener?.('active'));

  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  act(() => result.current.onAccountCreated());
  act(() => appStateListener?.('background'));

  expect(result.current.status).toBe('locked');

  act(() => appStateListener?.('active'));
  act(() => result.current.unlock());
  expect(result.current.status).toBe('onboarding');
});

test('onboarding stays unlocked while an auth sheet suspends the lock', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('locked'));
  act(() => result.current.unlock());

  // The Connect step's OAuth sheet must not tear the step down mid-flow.
  const release = suspendAutoLock();
  act(() => appStateListener?.('inactive'));
  expect(result.current.status).toBe('onboarding');
  act(() => appStateListener?.('active'));
  release();
});

test('loads a completed onboarding account as locked on the next launch', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  await completeOnboarding();

  const { result } = renderHook(() => useAuth(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('locked'));
});

test('completes onboarding into tabs only while foregrounded', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('locked'));
  act(() => result.current.unlock());
  expect(result.current.status).toBe('onboarding');

  act(() => result.current.onOnboardingCompleted());
  expect(result.current.status).toBe('unlocked');

  // Finished onboarding no longer routes an unlock back into it.
  act(() => appStateListener?.('background'));
  act(() => appStateListener?.('active'));
  act(() => result.current.unlock());
  expect(result.current.status).toBe('unlocked');
});

test('an interrupted completion locks instead of entering the console', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('locked'));
  act(() => result.current.unlock());

  act(() => result.current.onOnboardingCompleted({ interrupted: true }));
  expect(result.current.status).toBe('locked');

  act(() => result.current.unlock());
  expect(result.current.status).toBe('unlocked');
});

test('relocks an unlocked account when the app leaves the foreground', async () => {
  await createAccount('Ada', 'hunter2secret', false);
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('locked'));

  act(() => result.current.unlock());
  act(() => appStateListener?.('background'));

  expect(result.current.status).toBe('locked');
});

test('stays unlocked while an auth sheet suspends the lock', async () => {
  await createAccount('Ada', 'hunter2secret', false);
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('locked'));

  act(() => result.current.unlock());

  // Presenting the OAuth sheet leaves the foreground without the user leaving
  // the app; locking here would unmount the screen awaiting the callback.
  const release = suspendAutoLock();
  act(() => appStateListener?.('inactive'));
  expect(result.current.status).toBe('unlocked');

  act(() => appStateListener?.('active'));
  release();

  // Once the sheet is gone, ordinary backgrounding locks again.
  act(() => appStateListener?.('background'));
  expect(result.current.status).toBe('locked');
});

test('accepts an unlock that completes across a suspended foreground drop', async () => {
  await createAccount('Ada', 'hunter2secret', true);
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('locked'));

  // The biometric prompt resigns the active state before it reports success,
  // and the return to `active` lands after the completion.
  const release = suspendAutoLock();
  act(() => appStateListener?.('inactive'));
  act(() => result.current.unlock());
  release();
  act(() => appStateListener?.('active'));

  expect(result.current.status).toBe('unlocked');
});

test('rejects a late unlock completion while the app is backgrounded', async () => {
  await createAccount('Ada', 'hunter2secret', false);
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('locked'));

  act(() => appStateListener?.('background'));
  act(() => result.current.unlock());

  expect(result.current.status).toBe('locked');

  act(() => appStateListener?.('active'));
  act(() => result.current.unlock());

  expect(result.current.status).toBe('unlocked');
});

test('late onboarding completion while backgrounded stays locked', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('locked'));
  act(() => result.current.unlock());

  act(() => appStateListener?.('background'));
  act(() => result.current.onOnboardingCompleted());

  expect(result.current.status).toBe('locked');
});

test('surfaces corrupt storage and supports an explicit local reset', async () => {
  mockStore.set('local-account-v2', '{"name":"Ada"}');
  const { result } = renderHook(() => useAuth(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('error'));
  expect(result.current.errorKey).toBeTruthy();

  await act(async () => result.current.resetAccount());

  expect(result.current.status).toBe('no-account');
  expect(mockStore.has('local-account-v2')).toBe(false);
});

test('reset also removes every Cloudflare credential', async () => {
  mockStore.set('local-account-v2', '{"name":"Ada"}');
  mockStore.set(
    'cf-connections-v1',
    JSON.stringify([
      {
        id: 'tok-1',
        label: 'Acme',
        authType: 'token',
        accounts: [{ id: 'acc-1', name: 'Acme' }],
        createdAt: 1,
      },
    ]),
  );
  mockStore.set('cf-token-tok-1', 'secret-token');
  const { result } = renderHook(() => useAuth(), { wrapper });
  await waitFor(() => expect(result.current.status).toBe('error'));

  await act(async () => result.current.resetAccount());

  expect(result.current.status).toBe('no-account');
  // The next local account must not inherit the previous user's credentials.
  expect(mockStore.has('cf-token-tok-1')).toBe(false);
  expect(mockStore.has('cf-connections-v1')).toBe(false);
});

test('an unavailable keychain offers a retry instead of a reset', async () => {
  await createAccount('Ada', 'hunter2secret', false);
  jest
    .mocked(SecureStore.getItemAsync)
    .mockRejectedValueOnce(new Error('interaction not allowed'));
  const { result } = renderHook(() => useAuth(), { wrapper });

  await waitFor(() => expect(result.current.status).toBe('error'));
  expect(result.current.errorKey).toBe('errors.account-unavailable');

  act(() => result.current.retryAccount());

  await waitFor(() => expect(result.current.status).toBe('locked'));
  expect(result.current.errorKey).toBeNull();
  expect(mockStore.has('local-account-v2')).toBe(true);
});
