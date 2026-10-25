import '../server/env.js';
import { spawn } from 'node:child_process';

const configured = process.env.CAMPUS_TEST_DATABASE_URL;
if (!configured) {
  console.error('Set CAMPUS_TEST_DATABASE_URL to an isolated local PostgreSQL database or Neon test branch. This suite never falls back to DATABASE_URL.');
  process.exit(1);
}
try {
  const test = new URL(configured);
  if (!['postgres:', 'postgresql:'].includes(test.protocol)) throw Error();
  if (process.env.DATABASE_URL) {
    const application = new URL(process.env.DATABASE_URL);
    if (test.hostname === application.hostname && test.port === application.port && test.pathname === application.pathname) {
      console.error('The OAuth test database must be separate from the configured application database.');
      process.exit(1);
    }
  }
} catch {
  console.error('CAMPUS_TEST_DATABASE_URL must be a valid isolated PostgreSQL connection URL.');
  process.exit(1);
}
const child = spawn(process.execPath, ['--test', '--test-concurrency=2',
  'tests/backend-auth.test.mjs', 'tests/neon-google-oauth.test.mjs', 'tests/backend-google-oauth.test.mjs'],
{ stdio: 'inherit', env: process.env });
child.on('error', () => { console.error('The OAuth test runner could not start.'); process.exitCode = 1; });
child.on('exit', code => { process.exitCode = code ?? 1; });
