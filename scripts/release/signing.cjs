// One signing decision for packaging and for the release label (#123). electron-builder.config.cjs
// enables signing from these conditions, and the release workflow labels a platform "signed" only
// when the same condition holds, so a partial set of secrets yields an unsigned build that is also
// labelled unsigned instead of a confusing signature-verification failure.
// CLI: node scripts/release/signing.cjs <windows-x64|macos|linux-x64>   prints true or false.

/** Azure Trusted Signing needs the endpoint, account, certificate profile and publisher name. */
const azureSigning = env => Boolean(env.AZURE_SIGNING_ENDPOINT && env.AZURE_SIGNING_ACCOUNT && env.AZURE_SIGNING_PROFILE && env.WEFT_WINDOWS_PUBLISHER);
/** Notarization needs the App Store Connect API key file, its id and issuer. */
const macNotarization = env => Boolean(env.APPLE_API_KEY && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);

/**
 * Whether a platform's build will be signed. On Windows that is Azure Trusted Signing or a PFX
 * certificate (WIN_CSC_LINK). On macOS a Developer ID certificate plus the notarization key are
 * required, because a signed but unnotarized app still fails Gatekeeper; APPLE_API_KEY_P8 stands in
 * for the key file the workflow writes before building. Linux packages are never signed.
 */
function signingDecision(platform, env) {
  if (platform.startsWith('windows')) return azureSigning(env) || Boolean(env.WIN_CSC_LINK);
  if (platform.startsWith('mac')) return Boolean((env.MAC_CSC_LINK || env.CSC_LINK) && (env.APPLE_API_KEY || env.APPLE_API_KEY_P8) && env.APPLE_API_KEY_ID && env.APPLE_API_ISSUER);
  return false;
}

module.exports = { azureSigning, macNotarization, signingDecision };

if (require.main === module) {
  const platform = process.argv[2];
  if (!platform) { console.error('Usage: signing.cjs <windows-x64|macos|linux-x64>'); process.exit(2); }
  console.log(String(signingDecision(platform, process.env)));
}
