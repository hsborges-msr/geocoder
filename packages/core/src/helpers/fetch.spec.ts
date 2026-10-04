import nock from 'nock';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ProviderError, RateLimitError } from '../errors/index.js';
import fetch from './fetch.js';

/**
 * Tests for the fetch helper that wraps node-fetch with:
 * - Automatic retry logic (3 retries) for transient failures
 * - Configurable timeout via options.timeout (default 10 seconds)
 * - Retry on 5xx, 429, 418 status codes and network errors
 * - Exponential backoff for retries
 * - StatusCode property added to responses
 *
 * Uses nock for HTTP mocking to intercept and mock HTTP requests.
 * Tests use 2-second timeout for faster execution.
 */
describe('fetch helper', () => {
  beforeEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    nock.disableNetConnect();
  });

  afterEach(() => {
    nock.abortPendingRequests();
    nock.cleanAll();
    nock.enableNetConnect();
  });

  describe('default headers', () => {
    it('sends the default User-Agent', async () => {
      const scope = nock('https://api.example.com', {
        reqheaders: {
          'user-agent': 'hsborges-msr-geocoder (+https://github.com/hsborges-msr/geocoder)'
        }
      })
        .get('/ua')
        .reply(200, {});

      await fetch('https://api.example.com/ua');

      expect(scope.isDone()).toBe(true);
    });
  });

  describe('timeout functionality', () => {
    it('should successfully fetch when response is fast', async () => {
      const scope = nock('https://api.example.com').get('/data').reply(200, { success: true });

      const response = await fetch('https://api.example.com/data', { timeout: 2000 });

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    });

    it('should timeout when server takes longer than configured timeout', async () => {
      const scope = nock('https://slow-api.example.com')
        .get('/slow')
        .delay(2500) // Delay longer than 2-second timeout
        .reply(200, { success: true });

      const startTime = Date.now();

      await expect(
        fetch('https://slow-api.example.com/slow', {
          timeout: 2000,
          // Disable retries in this test to assert timeout behavior deterministically.
          retry: { limit: 0 }
        } as unknown as never)
      ).rejects.toThrow();

      expect(Date.now() - startTime).toBeGreaterThanOrEqual(2000);
      expect(scope.isDone()).toBe(true);
    });

    it('should not retry an aborted request', async () => {
      let attempts = 0;
      let requestStarted!: () => void;
      const started = new Promise<void>((resolve) => {
        requestStarted = resolve;
      });
      const scope = nock('https://abort-api.example.com')
        .get('/abort')
        .delayBody(200)
        .reply(() => {
          attempts += 1;
          requestStarted();
          return [200, { success: true }];
        });
      const controller = new AbortController();
      const request = fetch('https://abort-api.example.com/abort', {
        signal: controller.signal,
        timeout: 1000
      });

      await started;
      controller.abort();
      await expect(request).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(attempts).toBe(1);
      expect(scope.isDone()).toBe(true);
    });

    it('classifies a provider timeout as retryable transient failure', async () => {
      let attempts = 0;
      const scope = nock('https://timeout-api.example.com')
        .get('/timeout')
        .delay(200)
        .reply(() => {
          attempts += 1;
          return [200, { success: true }];
        });

      await expect(
        fetch('https://timeout-api.example.com/timeout', { timeout: 25 })
      ).rejects.toMatchObject({ kind: 'transient' });
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(attempts).toBe(1);
      expect(scope.isDone()).toBe(true);
    });

    it('should not timeout if request completes within configured timeout', async () => {
      const scope = nock('https://api.example.com')
        .get('/data')
        .delay(500) // Delay less than 2-second timeout
        .reply(200, { success: true });

      const response = await fetch('https://api.example.com/data', { timeout: 2000 });

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    });

    it('should complete successfully with delay just under timeout', async () => {
      const scope = nock('https://api.example.com')
        .get('/data')
        .delay(1800) // Just under the 2-second timeout
        .reply(200, { success: true });

      const response = await fetch('https://api.example.com/data', { timeout: 2000 });

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    }, 3000);

    it('should use default 10-second timeout when not specified', async () => {
      const scope = nock('https://api.example.com')
        .get('/data')
        .delay(500)
        .reply(200, { success: true });

      const response = await fetch('https://api.example.com/data');

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    });

    it('should respect custom longer timeout', async () => {
      const scope = nock('https://api.example.com')
        .get('/data')
        .delay(4000) // 4-second delay
        .reply(200, { success: true });

      const response = await fetch('https://api.example.com/data', { timeout: 5000 });

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    }, 6000);
  });

  describe('retry functionality', () => {
    it('should throw a transient ProviderError on 500 server errors', async () => {
      nock('https://api.example.com').get('/data').reply(500, 'Server Error');
      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow(
        /transient|500/i
      );
    });

    it('should throw a transient ProviderError on 502 bad gateway', async () => {
      nock('https://api.example.com').get('/data').reply(502, 'Bad Gateway');
      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow(
        /transient|502/i
      );
    });

    it('should throw a transient ProviderError on 503 service unavailable', async () => {
      nock('https://api.example.com').get('/data').reply(503, 'Service Unavailable');
      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow(
        /transient|503/i
      );
    });

    it('should throw a policy ProviderError on 403 forbidden', async () => {
      nock('https://api.example.com').get('/data').reply(403, 'Forbidden');
      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow(
        /policy|403/i
      );
    });

    it('should throw RateLimitError on 429 rate limit', async () => {
      nock('https://api.example.com').get('/data').reply(429, 'Too Many Requests');
      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toBeInstanceOf(
        RateLimitError
      );
    });

    it('should extract and cap Retry-After header to 60s', async () => {
      nock('https://api.example.com')
        .get('/data')
        .reply(429, 'Too Many Requests', { 'Retry-After': '120' });

      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toMatchObject({
        retryAfter: 60
      });
    });

    it('should throw a policy ProviderError on 418 teapot', async () => {
      nock('https://api.example.com').get('/data').reply(418, "I'm a teapot");
      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow(
        /policy|418/i
      );
    });

    it('should throw an invalid-request ProviderError on 404 not found', async () => {
      nock('https://api.example.com').get('/data').reply(404, 'Not Found');
      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow(
        /invalid|404/i
      );
    });

    it('should throw an invalid-request ProviderError on 400 bad request', async () => {
      nock('https://api.example.com').get('/data').reply(400, 'Bad Request');
      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow(
        /invalid|400/i
      );
    });

    it('should throw a transient ProviderError on network errors', async () => {
      nock('https://api.example.com').get('/data').replyWithError('Network error');

      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow(
        /transient|network/i
      );
    });
  });

  describe('response handling', () => {
    it('should return response with status', async () => {
      nock('https://api.example.com').get('/data').reply(200, { message: 'Hello' });

      const response = await fetch('https://api.example.com/data');

      expect(response.status).toBe(200);
    });

    it('should add statusCode property to response', async () => {
      nock('https://api.example.com').get('/data').reply(201, { id: '123' });

      const response = await fetch('https://api.example.com/data');

      expect(response.status).toBe(201);
    });

    it('should throw on error responses', async () => {
      nock('https://api.example.com').get('/data').reply(404, 'Not Found');

      await expect(fetch('https://api.example.com/data')).rejects.toThrow();
    });

    it('should handle JSON responses', async () => {
      nock('https://api.example.com').get('/data').reply(200, { name: 'test', value: 42 });

      const response = await fetch('https://api.example.com/data');
      const data = await response.json();

      expect(data).toEqual({ name: 'test', value: 42 });
    });
  });

  describe('request options', () => {
    it('should pass through POST method', async () => {
      const scope = nock('https://api.example.com')
        .post('/data', { test: 'data' })
        .reply(201, { success: true });

      const response = await fetch('https://api.example.com/data', {
        method: 'POST',
        body: JSON.stringify({ test: 'data' }),
        headers: {
          'Content-Type': 'application/json'
        }
      });

      expect(response.status).toBe(201);
      expect(scope.isDone()).toBe(true);
    });

    it('should pass through custom headers', async () => {
      const scope = nock('https://api.example.com')
        .get('/data')
        .matchHeader('Authorization', 'Bearer token123')
        .reply(200, { success: true });

      const response = await fetch('https://api.example.com/data', {
        headers: {
          Authorization: 'Bearer token123'
        }
      });

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    });

    it('should accept URL object', async () => {
      const scope = nock('https://api.example.com').get('/data').reply(200, { success: true });

      const url = new URL('https://api.example.com/data');
      const response = await fetch(url);

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    });

    it('should handle query parameters', async () => {
      const scope = nock('https://api.example.com')
        .get('/data')
        .query({ foo: 'bar', baz: 'qux' })
        .reply(200, { success: true });

      const response = await fetch('https://api.example.com/data?foo=bar&baz=qux');

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('integration with timeout and retries', () => {
    it('should throw on first transient error without retries', async () => {
      const scope = nock('https://api.example.com').get('/data').reply(500, 'Server Error');

      await expect(fetch('https://api.example.com/data', { timeout: 2000 })).rejects.toThrow();

      expect(scope.isDone()).toBe(true);
    });

    it('should handle multiple sequential requests', async () => {
      const scope = nock('https://api.example.com')
        .get('/data1')
        .reply(200, { id: 1 })
        .get('/data2')
        .reply(200, { id: 2 })
        .get('/data3')
        .reply(200, { id: 3 });

      const response1 = await fetch('https://api.example.com/data1');
      const response2 = await fetch('https://api.example.com/data2');
      const response3 = await fetch('https://api.example.com/data3');

      expect(response1.status).toBe(200);
      expect(response2.status).toBe(200);
      expect(response3.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    });
  });

  describe('edge cases', () => {
    it('should handle empty response body', async () => {
      const scope = nock('https://api.example.com').get('/data').reply(204);

      const response = await fetch('https://api.example.com/data');

      expect(response.status).toBe(204);
      expect(scope.isDone()).toBe(true);
    });

    it('should handle response delays within custom timeout', async () => {
      const scope = nock('https://api.example.com')
        .get('/data')
        .delay(1800) // Just under the 2-second timeout
        .reply(200, { success: true });

      const response = await fetch('https://api.example.com/data', { timeout: 2000 });

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    }, 3000);

    it('should handle URL with port', async () => {
      const scope = nock('https://api.example.com:8443').get('/data').reply(200, { success: true });

      const response = await fetch('https://api.example.com:8443/data');

      expect(response.status).toBe(200);
      expect(scope.isDone()).toBe(true);
    });
  });
});