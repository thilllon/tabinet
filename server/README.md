# Tabinet sync server

## Entry points

| To           | File                      | Started by                                                                                     |
| ------------ | ------------------------- | ---------------------------------------------------------------------------------------------- |
| Production   | `api/vercel.adaptor.ts`   | Vercel: `vercel.json` rewrites `/v1/*` and `/v2/*` to it, and it calls the app in `src/app.ts` |
| Railway      | `src/railway.adaptor.ts`  | Code only: it refuses to run (see "Deploy to Railway")                                         |
| Local        | `src/dev.ts`              | `pnpm --filter tabinet-server dev`: 127.0.0.1:8787, an empty in-memory database                |
| Migrate      | `scripts/migrate.ts`      | `DATABASE_URL=... pnpm --filter tabinet-server migrate` (003 also needs `WIPE_V1=yes`)         |
| KEK          | `scripts/kek.ts`          | `pnpm --filter tabinet-server kek:new <path>` / `kek:id <path>`                                |
| Schema check | `scripts/schema-check.ts` | `DATABASE_URL=... pnpm --filter tabinet-server schema:check`                                   |
| Stream check | `scripts/stream-check.ts` | `pnpm --filter tabinet-server stream-check`, once, at the cutover                              |

The Vercel adaptor has to be in `api/`: that is the only folder Vercel builds functions from with
the "Other" preset. It is the only Vercel-specific code. For the same reason the Railway adaptor
must never be in `api/`: Vercel would deploy it. Both serve the one handler from
`createServer()` in `src/production.ts`. To read the API, start at `src/app.ts`.

`tabinet-server` keeps a signed-in user's saved sessions, docs (YouTube notes, memos), screenshots
and settings in step across devices. It stores them **end-to-end encrypted**: a device encrypts
each record with its data key (DEK) before it is sent, so the server holds `{kind, id, updatedAt,
deleted, iv, ciphertext}` and never a session name, url, title, note, memo or picture. The DEK
travels only wrapped under the passphrase (the key envelope), and the server keeps even that only
sealed under its own key, the KEK, bound to the Google account. Sign-in is with Google; the server
keeps the Google account id (`sub`) and the email, nothing else about the person.

The extension calls it at `CLOUD_SYNC.apiBase` in `src/constants.ts`, set to
`https://tabinet-server.vercel.app`; clearing `apiBase` makes the extension dormant again. The
functions run in Vercel region `sin1` (Singapore), pinned in `vercel.json`.

Every limit below is in `POLICY` in the repository's `src/constants.ts`, the file the extension
reads too, and the only file outside `server/` that the server imports (`policy-server.test.ts`
fails on a server file that restates one). So it runs from a checkout of the whole repository,
never from a copy of `server/` alone.

## Layout

A Hono app, kept thin: a route handler calls the store directly. No services, classes or container.

