// main/claude-auth.ts — cleanup of the claude.ai sessions stored by earlier versions.
// The app no longer signs in to claude.ai (#140): Anthropic does not allow third-party
// apps to offer Claude sign-in or to collect or store claude.ai session tokens (Claude
// Code legal and compliance page). What is left removes what earlier versions stored.
//
// Each Claude account had its own Electron partition (`persist:account-<id>`, see
// store/migrate.ts); before per-account partitions (issue #4) the cookies lived in
// session.defaultSession.

import { session } from 'electron';

/** Clears cookies and storage of the account partition (disconnect, removal, #140 cleanup). */
export async function clearClaudePartition(partition: string): Promise<void> {
  await session.fromPartition(partition).clearStorageData();
}

/**
 * Removes the claude.ai cookies left in session.defaultSession by versions before
 * per-account partitions (#4). Returns how many were removed.
 */
export async function clearDefaultSessionClaudeCookies(): Promise<number> {
  const source = session.defaultSession;
  const cookies = await source.cookies.get({ url: 'https://claude.ai' });
  for (const c of cookies) {
    const host = (c.domain ?? 'claude.ai').replace(/^\./, '');
    await source.cookies.remove(`https://${host}${c.path ?? '/'}`, c.name);
  }
  return cookies.length;
}
