import { useCallback, useEffect, useRef, useState } from 'react';
import { Linking, StyleSheet, Text } from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { Globe } from 'lucide-react-native';
import {
  CloudflareApiError,
  getZoneSecurityLevel,
  setZoneSecurityLevel,
  type ZoneSecurityLevel,
} from '@/src/cloudflare/api';
import {
  fetchZonesSnapshot,
  getBearerForConnection,
  type ZoneListItem,
} from '@/src/cloudflare/resources';
import {
  forgetPreviousSecurityLevel,
  getPreviousSecurityLevel,
  rememberPreviousSecurityLevel,
} from '@/src/cloudflare/securityLevelMemory';
import { ZoneSubpage } from '@/src/components/ZoneSubpage';
import {
  Card,
  ToggleRow,
  showActionMenu,
  useToast,
  InlineEmpty,
  PermissionNotice,
} from '@/src/components/ui';
import { cloudflareErrorMessage } from '@/src/i18n/errors';
import { useTheme } from '@/src/theme/ThemeContext';
import { accent, font, label, spacing } from '@/src/theme/tokens';
import { mapLimit } from '@/src/utils/concurrency';

/** Cap parallel per-zone security-level lookups (accounts can have many zones). */
const SECURITY_LEVEL_CONCURRENCY = 6;

const FALLBACK_LEVEL: ZoneSecurityLevel = 'medium';

function isSecurityLevel(value: string | null): value is ZoneSecurityLevel {
  return (
    value === 'off' ||
    value === 'essentially_off' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'under_attack'
  );
}

export default function HomeUnderAttack() {
  const { t } = useTranslation();
  const { mode } = useTheme();
  const { showToast } = useToast();
  const params = useLocalSearchParams<{ accountId?: string }>();
  const [zones, setZones] = useState<ZoneListItem[]>([]);
  const [levels, setLevels] = useState<Record<string, ZoneSecurityLevel | null>>(
    {},
  );
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [permissionDenied, setPermissionDenied] = useState(false);
  const previousLevels = useRef<Record<string, ZoneSecurityLevel>>({});

  const load = useCallback(async () => {
    setError(null);
    const accountId = params.accountId || undefined;

    try {
      const snapshot = await fetchZonesSnapshot();
      const scoped = snapshot.zones.filter(
        (zone) => !accountId || zone.accountId === accountId,
      );
      setZones(scoped);

      let forbidden = false;
      const entries = await mapLimit(
        scoped,
        SECURITY_LEVEL_CONCURRENCY,
        async (zone) => {
          try {
            const bearer = await getBearerForConnection(zone.connectionId);
            const level = await getZoneSecurityLevel(bearer, zone.id);
            return [zone.id, level] as const;
          } catch (cause) {
            if (
              cause instanceof CloudflareApiError &&
              cause.code === 'forbidden'
            ) {
              forbidden = true;
            }
            return [zone.id, null] as const;
          }
        },
      );
      setPermissionDenied(forbidden);

      const next: Record<string, ZoneSecurityLevel | null> = {};
      const remembered: Record<string, ZoneSecurityLevel> = {};
      for (const [zoneId, level] of entries) {
        next[zoneId] = level;
        if (level && level !== 'under_attack') {
          remembered[zoneId] = level;
        }
      }
      previousLevels.current = remembered;
      setLevels(next);
    } catch (cause) {
      setError(cloudflareErrorMessage(cause));
    } finally {
      setLoading(false);
    }
  }, [params.accountId]);

  useEffect(() => {
    void load();
  }, [load]);

  const applyLevel = async (zone: ZoneListItem, value: ZoneSecurityLevel) => {
    setPendingId(zone.id);
    try {
      const bearer = await getBearerForConnection(zone.connectionId);
      await setZoneSecurityLevel(bearer, zone.id, value);
      setLevels((current) => ({ ...current, [zone.id]: value }));
      if (value !== 'under_attack') {
        delete previousLevels.current[zone.id];
        void forgetPreviousSecurityLevel(zone.id).catch(() => {});
      }
      showToast(
        value === 'under_attack'
          ? t('home.underAttackOn')
          : t('home.underAttackOff'),
      );
    } catch (cause) {
      showToast(cloudflareErrorMessage(cause), 'error');
    } finally {
      setPendingId(null);
    }
  };

  const onToggle = (zone: ZoneListItem, enabled: boolean) => {
    const current = levels[zone.id];
    if (enabled) {
      if (current && current !== 'under_attack') {
        previousLevels.current[zone.id] = current;
      }
      showActionMenu({
        title: t('home.underAttackEnable'),
        message: t('home.underAttackEnableConfirm', { name: zone.name }),
        cancelLabel: t('common.cancel'),
        actions: [
          {
            label: t('home.underAttackEnable'),
            destructive: true,
            onPress: () => {
              void (async () => {
                if (current && current !== 'under_attack') {
                  // Written before the switch, so the level survives even if
                  // the app is closed while the zone is under attack.
                  await rememberPreviousSecurityLevel(zone.id, current).catch(
                    () => {},
                  );
                }
                await applyLevel(zone, 'under_attack');
              })();
            },
          },
        ],
      });
      return;
    }

    void (async () => {
      const remembered =
        previousLevels.current[zone.id] ??
        (await getPreviousSecurityLevel(zone.id).catch(() => null));
      await applyLevel(zone, remembered ?? FALLBACK_LEVEL);
    })();
  };

  const levelLabel = (value: ZoneSecurityLevel | null): string => {
    if (!isSecurityLevel(value)) {
      return t('home.underAttackUnknown');
    }
    if (value === 'under_attack') {
      return t('home.securityLevel.under_attack');
    }
    return t('home.underAttackLevel', {
      level: t(`home.securityLevel.${value}`),
    });
  };

  return (
    <ZoneSubpage
      backLabel={t('tabs.home')}
      error={error}
      loading={loading && !error}
      onRefresh={load}
      subtitle={t('home.underAttackSubtitle')}
      title={t('home.underAttackTitle')}
    >
      <Text style={[styles.hint, { color: label(mode, 0.5) }]}>
        {t('home.underAttackHint')}
      </Text>

      {permissionDenied ? (
        <PermissionNotice
          title={t('common.permissionRequired')}
          message={t('home.underAttackNoPerm')}
          actionLabel={t('common.openApiTokens')}
          onAction={() => {
            void Linking.openURL(
              'https://dash.cloudflare.com/profile/api-tokens',
            );
          }}
        />
      ) : null}

      {zones.length === 0 && !loading ? (
        <InlineEmpty>
          {t('home.underAttackEmpty')}
        </InlineEmpty>
      ) : (
        <Card>
          {zones.map((zone, index) => {
            const level = levels[zone.id] ?? null;
            return (
              <ToggleRow
                key={zone.id}
                Icon={Globe}
                color={
                  level === 'under_attack' ? accent.orange : accent.blue
                }
                disabled={pendingId === zone.id || level === null}
                label={zone.name}
                last={index === zones.length - 1}
                onValueChange={(enabled) => onToggle(zone, enabled)}
                sub={levelLabel(level)}
                testID={`under-attack-toggle-${zone.id}`}
                value={level === 'under_attack'}
              />
            );
          })}
        </Card>
      )}
    </ZoneSubpage>
  );
}

const styles = StyleSheet.create({
  hint: {
    ...font('subhead'),
    marginBottom: 16,
    paddingHorizontal: spacing.lg,
  },
});
