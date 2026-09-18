# linkforge

A URL shortener I'm building from scratch to actually understand how these things work, instead of just using bit.ly and never thinking about it.

Stack is Node, Express and Postgres. Nothing fancy.

What works so far: shortening URLs (with an optional custom alias), redirecting, and counting clicks. Accounts, stats and the rest are still on the todo list at the bottom.

## How the short codes work

This was the fun part.

Every URL gets saved as a row in Postgres with an auto-increment id. That id is converted to base62 (0-9, a-z, A-Z) and the result is the short code:

```
id 1                    -> 1
id 62                   -> 10
id 125                  -> 21
id 9223372036854775807  -> aZl8N0y58M7   (max BIGINT)
```

So even if the table somehow hit the max bigint, codes would never be longer than 11 characters. And since ids are unique, codes are unique too, so there's no "generate a random string and check if it's taken" loop. That's the main reason I went with this over random codes.

A couple of things I ran into along the way:

- The short code depends on the id, but you don't get the id until after the insert. I didn't want to insert a row and then immediately update it, so the endpoint grabs the next value from the sequence first, encodes it, and inserts everything in one query. This also means `short_code` can be `NOT NULL`.
- node-postgres returns BIGINT columns as strings, because JS numbers lose precision past 2^53. So the encoder uses BigInt the whole way through.

The obvious downside is that codes are sequential, so anyone can guess `/1`, `/2`, `/3`... Not a big deal yet, but I'll probably scramble the ids before encoding at some point.

### Custom aliases and collisions

You can pick your own code (`/launch` instead of `/g9`). Aliases share the same `short_code` column as generated codes, so the unique constraint on that column is what catches collisions. Every insert uses `ON CONFLICT DO NOTHING`, so if two people grab the same alias at the same moment, Postgres picks the winner and the other one gets a 409. I tested this by firing 20 requests for the same alias at once: 1 got a 201 and 19 got a 409.

The tricky case took me a while to notice. Say someone creates the alias `abc`. That's a perfectly valid base62 string, and `abc` is what id 39134 encodes to. So when the id counter eventually gets there, the generated code would clash with the alias. When that happens the insert just comes back empty, and it skips that id and moves on to the next one (`abd`). It gives up after 10 tries in a row, which would only happen if someone deliberately reserved a run of upcoming codes.

## Validation

Since this thing redirects people wherever the database says, I'm fairly strict about what goes in:

- Only `http` and `https`. No `javascript:`, `data:`, `file:` etc.
- No usernames/passwords in the URL. `https://paypal.com@evil.example` looks like PayPal but actually goes to evil.example.
- No localhost or private network addresses (`127.0.0.1`, `192.168.x.x`, `169.254.169.254`, `[::1]`...). Sneaky forms like `http://2130706433` or `http://0x7f.1` get caught too, because Node's URL parser turns them back into `127.0.0.1` before I check.
- No hostnames without a dot (`http://intranet/`).
- No shortening links that point back at linkforge itself, so you can't make redirect loops.
- Optional domain blocklist through the `BLOCKED_DOMAINS` env var. Subdomains are blocked too.
- Max 2048 characters, checked again after normalizing because percent-encoding makes URLs longer.

Duplicates: if you submit a URL that's already been shortened (and the link hasn't expired), you get the existing short link back with a 200 instead of a new row. URLs are normalized first, so `https://EXAMPLE.com:443/x` and `https://example.com/x` count as the same. Custom aliases skip this check, since if you asked for a specific name you probably want it.

This doesn't check whether a site is actually malicious. Hooking up something like Google Safe Browsing would be the next step for that.

## Running it locally

You'll need Node 22+ and a Postgres database. A local install is fine, or a free hosted one like Neon or Supabase.

```bash
git clone https://github.com/DJashrith/linkforge-.git
cd linkforge-
npm install
cp .env.example .env    # on Windows cmd: copy .env.example .env
```

Open `.env` and set `DATABASE_URL` to your database. Then:

```bash
npm run db:migrate
npm run dev
```

It'll be running on http://localhost:3000.

### Tests

```bash
npm test
```

That runs the unit tests for base62 and validation. The API tests hit a real database and **wipe the urls table**, so they're skipped unless you set `TEST_DATABASE_URL` in `.env` to a separate, throwaway database. Don't point it at your dev one.

## API

### `POST /shorten`

```bash
curl -X POST http://localhost:3000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/some/really/long/path"}'
```

```json
{
  "short_code": "1",
  "short_url": "http://localhost:3000/1",
  "long_url": "https://example.com/some/really/long/path",
  "created_at": "2026-09-18T02:53:01.395Z",
  "expires_at": null
}
```

With a custom alias:

```bash
curl -X POST http://localhost:3000/shorten \
  -H "Content-Type: application/json" \
  -d '{"url": "https://example.com/launch", "alias": "launch"}'
```

Aliases are 3-16 characters: letters, numbers, `-` and `_`. They're case-sensitive, just like generated codes. A few words like `shorten`, `health`, `api` and `admin` are reserved for routes.

| Status | When |
|---|---|
| 201 | new short link created |
| 200 | this URL was already shortened, or you re-sent the same alias for the same URL |
| 400 | bad URL or bad alias (the `error` field says why) |
| 409 | alias is already taken by a different URL |

### `GET /:shortCode`

Redirects (302) to the original URL and bumps `click_count`. The lookup and the click count happen in one `UPDATE ... RETURNING` query.

- 404 if the code doesn't exist
- 410 if the link has expired

I went with 302 over 301 on purpose. Browsers cache 301s forever, so repeat visits would never reach the server and wouldn't get counted.

### `GET /health`

Returns `{"status": "ok"}`.

## Project layout

```
db/migrations/      SQL migrations, applied in order
scripts/migrate.js  tiny migration runner (tracks what's been applied)
src/base62.js       id <-> short code
src/validation.js   URL + alias checks
src/url-store.js    all the SQL (create, dedupe, collisions, resolve)
src/routes/urls.js  POST /shorten and GET /:shortCode
src/config.js       env vars
src/app.js          express setup
src/server.js       entry point
test/               unit tests + API tests
```

I wrote my own migration runner instead of pulling in a library. It's about 40 lines, and for a project this size that felt like enough.

## Todo

- [x] Schema + migrations
- [x] Base62 encoding
- [x] `POST /shorten`
- [x] Redirects (`GET /:code`) and click counting
- [x] Custom aliases + collision handling
- [x] URL validation and duplicate detection
- [ ] Setting an expiry date from the API (redirects already respect `expires_at`, there's just no way to set it yet)
- [ ] User accounts / auth
- [ ] Rate limiting
- [ ] Click stats that don't hammer one row per click, probably Redis or batched writes
- [ ] Maybe caching popular links