| Path                               | What it is                                                                                                                 |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `api/vercel.adaptor.ts`            | The Vercel function: the five methods it exports, all one handler                                                          |
| `src/app.ts`                       | `createApp(deps)`: the whole API, top to bottom, in the order the checks run                                               |
| `src/production.ts`                | The real dependencies and `createServer()`, which builds the app on first use                                              |
| `src/env.ts`                       | The production check, then environment parsing; an error names a variable, never a value                                   |
| `src/kek-id.ts`                    | `PINNED_KEK_ID`: the one KEK id production may run with (empty until the cutover)                                          |
| `src/envelope.ts`                  | The key envelope: parse, the 97 bytes, seal and open under the KEK, the write verifier                                     |
| `src/stream.ts`                    | The NDJSON body of a pull, one database batch per read                                                                     |
| `src/railway.adaptor.ts`           | The Railway server: `PORT`, graceful shutdown; imported by nothing                                                         |
| `src/dev.ts`                       | The local server, with a random in-memory KEK; never imported by what is deployed                                          |
| `src/context.ts`                   | `Deps`, and what middleware leaves on the request's context                                                                |
| `src/responses.ts`                 | JSON, error, no content and NDJSON answers with their exact headers                                                        |
| `src/types.ts`                     | The wire shapes (`RecordOut`, `WriteResult`, `PullLine`, `ErrorCode`, ...)                                                 |
| `src/routes/auth.ts`               | Sign in with Google, log out                                                                                               |
| `src/routes/account.ts`            | `me`, delete the account                                                                                                   |
| `src/routes/keys.ts`               | Open the envelope, create or replace it                                                                                    |
| `src/routes/records.ts`            | The pull stream and the push                                                                                               |
| `src/middleware/cors.ts`           | CORS for the origins in `ALLOWED_ORIGINS` only, and every `OPTIONS`                                                        |
| `src/middleware/v1-gate.ts`        | `/v1` and `/v1/*`: 410, before anything else is looked at                                                                  |
| `src/middleware/auth.ts`           | The bearer, checked before any body is read                                                                                |
| `src/middleware/key-header.ts`     | `Tabinet-Key-Id` against the bearer's account, before the body                                                             |
| `src/middleware/body-limit.ts`     | `readJsonBody(limit)`: reads a JSON body as a stream, and keeps nothing past the limit                                     |
| `src/middleware/errors.ts`         | Google unavailable becomes a 503, anything else thrown a JSON 500                                                          |
| `src/middleware/unmatched.ts`      | 404, 405 with `Allow`, and no automatic `HEAD`                                                                             |
| `src/db/client.ts`                 | Neon's HTTP driver (production only), with each statement's timeout as its signal                                          |
| `src/db/store.ts`                  | `createSqlStore(query)`: every SQL statement, over a one-function `query()` adapter                                        |
| `src/db/migrations.ts`             | Applies `migrations/NNN_*.sql` once each, recorded in `schema_migrations`                                                  |
| `src/validation.ts`                | Strict parsing of every body, header and query (sizes, ids, canonical base64)                                              |
| `src/google-auth.ts`               | Google access token verification through Google's tokeninfo endpoint                                                       |
| `src/tokens.ts`                    | Bearer tokens: 32 random bytes, stored only as their sha256                                                                |
| `migrations/001_init.sql`, `002_*` | Protocol v1, kept as they ran                                                                                              |
| `migrations/003_sync_v2.sql`       | Protocol v2: drops every v1 table and creates `accounts`, `account_tokens`, `account_records` and `apply_account_record()` |
| `scripts/`                         | `migrate`, `kek`, `schema-check`, `stream-check`                                                                           |
| `public/`                          | The only static files Vercel serves (`robots.txt`); never delete it                                                        |
| `vercel.json`                      | Preset "Other", the region, the install command, the function's limits, the rewrites                                       |
| `src/tests/`                       | vitest: PGlite with the real migrations, and a real Postgres when `TEST_DATABASE_URL` is set                               |

Hono's defaults differ from this API in a few places, each overridden and pinned by
`src/tests/contract.test.ts`: it serves `HEAD` as `GET` (here a 405), decodes the path before
matching (here the exact pathname), passes only `Error`s to `onError` (here every throw is the same
500), and its `c.json()` and `bodyLimit` answer differently (so `responses.ts` and
`middleware/body-limit.ts` are used instead).

## API (protocol v2)

Base path `/v2`. `/v1` and everything under it answer 410 `{"error":"upgrade_required"}` to every
method but `OPTIONS`, before a bearer, a body or the database is looked at (a `HEAD` gets the 410
without a body): no v1 row, key or bearer is accepted or migrated.

The checks run in this order, so an earlier one decides: CORS and `OPTIONS` (always 204), the
`/v1` gate, the route (404 `not_found`; 405 `method_not_allowed` with `Allow`), the bearer (401
`unauthorized`, and 401 means nothing else), the `Tabinet-Key-Id` header against the bearer's
account (400; 409 `key_missing` or `key_mismatch`, so a 409 never reads the body), the body (413
`payload_too_large`, 400 `bad_request`), Google (403, 503), the database. JSON answers carry
`Content-Type: application/json; charset=utf-8` and `Cache-Control: no-store`; an error is exactly
`{"error":"<code>"}`; anything thrown is 500 `internal`. Times are integer milliseconds.

