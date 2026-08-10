// Customer-facing release notes live with the app so every signed desktop
// build can explain its own changes, even before the network is available.
// Add an entry only when a release changes something a customer can see or use.
export const RELEASE_NOTES = {
  '1.5.53': {
    customerFacing: true,
    title: 'A clearer, more private StatfloBot',
    intro: 'This update improves how new features are explained and keeps support diagnostics out of customer-facing screens.',
    changes: [
      {
        audience: 'everyone',
        title: 'What’s New after meaningful updates',
        description: 'When an update adds or changes something you can use, StatfloBot will show a short, plain-language summary once after the update.',
      },
      {
        audience: 'paid',
        title: 'Private support diagnostics',
        description: 'Run History shows useful results and counts, while technical logs stay private. Sending a report securely attaches the details support needs.',
      },
      {
        audience: 'new',
        title: 'Guidance that matches your stage',
        description: 'New-account guidance and paying-customer changes are labeled clearly, so you can quickly see what applies to you.',
      },
    ],
    action: 'No action is required. Continue using StatfloBot normally.',
  },
};

export function getReleaseNotes(version) {
  const release = RELEASE_NOTES[String(version ?? '')];
  return release?.customerFacing ? { version: String(version), ...release } : null;
}

export function releaseNotesStorageKey(version) {
  return `statflobot_whats_new_seen_v${version}`;
}

export function shouldShowReleaseNotes(version) {
  const release = getReleaseNotes(version);
  if (!release) return false;
  try { return localStorage.getItem(releaseNotesStorageKey(version)) !== '1'; }
  catch { return true; }
}

export function markReleaseNotesSeen(version) {
  try { localStorage.setItem(releaseNotesStorageKey(version), '1'); } catch {}
}
