#!/usr/bin/env node
// Maintainer tooling for a file-based Weft community list. Works on a plain directory
// (keep it in any git repository): list.json holds governance state, published/ holds
// signed releases that subscribers fetch from any URL. No network, no hosted service.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateKeyPair, keyIdOf } from '../src/list-signing.js';
import { verifyRelease } from '../src/list-format.js';
import { addRole, appealDispute, correctEntry, createList, decideAppeal, disputeEntry, listStatus, markStale, publishRelease, removeRole, retireEntry, reviewEntry, rotateKey, setPolicy, submitEntry } from '../src/list-governance.js';

const USAGE = `Usage: node scripts/community-list.js <command> [--dir <list directory>] [options]

Setup:      keygen --out <dir>            init --id <slug> --name <text> --maintainer <member> --public-key <file|base64> [--min-reviewers 2]
Roles:      role-add|role-remove --as <maintainer> --member <m> --role maintainer|reviewer|submitter
            policy --as <maintainer> [--min-reviewers n] [--stale-after-days n] [--max-submissions-per-day n] [--max-pending-per-submitter n]
Workflow:   submit --as <m> (--entry-file f.json | --hostname h [--include-subdomains false] [--path /p] | --entity-name n [--entity-domains a,b])
                   --claim <text> --claim-type factual|opinion --category <c> [--recommended label|warn|block] [--source-url u --source-title t --source-retrieved iso]
            review --as <reviewer> --entry <id> --decision approve|reject [--note t]
            correct --as <m> --entry <id> --note <t> (--changes-file f.json | --claim t)
            dispute --as <member> --entry <id> --reason <t> [--reporter handle]
            appeal --as <m> --entry <id> --dispute <dN> --reason <t>
            decide-appeal --as <maintainer> --entry <id> --dispute <dN> --outcome grant|deny [--note t]
            retire --as <maintainer> --entry <id> [--note t]
            stale --as <m>                 mark accepted entries whose review date has passed
Release:    status                          publish --key <private.pem> [--expires-in-days n]
            rotate-key --key <old.pem> --next-key <new.pem> --statement <text>
            verify --file <signed.json> --public-key <file|base64> [--list-id id]
Add --now <ISO date> to any command for reproducible history. Member names are attestations
recorded under the signing key; authenticate contributors with your git host.`;

