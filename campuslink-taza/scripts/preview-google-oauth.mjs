// Real Neon authentication against an explicitly selected test branch only.
// No production fallback, automatic migrations, seed, or remote file storage.
import { existsSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const defaultFile = resolve(root, '.env.local');
const required = [
  'NEON_TEST_BRANCH_ID', 'NEON_TEST_BRANCH_NAME', 'DATABASE_URL',
  'NEON_AUTH_BASE_URL', 'NEON_AUTH_JWKS_URL', 'CAMPUS_DB_SCHEMA', 'APP_ORIGIN',
  'COOKIE_SECURE', 'GOOGLE_OAUTH_ENABLED', 'ALLOWED_ACADEMIC_EMAIL_DOMAINS',
];
class PreviewConfigError extends Error {}
const fail = message => { throw new PreviewConfigError(message); };
const serverSetting = key => /^(?:DATABASE_URL$|NEON_|R2_|CAMPUS_|APP_ORIGIN$|COOKIE_SECURE$|GOOGLE_|ALLOWED_ACADEMIC_EMAIL_DOMAINS$|PORT$)/.test(key);

function readConfig(path, label) {
  try { return parseEnv(readFileSync(path, 'utf8')); }
  catch { fail(`${label} is missing or unreadable. No connection was attempted.`); }
}
function url(value, label, protocols) {
  let parsed;
  try { parsed = new URL(value); } catch { fail(`${label} is invalid.`); }
  if (!protocols.includes(parsed.protocol) || parsed.hash) fail(`${label} is invalid.`);
  return parsed;
}
function authURL(value, label) {
  const parsed = url(value, label, ['https:']);
  if (parsed.username || parsed.password || parsed.search) fail(`${label} is invalid.`);
  return parsed;
}
const endpointHost = value => value.hostname.toLowerCase().replace(/-pooler(?=\.)/, '');

function configuration() {
  const args = process.argv.slice(2);
  if (args.some(arg => arg !== '--check' && !arg.startsWith('--env=')) || args.filter(arg => arg.startsWith('--env=')).length > 1) {
    fail('Usage: npm run preview:google-oauth -- [--env=/path/to/test.env] [--check]');
  }
  const envArgument = args.find(arg => arg.startsWith('--env='));
  if (envArgument === '--env=') fail('--env requires an explicit test environment file.');
  const file = envArgument ? resolve(envArgument.slice(6)) : resolve(root, '.env.oauth-test.local');
  if ([defaultFile, resolve(root, '.env'), resolve(root, '.env.example')].includes(file)) {
    fail('Use a dedicated test environment file; the normal application environment is refused.');
  }
  const baseline = readConfig(defaultFile, 'The normal .env.local comparison file');
  const env = readConfig(file, 'The dedicated OAuth test environment');
  const missing = required.filter(key => !env[key]?.trim());
  if (missing.length) fail(`The dedicated test environment must explicitly define: ${missing.join(', ')}.`);
  if (!/^br-[a-z0-9-]+$/.test(env.NEON_TEST_BRANCH_ID)
    || !/^[a-z0-9][a-z0-9._/-]{0,127}$/i.test(env.NEON_TEST_BRANCH_NAME)
    || !/(?:test|preview|sandbox|development|oauth)/i.test(env.NEON_TEST_BRANCH_NAME)
    || /^(?:main|master|prod|production)$/i.test(env.NEON_TEST_BRANCH_NAME)) {
    fail('Explicit Neon test branch metadata is required.');
  }
  const database = url(env.DATABASE_URL, 'Test DATABASE_URL', ['postgres:', 'postgresql:']);
  const originalDatabase = url(baseline.DATABASE_URL, 'Normal DATABASE_URL comparison', ['postgres:', 'postgresql:']);
  if (!database.hostname || !database.pathname.slice(1) || endpointHost(database) === endpointHost(originalDatabase)) {
    fail('The test database must use a different endpoint from .env.local, including pooled aliases.');
  }
  const auth = authURL(env.NEON_AUTH_BASE_URL, 'Test NEON_AUTH_BASE_URL');
  const originalAuth = authURL(baseline.NEON_AUTH_BASE_URL, 'Normal Neon Auth comparison');
  const jwks = authURL(env.NEON_AUTH_JWKS_URL, 'Test NEON_AUTH_JWKS_URL');
  if (auth.origin === originalAuth.origin) fail('Test Neon Auth must have a different origin from .env.local.');
  if (jwks.origin !== auth.origin || jwks.pathname !== `${auth.pathname.replace(/\/$/, '')}/.well-known/jwks.json`) {
    fail('Test JWKS must belong to the selected test Neon Auth service.');
  }
  if (env.APP_ORIGIN !== 'http://localhost:5181') fail('APP_ORIGIN must be http://localhost:5181 for this local test launcher.');
  if (env.COOKIE_SECURE !== 'false') fail('COOKIE_SECURE must explicitly be false for the localhost HTTP preview.');
  if (!['true', 'false'].includes(env.GOOGLE_OAUTH_ENABLED)) fail('GOOGLE_OAUTH_ENABLED must explicitly be true or false.');
  if (!/^[a-z][a-z0-9_]{0,62}$/.test(env.CAMPUS_DB_SCHEMA)) fail('CAMPUS_DB_SCHEMA is invalid.');
  if (env.ALLOWED_ACADEMIC_EMAIL_DOMAINS !== 'usmba.ac.ma') fail('The confirmed academic domain must be exactly usmba.ac.ma.');
  if (env.GOOGLE_WORKSPACE_DOMAINS && env.GOOGLE_WORKSPACE_DOMAINS !== 'usmba.ac.ma') fail('GOOGLE_WORKSPACE_DOMAINS may only be empty or usmba.ac.ma.');
  return { env, baseline, check: args.includes('--check') };
}

let app, server, stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  app?.locals.endStreams?.();
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  }
  await app?.locals.close?.();
}

