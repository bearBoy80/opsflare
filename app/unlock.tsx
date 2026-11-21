import { useEffect, useRef, useState } from 'react';
import {
  ActivityIndicator,
  AppState,
  Keyboard,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import { LockKeyhole, ScanFace } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/src/auth/AuthGate';
import { isAutoLockSuspended, suspendAutoLock } from '@/src/auth/autoLock';
import { getAccount, verifyPassword } from '@/src/auth/localAccount';
import {
  clearUnlockThrottle,
  getUnlockLockout,
  recordUnlockFailure,
} from '@/src/auth/unlockThrottle';
import { AuthTextInput } from '@/src/components/AuthTextInput';
import { useTheme } from '@/src/theme/ThemeContext';
import {
  accent,
  fontFace,
  foreground,
  label,
  tint,
} from '@/src/theme/tokens';

type AuthMode = 'password' | 'biometric' | null;

/** Rounds a lockout up to whole seconds, or minutes once it is long. */
const lockoutTime = (ms: number) =>
  ms >= 120_000
    ? `${Math.ceil(ms / 60_000)} min`
    : `${Math.max(1, Math.ceil(ms / 1000))} s`;

/** A stale counter must never block an unlock that already succeeded. */
const clearThrottleQuietly = () => {
  void clearUnlockThrottle().catch(() => {});
};

const isBiometricCancellation = (error: unknown) => {
  const code =
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    typeof error.code === 'string'
      ? error.code
      : error instanceof Error
        ? error.message
        : typeof error === 'string'
          ? error
          : undefined;

  return (
    code === 'user_cancel' ||
    code === 'app_cancel' ||
    code === 'system_cancel' ||
    code === 'user_fallback'
  );
};

export default function Unlock() {
  const { t } = useTranslation();
  const { reportAccountError, unlock } = useAuth();
  const { mode, colors } = useTheme();
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [biometricsEnabled, setBiometricsEnabled] = useState(false);
  const [authMode, setAuthMode] = useState<AuthMode>(null);
  const authModeRef = useRef<AuthMode>(null);
  const isForeground = useRef(AppState.currentState === 'active');
  const isMounted = useRef(true);
  const biometricFlight = useRef<Promise<void> | null>(null);
  const passwordFlight = useRef<Promise<void> | null>(null);
  const authBusy = authMode !== null;

  const tryBiometrics = () => {
    if (biometricFlight.current || authModeRef.current !== null) {
      return biometricFlight.current ?? Promise.resolve();
    }

    authModeRef.current = 'biometric';
    setAuthMode('biometric');
    setError(null);

    let flight: Promise<void>;
    flight = Promise.resolve().then(async () => {
      try {
        if (!isForeground.current) {
          return;
        }

        const hasHardware =
          await LocalAuthentication.hasHardwareAsync();
        if (!isForeground.current) {
          return;
        }
        if (!hasHardware) {
          if (isMounted.current) {
            setError(t('unlock.biometricUnavailableDevice'));
          }
          return;
        }

        const isEnrolled =
          await LocalAuthentication.isEnrolledAsync();
        if (!isForeground.current) {
          return;
        }
        if (!isEnrolled) {
          if (isMounted.current) {
            setError(t('unlock.biometricNotEnrolled'));
          }
          return;
        }

        // Presenting the system prompt drops the app out of the foreground,
        // exactly like the OAuth sheet, so the same suspension applies.
        const releaseAutoLock = suspendAutoLock();
        let result: LocalAuthentication.LocalAuthenticationResult;
        try {
          result = await LocalAuthentication.authenticateAsync({
            biometricsSecurityLevel: 'strong',
            cancelLabel: t('unlock.usePassword'),
            disableDeviceFallback: true,
            fallbackLabel: t('unlock.usePassword'),
            promptMessage: t('unlock.prompt'),
          });
        } finally {
          releaseAutoLock();
        }
        if (
          result.success &&
          isForeground.current &&
          isMounted.current
        ) {
          clearThrottleQuietly();
          unlock();
          return;
        }
        if (
          !result.success &&
          isForeground.current &&
          isMounted.current &&
          !isBiometricCancellation(result.error)
        ) {
          setError(
            result.error === 'authentication_failed'
              ? t('unlock.biometricNotRecognized')
              : t('unlock.biometricUnavailable'),
          );
        }
      } catch (error) {
        if (
          isForeground.current &&
          isMounted.current &&
          !isBiometricCancellation(error)
        ) {
          setError(t('unlock.biometricUnavailable'));
        }
      } finally {
        if (biometricFlight.current === flight) {
          biometricFlight.current = null;
          if (authModeRef.current === 'biometric') {
            authModeRef.current = null;
            if (isMounted.current) {
              setAuthMode(null);
            }
          }
        }
      }
    });

    biometricFlight.current = flight;
    return flight;
  };

  useEffect(() => {
    isMounted.current = true;
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState === 'active') {
        isForeground.current = true;
      } else if (!isAutoLockSuspended()) {
        // Mirrors AuthGate: the biometric prompt resigns the active state
        // without the user leaving, and the success arrives right after.
        isForeground.current = false;
      }
    });

    return () => {
      isMounted.current = false;
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    let active = true;

    void getAccount()
      .then((account) => {
        if (!active || !account) {
          return;
        }
        setName(account.name);
        setBiometricsEnabled(account.biometricsEnabled);
      })
      .catch((cause: unknown) => {
        if (active) {
          reportAccountError(cause);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  const submit = () => {
    if (passwordFlight.current || authModeRef.current !== null) {
      return passwordFlight.current ?? Promise.resolve();
    }
    if (!password) {
      setError(t('unlock.enterPassword'));
      return Promise.resolve();
    }

    setError(null);
    authModeRef.current = 'password';
    setAuthMode('password');
    Keyboard.dismiss();

    let flight: Promise<void>;
    flight = new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve());
    })
      .then(async () => {
        const lockout = await getUnlockLockout();
        if (lockout > 0) {
          if (isMounted.current) {
            setError(t('unlock.lockedOut', { time: lockoutTime(lockout) }));
          }
          return;
        }
        if (await verifyPassword(password)) {
          clearThrottleQuietly();
          if (isMounted.current) {
            unlock();
          }
          return;
        }
        const triggered = await recordUnlockFailure();
        if (isMounted.current) {
          setError(
            triggered > 0
              ? t('unlock.lockedOut', { time: lockoutTime(triggered) })
              : t('unlock.incorrectPassword'),
          );
        }
      })
      .catch((cause: unknown) => {
        if (isMounted.current) {
          reportAccountError(cause);
        }
      })
      .finally(() => {
        if (passwordFlight.current === flight) {
          passwordFlight.current = null;
          if (authModeRef.current === 'password') {
            authModeRef.current = null;
            if (isMounted.current) {
              setAuthMode(null);
            }
          }
        }
      });

    passwordFlight.current = flight;
    return flight;
  };

  const changePassword = (value: string) => {
    setPassword(value);
    if (error) {
      setError(null);
    }
  };

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.bg }]}>
      <ScrollView
        // The form stays centred while it fits and starts scrolling once the
        // keyboard squeezes it, so the unlock button is never cut off.
        automaticallyAdjustKeyboardInsets
        contentContainerStyle={styles.scrollContent}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        showsVerticalScrollIndicator={false}
        style={styles.scroll}
      >
        <View style={styles.content}>
          <View
            style={[
              styles.icon,
              { backgroundColor: tint(accent.orange, '22') },
            ]}
          >
            <LockKeyhole color={accent.orange} size={34} strokeWidth={2} />
          </View>

          <Text style={[styles.title, { color: colors.text }]}>
            {name
              ? t('unlock.welcomeBackName', { name })
              : t('unlock.welcomeBack')}
          </Text>
          <Text style={[styles.subtitle, { color: label(mode, 0.52) }]}>
            {t('unlock.subtitle')}
          </Text>

          <View style={styles.form}>
            <AuthTextInput
              disabled={authBusy}
              onChangeText={changePassword}
              onSubmitEditing={() => void submit()}
              placeholder={t('unlock.passwordPlaceholder')}
              returnKeyType="go"
              secureTextEntry
              showPasswordToggle
              testID="password"
              textContentType="password"
              value={password}
            />

            {error ? (
              <Text accessibilityRole="alert" style={styles.error}>
                {error}
              </Text>
            ) : null}

            <TouchableOpacity
              activeOpacity={0.8}
              accessibilityLabel={
                authMode === 'password'
                  ? t('unlock.unlocking')
                  : t('unlock.unlock')
              }
              accessibilityRole="button"
              accessibilityState={{
                busy: authMode === 'password',
                disabled: authBusy,
              }}
              disabled={authBusy}
              onPress={() => void submit()}
              style={[
                styles.primaryButton,
                { backgroundColor: accent.orange },
                authBusy && styles.actionDisabled,
              ]}
            >
              {authMode === 'password' ? (
                <>
                  <ActivityIndicator
                    color={foreground.onAccent}
                    size="small"
                  />
                  <Text
                    style={[
                      styles.primaryButtonText,
                      { color: foreground.onAccent },
                    ]}
                  >
                    {t('unlock.unlocking')}
                  </Text>
                </>
              ) : (
                <Text
                  style={[
                    styles.primaryButtonText,
                    { color: foreground.onAccent },
                  ]}
                >
                  {t('unlock.unlock')}
                </Text>
              )}
            </TouchableOpacity>
          </View>

          {biometricsEnabled ? (
            <Pressable
              accessibilityRole="button"
              accessibilityState={{
                busy: authMode === 'biometric',
                disabled: authBusy,
              }}
              disabled={authBusy}
              onPress={() => void tryBiometrics()}
              style={[
                styles.biometricButton,
                authBusy && styles.actionDisabled,
              ]}
            >
              <ScanFace color={label(mode, 0.65)} size={19} />
              <Text
                style={[styles.biometricText, { color: label(mode, 0.65) }]}
              >
                {authMode === 'biometric'
                  ? t('unlock.authenticating')
                  : t('unlock.useBiometrics')}
              </Text>
            </Pressable>
          ) : null}
        </View>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  actionDisabled: {
    opacity: 0.68,
  },
  biometricButton: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 7,
    justifyContent: 'center',
    marginTop: 20,
    padding: 10,
  },
  biometricText: {
    ...fontFace('bodySmall', '500'),
  },
  content: {
    alignSelf: 'center',
    maxWidth: 440,
    paddingHorizontal: 24,
    width: '100%',
  },
  error: {
    ...fontFace('subhead'),
    color: accent.red,
  },
  form: {
    gap: 12,
    marginTop: 26,
  },
  icon: {
    alignItems: 'center',
    alignSelf: 'center',
    borderRadius: 22,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  primaryButton: {
    alignItems: 'center',
    borderRadius: 15,
    flexDirection: 'row',
    gap: 9,
    justifyContent: 'center',
    minHeight: 52,
    width: '100%',
  },
  primaryButtonText: {
    ...fontFace('bodyLarge', '700'),
  },
  safeArea: {
    flex: 1,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
    justifyContent: 'center',
  },
  subtitle: {
    ...fontFace('bodySmall'),
    marginTop: 8,
    textAlign: 'center',
  },
  title: {
    ...fontFace('largeTitle'),
    marginTop: 22,
    textAlign: 'center',
  },
});
