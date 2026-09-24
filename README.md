# YouTube One-Click Transcript

A browser extension that adds a **Transcript** button to YouTube video pages. Click it to open the transcript and copy it to your clipboard.

For long videos (courses, podcasts, streams – anything with **chapters**), copying the whole transcript can exceed practical limits. That's why every chapter in the video description also gets a small **copy** button: click it to copy **only that chapter's** transcript, so you never have to deal with a transcript that's too long.

## Features

- 📜 **Transcript** button next to Like / Share – copies the complete transcript with one click. The button is a batch service over the whole transcript and never consults the chapter list, so an exceptionally long recording is split **purely by size** (ordered `Part i/N` pieces, 1M characters at most each) and a 19-hour chaptered video batches exactly like a chapterless one. How big those parts are is derived from the transcript that was actually collected, not from a fixed target: the parts come out even, so you get three ~700k pieces rather than 1M + 1M + a 100k tail. If a single clipboard write is ever rejected, the copy falls back to ordered parts instead of failing.
- **Shows how much you have copied so far.** While stepping through the parts of a long transcript every copy control tells you how far along you are — the main button in words (`⏭ Copy 2/5 · 43%`), a chapter or player badge in its compact form (`⏭2/5 · 43%`) — where the share is the part of the whole transcript already on the clipboard, counted from the text actually copied rather than from the part index. The tooltip says it in words too, and the debug report carries it as `progress=<n>%`. Because that makes the badge's pill wide, the chapter row reserves exactly the room the pill measures, so a long chapter title can never end up underneath it.
- 📋 **Per-chapter copy buttons** on each chapter in the video description (chapter cards and chapter lists) – copies just that chapter's slice of the transcript. Each chapter is a batch of its own, sized by its own limits and independent of the main button's, and an exceptionally long single chapter is copied in ordered parts too, with the button showing which part is next and how much of the chapter is already copied (`⏭2/3 · 43%`).
- 🎬 **Current-chapter button in the player** – a small copy button appears next to the chapter title in the player's control bar, copying the transcript of whatever chapter is playing right now (it updates as the video plays).
- Copies from the exact caption data first: one request returns the whole transcript (even for PO-token-gated videos via `get_panel`), so long videos are copied in a second instead of by slowly scrolling YouTube's panel.
- Never silently skips content: if every caption source fails and the extension has to scrape the panel, the collector detects discarded or unrendered segments (virtualized lists) and falls back to the caption data again — a copied transcript is never missing a chunk of text.
- **Survives in-page navigation.** Jumping to the next or previous playlist video, clicking a related video, or following a chapter link picks up the new video's transcript immediately — no page refresh, and never the previous video's transcript. A copy already in flight is abandoned when the page moves on.
- **Right language, not an accidental one.** The copy uses the video's *own* caption language — the one YouTube itself would show — rather than "the first track that isn't auto-generated", which on a video with several languages silently picked a translation. Set `ytxt_lang` to override (see below).
- **Works on a localized page.** Timecodes are read in Arabic-Indic (`٥:٠٨`) and Persian-Indic (`۵:۰۸`) numerals as well as ASCII, and chapter titles in any script survive. A right-to-left chapter title has its part marker isolated so the bidi algorithm cannot reorder it, and the same guard covers the button tooltips and the debug overlay (display-only for the overlay) — copied transcript text and the copied debug report never contain bidi control characters. The badges are positioned with logical insets, so a watch page mirrored for RTL does not put a badge on top of its chapter title.
- Works with both the newer YouTube chapter cards and the classic chapter list layout.

## How the per-chapter buttons work

1. The extension reads the video's chapter list (titles + timestamps) from the page data.
2. A small clipboard button appears on every chapter entry in the description:

   - **New YouTube layout:** on each chapter card in the Chapters shelf.
   - **Classic layout:** on the right side of each chapter row.

3. A similar button is anchored to the **current chapter title in the player** – it always copies the chapter you're currently watching, whatever its length.

