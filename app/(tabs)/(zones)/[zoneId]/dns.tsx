import { useCallback, useEffect, useState } from 'react';
import {
  ActivityIndicator,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
  type ListRenderItemInfo,
} from 'react-native';
import { useLocalSearchParams } from 'expo-router';
import { Cloud, Plus } from 'lucide-react-native';
import { useTranslation } from 'react-i18next';
import {
  createDnsRecord,
  deleteDnsRecord,
  listDnsRecords,
  updateDnsRecord,
  type CfDnsRecord,
  type DnsRecordInput,
} from '@/src/cloudflare/api';
import {
  validateDnsRecord,
  type DnsFieldErrors,
} from '@/src/cloudflare/dnsValidation';
import { getBearerForConnection } from '@/src/cloudflare/resources';
import { ZoneSubpage } from '@/src/components/ZoneSubpage';
import {
  CardRow,
  ListRow,
  SectionLabel,
  showActionMenu,
  ToggleRow,
  useToast,
  InlineEmpty,
} from '@/src/components/ui';
import { cloudflareErrorMessage } from '@/src/i18n/errors';
import { useSequencer } from '@/src/state/useSequencedLoad';
import { useTheme } from '@/src/theme/ThemeContext';
import {
  accent,
  fontFace,
  foreground,
  label,
  tint,
} from '@/src/theme/tokens';

const recordTypes = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS'] as const;

const typeColors: Record<string, string> = {
  A: accent.orange,
  AAAA: accent.purple,
  CNAME: accent.blue,
  MX: accent.green,
  TXT: accent.yellow,
  NS: accent.red,
};

const proxyableTypes = new Set(['A', 'AAAA', 'CNAME']);

interface EditorState {
  /** The record being edited, or null when creating a new one. */
  record: CfDnsRecord | null;
  type: string;
  name: string;
  content: string;
  priority: string;
  proxied: boolean;
}

