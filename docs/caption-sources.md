# Caption sources & the get_panel findings

This document explains how the extension obtains a video's transcript text when
YouTube's own transcript panel cannot be used, and records the reverse-engineering
findings behind the `get_panel` source (the one the current YouTube UI actually
uses).

## The source chain

A copy attempt works like this:

1. **Caption sources** — fetch YouTube's caption data directly, in order (below).
   This is the primary path for both the full copy and per-chapter copies: one
   request returns the whole transcript (timedtext and `get_panel` both do), so
   the copy is fast and independent of YouTube's panel UI.
2. If every caption source fails, the **panel route** runs — open YouTube's own
   transcript panel and scroll through it, collecting
   `ytd-transcript-segment-renderer` rows. If that also comes back empty or
   incomplete, the caption chain is retried once more before giving up.

The three caption sources, in order:

   | # | Source | Endpoint | Notes |
   |---|--------|----------|-------|
   | 1 | timedtext | `https://www.youtube.com/api/timedtext?...&fmt=json3` | URL from the player response's caption tracks; retried once on transient empty responses (unless PO-token-gated, see below) |
   | 2 | **get_panel** | `https://www.youtube.com/youtubei/v1/get_panel` | The modern transcript panel API (below) — returns the whole transcript in one response, no PO token needed |
   | 3 | get_transcript | `https://www.youtube.com/youtubei/v1/get_transcript` | Legacy innertube endpoint; live-verified to currently reject unauthenticated calls (HTTP 400 `Precondition check failed`), kept as a best-effort last resort |

Each attempt records its outcome in the debug report: `capSource`
(`timedtext` / `getpanel` / `innertube`) says which source produced the rows, and
`capFail` gives the per-source reasons, e.g.:

```
timedtext: caption response was empty [PO-token-gated: exp=xpe - this track requires a botguard PO token];
getpanel: getpanel error 400 (Invalid value at 'context.client.platform' ...);
innertube: innertube error 400 (Precondition check failed.)
```

## PO-token gating (why timedtext sometimes returns empty)

Since ~2025-2026 YouTube has been rolling out `exp=xpe` on timedtext URLs: such
URLs are only served to requests carrying a botguard **PO token**, which the
page's own player code attaches. A content script cannot mint one, so the
extension's timedtext fetch on a gated video gets HTTP 200 with an **empty body**
while the page's own token-bearing fetch for the same video gets megabytes of
real content.

Detection: the extension checks the advertised track URL for `exp=xpe` and, when
present, (a) skips the pointless retry and (b) says so explicitly in `capFail`.
The reference implementation `youtube-transcript-api` refuses these URLs outright
(`PoTokenRequired`).

## get_panel: the endpoint the current UI actually uses

Opening the transcript panel on a modern watch page fires a
`POST /youtubei/v1/get_panel?prettyPrint=false` with a **gzip-compressed JSON
body**:

```json
{
  "context": { "client": { /* innertube client, see requirements below */ } },
  "panelId": "PAmodern_transcript_view",
  "params": "qgkPCgtudV9wQ1ZQS3pUaxgB"
}
```

### The `params` protobuf (deterministic per video)

`params` is base64 of a protobuf message that only encodes the video id:

```
aa 09 0f                                    tag: field 149, wire type 2, len 15
0a 0b 6e 75 5f 70 43 56 50 4b 7a 54 6b      inner: field 1 (video id, 11 bytes)
18 01                                        inner: field 3, varint 1
```

For any 11-character video id `V` the payload is
`[0xaa, 0x09, 0x0f, 0x0a, 0x0b, ...V, 0x18, 0x01]` (inner length = 15 for 11-char
ids). The extension builds this by hand — no protobuf library needed.

### Context requirements (ablation-verified live)

The full 32-field client context the page sends is *not* required. Live ablation
(Sept 2026) showed the load-bearing fields are only:

