# Geocoder decorators

Decorators wrap any `Geocoder` and preserve its `search` API. They can add
caching, throttling, fallback, or load balancing.

## Cache

```typescript
import { Cache, Photon } from '@hsborges-msr/geocoder';

const geocoder = new Cache(new Photon(), {
  size: 1000,
  positiveTtl: 3_600_000,
  negativeTtl: 300_000
});
```

`Cache` uses an in-memory LRU and optional secondary Keyv store options. Its
options are `size`, `ttl`, `positiveTtl`, `negativeTtl`, `namespace`,
`provider`, `config`, and `secondary`. TTLs are milliseconds; `ttl` is an
alias for both result types and `0` means no expiry. Not-found results are
cached separately, and concurrent searches for the same normalized query are
deduplicated. Persistent stores may retain queries and results across
restarts, so configure finite TTLs and a deletion policy when required.

## Throttler

```typescript
import { Photon, Throttler } from '@hsborges-msr/geocoder';

const geocoder = new Throttler(new Photon(), {
  concurrency: 1,
  intervalCap: 1,
  interval: 1000,
  strict: true,
  retries: 2,
  retryDelay: 250
});
```

`ThrottlerOptions` is the PQueue options object plus `retries` and
`retryDelay`. It limits the queue supplied to it and retries only retryable
errors; it is not a general guarantee of compliance with an upstream
provider's policy. A one-request-per-second queue matches the public
Nominatim maximum, but regular or long-running bulk use must additionally be
single-threaded, cached, and limited to four requests per minute. Coordinate
all queues and processes sharing a provider account or endpoint.

Provider constructors already create a default one-request-per-second queue.
Use their `rate` option, or a `Throttler`, only when the provider's documented
limits and the workload require a different queue.

## Fallback

```typescript
import { Fallback, OpenStreetMap, Photon } from '@hsborges-msr/geocoder';

const geocoder = new Fallback(
  new OpenStreetMap({
    osmServer: 'https://nominatim.openstreetmap.org',
    email: 'ops@example.com',
    userAgent: 'my-app/1.0 (https://example.com/contact)'
  }),
  new Photon()
);
```

The fallback is used for a null result or a retryable provider failure. Abort
errors and non-retryable failures are not silently switched to another
provider.

## LoadBalancer

```typescript
import { LoadBalancer, Photon } from '@hsborges-msr/geocoder';

const geocoder = new LoadBalancer([
  new Photon(),
  new Photon({ concurrency: 1 })
]);
```

`LoadBalancer` requires a non-empty array, selects the provider with the
lowest queue size plus pending count, and gives each selection fallback access
to the other providers. An optional constructor option is
`{ timeoutMs?: number }`.

## Composition

```typescript
import { Cache, Fallback, OpenStreetMap, Photon } from '@hsborges-msr/geocoder';

const geocoder = new Cache(
  new Fallback(
    new OpenStreetMap({
      osmServer: 'https://nominatim.openstreetmap.org',
      email: 'ops@example.com',
      userAgent: 'my-app/1.0 (https://example.com/contact)'
    }),
    new Photon()
  ),
  { size: 1000, positiveTtl: 3_600_000, negativeTtl: 300_000 }
);
```

When public Nominatim is in the chain, display OpenStreetMap attribution and
follow its usage policy. Queries are third-party disclosures: do not pass
sensitive data to an upstream provider unless applicable privacy law and
provider terms permit it.
