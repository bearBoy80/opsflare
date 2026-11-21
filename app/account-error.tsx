import { Pressable, StyleSheet, Text, View } from 'react-native';
import { ShieldAlert } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import { ACCOUNT_UNAVAILABLE_KEY, useAuth } from '@/src/auth/AuthGate';
import { useTheme } from '@/src/theme/ThemeContext';
import {
  accent,
  fontFace,
  foreground,
  label,
  tint,
} from '@/src/theme/tokens';

export default function AccountError() {
  const { t } = useTranslation();
  const { errorKey, resetAccount, retryAccount } = useAuth();
  // A transient storage failure must not be answered with a destructive reset.
  const retryable = errorKey === ACCOUNT_UNAVAILABLE_KEY;
  const { colors, mode } = useTheme();

  return (
    <SafeAreaView style={[styles.safeArea, { backgroundColor: colors.bg }]}>
      <View style={styles.content}>
        <View
          style={[
            styles.icon,
            { backgroundColor: tint(accent.red, '22') },
          ]}
        >
          <ShieldAlert color={accent.red} size={34} />
        </View>
        <Text style={[styles.title, { color: colors.text }]}>
          {t('accountError.title')}
        </Text>
        <Text style={[styles.message, { color: label(mode, 0.55) }]}>
          {errorKey ? t(errorKey) : null}
        </Text>
        {retryable ? (
          <Pressable
            accessibilityRole="button"
            onPress={retryAccount}
            style={[styles.button, { backgroundColor: accent.orange }]}
          >
            <Text style={[styles.buttonText, { color: foreground.onAccent }]}>
              {t('accountError.retry')}
            </Text>
          </Pressable>
        ) : (
          <>
            <Pressable
              accessibilityRole="button"
              onPress={() => void resetAccount()}
              style={[styles.button, { backgroundColor: accent.red }]}
            >
              <Text style={[styles.buttonText, { color: foreground.onAccent }]}>
                {t('accountError.reset')}
              </Text>
            </Pressable>
            <Text style={[styles.warning, { color: label(mode, 0.42) }]}>
              {t('accountError.warning')}
            </Text>
          </>
        )}
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  button: {
    alignItems: 'center',
    borderRadius: 15,
    justifyContent: 'center',
    marginTop: 22,
    minHeight: 52,
    paddingHorizontal: 20,
  },
  buttonText: {
    ...fontFace('bodyLarge', '700'),
  },
  content: {
    alignItems: 'center',
    flex: 1,
    justifyContent: 'center',
    paddingHorizontal: 28,
  },
  icon: {
    alignItems: 'center',
    borderRadius: 22,
    height: 72,
    justifyContent: 'center',
    width: 72,
  },
  message: {
    fontSize: 14,
    lineHeight: 20,
    marginTop: 10,
    textAlign: 'center',
  },
  safeArea: {
    flex: 1,
  },
  title: {
    fontSize: 25,
    fontWeight: '700',
    marginTop: 22,
    textAlign: 'center',
  },
  warning: {
    ...fontFace('footnote'),
    marginTop: 12,
    textAlign: 'center',
  },
});
