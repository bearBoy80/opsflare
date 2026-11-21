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

import * as SecureStore from 'expo-secure-store';
import * as Crypto from 'expo-crypto';
import {
  advanceOnboarding,
  completeOnboarding,
  createAccount,
  createOnboardingAccount,
  deleteAccount,
  getAccount,
  LocalAccountStorageError,
  setBiometricsEnabled,
  verifyPassword,
} from '../localAccount';

const mockDigestStringAsync = jest.mocked(Crypto.digestStringAsync);
const expectedDigest =
  '16a6379d1959d7ffd43f63c4070f87f854acefcc396cbde149e7b79b1538ec02';

beforeEach(() => {
  mockStore.clear();
  mockDigestStringAsync.mockClear();
});

test('returns null when no local account exists', async () => {
  expect(await getAccount()).toBeNull();
});

test('rejects malformed local account data with a typed storage error', async () => {
  mockStore.set('local-account-v2', '{"name":"Ada"}');

  await expect(getAccount()).rejects.toMatchObject({
    code: 'corrupt',
    name: 'LocalAccountStorageError',
  });
});

test('wraps SecureStore access failures with a typed storage error', async () => {
  jest
    .mocked(SecureStore.getItemAsync)
    .mockRejectedValueOnce(new Error('keychain unavailable'));

  await expect(getAccount()).rejects.toEqual(
    expect.objectContaining<Partial<LocalAccountStorageError>>({
      code: 'unavailable',
    }),
  );
});

test('stores only a salted password hash and verifies the password', async () => {
  await createAccount('Ada', 'hunter2secret', false);

  const account = await getAccount();
  expect(account?.name).toBe('Ada');
  expect(account?.saltHex).toMatch(/^[0-9a-f]{32}$/);
  expect(account?.hashHex).toMatch(/^[0-9a-f]{64}$/);
  expect(JSON.stringify(account)).not.toContain('hunter2secret');
  expect(await verifyPassword('hunter2secret')).toBe(true);
  expect(await verifyPassword('wrong')).toBe(false);
});

test('persists version 3 for a normally created account', async () => {
  await createAccount('Ada', 'hunter2secret', false);

  expect(JSON.parse(mockStore.get('local-account-v2') ?? 'null')).toMatchObject({
    passwordHashVersion: 3,
    name: 'Ada',
  });
});

test('persists version 3 for an onboarding account', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );

  expect(JSON.parse(mockStore.get('local-account-v2') ?? 'null')).toMatchObject({
    passwordHashVersion: 3,
    onboardingStep: 'connect',
  });
});

test('verifies with the current hash without rewriting the stored account', async () => {
  await createAccount('Ada', 'hunter2secret', false);
  const storedBefore = mockStore.get('local-account-v2');
  jest.mocked(SecureStore.setItemAsync).mockClear();
  mockDigestStringAsync.mockClear();

  await expect(verifyPassword('hunter2secret')).resolves.toBe(true);

  expect(mockStore.get('local-account-v2')).toBe(storedBefore);
  expect(SecureStore.setItemAsync).not.toHaveBeenCalled();
  // Version 3 is PBKDF2 in JS; the legacy native SHA-256 is not involved.
  expect(mockDigestStringAsync).not.toHaveBeenCalled();
});

const legacyAccount = {
  name: 'Ada',
  organization: '',
  email: '',
  saltHex: 'ab'.repeat(16),
  hashHex: expectedDigest,
  passwordHashVersion: 2,
  biometricsEnabled: true,
  onboardingComplete: true,
  onboardingStep: 'done',
  createdAt: 0,
};

test('upgrades a version 2 hash to version 3 on a correct password', async () => {
  mockStore.set('local-account-v2', JSON.stringify(legacyAccount));

  await expect(verifyPassword('hunter2secret')).resolves.toBe(true);

  const upgraded = JSON.parse(mockStore.get('local-account-v2') ?? 'null');
  expect(upgraded).toMatchObject({
    name: 'Ada',
    biometricsEnabled: true,
    passwordHashVersion: 3,
  });
  expect(upgraded.hashHex).not.toBe(expectedDigest);
  await expect(verifyPassword('hunter2secret')).resolves.toBe(true);
  await expect(verifyPassword('wrong')).resolves.toBe(false);
});

