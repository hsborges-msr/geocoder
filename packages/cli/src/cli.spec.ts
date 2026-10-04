import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  createApp: vi.fn(),
  createConfiguredGeocoder: vi.fn(),
  runBulk: vi.fn(),
  readFile: vi.fn()
}));

vi.mock('node:fs/promises', () => ({ readFile: mocks.readFile }));
vi.mock('./app.js', () => ({
  createApp: mocks.createApp,
  createConfiguredGeocoder: mocks.createConfiguredGeocoder
}));
vi.mock('./bulk.js', () => ({ runBulk: mocks.runBulk }));

import { bulkContinueOnError, createProgram } from './cli.js';

describe('CLI program', () => {
  const tempDirectories: string[] = [];

  beforeEach(() => {
    mocks.createApp.mockReturnValue({
      addHook: vi.fn(),
      close: vi.fn().mockResolvedValue(undefined),
      listen: vi.fn().mockResolvedValue(undefined),
      server: { address: () => ({ address: '127.0.0.1', port: 3000 }) }
    });
    mocks.createConfiguredGeocoder.mockReturnValue({ search: vi.fn() });
    mocks.runBulk.mockResolvedValue({ processed: 0, succeeded: 0, failed: 0 });
    mocks.readFile.mockImplementation(async (filename: string) => readFileSync(filename, 'utf8'));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
    for (const directory of tempDirectories.splice(0)) rmSync(directory, { recursive: true });
  });

  it('maps CLI options over environment fallbacks for the default command', async () => {
    vi.stubEnv('OSM_EMAIL', 'env@example.test');
    vi.stubEnv('OSM_USER_AGENT', 'env-agent');
    vi.stubEnv('CACHE_SIZE', '17');
    vi.stubEnv('PROVIDER_LANGUAGE', 'de');
    vi.stubEnv('RATE_LIMIT_ENABLED', 'false');

    const program = createProgram();
    const processOn = vi.spyOn(process, 'on').mockImplementation(() => process);
    await program.parseAsync([
      'node',
      'geocoder',
      '--providers',
      'osm,photon',
      '--osm-server',
      'https://maps.example.test/nominatim/',
      '--rate-profile',
      'self-hosted',
      '--port',
      '4321',
      '--host',
      'cli-host',
      '--concurrency',
      '2',
      '--rate-limit',
      '--rate-limit-max',
      '3',
      '--rate-limit-window',
      '2 seconds',
      '--trust-proxy',
      'true'
    ]);
    processOn.mockRestore();

    expect(mocks.createApp).toHaveBeenCalledWith({
      cache: {
        dirname: undefined,
        size: 17,
        positiveTtl: 3_600_000,
        negativeTtl: 300_000
      },
      geocoder: {
        providers: ['osm', 'photon'],
        rateProfile: 'self-hosted',
        osmServer: 'https://maps.example.test/nominatim',
        email: 'env@example.test',
        userAgent: 'env-agent',
        language: 'de',
        providerTimeoutMs: 5000,
        retries: 2,
        concurrency: 2,
        locationIqKey: undefined
      },
      logLevel: 'info',
      trustProxy: true,
      rateLimit: { max: 3, timeWindow: '2 seconds' }
    });
  });

  it('reports the missing credentials error for public OSM without starting the app', async () => {
    vi.stubEnv('OSM_EMAIL', '');
    vi.stubEnv('OSM_USER_AGENT', '');
    const program = createProgram().exitOverride();

    await expect(
      program.parseAsync(['node', 'geocoder', '--providers', 'osm'])
    ).rejects.toMatchObject({
      code: 'commander.error',
      exitCode: 1,
      message:
        'You must provide an email and user agent for the default server (--help for more info)'
    });
    expect(mocks.createApp).not.toHaveBeenCalled();
  });

  it('reads bulk input and resume files and maps bulk options', async () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'geocoder-cli-'));
    tempDirectories.push(directory);
    const input = path.join(directory, 'input.txt');
    const resume = path.join(directory, 'resume.ndjson');
    writeFileSync(input, 'Paris\nBerlin\n');
    writeFileSync(resume, '{"query":"Paris","ok":true}\n');

    const program = createProgram();
    await program.parseAsync([
      'node',
      'geocoder',
      'bulk',
      input,
      '--resume',
      resume,
      '--workers',
      '3',
      '--continue-on-error'
    ]);

    expect(mocks.createConfiguredGeocoder).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ['osm', 'photon'],
        rateProfile: 'public-bulk'
      }),
      expect.objectContaining({ size: 1000 })
    );
    expect(mocks.runBulk).toHaveBeenCalledWith(
      expect.objectContaining({
        input: 'Paris\nBerlin\n',
        resume: '{"query":"Paris","ok":true}\n',
        workers: 3,
        continueOnError: true,
        geocoder: expect.anything(),
        write: expect.any(Function),
        progress: expect.any(Function)
      })
    );
  });

  it('reads bulk input from stdin when input is -', async () => {
    mocks.readFile.mockResolvedValue('stdin query\n');
    await createProgram().parseAsync(['node', 'geocoder', 'bulk', '-']);

    expect(mocks.readFile).toHaveBeenCalledWith('/dev/stdin', 'utf8');
    expect(mocks.runBulk).toHaveBeenCalledWith(expect.objectContaining({ input: 'stdin query\n' }));
  });

  it('provides working bulk output callbacks', async () => {
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mocks.readFile.mockResolvedValue('stdin query\n');
    await createProgram().parseAsync(['node', 'geocoder', 'bulk', '-']);

    const options = mocks.runBulk.mock.calls[0]?.[0];
    options.write('result');
    options.progress('progress');
    expect(stdout).toHaveBeenCalledWith('result\n');
    expect(stderr).toHaveBeenCalledWith('progress\n');
  });

  it('continues only when continueOnError is explicitly true', () => {
    expect(bulkContinueOnError({ continueOnError: true })).toBe(true);
    expect(bulkContinueOnError({ continueOnError: false })).toBe(false);
    expect(bulkContinueOnError({ continue: true })).toBe(false);
  });
});