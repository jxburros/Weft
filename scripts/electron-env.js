// Environment for launching the real Electron app (tests, benchmarks, packaged smoke tests).
// Electron runs as plain Node whenever ELECTRON_RUN_AS_NODE is set in its environment. On Windows a
// variable with an empty value still counts as set, so blanking it ('') starts Node, which rejects
// Chromium flags with "bad option: --no-sandbox". The key is removed instead, in every letter case
// because Windows environment names are case-insensitive.
export function electronEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const key of Object.keys(env)) if (key.toUpperCase() === 'ELECTRON_RUN_AS_NODE') delete env[key];
  return env;
}
