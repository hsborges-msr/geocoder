import Debug from 'debug';
import PQueue from 'p-queue';
import { Address } from '../../entities/Address.js';
import { NoProvidersError } from '../../errors/index.js';
import { Geocoder } from '../Geocoder.js';
import { Fallback } from './Fallback.js';

const debug = Debug('geocoder:load-balancer');

/**
 * LoadBalancer decorator that distributes requests across multiple providers
 */
export class LoadBalancer implements Geocoder {
  private readonly providers: Array<{ geocoder: Geocoder; queue: PQueue }>;

  /**
   * Create a new LoadBalancer
   * @param geocoders - Array of geocoder providers to distribute requests across
   */
  constructor(geocoders: Geocoder[], options?: { timeoutMs?: number }) {
    if (!geocoders || geocoders.length === 0) {
      throw new NoProvidersError();
    }

    this.providers = geocoders.map((geocoder, index) => {
      const wrapped = geocoders
        .filter((_, i) => i !== index)
        .reduce((mem, geo) => new Fallback(mem, geo), geocoder);

      const queue = new PQueue({
        concurrency: Infinity,
        timeout: options?.timeoutMs,
        autoStart: true
      });

      // Add lightweight event listeners for debugging
      // Note: PQueue emits 'active' and 'idle' events
      queue.on('active', () => {
        debug('Provider %d active: %d pending', index, queue.pending);
      });

      queue.on('idle', () => {
        debug('Provider %d idle', index);
      });

      // Handle queue errors (timeouts)
      queue.on('error', (err: Error) => {
        debug('Provider %d queue error: %s', index, err?.message);
      });

      return { geocoder: wrapped, queue };
    });

    debug('LoadBalancer initialized with %d providers', this.providers.length);
  }

  /**
   * Search for an address using the load balanced provider pool
   * Selects the provider with the lowest queue size for each request
   * @param q - Search query
   * @param options - Search options including optional AbortSignal
   * @returns Promise resolving to Address or null
   */
  async search(q: string, options?: { signal?: AbortSignal }): Promise<Address | null> {
    // Select provider with lowest queue size
    const provider = this.providers.reduce((best, current) => {
      const bestLoad = best.queue.size + best.queue.pending;
      const currentLoad = current.queue.size + current.queue.pending;
      return currentLoad < bestLoad ? current : best;
    });

    const providerIndex = this.providers.indexOf(provider);
    debug(
      'Assigning request to provider %d: %s (queue size: %d, pending: %d)',
      providerIndex,
      q,
      provider.queue.size,
      provider.queue.pending
    );

    // Add to provider's queue
    return provider.queue.add(() => provider.geocoder.search(q, options), options);
  }

  getStats() {
    return this.providers.map((p, i) => ({
      index: `${p.geocoder.constructor.name} #${i}`,
      queueSize: p.queue.size,
      pending: p.queue.pending
    }));
  }
}