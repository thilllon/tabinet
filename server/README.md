# Tabinet sync server

`tabinet-server` keeps a signed-in user's saved sessions, YouTube notes (with their screenshots) and settings in step across devices. It
stores them **end-to-end encrypted**: a device encrypts each record with a key derived from the
user's passphrase before it is sent, so the server holds `{kind, id, updatedAt, deleted, iv,
ciphertext}` and never a session name, url, title, note or picture. Sign-in is with Google; the server keeps the
Google account id (`sub`) and the email, nothing else about the person.

The extension calls it at `CLOUD_SYNC.apiBase` in `src/constants.ts`, set to
`https://tabinet-server.vercel.app` since #178 (sign-in with `chrome.identity.getAuthToken`, then
the sync engine in `src/lib/cloud-sync.ts`); clearing `apiBase` makes the extension dormant again.
The functions run in Vercel region `sin1` (Singapore), pinned in `vercel.json`.

## Layout

| Path                              | What it is                                                                          |
| --------------------------------- | ----------------------------------------------------------------------------------- |
| `api/index.ts`                    | The Vercel function. `vercel.json` rewrites `/v1/*` to it                           |
| `src/app.ts`                      | `handle(request, deps)`: the whole API as one web-standard router                   |
| `src/validation.ts`               | Strict parsing of every body and query (sizes, id pattern, kinds, base64)           |
| `src/store.ts`                    | `createSqlStore(query)`: every SQL statement, over a one-function `query()` adapter |
| `src/google-auth.ts`              | Google access token verification through Google's tokeninfo endpoint                |
| `src/tokens.ts`                   | Bearer tokens: 32 random bytes, stored only as their sha256                         |
| `src/cors.ts`                     | CORS for the origins in `ALLOWED_ORIGINS` only                                      |
| `src/production.ts`               | The real dependencies (Neon, Google, clock, random bytes) and `createServer()`      |
| `src/migrations.ts`               | Applies `migrations/NNN_*.sql` once each, recorded in `schema_migrations`           |
| `migrations/001_init.sql`         | `users`, `auth_tokens`, `records` and the `record_seq` sequence                     |
| `migrations/002_notes_images.sql` | The `notes` and `image` kinds, and `apply_image_record()` for the screenshot cap    |
| `scripts/migrate.ts`              | `pnpm --filter tabinet-server migrate`                                              |
| `tests/`                          | vitest; the store and the routes run against PGlite (Postgres in WASM), no network  |

## API

JSON, base path `/v1`. Every route but `POST /v1/auth/google` and `OPTIONS` needs
`Authorization: Bearer <token>`; a missing, unknown or expired token gets 401
`{"error":"unauthorized"}`. Any bad input gets 400 `{"error":"bad_request"}`, a body over 4 MiB
413 `{"error":"payload_too_large"}`.

| Route                                      | Answer                                                                                                                                                                    |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `POST /v1/auth/google {accessToken}`       | 200 `{token, expiresAt, email, keySetup}`; the token lasts 90 days                                                                                                        |
| `POST /v1/auth/logout`                     | 204; the presented token is deleted                                                                                                                                       |
| `GET /v1/me`                               | 200 `{email, keySetup}`                                                                                                                                                   |
| `PUT /v1/keys {kdf, salt, check, checkIv}` | 201 the first time, then 409 `{"error":"key_exists"}`                                                                                                                     |
| `GET /v1/records?since=&limit=&kinds=`     | 200 `{records, next, hasMore}`: records of `kinds` with `seq > since`, ascending, `limit` 1..500 (500); `kinds` is a comma-separated list, `session,settings` when absent |
| `POST /v1/records {records}`               | 200 `{results: [{kind, id, status: "applied", seq} or {kind, id, status: "stale", current} or {kind, id, status: "rejected", reason: "image_limit"}]}`                    |
| `DELETE /v1/account`                       | 204; the user, their tokens and their records are deleted                                                                                                                 |

Limits and rules:

- Sign-in takes a Google OAuth access token, at most 4096 characters, which the server checks
  by POSTing it (form body, never a URL or a log) to `https://oauth2.googleapis.com/tokeninfo`
  with a 10 s timeout. It is accepted only on HTTP 200 when the token was issued to one of
  `GOOGLE_CLIENT_IDS` (`aud` must be one of them when Google reports it, otherwise `azp`: a token
  Google issued to another app for the same account is refused), `email_verified` is true,
  `email` and `sub` are non-empty and `expires_in` is above 0. A 400 or 401 from Google (an
  invalid or expired token) is 401 `unauthorized`; any other status (429, 408, a 5xx), a network
  failure or a timeout is 500, never a false 401. An empty `GOOGLE_CLIENT_IDS` is a configuration
  error and answers 500. The Google
  token is used for that one check and not stored.
