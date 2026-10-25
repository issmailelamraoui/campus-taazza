import '../server/env.js';
import { googleOAuthConfiguration } from '../server/auth-sessions.js';

const config = googleOAuthConfiguration();
const report = {
  enabled: config.enabled,
  requested: config.requested,
  academicDomainsConfigured: config.configured,
  allowedEmailDomains: [...config.domains],
  requiredWorkspaceDomains: [...config.workspaceDomains],
  providerCredentials: 'Managed in Neon Console; not exposed or inspected by this script.',
};
try {
  const base = new URL(String(process.env.NEON_AUTH_BASE_URL || '').replace(/\/?$/, '/'));
  const jwks = new URL(process.env.NEON_AUTH_JWKS_URL);
  const app = new URL(process.env.APP_ORIGIN);
  if (base.protocol !== 'https:' || base.username || base.password || base.search || base.hash
    || jwks.protocol !== 'https:' || jwks.username || jwks.password || jwks.search || jwks.hash
    || app.origin !== process.env.APP_ORIGIN || app.username || app.password
    || !(app.protocol === 'https:' || app.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(app.hostname))) throw Error();
  report.neonSessionVerificationConfigured = true;
  report.googleAuthorizedRedirectURI = new URL('callback/google', base).href;
  report.applicationCallbackURL = new URL('/api/auth/google/callback', app).href;
  report.applicationOrigin = app.origin;
  report.publicOriginToConfirmInNeon = 'https://taza-link.vercel.app';
  if (process.argv.includes('--verify-provider')) {
    // Only the public OpenAPI schema is requested. No sign-in or provider write.
    const response = await fetch(new URL('open-api/generate-schema', base), {
      headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(10000),
    });
    if (!response.ok) throw Error();
    const schema = await response.json();
    report.managedEndpoints = Object.fromEntries([
      ['/sign-in/social', 'post'], ['/link-social', 'post'], ['/get-session', 'get'],
      ['/list-accounts', 'get'], ['/account-info', 'get'],
    ].map(([path, method]) => [path, Boolean(schema.paths?.[path]?.[method])]));
    if (Object.values(report.managedEndpoints).some(value => !value)) process.exitCode = 1;
  }
} catch {
  report.configurationOrReadOnlyProbeFailed = true;
  process.exitCode = 1;
}
console.log(JSON.stringify(report, null, 2));
