import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmodSync, createReadStream, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, isAbsolute, join } from 'node:path';
import { z } from 'zod';
import { readJson, writeJsonDurable } from './atomic-json.js';
import { sanitizeUrl } from './workspace.js';

const exitCodes = z.array(z.number().int().min(0).max(255)).min(1).max(20);
export const downloadSafetyCommandDefinitions = {
  'downloads.configureScanner': ['Human configures or removes an optional local command-line scanner run on completed downloads', {
    command: z.string().min(1).max(1000).nullable(), args: z.array(z.string().max(500)).max(20).default([]),
    cleanExitCodes: exitCodes.default([0]), infectedExitCodes: exitCodes.default([1]), timeoutSeconds: z.number().int().min(1).max(600).default(120) }],
  'launches.list': ['List external application/protocol launch requests blocked in this browser run', { workspaceId: z.string().min(1).max(200).optional() }],
  'launches.approve': ['Human authorizes one pending external application launch after reviewing its source page and target', { launchId: z.number().int().positive() }],
  'launches.deny': ['Human dismisses a pending external application launch request', { launchId: z.number().int().positive() }],
};
export const downloadSafetySchemas = Object.fromEntries(Object.entries(downloadSafetyCommandDefinitions).map(([name, [, shape]]) => [name, z.strictObject(shape)]));

// Schemes with a record of remote-code or credential abuse are never launched, even with approval.
export const NEVER_LAUNCH = new Set(['file', 'javascript', 'data', 'vbscript', 'blob', 'filesystem', 'chrome', 'about', 'devtools', 'view-source', 'ms-msdt', 'search-ms', 'search', 'ms-officecmd', 'ms-cxh', 'ms-cxh-full', 'ms-appinstaller', 'ms-settings', 'smb', 'nfs', 'afp', 'jar', 'shell', 'res', 'its', 'mk', 'ms-its', 'hcp', 'ldap', 'ldaps']);
const CATEGORIES = [
  ['installer', /\.(msi|msix|msixbundle|appx|appxbundle|pkg|mpkg|dmg|deb|rpm|apk|aab|ipa|appimage|snap|flatpak|run|msp|mst)$/i],
  ['executable', /\.(exe|com|scr|pif|cpl|dll|sys|app|bin|elf|out|xpi|crx|jar|class|so|dylib|chm|msc|xll|jnlp|appref-ms)$/i],
  ['script', /\.(bat|cmd|ps1|psm1|vbs|vbe|js|jse|mjs|wsf|wsh|hta|sh|bash|zsh|command|tool|py|pyw|pl|rb|php|lnk|url|scf|reg|inf|desktop|applescript|scpt|workflow|wsc|sct|ps1xml|library-ms|settingcontent-ms|iqy|slk)$/i],
  ['archive', /\.(zip|7z|rar|tar|gz|tgz|bz2|tbz|xz|txz|zst|cab|iso|img|vhd|vhdx|lzh|ace|arj|z)$/i],
  ['office-macro-capable', /\.(docm|dotm|xlsm|xltm|xlam|pptm|potm|ppsm|sldm)$/i],
];
export function fileCategory(filename, mimeType = '') {
  for (const [category, pattern] of CATEGORIES) if (pattern.test(filename)) return { category, risky: true };
  if (/x-msdownload|x-msdos-program|x-executable|x-sh|x-apple-diskimage|vnd.microsoft.portable-executable|java-archive/i.test(mimeType)) return { category: 'executable', risky: true };
  if (/zip|x-7z|x-rar|x-tar|gzip/i.test(mimeType)) return { category: 'archive', risky: true };
  return { category: extname(filename) ? 'document-or-media' : 'unknown', risky: false };
}

