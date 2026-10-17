// node:sqlite is built into Node 22.13+ and Electron's Node. Its load-time
// ExperimentalWarning is expected; every other warning is passed through.
const emitWarning = process.emitWarning;
process.emitWarning = function (warning, ...rest) {
  const type = typeof rest[0] === 'string' ? rest[0] : rest[0]?.type;
  if (type === 'ExperimentalWarning' && /SQLite/i.test(String(warning?.message ?? warning))) return;
  return emitWarning.call(this, warning, ...rest);
};
let sqlite;
try { sqlite = await import('node:sqlite'); } finally { process.emitWarning = emitWarning; }
export const { DatabaseSync } = sqlite;
