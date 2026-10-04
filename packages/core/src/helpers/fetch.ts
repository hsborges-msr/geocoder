import Debug from 'debug';
import fetch, { HTTPError, type Options, TimeoutError } from 'ky';
import { GeocoderError, ProviderError, RateLimitError } from '../errors/index.js';

const debug = Debug('geocoder:fetch');

export type FetchOptions = Omit<Options, 'retry'> & { provider?: string };

function retryAfterSeconds(response: Response): number | undefined {
  const value = response.headers.get('retry-after');
  if (!value) return undefined;
  const seconds = Number(value);
  const parsed = Number.isFinite(seconds) ? seconds : (Date.parse(value) - Date.now()) / 1000;
  if (!Number.isFinite(parsed) || parsed < 0) return undefined;
  return Math.min(parsed, 60);
}

export function classifyFetchError(
  error: unknown,
  provider = 'unknown',
  signal?: AbortSignal
): Error {
  if (error instanceof GeocoderError) return error;
  if (!(error instanceof Error))
    return new ProviderError(
      `Transient failure for provider: ${provider}`,
      provider,
      undefined,
      'transient',
      undefined,
      new Error(String(error))
    );
  if (signal?.aborted || error.name === 'AbortError') {
    return error;
  }
  if (error instanceof TimeoutError || error.name === 'TimeoutError')
    return new ProviderError(
      `Transient failure for provider: ${provider}`,
      provider,
      undefined,
      'transient',
      undefined,
      error
    );
  if (error instanceof HTTPError) {
    const status = error.response.status;
    const retryAfter = retryAfterSeconds(error.response);
    if (status === 429) return new RateLimitError(provider, retryAfter, status, error);
    if (status === 401 || status === 407)
      return new ProviderError(
        `Authentication failed for provider: ${provider}`,
        provider,
        status,
        'authentication',
        undefined,
        error
      );
    if (status === 403 || status === 418)
      return new ProviderError(
        `Provider policy rejected the request: ${provider}`,
        provider,
        status,
        'policy',
        undefined,
        error
      );
    if (status >= 400 && status < 500)
      return new ProviderError(
        `Invalid request for provider: ${provider}`,
        provider,
        status,
        'invalid-request',
        undefined,
        error
      );
    return new ProviderError(
      `Transient failure for provider: ${provider}`,
      provider,
      status,
      'transient',
      retryAfter,
      error
    );
  }
  return new ProviderError(
    `Transient failure for provider: ${provider}`,
    provider,
    undefined,
    'transient',
    undefined,
    error
  );
}

/**
 *  Fetch with retry
 *
 * @param url
 * @param options
 * @returns
 */
export default function <T>(url: string | URL, options?: FetchOptions) {
  debug('fetching: %s', url);

  const { headers: providedHeaders, provider, ...requestOptions } = options ?? {};

  const headers = new Headers(providedHeaders);
  if (!headers.has('User-Agent'))
    headers.set('User-Agent', 'hsborges-msr-geocoder (+https://github.com/hsborges-msr/geocoder)');

  return fetch<T>(url, {
    ...requestOptions,
    retry: { limit: 0 },
    timeout: options?.timeout ?? 10000,
    throwHttpErrors: options?.throwHttpErrors ?? true,
    headers
  }).catch((error: unknown) => {
    throw classifyFetchError(error, provider, requestOptions.signal ?? undefined);
  });
}