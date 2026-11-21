import Constants from 'expo-constants';
import {
  exchangeCodeAsync,
  refreshAsync,
  revokeAsync,
  TokenError,
  TokenTypeHint,
  type AuthRequest,
  type AuthSessionResult,
  type DiscoveryDocument,
  type TokenResponse,
} from 'expo-auth-session';
import * as WebBrowser from 'expo-web-browser';
import { suspendAutoLock } from '../auth/autoLock';
import { CloudflareApiError } from './api';

/**
 * Self-managed OAuth client endpoints, see
 * https://developers.cloudflare.com/fundamentals/oauth/integrate-with-cloudflare/
 */
export const discovery: DiscoveryDocument = {
  authorizationEndpoint: 'https://dash.cloudflare.com/oauth2/auth',
  tokenEndpoint: 'https://dash.cloudflare.com/oauth2/token',
  revocationEndpoint: 'https://dash.cloudflare.com/oauth2/revoke',
  userInfoEndpoint: 'https://dash.cloudflare.com/oauth2/userinfo',
};

/**
 * Scope ids as returned by `GET /client/v4/oauth/scopes`. They do not follow
 * the API-token permission names: the account scope is `account-settings.read`
 * (not `account.read`), Workers is `workers-scripts.read`, KV is
 * `workers-kv-storage.read` and Pages is `page.read` (singular).
 *
 * Registering scopes on the OAuth client only decides what may be asked for —
 * the authorization request still has to enumerate every scope it wants.
 */
const DEFAULT_SCOPES = [
  // Accounts and audit log. Note this does *not* cover billing: subscriptions
  // need `Billing Read`, which Cloudflare does not expose as an OAuth scope at
  // all, so that screen is reachable only through an API token.
  'account-settings.read',
  // Zones and their settings.
  'zone.read',
  'zone.write',
  'zone-settings.read',
  'zone-settings.write',
  'ssl-and-certificates.read',
  'cache.purge',
  'dns.read',
  'dns.write',
  'firewall-services.read',
  // Storage.
  'workers-r2.read',
  'workers-r2.write',
  'workers-kv-storage.read',
  'workers-kv-storage.write',
  'd1.read',
  'd1.write',
  // Compute.
  'workers-scripts.read',
  'workers-scripts.write',
  'workers-routes.read',
  'workers-routes.write',
  'page.read',
  'page.write',
  // Insights.
  'analytics.read',
  'account-analytics.read',
  'load-balancers.read',
  'load-balancing-monitors-and-pools.read',
  'notifications.read',
];

/**
 * Cloudflare's OAuth server (Hydra) only issues a refresh token when this
 * scope is requested, no matter which grant types the client registered.
 * Without it every session dies silently once the access token expires, so it
 * is appended here rather than left to each caller.
 */
const REFRESH_SCOPE = 'offline_access';

interface OauthConfig {
  clientId: string;
  /**
   * Public URL of the callback relay, registered on the OAuth client. It has
   * to be `https`: Cloudflare rejects private-use schemes outright.
   */
  redirectUri: string;
  scopes: string[];
}

export function getOauthConfig(): OauthConfig | null {
  const extra = Constants.expoConfig?.extra?.cloudflareOauth as
    | Partial<OauthConfig>
    | undefined;

  const clientId = extra?.clientId?.trim() ?? '';
  const configuredRedirect = extra?.redirectUri?.trim() ?? '';
  if (clientId.length === 0 || configuredRedirect.length === 0) {
    return null;
  }

  const configured =
    Array.isArray(extra?.scopes) && extra.scopes.length > 0
      ? extra.scopes
      : DEFAULT_SCOPES;

  return {
    clientId,
    redirectUri: configuredRedirect,
    scopes: configured.includes(REFRESH_SCOPE)
      ? configured
      : [...configured, REFRESH_SCOPE],
  };
}

/**
 * Where the callback relay sends the browser to re-enter the app. This is *not*
 * the registered redirect URI — Cloudflare never sees it, and it must not be
 * used when exchanging the code.
 *
 * Deliberately a constant instead of `makeRedirectUri`: that helper builds a
 * link back to the *current* environment, so a development build gets the Metro
 * host spliced in (`opsflare://192.168.x.x:8081/oauth/callback`) and Expo Go
 * gets an `exp://` scheme entirely. The relay always redirects to one fixed
 * URL, and `ASWebAuthenticationSession` only intercepts the scheme it was
 * started with, so this value has to be stable across environments and match
 * the relay.
 */
export const appCallbackUrl = 'opsflare://oauth/callback';

/**
 * Runs the browser half of the flow.
 *
 * Cloudflare demands an `https` redirect URI while iOS can only intercept a
 * private-use scheme, and `AuthRequest.promptAsync` listens on whatever it sent
 * as `redirect_uri`. So the URL is built with the relay address and the session
 * is opened against the app scheme by hand. `parseReturnUrl` still performs the
 * `state` check.
 */
export async function authorize(
  request: AuthRequest,
): Promise<AuthSessionResult> {
  const url = await request.makeAuthUrlAsync(discovery);

  if (__DEV__) {
    console.log('[oauth] authorize url:', url);
    console.log('[oauth] intercepting scheme of:', appCallbackUrl);
  }

  // Presenting the session drops the app out of the foreground, which would
  // otherwise re-lock the console and unmount the screen waiting for the code.
  const releaseAutoLock = suspendAutoLock();
  let result: Awaited<ReturnType<typeof WebBrowser.openAuthSessionAsync>>;
  try {
    result = await WebBrowser.openAuthSessionAsync(url, appCallbackUrl);
  } finally {
    releaseAutoLock();
  }

  if (__DEV__) {
    // Only the outcome: the callback url carries the authorization code, and
    // dev consoles end up in shared terminals and screen recordings.
    console.log('[oauth] session result:', result.type);
  }

  if (result.type !== 'success') {
    return { type: result.type } as AuthSessionResult;
  }

  return request.parseReturnUrl(result.url);
}

