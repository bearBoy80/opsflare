import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, AppState, StyleSheet, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/src/auth/AuthGate';
import {
  advanceOnboarding,
  completeOnboarding,
  getAccount,
} from '@/src/auth/localAccount';
import { ConnectStep } from '@/src/onboarding/ConnectStep';
import {
  CreateAccountStep,
  type CreateAccountDraft,
} from '@/src/onboarding/CreateAccountStep';
import { DoneStep } from '@/src/onboarding/DoneStep';
import type { OnboardingStep } from '@/src/onboarding/types';
import { WelcomeStep } from '@/src/onboarding/WelcomeStep';
import { useTheme } from '@/src/theme/ThemeContext';

export default function Onboarding() {
  const { t } = useTranslation();
  const {
    lock,
    onOnboardingCompleted,
    reportAccountError,
  } = useAuth();
  const { colors } = useTheme();
  const [step, setStep] = useState<OnboardingStep>('welcome');
  const [loading, setLoading] = useState(true);
  const [createDraft, setCreateDraft] = useState<CreateAccountDraft>({
    organization: '',
    name: '',
    email: '',
    password: '',
    confirm: '',
    biometricsEnabled: false,
  });
  const completionInFlight = useRef(false);
  const completionInterrupted = useRef(false);

  useEffect(() => {
    let active = true;
    void getAccount()
      .then((account) => {
        if (!active) {
          return;
        }
        if (account && !account.onboardingComplete) {
          setStep(account.onboardingStep);
        }
      })
      .catch((cause: unknown) => {
        if (active) {
          reportAccountError(cause);
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (nextState) => {
      if (nextState !== 'active' && completionInFlight.current) {
        completionInterrupted.current = true;
      }
    });

    return () => subscription.remove();
  }, []);

  const handleCreated = () => setStep('connect');

  // Shared by "skip for now" and by a successful credential bind: both leave
  // the connect step behind and land on the final step.
  const advanceToDone = async () => {
    await advanceOnboarding('done');
    setStep('done');
  };

  const handleEnterConsole = async () => {
    completionInterrupted.current = false;
    completionInFlight.current = true;
    try {
      await completeOnboarding();
      if (completionInterrupted.current) {
        lock();
      } else {
        onOnboardingCompleted();
      }
    } finally {
      completionInFlight.current = false;
    }
  };

  return (
    <SafeAreaView
      accessibilityState={{ busy: loading }}
      style={[styles.safeArea, { backgroundColor: colors.bg }]}
    >
      {loading ? (
        <View
          accessibilityLabel={t('onboarding.loadingA11y')}
          accessibilityRole="progressbar"
          style={styles.loading}
          testID="onboarding-loading"
        >
          <ActivityIndicator color={colors.text} size="large" />
        </View>
      ) : null}
      {!loading && step === 'welcome' ? (
        <WelcomeStep onContinue={() => setStep('create')} />
      ) : null}
      {!loading && step === 'create' ? (
        <CreateAccountStep
          draft={createDraft}
          onBack={() => setStep('welcome')}
          onCreated={handleCreated}
          onDraftChange={(update) => {
            setCreateDraft((current) => ({ ...current, ...update }));
          }}
        />
      ) : null}
      {!loading && step === 'connect' ? (
        <ConnectStep
          onAdvance={advanceToDone}
          onBack={() => setStep('create')}
        />
      ) : null}
      {!loading && step === 'done' ? (
        <DoneStep onEnterConsole={handleEnterConsole} />
      ) : null}
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  loading: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
  },
  safeArea: {
    flex: 1,
  },
});
