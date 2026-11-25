import type { Context, Handler, MiddlewareHandler } from 'hono';

import type { Store } from './db/store.js';
import type { VerifyGoogleToken } from './google-auth.js';
import type { User } from './types.js';

/** Everything the app reaches outside itself, injected so tests run without network. */
export interface Deps {
  store: Store;
  verifyGoogleToken: VerifyGoogleToken;
  /** Milliseconds since the epoch. */
  now: () => number;
  randomBytes: (size: number) => Uint8Array;
  /** Origins answered with CORS headers, e.g. `chrome-extension://<id>`. */
  allowedOrigins: readonly string[];
}

/** What the middleware leaves on the context for the handler after it. */
export interface AppEnv {
  Variables: {
    /** Set by `requireUser()`. */
    user: User;
    /** Set by `requireUser()`. */
    tokenHash: string;
    /** Set by `readJsonBody`: the parsed body, undefined when it is not JSON. */
    body: unknown;
  };
}

export type AppContext = Context<AppEnv>;
export type AppHandler = Handler<AppEnv>;
export type AppMiddleware = MiddlewareHandler<AppEnv>;
