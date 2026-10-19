// Packaging configuration. See docs/RELEASING.md for the procedure, trust roots and
// signing setup. Signing is enabled only when the corresponding secrets are present;
// otherwise the release workflow produces builds labelled "unsigned".
const env = process.env;
// The release workflow labels builds from the same conditions (scripts/release/signing.cjs).
const { azureSigning, macNotarization } = require('./scripts/release/signing.cjs');
const azure = azureSigning(env);
const icon = 'assets/logo/icons/app-icon-plum-1024.png';
const fuses = require('./scripts/release/fuses.cjs');

/** @type {import('electron-builder').Configuration} */
module.exports = {
  appId: 'io.github.jxburros.weft',
  productName: 'Weft',
  copyright: 'Copyright (c) Weft contributors. MIT License.',
  directories: { output: 'dist', buildResources: 'packaging' },
  // Only runtime code and brand assets ship; tests, docs, fixtures and sources stay out.
  files: [
    'package.json', 'LICENSE', 'THIRD-PARTY-NOTICES.md', 'licenses/**/*', 'src/**/*',
    'assets/tokens.css', 'assets/fonts/**/*',
    'assets/logo/svg/mark-full-color.svg', 'assets/logo/svg/horizontal-full-color.svg',
    'assets/logo/icons/favicon.ico', 'assets/logo/icons/app-icon-plum-512.png',
    'assets/logo/dark/mark-dark.svg', 'assets/logo/dark/horizontal-dark.svg',
    'assets/graphics/motion/**/*',
  ],
  asar: true,
  // No NODE_OPTIONS, no --inspect, app code only from a verified app.asar (#117). Checked by
  // scripts/release/check-fuses.js; the ad-hoc signature is redone for unsigned macOS builds.
  electronFuses: { ...fuses, resetAdHocDarwinSignature: true },
  // Stable channel only. The updater ignores this provider's URLs and uses the fixed
  // repository in src/updater.js; this entry only makes electron-builder emit latest*.yml.
  publish: [{ provider: 'github', owner: 'jxburros', repo: 'Weft', releaseType: 'draft', channel: 'latest' }],
  generateUpdatesFilesForAllChannels: false,
  artifactName: 'Weft-${version}-${arch}.${ext}',
  win: {
    target: [{ target: 'nsis', arch: ['x64'] }],
    icon,
    ...(azure ? { azureSignOptions: {
      publisherName: env.WEFT_WINDOWS_PUBLISHER, endpoint: env.AZURE_SIGNING_ENDPOINT,
      codeSigningAccountName: env.AZURE_SIGNING_ACCOUNT, certificateProfileName: env.AZURE_SIGNING_PROFILE,
    } } : env.WEFT_WINDOWS_PUBLISHER ? { signtoolOptions: { publisherName: env.WEFT_WINDOWS_PUBLISHER } } : {}),
  },
  nsis: {
    oneClick: false,
    perMachine: false,
    selectPerMachineByDefault: false,
    allowElevation: true,
    allowToChangeInstallationDirectory: true,
    deleteAppDataOnUninstall: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
    shortcutName: 'Weft',
    uninstallDisplayName: 'Weft ${version}',
    artifactName: 'Weft-Setup-${version}-${arch}.${ext}',
    installerSidebar: 'installer-sidebar.bmp',
    uninstallerSidebar: 'uninstaller-sidebar.bmp',
    installerHeader: 'installer-header.bmp',
    include: 'packaging/installer.nsh',
  },
  mac: {
    target: [{ target: 'dmg', arch: ['arm64', 'x64'] }, { target: 'zip', arch: ['arm64', 'x64'] }],
    icon,
    category: 'public.app-category.productivity',
    hardenedRuntime: true,
    gatekeeperAssess: false,
    // Notarization runs only when Apple credentials are present in the environment.
    notarize: macNotarization(env),
  },
  linux: {
    target: [{ target: 'AppImage', arch: ['x64'] }, { target: 'deb', arch: ['x64'] }],
    icon,
    category: 'Network',
    executableName: 'weft',
    synopsis: 'Local workspace browser for human and agent collaboration',
    maintainer: 'Weft contributors <https://github.com/jxburros/Weft>',
  },
  deb: { packageCategory: 'web' },
};
