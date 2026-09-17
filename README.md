# casinoscraper

Slack bot that processes SOFTSWISS Alerts (new game releases, recalls, URGENT disables, RTP changes, enabled-back, maintenance) and reconciles each event against Dicey + four competitor crypto-casinos (Shuffle, Stake, Rainbet, Roobet).

Watches `#ext-everhelp-dicey-alerts` for SOFTSWISS bot posts, classifies each by type, and replies in-thread with a per-type advisory. Actionable replies (something on Dicey needs human attention) `@`-mention the `@mops-dicey` Slack user-group (configurable via `SLACK_ALERT_USERGROUP_ID`); non-actionable replies stay quiet.

> ⚠️ **Deploy from a Toronto / non-US VPS.** Stake and Rainbet's Cloudflare edge geo-blocks US visitors at the network layer — no stealth plugin, no warmed context, no proxy at the app layer can fix this. A US-based VPS returns "⚠️ error: HTTP 451" (Stake, as of 2026-09) or HTTP 403 on Stake and Rainbet for every game, gracefully degrading the Gate 1 verdict to "escalate". Canadian residents are allowed on all four sites, and Cloudflare clears cleanly after a warmup nav. See [Deployment](#deployment).

## Alert types handled

| Type | Trigger | What we do |
|---|---|---|
| **Release** | `New Games Released` header | Parse multi-game block, fan out to 4 competitors + Dicey, post one consolidated reply with per-game Gate 1 verdicts |
| **Recall** | `the game X has been recalled` / `the following X games have been recalled` | Per game: if active on Dicey → @mops-dicey + recommend deactivate + persist to `state/recalls.json` keyed by canonical provider |
| **URGENT** | `#URGENT` or `temporarily disabled` + `freeze withdrawals` | Same as recall but with stronger framing (freeze withdrawals + deactivate) |
| **RTP change** | `value of RTP in the game X has been changed from A to B` | If active on Dicey → @mops-dicey + post old → new RTP + Δ pp + "verify and update RTP config". Handles `.` and `,` decimals. |
| **Enabled back** | `X games have been enabled back` / `available again` | Replay the recall state for that provider (clears it from the store) → @mops-dicey + list previously-deactivated games to re-enable |
| **Maintenance** | `maintenance` / `scheduled downtime` | Parse provider + window (release date / start / duration) → @mops-dicey + advise queueing customer-facing downtime notification |

Every reply ends with `_React to OG post w/ ✅ or ❌ once actioned or dismissed_` so the team knows the acknowledgement protocol.

## Release message dialects

Two release formats are in circulation and both parse:

**A — SOFTSWISS GA bot**

```
New Games Released
Curacao+Malta

Red Rascal (Hacksaw)
Fee: hacksaw_rtp | RTP: 92.26 | Certs: BG CA-ON CW
```

**B — the prose "Dear team!" mail**

```
The following games are released today:

Curacao+Malta:

Toothrot Tilly (Hacksaw/PineapplePlay):
    - fee group: hacksaw_basic ; RTP - 96.34
    - fee group: hacksaw_rtp94 ; RTP - 94.35
    - Certifications: CA-ON CW EE
```

B differs on six axes: a colon after the game heading, `fee group` instead of
`Fee`, a dash before the RTP, spelled-out `Certifications`, a bullet on every
detail line, and the certs hanging on their own line rather than inline. Before
B was handled it classified as `released` and then parsed **zero** games, so
`handleRelease` returned null and the bot posted nothing at all — a whole
release mail silently dropped.

A standalone `Certifications:` line applies to every config above it that has no
certs yet, which covers both layouts B uses: one shared trailing line for all
configs, and one line interleaved after each fee group.

Note that games whose provider is not in `PROVIDERS` are dropped by design — a
single dialect-B mail can list 23 games and report 5.

## Provider matching

Provider names in SOFTSWISS messages come in many forms (`Pragmaticplay`, `Playngo`, `Redtiger`, `Netent`, `Barbarabang`, `1spin4win`). We resolve them in three stages:

1. Exact normalized match (`Pragmaticplay` → `Pragmatic Play`)
2. Bidirectional substring containment (`Hacksaw` → `Hacksaw Gaming`)
3. Fuzzball `fuzz.ratio ≥ 88` for typos (`Pragmatik Play` → `Pragmatic Play`)

Threshold tightened from upstream's 80 to 88 because we don't pre-gate on an alert keyword. At 80, `PoggiPlay` (a real, distinct studio) confuses with our `Popiplay`; at 88 they cleanly separate while realistic typos still hit (typos score ≥93). Slash entries (`Evolution/Redtiger`) pass if any side matches; the raw `x/y` is preserved for display, with a `Matched: …` note when only some sides hit the allowlist.

The full list mirrors `ALLOWED_PROVIDERS` in [magiceden-vibes/tg-slack-softswiss-alerts](https://github.com/magiceden-vibes/tg-slack-softswiss-alerts) — see `PROVIDERS` in `src/extract.ts`.

## Per-site mechanics

| Site | Catalog access | RTP | Notes |
|---|---|---|---|
| **Dicey** (own) | `api.dicey.com/graphql` — `GameList(input: { search })` | ❌ not in schema | Reports `isActive` + `isGeoRestricted`. Post-fetch `fuzz.ratio ≥ 85` floor to reject "Cat in Vegas" → "Weekend In Vegas" style false positives. |
| **Shuffle** | Public flat JSON catalog (~5,600 games) | ✅ via `edge` field → `(10000 − edge) / 100` | One unauth HTTP GET, hourly cache |
| **Stake** | Slot detail page behind Cloudflare | ✅ scraped from detail page | Pre-warmed Playwright context with `puppeteer-extra-plugin-stealth` |
| **Rainbet** | Public sitemap (`/sitemap/casino.xml`, ~4,100 slot pages) | ❌ not in sitemap | The JSON API (`services.rainbet.com`) is behind a Cloudflare **Turnstile** managed challenge that 403s even the site's own frontend until `cf_clearance` is issued — unsolvable by stealth `fetch()`. The main-domain sitemap is unchallenged; we fuzzy-match the game slug against it. One unauth HTTP GET, hourly cache. |
| **Roobet** | `/casino/game/<provider>-<slug>` page title | ❌ not published publicly | SPA: title is set client-side ~2s in, so we poll for it. Slugs are provider-prefixed; the bare slug is tried in parallel as a fallback. |

### Cloudflare handling

Stake and Rainbet sit behind Cloudflare. We handle this in two ways:

- **Passive bot detection**: `puppeteer-extra-plugin-stealth` registered against `playwright-extra` masks automation fingerprints (`navigator.webdriver`, `chrome.runtime`, plugin lists, WebGL vendor strings).
- **Warmed contexts**: each site opens one Playwright context, navigates to the homepage at startup, lets the Cloudflare challenge resolve, then keeps that context (with cookies) alive for 25 minutes. Subsequent game lookups reuse the cleared context.

Both fail gracefully: if a warmup throws, the cache entry is **deleted** (not poisoned) so the next call retries instead of returning the same rejection forever. If Cloudflare blocks the request (typically because you're in a blocked geo — the main case being US), the per-game line shows `⚠️ <site> — error: HTTP 451` or `HTTP 403` and Gate 1 degrades to "escalate". Note that a blocked site drops out of the listed count, so a game on 3 real sites can read as 2/4 → escalate from a US IP. Run from Toronto.

## Gate 1 verdict logic

- **≥3/4 listed** AND **max RTP variance ≤ 0.5 pp** across publishing sites → ✅ **Proceed to Phase 2**
- **0/4 listed** → ⚠️ **Escalate to Enhanced Due Diligence**
- **RTP variance > 0.5 pp** across any pair that publishes, *not* explained by a published config → ❌ **Do NOT proceed**
- **1–2 of 4 listed** → ⚠️ **Escalate to Enhanced Due Diligence**

### Multi-config games

SOFTSWISS frequently ships one game in several fee/RTP builds at once, one
`Fee: … | RTP: … | Certs: …` line each under a single game heading:

```
Le Bandit Hold & Win (Hacksaw)
Fee: hacksaw_basic | RTP: 96.27 | Certs: …
Fee: hacksaw_rtp94 | RTP: 94.29 | Certs: …
Fee: hacksaw_rtp   | RTP: 92.23 | Certs: …
```

All of them are parsed into `MatchedGame.configs` (`rtp`/`fee`/`certs` stay flat,
pointing at the first). This matters for the variance rule: two operators
integrating *different but both legitimate* builds is normal, and comparing
against one arbitrary build produced a false ❌ — Shuffle on `hacksaw_basic`
(96.27) vs Stake on `hacksaw_rtp94` (94.29) is a 1.98 pp spread that says
nothing bad about the game.

So `computeGate()` takes the published configs and only rejects on variance when
a competitor's RTP matches **no** published build (within 0.5 pp). A spread fully
accounted for by the published configs falls through to the normal coverage rule
and is annotated instead:

```
*Le Bandit Hold & Win* (Hacksaw Gaming)
  Configs: hacksaw_basic 96.27% · hacksaw_rtp94 94.29% · hacksaw_rtp 92.23%
  ✅ Shuffle — RTP 96.27% (=hacksaw_basic)
  ✅ Stake — RTP 94.29% (=hacksaw_rtp94)
  ✅ *Gate 1:* Widely offered; RTP spread explained by 3 published configs → Proceed to Phase 2
```

Called with no config data, `computeGate()` is byte-identical to the old
behaviour (nothing matches, so any spread rejects). Coverage still governs: an
explained spread with only 2/4 listed still escalates. An RTP matching no
published build is now a *sharper* signal than before — the reply names which
site is the outlier and marks the line `⚠️ no published config`.

**Match tolerance is adaptive.** Providers ship builds far closer together than
0.5 pp — NetEnt has run two `netent_basic` builds 0.13 pp apart and two
`netent_basic_rtp94` builds 0.04 pp apart — so a fixed window would swallow
several distinct builds at once. `matchConfig()` narrows to half the smallest
gap between published RTPs, floored at 0.05 pp so 2dp rounding still matches.

**Fee labels are not unique.** Playtech ships four configs all labelled `gpas`;
Blueprint two labelled `blueprint_basic`. The `(=<fee>)` tag on a site line is
therefore only shown when that label identifies exactly one build; otherwise the
RTP already on the line is the discriminator. The `Configs:` header says
`(4, shared fee label)` so a repeated label doesn't read as a copy-paste bug.

**Headline naming.** The reply title prefers a real title from Dicey, Shuffle,
Stake or Roobet, then falls back to the alert's own. Rainbet is deliberately
excluded: its name is derived from a sitemap slug, so it arrives lowercased,
punctuation-stripped and provider-prefixed (`playn go lawn n complete disorder`)
and would otherwise replace the actual release title whenever Rainbet was the
only site carrying a new game.

Roobet's listing counts toward availability but is excluded from RTP alignment (it doesn't publish per-game RTP). Dicey is reported but **not** factored into Gate 1 — it's our own site, the question is "have we already integrated it" not "does the market like it".

## Setup

```sh
git clone https://github.com/davidnghiem/casinoscraper.git
cd casinoscraper
nvm use                # reads .nvmrc -> Node 22, matching CI and `engines`
npm install
npx playwright install chromium
cp .env.example .env   # fill in SLACK_BOT_TOKEN, SLACK_APP_TOKEN
npm run dev            # tsx-driven, hot path
```

### Node version

`package.json` requires `node >= 22` and `.github/workflows/canary.yml` pins
`node-version: '22'`, so `.nvmrc` pins 22 to keep local, CI and prod on the same
runtime — `nvm use` in the project root picks it up. Node 20 will run the tests
(tsx transpiles) but is below the declared floor, and `npm start` executes the
plain `dist/` build with no transpiler in front of it, so don't deploy on it.

### Behind a TLS-interception proxy (Cloudflare WARP / Zero Trust, corporate MITM)

If your machine routes traffic through a TLS-inspecting proxy, every HTTPS cert is
re-signed by a private root. `curl` and Chromium trust it via the system keychain,
but Node's `fetch` (undici) ships its own CA bundle and rejects it with
`SELF_SIGNED_CERT_IN_CHAIN` — surfacing as a useless `fetch failed` on the
fetch-only adapters (Shuffle, Dicey, Rainbet). The Playwright adapters (Stake,
Roobet) are unaffected because Chromium trusts the system store.

Fix: export the proxy root into `certs/` (gitignored), and the npm scripts pick it
up automatically via `scripts/run-with-ca.mjs` (no-op when the file is absent, e.g.
in CI/prod):

```sh
# macOS, Cloudflare WARP example — adjust the cert name for your proxy:
security find-certificate -a -c "Cloudflare" -p /Library/Keychains/System.keychain \
  > certs/cloudflare-gateway-root.pem
npm run dryrun -- "Sweet Bonanza"   # now resolves Shuffle/Dicey/Rainbet cleanly
```

Override the path with `DEV_CA_CERT=/path/to/root.pem`, or skip the wrapper entirely
with `NODE_EXTRA_CA_CERTS=…` set in your shell. This is a **local dev** concern only —
a normal server/CI without an interception proxy needs none of it.

### Required env

| Var | Purpose |
|---|---|
| `SLACK_BOT_TOKEN` | `xoxb-…` from your Slack app's OAuth & Permissions (scopes: `channels:history`, `chat:write`) |
| `SLACK_APP_TOKEN` | `xapp-…` Socket-Mode app-level token (scope: `connections:write`) |
| `SLACK_WATCH_CHANNEL_ID` | `C0ACMU6DHFA` (#ext-everhelp-dicey-alerts) is the default |
| `SLACK_ALERT_USERGROUP_ID` | `S09Q4GUKX4Y` (@mops-dicey) is the default — drop to empty to silence @-mentions |
| `SLACK_ERRORS_CHANNEL_ID` | *(optional)* Separate channel for handler-crash notifications; empty = log-only |
| `SOFTSWISS_BOT_ID` | *(optional)* Tighten bot-source filter from name-heuristic to exact bot_id |
| `LOG_LEVEL` | `info` default; `debug` for verbose pino output |

### Slack app config

1. api.slack.com/apps → **Create new app** in the target workspace.
2. **Socket Mode** → enable; generate app-level token with `connections:write` → `SLACK_APP_TOKEN`.
3. **OAuth & Permissions** → bot scopes `channels:history`, `chat:write` (+ `chat:write.public` if you don't want to invite to every channel). Install → `SLACK_BOT_TOKEN`.
4. **Event Subscriptions** → subscribe to `message.channels`.
5. Invite the bot to `#ext-everhelp-dicey-alerts` (channel ID `C0ACMU6DHFA`).

## Scripts

```sh
npm run dev              # tsx hot-run (start the bot)
npm run build            # tsc → dist/
npm start                # node dist/src/index.js (after build)
npm run typecheck        # tsc --noEmit
npm test                 # node --test against tests/*.test.ts (68 tests)
npm run canary           # Dicey GraphQL schema canary (used by GH Actions daily)
npm run dryrun:alerts    # Process every fixture in tests/fixtures/ through dispatch(), print would-be Slack replies
npm run dryrun:alerts -- --include-releases   # Also run the multi-game release fixture (hits Cloudflare; takes ~30s)
```

## Project layout

```
src/
  index.ts        Bolt Socket Mode entry; SOFTSWISS bot-message filter, error-channel posts
  handlers.ts     dispatch() + per-alert-type handlers + reply formatters (pure)
  extract.ts      Alert-type detection + parsers (both release dialects) + PROVIDERS allowlist + matchProvider
  state.ts        JSON-file-backed recall store (state/recalls.json, gitignored). STATE_PATH overrides for tests/dryruns
  logger.ts       pino JSON-line logger
  types.ts        Shared SiteResult / DiceyResult interfaces
  fuzzy.ts        Normalization + fuse.js with sequel-aware digit gate
  gate.ts         computeGate() + matchConfig(): pure Gate 1 verdict function
  browser.ts      Shared headless Chromium + per-site warmed Playwright contexts with cache-poisoning guard
  dicey.ts        api.dicey.com GraphQL adapter (fetch-only)
  shuffle.ts      Hourly-cached catalog fetch (fetch-only)
  stake.ts        Slot detail page scrape (Playwright)
  rainbet.ts      Sitemap-catalog fuzzy match (fetch-only; API is Turnstile-walled)
  roobet.ts       Slot detail page title parse (Playwright; polls for client-set title, provider-prefixed slug + bare fallback)

scripts/
  canary.ts         Daily Dicey schema canary
  dryrun.ts         Manual per-game smoke (tsx scripts/dryrun.ts "<game name>")
  dryrun-alerts.ts  Run every fixture through dispatch() with a tmp state file

tests/
  extract.test.ts   36 tests covering all 7 alert parsers, both release dialects, multi-config releases, title/provider edge cases + matchProvider
  gate.test.ts      20 tests covering Gate 1 verdicts (0/4 → 4/4, RTP variance, config-explained spread, adaptive tolerance, errors)
  handlers.test.ts  12 tests for formatReleaseReply across listing counts, RTP variance, slash providers, Dicey states, headline naming + build labels
  fixtures/         Captured SOFTSWISS message bodies, one per alert type (+2 multi-config releases, +1 prose dialect)

.github/workflows/
  canary.yml      Daily 13:00 UTC run of scripts/canary.ts; posts to SLACK_ERRORS_CHANNEL_ID on failure
```

## Deployment

A $5/mo VPS in **Toronto** (Vultr / DigitalOcean / Linode CA region) covers all four sites. From a Canadian IP:

- Shuffle: works (flat JSON CDN, no geo gate)
- Stake: works (Canada permitted; Cloudflare clears after warmup)
- Rainbet: works (permitted; same Cloudflare pattern)
- Roobet: works (Canadian residents allowed)

```sh
git clone https://github.com/davidnghiem/casinoscraper.git
cd casinoscraper
nvm use            # or otherwise ensure Node 22 (see .nvmrc)
npm install && npx playwright install --with-deps chromium
cp .env.example .env && nano .env
npm run build
npm install -g pm2
pm2 start dist/src/index.js --name softswissbot
pm2 save && pm2 startup
```

If Stake or Rainbet starts 403'ing from your DC IP, swap **only those two** to a residential proxy (BrightData / IPRoyal Canada exit). Shuffle and Roobet keep working from a DC IP.

## Selector calibration

If Stake stops returning RTPs, the slot-detail page DOM changed. Run a headed Playwright session from the VPS:

```ts
import { chromium } from 'playwright';
const browser = await chromium.launch({ headless: false });
const page = await (await browser.newContext()).newPage();
await page.goto('https://stake.com/casino/games/sweet-bonanza');
// pause, find the RTP element in DevTools, update candidates in src/stake.ts
```

For Roobet, two things matter and both have bitten us:

1. **The title is client-rendered.** The server ships a shell whose `<title>` is
   the generic `"Roobet Crypto Casino | …"`; the real title appears ~2s later.
   Reading it at `domcontentloaded` returned the shell for *every* game, so
   `searchRoobet` silently reported "not found" on 100% of lookups — including
   Sweet Bonanza and Gates of Olympus. `roobet.ts` now polls for the title via
   `page.waitForFunction` (`TITLE_SETTLE_TIMEOUT_MS`). There is no early
   "not a game" signal to race against: the doubled shell title is a stage that
   *found* games pass through too, so a genuine miss costs the full timeout.
2. **Slugs are provider-prefixed** — `pragmatic-play-gates-of-olympus`, not
   `gates-of-olympus`. A few large titles also answer on the bare slug, so both
   candidates are tried in parallel and the first hit wins.

If Roobet changes their title format, update `GAME_TITLE_RE` — it is the single
source of truth for both the poll predicate and the parse.

## What this is *not*

- Releases, RTP changes, URGENT, and maintenance are stateless. Recall/URGENT events write to `state/recalls.json` so an enabled-back message can replay the list. If a recall is announced twice, both fire (the second is a no-op dedupe at the slug level).
- Not authenticated — all four competitor lookups are anonymous. Geo-restrictions still apply at the network layer.
- Not robust to ToS enforcement. Read-only public-data scraping at this volume is generally fine but the sites can IP-block.
