import { memo, useCallback, useMemo, useState } from 'react';
import {
  Modal,
  Pressable,
  RefreshControl,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import { useFocusEffect, useRouter, type Href } from 'expo-router';
import {
  Activity,
  BarChart2,
  Bell,
  Check,
  ChevronsUpDown,
  DollarSign,
  FileText,
  Gauge,
  Globe,
  HardDrive,
  Layers,
  Server,
  Shield,
  ShieldAlert,
  Wifi,
  Zap,
  type LucideIcon,
} from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useTranslation } from 'react-i18next';
import {
  aggregateAnalytics,
  fetchAnalyticsSnapshot,
  type AnalyticsSnapshot,
} from '@/src/cloudflare/analytics';
import { fetchComputeSnapshot } from '@/src/cloudflare/accountResources';
import {
  fetchZonesSnapshot,
  type AccountSummary,
  type ZonesSnapshot,
} from '@/src/cloudflare/resources';
import {
  AccountChip,
  AreaChart,
  Card,
  EmptyState,
  ListRow,
  MetricTile,
  Pill,
  SectionLabel,
  type Status,
  ScreenSkeleton,
} from '@/src/components/ui';
import { cloudflareErrorMessage } from '@/src/i18n/errors';
import {
  reconcileAccountScope,
  useAccountScope,
} from '@/src/state/accountScope';
import Animated, { FadeInDown } from 'react-native-reanimated';
import { CollapsibleTitleContainer, CompactHeader, useCollapsibleTitle } from '@/src/components/CollapsibleTitle';
import { useTabBarInset } from '@/src/components/useTabBarInset';
import { useTheme } from '@/src/theme/ThemeContext';
import { haptics } from '@/src/utils/haptics';
import {
  accent,
  fontFace,
  foreground,
  label,
  tint,
} from '@/src/theme/tokens';
import { compactNumber, formatBytes } from '@/src/utils/format';

const chipColors = [accent.orange, accent.blue, accent.purple, accent.green];

function utcClock(date = new Date()): string {
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return `${hh}:${mm} UTC`;
}

function eventPillStatus(action: string): Status {
  if (action.includes('challenge')) {
    return 'challenge';
  }
  return action === 'block' ? 'block' : 'log';
}

interface NavItem {
  key: string;
  title: string;
  sub: string;
  Icon: LucideIcon;
  color: string;
  onPress: () => void;
}

/** Icon + title + subtitle navigation row (quick access / management). */
const NavRow = memo(function NavRow({
  item,
  last,
  testID,
}: {
  item: NavItem;
  last: boolean;
  testID: string;
}) {
  const { mode, colors } = useTheme();
  return (
    <ListRow
      last={last}
      onPress={item.onPress}
      testID={testID}
      left={
        <View style={styles.accountRow}>
          <View
            style={[
              styles.quickIcon,
              { backgroundColor: tint(item.color, '22') },
            ]}
          >
            <item.Icon
              accessibilityElementsHidden
              color={item.color}
              size={16}
            />
          </View>
          <View style={styles.accountCopy}>
            <Text style={[styles.accountName, { color: colors.text }]}>
              {item.title}
            </Text>
            <Text style={[styles.accountSub, { color: label(mode, 0.45) }]}>
              {item.sub}
            </Text>
          </View>
        </View>
      }
    />
  );
});

const AccountRow = memo(function AccountRow({
  account,
  color,
  health,
  plan,
  requests,
  last,
  onSelect,
}: {
  account: AccountSummary;
  color: string;
  health: string;
  plan: string | null;
  requests: number | null;
  last: boolean;
  onSelect: (accountId: string) => void;
}) {
  const { t } = useTranslation();
  const { mode, colors } = useTheme();
  const subParts = [
    plan,
    t('common.zoneCount', { count: account.zoneCount }),
    requests !== null
      ? t('home.requestsShort', { value: compactNumber(requests) })
      : null,
  ].filter(Boolean);
  return (
    <ListRow
      last={last}
      onPress={() => onSelect(account.id)}
      right={
        requests !== null ? (
          <Text style={styles.accountRequests}>{compactNumber(requests)}</Text>
        ) : undefined
      }
      left={
        <View style={styles.accountRow}>
          <AccountChip color={color} name={account.name} size={30} />
          <View style={styles.accountCopy}>
            <View style={styles.accountNameRow}>
              <Text
                numberOfLines={1}
                style={[styles.accountName, { color: colors.text }]}
              >
                {account.name}
              </Text>
              <View style={[styles.accountDot, { backgroundColor: health }]} />
            </View>
            <Text style={[styles.accountSub, { color: label(mode, 0.4) }]}>
              {subParts.join(' · ')}
            </Text>
          </View>
        </View>
      }
    />
  );
});

