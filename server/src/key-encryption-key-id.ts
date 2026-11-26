/**
 * The id of the one key encryption key production may run with: `HKDF(keyEncryptionKey, "tabinet-kek-id-v2", 8)` as hex,
 * printed by `pnpm --filter tabinet-server key-encryption-key:id <file>`. Pinned at the v10 cutover; the production check in
 * env.ts refuses to start unless TABINET_KEY_ENCRYPTION_KEY has exactly this id. Never the test vectors' id.
 */
export const PINNED_KEY_ENCRYPTION_KEY_ID: string = '05a383fd18385170';
