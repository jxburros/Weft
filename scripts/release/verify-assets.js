#!/usr/bin/env node
// Verifies every latest*.yml with the same strict parser the app uses, checks that each listed
// file exists with the declared size and SHA-512, and writes SHA256SUMS.txt for all assets.
// Usage: node scripts/release/verify-assets.js <directory> <version>
import { createHash } from 'node:crypto';
import { createReadStream, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseManifest } from '../../src/updater.js';

const digest = async (path, algorithm, encoding) => {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest(encoding);
};
export const releaseAsset = name => /^(Weft-.+\.(exe|dmg|zip|AppImage|deb|blockmap)|latest(-mac|-linux)?\.yml)$/.test(name);

export async function verifyReleaseAssets(directory, version) {
  const names = readdirSync(directory).filter(releaseAsset).sort();
  const problems = [];
  const manifests = names.filter(name => name.endsWith('.yml'));
  if (!manifests.length) problems.push('No latest*.yml update manifest found');
  for (const name of manifests) {
    let manifest;
    try { manifest = parseManifest(readFileSync(join(directory, name), 'utf8')); } catch (error) { problems.push(`${name}: ${error.message}`); continue; }
    if (manifest.version !== version) problems.push(`${name}: version ${manifest.version} does not match ${version}`);
    for (const file of manifest.files) {
      const path = join(directory, file.url);
      try {
        if (statSync(path).size !== file.size) problems.push(`${name}: ${file.url} size differs`);
        else if (await digest(path, 'sha512', 'base64') !== file.sha512) problems.push(`${name}: ${file.url} SHA-512 differs`);
      } catch { problems.push(`${name}: ${file.url} is missing`); }
    }
  }
  const sums = [];
  for (const name of names) sums.push(`${await digest(join(directory, name), 'sha256', 'hex')}  ${name}`);
  return { problems, names, sums: `${sums.join('\n')}\n` };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [directory, version] = process.argv.slice(2);
  if (!directory || !version) { console.error('Usage: verify-assets.js <directory> <version>'); process.exit(2); }
  const { problems, names, sums } = await verifyReleaseAssets(directory, version);
  if (problems.length) {
    for (const problem of problems) console.error(`::error::${problem}`);
    process.exit(1);
  }
  writeFileSync(join(directory, 'SHA256SUMS.txt'), sums);
  console.log(`Verified ${names.length} release assets; wrote SHA256SUMS.txt`);
}