test('leaves a version 2 hash alone on a wrong password', async () => {
  const stored = JSON.stringify(legacyAccount);
  mockStore.set('local-account-v2', stored);

  await expect(verifyPassword('wrong')).resolves.toBe(false);

  expect(mockStore.get('local-account-v2')).toBe(stored);
});

test('ignores unpublished version 1 data stored under its prior key', async () => {
  mockStore.set(
    'local-account-v1',
    JSON.stringify({
      name: 'Old Ada',
      organization: '',
      email: '',
      saltHex: 'ab'.repeat(16),
      hashHex: expectedDigest,
      passwordHashVersion: 1,
      biometricsEnabled: false,
      onboardingComplete: true,
      onboardingStep: 'done',
      createdAt: 0,
    }),
  );

  await expect(getAccount()).resolves.toBeNull();
});

test('rejects an unknown password hash version as corrupt data', async () => {
  mockStore.set(
    'local-account-v2',
    JSON.stringify({
      name: 'Ada',
      organization: '',
      email: '',
      saltHex: 'ab'.repeat(16),
      hashHex: expectedDigest,
      passwordHashVersion: 4,
      biometricsEnabled: false,
      onboardingComplete: true,
      onboardingStep: 'done',
      createdAt: 0,
    }),
  );

  await expect(getAccount()).rejects.toMatchObject({ code: 'corrupt' });
});

test('rejects an otherwise-valid account that omits its password hash version', async () => {
  mockStore.set(
    'local-account-v2',
    JSON.stringify({
      name: 'Ada',
      organization: '',
      email: '',
      saltHex: 'ab'.repeat(16),
      hashHex: expectedDigest,
      biometricsEnabled: false,
      onboardingComplete: true,
      onboardingStep: 'done',
      createdAt: 0,
    }),
  );

  await expect(getAccount()).rejects.toMatchObject({
    code: 'corrupt',
    name: 'LocalAccountStorageError',
  });
});

test('uses native random bytes for the password salt', async () => {
  await createAccount('Ada', 'hunter2secret', false);

  expect((await getAccount())?.saltHex).toBe('ab'.repeat(16));
});

test('persists the biometric unlock preference', async () => {
  await createAccount('Ada', 'hunter2secret', false);

  await setBiometricsEnabled(true);

  expect((await getAccount())?.biometricsEnabled).toBe(true);
});

test('rejects biometric preference changes before an account exists', async () => {
  await expect(setBiometricsEnabled(true)).rejects.toThrow('no local account');
});

test('deletes the local account for explicit recovery', async () => {
  await createAccount('Ada', 'hunter2secret', false);

  await deleteAccount();

  expect(await getAccount()).toBeNull();
});

test('persists an incomplete onboarding account and advances its step', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    true,
  );

  expect(await getAccount()).toMatchObject({
    organization: 'Acme',
    name: 'Ada',
    email: 'ada@example.com',
    biometricsEnabled: true,
    onboardingComplete: false,
    onboardingStep: 'connect',
  });

  await advanceOnboarding('done');
  expect((await getAccount())?.onboardingStep).toBe('done');
});

test('marks onboarding complete without changing the password hash', async () => {
  await createOnboardingAccount(
    { organization: 'Acme', name: 'Ada', email: 'ada@example.com' },
    'hunter2secret',
    false,
  );
  const hashBefore = (await getAccount())?.hashHex;

  await completeOnboarding();

  expect(await getAccount()).toMatchObject({
    onboardingComplete: true,
    onboardingStep: 'done',
    hashHex: hashBefore,
  });
});

test('rejects an otherwise-valid v2 account without onboarding fields as corrupt', async () => {
  await createAccount('Ada', 'hunter2secret', false);
  const current = JSON.parse(mockStore.get('local-account-v2')!);
  delete current.organization;
  delete current.email;
  delete current.onboardingComplete;
  delete current.onboardingStep;
  mockStore.set('local-account-v2', JSON.stringify(current));

  await expect(getAccount()).rejects.toMatchObject({
    code: 'corrupt',
    name: 'LocalAccountStorageError',
  });
});