- `kdf` is `{name: "PBKDF2", hash: "SHA-256", iterations}` with 100000..10000000 iterations;
  `salt` 16..64 bytes, `check` 1..1024 bytes, `checkIv` 12..32 bytes, all padded base64.
- A record's `kind` is `session`, `settings`, `notes` (one YouTube video's notes, `id` = the video
  id) or `image` (one note screenshot), its `id` matches `[A-Za-z0-9_-]{1,64}`,
  `updatedAt` is a non-negative integer (ms). Every record, a tombstone (`deleted: true`)
  included, has an `iv` of 12..32 bytes and a non-empty `ciphertext` of at most 1 MiB of base64:
  the client encrypts the deletion too, with the record's `kind`, `id`, `updatedAt` and `deleted`
  as AES-GCM additional data, so the server cannot forge a tombstone or move, replay or flip a
  record under other metadata.
- At most 100 records and at most 4 MiB of body per request, whichever comes first, so a client
  splits its batches by size as well as by count; unknown fields are refused. One bad record
  refuses the whole request. (Vercel itself refuses a body over 4.5 MB before the function runs,
  with no CORS headers and no JSON, which the 4 MiB limit keeps a client clear of.)
- Last writer wins per `(kind, id)`: a write applies only when its `updatedAt` is greater than the
  stored one; a tie or an older one comes back `stale` with the stored record, read after the
  write. Each record is one conditional upsert statement, so concurrent writers cannot lose an
  update, and every applied write takes a new `seq` from one global sequence. The statement locks
  the user's row first, so a user's writes commit in `seq` order and paging by `since` never
  skips one.
- At most `IMAGE_RECORD_LIMIT` (100, `src/store.ts`) live `image` records per account. A write
  that would add one more is answered `rejected` with `reason: "image_limit"` and stores nothing;
  tombstones and writes to an image that is already live are always accepted. Image writes go
  through the SQL function `apply_image_record()` (migration 002): it takes the same user row lock
  and then counts with a fresh snapshot, so two concurrent writers cannot both take the last place.
- `GET /v1/records` lists only `session` and `settings` records unless the client names more in
  `kinds`: versions of the extension from before notes refuse a page holding a kind they do not
  know. A client that starts asking for `notes,image` reads the feed again from 0 once.
- CORS headers go only to an `Origin` listed in `ALLOWED_ORIGINS`; preflight allows GET, POST, PUT,
  DELETE with `Authorization` and `Content-Type`. Every answer carries `Vary: Origin` and
  `Cache-Control: no-store`.
- Logs carry an error's name only, never a token or a record.

## Develop

```bash
pnpm install                          # from the repository root
pnpm server:typecheck                 # tsc over server/
pnpm server:test                      # vitest, against PGlite
```

## Deploy

1. **Create the Vercel project.** In Vercel, "Add New... > Project", import this repository and set
   **Root Directory** to `server`. Framework preset "Other"; no build command. The function runs on
   the Node.js runtime. Vercel compiles `api/index.ts` with the `typescript` it finds in `server/`,
   which needs the compiler API that TypeScript 7 no longer ships, so `server/` pins TypeScript 6.
2. **Add Postgres.** In the project's **Storage** tab, add **Neon** from the Vercel Marketplace and
   connect it to the project. This sets `DATABASE_URL` for every environment.
3. **Set the environment variables** (Settings > Environment Variables):
   - `DATABASE_URL`: set by step 2 (the pooled connection string).
   - `GOOGLE_CLIENT_IDS`: the OAuth client id from step 5, comma-separated if there are several.
   - `ALLOWED_ORIGINS`: `chrome-extension://bmbpmnfhfbdjdjpblimidmbohgccmjdg` (comma-separated; add
     the id of an unpacked development build if you test with one).

   Redeploy after changing them.

4. **Create the tables.** From the repository root, with the same connection string:

   ```bash
   DATABASE_URL='postgres://...' pnpm --filter tabinet-server migrate
   ```

   It applies every file in `migrations/` that has not run yet, so run it again after adding one.

5. **Create the Google OAuth client.** In Google Cloud Console, "APIs & Services > Credentials >
   Create credentials > OAuth client ID":
   - Application type: **Chrome extension**, item ID `bmbpmnfhfbdjdjpblimidmbohgccmjdg` (the store
     build). The extension signs in with `chrome.identity.getAuthToken` and sends the access token.
   - The OAuth consent screen asks for the scopes `openid` and `email` only.

   Put its client id in `GOOGLE_CLIENT_IDS` (step 3).

   This client works only for that item id. An unpacked build (`pnpm dev`, a local `dist/`) has
   another extension id, so `getAuthToken` refuses the client there. To test sign-in locally, load
   a build whose manifest carries the store item's public `key`, or create a second "Chrome
   extension" client for the unpacked id and add it to `GOOGLE_CLIENT_IDS` (comma-separated).

Check it: `curl https://<project>.vercel.app/v1/me` answers 401 `{"error":"unauthorized"}`.