function parse(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`Unexpected argument ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const next = rest[i + 1];
    if (next === undefined || next.startsWith('--')) options[key] = true; else { options[key] = next; i++; }
  }
  return { command, options };
}
const need = (options, key) => { if (options[key] === undefined || options[key] === true) throw new Error(`Missing --${key.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`); return options[key]; };
const num = value => (value === undefined ? undefined : Number(value));
const readKeyArg = value => { const text = existsSync(value) ? readFileSync(value, 'utf8') : value; return text.trim(); };
function writeAtomic(path, text, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, text, mode ? { mode } : undefined);
  renameSync(temp, path);
}
const load = dir => {
  const path = join(dir, 'list.json');
  if (!existsSync(path)) throw new Error(`No list.json in ${dir}; run init first`);
  return JSON.parse(readFileSync(path, 'utf8'));
};
const save = (dir, state) => writeAtomic(join(dir, 'list.json'), JSON.stringify(state, null, 2) + '\n');

/** Run one command; returns a JSON-serialisable result. */
export function run(argv) {
  const { command, options } = parse(argv);
  if (!command || command === 'help' || options.help) return { usage: USAGE };
  const now = options.now ? new Date(options.now) : new Date();
  if (Number.isNaN(now.getTime())) throw new Error('Invalid --now');
  const dir = resolve(options.dir || '.');
  const actor = options.as;
  if (command === 'keygen') {
    const out = resolve(need(options, 'out'));
    const pair = generateKeyPair();
    mkdirSync(out, { recursive: true });
    const privatePath = join(out, 'publisher.key.pem');
    if (existsSync(privatePath)) throw new Error('Refusing to overwrite an existing publisher.key.pem');
    writeAtomic(privatePath, pair.privateKeyPem, 0o600);
    chmodSync(privatePath, 0o600);
    writeAtomic(join(out, 'publisher.pub'), pair.publicKey + '\n');
    return { keyId: pair.keyId, publicKey: pair.publicKey, privateKeyFile: privatePath, publicKeyFile: join(out, 'publisher.pub'), note: 'Keep the private key out of the repository. Share the public key and key ID out of band so subscribers can pin it.' };
  }
  if (command === 'init') {
    if (existsSync(join(dir, 'list.json'))) throw new Error('list.json already exists');
    const publicKey = readKeyArg(need(options, 'publicKey'));
    const state = createList({ listId: need(options, 'id'), name: need(options, 'name'), description: options.description === true ? '' : options.description, keyId: keyIdOf(publicKey), maintainer: need(options, 'maintainer'), minReviewers: num(options.minReviewers) ?? 2, now });
    save(dir, state);
    return { dir, listId: state.listId, keyId: state.keyId, minReviewers: state.governance.minReviewers };
  }
  if (command === 'verify') {
    const file = resolve(need(options, 'file'));
    const publicKey = readKeyArg(need(options, 'publicKey'));
    const release = verifyRelease(readFileSync(file, 'utf8'), { pinned: { keyId: keyIdOf(publicKey), publicKey }, listId: options.listId });
    return { valid: true, listId: release.payload.listId, sequence: release.payload.sequence, issuedAt: release.payload.issuedAt, payloadSha256: release.payloadSha256, bytes: release.bytes, entries: release.payload.entries.length, rotation: release.rotation };
  }
  const state = load(dir);
  if (command === 'status') return listStatus(state, now);
  if (!actor && !['publish', 'rotate-key'].includes(command)) throw new Error('Missing --as <member>');
  const result = {};
  let next;
  switch (command) {
    case 'role-add': next = addRole(state, { actor, member: need(options, 'member'), role: need(options, 'role'), now }); break;
    case 'role-remove': next = removeRole(state, { actor, member: need(options, 'member'), role: need(options, 'role') }); break;
    case 'policy': next = setPolicy(state, { actor, minReviewers: num(options.minReviewers), staleAfterDays: num(options.staleAfterDays),
      limits: Object.fromEntries(Object.entries({ maxSubmissionsPerDay: num(options.maxSubmissionsPerDay), maxPendingPerSubmitter: num(options.maxPendingPerSubmitter), maxOpenDisputesPerMember: num(options.maxOpenDisputesPerMember) }).filter(([, v]) => v !== undefined)) }); break;
    case 'submit': {
      let fields;
      if (options.entryFile) fields = JSON.parse(readFileSync(resolve(options.entryFile), 'utf8'));
      else {
        const subject = options.entityName
          ? { type: 'entity', name: options.entityName, entityKind: options.entityKind || 'organization', domains: options.entityDomains ? String(options.entityDomains).split(',') : [] }
          : { type: 'domain', hostname: need(options, 'hostname'), includeSubdomains: options.includeSubdomains !== 'false', path: options.path || '/' };
        fields = { subject, claim: need(options, 'claim'), claimType: need(options, 'claimType'), category: need(options, 'category'), recommended: options.recommended || 'label',
          sources: options.sourceUrl ? [{ title: need(options, 'sourceTitle'), url: options.sourceUrl, retrievedAt: options.sourceRetrieved || now.toISOString() }] : [] };
      }
      const submitted = submitEntry(state, { actor, entry: fields, now });
      next = submitted.state; result.entryId = submitted.entry.id; break;
    }
    case 'review': { const out = reviewEntry(state, { actor, entryId: need(options, 'entry'), decision: need(options, 'decision'), note: options.note === true ? '' : options.note, now }); next = out.state; result.status = out.entry.status; result.transition = out.transition; break; }
    case 'correct': {
      const changes = options.changesFile ? JSON.parse(readFileSync(resolve(options.changesFile), 'utf8')) : (options.claim ? { claim: options.claim } : {});
      const out = correctEntry(state, { actor, entryId: need(options, 'entry'), changes, note: need(options, 'note'), now });
      next = out.state; result.status = out.entry.status; result.revision = out.entry.revision; break;
    }
    case 'dispute': { const out = disputeEntry(state, { actor, entryId: need(options, 'entry'), reason: need(options, 'reason'), reporter: options.reporter === true ? '' : options.reporter, now }); next = out.state; result.status = out.entry.status; result.disputeId = out.entry.disputes.at(-1).id; break; }
    case 'appeal': { const out = appealDispute(state, { actor, entryId: need(options, 'entry'), disputeId: need(options, 'dispute'), reason: need(options, 'reason'), now }); next = out.state; result.status = out.entry.status; break; }
    case 'decide-appeal': { const out = decideAppeal(state, { actor, entryId: need(options, 'entry'), disputeId: need(options, 'dispute'), outcome: need(options, 'outcome'), note: options.note === true ? '' : options.note, now }); next = out.state; result.status = out.entry.status; break; }
    case 'retire': { const out = retireEntry(state, { actor, entryId: need(options, 'entry'), note: options.note === true ? '' : options.note, now }); next = out.state; result.status = out.entry.status; break; }
    case 'stale': { const out = markStale(state, { actor, now }); next = out.state; result.marked = out.marked; break; }
    case 'publish':
    case 'rotate-key': {
      const keyPem = readFileSync(resolve(need(options, 'key')), 'utf8');
      const release = command === 'publish'
        ? publishRelease(state, { privateKeyPem: keyPem, now, expiresInDays: num(options.expiresInDays) })
        : rotateKey(state, { currentPrivateKeyPem: keyPem, nextPrivateKeyPem: readFileSync(resolve(need(options, 'nextKey')), 'utf8'), statement: need(options, 'statement'), now });
      const published = join(dir, 'published');
      writeAtomic(join(published, `list-${String(release.payload.sequence).padStart(4, '0')}.signed.json`), release.envelope);
      writeAtomic(join(published, 'latest.signed.json'), release.envelope);
      next = release.state;
      Object.assign(result, { sequence: release.payload.sequence, payloadSha256: release.payloadSha256, bytes: Buffer.byteLength(release.envelope), file: join(published, 'latest.signed.json'), keyId: release.state.keyId, rotation: Boolean(release.payload.keyRotation) });
      break;
    }
    default: throw new Error(`Unknown command ${command}\n\n${USAGE}`);
  }
  save(dir, next);
  return { ok: true, command, ...result };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(run(process.argv.slice(2)), null, 2)); }
  catch (error) { console.error(error.message); process.exit(1); }
}
