// Customer-facing release notes live with the app so every signed desktop
// build can explain its own changes, even before the network is available.
// Add an entry only when a release changes something a customer can see or use.
export const RELEASE_NOTES = {
  '1.5.67': {
    customerFacing: true,
    audience: 'lifetime',
    title: 'Clear guidance, right when you need it',
    intro: 'Lifetime members now get concise, plain-language help for Lifetime access, optional Referral Rewards, and Everyone Mode.',
    changes: [
      {
        title: 'Referral Rewards are clearly optional',
        description: 'Your Rewards Hub now explains that sharing is always your choice, may help another rep, and is never required to keep Lifetime access or features.',
      },
      {
        title: 'A safer first step into Everyone Mode',
        description: 'The first time you enable Everyone Mode in this version, StatfloBot explains how it reaches eligible lines, what it skips, and when to use it.',
      },
      {
        title: 'Lifetime explained in one place',
        description: 'Account → Billing now includes a quick explanation of your one-time plan, included updates, and the features that come with it.',
      },
    ],
    action: 'No setup is required. Open Account for Lifetime and Referral Rewards help, or use “How Everyone Mode works” beside the run control.',
  },
  '1.5.66': {
    customerFacing: true,
    title: 'Referral rewards can arrive automatically',
    intro: 'Lifetime members with a connected payout account can now receive eligible referral rewards by automatic bank deposit after the 30-day qualification period.',
    changes: [
      {
        title: 'Automatic bank deposits',
        description: 'Once an eligible reward is ready and your bank connection is active, StatfloBot checks it daily and sends it automatically when program funds are available.',
      },
      {
        title: 'Clear status in your Rewards Hub',
        description: 'Account → Referral Rewards shows your reward balance, bank connection, qualification progress, and payout status in one place.',
      },
    ],
    action: 'Lifetime members can open Account → Referral Rewards to connect a bank or review their status. No action is needed if your bank is already connected.',
  },
  '1.5.63': {
    customerFacing: true,
    title: 'Referral rewards are easier to find',
    intro: 'Lifetime members can find their Rewards Hub in Account, while the owner now has a clear referral overview in the app’s Admin tab.',
    changes: [
      {
        title: 'Lifetime Rewards Hub',
        description: 'Lifetime members can create and copy their code, track tier progress, and follow each referral through its private status timeline from Account → Referral Rewards.',
      },
      {
        title: 'Clearer program information',
        description: 'The StatfloBot website now explains who can participate, how tier progress works, and why rewards pass through qualification and owner review.',
      },
    ],
    action: 'Lifetime members can open Account → Referral Rewards. Owner accounts can review program-wide activity from Admin → Referral Program.',
  },
  '1.5.62': {
    customerFacing: true,
    title: 'Introducing Referral Rewards',
    intro: 'Lifetime members can now share StatfloBot and track referral rewards from one private Rewards Hub.',
    changes: [
      {
        title: 'Your referral code and progress',
        description: 'Open Account to copy your personal code, see qualified referrals, and follow your progress toward higher reward tiers.',
      },
      {
        title: 'Clear reward status',
        description: 'See when a code is applied, a purchase is clearing, a reward is available, or an approved payout is in transit or complete.',
      },
      {
        title: 'Private and owner reviewed',
        description: 'Buyer details stay private, and every payout requires manual StatfloBot owner approval before anything can be sent.',
      },
    ],
    action: 'Lifetime members can open Account → Referral Rewards to get started. No action is needed for monthly members.',
  },
  // Silent wording correction: support notices remain account-private while
  // making clear that the underlying software fix ships to every user.
  '1.5.61': {
    customerFacing: false,
    title: 'Support notice wording correction',
    changes: [],
  },
  '1.5.60': {
    customerFacing: true,
    title: 'Clearer follow-up when you report an issue',
    intro: 'Support reports now stay connected to your account from the moment you send them through resolution.',
    changes: [
      {
        title: 'A reference for every report',
        description: 'After a report is accepted, StatfloBot shows a private reference you can use when following up with support.',
      },
      {
        title: 'Private resolution updates',
        description: 'When your reported issue is fixed, you can receive a clear email and a private notice the next time you open StatfloBot. If the fix requires an update, the notice can take you directly to it.',
      },
    ],
    action: 'No setup is needed. Continue sending failed runs through the report prompt whenever you need help.',
  },
  '1.5.59': {
    customerFacing: false,
    title: 'Unique-client count correction',
    changes: [],
  },
  '1.5.58': {
    customerFacing: true,
    title: 'More reliable full-list runs',
    intro: 'StatfloBot can now recover more safely when Statflo has trouble returning to Smart Lists between customers.',
    changes: [
      {
        title: 'Stronger Smart Lists recovery',
        description: 'If Statflo’s navigation menu becomes unavailable after a message, StatfloBot uses a safe backup route to return to the correct list and continue.',
      },
      {
        title: 'Accurate results after a confirmed send',
        description: 'A successfully sent message stays recorded as sent even if Statflo has a navigation problem afterward. The same customer will not be messaged twice during recovery.',
      },
    ],
    action: 'No setup is needed. Continue running your lists normally.',
  },
  // Silent maintenance release: update cards no longer segment a paid-only
  // product into audience groups. Future meaningful releases still appear.
  '1.5.57': {
    customerFacing: false,
    title: 'Update-note presentation cleanup',
    changes: [],
  },
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

export function getReleaseNotes(version, context = {}) {
  const release = RELEASE_NOTES[String(version ?? '')];
  if (release?.audience === 'lifetime' && !context.isLifetime) return null;
  return release?.customerFacing ? { version: String(version), ...release } : null;
}

export function releaseNotesStorageKey(version) {
  return `statflobot_whats_new_seen_v${version}`;
}

export function shouldShowReleaseNotes(version, context = {}) {
  const release = getReleaseNotes(version, context);
  if (!release) return false;
  try { return localStorage.getItem(releaseNotesStorageKey(version)) !== '1'; }
  catch { return true; }
}

export function markReleaseNotesSeen(version) {
  try { localStorage.setItem(releaseNotesStorageKey(version), '1'); } catch {}
}
