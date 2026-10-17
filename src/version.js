import { readFileSync } from 'node:fs';

/** The product version has one source of truth: package.json (test/release.test.js checks the other manifests). */
export const WEFT_VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
