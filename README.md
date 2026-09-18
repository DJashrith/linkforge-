# linkforge

A URL shortener I'm building from scratch to actually understand how these things work, instead of just using bit.ly and never thinking about it.

Stack is Node, Express and Postgres. Nothing fancy.

Right now it does one thing: you give it a long URL and it gives you back a short one. Redirects, accounts, click stats etc. are next (see the todo list at the bottom).

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

Tests (only cover the base62 logic for now):

```bash
npm test
```

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

Returns `400` if the url is missing, isn't http/https, or is longer than 2048 characters. I added the http/https check so nobody can shorten `javascript:` links.

### `GET /health`

Returns `{"status": "ok"}`.

## Project layout

```
db/migrations/     SQL migrations, applied in order
scripts/migrate.js tiny migration runner (tracks what's been applied)
src/base62.js      id <-> short code
src/routes/urls.js the /shorten endpoint
src/app.js         express setup
src/server.js      entry point
test/              tests
```

I wrote my own migration runner instead of pulling in a library. It's about 40 lines, and for a project this size that felt like enough.

## Todo

- [x] Schema + migrations
- [x] Base62 encoding
- [x] `POST /shorten`
- [ ] Redirects (`GET /:code`) and click counting
- [ ] Link expiry
- [ ] User accounts / auth
- [ ] Rate limiting
- [ ] Maybe custom aliases, maybe caching popular links
