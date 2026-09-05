import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const FIXTURES_DIR = fileURLToPath(new URL('../../test/fixtures/', import.meta.url));

/** Absolute path of a file under test/fixtures. */
export function fixturePath(name: string): string {
  return `${FIXTURES_DIR}${name}`;
}

/** Contents of a text fixture. */
export function readFixture(name: string): string {
  return readFileSync(fixturePath(name), 'utf8');
}

/** A JSON fixture, parsed fresh on every call so tests can mutate it freely. */
export function readJsonFixture<T = unknown>(name: string): T {
  return JSON.parse(readFixture(name)) as T;
}
