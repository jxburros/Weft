// Append-only transitions: never change a migration after its schema is shipped.
export const CURRENT_SCHEMA_VERSION = 2;
export const transitions = Object.freeze([
  { from: 1, to: 2, migrate(state, kind) { if (kind === 'store') state.history ??= []; return state; } },
]);

export function migrateSchema(input, { kind = 'store', validate = () => {} } = {}) {
  if (!input || !Number.isSafeInteger(input.schemaVersion) || input.schemaVersion < 1 || input.schemaVersion > CURRENT_SCHEMA_VERSION) throw new Error('Unsupported workspace schema; existing state has been preserved');
  const state = structuredClone(input);
  while (state.schemaVersion < CURRENT_SCHEMA_VERSION) {
    const transition = transitions.find(item => item.from === state.schemaVersion);
    if (!transition) throw new Error(`Unsupported migration from schema ${state.schemaVersion}`);
    transition.migrate(state, kind);
    state.schemaVersion = transition.to;
  }
  validate(state);
  return state;
}
