# `@hsborges-msr/geocoder` core

The core package exports the `Geocoder` interface and provider/decorator
implementations. A geocoder implements:

```typescript
search(q: string, options?: { signal?: AbortSignal }): Promise<Address | null>
```

## OpenStreetMap / Nominatim

```typescript
import { OpenStreetMap } from '@hsborges-msr/geocoder';

const geocoder = new OpenStreetMap({
  osmServer: 'https://nominatim.openstreetmap.org',
  email: 'ops@example.com',
  userAgent: 'my-app/1.0 (https://example.com/contact)',
  concurrency: 1,
  language: 'en-US',
  minConfidence: 0.5
});

const result = await geocoder.search('São Paulo, Brazil');
```

Options are `osmServer`, `email`, `userAgent`, `concurrency`, `language`,
`minConfidence`, `rate`, and `retries`. For the public server, the library
requires an identifying `User-Agent` and contact email, sending them as the
`User-Agent` header and `email` query parameter. Although the policy also
accepts a `Referer`, the core exposes no `Referer` option. Nominatim's public
maximum is one request per second. The safe default provider queue applies one
request per second with one concurrent request. Explicit `concurrency` and
`rate` options are accepted unchanged; the library does not enforce the public
Nominatim concurrency/rate policy, so following provider terms is the caller's
responsibility. A custom server is not automatically self-hosted or covered by
the public server's terms, so follow its operator's policy.

For regular or long-running bulk use, Nominatim requires one thread, caching,
and no more than four requests per minute. The core provider's one-request-
per-second queue does not enforce that stricter bulk pace; the caller must
pace bulk work.

## Other providers

```typescript
import { LocationIQ, Photon } from '@hsborges-msr/geocoder';

const locationiq = new LocationIQ({
  apiKey: 'your-locationiq-key',
  baseUrl: 'https://us1.locationiq.com/v1',
  language: 'en',
  minConfidence: 0.5,
  concurrency: 1,
  retries: 2
});
const photon = new Photon({ language: 'en', concurrency: 1 });

console.log(await locationiq.search('Seattle'));
console.log(await photon.search('Seattle'));
```

`LocationIQ` requires `apiKey` and also accepts `baseUrl`, `minConfidence`,
`language`, `concurrency`, `rate`, and `retries`. `Photon` accepts `language`,
`concurrency`, `rate`, and `retries`. Their default queues are also one
request per second; use the provider's documented limits when changing the
`rate` option. The core package does not read environment variables.

## Provider switching

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

`Fallback` tries the second service after a null result or a retryable provider
failure. `LoadBalancer` accepts a non-empty array of geocoders and selects the
least-loaded queue; it also wraps each choice with fallback providers.

## Cache

```typescript
import { Cache, Photon } from '@hsborges-msr/geocoder';

const cached = new Cache(new Photon(), {
  size: 1000,
  positiveTtl: 3_600_000,
  negativeTtl: 300_000
});
```

`Cache` options are `size`, `ttl`, `positiveTtl`, `negativeTtl`, `namespace`,
`provider`, `config`, and optional secondary Keyv store options. TTLs are
milliseconds; `ttl` sets both positive and negative TTLs, and `0` means no
expiry. Positive and not-found results have separate TTLs, concurrent requests
for the same normalized query are deduplicated, and a persistent secondary
store can retain queries across process restarts. Set finite TTLs and manage
secondary-store deletion when retention or privacy requirements demand it.

## Address scores

`confidence` is the provider value used for filtering; it is not a universal
probability. `score` is the raw provider score when one is exposed.
OpenStreetMap and LocationIQ map provider `importance` to both fields, while
Photon sets `confidence` to `0` and has no score. `minConfidence` applies to
OpenStreetMap and LocationIQ.

## Nominatim attribution and privacy

Applications must display attribution to
[OpenStreetMap/Nominatim](https://www.openstreetmap.org/copyright) wherever
results are shown. The core
library does not render attribution for you. Queries go to the selected
provider, so disclose that third party to users and avoid sending personal or
confidential data unless applicable privacy law and provider terms permit it.
Do not use public Nominatim for autocomplete, systematic queries, details
scraping, reselling, or creating a competing database.
