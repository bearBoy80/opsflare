import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { AppState } from 'react-native';
import { isAutoLockSuspended } from './autoLock';
import { wipeCloudflareData } from '../cloudflare/wipe';
import {
  deleteAccount,
  getAccount,
  LocalAccountStorageError,
} from './localAccount';

/** Error key for a storage failure that a retry may clear. */
export const ACCOUNT_UNAVAILABLE_KEY = 'errors.account-unavailable';

/**
 * Only data that was read and found invalid gets the destructive reset. A
 * keychain that is merely unavailable (prewarm before first unlock, a lock
 * state race) holds a perfectly good login, so it is offered a retry instead.
 */
function errorKeyFor(cause: unknown): string {
  return cause instanceof LocalAccountStorageError && cause.code === 'corrupt'
    ? 'errors.account-unreadable'
    : ACCOUNT_UNAVAILABLE_KEY;
}

export type AuthStatus =
  | 'loading'
  | 'no-account'
  | 'onboarding'
  | 'locked'
  | 'unlocked'
  | 'error';

interface AuthValue {
  status: AuthStatus;
  /** i18n resource key describing the account error, translated at display. */
  errorKey: string | null;
  unlock: () => void;
  lock: () => void;
  /**
   * Onboarding has just stored the local account. From here on a password
   * exists, so leaving the app re-locks it like the console does.
   */
  onAccountCreated: () => void;
  /**
   * Onboarding finished and was persisted. `interrupted` reports that the app
   * left the foreground while the completion was being written.
   */
  onOnboardingCompleted: (options?: { interrupted?: boolean }) => void;
  reportAccountError: (cause?: unknown) => void;
  /** Re-reads the local account after a transient storage failure. */
  retryAccount: () => void;
  resetAccount: () => Promise<void>;
}

const AuthContext = createContext<AuthValue | null>(null);

export function AuthGateProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [status, setStatus] = useState<AuthStatus>('loading');
  const [errorKey, setErrorKey] = useState<string | null>(null);
  // iOS prewarming can start the process while backgrounded, so derive the
  // initial foreground state instead of assuming `true`. `currentState` may
  // still be null this early, which we treat as foreground.
  const isForeground = useRef(AppState.currentState !== 'background');

  const [loadAttempt, setLoadAttempt] = useState(0);
  /**
   * A local account (and so a password) exists. Onboarding before that point
   * has nothing to protect; after it, the Connect step may already have
   * stored a Cloudflare credential.
   */
  const hasAccount = useRef(false);
  /** Unlocking lands back in onboarding rather than the console. */
  const resumeOnboarding = useRef(false);

  useEffect(() => {
    let active = true;

    void getAccount()
      .then((account) => {
        if (active) {
          hasAccount.current = account !== null;
          resumeOnboarding.current =
            account !== null && !account.onboardingComplete;
          setErrorKey(null);
          // Any stored account starts locked, finished or not: an onboarding
          // abandoned after the Connect step already holds a Cloudflare
          // credential, and resuming it must not skip the password.
          setStatus(account ? 'locked' : 'no-account');
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          setErrorKey(errorKeyFor(cause));
          setStatus('error');
        }
      });

    return () => {
      active = false;
    };
  }, [loadAttempt]);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        isForeground.current = true;
        return;
      }
      // A sheet we put up ourselves — the OAuth session or the biometric
      // prompt — also resigns the active state. The user never left, so this
      // must not lock, and it must not mark us as backgrounded either: the
      // completion that follows would then be discarded as a late arrival.
      if (isAutoLockSuspended()) {
        return;
      }
      isForeground.current = false;
      setStatus((current) =>
        current === 'unlocked' ||
        (current === 'onboarding' && hasAccount.current)
          ? 'locked'
          : current,
      );
    });

    return () => subscription.remove();
  }, []);

  const value = useMemo<AuthValue>(
    () => ({
      status,
      errorKey,
      unlock: () => {
        if (!isForeground.current) {
          return;
        }
        setErrorKey(null);
        setStatus(resumeOnboarding.current ? 'onboarding' : 'unlocked');
      },
      lock: () => setStatus('locked'),
      onAccountCreated: () => {
        hasAccount.current = true;
        resumeOnboarding.current = true;
        // A first-time user is still `no-account` here. Both statuses show the
        // onboarding screen, but only `onboarding` re-locks on background.
        setStatus((current) =>
          current === 'no-account' ? 'onboarding' : current,
        );
      },
      onOnboardingCompleted: (options) => {
        resumeOnboarding.current = false;
        setErrorKey(null);
        setStatus(
          isForeground.current && !options?.interrupted ? 'unlocked' : 'locked',
        );
      },
      reportAccountError: (cause?: unknown) => {
        setErrorKey(errorKeyFor(cause));
        setStatus('error');
      },
      retryAccount: () => {
        setStatus('loading');
        setLoadAttempt((attempt) => attempt + 1);
      },
      resetAccount: async () => {
        try {
          // Credentials first: if this fails the login is still there and the
          // reset can be retried, instead of orphaning tokens for the next
          // account created on this device.
          await wipeCloudflareData();
          await deleteAccount();
          hasAccount.current = false;
          resumeOnboarding.current = false;
          setErrorKey(null);
          setStatus('no-account');
        } catch {
          setErrorKey('errors.account-reset-failed');
          setStatus('error');
        }
      },
    }),
    [errorKey, status],
  );

  return (
    <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
  );
}

export function useAuth(): AuthValue {
  const value = useContext(AuthContext);
  if (!value) {
    throw new Error('useAuth must be used within AuthGateProvider');
  }
  return value;
}
