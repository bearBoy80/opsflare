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

jest.mock('../api', () => ({
  verifyToken: jest.fn(),
  listAccounts: jest.fn(),
}));

jest.mock('../oauth', () => ({
  revokeOauthTokens: jest.fn(async () => {}),
}));

import * as SecureStore from 'expo-secure-store';
import { listAccounts, verifyToken } from '../api';
import { revokeOauthTokens } from '../oauth';
import {
  addConnection,
  addOauthConnection,
  getConnectionOauthTokens,
  getConnectionToken,
  listConnections,
  removeAllConnections,
  removeConnection,
  resetConnectionsCache,
} from '../connections';

beforeEach(() => {
  jest.clearAllMocks();
  mockStore.clear();
  resetConnectionsCache();
  jest
    .mocked(verifyToken)
    .mockResolvedValue({ id: 'tok-1', status: 'active' });
  jest.mocked(listAccounts).mockResolvedValue([
    { id: 'acc-1', name: 'Acme Corp' },
  ]);
});

test('starts with no connections', async () => {
  await expect(listConnections()).resolves.toEqual([]);
});

test('adds a connection after verifying the token', async () => {
  const connection = await addConnection(' secret-token ');

  expect(connection.id).toBe('tok-1');
  expect(connection.label).toBe('Acme Corp');
  expect(connection.accounts).toEqual([{ id: 'acc-1', name: 'Acme Corp' }]);

  await expect(listConnections()).resolves.toHaveLength(1);
  await expect(getConnectionToken('tok-1')).resolves.toBe('secret-token');
});

test('re-adding the same token replaces the entry', async () => {
  await addConnection('secret-token');
  jest.mocked(listAccounts).mockResolvedValue([
    { id: 'acc-1', name: 'Acme Corp' },
    { id: 'acc-2', name: 'Side Project' },
  ]);

  await addConnection('secret-token');

  const connections = await listConnections();
  expect(connections).toHaveLength(1);
  expect(connections[0].accounts).toHaveLength(2);
});

test('does not persist anything when verification fails', async () => {
  jest
    .mocked(verifyToken)
    .mockRejectedValue(new Error('invalid'));

  await expect(addConnection('bad-token')).rejects.toThrow('invalid');
  await expect(listConnections()).resolves.toEqual([]);
});

test('removes the connection and its token', async () => {
  await addConnection('secret-token');

  await removeConnection('tok-1');

  await expect(listConnections()).resolves.toEqual([]);
  await expect(getConnectionToken('tok-1')).resolves.toBeNull();
});

test('treats corrupt metadata as empty', async () => {
  mockStore.set('cf-connections-v1', 'not-json');

  await expect(listConnections()).resolves.toEqual([]);
});

test('does not pin a transient empty keychain read', async () => {
  // First read races the lock state and sees nothing.
  await expect(listConnections()).resolves.toEqual([]);

  // The keychain becomes readable again; the empty result must not stick.
  mockStore.set(
    'cf-connections-v1',
    JSON.stringify([
      { id: 'tok-1', label: 'Acme', accounts: [], createdAt: 1 },
    ]),
  );
  await expect(listConnections()).resolves.toHaveLength(1);
});

test('serves repeated list calls from memory after one keychain read', async () => {
  mockStore.set(
    'cf-connections-v1',
    JSON.stringify([
      { id: 'tok-1', label: 'Acme', accounts: [], createdAt: 1 },
    ]),
  );

  await listConnections();
  await listConnections();

  expect(jest.mocked(SecureStore.getItemAsync)).toHaveBeenCalledTimes(1);
});

test('mutations keep the memory cache in sync', async () => {
  await addConnection('secret-token');
  jest.mocked(SecureStore.getItemAsync).mockClear();

  // Served from the cache updated by the write.
  await expect(listConnections()).resolves.toHaveLength(1);
  expect(jest.mocked(SecureStore.getItemAsync)).not.toHaveBeenCalledWith(
    'cf-connections-v1',
  );

  // Removing the last connection empties the cache; empty lists are never
  // trusted from memory, so the next call re-reads the keychain.
  await removeConnection('tok-1');
  await expect(listConnections()).resolves.toEqual([]);
});

test('marks entries persisted before OAuth support as token auth', async () => {
  mockStore.set(
    'cf-connections-v1',
    JSON.stringify([
      { id: 'tok-legacy', label: 'Old', accounts: [], createdAt: 1 },
    ]),
  );

  const [legacy] = await listConnections();
  expect(legacy.authType).toBe('token');
});

describe('OAuth connections', () => {
  const tokens = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: 1700003600000,
  };
  const identity = { sub: 'user-1', email: 'sarah@acme.com' };

  test('persists the grant keyed by the Cloudflare user', async () => {
    const connection = await addOauthConnection(tokens, identity);

    expect(connection.id).toBe('oauth-user-1');
    expect(connection.authType).toBe('oauth');
    expect(connection.label).toBe('sarah@acme.com');
    await expect(getConnectionOauthTokens('oauth-user-1')).resolves.toEqual(
      tokens,
    );
  });

  test('repeated grants by the same user replace the entry', async () => {
    await addOauthConnection(tokens, identity);
    await addOauthConnection(
      { ...tokens, accessToken: 'newer' },
      identity,
    );

    const connections = await listConnections();
    expect(connections).toHaveLength(1);
    await expect(
      getConnectionOauthTokens('oauth-user-1'),
    ).resolves.toMatchObject({ accessToken: 'newer' });
  });

  test('remove deletes the stored token bundle', async () => {
    await addOauthConnection(tokens, identity);

    await removeConnection('oauth-user-1');

    await expect(listConnections()).resolves.toEqual([]);
    await expect(
      getConnectionOauthTokens('oauth-user-1'),
    ).resolves.toBeNull();
  });

  test('remove revokes the grant at Cloudflare', async () => {
    await addOauthConnection(tokens, identity);

    await removeConnection('oauth-user-1');
    await Promise.resolve();

    expect(revokeOauthTokens).toHaveBeenCalledWith(tokens);
  });

  test('a failed revoke does not fail the local removal', async () => {
    jest.mocked(revokeOauthTokens).mockRejectedValueOnce(new Error('offline'));
    await addOauthConnection(tokens, identity);

    await expect(removeConnection('oauth-user-1')).resolves.toBeUndefined();
    await expect(listConnections()).resolves.toEqual([]);
  });
});

test('a failed secret delete keeps the connection listed for a retry', async () => {
  await addConnection('secret-token');
  jest
    .mocked(SecureStore.deleteItemAsync)
    .mockRejectedValueOnce(new Error('keychain busy'));

  await expect(removeConnection('tok-1')).rejects.toThrow('keychain busy');

  // Still listed, so the user can disconnect again instead of the token
  // lingering in the keychain with nothing pointing at it.
  await expect(listConnections()).resolves.toHaveLength(1);
  await expect(removeConnection('tok-1')).resolves.toBeUndefined();
  await expect(getConnectionToken('tok-1')).resolves.toBeNull();
});

test('removeAllConnections wipes every credential and the list', async () => {
  await addConnection('secret-token');
  await addOauthConnection(
    { accessToken: 'access', refreshToken: 'refresh' },
    { sub: 'user-1' },
  );

  await removeAllConnections();

  await expect(listConnections()).resolves.toEqual([]);
  expect(mockStore.size).toBe(0);
});
