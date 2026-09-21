import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Minimal `.env` reader for local development and tests.
 *
 * Deployed environments use platform secrets, never a file, so this deliberately does not
 * support interpolation, exports or multiline values. Existing process variables win, so a
 * test can override a single setting without rewriting the file.
 */
export function loadDotEnv(file = '.env.local', cwd = process.cwd()): Record<string, string> {
  const path = resolve(cwd, file);
  const loaded: Record<string, string> = {};
  if (!existsSync(path)) return loaded;
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq < 1) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    loaded[key] = value;
    if (process.env[key] === undefined) process.env[key] = value;
  }
  return loaded;
}