const run = (execFileImpl, command, args, options) => new Promise(resolve => {
  execFileImpl(command, args, { windowsHide: true, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => resolve({ error, code: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') }));
});

/** Record where a file came from using the platform's own mechanism, then verify it. */
export async function applyOriginMetadata(path, { url, referrer }, { platform = process.platform, execFileImpl = execFile, writeFileImpl = writeFileSync, now = Date.now } = {}) {
  const host = sanitizeUrl(url) || 'about:blank';
  const ref = sanitizeUrl(referrer) || '';
  if (platform === 'win32') {
    try {
      writeFileImpl(`${path}:Zone.Identifier`, `[ZoneTransfer]\r\nZoneId=3\r\n${ref ? `ReferrerUrl=${ref}\r\n` : ''}HostUrl=${host}\r\n`);
      return { status: 'applied', mechanism: 'Mark-of-the-Web (Zone.Identifier, ZoneId=3)' };
    } catch (error) { return { status: 'failed', mechanism: 'Mark-of-the-Web', detail: `NTFS alternate data stream unavailable: ${error.code || error.message}` }; }
  }
  if (platform === 'darwin') {
    const value = `0081;${Math.floor(now() / 1000).toString(16)};Weft;${randomUUID().toUpperCase()}`;
    const result = await run(execFileImpl, '/usr/bin/xattr', ['-w', 'com.apple.quarantine', value, path], { timeout: 10000 });
    return result.error ? { status: 'failed', mechanism: 'com.apple.quarantine', detail: (result.stderr || result.error.message).slice(0, 300) } : { status: 'applied', mechanism: 'com.apple.quarantine' };
  }
  if (platform === 'linux') {
    const results = [await run(execFileImpl, 'setfattr', ['-n', 'user.xdg.origin.url', '-v', host, path], { timeout: 10000 })];
    if (ref) results.push(await run(execFileImpl, 'setfattr', ['-n', 'user.xdg.referrer.url', '-v', ref, path], { timeout: 10000 }));
    const failed = results.find(result => result.error);
    if (!failed) return { status: 'applied', mechanism: 'user.xdg.origin.url extended attribute (freedesktop convention; advisory only)' };
    return { status: failed.error.code === 'ENOENT' ? 'unsupported' : 'failed', mechanism: 'user.xdg.origin.url', detail: failed.error.code === 'ENOENT' ? 'setfattr (attr package) is not installed; Linux has no enforced origin marker.' : (failed.stderr || failed.error.message).slice(0, 300) };
  }
  return { status: 'unsupported', mechanism: null, detail: `No origin metadata mechanism for ${platform}` };
}

export function hashFile(path) {
  return new Promise((resolve, reject) => {
    const digest = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', chunk => digest.update(chunk)).on('end', () => resolve(digest.digest('hex')));
  });
}

/** Optional, explicitly configured scanner. No scanner means "unscanned", never "safe". */
export class DownloadSafety {
  constructor({ path, execFileImpl = execFile } = {}) {
    this.path = path; this.execFile = execFileImpl;
    this.config = path ? readJson(path, { version: 1, scanner: null }) : { version: 1, scanner: null };
  }
  configure(input) {
    const args = downloadSafetySchemas['downloads.configureScanner'].parse(input);
    if (args.command !== null) {
      if (!isAbsolute(args.command)) throw new Error('Scanner command must be an absolute path');
      if (!existsSync(args.command) || !statSync(args.command).isFile()) throw new Error('Scanner command was not found');
      if (args.cleanExitCodes.some(code => args.infectedExitCodes.includes(code))) throw new Error('Clean and infected exit codes must differ');
    }
    this.config = { version: 1, scanner: args.command === null ? null : { command: args.command, args: args.args, cleanExitCodes: args.cleanExitCodes, infectedExitCodes: args.infectedExitCodes, timeoutSeconds: args.timeoutSeconds, configuredAt: new Date().toISOString() } };
    if (this.path) writeJsonDurable(this.path, this.config);
    return this.status();
  }
  status() {
    return { scanner: this.config.scanner ? { command: this.config.scanner.command, args: this.config.scanner.args, cleanExitCodes: this.config.scanner.cleanExitCodes, infectedExitCodes: this.config.scanner.infectedExitCodes, timeoutSeconds: this.config.scanner.timeoutSeconds } : null,
      statuses: { unscanned: 'No scanner is configured; the file was not checked.', scanning: 'Scanner running.', clean: 'The configured scanner reported no detection. This is not a guarantee of safety.', infected: 'The scanner reported a detection; the file was moved to quarantine.', 'known-malicious': 'The file hash matches installed threat intelligence; the file was moved to quarantine.', 'scan-failed': 'The scanner failed or timed out; safety is unknown.' } };
  }
  async scan(path) {
    const scanner = this.config.scanner;
    if (!scanner) return { scanStatus: 'unscanned', scanDetail: 'No scanner configured' };
    const result = await run(this.execFile, scanner.command, [...scanner.args, path], { timeout: scanner.timeoutSeconds * 1000 });
    const detail = `${basename(scanner.command)} exit ${result.code ?? 'error'}${result.stdout ? `: ${result.stdout.trim().slice(0, 300)}` : ''}`;
    if (result.code !== null && scanner.infectedExitCodes.includes(result.code)) return { scanStatus: 'infected', scanDetail: detail };
    if (result.code !== null && scanner.cleanExitCodes.includes(result.code)) return { scanStatus: 'clean', scanDetail: detail };
    return { scanStatus: 'scan-failed', scanDetail: result.error?.killed ? 'Scanner timed out' : detail };
  }
  quarantine(path, directory) {
    const target = join(directory, 'quarantine');
    mkdirSync(target, { recursive: true, mode: 0o700 });
    const destination = join(target, `${basename(path)}.quarantined`);
    renameSync(path, destination);
    try { chmodSync(destination, 0o400); } catch { /* Best effort on platforms without POSIX modes. */ }
    return destination;
  }
}
