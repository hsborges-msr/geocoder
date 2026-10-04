# Geocoder decorators

Decorators wrap any `Geocoder`, keep its `search` API, and can be nested.

```typescript
import { Cache, Fallback, OpenStreetMap, Photon } from '@hsborges-msr/geocoder';

const geocoder = new Cache(
  new Fallback(
    new OpenStreetMap({
      osmServer: 'https://nominatim.openstreetmap.org',
      email: 'you@example.com',
      userAgent: 'my-app/1.0 (https://example.com/contact)'
    }),
    new Photon()
  ),
  { size: 1000, positiveTtl: 3_600_000, negativeTtl: 300_000 }
);
```

## Cache

```typescript
const cached = new Cache(new Photon(), { size: 1000, ttl: 3_600_000 });
```

| Option | Description |
| --- | --- |
| `size` | Maximum in-memory entries (LRU). |
| `ttl` | Sets both TTLs below. |
| `positiveTtl` | TTL in ms for found results. `0` = no expiry. |
| `negativeTtl` | TTL in ms for not-found results. `0` = no expiry. |
| `namespace`, `provider`, `config` | Build the cache key namespace, so different setups don't share entries. |
| `secondary` | [Keyv](https://keyv.org/) options for a persistent second-level store. |

Keys use the normalized query (case- and Unicode-folded). Concurrent searches
for the same key share one provider call. A persistent store keeps queries on
disk: set finite TTLs if retention matters.

## Fallback

```typescript
const geocoder = new Fallback(primary, secondary);
```

Calls `secondary` when `primary` returns `null` or fails with a retryable
provider error. Aborts and non-retryable errors are thrown as-is.

## Throttler

```typescript
const geocoder = new Throttler(new Photon(), {
  concurrency: 1,
  intervalCap: 1,
  interval: 1000,
  retries: 2,
  retryDelay: 250
});
```

Takes [p-queue](https://github.com/sindresorhus/p-queue) options plus
`retries` and `retryDelay`, and retries only retryable errors. Providers
already have a one-request-per-second queue, so you rarely need this; prefer
their `rate` option. Queues are per instance: coordinate them yourself if
several processes share a provider.

## LoadBalancer

```typescript
const geocoder = new LoadBalancer([new Photon(), new Photon()], { timeoutMs: 10_000 });
```

Sends each search to the geocoder with the shortest queue, falling back to the
others. Requires a non-empty array.