| Route                                         | Answer                                                                                                                                   |
| --------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v2/auth/google {accessToken}`          | 200 `{token, expiresAt, accountId, email, key}`; 403 `google_refused`, 503 `google_unavailable`                                          |
| `POST /v2/auth/logout`                        | 204; the presented bearer is deleted                                                                                                     |
| `GET /v2/me`                                  | 200 `{accountId, email, key, usage}`                                                                                                     |
| `POST /v2/keys/open {accessToken}`            | 200 `{envelope}`; 403 `google_refused` / `google_account_mismatch`, 409 `key_missing`, 500 `key_unavailable`, 503                        |
| `PUT /v2/keys {accessToken, envelope, proof}` | 201 on create, 200 on replace: `{key}`; 403 also `proof_invalid`; 409 `key_exists`, `key_missing`, `key_mismatch`, `generation_conflict` |
| `GET /v2/records?since=<n>` + key header      | 200 NDJSON, below                                                                                                                        |
| `POST /v2/records {records}` + key header     | 200 `{results, usage}`                                                                                                                   |
| `DELETE /v2/account {accessToken}`            | 204; the account, its bearers and records are deleted (a new sign-in makes a new `accountId`)                                            |

`key` is `{keyId, generation}` or null, `usage` is `{bytes, screenshots}`. The shapes are in
`src/types.ts`, declared the same way in the extension's `src/types.ts`.

**Sign-in.** A Google OAuth access token, at most `POLICY.request.maxAccessTokenChars`, checked by
POSTing it (form body, never a URL or a log) to `https://oauth2.googleapis.com/tokeninfo` within
`POLICY.request.googleTimeoutMs`. It is accepted only on HTTP 200 with the token issued to one of
`GOOGLE_CLIENT_IDS` (`aud` when Google reports it, otherwise `azp`), `email_verified` true,
non-empty `email` and `sub`, and `expires_in` above 0. A 400 or 401 from Google is 403
`google_refused`; a timeout, a network failure, 408, 429, a 5xx or an answer that is not JSON is
503 `google_unavailable`. The bearer is 32 random bytes, kept only as its sha256, valid for
`POLICY.signIn.tokenLifetimeMs`; a sign-in also drops the account's expired bearers. Sign-in never
answers an envelope and never uses the KEK.

**Keys.** Opening, replacing and deleting the account each need, besides the bearer, a live Google
token of the same account in the body: a bearer alone opens and deletes nothing, and another
account's token is 403 `google_account_mismatch`. The envelope is sealed (AES-256-GCM, a fresh IV)
under the KEK with the associated data `["tabinet-envelope-v2", sub, kekId, keyId, generation]`,
where `sub` is the one Google verified in that request, never one read from the database; so a
sealed envelope moved to another row, or a `sub` rewritten in the database, opens nothing. Any
failure to open, or a row sealed under another KEK, is 500 `key_unavailable`, and nothing is
rewritten. A create needs no key and no record yet; a replace (a passphrase change) needs the same
key id, the write proof (the server keeps only its sha256, `write_verifier`) and the generation one
above the stored one, in one conditional UPDATE, so of two concurrent changes one wins and a Google
token without the data key cannot replace the envelope. The byte formats (the envelope's 97 bytes,
the 125-byte sealed text) are in `src/envelope.ts`, with the shared test vectors in the repository's
`src/tests/key-vectors.json`.

**Push.** The whole request is checked before any write: at most `POLICY.request.maxRecordsPerPush`
records, no repeated `(kind, id)`, a kind of `session`, `settings`, `image` or `doc`, an id of
`[A-Za-z0-9_-]{1,64}` (exactly 43 for a doc, `settings` for the settings, which cannot be
deleted), a 12-byte IV, a canonical base64 ciphertext of at least 17 bytes and at most
`POLICY.record.maxCiphertextBytes` characters live or `POLICY.record.maxTombstoneChars` deleted,
and a `baseSeq` on a doc only. Each record is then one `apply_account_record()` call, in order:

- `session`, `settings`, `image`: last writer wins on `updatedAt`. `doc`: compare and swap, only
  when `baseSeq` is the stored seq (null for no row) and `updatedAt` is newer.
