# Geocoder

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js >= 20](https://img.shields.io/badge/node-%3E%3D20-339933.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/types-TypeScript-3178C6.svg)](https://www.typescriptlang.org/)

Turn free-form location text into structured places.

Geocoder resolves self-reported locations, such as the ones people write on
GitHub profiles (`"SF Bay Area"`, `"Belo Horizonte, MG"`, `"Berlin 🇩🇪"`), into a
**city, state, and country**, with coordinates when available. It is built for
research and data pipelines that need to geocode many short, messy strings
reliably and politely.

It ships as:

- **A TypeScript library** — `@hsborges-msr/geocoder`
- **An HTTP API** — `GET /search?q=...`, with Swagger docs
- **A bulk CLI** — newline-delimited text in, NDJSON out, resumable

> [!NOTE]
> Geocoder targets **administrative places** (cities, states, countries). It is
> not designed for street addresses or points of interest.

## Contents

- [Why Geocoder](#why-geocoder)
- [Install](#install)
- [Quick start](#quick-start)
- [Result format](#result-format)
- [Providers](#providers)
- [Composing geocoders](#composing-geocoders)
- [HTTP API](#http-api)
- [Bulk geocoding](#bulk-geocoding)
- [Configuration](#configuration)
- [Docker](#docker)
- [Usage policy, attribution, and privacy](#usage-policy-attribution-and-privacy)
- [Development](#development)
- [License](#license)

## Why Geocoder

- **Multiple providers** — [OpenStreetMap Nominatim](https://nominatim.org/),
  [Photon](https://photon.komoot.io/), and [LocationIQ](https://locationiq.com/),
  all returning the same normalized `Address` shape.
- **Fallback** — when one provider finds nothing or fails with a retryable
  error, the next one is tried.
- **Caching** — in-memory LRU with separate TTLs for found and not-found
  results, an optional persistent store (SQLite in the CLI), and
  deduplication of concurrent identical queries.
- **Polite by default** — per-provider queues default to one request per
  second, one at a time, with retries for transient failures.
- **Validated output** — every result is checked against a
  [Zod](https://zod.dev/) schema; malformed provider payloads are rejected.
- **Cancellable** — every search accepts an `AbortSignal`.
- **Deployable server** — health checks, optional inbound rate limiting,
  graceful shutdown, structured logs, and a non-root Docker image.

## Install

Requires Node.js 20 or later. The package is ESM-only.

```bash
npm install github:hsborges-msr/geocoder
# or
yarn add github:hsborges-msr/geocoder
```

## Quick start

### Library

```typescript
import { Cache, Fallback, OpenStreetMap, Photon } from '@hsborges-msr/geocoder';

const geocoder = new Cache(
  new Fallback(
    new OpenStreetMap({
      osmServer: 'https://nominatim.openstreetmap.org',
      email: 'you@example.com', // required by the public Nominatim server
      userAgent: 'my-app/1.0 (https://example.com/contact)' // required too
    }),
    new Photon()
  ),
  { size: 1000, positiveTtl: 3_600_000, negativeTtl: 300_000 } // TTLs in ms
);

const address = await geocoder.search('Belo Horizonte, MG');
// → { city: 'Belo Horizonte', state: 'Minas Gerais', country: 'Brazil', ... }
// → null when nothing is found
```

Every geocoder implements the same interface:

```typescript
search(q: string, options?: { signal?: AbortSignal }): Promise<Address | null>
```

See the [core package README](packages/core/README.md) for all provider
options and the [decorators guide](packages/core/src/geocoder/decorators/README.md)
for caching, throttling, fallback, and load balancing.

### HTTP server

```bash
OSM_EMAIL=you@example.com \
OSM_USER_AGENT='my-app/1.0 (https://example.com/contact)' \
npx geocoder --port 8080

curl 'http://localhost:8080/search?q=Belo%20Horizonte'
```

Open <http://localhost:8080/docs> for interactive Swagger UI.

### Bulk CLI

```bash
printf 'Paris\nSF Bay Area\nBelo Horizonte, MG\n' > places.txt

OSM_EMAIL=you@example.com \
OSM_USER_AGENT='my-app/1.0 (https://example.com/contact)' \
npx geocoder bulk places.txt --cache-dir .cache > results.ndjson
```

## Result format

A successful search returns an `Address`. Illustrative example:

```json
{
  "source": "Paris, France",
  "name": "Paris, Île-de-France, France",
  "type": "city",
  "confidence": 0.88,
  "score": 0.88,
  "latitude": 48.8534951,
  "longitude": 2.3483915,
  "bbox": [48.8155755, 48.902156, 2.224122, 2.4697602],
  "source_id": "relation/7444",
  "provenance": "openstreetmap",
  "city": "Paris",
  "state": "Île-de-France",
  "country": "France",
  "country_code": "FR",
  "provider": "openstreetmap"
}
```

| Field | Always present | Description |
| --- | :---: | --- |
| `source` | ✓ | The query, trimmed and with repeated whitespace collapsed. |
| `name` | ✓ | City, state, and country joined with commas, without empty or repeated parts. |
| `type` | ✓ | The provider's place type (for example `city`, `state`, `country`). |
| `confidence` | ✓ | Provider value used for `minConfidence` filtering. **Not a probability.** |
| `provider` | ✓ | `openstreetmap`, `photon`, or `locationiq`. |
| `score` | | Raw provider score, when the provider exposes one. |
| `latitude`, `longitude` | | Coordinates of the place. |
| `bbox` | | Bounding box as reported by the provider. |
| `source_id`, `provenance` | | Provider record identifier and origin. |
| `city`, `state`, `country` | at least one | Administrative components. |
| `country_code` | | Upper-case ISO country code. |

OpenStreetMap and LocationIQ map their `importance` value to both
`confidence` and `score`. Photon has no comparable value, so it reports
`confidence: 0` and no `score`.

The Zod schema is exported as `AddressSchema` if you need to validate stored
results.

## Providers

| Provider | Class | CLI name | API key | Notes |
| --- | --- | --- | :---: | --- |
| OpenStreetMap Nominatim | `OpenStreetMap` | `osm` | — | Public server requires `email` and `userAgent`. Supports self-hosted instances. |
| Photon (Komoot) | `Photon` | `photon` | — | Uses the hosted Komoot endpoint. |
| LocationIQ | `LocationIQ` | `locationiq` | ✓ | Commercial service with a free tier. |

All providers accept `language`, `concurrency`, `rate`, and `retries`.
OpenStreetMap and LocationIQ also accept `minConfidence`. The library never
reads environment variables; configure it in code.

## Composing geocoders

Decorators wrap any `Geocoder` and can be nested freely:

| Decorator | Purpose |
| --- | --- |
| `Cache` | LRU cache with separate positive/negative TTLs, optional persistent [Keyv](https://keyv.org/) store, and in-flight deduplication. |
| `Fallback` | Tries the next geocoder on a `null` result or a retryable provider error. |
| `Throttler` | Puts a geocoder behind a [p-queue](https://github.com/sindresorhus/p-queue) with retries. |
| `LoadBalancer` | Spreads requests across geocoders, choosing the least-loaded queue. |

Details and examples: [decorators guide](packages/core/src/geocoder/decorators/README.md).

## HTTP API

Running `geocoder` without a subcommand starts the server.

| Endpoint | Description |
| --- | --- |
| `GET /search?q=<place>` | Returns an `Address` (`200`), `404` when nothing is found, or `400` for an invalid query. `q` must be non-empty and at most 500 characters. |
| `GET /docs` | Swagger UI. `/` redirects here. |
| `GET /health` | Status, timestamp, and uptime. |
| `GET /health/ready` | `{ "ready": true }` |
| `GET /health/live` | `{ "alive": true }`. Never rate-limited. |

Health endpoints only check the local process; they never call providers.

Successful searches include an `X-Geocoder-Provider` header and, when
available, an `X-Geocoder-Attribution` header with the text to credit. These
headers do not replace visible attribution in your application.

## Bulk geocoding

```bash
geocoder bulk places.txt \
  --providers osm --workers 1 \
  --cache-dir .cache --cache-positive-ttl '24 hours' \
  --resume previous.ndjson \
  --continue-on-error > results.ndjson
```

- **Input** — one place per line, from a file argument, `--input <FILE>`, or
  stdin (`-`, the default). Lines are normalized and duplicates are removed.
- **Output** — one JSON record per line on stdout; progress goes to stderr.

  ```json
  { "query": "Paris", "ok": true, "address": { "city": "Paris", "...": "..." } }
  { "query": "Atlantis", "ok": true, "address": null }
  { "query": "Lisbon", "ok": false, "error": "Geocoding failed" }
  ```

- **Resume** — `--resume <FILE>` skips queries that already succeeded in a
  previous output file.
- **Failures** — the run stops at the first provider failure unless
  `--continue-on-error` is set.
- **Pacing** — with the public Nominatim server, bulk switches to the
  `public-bulk` profile (four requests per minute). Keep `--workers 1` and a
  cache enabled for public Nominatim.

Bulk accepts all provider and cache options below. Server-only options
(`--host`, `--port`, `--rate-limit*`, `--trust-proxy`) are ignored.

## Configuration

The CLI reads options from flags or environment variables; flags take
precedence.

| Flag | Environment variable | Default | Description |
| --- | --- | --- | --- |
| `--providers <LIST>` | `PROVIDERS` | `osm,photon` | Comma-separated provider order: `osm`, `photon`, `locationiq`. |
| `--osm-server <URL>` | `OSM_SERVER` | `https://nominatim.openstreetmap.org` | Nominatim server. |
| `--osm-email <EMAIL>` | `OSM_EMAIL` | — | Contact email (required for public Nominatim). |
| `--osm-agent <AGENT>` | `OSM_USER_AGENT` | — | Identifying User-Agent (required for public Nominatim). |
| `--locationiq-key <KEY>` | `LOCATIONIQ_KEY` | — | Required when `locationiq` is selected. |
| `--rate-profile <PROFILE>` | `RATE_PROFILE` | `public` | `public`, `public-bulk`, or `self-hosted`. |
| `--provider-language <LANG>` | `PROVIDER_LANGUAGE` | `en` | Preferred result language. |
| `--provider-timeout-ms <MS>` | `PROVIDER_TIMEOUT_MS` | `5000` | Per-request provider timeout. |
| `--provider-retries <COUNT>` | `PROVIDER_RETRIES` | `2` | Retries for transient provider failures. |
| `--concurrency <COUNT>` | `CONCURRENCY` | `1` | Concurrent requests per provider. |
| `--cache-dir <DIR>` | `CACHE_DIR` | — | Enables a persistent cache at `<DIR>/geocoder-cache.sqlite`. |
| `--cache-size <SIZE>` | `CACHE_SIZE` | `1000` | In-memory cache entries. |
| `--cache-positive-ttl <DURATION>` | `CACHE_POSITIVE_TTL_MS` | `1 hour` | TTL for found results (`0` = no expiry). |
| `--cache-negative-ttl <DURATION>` | `CACHE_NEGATIVE_TTL_MS` | `5 minutes` | TTL for not-found results (`0` = no expiry). |
| `-H, --host <HOST>` | `HOST` | `localhost` | Server bind address. |
| `-p, --port <PORT>` | `PORT` | `3000` | Server port. |
| `--rate-limit` | `RATE_LIMIT_ENABLED` | `false` | Enable inbound rate limiting. |
| `--rate-limit-max <MAX>` | `RATE_LIMIT_MAX` | `100` | Requests per window per client. |
| `--rate-limit-window <DURATION>` | `RATE_LIMIT_WINDOW` | `1 minute` | Rate-limit window. |
| `--trust-proxy <BOOLEAN>` | `TRUST_PROXY` | `false` | Trust `X-Forwarded-*` headers. |
| — | `LOG_LEVEL` | `info` | Server log level. |
| — | `GRACEFUL_SHUTDOWN_TIMEOUT_MS` | `30000` | Shutdown grace period. |

Durations accept values such as `500ms`, `5 seconds`, or `1 hour`.

**Rate profiles.** Profiles only change pacing for the public Nominatim
server: `public` applies one request per second and `public-bulk` four
requests per minute. Other servers use the provider's default queue. Use
`self-hosted` only to describe an instance you operate. Explicit
`--concurrency` values are passed through unchanged.

Run `geocoder --help` or `geocoder bulk --help` for the full list.

## Docker

```bash
docker build -t hsborges-msr/geocoder .
docker run --rm -p 8080:8080 -v geocoder-cache:/app/.cache hsborges-msr/geocoder
```

The image runs as the unprivileged `node` user, listens on `0.0.0.0:8080`,
keeps a persistent cache in `/app/.cache`, holds up to 10,000 entries in
memory, and uses `/health/live` for its health check.

> [!IMPORTANT]
> The image sets `OSM_SERVER=https://nominatim.geocoding.ai`, a hosted endpoint
> that is **not** the official public Nominatim service. Check its terms, or
> point it elsewhere with `-e OSM_SERVER=...`. If you use the official public
> server, also pass `OSM_EMAIL` and `OSM_USER_AGENT`.

## Usage policy, attribution, and privacy

Geocoder calls third-party services. You are responsible for following their
terms.

**Public Nominatim**
([usage policy](https://operations.osmfoundation.org/policies/nominatim/)):

- At most **one request per second**; for bulk or long-running jobs, a single
  thread, caching, and at most **four requests per minute**.
- Identify your application: Geocoder sends `userAgent` as the `User-Agent`
  header and `email` as the `email` query parameter.
- No autocomplete, systematic harvesting, scraping, reselling, or building a
  competing database.

The defaults follow these limits, but explicit `concurrency`, `rate`, or
`--workers` values are not overridden. For heavy workloads, run your own
[Nominatim instance](https://nominatim.org/release-docs/latest/admin/Installation/)
and use the `self-hosted` profile. A custom `OSM_SERVER` is not automatically
covered by your own terms: follow the policy of whoever operates it.

**Attribution.** Show visible credit to
[OpenStreetMap contributors](https://www.openstreetmap.org/copyright) (and to
Photon or LocationIQ when used) wherever results are displayed.

**Privacy.** Queries are sent to the selected providers, which may log them.
Disclose this in your privacy notice and avoid sending personal or
confidential data. Persistent caches keep queries and results on disk; set
finite TTLs and a retention policy where required.

## Development

This is a Yarn 1 monorepo managed with [Turborepo](https://turbo.build/):

```text
packages/
  core/  @hsborges-msr/geocoder      providers, decorators, Address schema
  cli/   @hsborges-msr/geocoder-cli  HTTP server (Fastify) and bulk CLI
```

```bash
yarn install --frozen-lockfile
yarn verify      # lint + test + build
yarn test        # tests only
yarn format      # format with Biome
```

Commit messages follow [Conventional Commits](https://www.conventionalcommits.org/).

## License

[MIT](LICENSE) © Hudson Silva Borges
