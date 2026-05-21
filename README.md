# casinoscraper

Slack bot that automates **Phase 1 — Initial Market Validation** (Decision Gate 1) for new slot releases.

Watches a Slack channel for new-game announcements, checks all four competitor casinos (Shuffle, Stake, Rainbet, Roobet), captures RTP where published, and replies in-thread with a Gate 1 verdict that matches the manual decision table.

## What it does per message

1. Regex-scans the message for an allowlisted provider (Pragmatic Play, Hacksaw Gaming, Nolimit City, Push Gaming, Relax Gaming, Play'n GO, ELK Studios, Print Studios, Big Time Gaming). No LLM call.
2. If a provider is found, fans out to the four competitor checks in parallel.
3. Posts a threaded reply with per-site availability + RTP, then a Gate 1 verdict.

### Per-site mechanics

| Site | Catalog access | RTP | Notes |
|---|---|---|---|
| **Shuffle** | Public flat JSON catalog (5,663 games) | ✅ via `edge` field, derived as `(10000 − edge) / 100` | One unauth HTTP GET, hourly cache |
| **Stake** | GraphQL behind Cloudflare | ✅ scraped from slot detail page | Pre-warmed Playwright context |
| **Rainbet** | Public REST list endpoint | Likely ✅ in payload — verify on first run | Pre-warmed context (Cloudflare on the API host) |
| **Roobet** | Page title at `/casino/game/<slug>` | ❌ not published publicly | Title parse → confirms listed + provider only |

### Gate 1 verdict logic

Mirrors your manual decision table:

- **≥3/4 listed** AND **max RTP variance ≤ 0.5 pp** across publishing sites → ✅ **Proceed to Phase 2**
- **0/4 listed** → ⚠️ **Escalate to Enhanced Due Diligence**
- **RTP variance > 0.5 pp** across any pair that publishes → ❌ **Do NOT proceed** (rejection escalation)
- **1–2 of 4 listed** → ⚠️ **Escalate to Enhanced Due Diligence**

Roobet's listing counts toward the availability threshold but is excluded from RTP alignment (it doesn't publish per-game RTP).

### Sample reply

```
🎰 Sweet Bonanza 1000 (Pragmatic Play)
  ✅ Shuffle — RTP 96.50%
  ✅ Stake — RTP 96.51%
  ✅ Rainbet — RTP 96.50%
  ✅ Roobet — listed (RTP not published)

✅ Gate 1: Widely offered + RTPs aligned → Proceed to Phase 2
```

## Project layout

```
src/
  index.js     Bolt Socket Mode entry; fan-out + gate composition
  extract.js   Regex provider detection + filler-word stripping
  fuzzy.js     Normalization + fuse.js with a sequel-aware gate
  browser.js   Shared headless Playwright launcher + per-site warmed contexts
  shuffle.js   Hourly-cached catalog fetch + slot search (no Playwright)
  stake.js     Slot detail page scrape (Playwright)
  rainbet.js   Public REST catalog cache via warmed context
  roobet.js    Slot detail page title parse (Playwright)
  gate.js      Pure function computing the Gate 1 verdict
```

## Setup

```sh
cd casinoscraper
npm install
npx playwright install chromium
cp .env.example .env   # fill in tokens
npm start
```

### Slack app

1. api.slack.com/apps → **Create new app** (from scratch) in the target workspace.
2. **Socket Mode** → enable. Generate an **app-level token** with scope `connections:write` → `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** → bot scopes `channels:history`, `chat:write`. Install → `SLACK_BOT_TOKEN`.
4. **Event Subscriptions** → subscribe to `message.channels`.
5. Invite the bot to the channel; copy the channel ID into `SLACK_WATCH_CHANNEL_ID`.

## Deployment

A $5/mo VPS in **Toronto** (Vultr / DigitalOcean) covers all four sites. From a Canadian IP:
- Shuffle: works (flat JSON CDN, no geo gate)
- Stake: works (Canada is permitted; Cloudflare clears after warmup)
- Rainbet: works (permitted; same Cloudflare pattern)
- Roobet: works (Canadian residents allowed)

```sh
git clone <repo> && cd casinoscraper
npm install && npx playwright install --with-deps chromium
cp .env.example .env && nano .env
npm install -g pm2
pm2 start src/index.js --name casinoscraper
pm2 save && pm2 startup
```

If Stake or Rainbet starts 403'ing from your DC IP, swap **only those two** to a residential proxy (BrightData / IPRoyal Canada exit). Shuffle and Roobet should keep working from a DC IP indefinitely.

## First-run verification

Both Stake and Rainbet do client-side rendering with selectors that drift. After deploying, post a known release into the watched channel (e.g. "Pragmatic Play just dropped Sweet Bonanza 1000") and confirm:

- **Shuffle** returns an RTP — if it doesn't, the catalog JSON shape changed; check `shuffle.js`.
- **Stake** returns an RTP — if it returns "listed (RTP not published)", the RTP selector in `stake.js`'s `extractRtpFromPage` candidate list needs an update from a headed inspection.
- **Rainbet** returns an RTP — if not, `rainbet.js`'s `gameRtp()` field guesses (`rtp`, `return_to_player`, `edge`) didn't match the payload. Log one entry from the catalog to find the right field name and add it to `gameRtp()`.
- **Roobet** returns "listed (RTP not published)" — that's the expected output. RTP is never auto-extracted.

## Stake / Roobet selector calibration

If RTP on Stake starts returning `null` for listed games, run a headed session from the VPS and inspect the slot detail page DOM:

```js
// scratch.js
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false });
const page = await browser.newContext().then((c) => c.newPage());
await page.goto('https://stake.com/casino/games/sweet-bonanza');
// pause, find the RTP element in DevTools, update candidates in src/stake.js
```

For Roobet, the title-parsing regex in `roobet.js` covers the current pattern `"Play X Slot Online - Provider At Roobet Casino"`. If Roobet changes their title format, update `GAME_TITLE_RE`.

## What this is *not*

- Not stateful — each message is a one-shot. If a release is announced twice, the bot replies twice.
- Not authenticated — all four lookups are anonymous. Stake will geo-restrict if you run from a blocked country (US, UK, AU, FR, NL, ES, …).
- Not robust to ToS enforcement. Read-only public-data scraping at this volume is generally fine but the sites can IP-block.