Clicking a chapter's button (in the description or in the player) fetches the video's caption data directly and copies the slice that belongs to that chapter's time range. The copied text starts with the chapter title on its own line. The chapter boundaries come from the next chapter's start time, so the text never overlaps the neighboring chapter. A chapter longer than its own 1M-character cap is split into ordered parts — `Chapter Title (part 1/N)` — and the button turns into a "copy next part" control: it shows the part count while copying (`⏳1/3`) and then offers the next part with the share of the chapter already copied (`⏭2/3 · 43%`), ending on a `✓`. While that pill is showing, the chapter row reserves the room it takes — measured from the badge itself, so it is right for any wording, digit set or part count — which keeps a long chapter title from ending up underneath it (`tools/check-badge-layout.mjs` measures exactly that in a real browser). The badge is only 22px wide, so while it is showing a count it widens into a pill and shrinks back to a circle afterwards — the smaller the badge, the bigger the count looks otherwise. A chapter that fits one write shows just the `✓`. Only if none of the caption sources below answers does the extension open YouTube's transcript panel and scrape it as a last resort. Because YouTube keeps that panel alive across an in-page navigation, one still showing the previous video's rows is closed and re-opened — and has to actually change — before it is read, so the scrape cannot paste the video you just left.

The extension fetches the video's caption data from YouTube, trying three independent sources in order:

1. **timedtext URL** from the video's player response (the exact caption data; retried once when YouTube returns a transiently empty response — unless the URL is PO-token-gated (`exp=xpe`), in which case the retry is skipped because it can't mint the required botguard token, and the report says so explicitly), then
2. **YouTube's `get_panel` API** (the modern transcript panel endpoint) — sends the same gzip-compressed request the YouTube page itself makes and returns the **whole transcript in a single response**, including for videos whose timedtext URL is PO-token-gated. This is the most reliable fallback for gated videos. (The OS fields it requires are derived from the user agent.) It degrades gracefully: if the page doesn't expose visitor data or the browser lacks gzip compression, this source is skipped and the chain falls through to the next one (`capFail` reports `getpanel: no visitor data on the page` or `getpanel: CompressionStream unavailable`).
3. **YouTube's innertube `get_transcript` API** — a separate serving path that only needs the video id.

The video id every one of those requests is built from comes from the URL, never from the page's cached payload: YouTube is a single-page app, so a payload that still describes the video you just left is discarded (`staleBlob` in the debug report) instead of being used to fetch the wrong transcript. See [docs/caption-sources.md](docs/caption-sources.md#video-id-resolution-after-an-in-page-navigation).

Each attempt records its outcome in the debug report (`capSource`: `timedtext` / `getpanel` / `innertube`, plus `capFail` with per-source reasons), so if a copy still fails you can see exactly which source answered and how. See [docs/caption-sources.md](docs/caption-sources.md) for the full reverse-engineering notes on these sources (request formats, the `get_panel` protobuf params, and the PO-token findings).

The main Transcript button is a batch service over the **whole** transcript, and it never looks at the chapter list — so a 19-hour chaptered video batches by size exactly like a chapterless one. A copy goes to the clipboard in one write while it fits the 1M-character ceiling (1M characters is ~2 MB); beyond that the transcript is divided into **as few parts as the ceiling allows, sized evenly**: the number of parts comes from the text that was collected (`ceil(size / ceiling)`) and each part's target is the text still unplaced shared over the parts still to come, so a part that came in under its target raises the next one's instead of leaving a stub at the end. Boundaries always fall between segments, so no caption is ever cut in half, and the button becomes a "copy next part" control (`⏭ Copy 2/5`). Those parts are numbered `Part i/N` and carry no chapter title. Click the button again after pasting each part to continue, and read how far along you are from the label — `⏭ Copy 2/5 · 43%`, where the share is the text already copied over the whole transcript (it grows with the parts, not with their index, so it reaches exactly 100% on the last one). Use the separate chapter copy buttons when you intentionally want only one chapter at a time.

The parts are a **lossless partition** of what was collected: every segment lands in exactly one part, in order, so the parts reassemble into the transcript byte for byte. That is verified before the first write, and a partition that would drop, duplicate or truncate text — or that would send a part over the ceiling while holding more than one segment — fails loudly instead of pasting a transcript with a hole in it. A single segment that is longer than the ceiling on its own still gets its own part whole, because cutting a caption in half to satisfy a size limit would lose text.

