// Entry point for the forge: boots the HTTP server, registers its port with
// the trial env, then waits until the env says the trial is over.
//
// Lifecycle (settled by the harness, env/src/wire.ts):
//   1. Read and validate the config from the environment. The only required
//      value is MAKEFUN_ENV_URL, the env's origin (http://store:8080 inside a
//      trial pod). Without it there is nothing to register with, so exit 1.
//   2. Create the forge server (app.ts: git smart HTTP, REST v3, GraphQL v4
//      and MCP over one in-memory store) and listen on an ephemeral port.
//      Port 0 lets the kernel pick a free one; never bind 8080, the env
//      listens there. An explicit MAKEFUN_PORT is honoured only when it is a
//      sane, non-8080 port, and a port that is already taken fails fast with
//      a message that names the port instead of a bare stack trace.
//   3. POST {"port": N} to $MAKEFUN_ENV_URL/register. The env records the
//      address the request came from plus N and dials it from then on. The
//      first register wins; a 409 means another process already registered
//      and this process simply waits like any other. 400/405 are contract
//      errors and end the program; anything else is retried, since the env
//      may still be starting up.
//   4. Poll GET $MAKEFUN_ENV_URL/done until it answers {"done": true}. The
//      env answers at once ({"done": false} while the suite runs), so this is
//      a poll, not a long-held request. A failed or slow poll is retried with
//      exponential backoff; the process never exits before the env says done.
//   5. Close the server and exit 0. The harness then stops the env, which
//      writes the export the scorer reads.
//
// A SIGINT or SIGTERM at any point shuts the server down cleanly instead of
// leaving a half-open socket behind. Nothing in this file makes a model call
// and nothing here reaches past the env: the only outbound traffic is the
// register POST and the done polls.

import { createApp } from './app.ts';

/** Everything the entry point needs, parsed once and validated up front. */
interface EntryConfig {
  /** The env origin, trailing slashes stripped, e.g. http://store:8080. */
  envUrl: string;
  /** Interface to bind: 0.0.0.0 so the env can dial the pod's address. */
  host: string;
  /** Port to bind: 0 means the kernel picks an ephemeral one. */
  port: number;
  /** How long one register or done request may take before it is abandoned. */
  requestTimeoutMs: number;
  /** First wait between retries, and the longest wait. */
  retryInitialMs: number;
  retryMaxMs: number;
}

const ENV_PORT = 8080; // The env's own port: never bind it.
const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RETRY_INITIAL_MS = 250;
const DEFAULT_RETRY_MAX_MS = 2_000;
const MAX_PORT = 65_535;

/** Parse an env var as a positive integer, falling back when it is absent or junk. */
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isSafeInteger(value) && value > 0 ? value : fallback;
}

/**
 * Read the config, failing fast with a plain-language message when a value is
 * missing or unusable instead of crashing halfway through the boot.
 */
