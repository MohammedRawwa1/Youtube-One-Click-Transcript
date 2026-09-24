// ==UserScript==
// @name         YouTube One-Click Transcript
// @namespace    http://tampermonkey.net/
// @version      1.7.0
// @match        https://www.youtube.com/*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(() => {
  "use strict";

  // =========================================================
  // CONSOLE NOISE FILTER
  // =========================================================
  // YouTube's page code and Chrome's extension layer print a steady stream
  // of harmless warnings on every watch page - Polymer deprecation notices,
  // PWA manifest quirks, and (loudest of all) the "A listener indicated an
  // asynchronous response..." errors thrown by *other* extensions' dead
  // message channels whenever the page navigates (e.g. Tampermonkey on
  // playlist jumps). This filter hides exactly those known patterns so real
  // errors - including this extension's own failure reports - stay visible.
  //
  // Hard limits (nothing page/extension code can do about these):
  //  - Browser-level warnings ("migrate_from", "preloaded using link
  //    preload", "powerPreference ... ignored") and network failures
  //    (401 / CORS / ERR_FAILED) are printed by Chrome itself, not through
  //    the page's console API - only the DevTools console filter can hide
  //    those (see README).
  //  - As an MV3 content script this runs in an isolated JS world where the
  //    page's console is out of reach, so the patch is a no-op there. It
  //    takes effect when the script runs in the page's own world
  //    (Tampermonkey @grant none), which is the recommended install.
  const CONSOLE_NOISE = [
    // Other extensions' messaging noise: thrown as an uncaught promise
    // rejection when an onMessage listener returns true but its channel
    // closes (SPA navigation / tab switch). Repeated several times per
    // navigation - once per frame that has the other extension injected.
    /A listener indicated an asynchronous response by returning true, but the message channel closed before a response was received/,
    // YouTube's own Polymer/Lit deprecation notice (kevlar modules).
    /LegacyDataMixin will be applied to all legacy elements/,
    // YouTube's PWA install-banner note.
    /Banner not shown: beforeinstallprompt/,
  ];

  function installConsoleNoiseFilter() {
    if (typeof window === "undefined" || typeof console === "undefined") return;
    try {
      // Guard against double injection (script loaded twice in the same JS
      // world) - never stack wrappers on top of each other.
      if (window.__ytxtNoiseFilterInstalled) return;
      Object.defineProperty(window, "__ytxtNoiseFilterInstalled", {
        value: true,
        writable: false,
        configurable: false,
        enumerable: false,
      });
      // Opt-out: localStorage.setItem("ytxt_noise_filter", "0")
      if (localStorage.getItem("ytxt_noise_filter") === "0") return;
    } catch (e) {
      return;
    }

    const msgOf = (args) => {
      let out = "";
      for (const a of args) {
        try {
          out += typeof a === "string" ? a : JSON.stringify(a);
        } catch (e2) {
          try {
            out += String(a);
          } catch (e3) {}
        }
        out += " ";
      }
      return out;
    };
    const isNoise = (args) => CONSOLE_NOISE.some((re) => re.test(msgOf(args)));

    for (const level of ["log", "info", "warn", "error", "debug"]) {
      const orig = console[level];
      if (typeof orig !== "function") continue;
      console[level] = function (...args) {
        if (isNoise(args)) return undefined;
        return orig.apply(console, args);
      };
    }

    // The async-response error never passes through the console wrappers
    // above (it's an uncaught promise rejection, not a console call), so
    // swallow exactly that message via unhandledrejection; everything else
    // still reaches the console.
    window.addEventListener("unhandledrejection", (ev) => {
      const reason = ev && ev.reason;
      let msg = "";
      try {
        msg = reason && reason.message ? reason.message : String(reason);
      } catch (e) {}
      if (msg.includes("A listener indicated an asynchronous response")) {
        ev.preventDefault();
      }
    });
  }

  installConsoleNoiseFilter();

  const BUTTON_ID = "my-yt-transcript-button";
  const CHAPTER_BTN_CLS = "my-yt-chapter-copy";
  const CHAPTER_HAS_BTN = "my-yt-chapter-has-btn";
  // Set on a chapter row while its badge is a pill (a count, or a count and the
  // share copied), so the row can reserve the room the pill takes. content.css
  // turns the class into `padding-inline-end: var(BADGE_ROOM_VAR)`; the width is
  // measured off the rendered badge (see reserveBadgeRoom) because it depends on
  // the label, the digit set and the font.
  const BADGE_PILL_CLS = "my-yt-chapter-pill";
  const BADGE_ROOM_VAR = "--my-yt-badge-room";
  // Between the pill and the text it must not touch: the badge's own 6px inset
  // (content.css) plus a little air.
  const BADGE_ROOM_GAP = 10;
  const PLAYER_BTN_ID = "my-yt-player-chapter-btn";
  const DEBUG_OVERLAY_ID = "my-yt-debug-overlay";
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  // Cache of parsed chapter data, keyed by video id
  let chaptersCache = { videoId: null, chapters: null };

  // Rows that were on screen in YouTube's transcript panel when the page began
  // navigating. The panel outlives an in-page navigation and keeps the previous
  // video's rows until YouTube repopulates it, so this snapshot is what lets a
  // later panel scrape recognise those rows as stale. See
  // ensureFreshTranscriptPanel().
  let panelRowsAtNav = null;

  // TWO INDEPENDENT BATCHERS, each with its own unit of work and its own size
  // numbers. Neither may borrow the other's constants:
  //
  //   * the main Transcript button is a batch service over the WHOLE video. It
  //     never consults the chapter list and never labels a part with a chapter
  //     title - its only unit is the transcript itself, so a 19-hour chaptered
  //     video batches by size exactly like a chapterless one.
  //   * every chapter (and the player badge for the chapter playing right now)
  //     is its own parent node: it batches its own chapter and nothing else.
  //
  // The ONLY number this file imposes is the ceiling below: the most that may
  // go into one clipboard write. How a copy is divided into parts is NOT a
  // constant - it is derived from the rows the caption source actually
  // returned (see splitRowsIntoParts), so any transcript, whatever its size,
  // can be batched without a fixed target to hit.
  //
  // ---- main Transcript button ----
  // Above this many characters a whole-video copy is split into ordered parts
  // instead of being written in one go. Kept equal to the ceiling: past the
  // ceiling a single write is no longer safe, and below it splitting would
  // only cost the user extra clicks.
  const MAIN_CHUNK_THRESHOLD = 1000000; // characters
  // When the main button's batch mode is active, no single copied part may
  // exceed this many characters: the transcript is divided at segment
  // boundaries so every clipboard write stays manageable.
  //
  // How this number was chosen - the clipboard is NOT the constraint, so the
  // ceiling is set from the weakest link in this file instead of from clipboard
  // limits:
  //  - Chromium caps clipboard data at 256 MiB (kMaxClipboardSize in
  //    ui/base/clipboard/clipboard_win.cc, crbug.com/1164680) but applies it to
  //    READS: GetClipboardDataWithLimit() refuses anything larger, while
  //    WriteText() allocates and sets the data with no size test at all.
  //  - Windows itself has no pre-set clipboard maximum, only available memory
  //    (the failure mode for enormous payloads is the 30 s delay-render
  //    timeout, which cannot apply here: the text is written eagerly with
  //    SetClipboardData).
  //  - navigator.clipboard.writeText documents no size limit; the only failure
  //    it names is NotAllowedError, which is about permission, secure context
  //    and focus, not length.
  //  - The one size-sensitive route is the execCommand fallback in
  //    copyTextToClipboard(), which lays the string out in a hidden textarea
  //    first and has been reported to struggle from roughly 180k characters
  //    (Chrome 55 era). It only runs when writeText is unavailable, and a
  //    write it rejects is not a dead end: copyRowsWithSplitFallback() - and
  //    the main path's retry - turn the same text into an ordered part
  //    sequence, so an oversized chunk degrades into more, smaller chunks
  //    instead of failing the copy.
  // 1M characters is ~2 MB as UTF-16 and ~0.4% of the 256 MiB read cap. The
  // value is bounded by memory rather than by the clipboard, and extensions
  // load on phones too (Firefox for Android, Kiwi and friends), where the
  // async clipboard path is the same API - a couple of megabytes is fine to
  // hold and write there.
  //
  // The only way a part may exceed this is when it holds a single segment that
  // is longer than the ceiling on its own - a caption is never cut in half, and
  // dropping or truncating it would lose text. test/test_chunks.mjs enforces
  // both pairs and the partition itself.
  const MAIN_CHUNK_MAX_CHARS = 1000000; // characters
  // ---- chapter / player badges ----
  // The same scheme, sized independently: a chapter node starts splitting above
  // its own threshold and holds every part to its own ceiling, so the two
  // operations can be retuned without touching each other.
  const CHAPTER_CHUNK_THRESHOLD = 1000000; // characters
  const CHAPTER_CHUNK_MAX_CHARS = 1000000; // characters
  // Active chunk session, for the main Transcript button or for a single
  // chapter button whose chapter is too long for one clipboard write.
  // `owner` is the button that started it, so a click on a different button
  // starts a new copy instead of resuming (or hijacking) that sequence.
  let chunkSession = null;
  // Added to a copy button while a chunk session is showing an "n/N" count on
  // it. The chapter badges are 22px circles and the player badge 24px, sized for
  // a single glyph: a count does not fit inside one, so the class switches the
  // badge to the pill layout in content.css and is removed again as soon as an
  // ordinary label comes back (see setChunkLabel / resetMainButton).
  const CHUNK_LABEL_CLS = "my-yt-chunking";

  // =========================================================
  // DIAGNOSTICS (opt-in)
  // =========================================================
  // Enable with ?ytxt_debug=1 or #ytxt_debug=1 in the URL, or
  // localStorage ytxt_debug = "1" (the hash/localStorage survive YouTube's
  // URL canonicalization, which strips unknown query params).
  // When enabled, every copy operation records what the collector actually
  // did (rows collected, sweep steps, fallbacks used, source) and prints a
  // one-line console block. The latest stats are also written to the main
  // button's data-debug attribute (shared DOM), so CDP-based tests and the
  // page can read them back for issue reports.
  const lastStats = {
    label: "",
    source: "none",   // "panel" | "captions" | "chunks"
    rows: 0,          // rows that made it into the copied text
    panelRows: 0,     // rows the panel collector gathered
    sweep: false,     // repair sweep ran
    sweepSteps: 0,    // scroll steps the repair sweep took
    incomplete: false, // collector flagged missing segments
    fallbacks: 0,     // caption-fetch fallback invocations
    range: "",
    durationMs: 0,
    capFail: null, // why fetchCaptionsFallback returned null, if it did
    capRetries: 0, // how many times the caption fetch was retried
    capSource: null, // which caption source produced rows: "timedtext" | "getpanel" | "innertube"
    capLang: null, // language of the rows that source returned ("ar", "ar-EG", ...)
    capLangMismatch: false, // a requested ytxt_lang could not be honored by the source that answered
    staleBlob: null, // id of a page player response ignored for belonging to another video
    progress: null, // share of the whole transcript copied after this part (chunk sessions)
    error: null,
  };
  let debugEnabled = null;
  // Timestamp of the current copy operation's start (set by resetStats, read
  // by logStats) so the debug report's durationMs is actually measured.
  let statsStartedAt = 0;
  function isDebugEnabled() {
    if (debugEnabled === null) {
      try {
        const inSearch = new URLSearchParams(window.location.search).get("ytxt_debug") === "1";
        const inHash = window.location.hash.includes("ytxt_debug=1");
        debugEnabled = inSearch || inHash || localStorage.getItem("ytxt_debug") === "1";
      } catch (e) {
        debugEnabled = false;
      }
    }
    return debugEnabled;
  }
  function resetStats(label) {
    statsStartedAt = Date.now();
    Object.assign(lastStats, {
      label,
      source: "none",
      rows: 0,
      panelRows: 0,
      sweep: false,
      sweepSteps: 0,
      incomplete: false,
      fallbacks: 0,
      range: "",
      durationMs: 0,
      capFail: null,
      capRetries: 0,
      capSource: null,
      capLang: null,
      capLangMismatch: false,
      staleBlob: null,
      progress: null,
      error: null,
    });
  }
  function logStats() {
    if (!isDebugEnabled()) return;
    const s = lastStats;
    s.durationMs = Date.now() - statsStartedAt;
    console.info(
      `[YT-Transcript] ${s.label} ` +
        `source=${s.source} rows=${s.rows} panelRows=${s.panelRows} ` +
        `sweep=${s.sweep ? "yes(" + s.sweepSteps + ")" : "no"} incomplete=${s.incomplete} ` +
        `fallbacks=${s.fallbacks}${s.capSource ? " capSource=" + s.capSource : ""}${s.capLang ? " capLang=" + s.capLang : ""}${s.capLangMismatch ? " capLangMismatch=yes" : ""}${s.capRetries ? " retries=" + s.capRetries : ""} range=${s.range} ${s.durationMs}ms` +
        (s.progress === null || s.progress === undefined ? "" : ` progress=${s.progress}%`) +
        (s.capFail ? ` capFail=${JSON.stringify(s.capFail)}` : "") +
        (s.staleBlob ? ` staleBlob=${s.staleBlob}` : "") +
        (s.error ? ` error=${JSON.stringify(s.error)}` : "")
    );
    const btn = document.getElementById(BUTTON_ID);
    if (btn) {
      btn.setAttribute(
        "data-debug",
        JSON.stringify({ ...s, video: currentVideoId() })
      );
    }
    updateStatsOverlay();
  }

  // Shows the latest collector stats in a small on-page overlay (debug mode
  // only) with a button that copies the full report as JSON, so non-developers
  // can paste it into a bug report without opening the console.
  function updateStatsOverlay() {
    if (!isDebugEnabled()) return;
    const s = lastStats;
    // The label can embed a chapter title - "Chapter: المقدمة" - and this is one
    // long display-only line, so the value is isolated to keep the bidi
    // algorithm from reordering the diagnostics around it. The JSON below is
    // deliberately NOT isolated: it is what the Copy report button puts on the
    // clipboard and has to stay byte-identical for tooling.
    const summary =
      `${isolateRtl(s.label)} — source=${s.source} rows=${s.rows} panelRows=${s.panelRows} ` +
      `sweep=${s.sweep ? "yes(" + s.sweepSteps + ")" : "no"} incomplete=${s.incomplete} ` +
      `fallbacks=${s.fallbacks}${s.capSource ? " capSource=" + s.capSource : ""}${s.capRetries ? " retries=" + s.capRetries : ""} range=${s.range} ${s.durationMs}ms` +
      (s.progress === null || s.progress === undefined ? "" : ` progress=${s.progress}%`) +
      (s.capFail ? ` capFail=${s.capFail}` : "") +
      (s.staleBlob ? ` staleBlob=${s.staleBlob}` : "") +
      (s.error ? ` error=${s.error}` : "");
    const report = JSON.stringify({ ...s, video: currentVideoId() }, null, 1);

    let overlay = document.getElementById(DEBUG_OVERLAY_ID);
    if (!overlay) {
      overlay = document.createElement("div");
      overlay.id = DEBUG_OVERLAY_ID;

      const head = document.createElement("div");
      head.className = "my-yt-debug-head";
      const title = document.createElement("span");
      title.className = "my-yt-debug-title";
      title.textContent = t("debug.title");
      const copyBtn = document.createElement("button");
      copyBtn.type = "button";
      copyBtn.className = "my-yt-debug-copy";
      copyBtn.textContent = t("debug.copy");
      copyBtn.addEventListener("click", async (e) => {
        e.stopPropagation();
        try {
          await copyTextToClipboard(overlay.__report || "");
          copyBtn.textContent = t("debug.copied");
          setTimeout(() => (copyBtn.textContent = "📋 Copy report"), 1500);
        } catch (err) {
          copyBtn.textContent = t("debug.failed");
          setTimeout(() => (copyBtn.textContent = "📋 Copy report"), 1500);
        }
      });
      const closeBtn = document.createElement("button");
      closeBtn.type = "button";
      closeBtn.className = "my-yt-debug-close";
      closeBtn.textContent = "✕";
      closeBtn.title = t("debug.closeTip");
      closeBtn.addEventListener("click", () => overlay.remove());
      head.append(title, copyBtn, closeBtn);

      const sum = document.createElement("div");
      sum.className = "my-yt-debug-summary";
      const pre = document.createElement("pre");
      pre.className = "my-yt-debug-json";
      overlay.append(head, sum, pre);
      document.body.appendChild(overlay);
    }
    overlay.querySelector(".my-yt-debug-summary").textContent = summary;
    overlay.querySelector(".my-yt-debug-json").textContent = report;
    overlay.__report = report;
  }

  // =========================================================
  // UTILITIES
  // =========================================================
  function currentVideoId() {
    const params = new URLSearchParams(window.location.search);
    return params.get("v") || "";
  }

  // Timestamps in this extension are *display* strings - read out of the DOM or
  // out of a localized API response - and YouTube renders those in the digits of
  // the page's own locale: an Arabic page shows "٥:٠٨" and a Persian one "۵:۰۸",
  // neither of which the plain \d pattern in parseTimecode matches. Every such
  // row used to be dropped silently (a panel scrape collected nothing, a
  // chapter list resolved to no chapters at all). Folding those two digit
  // ranges down to ASCII is lossless where they cannot occur and is what makes
  // a localized page readable.
  //
  // Both ranges are ten consecutive code points starting at a multiple of 16
  // (U+0660 and U+06F0), so `& 0xf` is the digit's value. Bidi controls are
  // replaced by a SPACE rather than deleted: the fold must preserve the
  // string's length because chaptersFromDescriptionText() slices a title out of
  // the original line by the match offset of its folded copy. A space is also
  // the safe substitution for the matchers here - parseTimecode's regex is
  // unanchored, so a mark turned into a space before the timecode still
  // matches.
  function foldDigits(text) {
    return String(text == null ? "" : text)
      .replace(/[\u200e\u200f\u061c]/g, " ")
      .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) & 0xf));
  }

  // "1:02:03" / "2:42" / "0:07" / "(0:07)" -> seconds.
  // Accepts the same timecode in Arabic-Indic or Persian-Indic digits.
  function parseTimecode(text) {
    if (!text) return null;
    const folded = foldDigits(text);
    const m = folded.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
    if (!m) {
      const secOnly = folded.match(/(\d{1,4})\s*s/);
      return secOnly ? parseInt(secOnly[1], 10) : null;
    }
    const h = m[1] ? parseInt(m[1], 10) : 0;
    return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
  }

  function parseISO8601Duration(iso) {
    if (!iso) return null;
    const m = String(iso).match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
    if (!m) return null;
    return (parseInt(m[1] || 0, 10) * 3600) + (parseInt(m[2] || 0, 10) * 60) + parseInt(m[3] || 0, 10);
  }

  function getVideoDuration() {
    const meta = document.querySelector('meta[itemprop="duration"]');
    if (meta) {
      const d = parseISO8601Duration(meta.getAttribute("content"));
      if (d) return d;
    }
    const tEl = document.querySelector(".ytp-time-duration");
    if (tEl) {
      const d = parseTimecode(tEl.textContent);
      if (d) return d;
    }
    const video = document.querySelector("video");
    if (video && video.duration && isFinite(video.duration) && video.duration > 0) {
      return Math.floor(video.duration);
    }
    return null;
  }

  function cleanSegmentText(text) {
    return String(text || "").replace(/\s+/g, " ").trim();
  }

  // =========================================================
  // NUMERALS IN THE UI (chunk counters)
  // =========================================================
  // The chunk counters ("1/3") are chrome, not content, and YouTube localizes
  // its own numerals - an Arabic-UI page shows "٣" where an English one shows
  // "3". These counters follow the page's language for the same reason the
  // transcript follows the video's: the labels should not look foreign next to
  // YouTube's own UI. Intl decides which digit set a locale uses, so there is no
  // hand-rolled digit table here.
  //
  // Two things Intl alone gets wrong for this purpose:
  //  - `new Intl.NumberFormat("ar")` resolves to LATIN digits; only a regioned
  //    tag (ar-EG, ar-SA) is Arabic-Indic. A page's <html lang> very often
  //    carries no region, so the language-only tags whose regions commonly use
  //    non-Latin digits are pinned below.
  //  - The Maghreb (ar-MA / ar-DZ / ar-TN) does use Latin digits, which is why
  //    a regioned tag is always left to Intl.
  //
  // Which language those numerals come from, most specific first:
  // `ytxt_numerals` ("latn" | "arab" | "arabext") > an explicit `ytxt_ui` > the
  // page's own language.
  //
  // Deliberately NOT applied to the copied transcript's "part i/N" markers
  // (content, and it has to stay greppable) or to the debug report's field
  // values (they have to stay comparable between users).
  const DEFAULT_NUMBERING = {
    ar: "arab", // ٠١٢٣٤٥٦٧٨٩
    ur: "arabext", // ۰۱۲۳۴۵۶۷۸۹
  };
  const numberFormats = new Map();
  function pageLocale() {
    try {
      const lang = document.documentElement && document.documentElement.getAttribute("lang");
      if (lang) return lang;
    } catch (e) {}
    try {
      if (navigator.language) return navigator.language;
    } catch (e) {}
    return "en";
  }
  function numberingOverride() {
    try {
      if (typeof localStorage !== "undefined") {
        const v = localStorage.getItem("ytxt_numerals");
        if (v && String(v).trim()) return String(v).trim().toLowerCase();
      }
    } catch (e) {}
    return "";
  }
  // One formatter per (locale, override), built lazily and kept: the page's
  // language does not change without a navigation, and the map is tiny.
  function uiNumberFormat() {
    const locale = uiLocale();
    const override = numberingOverride();
    const key = locale + "|" + override;
    if (numberFormats.has(key)) return numberFormats.get(key);
    let fmt = null;
    try {
      const resolved = new Intl.NumberFormat(locale).resolvedOptions().numberingSystem;
      const primary = String(locale).toLowerCase().split(/[-_]/)[0];
      // The pin only applies to a REGION-LESS tag: "ar" has no region to speak
      // for it, while "ar-MA" is an explicit statement (that is the Maghreb
      // chose Latin digits) and must win over the language-level guess.
      const regionLess = !/[-_]/.test(locale);
      const want =
        override ||
        (regionLess && resolved === "latn" && DEFAULT_NUMBERING[primary]) ||
        resolved ||
        "latn";
      fmt = new Intl.NumberFormat(locale, { numberingSystem: want });
    } catch (e) {
      // Unknown locale or numbering system: fall back to plain digits.
      fmt = null;
    }
    numberFormats.set(key, fmt);
    return fmt;
  }
  // "3", or "1/3" in the page's numerals. The slash is kept between the two
  // numbers (not localized): it is the count's own syntax, and both numbers
  // being one run is what keeps them reading left-to-right in an RTL context.
  function countText(n, total) {
    const one = (v) => {
      if (typeof v !== "number" || !isFinite(v)) return String(v);
      const fmt = uiNumberFormat();
      try {
        return fmt ? fmt.format(v) : String(v);
      } catch (e) {
        return String(v);
      }
    };
    return total === undefined ? one(n) : one(n) + "/" + one(total);
  }
  // "43%", localized exactly the way the counts are - same locale, same
  // numbering system - so a percentage is never in a different digit set from
  // the count beside it (an Arabic page shows "٤٣٪", not "43%"). Intl also
  // supplies the locale's own percent sign, which is not always "%".
  function percentText(percent) {
    const pct = Number(percent);
    if (!isFinite(pct)) return "";
    const locale = uiLocale();
    try {
      const fmt = uiNumberFormat();
      const numberingSystem = fmt ? fmt.resolvedOptions().numberingSystem : null;
      return new Intl.NumberFormat(locale, {
        style: "percent",
        maximumFractionDigits: 0,
        ...(numberingSystem ? { numberingSystem } : {}),
      }).format(pct / 100);
    } catch (e) {
      return Math.round(pct) + "%";
    }
  }

  // =========================================================
  // BIDI (RTL) GUARD FOR UI STRINGS
  // =========================================================
  // Strings that embed *user content* inside a fixed English sentence - the
  // button tooltips ("Copy transcript of chapter: <title>") and the chunk
  // session's instruction - are reordered by the bidi algorithm when the
  // embedded value is right-to-left: the sentence itself is LTR, but an Arabic
  // or Hebrew run can drag the surrounding punctuation with it, so
  // "Copy transcript of chapter: المقدمة" can render with its separator on the
  // wrong side or the title split around the colon. Wrapping just the VALUE in
  // an FSI/PDI isolate (U+2068/U+2069) pins it as one unit whose direction comes
  // from its own first strong character, and leaves an LTR value byte-identical.
  //
  // This is applied only to strings that are *displayed* or read as a tooltip.
  // Copied transcript text and the machine-readable debug report are never put
  // through it: control characters there would corrupt the output.
  const RTL_RE = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
  function isolateRtl(value) {
    const s = String(value == null ? "" : value);
    return RTL_RE.test(s) ? "\u2068" + s + "\u2069" : s;
  }

  // =========================================================
  // UI STRINGS (optional label table)
  // =========================================================
  // These labels are chrome, not content, so `ytxt_ui` picks the language they
  // are written in:
  //   localStorage.setItem("ytxt_ui", "ar")   // Arabic
  //   localStorage.setItem("ytxt_ui", "auto") // follow the page's language
  //   localStorage.removeItem("ytxt_ui")      // English (the default)
  // (also settable as #ytxt_ui=ar on the video URL). This is a different
  // question from `ytxt_lang`, which chooses the CAPTION language: a German user
  // may well want German buttons around an English transcript, and vice versa.
  //
  // A key missing from a table falls back to English, so a partial table is
  // always safe - including one a user adds for a language that is not built in:
  //   localStorage.setItem("ytxt_ui_strings", JSON.stringify({
  //     de: { "button.idle": "📜 Transkript" }
  //   }))
  //
  // Deliberately not in the table: the debug report's field names and values.
  // Those stay ASCII so reports remain comparable between users - only the human
  // `label.*` entries are translated.
  const UI_STRINGS = {
    en: {
      "button.idle": "📜 Transcript",
      "button.copying": "⏳ Copying...",
      "button.copied": "✓ Copied!",
      "button.failed": "❌ Failed",
      "button.chunkCopying": "⏳ {count}",
      "button.chunkNext": "⏭ Copy {count} · {pct}",
      "button.chunkAll": "✓ All chunks copied!",
      "badge.copying": "⏳",
      "badge.copied": "✓",
      "badge.failed": "✗",
      "badge.hardFailed": "❌",
      "badge.chunkCopying": "⏳{count}",
      "badge.chunkNext": "⏭{count} · {pct}",
      "chapter.tip": "Copy transcript of chapter: {title}",
      "chapter.noTitleTip": "Copy transcript of this chapter",
      "player.tip": "Copy transcript of current chapter: {title}",
      "player.noChapterTip": "Copy transcript of current chapter",
      "chunk.instruction": "Paste chunk {n} ({title}) somewhere first, then click again to copy chunk {next} ({nextTitle}).",
      "chunk.progress": "{pct} of the transcript copied so far.",
      "label.full": "Full transcript",
      "label.chapter": "Chapter: {title}",
      "label.chapterGeneric": "Chapter",
      "label.chunk": "Chunk {n}/{total}",
      "debug.title": "YT-Transcript debug",
      "debug.copy": "📋 Copy report",
      "debug.copied": "✓ Copied",
      "debug.failed": "✗ Failed",
      "debug.closeTip": "Hide debug overlay",
      "error.noButton": "Transcript button not found (does this video have captions?)",
      "error.panelTimeout": "Transcript panel did not open.",
      "error.panelStale":
        "The transcript panel is still showing the previous video. Open the transcript manually, then try again.",
      "error.noRange": "No transcript found for this chapter range.",
      "error.incomplete": "Transcript loaded incompletely; please try again.",
      "error.noText": "No transcript text was loaded.",
      "error.clipboard": "Clipboard write failed.",
      "error.chapterCopy": "Could not copy this chapter's transcript.",
      "error.captionSources": "Caption sources all failed:",
    },
    ar: {
      "button.idle": "📜 النص",
      "button.copying": "⏳ جارٍ النسخ...",
      "button.copied": "✓ تم النسخ!",
      "button.failed": "❌ فشل النسخ",
      "button.chunkCopying": "⏳ {count}",
      "button.chunkNext": "⏭ نسخ {count} · {pct}",
      "button.chunkAll": "✓ تم نسخ كل الأجزاء!",
      "badge.copying": "⏳",
      "badge.copied": "✓",
      "badge.failed": "✗",
      "badge.hardFailed": "❌",
      "badge.chunkCopying": "⏳{count}",
      "badge.chunkNext": "⏭{count} · {pct}",
      "chapter.tip": "نسخ نص الفصل: {title}",
      "chapter.noTitleTip": "نسخ نص هذا الفصل",
      "player.tip": "نسخ نص الفصل الحالي: {title}",
      "player.noChapterTip": "نسخ نص الفصل الحالي",
      "chunk.instruction": "الصق الجزء {n} ({title}) في مكان ما أولًا، ثم انقر مرة أخرى لنسخ الجزء {next} ({nextTitle}).",
      "chunk.progress": "تم نسخ {pct} من النص حتى الآن.",
      "label.full": "النص الكامل",
      "label.chapter": "الفصل: {title}",
      "label.chapterGeneric": "فصل",
      "label.chunk": "الجزء {n}/{total}",
      "debug.title": "تصحيح YT-Transcript",
      "debug.copy": "📋 نسخ التقرير",
      "debug.copied": "✓ تم النسخ",
      "debug.failed": "✗ فشل",
      "debug.closeTip": "إخفاء نافذة التصحيح",
      "error.noButton": "لم يُعثر على زر النص (هل يحتوي هذا الفيديو على ترجمات؟)",
      "error.panelTimeout": "لم تُفتح لوحة النص.",
      "error.panelStale": "ما زالت لوحة النص تعرض الفيديو السابق. افتح النص يدويًا ثم أعد المحاولة.",
      "error.noRange": "لا يوجد نص لهذا النطاق من الفصل.",
      "error.incomplete": "تم تحميل النص بشكل غير مكتمل؛ يُرجى المحاولة مرة أخرى.",
      "error.noText": "لم يتم تحميل أي نص.",
      "error.clipboard": "فشلت الكتابة إلى الحافظة.",
      "error.chapterCopy": "تعذّر نسخ نص هذا الفصل.",
      "error.captionSources": "فشلت جميع مصادر الترجمة:",
    },
  };

  const uiTables = new Map();

  // The language the chrome is in - which is also the language the counters are
  // numbered in: Arabic wording next to ASCII digits looks broken, so an
  // explicit `ytxt_ui` carries the numerals with it. With "auto" (or nothing)
  // the page's own language decides, and `ytxt_numerals` is more specific than
  // either and wins over both.
  function uiLocale() {
    const pref = uiPref();
    if (pref && pref !== "auto") return pref;
    return pageLocale();
  }

  function uiPref() {
    try {
      if (typeof localStorage !== "undefined") {
        const v = localStorage.getItem("ytxt_ui");
        if (v && String(v).trim()) return String(v).trim().toLowerCase();
      }
    } catch (e) {}
    try {
      const hash = String(
        (typeof window !== "undefined" && window.location && window.location.hash) || ""
      );
      const m = hash.match(/ytxt_ui=([A-Za-z][A-Za-z-]{0,15})/);
      if (m) return m[1].toLowerCase();
    } catch (e) {}
    return "";
  }

  const normalizeLang = (code) =>
    String(code || "").toLowerCase().replace(/_/g, "-").split("-")[0];

  // User-supplied tables, so a language that is not built in can be added
  // without editing this file: { "de": { "button.idle": "..." } }
  function customUiStrings() {
    try {
      if (typeof localStorage !== "undefined") {
        const raw = localStorage.getItem("ytxt_ui_strings");
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === "object") return parsed;
        }
      }
    } catch (e) {}
    return null;
  }

  // The active table: English underneath (so a partial translation is always
  // safe), the built-in table for the language over it, and the user's own
  // entries last so they can override any single label.
  function uiTable() {
    const pref = uiPref();
    const lang = pref === "auto" ? normalizeLang(pageLocale()) : normalizeLang(pref) || "en";
    if (uiTables.has(lang)) return uiTables.get(lang);
    const custom = customUiStrings();
    const own = (custom && custom[lang] && typeof custom[lang] === "object" && custom[lang]) || {};
    const merged = { ...UI_STRINGS.en, ...(UI_STRINGS[lang] || {}), ...own };
    uiTables.set(lang, merged);
    return merged;
  }

  // Look up a label and fill in its {placeholders}. A key that has no
  // translation - in a language with no table at all, or in a partial one -
  // falls back to English; only a typo can reach the key itself.
  function t(key, vars) {
    const raw = uiTable()[key];
    if (typeof raw !== "string") return key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (m, name) =>
      Object.prototype.hasOwnProperty.call(vars, name) ? String(vars[name]) : m
    );
  }

  // =========================================================
  // PAGE DATA (ytInitialData / ytInitialPlayerResponse)
  // =========================================================
  function extractBalancedJson(text, start) {
    // text[start] must be "{"
    let depth = 0;
    let inStr = false;
    let esc = false;
    for (let i = start; i < text.length; i++) {
      const c = text[i];
      if (inStr) {
        if (esc) esc = false;
        else if (c === "\\") esc = true;
        else if (c === '"') inStr = false;
        continue;
      }
      if (c === '"') inStr = true;
      else if (c === "{") depth++;
      else if (c === "}") {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      } else if (c === "<" && text.startsWith("</script", i)) {
        return null;
      }
    }
    return null;
  }

  function readPageVarUncached(name) {
    // Looks for: var ytInitialData = {...};  or  window["ytInitialData"] = {...};
    const scripts = document.querySelectorAll("script");
    for (const sc of scripts) {
      const t = sc.textContent || "";
      let idx = t.indexOf(`var ${name} =`);
      if (idx < 0) idx = t.indexOf(`window["${name}"] =`);
      if (idx < 0) continue;
      const brace = t.indexOf("{", idx + name.length);
      if (brace < 0) continue;
      const jsonText = extractBalancedJson(t, brace);
      if (!jsonText) continue;
      try {
        return JSON.parse(jsonText);
      } catch (e) {
        // try next script
      }
    }
    return null;
  }

  // Parsed page variables, memoized per (video id, name).
  //
  // Reading one means walking every <script> on the page and JSON-parsing a
  // blob that runs to several megabytes, and the chapter lookup asks for them
  // on a 400 ms tick - repeatedly, because a video with no chapters never
  // populates the chapter cache. The video id is part of the key, so an
  // in-page navigation cannot be served the previous video's payload from
  // here. A blob that parses to nothing is NOT cached, so the "page is still
  // loading, try again next tick" path keeps working.
  const pageVarCache = new Map();

  function readPageVar(name) {
    const videoId = currentVideoId();
    const key = videoId + "|" + name;
    if (pageVarCache.has(key)) return pageVarCache.get(key);
    const data = readPageVarUncached(name);
    if (data) {
      // Keep only the current video's blobs; the rest can only be stale.
      for (const k of [...pageVarCache.keys()]) {
        if (!k.startsWith(videoId + "|")) pageVarCache.delete(k);
      }
      pageVarCache.set(key, data);
    }
    return data;
  }

  // =========================================================
  // WHICH VIDEO IS PLAYING? (in-page navigation / staleness guard)
  // =========================================================
  // YouTube is a single-page app. The inline `ytInitialData` and
  // `ytInitialPlayerResponse` scripts are written once, on the first hard
  // load, and are NOT rewritten when the page moves to another video
  // (playlist next/previous, a related-video click, a chapter link). Reading
  // them after such a navigation therefore yields the PREVIOUS video's
  // payload - the old caption tracks and the old chapters - which is exactly
  // how the transcript of the video you already left gets copied until the
  // browser is refreshed.
  //
  // Rule: the URL is the only trustworthy statement of which video is
  // playing. A page-data blob is used only when it can be shown to belong to
  // that video; otherwise it is ignored and the caller falls through to the
  // sources built from the URL's video id (get_panel / get_transcript) or to
  // the live DOM, both of which are always current.

  // The video id a page-data blob claims to describe, per blob shape.
  function blobVideoId(name, data) {
    if (!data) return "";
    if (name === "ytInitialData") {
      return data?.currentVideoEndpoint?.watchEndpoint?.videoId || "";
    }
    return data?.videoDetails?.videoId || "";
  }

  // A blob may be used when it proves it belongs to the video in the URL, or
  // when it names no video at all (nothing to contradict). A blob that names
  // a DIFFERENT video is the previous video's and must not be trusted.
  function blobIsCurrent(name, data) {
    const urlId = currentVideoId();
    if (!urlId) return true; // not a watch page - nothing to compare against
    const id = blobVideoId(name, data);
    return !id || id === urlId;
  }

  function pageDataForCurrentVideo(name) {
    const data = readPageVar(name);
    if (!blobIsCurrent(name, data)) return null;
    return data;
  }

  // The player response for the video that is playing right now. The player
  // element keeps its own current response and YouTube updates it on every
  // in-page navigation, so it is preferred whenever the JS world exposes it
  // (userscript / page world). An MV3 content script runs in an isolated
  // world where page-defined element properties and methods are invisible, so
  // absence there is expected rather than an error: the caller then relies on
  // the URL-built sources instead of falling back to a stale blob.
  function livePlayerResponse() {
    const candidates = [];
    try {
      const player = document.getElementById("movie_player");
      if (player && typeof player.getPlayerResponse === "function") {
        candidates.push(player.getPlayerResponse());
      }
    } catch (e) {}
    try {
      const flexy = document.querySelector("ytd-watch-flexy");
      if (flexy && flexy.playerData) candidates.push(flexy.playerData);
    } catch (e) {}
    for (const c of candidates) {
      if (c && c.videoDetails && blobIsCurrent("ytInitialPlayerResponse", c)) {
        return c;
      }
    }
    const pr = pageDataForCurrentVideo("ytInitialPlayerResponse");
    return pr && pr.videoDetails ? pr : null;
  }

  // =========================================================
  // CHAPTERS
  // =========================================================
  // Chapters show up in BOTH ytInitialData.playerOverlays... and
  // ytInitialPlayerResponse.playerOverlays..., under a markersMap whose
  // key is DESCRIPTION_CHAPTERS. Each chapterRenderer has a title and a
  // timeRangeStartMillis.
  function chaptersFromPageData(data) {
    if (!data) return null;
    const markersMap = data?.playerOverlays?.playerOverlayRenderer
      ?.decoratedPlayerBarRenderer?.decoratedPlayerBarRenderer?.playerBar
      ?.multiMarkersPlayerBarRenderer?.markersMap;
    if (!markersMap) return null;
    for (const entry of markersMap) {
      const chapters = entry?.value?.chapters;
      if (Array.isArray(chapters) && chapters.length) {
        const parsed = chapters
          .map((c) => c?.chapterRenderer)
          .filter(Boolean)
          .map((r) => ({
            title: r.title?.simpleText ?? r.title?.runs?.map((x) => x.text).join("") ?? "",
            start: Math.round((r.timeRangeStartMillis || 0) / 1000),
          }))
          .filter((c) => c.start >= 0);
        if (parsed.length) return parsed;
      }
    }
    return null;
  }

  // Fallback: parse chapter-like lines from the raw description text.
  // e.g. "⌨️ (0:02:42) Learn HTML" or "0:00 Intro".
  // Scoped to the description itself - scanning the whole watch metadata
  // blob matched stray timestamps (view counts, durations) as "chapters".
  function chaptersFromDescriptionText() {
    const scopes = [
      document.querySelector("#description"),
      document.querySelector("ytd-structured-description-content-renderer"),
    ].filter(Boolean);
    const full = scopes.map((el) => el.textContent || "").join("\n");
    if (!full) return null;

    const lines = full.split("\n");
    const out = [];
    // Lines such as: "⌨️ (0:02:42) Learn HTML", "0:00 Intro", "(1:26:27) Learn CSS"
    const re = /(?:^|[\s(（])(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\s*[)\u2029]?[\s\u00a0:—-]*(.+)$/;
    for (const line of lines) {
      // The timecode is matched on a digit-folded copy of the line, so an
      // Arabic- or Persian-locale description ("٠٠:٠٠ المقدمة") parses too.
      // foldDigits() preserves length, so the title is still sliced out of the
      // ORIGINAL line (it keeps whatever digits it contains) using the folded
      // match's offset.
      const m = foldDigits(line).match(re);
      if (!m) continue;
      const start = (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
      // Strip only leading punctuation/marks (the ⌨️ / "(0:07)" decoration).
      // The old /^[^a-zA-Z0-9]+/ deleted an Arabic-only title ENTIRELY - every
      // character of it is "not alphanumeric" by that class - and the chapter
      // was then dropped as empty. \p{L}\p{N} keeps any script's letters.
      const title = line.slice(line.length - m[4].length).replace(/^[^\p{L}\p{N}]+/u, "").trim();
      // Reject bare-number matches (e.g. "1:26 27 views" style fragments).
      if (!title || title.length <= 1 || /^\d+$/.test(foldDigits(title))) continue;
      out.push({ title, start });
    }
    if (out.length < 2) return null;
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // Fallback: read the rendered Chapters shelf/list cards. These mirror the
  // player's own chapters (each chapter appears once per shelf copy, and the
  // shelf is sometimes rendered multiple times), so entries are deduped by
  // start time. This is authoritative and works even in sessions where the
  // page's JSON variables can't be parsed.
  function chaptersFromChapterShelf() {
    const out = [];
    const seen = new Set();
    const items = document.querySelectorAll(
      "ytd-macro-markers-list-item-renderer, ytd-video-description-chapter-thumbnail-renderer"
    );
    for (const item of items) {
      const timeEl = item.querySelector("#time, .segment-timestamp");
      const start = timeEl ? parseTimecode(timeEl.textContent) : null;
      if (start === null || start < 0 || seen.has(start)) continue;
      const h = item.querySelector("h3[title], .chapter-title, h3.macro-markers");
      const title = h
        ? cleanSegmentText(h.getAttribute("title") || h.textContent)
        : "";
      // Fold before the bare-number test, so a title that is *only* a number in
      // Arabic-Indic or Persian-Indic digits is rejected the same way as "27".
      if (!title || title.length <= 1 || /^\d+$/.test(foldDigits(title))) continue;
      seen.add(start);
      out.push({ title, start });
    }
    if (out.length < 2) return null;
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  function getChapters() {
    const videoId = currentVideoId();
    if (chaptersCache.videoId === videoId && chaptersCache.chapters) {
      return chaptersCache.chapters;
    }
    let chapters =
      // Live first: the player's own response is updated on every in-page
      // navigation and is checked against the video id in the URL, so a
      // playlist jump cannot yield the previous video's chapters.
      chaptersFromPageData(livePlayerResponse()) ||
      // The rendered chapter shelf is live DOM, so it is never stale.
      chaptersFromChapterShelf() ||
      // Page-data blobs, accepted only when they belong to this video.
      chaptersFromPageData(pageDataForCurrentVideo("ytInitialData")) ||
      chaptersFromPageData(pageDataForCurrentVideo("ytInitialPlayerResponse")) ||
      chaptersFromDescriptionText();
    if (!chapters || !chapters.length) {
      // Nothing found yet (page may still be loading) - try again next tick
      chaptersCache = { videoId: null, chapters: null };
      return null;
    }
    chapters.sort((a, b) => a.start - b.start);
    // End of each chapter = start of next; last chapter ends at video length
    const duration = getVideoDuration();
    for (let i = 0; i < chapters.length; i++) {
      const end = i + 1 < chapters.length ? chapters[i + 1].start : duration;
      chapters[i].end = end === null || end === undefined ? Infinity : end;
      chapters[i].end = Math.max(chapters[i].end, chapters[i].start + 1);
    }
    chaptersCache = { videoId, chapters };
    return chapters;
  }

  // =========================================================
  // FIND NATIVE TRANSCRIPT BUTTON
  // =========================================================
  function findNativeTranscriptButton() {
    return (
      document.querySelector("#description ytd-video-description-transcript-section-renderer button") ||
      document.querySelector("ytd-video-description-transcript-section-renderer button") ||
      document.querySelector('button[aria-label*="transcript" i]') ||
      document.querySelector('button[aria-label*="Transcript" i]')
    );
  }

  // =========================================================
  // FIND TRANSCRIPT PANEL
  // =========================================================
  function findTranscriptPanel() {
    return (
      document.querySelector('[target-id="engagement-panel-searchable-transcript"]') ||
      document.querySelector("ytd-transcript-search-panel-renderer") ||
      document.querySelector("ytd-transcript-renderer")
    );
  }

  // =========================================================
  // OPEN TRANSCRIPT
  // =========================================================
  async function openTranscript() {
    const existing = findTranscriptPanel();
    if (existing && existing.getAttribute("visibility") === "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED") {
      return;
    }

    let nativeButton = findNativeTranscriptButton();

    // If the button isn't in the DOM yet, expand the description first
    if (!nativeButton) {
      const expandBtn =
        document.querySelector("#description-inline-expander") ||
        document.querySelector("tp-yt-paper-button#expand") ||
        document.querySelector("#expand.ytd-text-inline-expander") ||
        document.querySelector("ytd-text-inline-expander #expand") ||
        document.querySelector("#description #expand") ||
        document.querySelector("#expand");
      const candidates = [expandBtn];
      for (const cand of candidates) {
        if (cand && !cand.hasAttribute("hidden")) {
          cand.click();
          await sleep(300);
        }
      }
    }

    for (let i = 0; i < 20; i++) {
      nativeButton = findNativeTranscriptButton();
      if (nativeButton) {
        nativeButton.click();
        return;
      }
      await sleep(250);
    }

    const hiddenPanel = document.querySelector('[target-id="engagement-panel-searchable-transcript"]');
    if (hiddenPanel) {
      hiddenPanel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED");
      return;
    }

    throw new Error(t("error.noButton"));
  }

  // =========================================================
  // WAIT FOR PANEL & TEXT
  // =========================================================
  function waitForTranscriptPanel(timeout = 10000) {
    return new Promise((resolve, reject) => {
      const existing = findTranscriptPanel();
      if (existing) return resolve(existing);

      const observer = new MutationObserver(() => {
        const panel = findTranscriptPanel();
        if (panel) {
          observer.disconnect();
          resolve(panel);
        }
      });

      observer.observe(document.body, { childList: true, subtree: true });

      setTimeout(() => {
        observer.disconnect();
        reject(new Error(t("error.panelTimeout")));
      }, timeout);
    });
  }

  // A cheap identity for the rows currently rendered in the transcript panel:
  // the row count plus the text of the leading rows - enough to tell two
  // videos' transcripts apart without walking the whole (virtualized) list.
  function panelRowSignature(panel) {
    if (!panel) return "";
    const segs = panel.querySelectorAll("ytd-transcript-segment-renderer");
    if (!segs.length) return "";
    let out = segs.length + ":";
    for (let i = 0; i < Math.min(segs.length, 8); i++) {
      out += cleanSegmentText(segs[i].textContent) + "|";
    }
    return out;
  }

  // Returns the transcript panel only once its rows are known to belong to the
  // video in the URL.
  //
  // The transcript panel is an engagement panel that survives an in-page
  // navigation: YouTube keeps the element and repopulates it asynchronously, so
  // for a short window after a playlist jump its DOM still holds the PREVIOUS
  // video's rows. Reading it then is the one remaining way the extension could
  // copy the video it just left - the caption route never touches the panel.
  // What was on screen when the navigation began is remembered in
  // `panelRowsAtNav`, so a scrape can tell those rows apart from freshly
  // rendered ones; while the rows are still the remembered ones the panel is
  // closed and re-opened, and has to actually change before its content is used.
  //
  // One assumption is left, stated so it is not mistaken for a proof: if the
  // panel was open but had rendered no rows when the navigation began, later
  // rows are accepted. The panel's content is fetched per video id, so with
  // nothing on screen there was nothing to inherit.
  async function ensureFreshTranscriptPanel(timeout = 15000) {
    const panel = findTranscriptPanel();
    const current = panelRowSignature(panel);
    const suspect = current !== "" && current === panelRowsAtNav;
    if (!suspect) return waitForTranscriptPanel(timeout);

    // Closing first matters: re-expanding the same node can leave the same rows
    // in place, whereas going back through the native button is what makes
    // YouTube fetch and render this video's transcript.
    panel.setAttribute("visibility", "ENGAGEMENT_PANEL_VISIBILITY_COLLAPSED");
    await sleep(150);
    await openTranscript();
    const fresh = await waitForTranscriptPanel(timeout);

    // Still the rows that were on screen before the navigation: the panel could
    // not be refreshed, so refuse rather than hand back content that may belong
    // to another video.
    if (panelRowSignature(fresh) === panelRowsAtNav) {
      throw new Error(t("error.panelStale"));
    }
    panelRowsAtNav = null; // the panel now provably holds this video's rows
    return fresh;
  }

  function segmentTimestamp(seg) {
    const el = seg.querySelector(".segment-timestamp") || seg.querySelector("a[href*='&t=']");
    if (!el) return null;
    return parseTimecode(el.textContent);
  }

  function segmentText(seg) {
    const el = seg.querySelector(".segment-text");
    return cleanSegmentText(el ? el.textContent : "");
  }

  // The deepest scrollable ancestor of the segments list (the element we
  // must scroll to make YouTube load more transcript segments).
  function findSegmentScroller(panel) {
    const first = panel.querySelector("ytd-transcript-segment-renderer");
    if (!first) return null;
    let el = first.parentElement;
    while (el && el !== document.body) {
      if (el.scrollHeight > el.clientHeight + 5 && el.clientHeight > 0) return el;
      el = el.parentElement;
    }
    // Fallback: any scrollable element inside the panel
    const candidates = [...panel.querySelectorAll("*")].filter(
      (n) => n.scrollHeight > n.clientHeight + 5 && n.clientHeight > 0
    );
    candidates.sort((a, b) => b.scrollHeight - a.scrollHeight);
    return candidates[0] || null;
  }

  // Caption segments for continuous speech normally start every few seconds,
  // so a gap this large between two consecutive collected segments means a
  // stretch of the transcript was probably never rendered. When detected, the
  // collector flags the result as incomplete and callers fall back to the
  // exact caption fetch instead of copying a transcript with silent holes.
  const SUSPECT_GAP_SEC = 30;

  // Scroll the open transcript until the newest loaded segment passes
  // `toSec` (or the transcript is fully loaded), collecting every segment we
  // pass. Works for very long videos because YouTube only renders a window of
  // segments at a time and loads more as you scroll.
  //
  // Completeness safeguards against silently truncated copies:
  //  - A repair sweep walks the range from the top one viewport at a time,
  //    forcing YouTube to (re)render every window, whenever the fast pass
  //    discarded DOM rows (virtualized list) or stalled before reaching
  //    `toSec` (or the video's known duration for full copies).
  //  - A final gap audit checks the collected timestamps are contiguous; if a
  //    suspicious hole remains, `collected.incomplete` is set so callers use
  //    the exact caption data instead.
  async function loadTranscriptSegments(panel, toSec = Infinity, fromSec = 0) {
    const collected = new Map();
    lastStats.range = `[${fromSec}s, ${Number.isFinite(toSec) ? toSec + "s" : "end"}]`;
    const snap = () => {
      let maxT = -1;
      const segs = panel.querySelectorAll("ytd-transcript-segment-renderer");
      for (const s of segs) {
        const t = segmentTimestamp(s);
        const txt = segmentText(s);
        if (t !== null && t >= 0 && txt) {
          const key = t + "|" + txt;
          if (!collected.has(key)) collected.set(key, { t, txt });
          if (t > maxT) maxT = t;
        }
      }
      return { dom: segs.length, size: collected.size, maxT };
    };

    let scroller = findSegmentScroller(panel);
    if (!scroller) {
      // YouTube renders the panel's segment list asynchronously after the
      // panel shell opens (and the caption chain may already have failed,
      // leaving the panel as the only source). Wait up to ~12s for the first
      // segment instead of racing ahead and returning an empty collection,
      // which would wrongly fail the copy with "no transcript found".
      for (let i = 0; i < 40 && !scroller; i++) {
        await sleep(300);
        scroller = findSegmentScroller(panel);
      }
      if (!scroller) return collected;
    }

    // For "copy everything" calls (`toSec` = Infinity) use the video's known
    // length as the reach target, so a stall caused by YouTube's list
    // virtualization is detected (and repaired) instead of silently
    // truncating the copy. (Without a known duration we keep Infinity and
    // rely on the eviction check + gap audit below.)
    let reachTarget = toSec;
    if (!Number.isFinite(reachTarget)) {
      const duration = getVideoDuration();
      if (duration && duration > 0) reachTarget = duration + 2;
    }

    // Largest gap (seconds) between consecutive collected timestamps inside
    // the requested [fromSec, toSec) range. 0 = none found.
    const biggestHole = () => {
      const rows = [...collected.values()]
        .filter((r) => r.t >= fromSec && r.t < toSec)
        .sort((a, b) => a.t - b.t);
      let worst = 0;
      for (let i = 1; i < rows.length; i++) {
        const gap = rows[i].t - rows[i - 1].t;
        if (gap > worst) worst = gap;
      }
      return worst;
    };

    // Walk the scroller from the top downward one viewport per step, snapping
    // at every position. Parking each window in the viewport forces YouTube to
    // (re)render it, so segments the fast pass skipped or discarded are
    // collected. Growth is bursty on virtualized lists (long runs of empty
    // steps while walking over already-collected rows, then new rows again),
    // so the walk only stops early when the DOM is fully materialized: if it
    // holds every row we have collected (keep-all rendering) and a few steps
    // found nothing new, the rest of the scroll can only re-render
    // already-collected content. Virtualized lists keep fewer DOM rows than
    // collected, so they walk all the way to the bottom.
    const sweepOnce = async () => {
      lastStats.sweep = true;
      scroller.scrollTop = 0;
      await sleep(250);
      let guard = 0;
      let emptySteps = 0;
      let stuck = 0;
      while (guard++ < 4000) {
        lastStats.sweepSteps++;
        const cur = snap();
        if (cur.maxT >= reachTarget) return;
        const maxTop = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
        if (cur.dom > 0 && scroller.scrollTop >= maxTop - 3) return; // bottom reached
        const beforeTop = scroller.scrollTop;
        const sizeBefore = collected.size;
        scroller.scrollTop = Math.min(scroller.scrollTop + scroller.clientHeight, maxTop);
        await sleep(120);
        const after = snap(); // collect whatever (re)rendered at the new position
        if (after.size > sizeBefore) {
          emptySteps = 0;
        } else {
          emptySteps++;
          if (emptySteps >= 3 && collected.size <= after.dom) return;
        }
        if (scroller.scrollTop === beforeTop) {
          stuck++;
          if (stuck >= 5) return;
        } else {
          stuck = 0;
        }
      }
    };

    // Phase 1 - fast forward: jump to the bottom so YouTube keeps appending
    // segments until the newest one passes `reachTarget` (or loading stalls =
    // end of the transcript).
    scroller.scrollTop = 0;
    await sleep(600);
    let prev = snap();
    let maxTSeen = prev.maxT;
    let stalls = 0;
    let guard = 0;
    while (guard++ < 3000) {
      scroller.scrollTop = scroller.scrollHeight;
      await sleep(300);
      const cur = snap();
      if (cur.maxT > maxTSeen) maxTSeen = cur.maxT;
      const bottom = scroller.scrollTop + scroller.clientHeight >= scroller.scrollHeight - 3;
      if (cur.maxT >= reachTarget) break;
      if (cur.size === prev.size && cur.dom === prev.dom && cur.maxT === prev.maxT && bottom) {
        stalls++;
        if (stalls >= 2) break;
      } else {
        stalls = 0;
      }
      prev = cur;
    }

    // Phase 2 - verify & repair: sweep from the top when YouTube discarded DOM
    // rows while we were jumping deep (fewer rows in the DOM now than we
    // collected), or when the fast pass stalled short of the target because
    // its list only renders/loads as you scroll through it.
    const domCount = panel.querySelectorAll("ytd-transcript-segment-renderer").length;
    const rowsEvicted = collected.size > domCount;
    const stalledShort = Number.isFinite(reachTarget) && maxTSeen < reachTarget - 1;
    if ((rowsEvicted || stalledShort) && (collected.size > 0 || domCount > 0)) {
      await sweepOnce();
    }

    // Phase 3 - audit: if a gap bigger than the normal speech cadence still
    // separates two collected segments in the range, some content was never
    // rendered. Flag it so callers fall back to the exact caption data. (A
    // genuinely long silent stretch triggers the same fallback, which is
    // exact, so the result is correct either way.)
    if (biggestHole() > SUSPECT_GAP_SEC) {
      collected.incomplete = true;
    }
    lastStats.panelRows = collected.size;
    lastStats.incomplete = !!collected.incomplete;
    return collected;
  }

  function collectedMaxT(collected) {
    let maxT = -1;
    for (const v of collected.values()) {
      if (v.t > maxT) maxT = v.t;
    }
    return maxT;
  }

  // Builds the ordered part list for ONE node's batch: the main Transcript
  // button's whole-video copy, or a single chapter's copy. `span` is that
  // node's own unit of work ({ title, start, end }) and `maxChars` is that
  // node's own ceiling, so each operation splits on its own numbers and no node
  // is ever cut along another node's boundaries.
  //
  // How many parts there are is DERIVED from the rows the caption source
  // actually returned (see splitRowsIntoParts) rather than from a fixed target:
  // the text is divided into as few parts as the ceiling allows and those parts
  // are then sized evenly, so a 2.1M-character transcript becomes three ~700k
  // parts instead of 1M + 1M + a 100k tail. A whole segment is never cut in
  // half; the only way a part can exceed the ceiling is by holding a single
  // segment that is longer than the ceiling on its own. Parts are numbered
  // 1..N and each starts with a self-describing title line.
  //
  // The returned parts are a LOSSLESS partition of `span`'s rows: every row
  // lands in exactly one part, in order, so the parts reassemble into the
  // source text byte for byte. That is asserted before returning - a partition
  // that would drop, duplicate or truncate text throws instead of being pasted.
  function buildChunks(span, rows, maxChars) {
    // A part marker appended to a title in an RTL script (Arabic, Hebrew, ...)
    // is reordered by the bidi algorithm against that title - the paragraph
    // direction comes from the title's first strong character, so "(part 1/3)"
    // can land on the wrong side of it and its parentheses can pair with
    // neighbouring text. Wrapping just the MARKER in an LRI/PDI isolate pins it
    // to one unambiguous unit and leaves the title's own characters untouched.
    // A Latin title is returned exactly as before, so LTR copies stay
    // byte-identical.
    const RTL_RE = /[\u0590-\u05ff\u0600-\u06ff\u0700-\u074f\u0750-\u077f\u08a0-\u08ff\ufb1d-\ufdff\ufe70-\ufeff]/;
    const partMarker = (marker, title) =>
      RTL_RE.test(title) ? "\u2066" + marker + "\u2069" : marker;
    const chunks = [];
    const spanRows = rows.filter((r) => r.t >= span.start - 0.6 && r.t < span.end);
    if (spanRows.length) {
      // A span with no title - the main button's whole-video batch is exactly
      // that - must not be labelled "Chapter 1": its parts are numbered by
      // position instead, and a single unsplit one gets no header line at all,
      // so it stays byte-identical to what was copied before.
      const title = span.title || "";
      const ceiling = maxChars > 0 ? maxChars : Infinity;
      const groups = splitRowsIntoParts(spanRows, ceiling);
      groups.forEach((g, gi) => {
        // Never joined from anything but whole segment texts: `body` is the
        // part's data and the only thing the losslessness check compares.
        const body = g.map((r) => r.txt).join(" ");
        const partTitle =
          groups.length === 1
            ? title
            : title
              ? `${title} ${partMarker(`(part ${gi + 1}/${groups.length})`, title)}`
              : `Part ${gi + 1}/${groups.length}`;
        chunks.push({
          title: partTitle,
          start: span.start,
          end: span.end,
          rowCount: g.length,
          body,
          text: partTitle ? `${partTitle}\n${body}` : body,
        });
      });
      assertLosslessPartition(chunks, spanRows, ceiling);
    }
    return chunks.map((c, i) => ({ ...c, n: i + 1 }));
  }

  // Divides one node's rows into its parts. The part SIZE comes from the data
  // that was actually returned rather than from a constant: the rows are split
  // into the fewest parts the ceiling allows (ceil(total / ceiling)) and the
  // target for each part is the text still unplaced shared over the parts still
  // to come, re-derived as we go - so a part that came in under its target
  // raises the next one's instead of leaving a stub at the end, and any size at
  // all can be batched. The target is clamped to the ceiling, so no part can
  // drift over it.
  //
  // A part is only ever closed BETWEEN segments, so a single segment longer
  // than the ceiling ends up alone in its own (necessarily oversized) part
  // rather than being cut in half. Every row is placed exactly once, in order.
  function splitRowsIntoParts(rows, ceiling) {
    const total = rowsLength(rows);
    // Fits one write (or there is no ceiling): one part, byte-identical to the
    // text a single write has always received.
    if (!(total > ceiling)) return [rows];
    let left = Math.ceil(total / ceiling);
    const groups = [];
    let cur = [];
    let curLen = 0;
    let remaining = total;
    for (const r of rows) {
      const addLen = r.txt.length + 1;
      const target = Math.min(ceiling, Math.max(1, Math.ceil(remaining / Math.max(1, left))));
      if (cur.length && curLen + addLen > target) {
        groups.push(cur);
        remaining -= curLen;
        left--;
        cur = [];
        curLen = 0;
      }
      cur.push(r);
      curLen += addLen;
    }
    if (cur.length) groups.push(cur);
    return groups;
  }

  // How big a copy is, measured the way the batcher measures it: every row
  // contributes its text plus the single space that follows it. So a part's
  // body comes out strictly under its ceiling rather than exactly at it, and
  // the callers that decide whether to batch measure their size with this same
  // function, so the decision and the split can never disagree by a character.
  function rowsLength(rows) {
    let n = 0;
    for (const r of rows) n += r.txt.length + 1;
    return n;
  }

  // Refuses a partition that is not lossless.
  //
  // The parts are a partition of the rows by construction - splitRowsIntoParts
  // pushes every row into exactly one group, in order, and nothing else ever
  // touches the text - so this can only fail if that stops being true. When it
  // does, failing loudly is the honest outcome: a copy that pasted a transcript
  // with a hole in it, or with a part repeated, would look exactly like a
  // successful copy.
  function assertLosslessPartition(chunks, rows, ceiling) {
    const source = rows.map((r) => r.txt).join(" ");
    const reassembled = chunks.map((c) => c.body).join(" ");
    const placed = chunks.reduce((n, c) => n + c.rowCount, 0);
    // A part may only exceed the ceiling when it holds one single segment that
    // is longer than the ceiling on its own: a caption is never cut in half.
    const overfull = chunks.find((c) => c.body.length > ceiling && c.rowCount > 1);
    if (reassembled !== source || placed !== rows.length || overfull) {
      throw new Error(
        "chunk partition would lose or duplicate transcript text " +
          `(rows ${placed}/${rows.length}, ` +
          `overfull=${overfull ? overfull.body.length + ">" + ceiling : "no"}) ` +
          "- refusing to copy"
      );
    }
  }

  // =========================================================
  // FALLBACK: CAPTION SOURCES, tried in order when the panel route fails:
  //   1. timedtext URL from the player response (with one retry)
  //   2. youtubei/v1/get_panel (the modern transcript panel API - returns the
  //      whole transcript in one response, works without a PO token)
  //   3. innertube youtubei/v1/get_transcript (independent of caption tracks)
  // =========================================================
  async function fetchCaptionsFallback(primary) {
    // `primary`: the caption chain is being used as the main fetch path
    // (caption sources first, panel scrape as fallback). Only count
    // invocations that rescue a failed panel route as "fallbacks" so the
    // debug report stays accurate.
    if (!primary) lastStats.fallbacks++;
    lastStats.capFail = null;
    lastStats.capRetries = 0;
    lastStats.capSource = null;

    // Fetch and parse one timedtext response. Returns { rows } on success or
    // { reason } describing why it failed.
    const fetchOnce = async (url) => {
      let res;
      try {
        res = await fetch(url.toString(), { credentials: "include" });
      } catch (e) {
        return { reason: "caption fetch threw: " + e.message };
      }
      if (!res.ok) {
        return { reason: "caption fetch http " + res.status };
      }
      let body;
      try {
        body = await res.text();
      } catch (e) {
        return { reason: "caption fetch threw: " + e.message };
      }
      if (!body.trim()) {
        // HTTP 200 with no content: the track exists but wasn't served for
        // this request/session (observed on ASR tracks) - worth a retry.
        return { reason: "caption response was empty" };
      }
      let data;
      try {
        data = JSON.parse(body);
      } catch (e) {
        return { reason: "caption response was not JSON" };
      }
      const events = Array.isArray(data?.events) ? data.events : [];
      const rows = [];
      for (const ev of events) {
        const ms = ev.tStartMs ?? ev.aStartMs;
        if (ms === undefined || ms === null) continue;
        const txt = cleanSegmentText((ev.segs || []).map((s) => s.utf8 || "").join(""));
        if (txt) rows.push({ t: ms / 1000, txt });
      }
      if (!rows.length) {
        return { reason: "caption response had no text events" };
      }
      rows.sort((a, b) => a.t - b.t);
      return { rows };
    };

    // Resolve the timedtext track (exact caption data, non-ASR preferred) or
    // a reason why there is nothing to fetch.
    //
    // Staleness guard: after an in-page navigation (playlist next/previous, a
    // related-video click) the page's inline player-response script still
    // holds the PREVIOUS video, and its caption tracks would fetch the old
    // transcript. A response that is not for the video in the URL is therefore
    // discarded here, and the sources below - which are built from the URL's
    // video id - answer instead. Reported as `staleBlob` in the debug line so
    // a mis-detection is visible rather than silent.
    const rawPr = readPageVar("ytInitialPlayerResponse");
    const urlVideoId = typeof currentVideoId === "function" ? currentVideoId() : "";
    const pr = typeof livePlayerResponse === "function" ? livePlayerResponse() : null;
    const rawId = rawPr?.videoDetails?.videoId || "";
    if (!pr && urlVideoId && rawId && rawId !== urlVideoId) {
      lastStats.staleBlob = rawId;
    }
    const tracks = pr?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
    const captionRenderer = pr?.captions?.playerCaptionsTracklistRenderer;

    // ---- which caption LANGUAGE to copy ---------------------------------
    // The track list is a list of LANGUAGES, so "prefer a manual track over an
    // ASR one" is not a safe rule on its own: for an Arabic video offering
    // Arabic auto-captions plus a manual English track,
    // `find(t => t.kind !== "asr")` picks English and the copy silently becomes
    // a translation. The language is therefore decided FIRST, and the
    // manual-over-ASR preference only settles a choice within one language:
    //   1. `ytxt_lang` (localStorage, or #ytxt_lang=ar in the URL), if set;
    //   2. otherwise the video's own default caption language - what the page
    //      itself would show - from the default audio track's caption index,
    //      falling back to the first listed track, which is where YouTube puts
    //      the video's original language;
    //   3. within that language, a manual track over an ASR one.
    // A requested language with no track of its own is served from the default
    // track through YouTube's own `tlang` translation, and that is reported as
    // `capLang` (so a copy is never silently in the wrong language).
    const preferredLang = (() => {
      try {
        if (typeof localStorage !== "undefined") {
          const v = localStorage.getItem("ytxt_lang");
          if (v && String(v).trim()) return String(v).trim().toLowerCase();
        }
      } catch (e) {}
      try {
        const hash = String(
          (typeof window !== "undefined" && window.location && window.location.hash) || ""
        );
        const m = hash.match(/ytxt_lang=([A-Za-z][A-Za-z-]{1,15})/);
        if (m) return m[1].toLowerCase();
      } catch (e) {}
      return "";
    })();
    // "ar" / "ar-EG" from languageCode, or from vssId (".ar" = manual,
    // "a.ar" = ASR), which is all some responses carry.
    const langOf = (t) =>
      String((t && (t.languageCode || t.vssId)) || "")
        .replace(/^a?\./, "")
        .toLowerCase();
    const sameLang = (a, b) =>
      !!a && !!b && (a === b || a.split("-")[0] === b.split("-")[0]);
    const defaultLang = (() => {
      try {
        const audio =
          captionRenderer && Array.isArray(captionRenderer.audioTracks)
            ? captionRenderer.audioTracks[captionRenderer.defaultAudioTrackIndex || 0]
            : null;
        const idx =
          audio && Array.isArray(audio.captionTrackIndices)
            ? audio.captionTrackIndices[0]
            : null;
        if (typeof idx === "number" && tracks && tracks[idx]) return langOf(tracks[idx]);
      } catch (e) {}
      return tracks && tracks.length ? langOf(tracks[0]) : "";
    })();
    // Records what the successful source actually produced, and whether an
    // explicitly requested language could not be honored by it.
    const noteLang = (lang) => {
      lastStats.capLang = lang || null;
      lastStats.capLangMismatch =
        !!preferredLang && !!lang && !sameLang(lang, preferredLang);
    };

    let timedtext = null;
    if (!pr) {
      timedtext = {
        reason:
          "no player response for this video (the page's copy is stale after an in-page navigation)",
      };
    } else if (!Array.isArray(tracks) || !tracks.length) {
      timedtext = { reason: "no caption tracks in player response" };
    } else {
      const pickTrack = () => {
        const usable = tracks.filter((t) => t && t.baseUrl);
        const pool = usable.length ? usable : tracks;
        if (preferredLang) {
          const native =
            pool.find((t) => sameLang(langOf(t), preferredLang) && t.kind !== "asr") ||
            pool.find((t) => sameLang(langOf(t), preferredLang));
          if (native) return { track: native };
          const base =
            pool.find((t) => sameLang(langOf(t), defaultLang)) ||
            pool.find((t) => t.kind !== "asr") ||
            pool[0];
          return base ? { track: base, tlang: preferredLang } : { track: null };
        }
        const inDefault = pool.filter((t) => sameLang(langOf(t), defaultLang));
        const chosen =
          inDefault.find((t) => t.kind !== "asr") ||
          inDefault[0] ||
          // No track states a language at all: fall back to the previous
          // rule (a manual track over an ASR one) rather than to array order.
          pool.find((t) => t.kind !== "asr") ||
          pool[0];
        return { track: chosen || null };
      };
      const picked = pickTrack();
      const track = picked.track;
      if (!track?.baseUrl) {
        timedtext = { reason: "caption track has no baseUrl" };
      } else {
        try {
          const url = new URL(track.baseUrl);
          url.searchParams.set("fmt", "json3");
          // Translated captions: only a language with no track of its own gets
          // YouTube's `tlang` translation of the default track.
          if (picked.tlang && !url.searchParams.get("tlang")) {
            url.searchParams.set("tlang", picked.tlang);
          }
          timedtext = { url, lang: picked.tlang || langOf(track) };
          // exp=xpe marks the PO-token-gated timedtext format: YouTube serves
          // these URLs only to requests carrying a botguard "PO token", which
          // an extension content script cannot mint (the page attaches its own
          // via its internal player code). Detected so failures on such tracks
          // are explained instead of looking like random empty responses.
          const exp = (url.searchParams.get("exp") || "").split(",");
          if (exp.includes("xpe")) timedtext.poTokenGated = true;
        } catch (e) {
          timedtext = { reason: "caption baseUrl could not be parsed" };
        }
      }
    }

    if (timedtext?.url) {
      // Caption availability varies per session (a track can 200 with an
      // empty body one moment and serve fine the next), so give transient
      // empty responses one retry before moving to the next source - unless
      // the URL is PO-token-gated, where a retry cannot mint the missing
      // token and would only waste a request.
      const first = await fetchOnce(timedtext.url);
      if (first.rows) {
        lastStats.capSource = "timedtext";
        noteLang(timedtext.lang);
        return first.rows;
      }
      timedtext.reason = first.reason;
      const transient =
        first.reason === "caption response was empty" ||
        first.reason === "caption response had no text events";
      if (timedtext.poTokenGated) {
        if (transient) {
          // The empty body is the gate itself, not a transient blip.
          timedtext.reason =
            "caption response was empty [PO-token-gated: exp=xpe - this track requires a botguard PO token]";
        } else {
          timedtext.reason +=
            " [PO-token-gated: exp=xpe - this track requires a botguard PO token]";
        }
      } else if (transient) {
        lastStats.capRetries++;
        await sleep(700);
        const retry = await fetchOnce(timedtext.url);
        if (retry.rows) {
          lastStats.capSource = "timedtext";
          noteLang(timedtext.lang);
          return retry.rows;
        }
        timedtext.reason = retry.reason;
      }
    }

    // The timedtext URL is served from different infrastructure than the
    // innertube API and can be gated per session even for videos that do have
    // captions (observed: HTTP 200 with an empty body, or no track list at
    // all in some sessions). get_transcript only needs the video id, so it is
    // a genuinely independent second path worth trying before giving up.
    const readCfg = (key) => {
      // Pull "KEY":"value" out of ytcfg.set({...}) payloads in page scripts,
      // so we ride YouTube's own current client version / API key when those
      // are parseable, and fall back to well-known constants otherwise.
      try {
        const re = new RegExp('"' + key + '"\\s*:\\s*"([^"]+)"');
        for (const sc of document.querySelectorAll("script")) {
          const m = (sc.textContent || "").match(re);
          if (m) return m[1];
        }
      } catch (e) {}
      return null;
    };
    // The URL wins: it is the one description of "the video playing right
    // now" that is correct in every context, including after an in-page
    // navigation. The blob's id is only a fallback for a URL that carries no
    // `v` parameter at all.
    const videoId = urlVideoId || pr?.videoDetails?.videoId || "";

    // ---------------- modern transcript panel API (youtubei/v1/get_panel) -------------
    // The current YouTube UI loads transcript panels via get_panel with a
    // gzip-compressed JSON body: { context, panelId: "PAmodern_transcript_view",
    // params }. The params are a deterministic protobuf carrying the video id
    // (field 149 wrapper -> { field 1: video_id, field 3: 1 }). Live-verified:
    // with the page's own visitor data this returns the full transcript of even
    // PO-token-gated videos in a single response - no botguard token needed.
    //
    // Graceful degradation: this source only runs when its prerequisites are
    // met (video id, CompressionStream, and the page's visitor data - which is
    // normally present on any watch page). If any are missing, or the request
    // fails, it returns a { reason } and the chain falls through to the next
    // source; the reason is reported in capFail so failures stay explainable.
    const panelApiAttempt = async () => {
      if (!videoId) return { reason: "no video id" };
      if (typeof CompressionStream !== "function") {
        // Can't gzip the request body - skip this source entirely.
        return { reason: "CompressionStream unavailable (needed to gzip the request body)" };
      }
      const visitorData = readCfg("VISITOR_DATA");
      if (!visitorData) {
        // The request is rejected without valid visitor data, so skip rather
        // than send a doomed request - the next source still gets a chance.
        return { reason: "no visitor data on the page" };
      }
      const clientVersion =
        readCfg("INNERTUBE_CLIENT_VERSION") || "2.20250101.00.00";
      // protobuf params: field 149 (len-delimited) wrapping { 1: video_id, 3: 1 }
      const vid = new TextEncoder().encode(videoId);
      const inner = new Uint8Array([0x0a, vid.length, ...vid, 0x18, 0x01]);
      const payload = new Uint8Array([0xaa, 0x09, inner.length, ...inner]);
      const B64 =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let params = "";
      for (let i = 0; i < payload.length; i += 3) {
        const n =
          (payload[i] << 16) |
          ((i + 1 < payload.length ? payload[i + 1] : 0) << 8) |
          (i + 2 < payload.length ? payload[i + 2] : 0);
        params +=
          B64[(n >> 18) & 63] +
          B64[(n >> 12) & 63] +
          (i + 1 < payload.length ? B64[(n >> 6) & 63] : "=") +
          (i + 2 < payload.length ? B64[n & 63] : "=");
      }
      // The OS fields are part of what passes the request validation; derive
      // them from the user agent (best effort, safe defaults).
      const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";
      // platform is a strict innertube enum (DESKTOP / MOBILE / TV / ...)
      let osName = "Windows", osVersion = "10.0", platform = "DESKTOP";
      const mMac = ua.match(/Mac OS X (\d+[._]\d+)/);
      if (mMac) {
        osName = "macOS";
        osVersion = mMac[1].replace(/_/g, ".");
      } else if (/Linux/.test(ua)) {
        osName = "Linux";
        osVersion = "";
      } else if (/Android/.test(ua)) {
        osName = "Android";
        osVersion = (ua.match(/Android (\d+(?:\.\d+)?)/) || [])[1] || "";
        platform = "MOBILE";
      } else if (/iPhone|iPad|iPod/.test(ua)) {
        osName = "iOS";
        osVersion = (ua.match(/OS (\d+[_.\d]*)/) || [])[1] || "";
        platform = "MOBILE";
      }
      const body = {
        context: {
          client: {
            hl: "en",
            gl: "US",
            visitorData,
            userAgent: ua,
            clientName: "WEB",
            clientVersion,
            osName,
            osVersion,
            platform,
          },
        },
        panelId: "PAmodern_transcript_view",
        params,
      };
      let res;
      try {
        const stream = new Blob([JSON.stringify(body)])
          .stream()
          .pipeThrough(new CompressionStream("gzip"));
        res = await fetch(
          "https://www.youtube.com/youtubei/v1/get_panel?prettyPrint=false",
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "Content-Encoding": "gzip",
            },
            body: stream,
            duplex: "half",
          }
        );
      } catch (e) {
        return { reason: "getpanel fetch threw: " + e.message };
      }
      let data = null;
      let parseFailed = false;
      try {
        data = await res.json();
      } catch (e) {
        parseFailed = true;
      }
      if (!res.ok) {
        if (data?.error?.code !== undefined) {
          const detail = data.error.message
            ? " (" + String(data.error.message).slice(0, 80) + ")"
            : "";
          return { reason: "getpanel error " + data.error.code + detail };
        }
        return { reason: "getpanel http " + res.status };
      }
      if (parseFailed) {
        return { reason: "getpanel response was not JSON" };
      }
      // Response: content.engagementPanelSectionListRenderer.content
      // .sectionListRenderer.contents[].itemSectionRenderer.contents[]
      // .timelineItemViewModel.contentItems[].transcriptSegmentViewModel
      // with { timestamp: "0:00" / "7:29:09", simpleText }.
      const rows = [];
      const walk = (o) => {
        if (Array.isArray(o)) {
          for (const v of o) walk(v);
          return;
        }
        if (!o || typeof o !== "object") return;
        const seg = o.transcriptSegmentViewModel;
        if (seg && seg.timestamp && seg.simpleText) {
          const t = parseTimecode(seg.timestamp);
          const txt = cleanSegmentText(seg.simpleText);
          if (t !== null && txt) rows.push({ t, txt });
        }
        for (const v of Object.values(o)) walk(v);
      };
      walk(data);
      if (!rows.length) {
        return { reason: "getpanel response had no transcript segments" };
      }
      rows.sort((a, b) => a.t - b.t);
      return { rows };
    };

    const innertubeAttempt = async () => {
      if (!videoId) return { reason: "no video id" };
      // protobuf params: message { 1: string video_id } -> 0x0a <len> <bytes>
      const vid = new TextEncoder().encode(videoId);
      const payload = new Uint8Array([0x0a, vid.length, ...vid]);
      const B64 =
        "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      let params = "";
      for (let i = 0; i < payload.length; i += 3) {
        const n =
          (payload[i] << 16) |
          ((i + 1 < payload.length ? payload[i + 1] : 0) << 8) |
          (i + 2 < payload.length ? payload[i + 2] : 0);
        params +=
          B64[(n >> 18) & 63] +
          B64[(n >> 12) & 63] +
          (i + 1 < payload.length ? B64[(n >> 6) & 63] : "=") +
          (i + 2 < payload.length ? B64[n & 63] : "=");
      }
      const key =
        readCfg("INNERTUBE_API_KEY") ||
        "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
      const clientVersion =
        readCfg("INNERTUBE_CLIENT_VERSION") || "2.20250101.00.00";
      let res;
      try {
        res = await fetch(
          "https://www.youtube.com/youtubei/v1/get_transcript?key=" + key,
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              context: {
                client: {
                  clientName: "WEB",
                  clientVersion,
                  hl: "en",
                  gl: "US",
                },
              },
              params: encodeURIComponent(params),
            }),
          }
        );
      } catch (e) {
        return { reason: "innertube fetch threw: " + e.message };
      }
      let data = null;
      let parseFailed = false;
      try {
        data = await res.json();
      } catch (e) {
        parseFailed = true;
      }
      if (!res.ok) {
        // Surface YouTube's own rejection (e.g. "Precondition check failed")
        // when the error body parses, so bug reports say exactly what the
        // server answered.
        if (data?.error?.code !== undefined) {
          const detail = data.error.message
            ? " (" + String(data.error.message).slice(0, 80) + ")"
            : "";
          return { reason: "innertube error " + data.error.code + detail };
        }
        return { reason: "innertube http " + res.status };
      }
      if (parseFailed) {
        return { reason: "innertube response was not JSON" };
      }
      if (data?.error?.code !== undefined) {
        return { reason: "innertube error " + data.error.code };
      }
      // Response shape: response.actions[].updateEngagementPanelAction.content
      // .transcriptRenderer(.content.transcriptSearchPanelRenderer)?.body
      // .transcriptBodyRenderer.cueGroups[].transcriptCueGroupRenderer.cues[]
      // Each cue: transcriptCueRenderer { startOffsetMs, cue.simpleText|runs }.
      const actions = Array.isArray(data?.actions) ? data.actions : [];
      for (const a of actions) {
        const upd = a?.updateEngagementPanelAction;
        const renderer = upd?.content?.transcriptRenderer;
        if (!renderer) continue;
        const body =
          renderer?.body?.transcriptBodyRenderer ||
          renderer?.content?.transcriptSearchPanelRenderer?.body
            ?.transcriptBodyRenderer;
        if (!body || !Array.isArray(body.cueGroups)) continue;
        const rows = [];
        for (const group of body.cueGroups) {
          const cues = group?.transcriptCueGroupRenderer?.cues;
          if (!Array.isArray(cues)) continue;
          for (const cue of cues) {
            const cr = cue?.transcriptCueRenderer;
            if (!cr) continue;
            const ms = parseInt(cr.startOffsetMs, 10);
            if (!isFinite(ms)) continue;
            const cueText = cr.cue || {};
            let raw = "";
            if (cueText.simpleText !== undefined) raw = cueText.simpleText;
            else if (Array.isArray(cueText.runs))
              raw = cueText.runs.map((x) => x.text || "").join("");
            const txt = cleanSegmentText(raw);
            if (txt) rows.push({ t: ms / 1000, txt });
          }
        }
        if (rows.length) {
          rows.sort((a, b) => a.t - b.t);
          return { rows };
        }
      }
      return { reason: "innertube response had no transcript body" };
    };
    const panelApi = await panelApiAttempt();
    if (panelApi.rows) {
      lastStats.capSource = "getpanel";
      // get_panel's params carry only the video id, so this source always
      // returns the video's DEFAULT transcript; a requested language it cannot
      // honor shows up as capLangMismatch rather than passing silently.
      noteLang(defaultLang);
      return panelApi.rows;
    }

    // get_panel was skipped or came back empty - degrade to the next source.
    // Its reason is folded into the combined capFail below.
    const innertube = await innertubeAttempt();
    if (innertube.rows) {
      lastStats.capSource = "innertube";
      noteLang(defaultLang);
      return innertube.rows;
    }

    lastStats.capFail =
      "timedtext: " + (timedtext?.reason || "not attempted") +
      "; getpanel: " + panelApi.reason +
      "; innertube: " + innertube.reason;
    return null;
  }

  // =========================================================
  // COPY HANDLERS
  // =========================================================
  async function copyTextToClipboard(text) {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      // Fallback for contexts where the async clipboard API is unavailable
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      if (!ok) throw new Error(t("error.clipboard"));
    }
  }

  function setButtonState(btn, label, disabled) {
    btn.textContent = label;
    btn.disabled = !!disabled;
  }

  // Sets a chunk label, widening a compact badge so its "n/N" count is legible
  // instead of spilling out of the circle (see CHUNK_LABEL_CLS). The class is
  // harmless on the main Transcript button, which has room for the count.
  function setChunkLabel(btn, label, disabled) {
    btn.classList.add(CHUNK_LABEL_CLS);
    setButtonState(btn, label, disabled);
    reserveBadgeRoom(btn);
  }

  // Tells a chapter row how much room its badge is taking, so the row can keep
  // the chapter title out from under it.
  //
  // The compact badge is absolutely positioned, so a wide pill does not push the
  // title aside - it covers it, and a long title is exactly where the end of the
  // label would land. The row is given the width the badge actually rendered at
  // (measured after the label is set, so it is right for any wording, digit set
  // and part count) and content.css reserves it. Only the chapter rows need this:
  // the badge on a chapter card sits over the thumbnail, and the player's badge
  // shares a flex row that reflows on its own.
  function reserveBadgeRoom(btn) {
    // The main button's label is already in the page flow; nothing to reserve.
    if (!btn.getAttribute("data-orig")) return;
    const row = btn.parentElement;
    if (!row || typeof row.matches !== "function" || !row.matches(CHAPTER_ITEM_SELECTOR)) return;
    if (!row.classList || !row.style || typeof row.style.setProperty !== "function") return;
    let width = 0;
    try {
      const rect = btn.getBoundingClientRect ? btn.getBoundingClientRect() : null;
      width = rect && rect.width ? Math.ceil(rect.width) : 0;
    } catch (e) {}
    // Nothing measured means nothing to go on: leave the row exactly as it was
    // rather than reserve a number that is not the badge's real width.
    if (!width) return;
    row.classList.add(BADGE_PILL_CLS);
    row.style.setProperty(BADGE_ROOM_VAR, width + BADGE_ROOM_GAP + "px");
  }

  // The main Transcript button's single unit of work: the whole video, with no
  // title, so its parts are numbered by position ("Part 2/5") instead of being
  // labelled with a chapter. The main button never splits along chapters - a
  // chapter is another node's unit, batched by that node on its own numbers.
  function wholeVideoSpan() {
    return { title: "", start: 0, end: Infinity };
  }

  // Writes one clipboard payload, and if that single write is rejected, degrades
  // into the same ordered part sequence a too-large transcript uses rather than
  // reporting a failure.
  //
  // This exists because the fragile half of a write is size-dependent: the async
  // clipboard path is not, but the execCommand fallback taken when writeText is
  // unavailable lays the string out in a hidden textarea first and has been
  // reported to struggle from roughly 180k characters. The error is not typed, so
  // a non-size failure (permission, focus) is retried as parts too and simply
  // fails again on the first part, leaving the caller to report it.
  //
  // Returns "whole" when the payload was written in one go, or "parts" when a
  // chunk session was started (the caller must then leave the button alone -
  // copyNextChunk has already set it up). `maxChars` is the caller's own cap,
  // so a recovery re-split still follows the caller's numbers.
  async function copyRowsWithSplitFallback(rows, span, text, btn, maxChars) {
    try {
      await copyTextToClipboard(text);
      return "whole";
    } catch (err) {
      const chunks = span ? buildChunks(span, rows, maxChars) : [];
      if (chunks.length < 2) throw err;
      console.warn(
        `[YT-Transcript] one clipboard write was rejected; copying as ${chunks.length} parts instead:`,
        err && err.message
      );
      chunkSession = { chunks, idx: 0, owner: btn };
      try {
        await copyNextChunk(btn);
      } catch (err2) {
        chunkSession = null;
        throw err2;
      }
      return "parts";
    }
  }

  // Copies one chapter's rows, as a single clipboard write when they fit and as
  // an ordered part sequence when they do not. A long chapter used to go to the
  // clipboard in one write however big it was, so a single 3-hour chapter inside
  // a stream became one enormous paste with no way to tell how much was left;
  // chapter buttons now behave like a batch of their own, turning into an "n/N"
  // control. This is the chapter node's OWN batcher: it splits on the CHAPTER_*
  // numbers and never on the main button's, so retuning one leaves the other
  // alone.
  //
  // Returns false when there is nothing to copy, so callers fall through to their
  // next source. `chapter` may be null (a chapter-shelf entry that could not be
  // matched to the chapter list), where there is no title to split by: it
  // becomes an untitled span of its own and the rows are written as-is, exactly
  // as before.
  async function copyChapterRows(rows, chapter, btn) {
    if (!rows.length) return false;
    const span = chapter || wholeVideoSpan();
    const chunks = buildChunks(span, rows, CHAPTER_CHUNK_MAX_CHARS);
    if (!chunks.length || !chunks[0].text) return false;
    // A chapter batches itself: it is only cut into parts when the chapter alone
    // is bigger than its own ceiling and yields more than one part.
    if (rowsLength(rows) > CHAPTER_CHUNK_THRESHOLD && chunks.length > 1) {
      chunkSession = { chunks, idx: 0, owner: btn };
      try {
        await copyNextChunk(btn);
      } catch (err) {
        // A failed first part must not leave a live session behind: the button
        // goes back to idle, so the next click has to start a fresh copy rather
        // than silently resuming a sequence the user believes was abandoned.
        chunkSession = null;
        throw err;
      }
      return true;
    }
    // Fits in one write - but if that write is rejected for size, fall back to
    // parts rather than failing (see copyRowsWithSplitFallback).
    const outcome = await copyRowsWithSplitFallback(rows, span, chunks[0].text, btn, CHAPTER_CHUNK_MAX_CHARS);
    if (outcome === "whole") {
      lastStats.rows = chunks[0].rowCount || rows.length;
      logStats();
      // A chapter that fits in one write is a plain "copied"; only an oversized
      // one turns into an n/N control, which is what the main button does too.
      // A checkmark is a single glyph, so it stays the ordinary circular badge.
      setButtonState(btn, t("badge.copied"), false);
      setTimeout(() => resetMainButton(btn), 1500);
    }
    return true;
  }

  async function copyChapterRange(chapter, btn) {
    const original = btn.getAttribute("data-orig") || "📋";

    // A chunk session started by THIS button: each click copies the next part of
    // an oversized chapter. A session owned by another button is left alone -
    // the click below starts a new copy instead.
    if (chunkSession && chunkSession.owner === btn) {
      if (chunkSession.idx < chunkSession.chunks.length) {
        try {
          await copyNextChunk(btn);
        } catch (err) {
          console.error(err);
          lastStats.error = err.message || "chunk copy failed";
          logStats();
          // Abort the session so the next click starts fresh rather than
          // silently resuming mid-sequence.
          chunkSession = null;
          setButtonState(btn, t("badge.hardFailed"), false);
          setTimeout(() => resetMainButton(btn), 2000);
        }
      }
      return;
    }

    const fromSec = chapter ? chapter.start : 0;
    const toSec = chapter ? chapter.end : Infinity;
    // The raw title (not the bidi-isolated one) - this label also lands in the
    // debug report, which has to stay byte-identical for tooling.
    resetStats(chapter && chapter.title ? t("label.chapter", { title: chapter.title }) : t("label.chapterGeneric"));
    const epoch = navEpoch;
    try {
      setButtonState(btn, t("badge.copying"), true);

      // Fast path: the exact caption fetch (timedtext → get_panel →
      // get_transcript) returns the whole transcript in one or two requests
      // - get_panel even serves PO-token-gated videos - so the chapter's
      // slice can be cut from it directly. This avoids the slow, fragile
      // panel scroll for long videos and works even when YouTube's panel UI
      // renders no segments (e.g. the modern chapter-panel layout). The
      // panel scrape below remains the fallback when every caption source
      // fails.
      const caps = await fetchCaptionsFallback(true);
      if (abandoned(epoch)) {
        setButtonState(btn, original, false);
        return;
      }
      if (caps) {
        const capRows = caps.filter((c) => c.t >= fromSec - 0.6 && c.t < toSec);
        if (capRows.length) {
          lastStats.source = "captions";
          lastStats.rows = capRows.length;
          if (await copyChapterRows(capRows, chapter, btn)) return;
        }
      }

      const panel = await ensureFreshTranscriptPanel(15000);

      // Wait for the first segments to render
      for (let i = 0; i < 30; i++) {
        const segs = panel.querySelectorAll("ytd-transcript-segment-renderer");
        if (segs.length) break;
        await sleep(300);
      }

      const collected = await loadTranscriptSegments(panel, toSec, fromSec);
      if (abandoned(epoch)) {
        setButtonState(btn, original, false);
        return;
      }
      // Keep the rows rather than pre-joined text: the chapter may be long
      // enough that the copy has to be split, and splitting happens on segment
      // boundaries.
      let rows = [...collected.values()]
        .filter((r) => r.t >= fromSec - 0.6 && r.t < toSec)
        .sort((a, b) => a.t - b.t);
      lastStats.source = "panel";
      lastStats.rows = rows.length;

      if (!rows.length || collectedMaxT(collected) < fromSec - 1 || collected.incomplete) {
        // Panel route did not cover the requested range or missed segments
        // (flagged by the collector) -> use the exact caption fetch instead.
        const retryCaps = await fetchCaptionsFallback();
        if (retryCaps) {
          rows = retryCaps
            .filter((c) => c.t >= fromSec - 0.6 && c.t < toSec)
            .sort((a, b) => a.t - b.t);
          lastStats.source = "captions";
          lastStats.rows = rows.length;
        } else if (collected.incomplete) {
          // The panel was missing content and there is no caption source to
          // fall back on - fail loudly rather than copy a transcript with
          // silent holes.
          throw new Error(t("error.incomplete"));
        }
      }
      if (!rows.length) throw new Error(t("error.noRange"));

      await copyChapterRows(rows, chapter, btn);
    } catch (err) {
      if (abandoned(epoch)) {
        setButtonState(btn, original, false);
        return;
      }
      console.error(err);
      setButtonState(btn, t("badge.failed"), false);
      try {
        const caps = await fetchCaptionsFallback();
        if (caps) {
          const fallbackRows = caps.filter((c) => c.t >= fromSec - 0.6 && c.t < toSec);
          if (fallbackRows.length) {
            lastStats.source = "captions";
            lastStats.rows = fallbackRows.length;
            if (await copyChapterRows(fallbackRows, chapter, btn)) return;
          }
        }
      } catch (e2) {
        console.error(e2);
      }
      alert(
        (err.message || t("error.chapterCopy")) +
          (lastStats.capFail ? "\n\n" + t("error.captionSources") + "\n" + lastStats.capFail : "")
      );
      lastStats.error = err.message || "copy failed";
      logStats();
      setTimeout(() => resetMainButton(btn), 2000);
    }
  }

  // True when the page has navigated since `epoch` was captured. Long copies
  // are asynchronous, so a result is only used while it still describes the
  // video on screen.
  function abandoned(epoch) {
    return epoch !== navEpoch;
  }

  // Restores a copy button to its idle label. The main Transcript button's
  // default is spelled out here; the compact chapter and player buttons keep
  // theirs in data-orig, so ending a chunk session on one of those restores the
  // clipboard glyph rather than the main button's text.
  async function resetMainButton(btn) {
    if (btn) {
      // A chunk count needs the pill layout; an idle label does not.
      btn.classList.remove(CHUNK_LABEL_CLS);
      // ...and the room the pill reserved goes back to the chapter title.
      const row = btn.parentElement;
      if (row && row.classList) {
        row.classList.remove(BADGE_PILL_CLS);
        if (row.style && typeof row.style.removeProperty === "function") {
          row.style.removeProperty(BADGE_ROOM_VAR);
        }
      }
      btn.textContent = btn.getAttribute("data-orig") || t("button.idle");
      btn.disabled = false;
      // Restore the button's own tooltip: a chunk session overwrote it with the
      // "click again for the next part" instruction, and the chapter badges carry
      // a useful default ("Copy transcript of chapter: ..."). The main button
      // stores none, so it simply ends up without a tooltip.
      btn.title = btn.getAttribute("data-tip") || "";
    }
  }

  // How much of the whole transcript a chunk session has already put on the
  // clipboard. Measured the way the parts were sized - every segment counts as
  // its text plus its joining space - so it is earned, not estimated: it adds a
  // part only once that part has been written, and it reaches exactly 100% on
  // the last one. `upto` is the number of parts already copied.
  function sessionProgress(session, upto) {
    let total = 0;
    let done = 0;
    session.chunks.forEach((c, i) => {
      const len = String(c.body == null ? "" : c.body).length + 1;
      total += len;
      if (i < upto) done += len;
    });
    return { done, total, pct: total ? Math.round((done / total) * 100) : 100 };
  }

  // Copies the next chunk of an active chunk session. The button becomes a
  // "copy next chunk" control until every chunk is copied.
  async function copyNextChunk(btn) {
    const session = chunkSession;
    const n = session.chunks.length;
    const ch = session.chunks[session.idx];

    // Carry the caption-source provenance (which fallback produced the rows)
    // into the per-chunk report instead of wiping it on each chunk reset.
    const provenance = {
      capSource: lastStats.capSource,
      capLang: lastStats.capLang,
      capLangMismatch: lastStats.capLangMismatch,
      capFail: lastStats.capFail,
      capRetries: lastStats.capRetries,
    };
    // The diagnostic label stays ASCII on purpose: it lands in the debug report
    // and `data-debug`, which have to be comparable between users and grep-able.
    resetStats(`Chunk ${ch.n}/${n}`);
    Object.assign(lastStats, provenance);
    lastStats.source = "chunks";
    lastStats.rows = ch.rowCount || 0;
    // The chapter and player buttons are 22px squares, so they get the count
    // without any words; the main button has room for the full label. The
    // explanation is carried by the tooltip either way.
    const compact = !!btn.getAttribute("data-orig");
    setChunkLabel(btn, t(compact ? "badge.chunkCopying" : "button.chunkCopying", { count: countText(ch.n, n) }), true);
    await copyTextToClipboard(ch.text);
    session.idx++;
    // Read after the write and before the report: the share shown is the one
    // that is actually on the clipboard, with nothing in flight counted.
    const copied = sessionProgress(session, session.idx);
    lastStats.progress = copied.pct;
    logStats();

    if (session.idx >= n) {
      // Single glyph: the circular badge fits it, so no count class here.
      setButtonState(btn, compact ? t("badge.copied") : t("button.chunkAll"), false);
      setTimeout(() => {
        chunkSession = null;
        resetMainButton(btn);
      }, 2200);
      return;
    }
    const next = session.chunks[session.idx];
    setChunkLabel(
      btn,
      // The compact badges are 22px circles: a count already widens them into a
      // pill, and a percentage as well would be wide enough to sit over the
      // chapter title it belongs to. So the count stays bare there and the share
      // is carried by the tooltip (and by the report) instead.
      t(compact ? "badge.chunkNext" : "button.chunkNext", {
        count: countText(next.n, n),
        pct: percentText(copied.pct),
      }),
      false
    );
    btn.title =
      t("chunk.instruction", {
        n: countText(ch.n),
        title: isolateRtl(ch.title),
        next: countText(next.n),
        nextTitle: isolateRtl(next.title),
      }) +
      " " +
      t("chunk.progress", { pct: percentText(copied.pct) });
  }

  async function handleClick() {
    const btn = document.getElementById(BUTTON_ID);
    if (!btn) return;
    const epoch = navEpoch;

    // An active chunk session: each click copies the next chunk. Only the button
    // that started the session continues it, so clicking the Transcript button
    // while a chapter is mid-sequence starts a fresh full copy instead of
    // resuming the chapter's chunk list.
    // (While the final "all copied" flash is showing, ignore extra clicks.)
    if (chunkSession && chunkSession.owner === btn) {
      if (chunkSession.idx < chunkSession.chunks.length) {
        try {
          await copyNextChunk(btn);
        } catch (err) {
          console.error(err);
          lastStats.error = err.message || "chunk copy failed";
          logStats();
          // Abort the whole session so the next click starts fresh instead of
          // silently resuming mid-way through the chapters.
          chunkSession = null;
          btn.textContent = t("button.failed");
          setTimeout(() => resetMainButton(btn), 2000);
        }
      }
      return;
    }
    chunkSession = null;

    try {
      setButtonState(btn, t("button.copying"), true);
      resetStats(t("label.full"));

      // Fast path: the exact caption fetch (timedtext → get_panel →
      // get_transcript) returns the whole transcript in one or two requests
      // - get_panel even serves PO-token-gated videos - so long transcripts
      // are copied without slowly scrolling the panel. The panel scrape
      // below remains the fallback when no caption source answers.
      let rows = null;
      const caps = await fetchCaptionsFallback(true);
      if (abandoned(epoch)) return; // navigated away - this copy is no longer wanted
      if (caps) {
        rows = caps;
        lastStats.source = "captions";
      }
      if (!rows) {
        const panel = await ensureFreshTranscriptPanel();
        // Load the whole transcript (top to bottom) so long videos are fully copied
        const collected = await loadTranscriptSegments(panel, Infinity, 0);
        if (abandoned(epoch)) return; // navigated away while the panel was loading

        // Normalize the collected panel rows (and the caption fallback) into
        // one ordered list. If the panel route came back empty or incomplete
        // - some segments were never rendered - swap in the exact caption
        // data so the full copy and the per-chapter chunks never contain
        // silent holes.
        rows = [...collected.values()];
        lastStats.source = "panel";
        if (!rows.length || collected.incomplete) {
          const retryCaps = await fetchCaptionsFallback();
          if (retryCaps) {
            rows = retryCaps;
            lastStats.source = "captions";
          } else if (collected.incomplete) {
            // The panel was missing content and there is no caption source
            // to fall back on - fail loudly rather than copy a transcript
            // with silent holes (same behavior as the per-chapter path).
            throw new Error(t("error.incomplete"));
          }
        }
      }
      if (!rows.length) throw new Error(t("error.noText"));
      rows.sort((a, b) => a.t - b.t);
      lastStats.rows = rows.length;
      const fullText = rows.map((r) => r.txt).join(" ");

      // Keep normal videos as a single copy, but split exceptionally large
      // transcripts into ordered, bounded parts so very long videos remain
      // usable when the browser clipboard rejects one huge write.
      //
      // This is the main button's OWN batcher over the whole transcript: it
      // never consults the chapter list, so a 19-hour chaptered video batches
      // by size ("Part 1/N") exactly like a chapterless one, instead of being
      // cut into one piece per chapter and labelled with chapter titles.
      // Chapters are other nodes with their own buttons and their own numbers.
      const span = wholeVideoSpan();
      if (rowsLength(rows) > MAIN_CHUNK_THRESHOLD) {
        const chunks = buildChunks(span, rows, MAIN_CHUNK_MAX_CHARS);
        if (chunks.length >= 2) {
          chunkSession = { chunks, idx: 0, owner: btn };
          await copyNextChunk(btn);
          return;
        }
      }

      const outcome = await copyRowsWithSplitFallback(rows, span, fullText, btn, MAIN_CHUNK_MAX_CHARS);
      if (outcome === "whole") {
        logStats();
        btn.textContent = t("button.copied");
        setTimeout(() => resetMainButton(btn), 1500);
      }
    } catch (err) {
      if (abandoned(epoch)) return; // the failure belongs to a video we have left
      console.error(err);
      chunkSession = null;
      btn.textContent = t("button.failed");
      lastStats.error = err.message || "copy failed";
      // Second chance: the caption chain may have hit a transient server
      // rejection on the first attempt - retry it once before giving up
      // (same behavior as the per-chapter path).
      try {
        const retryCaps = await fetchCaptionsFallback();
        if (abandoned(epoch)) return;
        if (retryCaps) {
          const retryText = retryCaps.map((r) => r.txt).join(" ");
          if (retryText) {
            // Same rule as the first attempt: a rejected single write degrades
            // into parts instead of failing twice - through the main button's
            // own batcher, still ignoring chapters.
            const retryOutcome = await copyRowsWithSplitFallback(
              retryCaps,
              wholeVideoSpan(),
              retryText,
              btn,
              MAIN_CHUNK_MAX_CHARS
            );
            if (retryOutcome === "whole") {
              lastStats.source = "captions";
              lastStats.rows = retryCaps.length;
              logStats();
              btn.textContent = t("button.copied");
              setTimeout(() => resetMainButton(btn), 1500);
            }
            return;
          }
        }
      } catch (e2) {
        console.error(e2);
      }
      // Tell the user WHY every source failed instead of only the panel
      // error - capFail carries YouTube's own rejection per source.
      const detail = lastStats.capFail
        ? "\n\n" + t("error.captionSources") + "\n" + lastStats.capFail
        : "";
      logStats();
      alert(err.message + detail);
      setTimeout(() => resetMainButton(btn), 2000);
    }
  }

  // =========================================================
  // CHAPTER BUTTON INJECTION
  // =========================================================
  // Chapter items we attach copy buttons to:
  //  - ytd-video-description-chapter-thumbnail-renderer  (classic rows)
  //  - ytd-macro-markers-list-item-renderer              (modern chapter cards / list)
  const CHAPTER_ITEM_SELECTOR = [
    "ytd-video-description-chapter-thumbnail-renderer",
    "ytd-macro-markers-list-item-renderer",
  ].join(", ");

  // Find which chapter a DOM item corresponds to by matching its displayed
  // timecode (or title) against the authoritative chapter list.
  function matchChapter(chapters, item) {
    if (!chapters) return null;
    const timeEl = item.querySelector("#time, .segment-timestamp, .ytp-time-duration");
    const anchor = item.querySelector("a[href*='&t='], a#endpoint");
    const hrefTime = anchor ? parseInt((anchor.getAttribute("href") || "").match(/[?&]t=(\d+)s?/)?.[1] || "", 10) : NaN;
    const text = (item.innerText || "").replace(/\s+/g, " ");
    let start = null;
    if (!Number.isNaN(hrefTime) && hrefTime >= 0) start = hrefTime;
    else if (timeEl) start = parseTimecode(timeEl.textContent);
    if (start === null) start = parseTimecode(text);
    if (start !== null) {
      // exact or nearest match (<= 2s tolerance)
      let best = null;
      let bestDiff = Infinity;
      for (const c of chapters) {
        const diff = Math.abs(c.start - start);
        if (diff < bestDiff) {
          bestDiff = diff;
          best = c;
        }
      }
      if (best && bestDiff <= 2) return best;
    }
    // Match by title as a last resort
    const h = item.querySelector("h3, .chapter-title, .macro-markers");
    const title = h ? h.getAttribute("title") || cleanSegmentText(h.textContent) : "";
    if (title) {
      return chapters.find((c) => c.title === title) || null;
    }
    return null;
  }

  function makeChapterButton(item, chapter) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = CHAPTER_BTN_CLS;
    btn.title = chapter
      ? t("chapter.tip", { title: isolateRtl(chapter.title) })
      : t("chapter.noTitleTip");
    btn.textContent = "📋";
    btn.setAttribute("data-orig", "📋");
    // The tooltip a chunk session has to restore when it ends (it replaces the
    // title with the "click again" instruction while a sequence is running).
    btn.setAttribute("data-tip", btn.title);
    btn.setAttribute("aria-label", btn.title);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      copyChapterRange(chapter, btn);
    });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("pointerup", (e) => e.stopPropagation());
    return btn;
  }

  function injectChapterButtons() {
    if (!window.location.pathname.startsWith("/watch")) return;
    // Don't do any chapter parsing until YouTube actually renders chapter
    // entries (description expanded / chapters shelf present).
    const items = document.querySelectorAll(CHAPTER_ITEM_SELECTOR);
    if (!items.length) return;
    const chapters = getChapters();
    if (!chapters || !chapters.length) return;

    for (const item of items) {
      // Only attach to items that look like chapter entries (they have a title + timecode)
      const txt = (item.innerText || "").replace(/\s+/g, " ");
      if (!parseTimecode(txt) && !item.querySelector("#time")) continue;
      const chapter = matchChapter(chapters, item);

      const existingBtn = item.querySelector(`.${CHAPTER_BTN_CLS}`);
      if (existingBtn) {
        if (item.classList.contains(CHAPTER_HAS_BTN)) {
          // YouTube may reuse the same DOM node for a different chapter;
          // if the button now points at the wrong chapter, rebuild it.
          const existingStart = existingBtn.dataset.start ? Number(existingBtn.dataset.start) : null;
          const correctStart = chapter ? chapter.start : null;
          // A node reused across an in-page navigation can keep its button
          // while describing a different chapter; the title is compared too,
          // so a stale button is rebuilt instead of copying the wrong range.
          const existingTitle = existingBtn.dataset.title || "";
          const correctTitle = chapter ? chapter.title : "";
          if (existingStart === correctStart && existingTitle === correctTitle) continue;
          existingBtn.remove();
          item.classList.remove(CHAPTER_HAS_BTN);
        } else {
          existingBtn.remove();
        }
      }

      const btn = makeChapterButton(item, chapter);
      if (chapter) {
        btn.dataset.start = String(chapter.start);
        btn.dataset.title = chapter.title || "";
      }
      // Ensure relative positioning so the absolutely-positioned button stays put
      const cs = getComputedStyle(item);
      if (cs.position === "static") item.style.position = "relative";
      item.appendChild(btn);
      item.classList.add(CHAPTER_HAS_BTN);
    }
  }

  // =========================================================
  // CURRENT-CHAPTER BUTTON IN THE PLAYER (SCRUBBER)
  // =========================================================
  // The player shows the title of the chapter currently playing in the
  // bottom control bar (.ytp-chrome-controls > .ytp-chapter-container,
  // with .ytp-chapter-title-content). We add a small copy button right
  // next to it that copies that chapter's slice of the transcript.

  // The chapter container that is actually visible right now (YouTube keeps
  // hidden placeholder copies around).
  function findVisiblePlayerChapterContainer() {
    const player = document.querySelector("#movie_player");
    if (!player) return null;
    const containers = player.querySelectorAll(".ytp-chapter-container");
    for (const c of containers) {
      if (c.style.display === "none") continue;
      const content = c.querySelector(".ytp-chapter-title-content");
      if (content && cleanSegmentText(content.textContent)) return c;
    }
    return null;
  }

  // Which chapter is playing right now: prefer the real playback time
  // (works after seeking), fall back to the title shown in the player.
  function playerCurrentChapter(chapters) {
    if (!Array.isArray(chapters) || !chapters.length) return null;
    const video = document.querySelector("#movie_player video");
    let t = null;
    if (video && isFinite(video.currentTime) && video.currentTime > 0) {
      t = video.currentTime;
    } else {
      const tEl = document.querySelector(".ytp-time-current");
      if (tEl) t = parseTimecode(tEl.textContent);
    }
    if (t !== null && t >= 0) {
      const byTime = chapters.find((c) => t >= c.start && t < c.end);
      if (byTime) return byTime;
    }
    const container = findVisiblePlayerChapterContainer();
    const content = container && container.querySelector(".ytp-chapter-title-content");
    if (content) {
      const title = content.getAttribute("aria-label") || cleanSegmentText(content.textContent);
      if (title) {
        const byTitle = chapters.find((c) => c.title === title);
        if (byTitle) return byTitle;
      }
    }
    return chapters[0] || null;
  }

  function injectPlayerChapterButton() {
    if (!window.location.pathname.startsWith("/watch")) return;
    const chapters = getChapters();
    const hasChapters = Array.isArray(chapters) && chapters.length >= 2;
    const container = findVisiblePlayerChapterContainer();
    const existing = document.getElementById(PLAYER_BTN_ID);

    if (!hasChapters || !container) {
      if (existing) existing.remove();
      return;
    }

    const chapter = playerCurrentChapter(chapters);
    const chapterStart = chapter ? chapter.start : null;
    const parent = container.parentElement;
    if (!parent) return;

    if (existing) {
      // Re-anchor if the player swapped which container is visible or the
      // current chapter changed since the last tick.
      const anchored =
        existing.parentElement === parent && existing.previousElementSibling === container;
      const startChanged = existing.dataset.start !== String(chapterStart ?? "");
      if (anchored && !startChanged) {
        if (chapter) {
          existing.title = t("player.tip", { title: isolateRtl(chapter.title) });
          existing.setAttribute("data-tip", existing.title);
        }
        return;
      }
      existing.remove();
    }

    const btn = document.createElement("button");
    btn.id = PLAYER_BTN_ID;
    btn.type = "button";
    btn.className = "my-yt-player-chapter-copy";
    btn.textContent = "📋";
    btn.setAttribute("data-orig", "📋");
    if (chapter) {
      btn.dataset.start = String(chapter.start);
      btn.title = t("player.tip", { title: isolateRtl(chapter.title) });
    } else {
      btn.title = t("player.noChapterTip");
    }
    btn.setAttribute("data-tip", btn.title);
    btn.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      const ch = playerCurrentChapter(getChapters());
      if (ch) copyChapterRange(ch, btn);
    });
    btn.addEventListener("pointerdown", (e) => e.stopPropagation());
    btn.addEventListener("pointerup", (e) => e.stopPropagation());
    parent.insertBefore(btn, container.nextSibling);
  }

  // =========================================================
  // MAIN BUTTON INJECTION ENGINE (No Reload Needed)
  // =========================================================
  function injectButton() {
    if (!window.location.pathname.startsWith("/watch")) return;

    const target =
      document.querySelector("ytd-watch-metadata #top-level-buttons-computed") ||
      document.querySelector("#top-level-buttons-computed") ||
      document.querySelector("#actions-inner #top-level-buttons-computed") ||
      document.querySelector("#owner");

    if (!target) return;

    if (target.querySelector(`#${BUTTON_ID}`)) return;

    const oldBtn = document.getElementById(BUTTON_ID);
    if (oldBtn) oldBtn.remove();

    const isDarkMode = document.documentElement.hasAttribute("dark");

    const button = document.createElement("button");
    button.id = BUTTON_ID;
    button.textContent = t("button.idle");
    button.style.cssText = `
      border: 1px solid ${isDarkMode ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.1)"};
      border-radius: 18px;
      padding: 0 14px;
      height: 36px;
      margin-inline-end: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      background: ${isDarkMode ? "#272727" : "#f2f2f2"};
      color: ${isDarkMode ? "#ffffff" : "#0f0f0f"};
      white-space: nowrap;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
    `;

    button.addEventListener("click", handleClick);
    target.prepend(button);
  }

  // Chapter entries can appear at any time (description expand, opening the
  // "View all" chapter list, layout switches), so besides the periodic tick
  // we also react instantly when chapter items are added to the DOM.
  function setupChapterObserver() {
    let scheduled = false;
    const obs = new MutationObserver((mutations) => {
      let relevant = false;
      for (const m of mutations) {
        if (m.type !== "childList" || !m.addedNodes || !m.addedNodes.length) continue;
        for (const node of m.addedNodes) {
          if (node.nodeType !== 1) continue;
          const el = node;
          if (
            (typeof el.matches === "function" && el.matches(CHAPTER_ITEM_SELECTOR)) ||
            (typeof el.querySelector === "function" &&
              (el.querySelector(CHAPTER_ITEM_SELECTOR) ||
                el.querySelector('[target-id*="macro-markers"], ytd-macro-markers-list-renderer')))
          ) {
            relevant = true;
            break;
          }
        }
        if (relevant) break;
      }
      if (!relevant || scheduled) return;
      scheduled = true;
      setTimeout(() => {
        scheduled = false;
        injectChapterButtons();
      }, 120);
    });
    obs.observe(document.body, { childList: true, subtree: true });
    return obs;
  }

  // Bumped on every in-page navigation. A copy operation captures the value
  // it started with and abandons its result if the page has moved on
  // meanwhile, so a slow fetch for the video you just left can never paste
  // its transcript over the new one - and the button cannot be left stuck on a
  // spinner for a video that is no longer open.
  let navEpoch = 0;

  // YouTube navigation watcher
  let checkTimer = setInterval(() => {
    injectButton();
    injectChapterButtons();
    injectPlayerChapterButton();
  }, 400);
  let navRestartTimer = null;
  setupChapterObserver();

  document.addEventListener("yt-navigate-start", () => {
    // Invalidate as soon as the navigation begins, not when the new video is
    // ready: anything already in flight belongs to the video being left.
    navEpoch++;
    // Remember the transcript rows still on screen. They belong to the video
    // being left, and a scrape that runs before YouTube repopulates the panel
    // would otherwise read them as if they were the new video's.
    panelRowsAtNav = panelRowSignature(findTranscriptPanel());
  });

  document.addEventListener("yt-navigate-finish", () => {
    navEpoch++;
    chaptersCache = { videoId: null, chapters: null };
    chunkSession = null;
    // A button that survived the navigation can still carry the previous
    // video's label (e.g. a spinner mid-copy) - put it back to its default.
    resetMainButton(document.getElementById(BUTTON_ID));
    const oldOverlay = document.getElementById(DEBUG_OVERLAY_ID);
    if (oldOverlay) oldOverlay.remove(); // don't show stale stats from the previous video
    debugEnabled = null; // re-check ?ytxt_debug / localStorage for the new page
    clearInterval(checkTimer);
    // Rapid SPA navigations must not stack restart timers (double tick loops).
    if (navRestartTimer) clearTimeout(navRestartTimer);
    navRestartTimer = setTimeout(() => {
      injectButton();
      injectChapterButtons();
      injectPlayerChapterButton();
      checkTimer = setInterval(() => {
        injectButton();
        injectChapterButtons();
        injectPlayerChapterButton();
      }, 400);
    }, 200);
  });
})();
