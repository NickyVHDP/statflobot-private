const bundledVersion = typeof __APP_VERSION__ !== 'undefined' ? __APP_VERSION__ : 'current';

export function guideStorageKey(id, version = bundledVersion) {
  return `statflobot_guide_${id}_seen_v${version || 'current'}`;
}

export function shouldShowContextualGuide(id, version = bundledVersion) {
  try { return localStorage.getItem(guideStorageKey(id, version)) !== '1'; }
  catch { return true; }
}

export function markContextualGuideSeen(id, version = bundledVersion) {
  try { localStorage.setItem(guideStorageKey(id, version), '1'); } catch {}
}

export const REFERRAL_GUIDE = {
  id: 'referral-rewards',
  eyebrow: 'Lifetime benefit',
  title: 'Referral Rewards are completely optional',
  intro: 'If StatfloBot could genuinely help another rep, you can share your code and may earn a reward when their eligible Lifetime purchase qualifies.',
  points: [
    'You never need to refer anyone to keep your Lifetime access or any included feature.',
    'The new customer enters your code before purchasing Lifetime. Applying a code without completing payment earns nothing.',
    'A paid referral clears for 30 days before it can be deposited to your connected bank account.',
    'Your Rewards Hub keeps the buyer private while showing the status and value of each referral.',
  ],
  note: 'Share only with people you believe may benefit. There is no pressure or referral requirement.',
};

export const LIFETIME_GUIDE = {
  id: 'lifetime-access',
  eyebrow: 'Your plan',
  title: 'What Lifetime means',
  intro: 'Lifetime is a one-time StatfloBot purchase with no monthly renewal.',
  points: [
    'Your StatfloBot access remains active without a recurring subscription payment.',
    'Future StatfloBot app updates are included.',
    'Everyone Mode and the optional Referral Rewards program are included.',
    'Normal account security, device limits, and the StatfloBot Terms of Service still apply.',
  ],
  note: 'Lifetime purchases are final and non-refundable except where required by law.',
};

export function getEveryoneModeGuide(mode) {
  const isFirstAttempt = mode === 'first';
  return {
    id: 'everyone-mode',
    eyebrow: 'Run safety',
    title: 'Before you use Everyone Mode',
    intro: 'Everyone Mode can send to every eligible SMS line on each client instead of stopping after one line.',
    points: [
      isFirstAttempt
        ? 'For 1st Attempt lists, StatfloBot checks each enabled SMS line on the client.'
        : 'For 2nd and 3rd Attempt lists, StatfloBot tries the direct composer first, then checks the remaining SMS lines without intentionally repeating the primary line.',
      'DNC, recently messaged, unavailable, and unsupported lines are skipped when StatfloBot can identify them safely.',
      'If phone-line identity is unclear, StatfloBot restricts the line walk to reduce duplicate-send risk.',
      'Review the selected list, attempt, and message before starting. One client may receive more than one message when multiple lines are eligible.',
    ],
    note: 'Enable this only when you intentionally want to reach every eligible line for each client.',
  };
}
