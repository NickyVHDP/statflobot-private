/**
 * afterSign hook for electron-builder.
 * Notarizes the macOS app bundle with Apple's notary service.
 *
 * Required env vars:
 *   APPLE_ID                  — Apple ID email used for notarization
 *   APPLE_APP_SPECIFIC_PASSWORD — app-specific password for that Apple ID
 *   APPLE_TEAM_ID             — 10-char Apple Developer Team ID
 *
 * Code signing env vars (read by electron-builder automatically):
 *   CSC_LINK                  — base64-encoded .p12 certificate
 *   CSC_KEY_PASSWORD          — password for the .p12
 */

const { notarize } = require('@electron/notarize');
const path = require('path');

module.exports = async function afterSign(context) {
  const { electronPlatformName, appOutDir } = context;
  if (electronPlatformName !== 'darwin') return;

  const { APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID } = process.env;
  if (!APPLE_ID || !APPLE_APP_SPECIFIC_PASSWORD || !APPLE_TEAM_ID) {
    console.warn('[notarize] Skipping — APPLE_ID / APPLE_APP_SPECIFIC_PASSWORD / APPLE_TEAM_ID not set');
    return;
  }

  const appName = context.packager.appInfo.productFilename;
  const appPath = path.join(appOutDir, `${appName}.app`);

  console.log(`[notarize] Submitting ${appPath} to Apple notary service…`);

  await notarize({
    tool: 'notarytool',
    appPath,
    appleId: APPLE_ID,
    appleIdPassword: APPLE_APP_SPECIFIC_PASSWORD,
    teamId: APPLE_TEAM_ID,
  });

  console.log('[notarize] Notarization complete.');
};