- `clientName: "WEB"`, `clientVersion` (the page's current version)
- `hl`, `gl`
- `visitorData` (read from the page's `ytcfg` `VISITOR_DATA`)
- `userAgent`
- `osName`, `osVersion`, `platform` — `platform` is a **strict enum**
  (`DESKTOP` / `MOBILE` / ...); the extension derives these from the user agent

The `user`, `request`, `clickTracking`, and `adSignalsInfo` sections are
optional. Dropping `remoteHost`, `deviceExperimentId`, `rolloutToken`,
`configInfo`, and friends does not affect acceptance.

`INNERTUBE_CONTEXT` is *not* exposed as a single parseable string on the watch
page, but `INNERTUBE_CLIENT_VERSION`, `INNERTUBE_API_KEY`, and `VISITOR_DATA`
are all readable from `ytcfg.set({...})` payloads in page scripts.

### Response shape

One `get_panel` response contains the **entire transcript** — no pagination for
segments (the only continuation is for the panel's search box). For the 7h
freeCodeCamp video it was a single 4.3 MB JSON with 3,353 segments covering
`0:00` → `7:29:09`.

The segments live at:

```
content.engagementPanelSectionListRenderer.content.sectionListRenderer
  .contents[].itemSectionRenderer.contents[]
  .timelineItemViewModel.contentItems[]
  .transcriptSegmentViewModel
```

with the two fields that matter:

```json
{
  "timestamp": "0:08",
  "simpleText": "use those skills to make a fullstack web app ..."
}
```

(No `cueGroups`/`transcriptCueRenderer` here — those belong to the legacy
`transcriptBodyRenderer` shape used by `get_transcript`.)

### The no-PO-token finding

The captured page request for `get_panel` contains **no poToken** anywhere.
Combined with the ablation above, this makes `get_panel` the one caption source
that works from a plain, unauthenticated, anonymous browser session on videos
whose timedtext URLs are PO-token-gated — verified end-to-end on the gated
video: timedtext → empty (gated) → get_panel → full 7-hour transcript copied in
chapter chunks, with `capSource: "getpanel"` in the report.

### Language selection (and what this source cannot do)

The `params` protobuf above carries **only the video id**, so `get_panel`
returns the video's *default* transcript and offers no way to ask for another
language. That is fine as a default (it is the language the page itself would
show), but it means a Track-selection preference has to be applied elsewhere.

The `timedtext` source therefore owns the language decision:

- with no preference, the chosen track is the one whose `languageCode` (or
  `vssId`, `.ar` = manual / `a.ar` = ASR) matches the video's default caption
  language — taken from `playerCaptionsTracklistRenderer.audioTracks[defaultAudioTrackIndex].captionTrackIndices[0]`,
  falling back to the first listed track (where YouTube puts the original
  language). Manual-over-ASR only settles the choice *within* that language;
- with `ytxt_lang` set (`localStorage` or `#ytxt_lang=ar`), a native track in
  that language is used when one exists, otherwise the default track is fetched
  with YouTube's own `&tlang=ar` translation;
- whichever source answers, the language it produced is reported as `capLang`,
  and a requested language that `get_panel` / `get_transcript` could not honor is
  flagged as `capLangMismatch=yes` in the debug report rather than passing
  silently.

**Open question (needs one live capture).** The panel UI has a language
selector, so a request shape that selects a language for `get_panel` probably
exists. Finding it means recording a second `get_panel` request after switching
language in the panel and diffing its gzipped `params` (and JSON body) against
the default one — the procedure under *Re-verifying live* below. Until then the
chain stays on the known-good video-id-only params and reports the mismatch
instead of guessing a protobuf field.

### Graceful degradation

The `get_panel` attempt only runs when its prerequisites are met and always falls
through cleanly:

- no video id → `no video id`
- `CompressionStream` unavailable (needed to gzip the body) →
  `CompressionStream unavailable ...`
- no `VISITOR_DATA` in the page → `no visitor data on the page`
- request/parse failures → HTTP/JSON/segment-count reasons

In every case the chain proceeds to the next source and the reason appears in
`capFail`, so a degraded copy is never silent.

## Video id resolution after an in-page navigation

The `params` protobuf is only as trustworthy as the video id inside it, and that
id is the one thing a piece of page data cannot be trusted for.

YouTube is a single-page app: the inline `ytInitialData` and
`ytInitialPlayerResponse` scripts are written once, on the first hard load, and
are **not** rewritten when the page moves to another video. Resolving the caption
track from that payload — as a naive implementation does — fetches the
**previous** video's timedtext URL, so the copied transcript is the video you
already left until the page is refreshed. The `get_panel` / `get_transcript`
requests have the same trap when they build `params` from
`playerResponse.videoDetails.videoId`.

The rule used here: **the video id in the URL is authoritative.** Every request
is built from it, and a page payload is used only when it names that same video
or names no video at all. A payload naming a different video is discarded and
reported as `staleBlob`. Live sources are preferred wherever the JS world exposes
them — `movie_player.getPlayerResponse()` and `ytd-watch-flexy.playerData` are
updated by YouTube on every navigation — but as an MV3 content script (isolated
world) page-defined element methods are not visible at all, which is why the URL
path has to be correct on its own rather than as a fallback behind them.

## Re-verifying live

The language question above has a ready-made capture:

```bash
node tools/capture-getpanel-lang.mjs                # auto-pick a multi-language video
node tools/capture-getpanel-lang.mjs --video=<id>   # a specific video
```

It launches Chrome with a throwaway profile (your own profile is untouched),
opens the transcript panel on a video that has several caption languages,
records the transcript requests, then clicks through the panel's controls until
a language switch fires another one. Artifacts land in `tmp/getpanel-lang/`,
including the page's own pre-compression JSON bodies (read from the page's JS
world, because a gzip POST body read back over CDP can be mangled) and a decoded
"field path = value" dump of both `params` protobufs. The run prints exactly
which protobuf field (if any) differs between the default and switched requests —
that field is what `get_panel` would need in order to select a language.

If nothing changes in `params`, look at whether the panel instead re-requested
`timedtext` (the same summary lists every transcript request seen); then the
language is a `timedtext` concern only and the current behaviour is already
correct.


The findings above were captured with CDP-driven headed Edge runs that:
1. logged `Network.requestWillBeSent` for `get_panel`, saved the raw gzipped
   `postData` and the response body to disk,
2. gunzipped the request body and decoded the `params` protobuf,
3. replayed minimal-context variants from the page origin to find the required
   fields,
4. finally drove the real extension's Transcript button on the gated video and
   read the clipboard + `data-debug` report back.

To re-check acceptance from a fresh session, POST the gzip-compressed JSON
(minimal client + `panelId` + `params`) from any watch page origin and expect
HTTP 200 with `transcriptSegmentViewModel` entries. If you see
`Invalid value at 'context.client.platform'`, the `platform` value is not a
valid enum member; if you see `Precondition check failed.` with a minimal
client, add `osName`/`osVersion`/`platform` (and check `visitorData`).

## What was NOT viable

- **`youtubei/v1/get_transcript`** — every documented request shape (old and
  current client versions, one- and two-field protobuf params) returned HTTP 400
  `Precondition check failed.` in Sept 2026, and the current page UI no longer
  calls the endpoint at all (it uses `get_panel`). Kept in the chain because the
  endpoint may come back, and its rejection is reported precisely.
- **minting a PO token** — requires botguard evaluation; out of scope for a
  content script.