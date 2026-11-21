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
  onOnboardingCompleted: () => void;
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

  useEffect(() => {
    let active = true;

    void getAccount()
      .then((account) => {
        if (active) {
          setErrorKey(null);
          setStatus(
            !account
              ? 'no-account'
              : account.onboardingComplete
                ? 'locked'
                : 'onboarding',
          );
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
      setStatus((current) => (current === 'unlocked' ? 'locked' : current));
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
        setStatus('unlocked');
      },
      lock: () => setStatus('locked'),
      onOnboardingCompleted: () => {
        setErrorKey(null);
        setStatus(isForeground.current ? 'unlocked' : 'locked');
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
