import type { Context, Handler, MiddlewareHandler } from 'hono';

import type { Store } from './db/store.js';
import type { KeyEncryptionKey } from './envelope.js';
import type { VerifyGoogleToken } from './google-auth.js';
import type { Account } from './types.js';

/** Everything the app reaches outside itself, injected so tests run without network. */
export interface Deps {
  store: Store;
  verifyGoogleToken: VerifyGoogleToken;
  /** The one configured key encryption key: production's comes from `TABINET_KEY_ENCRYPTION_KEY` after the production check. */
  keyEncryptionKey: KeyEncryptionKey;
  /** Milliseconds since the epoch. */
  now(): number;
  randomBytes(n: number): Uint8Array;
  /** Origins answered with CORS headers, e.g. `chrome-extension://<id>`. */
  allowedOrigins: readonly string[];
}

/** What the middleware leaves on the context for the handler after it. */
export interface AppEnv {
  Variables: {
    /** Set by `requireAccount()`: the bearer's account, as the bearer lookup read it. */
    account: Account;
    /** Set by `requireAccount()`. */
    tokenHash: string;
    /** Set by `requireKeyHeader`: the `Tabinet-Key-Id` header, equal to the account's key. */
    keyId: string;
    /** Set by `readJsonBody()`: the parsed body, undefined when it is not JSON. */
    body: unknown;
  };
}

export type AppContext = Context<AppEnv>;
export type AppHandler = Handler<AppEnv>;
export type AppMiddleware = MiddlewareHandler<AppEnv>;
