import Debug from 'debug';
import { Address, AddressSchema } from '../entities/Address.js';
import { adminFields, adminLevel } from '../helpers/admin.js';
import fetch from '../helpers/fetch.js';
import { finiteNumber, record } from '../helpers/provider.js';
import { normalizeQuery } from '../helpers/query.js';
import { queueOptions } from '../helpers/queue.js';
import { Throttler, type ThrottlerOptions } from './decorators/Throttler.js';
import { Geocoder } from './Geocoder.js';

const debug = Debug('geocoder:photon');

type PhotonSearchResult = {
  features?: unknown[];
};

class BasePhoton implements Geocoder {
  constructor(
    private readonly language: string,
    private readonly timeoutMs?: number,
    private readonly baseUrl = 'https://photon.komoot.io/api/'
  ) {}

  async search(q: string, options?: { signal?: AbortSignal }): Promise<Address | null> {
    const normalized = normalizeQuery(q);
    const data = await fetch<PhotonSearchResult>(
      `${this.baseUrl.replace(/\/+$/u, '')}/?${new URLSearchParams([
        ['q', normalized],
        ['layer', 'city'],
        ['layer', 'county'],
        ['layer', 'state'],
        ['layer', 'country'],
        ['limit', '5'],
        ['lang', this.language]
      ]).toString()}`,
      {
        signal: options?.signal,
        timeout: this.timeoutMs,
        provider: 'photon'
      }
    ).then((res) => res.json());

    for (const feature of Array.isArray(data?.features) ? data.features : []) {
      const rawFeature = record(feature);
      const properties = record(rawFeature?.properties);
      if (!properties) continue;
      const level = adminLevel(properties.type, properties.osm_value);
      if (!level) continue;

      const fields = adminFields(level, properties.name, properties);
      const rawGeometry = rawFeature?.geometry;
      const geometry = record(rawGeometry);
      if (rawGeometry !== undefined && !geometry) continue;
      const coordinates = geometry?.coordinates;
      if (
        coordinates !== undefined &&
        (!Array.isArray(coordinates) ||
          finiteNumber(coordinates[0]) === undefined ||
          finiteNumber(coordinates[1]) === undefined)
      ) {
        continue;
      }
      const parsed = AddressSchema.safeParse({
        provider: 'photon',
        source: normalized,
        ...fields,
        type: level,
        confidence: 0,
        latitude: Array.isArray(coordinates) ? finiteNumber(coordinates[1]) : undefined,
        longitude: Array.isArray(coordinates) ? finiteNumber(coordinates[0]) : undefined,
        source_id:
          typeof properties.osm_type === 'string' &&
          (typeof properties.osm_id === 'number' || typeof properties.osm_id === 'string')
            ? `${properties.osm_type}/${properties.osm_id}`
            : undefined,
        provenance: 'photon'
      });
      if (parsed.success) return parsed.data;
    }
    debug('discarding malformed Photon result for: %s', normalized);
    return null;
  }
}

export type PhotonOptions = {
  concurrency?: number;
  language?: string;
  timeoutMs?: number;
  baseUrl?: string;
  rate?: Omit<ThrottlerOptions, 'retries' | 'retryDelay'>;
  retries?: number;
};

export class Photon extends Throttler implements Geocoder {
  constructor(options: PhotonOptions = {}) {
    const rateOptions = queueOptions(options.rate, options.concurrency);
    super(new BasePhoton(options.language ?? 'en', options.timeoutMs, options.baseUrl), {
      ...rateOptions,
      retries: options.retries ?? 2,
      retryDelay: 250
    });
  }
}