export default function ZoneDns() {
  const { t } = useTranslation();
  const { mode, colors } = useTheme();
  const { showToast } = useToast();
  const params = useLocalSearchParams<{
    zoneId: string;
    connectionId: string;
    name?: string;
  }>();
  const [records, setRecords] = useState<CfDnsRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [bearer, setBearer] = useState<string | null>(null);
  const [editor, setEditor] = useState<EditorState | null>(null);
  const [fieldErrors, setFieldErrors] = useState<DnsFieldErrors>({});
  const [saving, setSaving] = useState(false);
  const sequence = useSequencer();

  const load = useCallback(
    () =>
      sequence(async (ifCurrent) => {
        ifCurrent(setError)(null);
        try {
          const resolved = await getBearerForConnection(params.connectionId);
          ifCurrent(setBearer)(resolved);
          ifCurrent(setRecords)(await listDnsRecords(resolved, params.zoneId));
        } catch (cause) {
          ifCurrent(setError)(cloudflareErrorMessage(cause));
        }
      }),
    [params.connectionId, params.zoneId, sequence],
  );

  useEffect(() => {
    void load();
  }, [load]);

  const refresh = () => {
    void load();
  };

  const openEditor = useCallback((record: CfDnsRecord | null) => {
    setFieldErrors({});
    setEditor({
      record,
      type: record?.type ?? 'A',
      name: record?.name ?? '',
      content: record?.content ?? '',
      priority:
        record?.priority !== undefined ? String(record.priority) : '10',
      proxied: record?.proxied ?? false,
    });
  }, []);

  /** Updates the draft and clears the stale error of the edited fields. */
  const patchEditor = (patch: Partial<EditorState>) => {
    setEditor((prev) => (prev ? { ...prev, ...patch } : prev));
    setFieldErrors((prev) => {
      const next = { ...prev };
      if ('name' in patch) {
        delete next.name;
      }
      if ('content' in patch || 'type' in patch) {
        delete next.content;
      }
      if ('priority' in patch || 'type' in patch) {
        delete next.priority;
      }
      return next;
    });
  };

  const save = () => {
    if (!editor || !bearer) {
      return;
    }
    const errors = validateDnsRecord(editor);
    if (Object.keys(errors).length > 0) {
      setFieldErrors(errors);
      return;
    }
    const input: DnsRecordInput = {
      type: editor.type,
      name: editor.name.trim(),
      content: editor.content.trim(),
      ttl: editor.record?.ttl ?? 1,
      proxied: proxyableTypes.has(editor.type) ? editor.proxied : undefined,
      priority: editor.type === 'MX' ? Number(editor.priority) : undefined,
    };
    setSaving(true);
    const editing = editor.record !== null;
    const action = editing
      ? updateDnsRecord(bearer, params.zoneId, editor.record!.id, input)
      : createDnsRecord(bearer, params.zoneId, input);
    void action
      .then(() => {
        setEditor(null);
        refresh();
        showToast(t(editing ? 'dns.savedToast' : 'dns.createdToast'));
      })
      .catch((cause) => {
        showToast(cloudflareErrorMessage(cause), 'error');
      })
      .finally(() => setSaving(false));
  };

  const confirmDelete = () => {
    if (!editor?.record || !bearer) {
      return;
    }
    const { record } = editor;
    showActionMenu({
      title: t('dns.deleteRecord'),
      message: t('dns.deleteConfirm', { type: record.type, name: record.name }),
      cancelLabel: t('common.cancel'),
      actions: [
        {
          label: t('dns.deleteRecord'),
          destructive: true,
          onPress: () => {
            setSaving(true);
            void deleteDnsRecord(bearer, params.zoneId, record.id)
              .then(() => {
                setEditor(null);
                refresh();
                showToast(t('dns.deletedToast'));
              })
              .catch((cause) => {
                showToast(cloudflareErrorMessage(cause), 'error');
              })
              .finally(() => setSaving(false));
          },
        },
      ],
    });
  };

  const inputStyle = [
    styles.input,
    { backgroundColor: colors.searchBg, color: colors.text },
  ];

  const recordKey = useCallback((record: CfDnsRecord) => record.id, []);

  const renderRecord = useCallback(
    ({ item, index }: ListRenderItemInfo<CfDnsRecord>) => {
      const color = typeColors[item.type] ?? accent.gray;
      const last = index === (records?.length ?? 0) - 1;
      return (
        <CardRow first={index === 0} last={last}>
          <ListRow
            chevron={false}
            last={last}
            onPress={() => openEditor(item)}
            testID={`dns-record-${item.id}`}
            right={
              <Cloud
                accessibilityLabel={
                  item.proxied ? t('dns.proxied') : t('dns.dnsOnly')
                }
                color={item.proxied ? accent.orange : label(mode, 0.25)}
                size={15}
              />
            }
            left={
              <View style={styles.row}>
                <View
                  style={[
                    styles.typeBadge,
                    { backgroundColor: tint(color, '22') },
                  ]}
                >
                  <Text style={[styles.typeText, { color }]}>{item.type}</Text>
                </View>
                <View style={styles.copy}>
                  <Text
                    numberOfLines={2}
                    style={[styles.name, { color: colors.text }]}
                  >
                    {item.name}
                  </Text>
                  <Text
                    numberOfLines={4}
                    style={[styles.value, { color: label(mode, 0.4) }]}
                  >
                    {item.content}
                  </Text>
                </View>
              </View>
            }
          />
        </CardRow>
      );
    },
    [colors.text, mode, openEditor, records?.length, t],
  );

  return (
    <ZoneSubpage
      backLabel={params.name ?? t('zone.fallbackTitle')}
      error={error}
      list={{
        data: records ?? [],
        keyExtractor: recordKey,
        renderItem: renderRecord,
        empty: <InlineEmpty>{t('dns.empty')}</InlineEmpty>,
      }}
      loading={!records}
      onRefresh={load}
      headerRight={
        <Pressable
          accessibilityLabel={t('dns.addRecord')}
          accessibilityRole="button"
          hitSlop={6}
          onPress={() => openEditor(null)}
          style={styles.addButton}
          testID="dns-add"
        >
          <Plus color={foreground.onAccent} size={18} />
        </Pressable>
      }
      subtitle={
        records
          ? `${params.name ?? ''} · ${t('zone.recordsCount', { count: records.length })}`
          : params.name
      }
      title={t('zone.svcDns')}
    >
      {records && records.length > 0 ? (
        <SectionLabel>{t('dns.records')}</SectionLabel>
      ) : null}

      <Modal
        animationType="slide"
        onRequestClose={() => setEditor(null)}
        transparent
        visible={editor !== null}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
          style={styles.sheetBackdropWrap}
        >
          <Pressable
            onPress={() => setEditor(null)}
            style={styles.sheetBackdrop}
            testID="dns-editor-backdrop"
          />
          {editor ? (
            <View style={[styles.sheet, { backgroundColor: colors.surface }]}>
              <View
                style={[
                  styles.sheetHandle,
                  { backgroundColor: label(mode, 0.2) },
                ]}
              />
              <Text style={[styles.sheetTitle, { color: colors.text }]}>
                {editor.record ? t('dns.editRecord') : t('dns.addRecord')}
              </Text>

              <Text style={[styles.fieldLabel, { color: label(mode, 0.5) }]}>
                {t('dns.typeLabel')}
              </Text>
              <ScrollView
                horizontal
                showsHorizontalScrollIndicator={false}
                contentContainerStyle={styles.typePills}
              >
                {recordTypes.map((type) => {
                  const selected = editor.type === type;
                  return (
                    <Pressable
                      key={type}
                      accessibilityRole="button"
                      onPress={() => patchEditor({ type })}
                      style={[
                        styles.typePill,
                        {
                          backgroundColor: selected
                            ? accent.orange
                            : colors.searchBg,
                        },
                      ]}
                      testID={`dns-type-${type}`}
                    >
                      <Text
                        style={[
                          styles.typePillText,
                          {
                            color: selected
                              ? foreground.onAccent
                              : label(mode, 0.6),
                          },
                        ]}
                      >
                        {type}
                      </Text>
                    </Pressable>
                  );
                })}
              </ScrollView>

              <Text style={[styles.fieldLabel, { color: label(mode, 0.5) }]}>
                {t('dns.nameLabel')}
              </Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                onChangeText={(name) => patchEditor({ name })}
                placeholder={t('dns.namePlaceholder')}
                placeholderTextColor={label(mode, 0.3)}
                style={[...inputStyle, fieldErrors.name && styles.inputError]}
                testID="dns-input-name"
                value={editor.name}
              />
              {fieldErrors.name ? (
                <Text style={styles.fieldError} testID="dns-error-name">
                  {t(fieldErrors.name)}
                </Text>
              ) : null}

              <Text style={[styles.fieldLabel, { color: label(mode, 0.5) }]}>
                {t('dns.contentLabel')}
              </Text>
              <TextInput
                autoCapitalize="none"
                autoCorrect={false}
                multiline={editor.type === 'TXT'}
                onChangeText={(content) => patchEditor({ content })}
                placeholder={t('dns.contentPlaceholder')}
                placeholderTextColor={label(mode, 0.3)}
                style={[
                  ...inputStyle,
                  editor.type === 'TXT' ? styles.inputMultiline : null,
                  fieldErrors.content && styles.inputError,
                ]}
                testID="dns-input-content"
                value={editor.content}
              />
              {fieldErrors.content ? (
                <Text style={styles.fieldError} testID="dns-error-content">
                  {t(fieldErrors.content)}
                </Text>
              ) : null}

              {editor.type === 'MX' ? (
                <>
                  <Text
                    style={[styles.fieldLabel, { color: label(mode, 0.5) }]}
                  >
                    {t('dns.priorityLabel')}
                  </Text>
                  <TextInput
                    keyboardType="number-pad"
                    onChangeText={(priority) => patchEditor({ priority })}
                    placeholderTextColor={label(mode, 0.3)}
                    style={[
                      ...inputStyle,
                      fieldErrors.priority && styles.inputError,
                    ]}
                    testID="dns-input-priority"
                    value={editor.priority}
                  />
                  {fieldErrors.priority ? (
                    <Text style={styles.fieldError} testID="dns-error-priority">
                      {t(fieldErrors.priority)}
                    </Text>
                  ) : null}
                </>
              ) : null}

              {proxyableTypes.has(editor.type) ? (
                <View style={styles.toggleWrap}>
                  <ToggleRow
                    Icon={Cloud}
                    label={t('dns.proxiedLabel')}
                    last
                    onValueChange={(proxied) => patchEditor({ proxied })}
                    testID="dns-toggle-proxied"
                    value={editor.proxied}
                  />
                </View>
              ) : null}

              <Pressable
                accessibilityRole="button"
                disabled={saving}
                onPress={save}
                style={[styles.saveButton, saving && styles.buttonDisabled]}
                testID="dns-save"
              >
                {saving ? (
                  <ActivityIndicator color={foreground.onAccent} />
                ) : (
                  <Text style={styles.saveLabel}>
                    {editor.record ? t('dns.save') : t('dns.addRecord')}
                  </Text>
                )}
              </Pressable>

              {editor.record ? (
                <Pressable
                  accessibilityRole="button"
                  disabled={saving}
                  onPress={confirmDelete}
                  style={styles.deleteButton}
                  testID="dns-delete"
                >
                  <Text style={styles.deleteLabel}>
                    {t('dns.deleteRecord')}
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}
        </KeyboardAvoidingView>
      </Modal>
    </ZoneSubpage>
  );
}

const styles = StyleSheet.create({
  addButton: {
    alignItems: 'center',
    backgroundColor: accent.orange,
    borderRadius: 16,
    height: 32,
    justifyContent: 'center',
    width: 32,
  },
  buttonDisabled: {
    opacity: 0.6,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  deleteButton: {
    alignItems: 'center',
    marginTop: 4,
    minHeight: 44,
    justifyContent: 'center',
    paddingVertical: 12,
  },
  deleteLabel: {
    ...fontFace('headline', '400'),
    color: accent.red,
  },
  fieldError: {
    ...fontFace('subhead'),
    color: accent.red,
    marginTop: 6,
    paddingHorizontal: 16,
  },
  fieldLabel: {
    ...fontFace('footnote', '500'),
    marginBottom: 6,
    marginTop: 14,
    paddingHorizontal: 16,
    textTransform: 'uppercase',
  },
  input: {
    ...fontFace('headline', '400'),
    borderRadius: 10,
    marginHorizontal: 16,
    minHeight: 44,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  inputError: {
    borderColor: accent.red,
    borderWidth: 1,
  },
  inputMultiline: {
    minHeight: 72,
    textAlignVertical: 'top',
  },
  name: {
    ...fontFace('bodyLarge', '500'),
  },
  row: {
    alignItems: 'center',
    flexDirection: 'row',
    gap: 12,
  },
  saveButton: {
    alignItems: 'center',
    backgroundColor: accent.orange,
    borderRadius: 12,
    marginHorizontal: 16,
    marginTop: 20,
    minHeight: 50,
    justifyContent: 'center',
    paddingVertical: 13,
  },
  saveLabel: {
    ...fontFace('headline'),
    color: foreground.onAccent,
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
  },
  sheetBackdropWrap: {
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
    ...fontFace('headline'),
    paddingHorizontal: 16,
  },
  toggleWrap: {
    marginTop: 8,
  },
  typeBadge: {
    alignItems: 'center',
    borderRadius: 6,
    paddingVertical: 2,
    width: 52,
  },
  typeText: {
    ...fontFace('footnote', '700'),
  },
  typePill: {
    borderRadius: 17,
    minHeight: 34,
    justifyContent: 'center',
    paddingHorizontal: 16,
    paddingVertical: 7,
  },
  typePillText: {
    ...fontFace('body', '600'),
  },
  typePills: {
    gap: 8,
    paddingHorizontal: 16,
  },
  value: {
    fontFamily: 'Menlo',
    fontSize: 12,
    lineHeight: 17,
    marginTop: 2,
  },
});
