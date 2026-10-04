import path from 'node:path';
import fastifySwagger from '@fastify/swagger';
import fastifySwaggerUI from '@fastify/swagger-ui';
import KeyvSqlite from '@keyv/sqlite';
import fastify, { FastifyInstance } from 'fastify';
import {
  jsonSchemaTransform,
  serializerCompiler,
  validatorCompiler,
  ZodTypeProvider
} from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  AddressSchema,
  Cache,
  type CacheOptions,
  Fallback,
  Geocoder,
  GeocoderError,
  LocationIQ,
  MAX_QUERY_LENGTH,
  normalizeQuery,
  OpenStreetMap,
  OpenStreetMapOptions,
  Photon,
  RateLimitError,
  RequestAbortedError,
  ValidationError
} from '@/core';
import pJson from '../package.json' with { type: 'json' };
import {
  DEFAULT_OSM_SERVER,
  isDefaultNominatimServer,
  normalizeOsmServerUrl,
  parseCacheSize,
  parseConcurrency,
  parseDuration,
  parseProviders,
  parseProviderTimeout,
  parseRateLimitMax,
  parseRateProfile,
  validateApiKey,
  validateCacheDirectory,
  validateEmail,
  validateUserAgent
} from './helpers/config.js';

const disallowedQueryControls = /[\u0000-\u001F\u007F-\u009F]/u;

export type ProviderConfig = OpenStreetMapOptions & {
  providers?: string[];
  locationIqKey?: string;
  rateProfile?: string;
  providerTimeoutMs?: number;
};

export type AppOptions = {
  // Accept either geocoder options to construct providers or a ready-made Geocoder (useful for tests)
  geocoder: ProviderConfig | Geocoder;
  cache?: Partial<CacheOptions & { dirname: string }>;
  logLevel?: string;
  rateLimit?: { max?: number; timeWindow?: string };
  trustProxy?: boolean;
};

const ATTRIBUTIONS: Record<string, string> = {
  openstreetmap: 'OpenStreetMap/Nominatim (https://www.openstreetmap.org/copyright)',
  photon: 'Photon by Komoot (https://photon.komoot.io/)',
  locationiq: 'LocationIQ (https://locationiq.com/)'
};

function applyCache(
  geocoder: Geocoder,
  options?: AppOptions['cache'],
  config?: ProviderConfig
): Geocoder {
  if (!options || options.size === undefined || options.size === 0) return geocoder;
  return new Cache(geocoder, {
    namespace: 'geocoder-cache-cli',
    config: config ? cacheIdentity(config) : undefined,
    size: parseCacheSize(options.size),
    positiveTtl: options.positiveTtl,
    negativeTtl: options.negativeTtl,
    secondary: options.dirname
      ? {
          store: new KeyvSqlite(
            `sqlite://${path.resolve(
              validateCacheDirectory(options.dirname) as string,
              'geocoder-cache.sqlite'
            )}`
          )
        }
      : undefined
  });
}

export function createGeocoder(config: ProviderConfig): Geocoder {
  const providers = parseProviders(config.providers ?? ['osm', 'photon']);
  const rateProfile = parseRateProfile(config.rateProfile ?? 'public');
  const concurrency = parseConcurrency(config.concurrency ?? 1);
  const osmServer = normalizeOsmServerUrl(config.osmServer ?? DEFAULT_OSM_SERVER);
  const providerTimeoutMs =
    config.providerTimeoutMs === undefined
      ? undefined
      : parseProviderTimeout(config.providerTimeoutMs);
  const email = validateEmail(config.email);
  const userAgent = validateUserAgent(config.userAgent);
  const locationIqKey = validateApiKey(config.locationIqKey);

  if (providers.includes('osm') && isDefaultNominatimServer(osmServer) && (!email || !userAgent)) {
    throw new ValidationError(
      'OSM_SERVER',
      osmServer,
      'default Nominatim requires OSM_EMAIL and OSM_USER_AGENT'
    );
  }
  if (providers.includes('locationiq') && !locationIqKey) {
    throw new ValidationError(
      'LOCATIONIQ_KEY',
      undefined,
      'is required when LOCATIONIQ is enabled'
    );
  }

  const publicNominatim = providers.includes('osm') && isDefaultNominatimServer(osmServer);
  const osmRate = publicNominatim
    ? rateProfile === 'public-bulk'
      ? { concurrency, intervalCap: 4, interval: 60_000, strict: true }
      : { concurrency, intervalCap: 1, interval: 1_000, strict: true }
    : undefined;
  const makeProvider = (provider: (typeof providers)[number]): Geocoder => {
    if (provider === 'osm') {
      return new OpenStreetMap({
        ...config,
        osmServer,
        email,
        userAgent,
        timeoutMs: providerTimeoutMs,
        rate: osmRate
      });
    }
    if (provider === 'photon') {
      return new Photon({
        concurrency,
        language: config.language,
        retries: config.retries,
        timeoutMs: providerTimeoutMs
      });
    }
    return new LocationIQ({
      apiKey: locationIqKey as string,
      concurrency,
      language: config.language,
      retries: config.retries,
      timeoutMs: providerTimeoutMs
    });
  };
  return providers
    .slice(1)
    .reduce<Geocoder>(
      (fallback, provider) => new Fallback(fallback, makeProvider(provider)),
      makeProvider(providers[0])
    );
}

