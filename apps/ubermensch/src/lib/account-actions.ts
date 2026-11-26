import { clearCache } from '@/lib/session-cache';
import { dropToken } from '@/lib/token-store';
import type { StoredToken } from '@/types';

/**
 * Forgets one account on this device: its token and everything cached for it. Google is not
 * contacted; the token would expire within the hour anyway, and nothing here keeps it.
 */
export async function signOut(token: StoredToken): Promise<void> {
  const accounts = await dropToken(token.accessToken);
  for (const account of accounts) {
    await clearCache(account);
  }
}
