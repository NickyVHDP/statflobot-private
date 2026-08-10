// Customer-facing release notes live with the app so every signed desktop
// build can explain its own changes, even before the network is available.
// Add an entry only when a release changes something a customer can see or use.
export const RELEASE_NOTES = {
  '1.5.56': {
    customerFacing: true,
    title: 'Safer, more reliable full-list runs',
    intro: 'StatfloBot is more careful when deciding whether to send, skip a phone number, or record a DNC.',
    changes: [
      {
        audience: 'paid',
        title: 'Safer phone-line decisions',
        description: 'When one number cannot be messaged, StatfloBot checks the next available number on the account. An unclear disabled Send button now causes a safe skip instead of an incorrect DNC.',
      },
      {
        audience: 'paid',
        title: 'Better reliability diagnostics',
        description: 'Failed runs now carry clearer categories so support can identify recurring sending, phone-line, DNC, login, or browser issues and fix them faster.',
      },
    ],
    action: 'No setup is needed. Continue running your lists normally and use the failed-run report prompt whenever an issue appears.',
  },
  '1.5.55': {
    customerFacing: true,
    title: 'Quicker failed-run reports',
    intro: 'Sending a failed run to support now takes less typing.',
    changes: [
      {
        audience: 'everyone',
        title: 'Your contact details are ready',
        description: 'Support reports automatically fill your saved account name and verified email address. You can still edit either field before sending.',
      },
      {
        audience: 'paid',
        title: 'Failed-run reports stay fast and private',
        description: 'The report opens with your contact details and issue summary ready, while technical diagnostics remain hidden and attach securely when sent.',
      },
    ],
    action: 'No setup is needed. Keep your account name current and StatfloBot will fill it for you.',
  },
  '1.5.54': {
    customerFacing: true,
    title: 'Faster help when a run fails',
    intro: 'This update makes it easier to report a failed run while keeping technical diagnostics private.',
    changes: [
      {
        audience: 'everyone',
        title: 'A helpful prompt after failed runs',
        description: 'If the latest run fails or contains failed clients, StatfloBot asks whether you would like to send it to support.',
      },
      {
        audience: 'paid',
        title: 'The correct run is attached securely',
        description: 'Choose Review & Send Report to open a pre-filled report. The latest failed run details are attached privately when you send it.',
      },
    ],
    action: 'No setup is needed. The prompt appears automatically only when a run needs attention.',
  },
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
