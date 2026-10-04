#!/usr/bin/env node
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { Command, InvalidArgumentError, Option } from 'commander';
import { AddressInfo } from 'net';
import pJson from '../package.json' with { type: 'json' };
import { createApp, createConfiguredGeocoder } from './app.js';
import { runBulk } from './bulk.js';
import {
  isDefaultNominatimServer,
  normalizeOsmServerUrl,
  parseBoolean,
  parseCacheSize,
  parseConcurrency,
  parseDuration,
  parsePort,
  parseProviders,
  parseProviderTimeout,
  parseRateLimitMax,
  parseRateProfile,
  parseRetries,
  validateApiKey,
  validateCacheDirectory,
  validateEmail,
  validateHost,
  validateLanguage,
  validateUserAgent
} from './helpers/config.js';
import { parseEnv } from './helpers/env.js';

const commanderParser =
  <T>(parser: (value: string) => T) =>
  (value: string): T => {
    try {
      return parser(value);
    } catch (error) {
      throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
    }
  };

function addConfigOptions(command: Command): Command {
  return command
    .addOption(
      new Option('--osm-server <SERVER>', 'OpenStreetMap server to use').argParser(
        commanderParser(normalizeOsmServerUrl)
      )
    )
    .addOption(
      new Option('--osm-email <EMAIL>', 'Email to use for OpenStreetMap requests').argParser(
        commanderParser((value) => validateEmail(value) as string)
      )
    )
    .addOption(
      new Option('--osm-agent <AGENT>', 'User agent to use for OpenStreetMap requests').argParser(
        commanderParser((value) => validateUserAgent(value) as string)
      )
    )
    .addOption(
      new Option('--providers <LIST>', 'Comma-separated provider order').argParser(
        commanderParser(parseProviders)
      )
    )
    .addOption(
      new Option('--rate-profile <PROFILE>', 'Provider rate policy').argParser(
        commanderParser(parseRateProfile)
      )
    )
    .addOption(
      new Option('--provider-language <LANG>', 'Provider language').argParser(
        commanderParser(validateLanguage)
      )
    )
    .addOption(
      new Option('--provider-timeout-ms <MS>', 'Provider timeout in milliseconds').argParser(
        commanderParser(parseProviderTimeout)
      )
    )
    .addOption(
      new Option('--provider-retries <COUNT>', 'Provider retry count').argParser(
        commanderParser(parseRetries)
      )
    )
    .addOption(
      new Option('--locationiq-key <KEY>', 'LocationIQ API key').argParser(
        commanderParser((value) => validateApiKey(value) as string)
      )
    )
    .addOption(
      new Option('--cache-dir <DIR>', 'Directory to store cache files').argParser(
        commanderParser((value) => validateCacheDirectory(value) as string)
      )
    )
    .addOption(
      new Option('--cache-size <SIZE>', 'Number of records to keep in memory').argParser(
        commanderParser(parseCacheSize)
      )
    )
    .addOption(
      new Option('--cache-positive-ttl <DURATION>', 'Positive cache TTL').argParser(
        commanderParser((value) => parseDuration(value, 'CACHE_POSITIVE_TTL_MS'))
      )
    )
    .addOption(
      new Option('--cache-negative-ttl <DURATION>', 'Negative cache TTL').argParser(
        commanderParser((value) => parseDuration(value, 'CACHE_NEGATIVE_TTL_MS'))
      )
    )
    .addOption(
      new Option('--rate-limit-max <MAX>', 'Inbound requests per window').argParser(
        commanderParser(parseRateLimitMax)
      )
    )
    .addOption(
      new Option('--rate-limit-window <DURATION>', 'Inbound rate-limit window').argParser(
        commanderParser((value) => {
          parseDuration(value, 'rateLimit.timeWindow');
          return value;
        })
      )
    )
    .addOption(new Option('--rate-limit', 'Enable inbound rate limiting'))
    .addOption(
      new Option('--trust-proxy <BOOLEAN>', 'Trust forwarded client addresses').argParser(
        commanderParser((value) => parseBoolean(value, 'TRUST_PROXY'))
      )
    )
    .addOption(
      new Option('--concurrency <COUNT>', 'Provider concurrency').argParser(
        commanderParser(parseConcurrency)
      )
    )
    .addOption(
      new Option('-H, --host <HOST>', 'Host to listen on').argParser(commanderParser(validateHost))
    )
    .addOption(
      new Option('-p, --port <PORT>', 'Port to listen on').argParser(commanderParser(parsePort))
    );
}

function settings(options: Record<string, unknown>) {
  const env = parseEnv();
  const get = <T>(name: string, fallback: T): T =>
    options[name] === undefined ? fallback : (options[name] as T);
  return {
    osmServer: get('osmServer', env.OSM_SERVER),
    osmEmail: get('osmEmail', env.OSM_EMAIL),
    osmAgent: get('osmAgent', env.OSM_USER_AGENT),
    providers: get('providers', env.PROVIDERS),
    rateProfile: get('rateProfile', env.RATE_PROFILE),
    language: get('providerLanguage', env.PROVIDER_LANGUAGE),
    providerTimeoutMs: get('providerTimeoutMs', env.PROVIDER_TIMEOUT_MS),
    retries: get('providerRetries', env.PROVIDER_RETRIES),
    locationIqKey: get('locationiqKey', env.LOCATIONIQ_KEY),
    cacheDir: get('cacheDir', env.CACHE_DIR),
    cacheSize: get('cacheSize', env.CACHE_SIZE),
    positiveTtl: get('cachePositiveTtl', env.CACHE_POSITIVE_TTL_MS),
    negativeTtl: get('cacheNegativeTtl', env.CACHE_NEGATIVE_TTL_MS),
    rateLimitEnabled: get('rateLimit', env.RATE_LIMIT_ENABLED),
    rateLimitMax: get('rateLimitMax', env.RATE_LIMIT_MAX),
    rateLimitWindow: get('rateLimitWindow', env.RATE_LIMIT_WINDOW),
    trustProxy: get('trustProxy', env.TRUST_PROXY),
    host: get('host', env.HOST),
    port: get('port', env.PORT),
    concurrency: get('concurrency', env.CONCURRENCY),
    logLevel: env.LOG_LEVEL,
    shutdownTimeout: env.GRACEFUL_SHUTDOWN_TIMEOUT_MS
  };
}