- A stamp more than `POLICY.record.maxClockAheadMs` ahead of the server's clock is `rejected`
  `clock_ahead` before any SQL.
- A row counts `max(ciphertext, POLICY.record.maxTombstoneChars) + POLICY.record.overheadBytes`
  against `POLICY.account.storageBytes`; live screenshots count against
  `POLICY.account.screenshots`. A live write past either is `rejected` (`storage_limit`,
  `image_limit`); a shrinking write and a tombstone over an existing row always apply; a tombstone
  for a row the server lacks is written while it fits and answered `absent` (nothing stored) when
  it does not. So the cap is a hard bound.
- `stale` carries the stored row, read in a statement of its own (`current: null` for a doc with
  no row); past `POLICY.request.maxStaleBytes` of them, the rest are `withheld: true`, so the
  answer stays under Vercel's 4.5 MB.
- An account deleted or a key changed in the middle answers 401 or 409; earlier records of that
  request stay written, as after any lost answer. `usage` is read after the last write.

The account row is locked first, so an account's writes commit in `seq` order and the caps and the
compare and swap are exact under concurrency (`src/tests/postgres.test.ts`, on a real Postgres).

**Pull.** `since` is 1 to 16 digits (0 when absent); every other parameter is ignored (Vercel's
rewrite adds `path`). `Content-Type: application/x-ndjson; charset=utf-8`, `Cache-Control:
no-store, no-transform`, one JSON line each: `start` (`keyId`, `since`, `through` = the account's
last seq when the answer began, `usage`), then batches of `record` lines each closed by a
`checkpoint` (`cursor`, `count`), then `end` (`cursor`, `complete`). A batch is at most
`POLICY.pull.batchRecords` rows and `POLICY.pull.batchBytes` of what they count, always at least one
row. Nothing is queued ahead: one batch is read from the database each time the reader asks for
more, so an account of 50 MiB streams past Vercel's limit without being held in memory. After
`POLICY.pull.streamMs` the stream ends `complete: false` at the last checkpoint. A database error,
a timeout, an account deleted or a key changed mid-stream closes it **without** an end line, which
the client treats as a failed run; every checkpoint is a safe place to resume from.

