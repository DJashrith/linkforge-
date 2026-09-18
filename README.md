# linkforge

A URL shortener I'm building from scratch to actually understand how these things work, instead of just using bit.ly and never thinking about it.

Stack is Node, Express, Postgres and Redis. Nothing fancy.

What works so far: shortening URLs (with an optional custom alias), redirects served from a Redis cache, and click tracking that happens in the background (referrer, user agent, rough location) with a stats endpoint. Accounts and the rest are still on the todo list at the bottom.

Under load on my laptop, adding the cache and moving click tracking out of the redirect took it from ~12k to ~16k redirects/s, cut p99 latency from 9ms to 4ms, and took Postgres from ~11,700 queries/s down to ~70. The numbers and the caveats are in [Benchmarks](#benchmarks).

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

## Caching

Redirects check Redis first (`link:<code>` -> long URL) and only go to Postgres on a miss. The cache is filled on the way back from Postgres, and new links are written into it as soon as they're created.

It also caches the misses. If someone hits `/doesnotexist` in a loop, only the first request reaches Postgres; after that there's a "missing" marker in Redis for 60 seconds. Expired links get an "expired" marker, so they don't hit Postgres either.

### Invalidation

This is the part I spent the most time on. Links can be updated or deleted now (see the `/urls` endpoints below), and after that the cache must never keep sending people to the old URL.

The simple version is "delete the key after updating Postgres", but that has a race:

1. A redirect misses the cache and reads the **old** row from Postgres
2. Someone updates the link, and the cache key gets deleted
3. The redirect from step 1 finishes and writes the **old** URL back into the cache

And now it's stale until the TTL runs out. What I ended up doing:

- Reads that miss fill the cache with `SET ... NX`, meaning "only if the key doesn't exist". So they can never overwrite anything.
- Updates, deletes and creates write the new value straight into the cache (deletes write the "missing" marker) right after Postgres. They always overwrite.

So in the race above, step 2 puts the new value in, and step 3's `NX` write just does nothing. There's a test for exactly this.

Some other details:

- A cached link never outlives its `expires_at`. The TTL is whichever is shorter: the default (1 hour) or the time left until it expires.
- Creating an alias overwrites any "missing" marker for it, so the link works right away even if someone tried that URL a second earlier.
- If Redis is down, redirects just go to Postgres. Cache calls fail fast (250ms timeout, no queueing) instead of hanging. I tested this by killing Redis in the middle of a run.
- If an update happens while Redis is unreachable, that key can't be overwritten, so Redis would keep the stale value once it comes back. The app remembers those keys and deletes them once Redis answers again (it retries every 5 seconds). If the app restarts during the outage it forgets that list, so the 1 hour TTL is the last line of defence there.

## Click tracking

On Day 2 every redirect ran `UPDATE urls SET click_count = click_count + 1`, so every visitor waited on a Postgres write. Now the redirect sends the 302 first and then drops an event onto a Redis Stream without waiting for it. A separate worker process (`npm run worker`) reads the events in batches of up to 500 and writes them to Postgres.

Each event has: timestamp, referrer, user agent, and the visitor's IP. The worker turns the IP into country/region/city using the offline GeoLite2 database (via `geoip-lite`), and **the IP itself is never stored**. HEAD requests don't count, so link preview bots checking where a link goes don't inflate the numbers.

I used a Redis Stream instead of a plain list or BullMQ. A list is simpler, but once the worker pops an event it's gone, so if the worker crashes before writing to Postgres those clicks are lost. BullMQ would handle that, but it's a lot of machinery for "write some rows". A stream with a consumer group sits in the middle:

- An event stays "pending" until the worker acks it, and the ack only happens after the Postgres write succeeds. If the worker dies halfway, the events are still there.
- On startup and every 30 seconds, a worker claims events another worker has been holding for over a minute (`XAUTOCLAIM`). So you can run several workers and a crashed one's events get picked up.
- Because of that, an event can occasionally get processed twice. Each event has a UUID and `click_events.event_id` is `UNIQUE`, so the second insert does nothing. The `click_count` bump is part of the same SQL statement and only counts rows that actually got inserted, so the count can't drift either.
- Malformed events are skipped and acked. Otherwise one bad event would fail the whole batch forever.
- Processed events are deleted from the stream, so normally it's tiny. There's a cap at 1 million events as a safety valve if the worker is down for ages; past that the oldest events get dropped instead of Redis running out of memory.

The tradeoff: `click_count` lags behind by however long the worker takes (normally well under a second), and if Redis is completely down, those clicks are dropped. The redirect still works though, which matters more.

## Benchmarks

`npm run bench -- http://localhost:3000 "label"` creates 1000 links, then hits random ones in two ways: 5000 requests one at a time (to measure latency) and 15 seconds of load with 50 connections (to measure throughput). I ran it against three versions using the same database:

- **Day 2**: Postgres lookup + `UPDATE click_count` on every redirect (I checked out the old commit)
- **Cache off**: current code with `CACHE_ENABLED=false`, so a Postgres lookup, but clicks go to the queue
- **Cache on**: current code

Medians of 3 runs on my laptop (i7-12700H, 16GB, Windows 11, Postgres 18, Redis 8), all on the same machine:

| | Day 2 | Cache off | Cache on |
|---|---|---|---|
| One at a time, p50 | 0.41ms | 0.31ms | **0.28ms** |
| One at a time, p99 | 0.99ms | 0.61ms | **0.57ms** |
| 50 connections, throughput | 12,274 req/s | 9,208 req/s | **16,313 req/s** |
| 50 connections, p99 | 9ms | 8ms | **4ms** |
| Postgres queries/s during the load test | ~11,700 | ~8,800 | **~70** |

Being honest about what this shows:

- **The cache barely changes single-request latency here.** Everything runs on one machine, and a Redis GET and a Postgres primary-key lookup both take about 0.08ms over localhost (I measured both directly). Postgres with a hot index in memory is just fast. Most of the 0.41 -> 0.28ms improvement comes from taking the `UPDATE` out of the redirect, not from Redis.
- **Where the cache matters is load.** Postgres goes from handling every redirect to handling basically none of them, throughput goes up ~33% over Day 2 (~77% over cache off), and p99 halves. It was also by far the most stable of the three between runs; the two Postgres-based versions had one noticeably worse run each, the cache-on numbers barely moved.
- **Cache off is slower than Day 2 under load**, which surprised me at first. It still hits Postgres for every redirect *and* also sends the event to Redis, so it's more work per request for the Node process, which is the bottleneck at these rates.
- With a real network between the app and the database, the gap would be bigger. I didn't want to fake that with an artificial delay though.
- I ran these with the click worker stopped, because on one laptop it competes with the server for CPU and made the numbers noisy. The events just piled up in the stream. Afterwards the worker cleared the whole backlog (366,618 events) in 17.9 seconds, **~20,500 events/s**, and none were lost or duplicated.

## Running it locally

You'll need Node 22+, Postgres and Redis 6.2+.

- Postgres: a local install, or a free hosted one like Neon or Supabase.
- Redis: a local install (on Windows I used a [redis-windows](https://github.com/redis-windows/redis-windows) build; Memurai also works), or a free hosted one like Upstash.

```bash
git clone https://github.com/DJashrith/linkforge-.git
cd linkforge-
npm install
cp .env.example .env    # on Windows cmd: copy .env.example .env
```

Open `.env` and set `DATABASE_URL`, `REDIS_URL` and `ADMIN_TOKEN` (any long random string). Then:

```bash
npm run db:migrate
npm run dev        # the API on http://localhost:3000
npm run worker     # in a second terminal, writes clicks to Postgres
```

If you forget the worker, nothing breaks. Clicks just wait in Redis until you start it.

### Tests

```bash
npm test
```

That always runs the unit tests (base62, validation, event parsing). The API, cache and click tests need a real Postgres and Redis, and they **wipe the tables and flush the Redis database**. So they're skipped unless you set `TEST_DATABASE_URL` and `TEST_REDIS_URL` to throwaway ones (e.g. `redis://localhost:6379/15`). Don't point them at your dev data.

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

Aliases are 3-16 characters: letters, numbers, `-` and `_`. They're case-sensitive, just like generated codes. A few words like `shorten`, `health`, `urls` and `admin` are reserved for routes.

| Status | When |
|---|---|
| 201 | new short link created |
| 200 | this URL was already shortened, or you re-sent the same alias for the same URL |
| 400 | bad URL or bad alias (the `error` field says why) |
| 409 | alias is already taken by a different URL |

### `GET /:shortCode`

Redirects (302) to the original URL and queues a click event.

- 404 if the code doesn't exist
- 410 if the link has expired

I went with 302 over 301 on purpose. Browsers cache 301s forever, so repeat visits would never reach the server and wouldn't get counted.

### Managing links

There are no user accounts yet, so for now these need `Authorization: Bearer <ADMIN_TOKEN>`. If `ADMIN_TOKEN` isn't set they're switched off (503).

| | |
|---|---|
| `GET /urls/:code` | link details including `click_count` and `is_custom` |
| `PATCH /urls/:code` | change `url` and/or `expires_at` (an ISO date, or `null` for never). A date in the past expires the link right away. |
| `DELETE /urls/:code` | delete the link and its click history (204) |
| `GET /urls/:code/stats` | total clicks, clicks per day (last 30 days), top countries, top referrers |

```bash
curl -X PATCH http://localhost:3000/urls/launch \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"expires_at": "2026-12-31T23:59:59Z"}'
```

```json
{
  "short_code": "launch",
  "total_clicks": 4,
  "clicks_by_day": [{ "day": "2026-09-18", "clicks": 4 }],
  "top_countries": [{ "country": "GB", "clicks": 2 }, { "country": "??", "clicks": 1 }, { "country": "US", "clicks": 1 }],
  "top_referrers": [{ "referrer": "twitter.com", "clicks": 2 }, { "referrer": "direct", "clicks": 1 }, { "referrer": "www.google.com", "clicks": 1 }]
}
```

`??` means the location couldn't be worked out (a private IP, for example). If the app runs behind a proxy or load balancer, set `TRUST_PROXY` (e.g. `1`), otherwise every click looks like it came from the proxy.

### `GET /health`

Returns `{"status": "ok"}`.

## Project layout

```
db/migrations/        SQL migrations, applied in order
scripts/migrate.js    tiny migration runner (tracks what's been applied)
scripts/bench.js      redirect benchmark
src/base62.js         id <-> short code
src/validation.js     URL, alias and expiry checks
src/url-store.js      all the SQL for links
src/cache.js          Redis cache + invalidation rules
src/links.js          keeps Postgres and the cache in sync
src/clicks/queue.js   pushes click events onto the stream
src/clicks/events.js  parses events + geo lookup
src/clicks/consumer.js reads batches, writes to Postgres, acks
src/worker.js         the worker process
src/routes/           POST /shorten, GET /:code, /urls admin endpoints
src/auth.js           admin token check
src/config.js         env vars
src/app.js            express setup
src/server.js         entry point
test/                 unit tests + API/cache/click tests
```

I wrote my own migration runner instead of pulling in a library. It's about 40 lines, and for a project this size that felt like enough.

## Todo

- [x] Schema + migrations
- [x] Base62 encoding
- [x] `POST /shorten`
- [x] Redirects (`GET /:code`)
- [x] Custom aliases + collision handling
- [x] URL validation and duplicate detection
- [x] Redis cache with proper invalidation
- [x] Update/delete links, set expiry dates
- [x] Async click tracking (referrer, user agent, location) + stats
- [ ] User accounts / auth (then the `/urls` endpoints become "your own links")
- [ ] Rate limiting
- [ ] Scramble ids so codes aren't guessable
- [ ] Nicer stats: browsers/devices from the user agent, maybe a small dashboard

---

Location data comes from GeoLite2, created by MaxMind and available from https://www.maxmind.com.
