// Electron fuses for packaged builds (#117), shared by electron-builder.config.cjs and
// scripts/release/check-fuses.js so the build and its check cannot disagree.
//
// RunAsNode stays on: the plugin sandbox (src/plugins/sandbox.js) and the credential
// broker (src/credentials.js) run as child processes of the Electron binary with
// ELECTRON_RUN_AS_NODE and Node's permission-model flags. Moving them to
// utilityProcess would change how those boundaries are enforced (stdin protocol,
// --permission flags), so it is a separate decision; see docs/RELEASING.md.
// Both children are started with an explicit, minimal environment, so the fuses
// below still stop NODE_OPTIONS and inspector flags from reaching any process.
module.exports = Object.freeze({
  runAsNode: true,
  enableNodeOptionsEnvironmentVariable: false,
  enableNodeCliInspectArguments: false,
  // Verified on macOS and Windows (electron-builder embeds the asar hash); Linux has no validation.
  enableEmbeddedAsarIntegrityValidation: true,
  onlyLoadAppFromAsar: true,
});
