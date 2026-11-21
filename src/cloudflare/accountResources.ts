import {
  CloudflareApiError,
  getD1Database,
  listAccounts,
  listD1Databases,
  listKvNamespaces,
  listPagesProjects,
  listR2Buckets,
  listWorkerScripts,
  type CfD1Database,
  type CfKvNamespace,
  type CfPagesProject,
  type CfR2Bucket,
  type CfWorkerScript,
} from './api';
import { mapLimit } from '../utils/concurrency';
import { listConnections } from './connections';
import { getConnectionBearer, type ConnectionIssue } from './resources';
import { createTtlCache } from './ttlCache';

/** Ownership metadata attached to every account-scoped resource. */
export interface AccountScope {
  accountId: string;
  accountName: string;
  connectionId: string;
}

export interface R2BucketItem extends CfR2Bucket, AccountScope {}
export interface KvNamespaceItem extends CfKvNamespace, AccountScope {}
export interface D1DatabaseItem extends CfD1Database, AccountScope {}
export interface WorkerItem extends CfWorkerScript, AccountScope {}
export interface PagesProjectItem extends CfPagesProject, AccountScope {}

export interface StorageSnapshot {
  connectionCount: number;
  /** Every reachable account, including ones without storage resources. */
  accounts: AccountScope[];
  buckets: R2BucketItem[];
  kvNamespaces: KvNamespaceItem[];
  d1Databases: D1DatabaseItem[];
  issues: ConnectionIssue[];
}

export interface ComputeSnapshot {
  connectionCount: number;
  accounts: AccountScope[];
  workers: WorkerItem[];
  pages: PagesProjectItem[];
  issues: ConnectionIssue[];
}

export interface ResolvedAccount extends AccountScope {
  bearer: string;
}

interface ResolvedAccounts {
  connectionCount: number;
  accounts: ResolvedAccount[];
  issues: ConnectionIssue[];
}

async function resolveAccountsUncached(): Promise<ResolvedAccounts> {
  const connections = await listConnections();
  const issues: ConnectionIssue[] = [];
  const byAccount = new Map<string, ResolvedAccount>();
  // Collected per connection and merged afterwards in stored order. Merging as
  // each lookup lands would let whichever credential answers first own a
  // shared account, so the bearer behind it would change between refreshes.
  const resolved: ResolvedAccount[][] = connections.map(() => []);

  await Promise.all(
    connections.map(async (connection, index) => {
      try {
        const bearer = await getConnectionBearer(connection);
        if (!bearer) {
          throw new CloudflareApiError('missing-credential');
        }
        // Older connections may have been stored without their account list
        // (e.g. tokens that could not list accounts at connect time), so
        // re-discover live before giving up.
        const accounts =
          connection.accounts.length > 0
            ? connection.accounts
            : await listAccounts(bearer);
        resolved[index] = accounts.map((account) => ({
          accountId: account.id,
          accountName: account.name,
          connectionId: connection.id,
          bearer,
        }));
      } catch (cause) {
        if (__DEV__) {
          console.warn(
            `[accountResources] connection ${connection.label} failed:`,
            cause,
          );
        }
        issues.push({
          connectionId: connection.id,
          label: connection.label,
          cause:
            cause instanceof CloudflareApiError
              ? cause
              : new CloudflareApiError('api'),
        });
      }
    }),
  );

  for (const account of resolved.flat()) {
    if (!byAccount.has(account.accountId)) {
      byAccount.set(account.accountId, account);
    }
  }

  return {
    connectionCount: connections.length,
    accounts: [...byAccount.values()].sort((a, b) =>
      a.accountName.localeCompare(b.accountName),
    ),
    issues,
  };
}

const ACCOUNTS_TTL_MS = 30_000;

/**
 * Shared across the storage/compute snapshots and management helpers so one
 * cold load resolves credentials (SecureStore reads, OAuth renewal) once
 * instead of once per caller.
 */
const accountsCache = createTtlCache(ACCOUNTS_TTL_MS, resolveAccountsUncached);

/**
 * One bearer per distinct account: the same account can be reachable through
 * several credentials, and account-level data would only be duplicated.
 *
 * Returns fresh array instances on every call — callers append their own
 * issues to the result, which must never leak into the cached value.
 */
export async function resolveAccounts(options?: {
  force?: boolean;
}): Promise<ResolvedAccounts> {
  const resolved = await accountsCache.get(options);
  return {
    connectionCount: resolved.connectionCount,
    accounts: [...resolved.accounts],
    issues: [...resolved.issues],
  };
}

export function invalidateResolvedAccounts(): void {
  accountsCache.invalidate();
}

/**
 * Bearer for one account, served from the shared resolution cache so
 * metrics fetches after a snapshot do not re-read the keychain per account.
 */
export async function getAccountBearer(accountId: string): Promise<string> {
  const { accounts } = await resolveAccounts();
  const bearer = accounts.find(
    (account) => account.accountId === accountId,
  )?.bearer;
  if (!bearer) {
    throw new CloudflareApiError('missing-credential');
  }
  return bearer;
}

/** Records at most one issue per account so missing scopes stay readable. */
function pushIssue(
  issues: ConnectionIssue[],
  account: ResolvedAccount,
  cause: unknown,
): void {
  if (__DEV__) {
    console.warn(
      `[accountResources] ${account.accountName} fetch failed:`,
      cause,
    );
  }
  if (issues.some((issue) => issue.label === account.accountName)) {
    return;
  }
  issues.push({
    connectionId: account.connectionId,
    label: account.accountName,
    cause:
      cause instanceof CloudflareApiError
        ? cause
        : new CloudflareApiError('api'),
  });
}

