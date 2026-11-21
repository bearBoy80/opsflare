import * as SecureStore from 'expo-secure-store';
import {
  listAccounts,
  listZones,
  verifyToken,
  type CfAccountRef,
} from './api';
import {
  revokeOauthTokens,
  type OauthIdentity,
  type OauthTokens,
} from './oauth';

/** Placeholder labels we replace once a real account name is discovered. */
const PLACEHOLDER_LABELS = new Set(['API Token', 'Cloudflare OAuth']);

const CONNECTIONS_KEY = 'cf-connections-v1';

const tokenKey = (connectionId: string) => `cf-token-${connectionId}`;
const oauthKey = (connectionId: string) => `cf-oauth-${connectionId}`;

export type ConnectionAuthType = 'token' | 'oauth';

export interface CloudflareConnection {
  /**
   * Cloudflare token id for API tokens, or `oauth-<sub>` for OAuth grants.
   * Stable ids make re-adding the same credential idempotent.
   */
  id: string;
  label: string;
  authType: ConnectionAuthType;
  accounts: CfAccountRef[];
  createdAt: number;
}

function parseConnections(stored: string | null): CloudflareConnection[] {
  if (!stored) {
    return [];
  }

  let value: unknown;
  try {
    value = JSON.parse(stored);
  } catch {
    return [];
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter(
      (item): item is CloudflareConnection =>
        !!item &&
        typeof item === 'object' &&
        typeof (item as CloudflareConnection).id === 'string' &&
        typeof (item as CloudflareConnection).label === 'string' &&
        Array.isArray((item as CloudflareConnection).accounts),
    )
    .map((item) => ({
      ...item,
      // Entries persisted before OAuth support are API tokens.
      authType: item.authType === 'oauth' ? 'oauth' : 'token',
    }));
}

/**
 * The connection list is read on every snapshot and bearer lookup, and each
 * SecureStore read is a native keychain round trip. All writes go through
 * saveConnections, so a plain memory cache stays correct for the process
 * lifetime. Only credential metadata lives here; tokens stay in SecureStore.
 */
let connectionsCache: CloudflareConnection[] | null = null;

export async function listConnections(): Promise<CloudflareConnection[]> {
  if (connectionsCache && connectionsCache.length > 0) {
    return connectionsCache;
  }
  const stored = await SecureStore.getItemAsync(CONNECTIONS_KEY);
  const parsed = parseConnections(stored);
  // Never pin an empty read: keychain reads can transiently return nothing
  // (app prewarming, lock-state races), and caching that would make the app
  // "forget" its connections until the next launch.
  connectionsCache = parsed.length > 0 ? parsed : null;
  return parsed;
}

/** Drops the in-memory connection list. Test helper. */
export function resetConnectionsCache(): void {
  connectionsCache = null;
}

async function saveConnections(
  connections: CloudflareConnection[],
): Promise<void> {
  await SecureStore.setItemAsync(
    CONNECTIONS_KEY,
    JSON.stringify(connections),
  );
  connectionsCache = connections;
}

async function upsertConnection(
  connection: CloudflareConnection,
): Promise<void> {
  const existing = await listConnections();
  await saveConnections([
    ...existing.filter((item) => item.id !== connection.id),
    connection,
  ]);
}

/**
 * Resolves the accounts a credential can manage. Prefers the `/accounts`
 * endpoint, but zone-scoped API tokens can't read it — for those we derive the
 * owning account(s) from the token's zones, which always carry `account`.
 */
export async function discoverAccounts(
  token: string,
): Promise<CfAccountRef[]> {
  let accounts: CfAccountRef[] = [];
  try {
    accounts = await listAccounts(token);
  } catch {
    accounts = [];
  }
  if (accounts.length > 0) {
    return accounts;
  }

  try {
    const zones = await listZones(token);
    const byId = new Map<string, string>();
    for (const zone of zones) {
      if (zone.accountId) {
        byId.set(zone.accountId, zone.accountName || zone.accountId);
      }
    }
    return [...byId.entries()].map(([id, name]) => ({ id, name }));
  } catch {
    return [];
  }
}

/**
 * Persists a freshly discovered account list onto an existing connection and
 * upgrades a placeholder label to the real account name. Used to heal
 * credentials stored before account discovery could see their zones.
 */
export async function setConnectionAccounts(
  connectionId: string,
  accounts: CfAccountRef[],
): Promise<CloudflareConnection | null> {
  const existing = await listConnections();
  const target = existing.find((item) => item.id === connectionId);
  if (!target) {
    return null;
  }
  const updated: CloudflareConnection = {
    ...target,
    accounts,
    label:
      target.label && !PLACEHOLDER_LABELS.has(target.label)
        ? target.label
        : accounts[0]?.name ?? target.label,
  };
  await saveConnections([
    ...existing.filter((item) => item.id !== connectionId),
    updated,
  ]);
  return updated;
}

/**
 * Verifies the API token against Cloudflare, discovers the accounts it can
 * see, and persists the credential. Re-adding the same token replaces the
 * existing entry instead of duplicating it.
 */
export async function addConnection(
  token: string,
  label?: string,
): Promise<CloudflareConnection> {
  const trimmed = token.trim();
  const verification = await verifyToken(trimmed);
  const accounts = await discoverAccounts(trimmed);

  const connection: CloudflareConnection = {
    id: verification.id,
    label:
      label?.trim() ||
      (accounts.length > 0 ? accounts[0].name : 'API Token'),
    authType: 'token',
    accounts,
    createdAt: Date.now(),
  };

  await SecureStore.setItemAsync(tokenKey(connection.id), trimmed);
  await upsertConnection(connection);
  return connection;
}

/**
 * Persists an OAuth grant after the PKCE flow: discovers the accounts the
 * access token can see and stores the token bundle in the keychain. Repeated
 * grants by the same Cloudflare user replace the existing entry.
 */
export async function addOauthConnection(
  tokens: OauthTokens,
  identity: OauthIdentity,
): Promise<CloudflareConnection> {
  const accounts = await discoverAccounts(tokens.accessToken);

  const connection: CloudflareConnection = {
    id: `oauth-${identity.sub}`,
    label:
      identity.email ||
      (accounts.length > 0 ? accounts[0].name : 'Cloudflare OAuth'),
    authType: 'oauth',
    accounts,
    createdAt: Date.now(),
  };

  await SecureStore.setItemAsync(
    oauthKey(connection.id),
    JSON.stringify(tokens),
  );
  await upsertConnection(connection);
  return connection;
}

/**
 * Deletes a credential.
 *
 * The secrets go first and the list entry last: if a keychain call fails
 * halfway, the connection is still listed (and can be removed again) instead
 * of leaving a token in the keychain that nothing points to any more.
 *
 * OAuth grants are also revoked at Cloudflare, so disconnecting really cuts
 * the app off. That call is best-effort and not awaited — the local removal
 * must not hang on a slow network, and a failed revoke still leaves the grant
 * unusable from this device.
 */
export async function removeConnection(connectionId: string): Promise<void> {
  const oauthTokens = await getConnectionOauthTokens(connectionId).catch(
    () => null,
  );

  await SecureStore.deleteItemAsync(tokenKey(connectionId));
  await SecureStore.deleteItemAsync(oauthKey(connectionId));
  const existing = await listConnections();
  await saveConnections(existing.filter((item) => item.id !== connectionId));

  if (oauthTokens) {
    void Promise.resolve()
      .then(() => revokeOauthTokens(oauthTokens))
      .catch(() => {});
  }
}

/** Deletes every stored credential, e.g. when the local account is reset. */
export async function removeAllConnections(): Promise<void> {
  const existing = await listConnections();
  for (const connection of existing) {
    await removeConnection(connection.id);
  }
  // Also drop the list itself, in case it held entries the parser rejected.
  await SecureStore.deleteItemAsync(CONNECTIONS_KEY);
  connectionsCache = null;
}

export async function getConnectionToken(
  connectionId: string,
): Promise<string | null> {
  return SecureStore.getItemAsync(tokenKey(connectionId));
}

export async function getConnectionOauthTokens(
  connectionId: string,
): Promise<OauthTokens | null> {
  const stored = await SecureStore.getItemAsync(oauthKey(connectionId));
  if (!stored) {
    return null;
  }
  try {
    return JSON.parse(stored) as OauthTokens;
  } catch {
    return null;
  }
}

export async function updateConnectionOauthTokens(
  connectionId: string,
  tokens: OauthTokens,
): Promise<void> {
  await SecureStore.setItemAsync(
    oauthKey(connectionId),
    JSON.stringify(tokens),
  );
}
