# `@hsborges-msr/geocoder`

The core library: geocoding providers, decorators, and the `Address` schema.
For an overview, the HTTP API, and the CLI, see the
[main README](../../README.md).

Every geocoder implements one method:

```typescript
search(q: string, options?: { signal?: AbortSignal }): Promise<Address | null>
```

It resolves to an `Address`, or `null` when nothing is found. The library does
not read environment variables; configure everything in code.

## Providers

### OpenStreetMap (Nominatim)

```typescript
import { OpenStreetMap } from '@hsborges-msr/geocoder';

const osm = new OpenStreetMap({
  osmServer: 'https://nominatim.openstreetmap.org',
  email: 'you@example.com',
  userAgent: 'my-app/1.0 (https://example.com/contact)',
  language: 'en-US',
  minConfidence: 0.5
});

await osm.search('São Paulo, Brazil');
```

| Option | Default | Description |
| --- | --- | --- |
| `osmServer` | public server | Nominatim base URL. |
| `email` | — | Contact email, sent as the `email` query parameter. Required for the public server. |
| `userAgent` | — | Sent as the `User-Agent` header. Required for the public server. |
| `language` | `en-US` | Preferred result language (`accept-language`). |
| `minConfidence` | `0` | Discard results whose `importance` is below this value. |
| `timeoutMs` | `10000` | Per-request timeout in ms. |
| `concurrency` | `1` | Concurrent requests. |
| `rate` | 1 req/s | Queue options ([p-queue](https://github.com/sindresorhus/p-queue)). |
| `retries` | `2` | Retries for transient failures. |

The default queue matches the public server's one-request-per-second limit.
For bulk work against the public server, pace requests to four per minute
yourself (for example with `rate: { intervalCap: 4, interval: 60_000 }`) and
keep a cache in front. See the
[usage policy](../../README.md#usage-policy-attribution-and-privacy).

### Photon

```typescript
import { Photon } from '@hsborges-msr/geocoder';

const photon = new Photon({ language: 'en' });
```

Options: `baseUrl`, `language`, `timeoutMs`, `concurrency`, `rate`, and
`retries`. Photon has no confidence value, so its results always have
`confidence: 0` and no `score`.

### LocationIQ

```typescript
import { LocationIQ } from '@hsborges-msr/geocoder';

const locationiq = new LocationIQ({ apiKey: process.env.LOCATIONIQ_KEY! });
```

`apiKey` is required. Other options: `baseUrl`, `language`, `minConfidence`,
`timeoutMs`, `concurrency`, `rate`, and `retries`.

## Decorators

`Cache`, `Fallback`, `Throttler`, and `LoadBalancer` wrap any geocoder. See the
[decorators guide](src/geocoder/decorators/README.md).

## Results and errors

- `Address` and `AddressSchema` (Zod) describe a result; see
  [Result format](../../README.md#result-format).
- `normalizeQuery()` applies the same normalization used for `source` and cache
  keys.
- Failures are thrown as `GeocoderError` subclasses: `ProviderError`,
  `RateLimitError`, `RequestAbortedError`, `ValidationError`, `QueueFullError`,
  `CacheError`, and `NoProvidersError`.

Runnable examples live in [`examples/`](examples/).
