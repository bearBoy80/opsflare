import { useCallback, useEffect, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  ChevronDown,
  ChevronRight,
  FileText,
  Fingerprint,
  Globe,
  Lock,
  LogOut,
  Moon,
  Plus,
  ScrollText,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import Constants from 'expo-constants';
import { useTranslation } from 'react-i18next';
import { useAuth } from '@/src/auth/AuthGate';
import { getStoredLanguage, type AppLanguage } from '@/src/i18n';
import {
  getAccount,
  setBiometricsEnabled,
} from '@/src/auth/localAccount';
import {
  discoverAccounts,
  listConnections,
  removeConnection,
  setConnectionAccounts,
  type CloudflareConnection,
} from '@/src/cloudflare/connections';
import { invalidateAllSnapshots } from '@/src/cloudflare/cache';
import { reconcileAccountScope } from '@/src/state/accountScope';
import { getBearerForConnection } from '@/src/cloudflare/resources';
import {
  AccountChip,
  Card,
  InitialsAvatar,
  ListRow,
  SectionLabel,
  SegmentedControl,
  showActionMenu,
  ToggleRow,
  useToast,
} from '@/src/components/ui';
import { useTabBarInset } from '@/src/components/useTabBarInset';
import { useTheme } from '@/src/theme/ThemeContext';
import { accent, fontFace, label, tint } from '@/src/theme/tokens';
import { haptics } from '@/src/utils/haptics';

const chipColors = [accent.orange, accent.blue, accent.green, accent.red];

interface Profile {
  name: string;
  organization: string;
  email: string;
}

/**
 * Re-discovers accounts for connections stored without any (e.g. tokens bound
 * before zone-based discovery), persists them, and pushes the healed list.
 */
async function healEmptyConnections(
  items: CloudflareConnection[],
  isActive: () => boolean,
  apply: (next: CloudflareConnection[]) => void,
): Promise<void> {
  const empties = items.filter((item) => item.accounts.length === 0);
  if (empties.length === 0) {
    return;
  }

  let changed = false;
  await Promise.all(
    empties.map(async (item) => {
      try {
        const bearer = await getBearerForConnection(item.id);
        const accounts = await discoverAccounts(bearer);
        if (accounts.length > 0) {
          await setConnectionAccounts(item.id, accounts);
          changed = true;
        }
      } catch {
        // Leave the connection untouched if discovery fails.
      }
    }),
  );

  if (changed && isActive()) {
    invalidateAllSnapshots();
    apply(await listConnections());
  }
}

export default function SettingsScreen() {
  const router = useRouter();
  const { t } = useTranslation();
  const { lock, reportAccountError } = useAuth();
  const { showToast } = useToast();
  const { mode, colors, preference, setPreference } = useTheme();
  const bottomInset = useTabBarInset();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [connections, setConnections] = useState<CloudflareConnection[]>([]);
  // Absent means expanded: nothing is hidden until the user chooses to fold it.
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [biometrics, setBiometrics] = useState(false);
  const [biometricsError, setBiometricsError] = useState<string | null>(null);
  const [language, setLanguage] = useState<AppLanguage>('system');

  useFocusEffect(
    useCallback(() => {
      let active = true;

      void listConnections()
        .then((items) => {
          if (active) {
            setConnections(items);
          }
          return healEmptyConnections(items, () => active, setConnections);
        })
        .catch(() => {
          // A failed read leaves the last known list in place.
        });

      void getStoredLanguage().then((preference) => {
        if (active) {
          setLanguage(preference);
        }
      });

      return () => {
        active = false;
      };
    }, []),
  );

  const toggleCredential = (connectionId: string) => {
    haptics.selection();
    setCollapsed((current) => ({
      ...current,
      [connectionId]: !current[connectionId],
    }));
  };

  const disconnect = (connection: CloudflareConnection) => {
    showActionMenu({
      title: t('settings.disconnectTitle'),
      // One credential can cover several accounts, and removing it cuts off all
      // of them. Naming only the credential would understate that.
      message:
        connection.accounts.length > 1
          ? t('settings.disconnectMessageMulti', {
              count: connection.accounts.length,
              label: connection.label,
            })
          : t('settings.disconnectMessage', { label: connection.label }),
      cancelLabel: t('common.cancel'),
      actions: [
        {
          label: t('settings.disconnect'),
          destructive: true,
          onPress: () => {
            void removeConnection(connection.id)
              .then(async () => {
                invalidateAllSnapshots();
                const remaining = await listConnections();
                setConnections(remaining);
                reconcileAccountScope(
                  remaining.flatMap((item) =>
                    item.accounts.map((account) => account.id),
                  ),
                );
              })
              .catch(() => {
                showToast(t('settings.disconnectError'), 'error');
                // Show what actually survived the partial removal.
                void listConnections()
                  .then(setConnections)
                  .catch(() => {});
              });
          },
        },
      ],
    });
  };

  useEffect(() => {
    let active = true;

    void getAccount()
      .then((account) => {
        if (active && account) {
          setProfile({
            name: account.name,
            organization: account.organization,
            email: account.email,
          });
          setBiometrics(account.biometricsEnabled);
        }
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

  const toggleBiometrics = (value: boolean) => {
    setBiometricsError(null);
    setBiometrics(value);
    void setBiometricsEnabled(value).catch(() => {
      setBiometrics(!value);
      setBiometricsError(t('settings.biometricsError'));
    });
  };

  const languageValue =
    language === 'system' ? t('language.system') : t(`language.${language}`);
  const version = Constants.expoConfig?.version ?? '1.0.0';
  const subtitleParts = [profile?.email, profile?.organization].filter(
    (part) => part && part.length > 0,
  );

  return (
    <SafeAreaView
      edges={['top']}
      style={[styles.safeArea, { backgroundColor: colors.bg }]}
    >
      <ScrollView
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.title, { color: colors.text }]}>
          {t('settings.title')}
        </Text>
        <Text style={[styles.subtitle, { color: label(mode, 0.5) }]}>
          {t('settings.subtitle')}
        </Text>

        <View style={[styles.accountCard, { backgroundColor: colors.surface }]}>
          <InitialsAvatar name={profile?.name ?? '?'} size={48} />
          <View style={styles.accountCopy}>
            <Text style={[styles.accountName, { color: colors.text }]}>
              {profile?.name ?? ' '}
            </Text>
            <Text style={[styles.accountDetail, { color: label(mode, 0.5) }]}>
              {subtitleParts.join(' · ')}
            </Text>
          </View>
        </View>

        <SectionLabel>
          {t('settings.connectedAccounts')} ·{' '}
          {connections.reduce(
            (sum, item) => sum + Math.max(item.accounts.length, 1),
            0,
          )}
        </SectionLabel>
        <Card>
          {connections.length === 0 ? (
            <ListRow
              chevron={false}
              left={
                <View style={styles.emptyAccounts}>
                  <Text
                    style={[styles.emptyAccountsTitle, { color: colors.text }]}
                  >
                    {t('settings.emptyTitle')}
                  </Text>
                  <Text
                    style={[
                      styles.emptyAccountsSub,
                      { color: label(mode, 0.4) },
                    ]}
                  >
                    {t('settings.emptySubtitle')}
                  </Text>
                </View>
              }
            />
          ) : (
            /*
             * Grouped by credential, not flattened by account: disconnecting
             * removes the whole credential, so the pressable row has to be the
             * credential itself. Accounts are read-only children, which also
             * makes it obvious which ones a single token covers.
             */
            connections.flatMap((connection) => {
              const isOpen = !collapsed[connection.id];
              const Chevron = isOpen ? ChevronDown : ChevronRight;

              return [
                <ListRow
                  key={`${connection.id}-credential`}
                  chevron={false}
                  expanded={isOpen}
                  onPress={() => toggleCredential(connection.id)}
                  right={
                    <Chevron
                      accessibilityElementsHidden
                      color={label(mode, 0.3)}
                      size={18}
                    />
                  }
                  testID={`credential-${connection.id}`}
                  left={
                    <View style={styles.accountRow}>
                      <AccountChip
                        color={accent.gray}
                        name={connection.label}
                        size={32}
                      />
                      <View style={styles.accountRowCopy}>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.accountRowName,
                            { color: colors.text },
                          ]}
                        >
                          {connection.label}
                        </Text>
                        <Text
                          numberOfLines={1}
                          style={[
                            styles.accountRowSub,
                            { color: label(mode, 0.4) },
                          ]}
                        >
                          {connection.accounts.length === 0
                            ? t('settings.tokenNoAccounts')
                            : `${
                                connection.authType === 'oauth'
                                  ? t('settings.authOauth')
                                  : t('settings.authToken')
                              } · ${t('settings.credentialAccounts', {
                                count: connection.accounts.length,
                              })}`}
                        </Text>
                      </View>
                    </View>
                  }
                />,
                ...(isOpen
                  ? [
                      ...connection.accounts.map((cfAccount, index) => (
                        <ListRow
                          key={`${connection.id}-${cfAccount.id}`}
                          chevron={false}
                          left={
                            <View style={styles.credentialAccountRow}>
                              <AccountChip
                                color={chipColors[index % chipColors.length]}
                                name={cfAccount.name}
                                size={24}
                              />
                              <Text
                                numberOfLines={1}
                                style={[
                                  styles.credentialAccountName,
                                  { color: colors.text },
                                ]}
                              >
                                {cfAccount.name}
                              </Text>
                              <View style={styles.healthDot} />
                            </View>
                          }
                        />
                      )),
                      // Scoped inside the group so it is unambiguous which
                      // credential it removes, and needs no hidden gesture.
                      <ListRow
                        key={`${connection.id}-disconnect`}
                        chevron={false}
                        onPress={() => disconnect(connection)}
                        testID={`disconnect-${connection.id}`}
                        left={
                          <Text style={styles.disconnectLabel}>
                            {t('settings.disconnectCredential')}
                          </Text>
                        }
                      />,
                    ]
                  : []),
              ];
            })
          )}
          <ListRow
            chevron={false}
            last
            onPress={() => router.push('/connect')}
            left={
              <View style={styles.connectRow}>
                <View
                  style={[
                    styles.connectIcon,
                    { backgroundColor: tint(accent.orange, '26') },
                  ]}
                >
                  <Plus
                    accessibilityElementsHidden
                    color={accent.orange}
                    size={16}
                  />
                </View>
                <Text style={styles.connectLabel}>
                  {t('common.connectAccount')}
                </Text>
              </View>
            }
          />
        </Card>

        <SectionLabel>{t('settings.preferences')}</SectionLabel>
        <Card>
          <View style={styles.appearanceRow}>
            <View
              style={[
                styles.languageIcon,
                { backgroundColor: tint(accent.blue, '26') },
              ]}
            >
              <Moon
                accessibilityElementsHidden
                color={accent.blue}
                size={16}
              />
            </View>
            <Text style={[styles.languageLabel, { color: colors.text }]}>
              {t('settings.appearance')}
            </Text>
          </View>
          <View style={styles.appearanceSegments}>
            <SegmentedControl
              segments={[
                { id: 'system', label: t('settings.themeSystem') },
                { id: 'light', label: t('settings.themeLight') },
                { id: 'dark', label: t('settings.themeDark') },
              ]}
              selected={preference}
              onChange={setPreference}
              testIDPrefix="appearance"
            />
          </View>
          <View
            style={[
              styles.divider,
              { backgroundColor: label(mode, 0.08) },
            ]}
          />
          <ListRow
            last
            onPress={() => router.push('/language')}
            testID="language-row"
            left={
              <View style={styles.languageRow}>
                <View
                  style={[
                    styles.languageIcon,
                    { backgroundColor: tint(accent.purple, '26') },
                  ]}
                >
                  <Globe
                    accessibilityElementsHidden
                    color={accent.purple}
                    size={16}
                  />
                </View>
                <Text style={[styles.languageLabel, { color: colors.text }]}>
                  {t('settings.language')}
                </Text>
              </View>
            }
            right={
              <Text style={[styles.languageValue, { color: label(mode, 0.45) }]}>
                {languageValue}
              </Text>
            }
          />
        </Card>

        <SectionLabel>{t('settings.signInSecurity')}</SectionLabel>
        <Card>
          <ToggleRow
            Icon={Fingerprint}
            color={accent.green}
            label={t('settings.biometrics')}
            last
            onValueChange={toggleBiometrics}
            sub={t('settings.biometricsSub')}
            testID="biometrics"
            value={biometrics}
          />
        </Card>
        {biometricsError ? (
          <Text accessibilityRole="alert" style={styles.error}>
            {biometricsError}
          </Text>
        ) : null}

        <SectionLabel>{t('settings.about')}</SectionLabel>
        <Card>
          <ListRow
            chevron={false}
            left={
              <View style={styles.accountRow}>
                <View
                  style={[
                    styles.languageIcon,
                    { backgroundColor: tint(accent.green, '26') },
                  ]}
                >
                  <Lock
                    accessibilityElementsHidden
                    color={accent.green}
                    size={16}
                  />
                </View>
                <View style={styles.accountRowCopy}>
                  <Text
                    style={[styles.accountRowName, { color: colors.text }]}
                  >
                    {t('settings.dataPrivacy')}
                  </Text>
                  <Text
                    style={[styles.accountRowSub, { color: label(mode, 0.4) }]}
                  >
                    {t('settings.dataPrivacySub')}
                  </Text>
                </View>
              </View>
            }
          />
          <ListRow
            onPress={() => router.push('/privacy')}
            testID="privacy-policy-row"
            left={
              <View style={styles.languageRow}>
                <View
                  style={[
                    styles.languageIcon,
                    { backgroundColor: tint(accent.blue, '26') },
                  ]}
                >
                  <FileText
                    accessibilityElementsHidden
                    color={accent.blue}
                    size={16}
                  />
                </View>
                <Text style={[styles.languageLabel, { color: colors.text }]}>
                  {t('settings.privacyPolicy')}
                </Text>
              </View>
            }
          />
          <ListRow
            last
            onPress={() => router.push('/terms')}
            testID="terms-row"
            left={
              <View style={styles.languageRow}>
                <View
                  style={[
                    styles.languageIcon,
                    { backgroundColor: tint(accent.purple, '26') },
                  ]}
                >
                  <ScrollText
                    accessibilityElementsHidden
                    color={accent.purple}
                    size={16}
                  />
                </View>
                <Text style={[styles.languageLabel, { color: colors.text }]}>
                  {t('settings.termsOfService')}
                </Text>
              </View>
            }
          />
        </Card>

        <View style={styles.lockWrap}>
          <Card>
            <ListRow
              chevron={false}
              last
              onPress={lock}
              testID="lock-console"
              left={
                <View style={styles.languageRow}>
                  <View
                    style={[
                      styles.languageIcon,
                      { backgroundColor: tint(accent.red, '26') },
                    ]}
                  >
                    <LogOut
                      accessibilityElementsHidden
                      color={accent.red}
                      size={16}
                    />
                  </View>
                  <Text style={[styles.languageLabel, { color: accent.red }]}>
                    {t('settings.lockConsole')}
                  </Text>
                </View>
              }
            />
          </Card>
        </View>

        <Text style={[styles.footer, { color: label(mode, 0.3) }]}>
          {t('settings.footer', { version })}
        </Text>
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  appearanceRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
    paddingHorizontal: 16,
    paddingTop: 12,
    paddingBottom: 10,
  },
  appearanceSegments: {
    paddingBottom: 12,
  },
  divider: {
    height: StyleSheet.hairlineWidth,
    marginLeft: 16,
  },
  accountRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  accountRowCopy: {
    flex: 1,
    minWidth: 0,
  },
  accountRowName: {
    ...fontFace('body', '500'),
    flexShrink: 1,
  },
  accountRowSub: {
    ...fontFace('footnote'),
    marginTop: 1,
  },
  accountRowTitle: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  credentialAccountName: {
    ...fontFace('bodySmall'),
    flexShrink: 1,
  },
  credentialAccountRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
    // Indented so the accounts read as belonging to the credential above.
    paddingLeft: 22,
  },
  disconnectLabel: {
    ...fontFace('bodySmall'),
    color: accent.red,
    paddingLeft: 22,
  },
  healthDot: {
    backgroundColor: accent.green,
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  accountCard: {
    alignItems: 'center',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 12,
    marginHorizontal: 16,
    marginTop: 4,
    padding: 16,
  },
  accountCopy: {
    flex: 1,
    minWidth: 0,
  },
  accountDetail: {
    ...fontFace('footnote'),
    marginTop: 2,
  },
  accountName: {
    ...fontFace('bodyLarge', '600'),
  },
  connectIcon: {
    alignItems: 'center',
    borderRadius: 8,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  connectLabel: {
    ...fontFace('body', '500'),
    color: accent.orange,
  },
  connectRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  content: {},
  emptyAccounts: {
    paddingVertical: 4,
  },
  emptyAccountsSub: {
    ...fontFace('footnote'),
    marginTop: 2,
  },
  emptyAccountsTitle: {
    ...fontFace('bodySmall', '500'),
  },
  error: {
    ...fontFace('footnote'),
    color: accent.red,
    marginTop: 8,
    paddingHorizontal: 20,
  },
  footer: {
    ...fontFace('caption'),
    marginTop: 24,
    textAlign: 'center',
  },
  languageIcon: {
    alignItems: 'center',
    borderRadius: 8,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  languageLabel: {
    ...fontFace('body', '500'),
  },
  languageRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  languageValue: {
    ...fontFace('bodySmall'),
  },
  lockWrap: {
    marginTop: 16,
  },
  safeArea: {
    flex: 1,
  },
  subtitle: {
    ...fontFace('subhead'),
    marginBottom: 12,
    marginTop: 2,
    paddingHorizontal: 16,
  },
  title: {
    ...fontFace('largeTitle'),
    paddingBottom: 0,
    paddingHorizontal: 16,
    paddingTop: 12,
  },
});
