import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';
import { resolve } from 'node:path';

// Node reads server configuration without passing any credentials to Vite.
// Existing process variables take precedence over the local environment file.
export function loadEnvironment() {
  const path = resolve('.env.local');
  if (existsSync(path)) loadEnvFile(path);
}

loadEnvironment();
