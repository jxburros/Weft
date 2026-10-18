#!/usr/bin/env node
// Pipe an RFC822 message from a local forwarding relay. No mail-account credentials.
import { createHash } from 'node:crypto';
import { createClient } from '../src/client.js';
import { resultExitCode } from '../src/commands.js';
import { emailMaterial } from '../src/mailbox.js';
const workspaceId = process.argv[2];
if (!workspaceId) throw new Error('Usage: node scripts/forward-email.mjs WORKSPACE_ID < message.eml');
const chunks = []; let size = 0;
for await (const chunk of process.stdin) { size += chunk.length; if (size > 450000) throw new Error('Email exceeds 450 KB'); chunks.push(chunk); }
const raw = Buffer.concat(chunks).toString('utf8');
const result = await createClient().executeOutcome('materials.create', { ...emailMaterial(raw, { workspaceId }), requestId: `email:${createHash('sha256').update(workspaceId + '\n' + raw).digest('hex')}` });
console.log(JSON.stringify({ status: result.status, id: result.result?.id, ...(result.error ? { error: result.error } : {}) }));
process.exitCode = resultExitCode(result);
