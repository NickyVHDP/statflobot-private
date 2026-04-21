# statflo-ruflo-bot

Playwright-based local automation for Statflo outreach across the **1st Attempt**, **2nd Attempt**, and **3rd Attempt** smart lists.

---

## Table of Contents

1. [Install](#install)
2. [First-time setup](#first-time-setup)
3. [How session saving works](#how-session-saving-works)
4. [Running the bot](#running-the-bot)
   - [Dry run](#dry-run)
   - [Live run](#live-run)
   - [Choosing 1st / 2nd / 3rd Attempt](#choosing-1st--2nd--3rd-attempt)
   - [CLI flags](#cli-flags)
5. [Doctor mode](#doctor-mode)
6. [Adjusting selectors](#adjusting-selectors)
7. [Adjusting message mapping](#adjusting-message-mapping)
8. [Config reference](#config-reference)
9. [Troubleshooting](#troubleshooting)

---

## Install

```bash
# 1. Clone / copy the project
cd statflo-ruflo-bot

# 2. Install Node dependencies
npm install

# 3. Install Playwright's Chromium browser
npm run install-browsers

# 4. Copy the environment config
cp .env.example .env
# Open .env and adjust if needed (defaults work for most setups)
```

---

## First-time setup

1. Copy `.env.example` to `.env`.
2. Leave `HEADLESS=false` (default) so you can see what the browser is doing.
3. Run the bot once — it will detect no saved session and prompt you to log in manually.

---

## How session saving works

The bot uses Playwright's **persistent context** feature. When you first log in, Playwright stores:
- Cookies
- `localStorage`
- `IndexedDB`
- Other browser state

…inside the `./playwright-profile/` folder.

On every subsequent run the bot loads that profile, navigates to
`https://csok.app.us.statflo.com/accounts`, and checks whether you are already logged in. If yes, it skips the login prompt entirely.

**If your session expires:**
- The bot detects the redirect to the login page.
- It prints a clear message in the terminal asking you to log in manually.
- After you log in and the accounts page is loaded, press **ENTER** in the terminal.
- The session is then automatically saved for next time.

> ⚠️ Never share or commit the `playwright-profile/` folder — it contains your login session.

---

## Running the bot

### Dry run

Safe by default — **no messages are sent, no DNC activities are logged**.

```bash
npm run dry
# equivalent: node src/main.js --mode=dry --max=1
```

### Live run

**Real messages will be sent.** The bot will ask you to confirm before starting.

```bash
npm run live
# equivalent: node src/main.js --mode=live
```

### Choosing 1st / 2nd / 3rd Attempt

Run without flags to get the interactive menu:

```bash
npm run start
```

You will be prompted to choose:
- Which smart list (1st / 2nd / 3rd Attempt)
- Mode (dry / live)
- Max clients (1 / 3 / 5 / 10 / all)
- Delay profile (safe / normal / fast)

### CLI flags

Skip menu prompts by passing flags directly:

```bash
# Process 2nd Attempt, dry run, 3 clients, normal delay
node src/main.js --list=2nd --mode=dry --max=3 --delay=normal

# Process 1st Attempt, live, 10 clients, safe delay
node src/main.js --list=1st --mode=live --max=10 --delay=safe

# Full names also work
node src/main.js --list="1st Attempt" --mode=dry
```

| Flag | Values | Default |
|------|--------|---------|
| `--list` | `1st`, `2nd`, `3rd` (or full names) | menu prompt |
| `--mode` | `dry`, `live`, `doctor` | `dry` |
| `--max` | `1`, `3`, `5`, `10`, `all` | `1` |
| `--delay` | `safe`, `normal`, `fast` | `normal` |

---

## Doctor mode

Use this **before your first live run** to check which selectors are working against your real Statflo UI.

```bash
npm run doctor
# equivalent: node src/main.js --mode=doctor
```

Doctor mode will:
1. Open the browser.
2. Prompt you to log in if needed.
3. Check every major selector and print `FOUND` or `NOT FOUND`.
4. Save a screenshot to `./screenshots/doctor-check.png`.
5. Wait for you to press ENTER before closing.

Update any `NOT FOUND` selectors in `src/selectors.js` and re-run doctor until everything is green.

---

## Adjusting selectors

All selectors live in **`src/selectors.js`**.

Each selector is annotated with a confidence level:
- `[CONFIRMED]` — tested, known to work
- `[LIKELY]` — reasonable guess, verify before live use
- `[TODO]` — must be verified before live use

**Workflow to fix a selector:**

1. Run `npm run doctor` to identify broken selectors.
2. Run `npm run start` with `--mode=dry --max=1` — the browser is visible.
3. Open Chrome DevTools (F12) in the Playwright browser window.
4. Use the inspector to find the element.
5. Copy the CSS selector or `aria-label` into `src/selectors.js`.
6. Re-run doctor to confirm.

**Common patterns in Statflo (React SPA):**
- Most interactive elements have `data-testid` attributes — prefer these.
- Buttons often have `aria-label` attributes.
- Playwright's `:text("…")` pseudo-class is very reliable for matching visible text.

---

## Adjusting message mapping

Edit **`src/config.js`**, in the `lists` section:

```js
lists: {
  '1st Attempt': {
    label: '1st Attempt',          // text as shown in Statflo sidebar
    messageIndex: 0,               // 0-based index of premade message
    messageKeyword: null,          // optional keyword to match message by text
    dncEnabled: true,
  },
  '2nd Attempt': {
    label: '2nd Attempt',
    messageIndex: 1,               // second premade message
    messageKeyword: null,
    dncEnabled: true,
  },
  '3rd Attempt': {
    label: '3rd Attempt',
    messageIndex: 2,               // third premade message
    messageKeyword: null,
    dncEnabled: true,
  },
},
```

**To select by keyword instead of index:**

```js
'1st Attempt': {
  messageIndex: 0,
  messageKeyword: 'intro',   // picks the premade message whose text includes "intro"
},
```

If `messageKeyword` is set, the bot searches all visible premade messages for that text first. If it is not found, it falls back to `messageIndex`.

---

## Config reference

| Field | File | Description |
|-------|------|-------------|
| `accountsUrl` | `config.js` | Statflo accounts page URL |
| `headless` | `.env` (`HEADLESS=true/false`) | Show/hide browser |
| `delayProfiles` | `config.js` | Timing ranges per delay profile |
| `maxRetries` | `config.js` | Retries per individual action |
| `maxConsecutiveErrors` | `.env` / `config.js` | Stop run after N consecutive errors |
| `lists[name].label` | `config.js` | Exact smart list label in Statflo |
| `lists[name].messageIndex` | `config.js` | Which premade message to select (0-based) |
| `lists[name].messageKeyword` | `config.js` | Keyword for message selection |
| `lists[name].dncEnabled` | `config.js` | Log DNC activity when all lines unavailable |
| `dncValues.*` | `selectors.js` | Option text for DNC activity dropdowns |

---

## Troubleshooting

### "Smart list not found"
- Run `npm run doctor` and check whether `smartListContainer` and `smartListItem` selectors are `FOUND`.
- The exact label text in `config.lists[name].label` must match what appears in the Statflo sidebar exactly (case-sensitive).

### Session expired on every run
- The `playwright-profile/` directory may be corrupted. Delete it and log in again.
- Some VPNs or SSO configurations force re-authentication frequently.

### "No SMS buttons found"
- Update `SELECTORS.smsButton` in `src/selectors.js`.
- Use `npm run doctor` to verify it against the live client profile page.

### Bot loops on the same client
- This can happen if the smart list does not remove a client after a message is sent.
- Check whether the `returnToListButton` selector is working — the bot may be navigating back to the same view without the client being removed.

### Messages not populating
- The premade message panel may have changed its structure.
- Update `SELECTORS.premadePanel`, `SELECTORS.premadeItem`, and `SELECTORS.chatStarterButton`.
- Run in dry mode first and watch the browser.

### DNC modal won't fill
- Dropdown option text must match exactly. Check `SELECTORS.dncValues` in `src/selectors.js`.
- Try running with `DEBUG=true node src/main.js` for more verbose output.

### Bot is too fast / too slow
- Change the delay profile: `--delay=safe` for slowest, `--delay=fast` for fastest.
- Adjust exact millisecond ranges in `config.delayProfiles` inside `src/config.js`.

---

## Output files

| Path | Contents |
|------|----------|
| `logs/run-<timestamp>.log` | Full structured JSON log for each run |
| `screenshots/*.png` | Screenshots taken on errors and in dry-run mode |
| `playwright-profile/` | Persistent browser session (do not share) |