The main button and the chapter badges keep **separate** size pairs (`MAIN_CHUNK_THRESHOLD` / `MAIN_CHUNK_MAX_CHARS` and `CHAPTER_CHUNK_THRESHOLD` / `CHAPTER_CHUNK_MAX_CHARS`), so either operation can be retuned without moving the other; `test/test_chunks.mjs` pins both pairs, pins that the main button never reads the chapter list, and pins the losslessness of the partition across a spread of sizes and ceilings.

## Choosing the caption language

By default the transcript is copied in the video's own caption language — the track YouTube's player would show, determined from the default audio track (falling back to the first track the video lists). A manual track is preferred over auto-generated captions only *within* that language, so a video can never be copied in a different language just because its other-language track happens to be a manual one.

To ask for a specific language:

```js
localStorage.setItem("ytxt_lang", "ar");   // Arabic
localStorage.removeItem("ytxt_lang");       // back to the video's own language
```

or add `#ytxt_lang=ar` to the video URL. If the video has a track in that language it is used directly; if it does not, the video's default track is copied through YouTube's own `tlang` translation (`https://www.youtube.com/api/timedtext?...&tlang=ar`), which is the same mechanism YouTube's captions menu uses.

The language the copy actually ended up in is reported as `capLang` in the debug report, and `capLangMismatch=yes` when a requested `ytxt_lang` could not be honored by the source that answered — `get_panel`, the modern transcript API, always returns the video's default transcript and takes no language parameter, so a preference it cannot satisfy is made visible instead of being applied silently.

## UI language

The extension's own labels — the transcript button, the chapter badges and their tooltips, the debug overlay and the text in the alert after a failure — are English by default. `ytxt_ui` switches them:

```js
localStorage.setItem("ytxt_ui", "ar");     // Arabic (built in)
localStorage.setItem("ytxt_ui", "auto");   // follow the page's language
localStorage.removeItem("ytxt_ui");        // English (the default)
```

It can also be set as `#ytxt_ui=ar` on the video URL. A language that is not built in falls back to English **label by label**, so nothing can go missing, and a language can be added — or a single label overridden — without editing the extension:

```js
localStorage.setItem("ytxt_ui_strings", JSON.stringify({
  de: {
    "button.idle": "📜 Transkript",
    "chapter.tip": "Transkript des Kapitels kopieren: {title}"
  }
}));
```

`{title}`-style placeholders are filled from the value at hand, and a chapter title keeps its bidi isolation inside a translated sentence. The debug report's field names and values are never translated, so reports stay comparable between users (only the human `label.*` entry is).

This is independent of `ytxt_lang`: the buttons' language and the transcript's language are separate choices.

## Numerals in the labels

The chunk counters are chrome, not content, so they follow the **page's** language rather than the video's: an Arabic-UI page shows `⏳١/٣` where an English one shows `⏳1/3`, in the digit set that language actually uses — Arabic-Indic for `ar`, Persian-Indic for `fa`, ASCII for everything else. A *regioned* tag is taken at its word, so `ar-MA` keeps Latin digits (as the Maghreb does); only a region-less `<html lang>`, which is the common case, falls back to the language's majority numerals.

An explicit `ytxt_ui` carries the numerals with it — Arabic wording next to ASCII counters looks broken — and `ytxt_numerals` is more specific than both and wins over either.

Override it when your preference differs from that majority:

```js
localStorage.setItem("ytxt_numerals", "latn");   // 1/3
localStorage.setItem("ytxt_numerals", "arab");   // ١/٣
localStorage.removeItem("ytxt_numerals");        // follow the page
```

Two things stay ASCII on purpose: the `(part i/N)` markers in the **copied** transcript (that text is content and has to stay greppable) and the debug report's field values (so reports stay comparable between users). Only what you read on the page is localized.

## Installation

1. Click **Code → Download ZIP** on this page.
2. Extract the downloaded ZIP file.
3. Open Chrome and go to `chrome://extensions`.
4. Enable **Developer mode**.
5. Click **Load unpacked**.
6. Select the extracted folder containing `manifest.json`.
7. Open a YouTube video and click **Transcript**, or expand the description and click the **📋** on any chapter.

