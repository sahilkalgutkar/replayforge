import { readFileSync } from 'node:fs';

/**
 * Loads a .env file into the process environment without overwriting anything
 * already set, so an inline `MERIDIAN_PASSWORD=x replayforge replay ...` beats
 * the file. Small enough not to warrant a dependency.
 */
export function loadEnvFile(path = '.env'): void {
  let contents: string;
  try {
    contents = readFileSync(path, 'utf8');
  } catch {
    return;
  }
  for (const line of contents.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const separator = trimmed.indexOf('=');
    if (separator === -1) continue;
    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/g, '');
    if (process.env[key] === undefined) process.env[key] = value;
  }
}
