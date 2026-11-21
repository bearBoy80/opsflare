import { setAccountScope } from '../state/accountScope';
import { invalidateAllSnapshots } from './cache';
import { removeAllConnections } from './connections';

/**
 * Removes every Cloudflare credential and everything cached from them.
 *
 * Resetting the local account must take these with it: the credentials are
 * only protected by the local password, so leaving them behind would hand them
 * to whoever creates the next local account on this device.
 */
export async function wipeCloudflareData(): Promise<void> {
  await removeAllConnections();
  invalidateAllSnapshots();
  setAccountScope(null);
}