export function createConfiguredGeocoder(
  config: ProviderConfig,
  cache?: AppOptions['cache']
): Geocoder {
  return applyCache(createGeocoder(config), cache, config);
}

export function cacheIdentity(config: ProviderConfig): Record<string, unknown> {
  return {
    schema: 'address-v3',
    providers: config.providers ?? ['osm', 'photon'],
    osmServer: normalizeOsmServerUrl(config.osmServer ?? DEFAULT_OSM_SERVER),
    language: config.language ?? 'en'
  };
}

/**
 * Create a new Fastify instance
 *
 * @returns {FastifyInstance} - The Fastify instance
 */
export function createApp(options: AppOptions): FastifyInstance {
  const injectedGeocoder =
    !!options.geocoder && typeof (options.geocoder as Geocoder).search === 'function';
  const providerOptions = injectedGeocoder ? undefined : (options.geocoder as ProviderConfig);
  const cacheOptions = options.cache
    ? {
        dirname: validateCacheDirectory(options.cache.dirname),
        size: options.cache.size === undefined ? undefined : parseCacheSize(options.cache.size),
        positiveTtl: options.cache.positiveTtl,
        negativeTtl: options.cache.negativeTtl
      }
    : undefined;

  const logger = options.logLevel
    ? {
        level: options.logLevel,
        serializers: {
          req: (request: { method: string; routeOptions?: { url?: string } }) => ({
            method: request.method,
            route: request.routeOptions?.url
          })
        }
      }
    : false;
  const app = fastify({ logger, trustProxy: options.trustProxy });

  app.setErrorHandler((error, request, reply) => {
    app.log.error(
      {
        errorName: error instanceof Error ? error.name : 'UnknownError',
        route: request.routeOptions.url
      },
      'request failed'
    );
    if (reply.sent) return;
    if (
      error instanceof RequestAbortedError ||
      (error instanceof Error && error.name === 'AbortError')
    ) {
      return reply.code(499).send({ message: 'Request aborted' });
    }
    if (error instanceof ValidationError || (error as { validation?: unknown }).validation) {
      return reply.code(400).send({ message: 'Invalid request' });
    }
    if (error instanceof RateLimitError) {
      if (error.retryAfter !== undefined) reply.header('Retry-After', String(error.retryAfter));
      return reply.code(429).send({ message: 'Geocoding service rate limited' });
    }
    if (error instanceof GeocoderError) {
      return reply.code(502).send({ message: 'Geocoding service unavailable' });
    }
    if (request.routeOptions.url === '/search') {
      return reply.code(502).send({ message: 'Geocoding service unavailable' });
    }
    return reply.code(500).send({ message: 'Internal server error' });
  });

  // Add schema validator and serializer
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Register simple in-memory rate limiter BEFORE routes
  if (options.rateLimit) {
    const max = parseRateLimitMax(options.rateLimit.max ?? 100);
    const windowMs = parseDuration(
      options.rateLimit.timeWindow ?? '1 minute',
      'rateLimit.timeWindow'
    );
    const store = new Map<string, { count: number; reset: number }>();
    const cleanupTimer = setInterval(
      () => {
        const now = Date.now();
        for (const [key, entry] of store) if (entry.reset <= now) store.delete(key);
      },
      Math.min(windowMs, 60_000)
    );
    cleanupTimer.unref();
    app.addHook('onClose', async () => clearInterval(cleanupTimer));

    app.addHook('onRequest', async (req, reply) => {
      if (req.url.split('?')[0] === '/health/live') return;
      try {
        const key = String(req.ip || 'unknown');
        const now = Date.now();
        let entry = store.get(key);
        if (entry && entry.reset <= now) {
          store.delete(key);
          entry = undefined;
        }
        // increment hits
        if (!entry) {
          entry = { count: 1, reset: now + windowMs };
          store.set(key, entry);
        } else {
          entry.count += 1;
        }
        const retryAfter = Math.max(1, Math.ceil((entry.reset - now) / 1000));
        reply.header('X-RateLimit-Limit', String(max));
        reply.header('X-RateLimit-Remaining', String(Math.max(0, max - entry.count)));
        reply.header('X-RateLimit-Reset', String(Math.ceil(entry.reset / 1000)));
        if (entry.count > max) {
          reply.header('Retry-After', String(retryAfter));
          return reply.code(429).send({
            statusCode: 429,
            error: 'Too Many Requests',
            message: `Rate limit exceeded. Try again after ${retryAfter} seconds.`,
            retryAfter
          });
        }
      } catch (err: unknown) {
        // On error, do not block the request; fail-open
        app.log.warn(
          { errorName: err instanceof Error ? err.name : 'UnknownError' },
          'rate-limiter error'
        );
      }
    });
  }

  app.register(fastifySwagger, {
    openapi: {
      info: {
        title: 'Geocoder',
        description: 'Geocode github users location',
        version: pJson.version
      }
    },
    transform: jsonSchemaTransform
  });

  app.register(fastifySwaggerUI, {
    routePrefix: '/docs'
  });

  // Keep this disabled in tests.
  const HEADERS_ENABLED = process.env.NODE_ENV !== 'test';
  if (HEADERS_ENABLED) {
    app.addHook('onSend', async (req, reply, payload) => {
      try {
        // HSTS: only set when running in production over HTTPS (best-effort)
        if (process.env.NODE_ENV === 'production') {
          reply.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
        }

        reply.header('X-Frame-Options', 'SAMEORIGIN');
        reply.header('X-Content-Type-Options', 'nosniff');
        reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');

        // Minimal CSP allowing Swagger UI to function and images from validator
        reply.header(
          'Content-Security-Policy',
          "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; img-src 'self' data: validator.swagger.io; connect-src 'self'"
        );
      } catch (err: unknown) {
        app.log.warn(
          { errorName: err instanceof Error ? err.name : 'UnknownError' },
          'failed to set security headers'
        );
      }
      return payload;
    });
  }

  // If a Geocoder instance is provided directly, use it (helps testing). Otherwise build from options.
  const geocoder = applyCache(
    injectedGeocoder
      ? (options.geocoder as Geocoder)
      : createGeocoder(providerOptions as ProviderConfig),
    cacheOptions,
    providerOptions
  );

  app.after(async () => {
    app.get('/', async (req, res) => {
      res.redirect('/docs');
    });

    app.withTypeProvider<ZodTypeProvider>().route({
      method: 'GET',
      url: '/search',
      schema: {
        tags: ['Geocoder'],
        summary: 'Geocode an address',
        querystring: z
          .object({
            q: z
              .string()
              .min(1)
              .max(MAX_QUERY_LENGTH)
              .refine(
                (query) => !disallowedQueryControls.test(query),
                'must not contain control characters'
              )
              .transform(normalizeQuery)
              .describe('The address to geocode')
          })
          .strict(),
        response: {
          200: AddressSchema,
          400: z.object({ message: z.string().describe('Bad request') }),
          404: z.object({ message: z.string().describe('Address not found') })
        }
      },
      handler: async (req, res) => {
        const controller = new AbortController();
        req.raw.once('close', () => controller.abort('Request aborted'));
        const normalized = req.query.q;

        const address = await geocoder.search(normalized, { signal: controller.signal });

        // Log structured geocoding result without query or URL
        app.log.info(
          {
            queryLength: normalized.length,
            result: address ? 'resolved' : 'not_found',
            resolved: !!address,
            ...(address && {
              provider: address.provider,
              confidence: address.confidence
            })
          },
          'geocoding completed'
        );

        if (address) {
          res.header('X-Geocoder-Provider', address.provider);
          if (address.provider in ATTRIBUTIONS) {
            res.header('X-Geocoder-Attribution', ATTRIBUTIONS[address.provider]);
          }
          res.send(address);
        } else res.status(404).send({ message: 'Address not found' });
      }
    });

    // Health is local-only and must not consume provider capacity.
    app.get('/health', async (req, res) => {
      res.send({
        status: 'healthy',
        timestamp: new Date().toISOString(),
        uptime: process.uptime()
      });
    });
    app.get('/health/ready', async (req, res) => {
      res.send({ ready: true });
    });
    app.get('/health/live', async (req, res) => {
      res.send({ alive: true });
    });
  });

  return app;
}