export interface OauthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Epoch milliseconds after which the access token must be refreshed. */
  expiresAt?: number;
  /**
   * Space-separated scopes the token was actually granted, which is not
   * necessarily what was requested. Adding scopes to the OAuth client does not
   * upgrade tokens that were already issued, so this is the only way to tell a
   * stale grant apart from an endpoint that has no scope at all.
   */
  scope?: string;
}

function toOauthTokens(response: TokenResponse): OauthTokens {
  return {
    accessToken: response.accessToken,
    refreshToken: response.refreshToken,
    expiresAt: response.expiresIn
      ? (response.issuedAt + response.expiresIn) * 1000
      : undefined,
    scope: response.scope,
  };
}

/**
 * Completes the Authorization Code + PKCE flow after the browser redirect,
 * exchanging the code (with the request's code verifier) for tokens.
 */
export async function exchangeAuthorizationCode(
  request: AuthRequest,
  result: AuthSessionResult,
): Promise<OauthTokens> {
  if (result.type !== 'success' || !result.params.code) {
    if (result.type === 'error') {
      throw new CloudflareApiError('oauth-failed', result.error?.description);
    }
    throw new CloudflareApiError('oauth-cancelled');
  }

  const config = getOauthConfig();
  if (!config) {
    throw new CloudflareApiError('oauth-config');
  }

  let response: TokenResponse;
  try {
    response = await exchangeCodeAsync(
      {
        clientId: config.clientId,
        code: result.params.code,
        // Must be the value sent in the authorization request, not the app
        // scheme the relay bounced us back through.
        redirectUri: config.redirectUri,
        extraParams: request.codeVerifier
          ? { code_verifier: request.codeVerifier }
          : undefined,
      },
      discovery,
    );
  } catch (cause) {
    // A `TokenError` means the token endpoint answered and rejected us — a
    // spent or expired code, a redirect that does not match the authorization
    // request, a bad PKCE verifier. Only a request that never got an answer is
    // a connectivity problem, and calling the two the same thing sends the
    // user off to check their signal over an authorization they can just retry.
    if (cause instanceof TokenError) {
      throw new CloudflareApiError(
        'oauth-failed',
        cause.params.error_description,
      );
    }
    throw new CloudflareApiError('network');
  }

  const tokens = toOauthTokens(response);

  if (__DEV__) {
    // A `forbidden` on a screen usually means the scope is missing here, not
    // that the request is wrong.
    console.log('[oauth] granted scope:', tokens.scope ?? '(none reported)');
    console.log('[oauth] refresh token issued:', Boolean(tokens.refreshToken));
  }

  return tokens;
}

export async function refreshOauthTokens(
  refreshToken: string,
): Promise<OauthTokens> {
  const config = getOauthConfig();
  if (!config) {
    throw new CloudflareApiError('oauth-config');
  }

  let response: TokenResponse;
  try {
    response = await refreshAsync(
      { clientId: config.clientId, refreshToken },
      discovery,
    );
  } catch (cause) {
    // Only a rejection from the token endpoint means the grant is really gone.
    // A request that never completed leaves the refresh token perfectly usable,
    // so reporting that as an expired session would walk the user through a
    // reconnect that a working connection would have made unnecessary.
    if (cause instanceof TokenError) {
      throw new CloudflareApiError('session-expired');
    }
    throw new CloudflareApiError('network');
  }

  return toOauthTokens(response);
}

export interface OauthIdentity {
  /** Stable subject id of the Cloudflare user that granted access. */
  sub: string;
  email?: string;
}

export async function fetchOauthIdentity(
  accessToken: string,
): Promise<OauthIdentity> {
  let response: Response;
  try {
    response = await fetch(discovery.userInfoEndpoint as string, {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
  } catch {
    throw new CloudflareApiError('network');
  }

  if (response.status === 401 || response.status === 403) {
    throw new CloudflareApiError('invalid-token');
  }

  let body: { sub?: string; email?: string };
  try {
    body = (await response.json()) as { sub?: string; email?: string };
  } catch {
    throw new CloudflareApiError('api');
  }

  if (!body.sub) {
    throw new CloudflareApiError('identity');
  }

  return { sub: body.sub, email: body.email };
}

/**
 * Revokes a grant at Cloudflare. Revoking the refresh token ends the whole
 * grant; the access token is revoked as well for servers that treat them
 * separately. Failures are left to the caller, which treats this as
 * best-effort.
 */
export async function revokeOauthTokens(tokens: OauthTokens): Promise<void> {
  const config = getOauthConfig();
  if (!config) {
    return;
  }
  if (tokens.refreshToken) {
    await revokeAsync(
      {
        clientId: config.clientId,
        token: tokens.refreshToken,
        tokenTypeHint: TokenTypeHint.RefreshToken,
      },
      discovery,
    );
  }
  await revokeAsync(
    {
      clientId: config.clientId,
      token: tokens.accessToken,
      tokenTypeHint: TokenTypeHint.AccessToken,
    },
    discovery,
  );
}