try {
  const { env, baseline, check } = configuration();
  if (check) {
    console.log(JSON.stringify({
      valid: true, connectionsAttempted: false,
      branchId: env.NEON_TEST_BRANCH_ID, branchName: env.NEON_TEST_BRANCH_NAME,
      applicationOrigin: env.APP_ORIGIN,
      googleEnabled: env.GOOGLE_OAUTH_ENABLED === 'true', academicDomain: 'usmba.ac.ma',
      databaseAndAuthDifferFromDefault: true, storage: 'temporary memory only',
    }, null, 2));
  } else {
    if (!existsSync(resolve(root, 'dist/index.html'))) fail('Build the frontend with npm run build before starting this preview.');
    // server/env.js loads .env.local on import. Predefine every baseline/server
    // key so it cannot silently fill test settings with production credentials.
    for (const key of new Set([...Object.keys(baseline), ...Object.keys(process.env)])) {
      if (Object.hasOwn(baseline, key) || serverSetting(key)) process.env[key] = '';
    }
    for (const [key, value] of Object.entries(env)) process.env[key] = value;
    process.env.GOOGLE_WORKSPACE_DOMAINS = env.GOOGLE_WORKSPACE_DOMAINS || '';
    process.env.CAMPUS_TEST_DATABASE_URL = env.DATABASE_URL;
    process.env.CAMPUS_DB_MIGRATE = 'false';
    process.env.CAMPUS_DB_SEED = 'false';
    process.env.PORT = '5181';
    process.chdir(root);
    const [{ createApp }, { memoryStorage }, { initializeWithRetry }] = await Promise.all([
      import('../server/app.js'), import('../tests/backend-helpers.mjs'), import('../server/startup.js'),
    ]);
    // Only the storage double is used. Authentication is the real application
    // service; createTestApp/createTestAuth are never called here.
    app = await initializeWithRetry(() => createApp({
      connectionString: env.DATABASE_URL, schema: env.CAMPUS_DB_SCHEMA,
      appOrigin: env.APP_ORIGIN, migrate: false, seed: false, storage: memoryStorage(),
    }));
    server = createServer((req, res) => {
      if (!['localhost:5181', '127.0.0.1:5181'].includes(req.headers.host)) {
        res.writeHead(403, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
        res.end('Use http://localhost:5181 for this local test preview.');
        return;
      }
      app(req, res);
    });
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(5181, '127.0.0.1', resolve);
    });
    server.on('error', () => {
      console.error('Local OAuth preview server failed.');
      void stop().then(() => { process.exitCode = 1; }, () => process.exit(1));
    });
    for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => {
      void stop().then(() => process.exit(0), () => process.exit(1));
    });
    console.log(`CampusLink real Neon OAuth test preview: ${env.APP_ORIGIN}\nTest branch: ${env.NEON_TEST_BRANCH_NAME} (${env.NEON_TEST_BRANCH_ID})\nGoogle enabled locally: ${env.GOOGLE_OAUTH_ENABLED}. Files stay in temporary memory. No migration or seed was run.`);
  }
} catch (error) {
  await stop().catch(() => {});
  if (error?.readiness) {
    console.error('The selected test branch schema is not ready. Apply pending migrations explicitly to that isolated branch before starting this preview. No migration or seed was run.');
  } else if (error?.code) {
    const hints = { EADDRINUSE: 'Port 5181 is already in use.', AUTH_CONFIGURATION: 'Test Neon Auth configuration is incomplete.', DATABASE_UNAVAILABLE: 'The selected test database is unavailable.' };
    console.error(hints[error.code] || 'The local OAuth test preview could not start. Check the dedicated test environment and isolated branch.');
  } else {
    // Only our static validation errors are emitted. Driver/provider errors are
    // never printed because their messages may include credentials or tokens.
    console.error(error instanceof PreviewConfigError ? error.message
      : 'The local OAuth test preview could not start. Check the dedicated test environment and isolated branch.');
  }
  process.exitCode = 1;
}
