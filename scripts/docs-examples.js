import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { validateCommand } from '../src/commands.js';

export function markdownFiles(root) {
  const files = [join(root, 'README.md')];
  for (const folder of ['docs', 'skills']) {
    const walk = path => {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        const child = join(path, entry.name);
        if (entry.isDirectory()) walk(child);
        else if (entry.name.endsWith('.md')) files.push(child);
      }
    };
    walk(join(root, folder));
  }
  return files;
}

// Tokenize documentation only. Nothing is passed to a shell or executed.
function shellWords(line) {
  const words = []; let word = '', quote = '', started = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (quote) {
      if (char === quote) quote = '';
      else if (char === '\\' && quote === '"') word += line[++i] ?? '';
      else word += char;
      started = true;
    } else if (char === '"' || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) { words.push(word); word = ''; started = false; } }
    else if (char === '#' && !started) break;
    else { word += char; started = true; }
  }
  if (quote) throw new Error('Unclosed shell quote');
  if (started) words.push(word);
  return words;
}

export function checkExamples(markdown, source = '<markdown>') {
  const checked = [], skipped = [];
  const fences = /(?:^|\n)([ \t]*```(\w*)[^\n]*\n)([\s\S]*?)\n[ \t]*```/g;
  for (const match of markdown.matchAll(fences)) {
    const language = match[2].toLowerCase();
    if (!['sh', 'shell', 'bash', 'json'].includes(language)) continue;
    const line = markdown.slice(0, match.index).split('\n').length;
    const prefix = markdown.slice(0, match.index).trimEnd();
    const marker = prefix.match(/<!--\s*docs-test:\s*skip\b([^]*?)-->$/);
    if (marker) {
      if (!marker[1].trim()) throw new Error(`${source}:${line}: docs-test skip requires a reason`);
      skipped.push({ source, line, reason: marker[1].trim() }); continue;
    }
    const validate = (command, args) => {
      try { validateCommand(command, args); }
      catch (error) { throw new Error(`${source}:${line}: ${command}: ${error.message}`); }
      checked.push({ source, line, command });
    };
    if (language === 'json') {
      let value;
      try { value = JSON.parse(match[3]); }
      catch (error) { throw new Error(`${source}:${line}: Invalid JSON example: ${error.message}`); }
      // MCP launch configurations and other JSON data are not command requests.
      if (value && !Array.isArray(value) && Object.hasOwn(value, 'command')) validate(value.command, value.args ?? {});
      else if (Array.isArray(value)) for (const item of value) if (item && Object.hasOwn(item, 'command')) validate(item.command, item.args ?? {});
      continue;
    }
    for (const raw of match[3].replace(/\\\r?\n/g, ' ').split('\n')) {
      const text = raw.trim().replace(/^\$\s+/, '');
      if (!/^(?:weft(?:\s|$)|node\s+(?:\.\/)?bin\/weft\.js(?:\s|$)|npm\s+run\s+cli\s+--(?:\s|$))/.test(text)) continue;
      const words = shellWords(text);
      // CLI options are not command arguments: --deadline-ms <ms> or --deadline-ms=<ms>.
      for (let index = 0; index < words.length; index++) {
        const option = /^--deadline-ms(?:=(.*))?$/.exec(words[index]);
        if (!option) continue;
        const value = option[1] ?? words[index + 1];
        if (!/^\d{1,6}$/.test(value ?? '') || Number(value) < 1 || Number(value) > 600000) throw new Error(`${source}:${line}: --deadline-ms needs 1-600000`);
        words.splice(index, option[1] === undefined ? 2 : 1);
        index--;
      }
      const count = words[0] === 'node' ? 2 : words[0] === 'npm' ? 4 : 1;
      const [command = 'help', json, ...extra] = words.slice(count);
      if (extra.length) throw new Error(`${source}:${line}: unsupported shell syntax; use a docs-test skip marker with a reason`);
      if (['commands', 'help', '--help', '-h', 'mcp'].includes(command)) {
        if (json) throw new Error(`${source}:${line}: unexpected arguments to ${command}`);
        checked.push({ source, line, command });
      } else validate(command, json ? JSON.parse(json) : {});
    }
  }
  return { checked, skipped };
}

export function checkRepositoryExamples(root) {
  return markdownFiles(root).map(path => checkExamples(readFileSync(path, 'utf8'), relative(root, path)));
}
