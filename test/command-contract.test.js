import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { commands } from '../src/commands.js';
import { mcpTools } from '../src/mcp.js';
import { commandReference } from '../scripts/command-reference.js';

test('generated command reference matches the catalog', () => {
  assert.equal(readFileSync(new URL('../docs/COMMANDS.md', import.meta.url), 'utf8'), commandReference());
});

test('all command fields have descriptions and typed schemas', () => {
  function check(schema, path) {
    for (const [key, field] of Object.entries(schema.properties || {})) {
      assert.ok(field.description?.length, `${path}.${key} needs a description`);
      assert.ok(field.type || field.anyOf || field.oneOf || key === 'data', `${path}.${key} needs a type`);
      check(field, `${path}.${key}`);
    }
    for (const variant of [...(schema.anyOf || []), ...(schema.oneOf || [])]) check(variant, path);
    if (schema.items) check(schema.items, `${path}[]`);
  }
  for (const [name, command] of Object.entries(commands)) check(command.inputSchema, name);
});

test('MCP surface fits reviewed size ratchet and every action appears once', () => {
  const baseline = JSON.parse(readFileSync(new URL('./mcp-surface-baseline.json', import.meta.url)));
  assert.ok(mcpTools.length <= baseline.toolCount);
  assert.ok(JSON.stringify(mcpTools).length <= baseline.totalCharacters, 'Review tool growth and update the baseline deliberately');
  for (const tool of mcpTools) {
    assert.ok(JSON.stringify(tool).length <= baseline.maxToolCharacters, tool.name);
    assert.ok(JSON.stringify(tool).length <= baseline.tools[tool.name], `${tool.name} grew`);
  }
  assert.deepEqual(mcpTools.flatMap(tool => tool.inputSchema.properties.action?.enum || []).sort(), Object.keys(commands).sort());
});
