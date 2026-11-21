import * as SecureStore from 'expo-secure-store';
import type { ZoneSecurityLevel } from './api';

/**
 * Security level a zone had before Under Attack mode was switched on.
 *
 * Kept on disk rather than in screen state: the screen remounts and the app
 * restarts while a zone sits in Under Attack mode, and without the original
 * level the only option is a fixed fallback, which can quietly turn a `high`
 * zone down to `medium` when the attack is over.
 */
const key = (zoneId: string) => `uam-previous-${zoneId}`;

const LEVELS = new Set<string>([
  'off',
  'essentially_off',
  'low',
  'medium',
  'high',
]);

export async function rememberPreviousSecurityLevel(
  zoneId: string,
  level: ZoneSecurityLevel,
): Promise<void> {
  if (level === 'under_attack') {
    return;
  }
  await SecureStore.setItemAsync(key(zoneId), level);
}

export async function getPreviousSecurityLevel(
  zoneId: string,
): Promise<ZoneSecurityLevel | null> {
  const stored = await SecureStore.getItemAsync(key(zoneId));
  return stored && LEVELS.has(stored) ? (stored as ZoneSecurityLevel) : null;
}

export async function forgetPreviousSecurityLevel(
  zoneId: string,
): Promise<void> {
  await SecureStore.deleteItemAsync(key(zoneId));
}
