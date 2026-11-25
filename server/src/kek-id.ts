/**
 * The id of the one KEK production may run with: `HKDF(kek, "tabinet-kek-id-v2", 8)` as hex,
 * printed by `pnpm --filter tabinet-server kek:id <file>`. Empty until the cutover commits the
 * production id, and while it is empty the production check in env.ts refuses to start, so no
 * deployment can run v2 without it. Never the test vectors' id.
 */
export const PINNED_KEK_ID: string = '';