export default function Home() {
  const router = useRouter();
  const { t } = useTranslation();
  const { mode, colors } = useTheme();
  const bottomInset = useTabBarInset();
  const { scrollY, onScroll } = useCollapsibleTitle();
  const [snapshot, setSnapshot] = useState<ZonesSnapshot | null>(null);
  const [analytics, setAnalytics] = useState<AnalyticsSnapshot | null>(null);
  const { scope, setScope } = useAccountScope();
  const [sheetOpen, setSheetOpen] = useState(false);
  const [refreshing, setRefreshing] = useState(false);

  const load = useCallback((force: boolean) => {
    return fetchZonesSnapshot({ force })
      .then((zones) => {
        setSnapshot(zones);
        // A partial snapshot may simply be missing an account that is still
        // there, so only a clean one may drop a stale selection.
        if (zones.issues.length === 0) {
          reconcileAccountScope(zones.accounts.map((account) => account.id));
        }
        if (!force) {
          // Warm the compute snapshot cache in the background so the compute
          // tab opens without a cold network wait. The shared TTL cache
          // dedupes this with the tab's own fetch.
          void fetchComputeSnapshot().catch(() => {});
        }
        // Analytics are best-effort and finish in the background: the
        // pull-to-refresh spinner only waits for the zones list.
        void fetchAnalyticsSnapshot(zones, { force })
          .then(setAnalytics)
          .catch(() => {});
      })
      .catch(() => {
        // Connection issues are reported per credential inside the snapshot;
        // a total failure keeps the previous state.
      });
  }, []);

  useFocusEffect(
    useCallback(() => {
      void load(false);
    }, [load]),
  );

  const refresh = () => {
    haptics.tap();
    setRefreshing(true);
    void load(true).finally(() => setRefreshing(false));
  };

  const scopedAccount = useMemo(
    () => snapshot?.accounts.find((account) => account.id === scope) ?? null,
    [snapshot, scope],
  );

  const aggregate = useMemo(() => {
    if (!analytics || !analytics.available) {
      return null;
    }
    return aggregateAnalytics(analytics, scope ?? undefined);
  }, [analytics, scope]);

  /** Health color, plan and request totals per account, computed once. */
  const accountMeta = useMemo(() => {
    const meta = new Map<
      string,
      { health: string; plan: string | null; requests: number | null }
    >();
    if (!snapshot) {
      return meta;
    }
    for (const account of snapshot.accounts) {
      const zones = snapshot.zones.filter(
        (zone) => zone.accountId === account.id,
      );
      meta.set(account.id, {
        health:
          zones.length === 0
            ? accent.gray
            : zones.every((zone) => zone.status === 'active' && !zone.paused)
              ? accent.green
              : accent.yellow,
        plan: zones[0]?.plan ?? null,
        requests: analytics?.available
          ? aggregateAnalytics(analytics, account.id).requests
          : null,
      });
    }
    return meta;
  }, [snapshot, analytics]);

  const selectAccount = useCallback(
    (accountId: string) => setScope(accountId),
    [setScope],
  );

  const openScoped = useCallback(
    (pathname: string) =>
      router.push({
        pathname,
        params: scopedAccount
          ? { accountId: scopedAccount.id, accountName: scopedAccount.name }
          : {},
      } as unknown as Href),
    [router, scopedAccount],
  );

  const quickAccess = useMemo<NavItem[]>(
    () => [
      {
        key: 'workers',
        title: t('home.quickWorkers'),
        sub: t('home.quickComputeSub'),
        Icon: Zap,
        color: accent.yellow,
        onPress: () => router.push('/(tabs)/(compute)'),
      },
      {
        key: 'dns',
        title: t('home.quickDns'),
        sub: t('home.quickZonesSub'),
        Icon: Server,
        color: accent.blue,
        onPress: () => router.push('/(tabs)/(zones)'),
      },
      {
        key: 'firewall',
        title: t('home.quickFirewall'),
        sub: t('home.quickFirewallSub', {
          count: aggregate ? compactNumber(aggregate.threats) : '—',
        }),
        Icon: Shield,
        color: accent.red,
        onPress: () =>
          router.push({
            pathname: '/(tabs)/(home)/firewall',
            params: scopedAccount ? { accountId: scopedAccount.id } : {},
          } as unknown as Href),
      },
      {
        key: 'underAttack',
        title: t('home.quickUnderAttack'),
        sub: t('home.quickUnderAttackSub'),
        Icon: ShieldAlert,
        color: accent.orange,
        onPress: () =>
          router.push({
            pathname: '/(tabs)/(home)/under-attack',
            params: scopedAccount ? { accountId: scopedAccount.id } : {},
          } as unknown as Href),
      },
      {
        key: 'analytics',
        title: t('home.quickAnalytics'),
        sub: t('home.quickAnalyticsSub'),
        Icon: BarChart2,
        color: accent.purple,
        onPress: () =>
          router.push({
            pathname: '/(tabs)/(home)/analytics',
            params: scopedAccount
              ? { accountId: scopedAccount.id, accountName: scopedAccount.name }
              : {},
          } as unknown as Href),
      },
    ],
    [t, router, aggregate, scopedAccount],
  );

  const management = useMemo<NavItem[]>(
    () => [
      {
        key: 'alerts',
        title: t('home.mgmtAlerts'),
        sub: t('home.mgmtAlertsSub'),
        Icon: Bell,
        color: accent.red,
        onPress: () => openScoped('/(tabs)/(home)/alerts'),
      },
      {
        key: 'analytics',
        title: t('home.mgmtAnalytics'),
        sub: t('home.mgmtAnalyticsSub'),
        Icon: Gauge,
        color: accent.purple,
        onPress: () => openScoped('/(tabs)/(home)/performance'),
      },
      {
        key: 'lb',
        title: t('home.mgmtLb'),
        sub: t('home.mgmtLbSub'),
        Icon: Wifi,
        color: accent.blue,
        onPress: () => openScoped('/(tabs)/(home)/lb'),
      },
      {
        key: 'audit',
        title: t('home.mgmtAudit'),
        sub: t('home.mgmtAuditSub'),
        Icon: FileText,
        color: accent.gray,
        onPress: () => openScoped('/(tabs)/(home)/audit'),
      },
      {
        key: 'billing',
        title: t('home.mgmtBilling'),
        sub: t('home.mgmtBillingSub'),
        Icon: DollarSign,
        color: accent.green,
        onPress: () => openScoped('/(tabs)/(home)/billing'),
      },
    ],
    [t, openScoped],
  );

  if (!snapshot) {
    return (
      <SafeAreaView
        edges={['top']}
        style={[styles.safeArea, { backgroundColor: colors.bg }]}
      >
        <Text style={[styles.title, { color: colors.text }]}>
          {t('home.title')}
        </Text>
        <ScreenSkeleton testID="screen-skeleton" />
      </SafeAreaView>
    );
  }

  if (snapshot.connectionCount === 0) {
    return (
      <SafeAreaView
        edges={['top']}
        style={[styles.safeArea, { backgroundColor: colors.bg }]}
      >
        <Text style={[styles.title, { color: colors.text }]}>
          {t('home.title')}
        </Text>
        <EmptyState
          Icon={Globe}
          title={t('home.emptyTitle')}
          subtitle={t('home.emptySubtitle')}
          actionLabel={t('common.connectAccount')}
          onAction={() => router.push('/connect')}
        />
      </SafeAreaView>
    );
  }

  const scopedZones = scope
    ? snapshot.zones.filter((zone) => zone.accountId === scope)
    : snapshot.zones;
  const healthy = snapshot.issues.length === 0;
  const cacheHitPct =
    aggregate && aggregate.bytes > 0
      ? Math.round((aggregate.cachedBytes / aggregate.bytes) * 100)
      : null;
  const events = (
    analytics?.events.filter((event) => !scope || event.accountId === scope) ??
    []
  ).slice(0, 3);

  return (
    <SafeAreaView
      edges={['top']}
      style={[styles.safeArea, { backgroundColor: colors.bg }]}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={t('home.switchAccount')}
        onPress={() => setSheetOpen(true)}
        style={styles.accountBar}
        testID="home-account-bar"
      >
        <View style={styles.accountBarIcon}>
          <Layers color={foreground.onAccent} size={15} />
        </View>
        <View style={styles.accountBarCopy}>
          <Text style={[styles.accountBarCaption, { color: label(mode, 0.4) }]}>
            {t('home.managing')}
          </Text>
          <Text
            numberOfLines={1}
            style={[styles.accountBarName, { color: colors.text }]}
          >
            {scopedAccount ? scopedAccount.name : t('home.allAccounts')}
          </Text>
        </View>
        <Text style={[styles.accountBarCount, { color: label(mode, 0.45) }]}>
          {t('common.accountCount', { count: snapshot.accounts.length })}
        </Text>
        <ChevronsUpDown color={label(mode, 0.45)} size={14} />
      </Pressable>

      <CollapsibleTitleContainer>
      <CompactHeader scrollY={scrollY} title={scopedAccount ? scopedAccount.name : t('home.title')} />
      <Animated.ScrollView
        onScroll={onScroll}
        scrollEventThrottle={16}
        entering={FadeInDown.duration(260)}
        contentContainerStyle={[styles.content, { paddingBottom: bottomInset }]}
        refreshControl={
          <RefreshControl
            onRefresh={refresh}
            refreshing={refreshing}
            tintColor={accent.orange}
          />
        }
        showsVerticalScrollIndicator={false}
      >
        <Text style={[styles.title, { color: colors.text }]}>
          {scopedAccount ? scopedAccount.name : t('home.title')}
        </Text>
        <Text style={[styles.subtitle, { color: label(mode, 0.5) }]}>
          {scopedAccount
            ? [
                accountMeta.get(scopedAccount.id)?.plan ?? null,
                t('common.zoneCount', { count: scopedZones.length }),
              ]
                .filter(Boolean)
                .join(' · ')
            : `${t('common.accountCount', { count: snapshot.accounts.length })} · ${t('common.zoneCount', { count: snapshot.zones.length })}`}
        </Text>

        <View
          style={[
            styles.banner,
            {
              backgroundColor: healthy
                ? tint(accent.green, '1f')
                : tint(accent.yellow, '1f'),
            },
          ]}
        >
          <View
            style={[
              styles.bannerDot,
              { backgroundColor: healthy ? accent.green : accent.yellow },
            ]}
          />
          <Text
            style={[
              styles.bannerText,
              { color: healthy ? accent.green : accent.yellow },
            ]}
          >
            {healthy
              ? t('home.allOperational')
              : t('home.needsAttention', { count: snapshot.issues.length })}
          </Text>
          <Text style={[styles.bannerTime, { color: label(mode, 0.4) }]}>
            {utcClock()}
          </Text>
        </View>
        {snapshot.issues.map((issue) => (
          <Text
            key={issue.connectionId}
            style={[styles.issue, { color: label(mode, 0.45) }]}
          >
            {issue.label}: {cloudflareErrorMessage(issue.cause)}
          </Text>
        ))}

        <View style={styles.tileRow}>
          <MetricTile
            Icon={Activity}
            color={accent.orange}
            label={t('home.metricRequests')}
            value={aggregate ? compactNumber(aggregate.requests) : '—'}
            sub={t('home.metricSub24h')}
          />
          <MetricTile
            Icon={Shield}
            color={accent.red}
            label={t('home.metricThreats')}
            value={aggregate ? compactNumber(aggregate.threats) : '—'}
            sub={t('home.metricSub24h')}
          />
        </View>
        <View style={styles.tileRow}>
          <MetricTile
            Icon={HardDrive}
            color={accent.blue}
            label={t('home.metricBandwidth')}
            value={aggregate ? formatBytes(aggregate.cachedBytes) : '—'}
            sub={
              cacheHitPct !== null
                ? t('home.cacheHitSub', { pct: cacheHitPct })
                : t('home.metricSub24h')
            }
          />
          <MetricTile
            Icon={DollarSign}
            color={accent.green}
            label={t('home.metricSpend')}
            value="—"
            sub={t('home.spendSub')}
          />
        </View>

        {!scope && (
          <>
            <SectionLabel>{t('home.sectionAccounts')}</SectionLabel>
            <Card>
              {snapshot.accounts.map((account, index) => {
                const meta = accountMeta.get(account.id);
                return (
                  <AccountRow
                    key={account.id}
                    account={account}
                    color={chipColors[index % chipColors.length]}
                    health={meta?.health ?? accent.gray}
                    plan={meta?.plan ?? null}
                    requests={meta?.requests ?? null}
                    last={index === snapshot.accounts.length - 1}
                    onSelect={selectAccount}
                  />
                );
              })}
            </Card>
          </>
        )}

        {aggregate && aggregate.series.length >= 2 ? (
          <View style={[styles.chartCard, { backgroundColor: colors.surface }]}>
            <Text style={[styles.chartTitle, { color: colors.text }]}>
              {t('home.chartTitle')}
            </Text>
            <Text style={[styles.chartSub, { color: label(mode, 0.4) }]}>
              {scopedAccount
                ? t('home.chartSubAccount', { name: scopedAccount.name })
                : t('home.chartSubAll')}
            </Text>
            <AreaChart color={accent.orange} data={aggregate.series} />
          </View>
        ) : null}

        <SectionLabel>{t('home.sectionQuickAccess')}</SectionLabel>
        <Card>
          {quickAccess.map((item, index) => (
            <NavRow
              key={item.key}
              item={item}
              last={index === quickAccess.length - 1}
              testID={`home-quick-${item.key}`}
            />
          ))}
        </Card>

        <SectionLabel>{t('home.sectionManagement')}</SectionLabel>
        <Card>
          {management.map((item, index) => (
            <NavRow
              key={item.key}
              item={item}
              last={index === management.length - 1}
              testID={`home-mgmt-${item.key}`}
            />
          ))}
        </Card>

        {analytics?.available ? (
          <>
            <SectionLabel>{t('home.sectionRecentEvents')}</SectionLabel>
            <Card>
              {events.length > 0 ? (
                events.map((event, index) => {
                  const zone = snapshot.zones.find(
                    (item) => item.id === event.zoneId,
                  );
                  return (
                    <ListRow
                      key={`${event.zoneId}-${event.datetime}-${index}`}
                      last={index === events.length - 1}
                      testID={`home-event-${index}`}
                      onPress={
                        zone
                          ? () =>
                              router.push({
                                pathname: '/(tabs)/(zones)/[zoneId]/firewall',
                                params: {
                                  zoneId: zone.id,
                                  connectionId: zone.connectionId,
                                  name: zone.name,
                                },
                              })
                          : undefined
                      }
                      left={
                        <View style={styles.accountRow}>
                          <Pill status={eventPillStatus(event.action)} />
                          <View style={styles.accountCopy}>
                            <Text
                              numberOfLines={1}
                              style={[
                                styles.accountName,
                                { color: colors.text },
                              ]}
                            >
                              {event.ruleId || event.action}
                            </Text>
                            <Text
                              style={[
                                styles.accountSub,
                                { color: label(mode, 0.4) },
                              ]}
                            >
                              {[
                                event.clientIP,
                                event.country,
                                event.datetime
                                  ? utcClock(new Date(event.datetime)).replace(
                                      ' UTC',
                                      '',
                                    )
                                  : null,
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </Text>
                          </View>
                        </View>
                      }
                    />
                  );
                })
              ) : (
                <ListRow
                  chevron={false}
                  last
                  left={
                    <Text
                      style={[styles.accountSub, { color: label(mode, 0.4) }]}
                    >
                      {t('firewall.noEvents')}
                    </Text>
                  }
                />
              )}
            </Card>
          </>
        ) : null}
      </Animated.ScrollView>
      </CollapsibleTitleContainer>

      <Modal
        animationType="slide"
        onRequestClose={() => setSheetOpen(false)}
        transparent
        visible={sheetOpen}
      >
        <Pressable
          onPress={() => setSheetOpen(false)}
          style={styles.sheetBackdrop}
          testID="home-account-sheet-backdrop"
        >
          <Pressable
            onPress={(e) => e.stopPropagation()}
            style={[styles.sheet, { backgroundColor: colors.surface }]}
          >
            <View
              style={[styles.sheetHandle, { backgroundColor: label(mode, 0.2) }]}
            />
            <Text style={[styles.sheetTitle, { color: colors.text }]}>
              {t('home.switchAccount')}
            </Text>
            <ListRow
              chevron={false}
              onPress={() => {
                setScope(null);
                setSheetOpen(false);
              }}
              right={
                scope === null ? (
                  <Check color={accent.orange} size={16} />
                ) : undefined
              }
              testID="home-scope-all"
              left={
                <View style={styles.accountRow}>
                  <View style={styles.accountBarIcon}>
                    <Layers color={foreground.onAccent} size={15} />
                  </View>
                  <View style={styles.accountCopy}>
                    <Text style={[styles.accountName, { color: colors.text }]}>
                      {t('home.allAccounts')}
                    </Text>
                    <Text
                      style={[styles.accountSub, { color: label(mode, 0.4) }]}
                    >
                      {t('common.accountCount', {
                        count: snapshot.accounts.length,
                      })}
                    </Text>
                  </View>
                </View>
              }
            />
            {snapshot.accounts.map((account, index) => (
              <ListRow
                chevron={false}
                key={account.id}
                last={index === snapshot.accounts.length - 1}
                onPress={() => {
                  setScope(account.id);
                  setSheetOpen(false);
                }}
                right={
                  scope === account.id ? (
                    <Check color={accent.orange} size={16} />
                  ) : undefined
                }
                left={
                  <View style={styles.accountRow}>
                    <AccountChip
                      color={chipColors[index % chipColors.length]}
                      name={account.name}
                      size={30}
                    />
                    <View style={styles.accountCopy}>
                      <Text
                        numberOfLines={1}
                        style={[styles.accountName, { color: colors.text }]}
                      >
                        {account.name}
                      </Text>
                      <Text
                        style={[styles.accountSub, { color: label(mode, 0.4) }]}
                      >
                        {t('common.zoneCount', { count: account.zoneCount })}
                      </Text>
                    </View>
                  </View>
                }
              />
            ))}
          </Pressable>
        </Pressable>
      </Modal>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  accountBar: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 10,
    minHeight: 44,
    paddingHorizontal: 16,
    paddingVertical: 8,
  },
  accountBarCaption: {
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 0.6,
    lineHeight: 15,
    textTransform: 'uppercase',
  },
  accountBarCopy: {
    flex: 1,
    minWidth: 0,
  },
  accountBarCount: {
    ...fontFace('subhead'),
    flexShrink: 0,
  },
  accountBarIcon: {
    alignItems: 'center',
    backgroundColor: accent.orange,
    borderRadius: 8,
    height: 30,
    justifyContent: 'center',
    width: 30,
  },
  accountBarName: {
    ...fontFace('headline'),
    lineHeight: 22,
  },
  accountCopy: {
    flex: 1,
    minWidth: 0,
  },
  accountDot: {
    borderRadius: 3,
    height: 6,
    width: 6,
  },
  accountName: {
    ...fontFace('bodyLarge', '500'),
    flexShrink: 1,
  },
  accountNameRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 8,
  },
  accountRequests: {
    ...fontFace('body', '600'),
    color: accent.orange,
    fontVariant: ['tabular-nums'],
  },
  accountRow: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  accountSub: {
    ...fontFace('subhead'),
    marginTop: 2,
  },
  banner: {
    alignItems: 'center',
    borderRadius: 16,
    flexDirection: 'row',
    gap: 10,
    marginHorizontal: 16,
    marginTop: 12,
    paddingHorizontal: 16,
    paddingVertical: 12,
  },
  bannerDot: {
    borderRadius: 4,
    height: 8,
    width: 8,
  },
  bannerText: {
    ...fontFace('subhead', '500'),
    flex: 1,
  },
  bannerTime: {
    ...fontFace('caption'),
  },
  chartCard: {
    borderRadius: 16,
    marginHorizontal: 16,
    marginTop: 16,
    padding: 16,
  },
  chartSub: {
    ...fontFace('footnote'),
    marginBottom: 12,
    marginTop: 2,
  },
  chartTitle: {
    ...fontFace('body', '600'),
  },
  content: {},
  issue: {
    ...fontFace('subhead'),
    marginTop: 6,
    paddingHorizontal: 20,
  },
  quickIcon: {
    alignItems: 'center',
    borderRadius: 8,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  safeArea: {
    flex: 1,
  },
  sheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    paddingBottom: 32,
    paddingTop: 8,
  },
  sheetBackdrop: {
    backgroundColor: 'rgba(0,0,0,0.5)',
    flex: 1,
    justifyContent: 'flex-end',
  },
  sheetHandle: {
    alignSelf: 'center',
    borderRadius: 3,
    height: 5,
    marginBottom: 8,
    width: 36,
  },
  sheetTitle: {
    ...fontFace('body', '600'),
    marginBottom: 4,
    paddingHorizontal: 16,
  },
  subtitle: {
    ...fontFace('body'),
    marginTop: 3,
    paddingHorizontal: 16,
  },
  tileRow: {
    flexDirection: 'row',
    gap: 12,
    marginTop: 12,
    paddingHorizontal: 16,
  },
  title: {
    ...fontFace('display'),
    paddingHorizontal: 16,
    paddingTop: 4,
  },
});
