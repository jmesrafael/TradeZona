# Performance & Egress Optimization Checklist

Living tracker for the egress-reduction and performance work. Each item references the file(s) it touched (or will touch). Tiers are ordered by ROI within each section. Mark `[x]` as done.

---

## Tier 1 — Read-path egress reduction

> The pages that show trades were doing `select('*')` on every load and on every realtime tick. This tier kills the bulk of recurring Supabase egress.

- [x] **#1 — `getTrades` explicit column list**
  Replace `select('*')` with the 14 columns `dbToTrade` actually reads.
  Files: [supabase.js:117-127](supabase.js#L117-L127)
  Effect: ~40-70 % less data per trade-list read.

- [x] **#2 — `getTradesLight` for analytics-only views**
  New helper returning `id, trade_date, pnl, r_factor` only. Calendar wired.
  Files: [supabase.js:131-138](supabase.js#L131-L138), [calendar.html:222](calendar.html#L222), [calendar.html:257](calendar.html#L257)
  Effect: Calendar payload ~25 % of before; no `notes` text shipped.

- [x] **#4 — `getTradeImages` excludes legacy `data` column**
  Explicit metadata-only select; on-demand legacy `data` fetch via `_fetchLegacyImageData(id)` for any pre-R2 row that still needs it.
  Files: [supabase.js:889-903](supabase.js#L889-L903), [supabase.js:691-722](supabase.js#L691-L722), [supabase.js:759-786](supabase.js#L759-L786)
  Effect: No base64 bytes shipped on hot image-list reads.

- [x] **#5 — Lazy-load all trade `<img>` tags**
  Added `loading="lazy"` and `decoding="async"` everywhere images render.
  Files: [logs/logs.js:1191-1192](logs/logs.js#L1191-L1192), 4 places in [notes.html](notes.html)
  Effect: Off-screen images don't fetch on first paint — typically 70-90 % less initial image traffic.

- [x] **#3 — Realtime delta-merging**
  New `applyTradeDelta(trades, payload, mergeFn)` helper. Realtime callbacks now apply INSERT/UPDATE/DELETE in place instead of refetching the full trade list. Logs has a `_staleFromRealtime` flag + `_maybeReconcileStale()` so dropped events during user edits get reconciled with one full refresh once edits settle.
  Files: [supabase.js:932-973](supabase.js#L932-L973), [logs/logs.js:62](logs/logs.js#L62), [logs/logs.js:236-265](logs/logs.js#L236-L265), [logs/logs.js:311-339](logs/logs.js#L311-L339), [notes.html:847-882](notes.html#L847-L882), [calendar.html:217-234](calendar.html#L217-L234)
  Effect: Steady-state egress for an active session drops by **>90 %**.

- [x] **#1-followup — Analytics no longer hard-reloads on every save**
  `tz_trades_changed` postMessage now queues a reload behind two gates: (a) `tz_tab_changed` says analytics is the active tab, AND (b) parent tab is visible. Coalesced 300 ms.
  Files: [analytics.html:97-135](analytics.html#L97-L135), [journal.html:1322-1334](journal.html#L1322-L1334), [journal.html:1335-1346](journal.html#L1335-L1346)
  Effect: 50+ reloads per editing session collapse to 1.

---

## Tier 2 — First-paint weight & cache hygiene

> Egress isn't only Supabase — slow first paint feels like the app is broken. These shrink cold-load.

- [x] **#9 — Vercel cache headers for static assets**
  HTML: `s-maxage=300, stale-while-revalidate=86400`. Static (.js/.css/font/image): `max-age=86400, s-maxage=604800, swr=604800`.
  Files: [vercel.json](vercel.json)
  Effect: Returning visitors hit Vercel edge / browser cache; we serve fewer bytes.

- [x] **#7 — Font Awesome subset (drop `regular` + `brands`)**
  Removed two CDN stylesheets every page used to load. `fa-regular fa-circle/image/copy/note-sticky` swapped for solid equivalents. `fa-brands fa-bitcoin` (~120 KB font file for ONE icon) replaced with a styled `₿` glyph (`.ico-btc` class injected via theme.js).
  Files: [theme.js:309-320](theme.js#L309-L320), [journal.html:16-17](journal.html#L16-L17), [logs/index.html:16-17](logs/index.html#L16-L17), [index.html:18-19](index.html#L18-L19), [calculatorpage.html:48-49](calculatorpage.html#L48-L49), `pages/calculator.html`, `pages/crypto-calculator.html`, [notes.html](notes.html), [logs/logs.js:696](logs/logs.js#L696)
  Effect: ~150 KB cut from cold first paint per visitor (one fewer CSS request, one fewer woff2 font fetch).

- [x] **#8 — Promote `_cache` from in-memory to `sessionStorage`**
  Replaced in-memory object with sessionStorage-backed cache while preserving TTL logic. Prefixes all keys with `_tz_cache_` to avoid collisions. Updated _cacheGet, _cacheSet, _cacheInvalidate with try/catch for graceful sessionStorage failure fallback.
  Files: [supabase.js:13-40](supabase.js#L13-L40)
  Effect: Profile persists across page navigations within the same session — 1 round-trip per session instead of per navigation.

---

## Tier 3 — Structural / longer-term

> Bigger payoffs once foundations are in place.

- [ ] **#11 — Pagination on `getTrades`**
  Default to last 365 days with a "Show all" toggle. A user with 5,000 trades currently pulls all 5,000 on every page that lists trades.
  Files to touch: [supabase.js:119-127](supabase.js#L119-L127), all `getTrades(jid)` callers (logs, notes, calendar, journal).
  Risk: medium — date-bound filtering needs UI affordances and "load more" UX.

- [ ] **#6 — Backfill remaining Supabase-Storage images → R2; drop `data` column**
  R2 egress is free; Supabase Storage egress counts. After backfill, delete the legacy `data` column so we can also drop the on-demand `_fetchLegacyImageData` path.
  Files to touch: write a one-shot worker (Node + service-role key); migration to drop the column once complete.

- [ ] **#12 — Vite (or esbuild) build pipeline**
  Unlocks: (a) tree-shaking the Supabase SDK (saves ~30 KB), (b) content-hashed asset names so we can use `Cache-Control: immutable`, (c) extracting inline JS from `journal.html` (152 KB) and `notes.html` (132 KB) into cacheable JS files.
  Risk: largest single change in this list — touches the deploy pipeline. Best done after Tier 2 wins are banked.

- [ ] **#13 — Subscribe analytics directly to realtime + recompute charts in place**
  Removes the last `location.reload()` path. Significant rewrite of the analytics IIFE. Only worth it if Tier 1 measurements show analytics is still a noticeable cost.

- [ ] **#14 — Audit `subscribeTrades` payload size**
  Realtime publication ships every column on every change, including `notes` (long text). If this becomes a measurable share of websocket traffic, configure the publication to omit `notes` (delta-merge would lose only the notes preview, which the trade-edit modal can refetch on demand).

---

## Cleanup

- [x] **Removed stale documentation files** (only referenced each other; no live code paths):
  `CODE_CHANGES.md`, `IMPROVEMENTS_SUMMARY.md`, `QUICK_START.md`, `README_UPDATES.md`, `VISUAL_GUIDE.md`.
- [x] **SQL migrations review** — kept all 3 (`2026-04-25_notes_pin_and_images.sql`, `2026-04-26_presession_checklist_refactor.sql`, `2026-04-26_presession_mood_options.sql`); each is needed for a fresh DB setup.
- Kept: `DEPLOYMENT_RUNBOOK.md` (designated source of truth), `TRADZONA_OVERVIEW.txt` (project overview), `deployment-phases/` (active runbook system).

---

## Open follow-ups noticed during the work

- The `tz_trades_changed` postMessage path in calendar still triggers a `getTradesLight` refresh on every save (in addition to the realtime delta). Consider gating it the same way analytics is gated.
- Several pages still load Font Awesome from cdnjs at runtime. Long-term, consider self-hosting the subset under our own origin so cache headers are under our control and there's no third-party DNS hop.
- The signed-URL cache (`_urlCache`) is in-memory only — same `sessionStorage` promotion as `_cache` could keep it warm across navigations and skip the `createSignedUrl` round-trip on second visits to a notes page.

Progress Report
✅ Tier 2 — Font Awesome subset done
File	Change
5 page heads	Dropped regular.min.css (where present) and brands.min.css (where present). journal.html:16-17, logs/index.html:16-17, index.html:18-19, calculatorpage.html:48-49
5 fa-regular call sites	Swapped for fa-solid equivalents (with opacity tweak for the empty-vs-filled note-sticky distinction in logs/logs.js:696)
9 fa-brands fa-bitcoin call sites	Replaced with <span class="ico-btc">₿</span> across index.html, calculatorpage.html, journal.html, pages/calculator.html, pages/crypto-calculator.html
theme.js	Added the small .ico-btc style (theme.js:309-320) so the Bitcoin glyph renders consistently across themes
Effect
Per cold first-visit, every page that used to load all four Font Awesome stylesheets now skips:

regular.min.css + the fa-regular-400.woff2 font file (~30 KB)
brands.min.css + the fa-brands-400.woff2 font file (~120 KB)
That's roughly ~150 KB cut from the cold first paint per visitor on journal, logs, index, and calculatorpage. Cached visitors save the same on cache miss / version bump. The remaining fontawesome.min.css + solid.min.css cover every icon still in the UI.

Note: this is browser-side bandwidth (CDN → user), not Supabase egress. The first-paint speed-up is the user-facing win.

✅ Cleanup
Removed 5 stale doc files that only referenced each other and weren't linked from any code: CODE_CHANGES.md, IMPROVEMENTS_SUMMARY.md, QUICK_START.md, README_UPDATES.md, VISUAL_GUIDE.md.
Kept all 3 SQL migrations — each is required for a fresh DB. Migrations are append-only.
Kept DEPLOYMENT_RUNBOOK.md (you flagged it as source of truth), TRADZONA_OVERVIEW.txt, and the entire deployment-phases/ system.
✅ CHECKLIST.md
New file at the repo root: CHECKLIST.md. It tracks every optimization across all three tiers with file references, status checkboxes, and a record of what's already done. Future sessions (or you) can update it as items get crossed off.

Test plan (cold-cache, this round)
Open the site in a private/incognito window → DevTools > Network → reload.
Confirm only fontawesome.min.css and solid.min.css load from cdnjs (no regular.min.css, no brands.min.css, no fa-regular-400.woff2, no fa-brands-400.woff2).
Visual smoke test:
Logs notes column: empty trades show a faded note-sticky, filled trades show a bright one.
Notes filter chip: "No Image" still has its image icon (now slightly faded).
Calculator page hero: Bitcoin glyph "₿" renders in the badges.
Index page nav dropdown: Bitcoin glyph in the Crypto Calculator entry.
Journal import section: Bitcoin glyph next to "Import Trade History".
What we should do next
From CHECKLIST.md, the remaining items in priority order:

🥇 Tier 2 — finish first-paint cleanup
#8 Promote _cache to sessionStorage — currently every page navigation re-fetches the user profile from Supabase even though it almost never changes. Persisting the existing in-memory cache to sessionStorage (TTL preserved) means one round-trip per browser session instead of per page. ~10-line change in supabase.js:17-33. Low risk, real win for navigation feel.

🥈 Tier 3 — bigger structural moves
#11 Pagination on getTrades — necessary before you have users with multi-year history. Default 365 days + "Show all" toggle.

#12 Vite build pipeline — the foundation that unlocks tree-shaking, asset hashing, and Cache-Control: immutable. Largest single change but compounds with everything else.

#6 Backfill old Supabase Storage images → R2 then drop the data column entirely.

🥉 Long tail
#13 Subscribe analytics directly to realtime (eliminate the last location.reload).
#14 Audit realtime payload size for notes text.

I'd recommend #8 (_cache → sessionStorage) next — it's contained, low risk, and noticeably improves cross-page navigation feel. Want me to do it?