function readConfig(): EntryConfig {
  const rawEnvUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
  if (rawEnvUrl === '') {
    throw new Error('MAKEFUN_ENV_URL is not set: there is no env to register with');
  }
  let envUrl: URL;
  try {
    envUrl = new URL(rawEnvUrl);
  } catch {
    throw new Error(`MAKEFUN_ENV_URL is not a valid URL: ${rawEnvUrl}`);
  }
  if (envUrl.protocol !== 'http:' && envUrl.protocol !== 'https:') {
    throw new Error(`MAKEFUN_ENV_URL must be http(s), got ${envUrl.protocol}`);
  }

  const host = (process.env.MAKEFUN_BIND_HOST ?? '0.0.0.0').trim() || '0.0.0.0';

  const rawPort = process.env.MAKEFUN_PORT;
  let port = 0; // Ephemeral by default: the kernel picks a free port.
  if (rawPort !== undefined && rawPort.trim() !== '') {
    const parsed = Number.parseInt(rawPort, 10);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PORT) {
      throw new Error(`MAKEFUN_PORT must be an integer between 1 and ${MAX_PORT}, got ${rawPort}`);
    }
    if (parsed === ENV_PORT) {
      throw new Error(`MAKEFUN_PORT must not be ${ENV_PORT}: the env listens there`);
    }
    port = parsed;
  }

  return {
    envUrl: rawEnvUrl,
    host,
    port,
    requestTimeoutMs: envInt('MAKEFUN_REQUEST_TIMEOUT_MS', DEFAULT_REQUEST_TIMEOUT_MS),
    retryInitialMs: envInt('MAKEFUN_RETRY_INITIAL_MS', DEFAULT_RETRY_INITIAL_MS),
    retryMaxMs: envInt('MAKEFUN_RETRY_MAX_MS', DEFAULT_RETRY_MAX_MS),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The wait after `attempt` failed requests: exponential from the initial wait, capped. */
function retryDelay(config: EntryConfig, attempt: number): number {
  return Math.min(config.retryMaxMs, config.retryInitialMs * 2 ** Math.min(attempt, 8));
}

function log(message: string): void {
  process.stdout.write(`[entry] ${message}\n`);
}

function logError(message: string): void {
  process.stderr.write(`[entry] ${message}\n`);
}

/**
 * POST the bound port until the env accepts it. 200 is the normal answer; 409
 * means a first register already won, which is not this process's to fix. 400
 * and 405 are contract errors and end the program; a network error or another
 * status is retried, since the env may still be starting.
 */
async function register(config: EntryConfig, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${config.envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(config.requestTimeoutMs),
      });
      if (res.status === 200) return;
      if (res.status === 409) {
        // Another process registered first; this one keeps waiting like any
        // other, since the env will only ever dial the first registration.
        log('register answered 409: another entry registered first; waiting');
        return;
      }
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
      logError(`register answered HTTP ${res.status}; retrying`);
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
      if (attempt % 20 === 0) {
        logError(`register failed (${err instanceof Error ? err.message : String(err)}); retrying`);
      }
    }
    await sleep(retryDelay(config, attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(config: EntryConfig): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${config.envUrl}/done`, { signal: AbortSignal.timeout(config.requestTimeoutMs) });
      if (res.ok) {
        let body: unknown = null;
        try {
          body = await res.json();
        } catch {
          body = null; // A non-JSON answer is not "done"; poll again.
        }
        if (typeof body === 'object' && body !== null && (body as { done?: unknown }).done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: it is not done, so poll again.
    }
    await sleep(retryDelay(config, attempt));
  }
}

/**
 * Bind the forge server. A port that is already taken (EADDRINUSE) fails fast
 * with a message naming the port and the fix, instead of an opaque stack
 * trace; any other listen error is rethrown the same way.
 */
async function bindServer(config: EntryConfig): Promise<{ server: ReturnType<typeof createApp>; port: number }> {
  const server = createApp();
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => resolve());
    });
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | undefined)?.code;
    if (code === 'EADDRINUSE') {
      throw new Error(
        `port ${config.port} is already in use on ${config.host}; ` +
          `unset MAKEFUN_PORT (or pick a free one) so the kernel chooses an ephemeral port`,
      );
    }
    throw new Error(`failed to listen on ${config.host}:${config.port}: ${err instanceof Error ? err.message : String(err)}`);
  }
  const address = server.address();
  if (address === null || typeof address === 'string') {
    server.close();
    throw new Error('the server did not bind a TCP port');
  }
  // From here on a server error (a dropped client socket, a listen fault
  // after the fact) is logged, not an unhandled 'error' crash: the forge
  // stays up for the suite until the env says done.
  server.on('error', (err: Error) => {
    logError(`server error: ${err.message}`);
  });
  return { server, port: address.port };
}

/** Bound the port, register it, then wait for the env: the whole life of the process. */
async function main(): Promise<void> {
  const config = readConfig();
  const { server, port } = await bindServer(config);
  log(`listening on ${config.host}:${port} (env ${config.envUrl})`);

  // A signal means the harness is tearing the pod down: close the server and
  // leave promptly instead of hanging on the done poll.
  let shuttingDown = false;
  const onSignal = (signal: string): void => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`received ${signal}; shutting down`);
    server.close(() => process.exit(0));
    // If the server will not close (a connection is still open), force it.
    setTimeout(() => process.exit(0), 5_000).unref();
  };
  process.once('SIGINT', () => onSignal('SIGINT'));
  process.once('SIGTERM', () => onSignal('SIGTERM'));

  await register(config, port);
  log('registered; waiting for the env to say done');

  await waitForDone(config);
  server.close();
  log('done');
}

try {
  await main();
  process.exit(0);
} catch (err) {
  logError(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
