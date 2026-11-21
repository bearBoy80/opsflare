import * as SecureStore from 'expo-secure-store';
import { getRandomBytes } from 'expo-crypto';
import {
  CURRENT_PASSWORD_HASH_VERSION,
  derivePasswordHash,
  isPasswordHashVersion,
  type PasswordHashVersion,
} from './passwordHash';
import { clearUnlockThrottle } from './unlockThrottle';

const STORAGE_KEY = 'local-account-v2';

export type LocalAccountStorageErrorCode = 'corrupt' | 'unavailable';

export class LocalAccountStorageError extends Error {
  readonly code: LocalAccountStorageErrorCode;

  constructor(code: LocalAccountStorageErrorCode) {
    super(
      code === 'corrupt'
        ? 'The local account data is invalid.'
        : 'The local account storage is unavailable.',
    );
    this.name = 'LocalAccountStorageError';
    this.code = code;
  }
}

export type PersistedOnboardingStep = 'connect' | 'done';

export interface OnboardingProfile {
  organization: string;
  name: string;
  email: string;
}

export interface LocalAccount {
  name: string;
  organization: string;
  email: string;
  saltHex: string;
  hashHex: string;
  passwordHashVersion: PasswordHashVersion;
  biometricsEnabled: boolean;
  onboardingComplete: boolean;
  onboardingStep: PersistedOnboardingStep;
  createdAt: number;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

function isHex(value: unknown, length: number): value is string {
  return (
    typeof value === 'string' &&
    value.length === length &&
    /^[0-9a-f]+$/i.test(value)
  );
}

function parseAccount(stored: string): LocalAccount {
  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    throw new LocalAccountStorageError('corrupt');
  }

  if (!value || typeof value !== 'object') {
    throw new LocalAccountStorageError('corrupt');
  }

  const candidate = value as Partial<LocalAccount>;
  if (
    typeof candidate.name !== 'string' ||
    candidate.name.trim().length === 0 ||
    !isHex(candidate.saltHex, 32) ||
    !isHex(candidate.hashHex, 64) ||
    !isPasswordHashVersion(candidate.passwordHashVersion) ||
    typeof candidate.biometricsEnabled !== 'boolean' ||
    typeof candidate.createdAt !== 'number' ||
    !Number.isFinite(candidate.createdAt)
  ) {
    throw new LocalAccountStorageError('corrupt');
  }

  if (
    typeof candidate.organization !== 'string' ||
    typeof candidate.email !== 'string' ||
    typeof candidate.onboardingComplete !== 'boolean' ||
    (candidate.onboardingStep !== 'connect' && candidate.onboardingStep !== 'done')
  ) {
    throw new LocalAccountStorageError('corrupt');
  }

  return candidate as LocalAccount;
}

export async function getAccount(): Promise<LocalAccount | null> {
  let stored: string | null;
  try {
    stored = await SecureStore.getItemAsync(STORAGE_KEY);
  } catch {
    throw new LocalAccountStorageError('unavailable');
  }

  return stored ? parseAccount(stored) : null;
}

async function saveAccount(account: LocalAccount): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, JSON.stringify(account));
  } catch {
    throw new LocalAccountStorageError('unavailable');
  }
}

async function requireAccount(): Promise<LocalAccount> {
  const account = await getAccount();
  if (!account) {
    throw new LocalAccountStorageError('corrupt');
  }
  return account;
}

export async function createAccount(
  name: string,
  password: string,
  biometricsEnabled: boolean,
): Promise<void> {
  const saltHex = bytesToHex(getRandomBytes(16));
  const hashHex = await derivePasswordHash(password, saltHex);
  const account: LocalAccount = {
    name,
    organization: '',
    email: '',
    saltHex,
    hashHex,
    passwordHashVersion: CURRENT_PASSWORD_HASH_VERSION,
    biometricsEnabled,
    onboardingComplete: true,
    onboardingStep: 'done',
    createdAt: Date.now(),
  };

  await saveAccount(account);
}

export async function createOnboardingAccount(
  profile: OnboardingProfile,
  password: string,
  biometricsEnabled: boolean,
): Promise<void> {
  const saltHex = bytesToHex(getRandomBytes(16));
  const hashHex = await derivePasswordHash(password, saltHex);
  const account: LocalAccount = {
    ...profile,
    saltHex,
    hashHex,
    passwordHashVersion: CURRENT_PASSWORD_HASH_VERSION,
    biometricsEnabled,
    onboardingComplete: false,
    onboardingStep: 'connect',
    createdAt: Date.now(),
  };
  await saveAccount(account);
}

export async function advanceOnboarding(
  step: PersistedOnboardingStep,
): Promise<void> {
  const account = await requireAccount();
  await saveAccount({ ...account, onboardingStep: step });
}

export async function completeOnboarding(): Promise<void> {
  const account = await requireAccount();
  await saveAccount({
    ...account,
    onboardingComplete: true,
    onboardingStep: 'done',
  });
}

export async function verifyPassword(password: string): Promise<boolean> {
  const account = await getAccount();
  if (!account) {
    return false;
  }
  const matches =
    (await derivePasswordHash(
      password,
      account.saltHex,
      account.passwordHashVersion,
    )) === account.hashHex;

  if (matches && account.passwordHashVersion !== CURRENT_PASSWORD_HASH_VERSION) {
    // The plaintext is only ever in hand right here, so this is the one chance
    // to move a legacy hash onto the current KDF. A failed write leaves the old
    // hash in place, which still verifies next time.
    const saltHex = bytesToHex(getRandomBytes(16));
    try {
      await saveAccount({
        ...account,
        saltHex,
        hashHex: await derivePasswordHash(password, saltHex),
        passwordHashVersion: CURRENT_PASSWORD_HASH_VERSION,
      });
    } catch {
      // Keep the unlock: the password was correct.
    }
  }
  return matches;
}

export async function setBiometricsEnabled(enabled: boolean): Promise<void> {
  const account = await getAccount();
  if (!account) {
    throw new Error('no local account');
  }

  await saveAccount({ ...account, biometricsEnabled: enabled });
}

export async function deleteAccount(): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(STORAGE_KEY);
    await clearUnlockThrottle();
  } catch {
    throw new LocalAccountStorageError('unavailable');
  }
}