const D1_DETAIL_LIMIT = 10;

/**
 * Accounts resolved at once. Each one fans out into several list calls (and D1
 * detail lookups on top), so an unbounded outer loop turns a credential with
 * many accounts into a burst big enough to be rate limited.
 */
const ACCOUNT_CONCURRENCY = 3;

/** Per-item detail lookups in flight inside one account. */
const DETAIL_CONCURRENCY = 4;

async function fetchStorage(): Promise<StorageSnapshot> {
  const { connectionCount, accounts, issues } = await resolveAccounts();
  const buckets: R2BucketItem[] = [];
  const kvNamespaces: KvNamespaceItem[] = [];
  const d1Databases: D1DatabaseItem[] = [];

  await mapLimit(accounts, ACCOUNT_CONCURRENCY, async (account) => {
    const scope = {
      accountId: account.accountId,
      accountName: account.accountName,
      connectionId: account.connectionId,
    };
    await Promise.all([
      listR2Buckets(account.bearer, account.accountId)
        .then((items) =>
          buckets.push(...items.map((item) => ({ ...item, ...scope }))),
        )
        .catch((cause) => pushIssue(issues, account, cause)),
      listKvNamespaces(account.bearer, account.accountId)
        .then((items) =>
          kvNamespaces.push(...items.map((item) => ({ ...item, ...scope }))),
        )
        .catch((cause) => pushIssue(issues, account, cause)),
      listD1Databases(account.bearer, account.accountId)
        .then(async (items) => {
          // The list response may omit size/tables; backfill a few details.
          const detailed = await mapLimit(
            items,
            DETAIL_CONCURRENCY,
            async (item, index) => {
              if (item.fileSize !== null || index >= D1_DETAIL_LIMIT) {
                return item;
              }
              return getD1Database(
                account.bearer,
                account.accountId,
                item.uuid,
              ).catch(() => item);
            },
          );
          d1Databases.push(...detailed.map((item) => ({ ...item, ...scope })));
        })
        .catch((cause) => pushIssue(issues, account, cause)),
    ]);
  });

  const byName = <T extends { name: string }>(a: T, b: T) =>
    a.name.localeCompare(b.name);
  buckets.sort(byName);
  kvNamespaces.sort((a, b) => a.title.localeCompare(b.title));
  d1Databases.sort(byName);

  return {
    connectionCount,
    accounts: accounts.map(({ accountId, accountName, connectionId }) => ({
      accountId,
      accountName,
      connectionId,
    })),
    buckets,
    kvNamespaces,
    d1Databases,
    issues,
  };
}

async function fetchCompute(): Promise<ComputeSnapshot> {
  const startedAt = Date.now();
  const { connectionCount, accounts, issues } = await resolveAccounts();
  const workers: WorkerItem[] = [];
  const pages: PagesProjectItem[] = [];

  await mapLimit(accounts, ACCOUNT_CONCURRENCY, async (account) => {
    const scope = {
      accountId: account.accountId,
      accountName: account.accountName,
      connectionId: account.connectionId,
    };
    await Promise.all([
      listWorkerScripts(account.bearer, account.accountId)
        .then((items) => {
          if (__DEV__) {
            console.log(
              `[compute] ${account.accountName}: ${items.length} workers`,
            );
          }
          workers.push(...items.map((item) => ({ ...item, ...scope })));
        })
        .catch((cause) => pushIssue(issues, account, cause)),
      listPagesProjects(account.bearer, account.accountId)
        .then((items) => {
          if (__DEV__) {
            console.log(
              `[compute] ${account.accountName}: ${items.length} pages projects`,
            );
          }
          pages.push(...items.map((item) => ({ ...item, ...scope })));
        })
        .catch((cause) => pushIssue(issues, account, cause)),
    ]);
  });

  workers.sort((a, b) => a.id.localeCompare(b.id));
  pages.sort((a, b) => a.name.localeCompare(b.name));

  if (__DEV__) {
    console.log(`[compute] snapshot loaded in ${Date.now() - startedAt}ms`);
  }

  return {
    connectionCount,
    accounts: accounts.map(({ accountId, accountName, connectionId }) => ({
      accountId,
      accountName,
      connectionId,
    })),
    workers,
    pages,
    issues,
  };
}

const SNAPSHOT_TTL_MS = 30_000;

const storageCache = createTtlCache(SNAPSHOT_TTL_MS, fetchStorage);
const computeCache = createTtlCache(SNAPSHOT_TTL_MS, fetchCompute);

export function fetchStorageSnapshot(options?: {
  force?: boolean;
}): Promise<StorageSnapshot> {
  return storageCache.get(options);
}

export function fetchComputeSnapshot(options?: {
  force?: boolean;
}): Promise<ComputeSnapshot> {
  return computeCache.get(options);
}

export function invalidateStorageSnapshot(): void {
  storageCache.invalidate();
  // A forced refresh should re-check credentials too (e.g. renewed OAuth).
  accountsCache.invalidate();
}

export function invalidateComputeSnapshot(): void {
  computeCache.invalidate();
  accountsCache.invalidate();
}