> **Note:** If the button doesn't appear, reload the YouTube page once.

## Requirements

- Chrome or any Chromium-based browser
- The video must have a transcript available
- Chapter copy buttons appear only on videos that have chapters

## Limitations

- YouTube UI changes may occasionally affect the extension.
- For extremely long videos, copying a chapter far from the current playback position may take a few seconds while the transcript loads.

## Debugging / reporting issues

To see what the extension actually did during a copy, enable diagnostics:

- `localStorage.setItem("ytxt_debug", "1")` in the console (reliable — YouTube strips unknown URL params), or
- add `?ytxt_debug=1` / `#ytxt_debug=1` to the video URL.

With diagnostics on, every copy prints a one-line report to the console, e.g.:

```
[YT-Transcript] Full transcript source=panel rows=1120 panelRows=1120 sweep=no incomplete=false fallbacks=0 range=[0s, end] 8300ms
```

It shows where the text came from (`panel` / `captions` / `chunks`), how many rows were collected, whether the repair sweep ran and how many steps it took, whether any segments were flagged missing, how many caption-fetch fallbacks were used, which caption source produced the rows when the panel route failed (`capSource`: `timedtext` or `innertube`), the language those rows are in (`capLang`, with `capLangMismatch=yes` when a requested `ytxt_lang` could not be honored), why the caption fallback failed if it did (`capFail`, e.g. `timedtext: caption response was empty; innertube: innertube error 400 (Precondition check failed.)`), the copied range, and — after an in-page navigation — `staleBlob`, the id of a page payload that was ignored for belonging to a different video. Chunk sessions add `progress=<n>%`, the share of the whole transcript copied by the part that report describes. The same stats are also stored as JSON on the main button's `data-debug` attribute.

With diagnostics on, a small **debug overlay** appears at the bottom-right of the page after each copy, showing the same report with a **📋 Copy report** button (copies the full JSON, including the video ID) and a ✕ to dismiss it — no console needed. Include that JSON when reporting an issue.

The extension also silences known-harmless console noise from YouTube's page code and other extensions: YouTube's `LegacyDataMixin` deprecation notice, its `beforeinstallprompt` banner note, and the repeated `A listener indicated an asynchronous response...` errors another extension's messaging throws on navigation (not this extension — it has no `chrome.runtime` messaging). Only exact known patterns are filtered; real errors, including this extension's own failure reports, always pass through. This works when the script runs in the page's JS world (Tampermonkey `@grant none`); as a plain MV3 content script the page's console is out of reach. Warnings Chrome itself prints — `preloaded using link preload`, `powerPreference ... ignored`, `migrate_from`, and network failures like 401/CORS/`ERR_FAILED` — can't be intercepted by any page or extension code; hide them with the DevTools console filter: `-/(preloaded using link preload|powerPreference|migrate_from|ad\.doubleclick\.net|ServiceLogin)/`. Opt out of the noise filter with `localStorage.setItem("ytxt_noise_filter", "0")`.

## Development

No build step — the extension is plain `manifest.json` + `content.js` + `content.css`.

```bash
npm test            # runs the unit suites (caption-fetch chain, transcript collector, perf/robustness)
npm run check       # syntax-checks content.js and validates manifest.json
npm run check:layout  # measures the chunk badge against the chapter title in Chrome (needs Chrome)
```

The tests extract the real functions out of `content.js` and exercise them against
mocked YouTube responses (timedtext, get_panel, get_transcript, virtualized panel
lists), so they run offline and deterministically.

`npm run check:layout` is the one check that needs a browser, because it is about
text width: it launches Chrome headless with a throwaway profile, inlines the real
`content.css`, injects the real `setChunkLabel()` / `reserveBadgeRoom()` and lays
out the badge against a long chapter title in every place the extension injects
one — including a mirrored RTL row — asserting that a pill never covers the title
and that a vertical card is never squeezed. It also verifies the check can fail:
without the reservation the wide labels must overlap. See
tools/check-badge-layout.mjs for what it can and cannot prove.