function configFrom(options: ReturnType<typeof settings>) {
  return {
    providers: options.providers,
    rateProfile: options.rateProfile,
    osmServer: options.osmServer,
    email: options.osmEmail,
    userAgent: options.osmAgent,
    language: options.language,
    providerTimeoutMs: options.providerTimeoutMs,
    retries: options.retries,
    concurrency: options.concurrency,
    locationIqKey: options.locationIqKey
  };
}

export function bulkContinueOnError(options: Record<string, unknown>): boolean {
  return options.continueOnError === true;
}

export function createProgram(): Command {
  const program = addConfigOptions(new Command());
  program
    .name('geocoder')
    .description('Geocode addresses with configured providers')
    .helpOption('--help', 'Show usage instructions')
    .version(pJson.version)
    .action(async (rawOptions) => {
      const options = settings(rawOptions);
      const config = configFrom(options);
      const normalizedOsmServer = normalizeOsmServerUrl(config.osmServer);
      if (
        config.providers?.includes('osm') &&
        isDefaultNominatimServer(normalizedOsmServer) &&
        (!config.email || !config.userAgent)
      ) {
        program.error(
          'You must provide an email and user agent for the default server (--help for more info)'
        );
      }
      const app = createApp({
        cache: {
          dirname: options.cacheDir,
          size: options.cacheSize,
          positiveTtl: options.positiveTtl,
          negativeTtl: options.negativeTtl
        },
        geocoder: { ...config, osmServer: normalizedOsmServer },
        logLevel: options.logLevel,
        trustProxy: options.trustProxy,
        ...(options.rateLimitEnabled
          ? { rateLimit: { max: options.rateLimitMax, timeWindow: options.rateLimitWindow } }
          : {})
      });
      await listen(app, options.host, options.port, options.shutdownTimeout);
    });

  const bulk = program
    .command('bulk')
    .argument('[input]', 'Input file, or - for stdin')
    .option('-i, --input <FILE>', 'Input file (default: stdin)')
    .option('--resume <FILE>', 'Previous NDJSON output')
    .option('--workers <COUNT>', 'Number of workers', '1')
    .option('--continue-on-error', 'Continue after provider failures');
  addConfigOptions(bulk).action(async (input, rawOptions, command) => {
    const root = command.parent?.opts() ?? {};
    const options = settings({ ...root, ...rawOptions });
    const publicNominatim =
      options.providers.includes('osm') && isDefaultNominatimServer(options.osmServer);
    const rateProfile = publicNominatim ? 'public-bulk' : options.rateProfile;
    const inputText = await readInput(rawOptions.input ?? input ?? '-');
    const resumeText = rawOptions.resume ? await readInput(rawOptions.resume) : undefined;
    const geocoder = createConfiguredGeocoder(
      { ...configFrom(options), rateProfile },
      {
        dirname: options.cacheDir,
        size: options.cacheSize,
        positiveTtl: options.positiveTtl,
        negativeTtl: options.negativeTtl
      }
    );
    await runBulk({
      input: inputText,
      resume: resumeText,
      geocoder,
      workers: Number(rawOptions.workers),
      continueOnError: rawOptions.continueOnError === true,
      write: (line) => process.stdout.write(`${line}\n`),
      progress: (line) => process.stderr.write(`${line}\n`)
    });
  });
  return program;
}

async function readInput(filename: string): Promise<string> {
  return readFile(filename === '-' ? '/dev/stdin' : filename, 'utf8');
}

async function listen(
  app: ReturnType<typeof createApp>,
  host: string,
  port: number,
  shutdownTimeout: number
) {
  app.addHook('onListen', () => {
    const address = app.server.address() as AddressInfo;
    process.stderr.write(`Server listening on http://${address.address}:${address.port}\n`);
  });
  try {
    await app.listen({ host, port });
    const shutdown = async (signal: string) => {
      process.stderr.write(`Received ${signal}, starting graceful shutdown...\n`);
      try {
        let timeoutHandle: NodeJS.Timeout | undefined;
        const timeout = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error('Graceful shutdown timed out')),
            shutdownTimeout
          );
        });
        try {
          await Promise.race([app.close(), timeout]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
        }
        process.stderr.write('Graceful shutdown complete\n');
        process.exit(0);
      } catch (error) {
        process.stderr.write(`${error instanceof Error ? error.message : 'Shutdown failed'}\n`);
        process.exit(1);
      }
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : 'Server failed to start'}\n`);
    process.exitCode = 1;
  }
}

const invokedFile = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (invokedFile === import.meta.url) {
  createProgram()
    .parseAsync(process.argv)
    .catch((error: unknown) => {
      process.stderr.write(`${error instanceof Error ? error.message : 'Command failed'}\n`);
      process.exitCode = 1;
    });
}