CORS headers go only to an `Origin` listed in `ALLOWED_ORIGINS`, on errors too; a preflight allows
`GET, POST, PUT, DELETE` with `Authorization, Content-Type, Tabinet-Key-Id`, max age 600. Every
answer carries `Vary: Origin`. Bodies are read as a stream and reading stops at the first chunk
over the limit, whatever `Content-Length` says: `POLICY.request.maxSmallBodyBytes` on the auth, keys
and account routes, `POLICY.request.maxBodyBytes` on records (below Vercel's own 4.5 MB). Logs
carry an error's name only, never a token, a proof, an envelope, a ciphertext or a connection string.

On Vercel two cases are answered before the app runs, without JSON or CORS: a method the adaptor
does not export (`HEAD`, `PATCH`) is Vercel's own empty 405, and a trailing slash its plain 404. No
released extension sends either.

## Develop

```bash
pnpm install                          # from the repository root
pnpm server:typecheck                 # tsc over server/
pnpm server:test                      # vitest, against PGlite
pnpm --filter tabinet-server dev      # http://127.0.0.1:8787, stop with Ctrl+C
```

`TEST_DATABASE_URL=postgres://...@localhost/...` adds the concurrency tests on a real Postgres (CI runs
them against a `postgres:17` service); they refuse any host but localhost and work in a schema of
their own.

`dev` cannot touch production: it always uses an empty in-memory PGlite with the real migrations and
a random in-memory KEK, never reads a `.env` file, `DATABASE_URL` or `TABINET_KEK`, never runs the
production check, and listens on 127.0.0.1 only. It has no way around sign-in either: without
`GOOGLE_CLIENT_IDS` in the shell every sign-in is refused, and with it tokens are checked with Google
as in production. `PORT` and `ALLOWED_ORIGINS` are read from the shell too.

## Environment and the production check

| Variable            | Production                  | Preview                | Development |
| ------------------- | --------------------------- | ---------------------- | ----------- |
| `DATABASE_URL`      | yes                         | yes, the same database | as needed   |
| `GOOGLE_CLIENT_IDS` | the one store client        | the same               | as needed   |
| `ALLOWED_ORIGINS`   | the store origin            | the same               | as needed   |
| `TABINET_KEK`       | one base64 KEK, type secret | **never**              | **never**   |
| `VERCEL_ENV`        | `production`, set by Vercel | `preview`              | absent      |

Before anything else, on every start and with no "only on Vercel" branch, `readEnv()` requires
`VERCEL_ENV=production`, a non-empty `PINNED_KEK_ID` in `src/kek-id.ts`, and `TABINET_KEK` being
canonical base64 of 32 bytes whose id is that pin. Otherwise it throws before a database client, a
Google verifier or the app exists, and `createServer()` answers every request (`OPTIONS` and `/v1`
too) 500 `{"error":"internal"}` with CORS, with no query at all. So a preview, a local run, the
Railway adaptor, a production deployment with another KEK, and every build before the cutover pins
an id all refuse to run.

Only `GOOGLE_CLIENT_IDS` of the store build belongs in production. Do not add a development OAuth
client there.

What the preview check does not cover, accepted: a preview holds `DATABASE_URL`, so code pushed to
any branch (or a bad dependency in it) could delete, withhold or roll back rows. It cannot open an
envelope, having no KEK. Dependency updates are therefore merged by hand, never automatically.

## The KEK

The KEK is created on the owner's machine, never in the repository, and backed up offline:

```bash
pnpm --filter tabinet-server kek:new /absolute/path/outside/the/repository/production.kek
pnpm --filter tabinet-server kek:id /absolute/path/outside/the/repository/production.kek
```

`kek:new` writes base64 of 32 random bytes (no newline, mode 0600, never over an existing file) and
prints only the id; `kek:id` prints the id of a file. Both refuse a relative path and any path
inside the repository. Then add the file's content to Vercel as `TABINET_KEK`, type secret, in
Production only, put the printed id in `PINNED_KEK_ID` and deploy.

**Rotation and loss** are the same procedure, with a short gap: write a new KEK, replace
`TABINET_KEK` and `PINNED_KEK_ID` together, deploy, then change the passphrase on a device that is
ready (its `PUT /v2/keys` needs no opening and reseals under the new KEK). Until then a new device's
unlock gets `key_unavailable`. Delete the old production deployments afterwards: each keeps the KEK
it was built with. There is no keyring and no reseal script.

## Migrations

Plain SQL in `migrations/NNN_name.sql`, applied once each by `pnpm --filter tabinet-server migrate`
in its own transaction. Never edit a migration that has run on production; add the next number.

`003_sync_v2.sql` is destructive on purpose: it drops every v1 table and function (so every
statement of every deployment built before v2 fails instead of reading or writing) and creates the
v2 tables under new names. On a database that holds a v1 account it raises and changes nothing
unless the run says `WIPE_V1=yes`, which `migrate` passes to the migration as the transaction-local
setting `tabinet.wipe_v1`:

```bash
DATABASE_URL='postgres://...' pnpm --filter tabinet-server schema:check
WIPE_V1=yes DATABASE_URL='postgres://...' pnpm --filter tabinet-server migrate
DATABASE_URL='postgres://...' pnpm --filter tabinet-server schema:check
```

`schema:check` runs SELECTs only and prints the applied migrations, the public tables and their row
counts, never a row or the connection string. No migration runs on a build or a start.

## Deploy to Vercel

1. **The Vercel project.** Root Directory `server`, preset "Other". `"framework": null` in
   `vercel.json` pins that preset and has to stay: without it a project's first deployment detects
   Hono, builds `src/app.ts` instead of `api/`, and fails. Vercel compiles
   `api/vercel.adaptor.ts` with the `typescript` it finds in `server/`, which needs the compiler API
   that TypeScript 7 no longer ships, so `server/` pins TypeScript 6. Keep **Include source files
   outside of the Root Directory** on: the function bundles `../src/constants.ts`. `installCommand`
   installs the server's dependency closure only, with no install scripts. The function may run
   for 300 s (`maxDuration`, above `POLICY.pull.streamMs`) and is told when a client goes away
   (`supportsCancellation`).
2. **Postgres.** Neon from the Vercel Marketplace, connected to the project (`DATABASE_URL`).
3. **Variables**, as in the table above. Redeploy after changing them.
4. **Tables**, with the direct connection string, as in "Migrations".
5. **The Google OAuth client.** "Chrome extension", item ID `bmbpmnfhfbdjdjpblimidmbohgccmjdg`,
   scopes `openid` and `email` only; its id is `GOOGLE_CLIENT_IDS`.
6. **The KEK**, as in "The KEK".

Check it: `curl https://<project>.vercel.app/v2/me` answers 401 `{"error":"unauthorized"}` (a 500
means the production check refused, or the database is not migrated) and `/v1/me` 410.

## Deploy to Railway

Code only, never deployed, never given the KEK, and not a failover: the same app on a long-running
Node server, which refuses to run because the production check fails there (there is no
`VERCEL_ENV=production`), so every request is a 500. Enabling it is a deliberate code change. The
settings below follow Railway's and Railpack's documentation and have not been tried on Railway
itself.

| Setting (service)  | Value                                                                                                              |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Root Directory     | empty: the repository root, for the lockfile, the workspace and files outside `server/` such as `src/constants.ts` |
| Builder            | Railpack (Node and pnpm versions come from `mise.toml`)                                                            |
| Build Command      | `echo no build` (without one Railpack runs the root `build`, the extension's)                                      |
| Start Command      | `cd server && exec node --import tsx src/railway.adaptor.ts`                                                       |
| Pre-Deploy Command | empty: migrations are never part of a deploy or a start                                                            |
| Healthcheck Path   | empty: it needs a 2xx, and no route here answers a plain GET with one                                              |
| Region             | Southeast Asia (Singapore), next to the database                                                                   |
| Watch Paths        | `/server/**`, `/src/constants.ts`, `/package.json`, `/pnpm-lock.yaml`, `/pnpm-workspace.yaml`, `/mise.toml`        |
| Networking         | a public domain, on the port Railway passes in `PORT`                                                              |

| Variable                              | Value                                                                                                                       |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `DATABASE_URL`                        | as on Vercel: a **Neon** connection string. The driver speaks Neon's HTTP protocol, so Railway's own Postgres does not work |
| `GOOGLE_CLIENT_IDS`                   | as on Vercel                                                                                                                |
| `ALLOWED_ORIGINS`                     | as on Vercel                                                                                                                |
| `PORT`                                | set by Railway; the server does not start without it                                                                        |
| `RAILPACK_INSTALL_CMD`                | `pnpm install --frozen-lockfile --prod --filter tabinet-server`                                                             |
| `RAILPACK_START_CMD`                  | the Start Command again, for the build                                                                                      |
| `RAILWAY_DEPLOYMENT_DRAINING_SECONDS` | `15`. The default is 0, which kills the server straight after SIGTERM                                                       |
| `RAILWAY_DEPLOYMENT_OVERLAP_SECONDS`  | `10`. Without a health check this covers the new server's start                                                             |

- The start command is the `start` script's own command, run with `exec` so that Node gets the
  SIGTERM. Do not put `pnpm --filter tabinet-server start` there: pnpm ends a clean stop with exit
  code 1, and `node --run start` does not pass the signal on.
- On SIGTERM the server takes no new connection, lets the requests in flight finish for up to 10
  seconds (hence the 15 above) and exits with 0.
- A bad variable is reported as on Vercel: the server starts, and every request is a 500 with
  `configuration failed` in the log. Only a missing or invalid `PORT` stops it from starting.
- Railpack decides at build time what to put in the image. Without a start command at that point it
  takes the repository root for what it is, a Vite app, and deploys `dist/` behind Caddy with no
  Node and no server: hence `RAILPACK_START_CMD`.
- `tsx` is a production dependency because it is what runs the TypeScript. There is no build.
- Create the tables by hand, as in "Migrations".
- The extension calls `CLOUD_SYNC.apiBase` only. Moving production here means changing it and
  saying so in `PRIVACY_POLICY.md`.

Today every request there answers 500 `{"error":"internal"}`: the production check refuses.
