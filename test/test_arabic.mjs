// Unit tests for the Arabic / RTL handling of the transcript pipeline.
//
// Everything here is extracted verbatim from content.js and driven with Arabic
// fixtures, because the failure mode these guard against is silent: a
// localized-locale page used to yield a transcript with rows dropped, a chapter
// list that resolved to nothing, or a copy in a different language than the
// video's own.
import fs from "node:fs";
import zlib from "node:zlib";

// CRLF-safe: a Windows checkout (core.autocrlf) restores CRLF line endings while
// every anchor below is written against LF, so normalize before matching.
const src = fs.readFileSync("content.js", "utf8").replace(/\r\n/g, "\n");
const extract = (a, b) => {
  const s = src.indexOf(a);
  const e = src.indexOf(b, s);
  if (s < 0 || e < 0) {
    console.error("FAIL: could not extract from content.js: " + a);
    process.exit(1);
  }
  return src.slice(s, e).trim();
};

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

const arabicIndic = (s) => String(s).replace(/[0-9]/g, (d) => "٠١٢٣٤٥٦٧٨٩"[+d]);
const persianIndic = (s) => String(s).replace(/[0-9]/g, (d) => "۰۱۲۳۴۵۶۷۸۹"[+d]);

// =========================================================
// 1. Localized numerals in timecodes
// =========================================================
{
  const folded = extract("  function foldDigits(", "\n\n  function parseISO8601Duration");
  const { parseTimecode, foldDigits } = new Function(`${folded}\n    return { parseTimecode, foldDigits };`)();

  check("ASCII timecodes are unchanged", parseTimecode("1:02:03") === 3723 && parseTimecode("0:08") === 8, `${parseTimecode("1:02:03")} / ${parseTimecode("0:08")}`);
  check("parenthesised ASCII timecode still parses", parseTimecode("(1:26:27)") === 5187, String(parseTimecode("(1:26:27)")));
  check("seconds-only form still parses", parseTimecode("45s") === 45, String(parseTimecode("45s")));
  check("Arabic-Indic '٠:٠٨' parses", parseTimecode("٠:٠٨") === 8, String(parseTimecode("٠:٠٨")));
  check("Arabic-Indic '٧:٢٩:٠٩' parses", parseTimecode("٧:٢٩:٠٩") === 26949, String(parseTimecode("٧:٢٩:٠٩")));
  check("Persian-Indic '۱:۰۲' parses", parseTimecode("۱:۰۲") === 62, String(parseTimecode("۱:۰۲")));
  check("a bidi mark around the timecode does not break it", parseTimecode("\u200f٠:٤٢") === 42, String(parseTimecode("\u200f٠:٤٢")));
  check("non-timecode text is still null", parseTimecode("no time here") === null && parseTimecode("") === null);
  check(
    "folding preserves length (titles are sliced by match offset)",
    foldDigits("\u200f٠:٠٨ text") .length === "\u200f٠:٠٨ text".length,
    `${foldDigits("\u200f٠:٠٨ text").length} vs ${"\u200f٠:٠٨ text".length}`
  );
}

// =========================================================
// 2. Chapter list parsed out of an Arabic description
// =========================================================
{
  const fnSrc = extract("  function chaptersFromDescriptionText(", "\n\n  // Fallback: read the rendered Chapters shelf");
  const foldSrc = extract("  function foldDigits(", "\n\n  function parseISO8601Duration");
  const foldDigits = new Function(`${foldSrc}\n    return foldDigits;`)();
  const parse = (text) => {
    // Only #description resolves: the structured-description scope is a second
    // element in the real page, and returning the same text for both would
    // double every chapter.
    const document = { querySelector: (sel) => (sel === "#description" ? { textContent: text } : null), querySelectorAll: () => [] };
    const fn = new Function("document", "foldDigits", `return (${fnSrc});`)(document, foldDigits);
    return fn();
  };

  const latin = parse("Intro\n0:00 Intro\n2:40 The body\n10:00 End");
  check("control: Latin description still parses", Array.isArray(latin) && latin.length === 3 && latin[1].title === "The body", JSON.stringify(latin));

  const decorated = parse("⌨️ (0:02:42) Learn HTML\n0:00 Intro\n1:00 Learn CSS");
  check(
    "leading decoration is still stripped (Latin)",
    Array.isArray(decorated) && decorated.find((c) => c.start === 162)?.title === "Learn HTML",
    JSON.stringify(decorated)
  );

  const arabicNums = parse("٠٠:٠٠ المقدمة\n٠٢:٤٠ الدرس الأول\n١٠:٠٠ الخاتمة");
  check("Arabic-Indic timecodes resolve the chapter list", Array.isArray(arabicNums) && arabicNums.length === 3, JSON.stringify(arabicNums));
  check("...with the timestamps read correctly", Array.isArray(arabicNums) && arabicNums[1].start === 160 && arabicNums[2].start === 600, JSON.stringify(arabicNums));

  const arabicTitles = parse("0:00 المقدمة\n2:40 الدرس الأول\n10:00 الخاتمة");
  check("Arabic-only titles survive (not deleted as non-alphanumeric)", Array.isArray(arabicTitles) && arabicTitles.length === 3, JSON.stringify(arabicTitles));
  check("...and are byte-identical to the description", Array.isArray(arabicTitles) && arabicTitles[0].title === "المقدمة" && arabicTitles[1].title === "الدرس الأول", JSON.stringify(arabicTitles));

  const persianNums = parse("۰۰:۰۰ شروع\n۰۱:۳۰ بخش دوم\n۰۵:۰۰ پایان");
  check("Persian-Indic timecodes resolve too", Array.isArray(persianNums) && persianNums.length === 3, JSON.stringify(persianNums));

  const digitsInTitle = parse("0:00 الفصل ٢ من ٥\n5:00 الفصل الثالث");
  check("digits inside a title are left as the author wrote them", Array.isArray(digitsInTitle) && digitsInTitle[0].title === "الفصل ٢ من ٥", JSON.stringify(digitsInTitle));

  // A line whose title is nothing but digits is a fragment, not a chapter -
  // including when those digits are written in Arabic-Indic numerals, which the
  // bare-number test has to fold before it can recognise them.
  const junk = parse("1:26 27\n١:٢٦ ٢٧\n3:00 real chapter here\n5:00 another chapter");
  check("bare-number fragments are still rejected (both scripts)", Array.isArray(junk) && junk.length === 2, JSON.stringify(junk));
}

// =========================================================
// Caption-source harness (Arabic fixtures)
// =========================================================
const capFnSrc = extract("  async function fetchCaptionsFallback", "  // =========================================================\n  // COPY HANDLERS");
const cleanSegmentText = (t) => String(t || "").replace(/\s+/g, " ").trim();
const parseTimecode = (text) => {
  if (!text) return null;
  const folded = String(text)
    .replace(/[\u200e\u200f\u061c]/g, " ")
    .replace(/[\u0660-\u0669\u06f0-\u06f9]/g, (d) => String(d.charCodeAt(0) & 0xf));
  const m = folded.match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return (m[1] ? parseInt(m[1], 10) * 3600 : 0) + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
};
// The real digit-folding helper (verbatim), for the extractors that need it as
// an injected dependency.
const foldDigits = new Function(
  `${extract("  function foldDigits(", "\n\n  function parseISO8601Duration")}\n    return foldDigits;`
)();

// The real label table and counter formatter (verbatim), instantiated for a
// given page language and ytxt_ui / ytxt_ui_strings / ytxt_numerals settings.
const numbersSrc = extract(
  "  // =========================================================\n  // NUMERALS IN THE UI",
  "\n\n  // =========================================================\n  // BIDI (RTL) GUARD FOR UI STRINGS"
);
const uiSrc = extract(
  "  // =========================================================\n  // UI STRINGS",
  "\n\n  // =========================================================\n  // PAGE DATA"
);
const buildUi = ({ lang = "en", navLang = undefined, ui = null, override = null, custom = null } = {}) =>
  new Function("document", "navigator", "localStorage", `${numbersSrc}\n${uiSrc}\n    return { t, countText };`)(
    // A null <html lang> exercises the navigator fallback.
    { documentElement: lang ? { getAttribute: () => lang } : null },
    { language: navLang === undefined ? lang || undefined : navLang },
    {
      getItem: (k) =>
        k === "ytxt_numerals" ? override : k === "ytxt_ui" ? ui : k === "ytxt_ui_strings" ? custom : null,
    }
  );

const VIDEO_ID = "abc123def45";
const FAKE_VISITOR = "CgsZm9vYmFyMTIzNDU2Nzg5MA==";
const panelSeg = (timestamp, text) => ({ transcriptSegmentViewModel: { timestamp, simpleText: text } });
const panelJson = (rows) => ({
  content: {
    engagementPanelSectionListRenderer: {
      content: {
        sectionListRenderer: {
          contents: [{ itemSectionRenderer: { contents: [{ timelineItemViewModel: { contentItems: rows } }] } }],
        },
      },
    },
  },
});
const okTimedtext = JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: "مرحبا " }, { utf8: "بالعالم" }] }, { tStartMs: 6000, segs: [{ utf8: "سطر ثان" }] }] });

function build({ tracks = [], audioTracks = null, defaultAudioTrackIndex = 0, timedtext = () => ({ status: 200, body: okTimedtext }), panel = () => ({ status: 400, json: { error: { code: 400, message: "Precondition check failed." } } }) } = {}) {
  const renderer = { captionTracks: tracks };
  if (audioTracks) {
    renderer.audioTracks = audioTracks;
    renderer.defaultAudioTrackIndex = defaultAudioTrackIndex;
  }
  const pr = { videoDetails: { videoId: VIDEO_ID }, captions: { playerCaptionsTracklistRenderer: renderer } };
  const log = [];
  let tCalls = 0;
  const respond = (r) => {
    const body = typeof r.json === "string" ? r.json : JSON.stringify(r.json);
    return { ok: r.status < 300, status: r.status, text: async () => body, json: async () => (typeof r.json === "string" ? JSON.parse(body) : r.json) };
  };
  const fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("get_panel")) {
      let bodyText = "";
      if (init?.body && typeof init.body.getReader === "function") {
        bodyText = zlib.gunzipSync(Buffer.from(await new Response(init.body).arrayBuffer())).toString("utf8");
      } else bodyText = String(init?.body || "");
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch (e) {}
      log.push({ kind: "getpanel", url, body: parsed });
      return respond(panel());
    }
    if (url.includes("youtubei")) {
      log.push({ kind: "innertube", url });
      return respond({ status: 200, json: { actions: [] } });
    }
    tCalls++;
    const r = timedtext(tCalls);
    log.push({ kind: "timedtext", url, call: tCalls });
    const body = typeof r.body === "string" ? r.body : JSON.stringify(r.body);
    return { ok: r.status < 300, status: r.status, text: async () => body, json: async () => JSON.parse(body) };
  };
  const readPageVar = () => pr;
  const livePlayerResponse = () => pr;
  const document = { querySelectorAll: () => [{ textContent: `"VISITOR_DATA":"${FAKE_VISITOR}"` }], getElementById: () => null, querySelector: () => null };
  const lastStats = { fallbacks: 0, capFail: null, capRetries: 0, capSource: null, capLang: null, capLangMismatch: false };
  const fn = new Function("readPageVar", "fetch", "cleanSegmentText", "sleep", "lastStats", "document", "parseTimecode", "livePlayerResponse", `return (${capFnSrc});`)(
    readPageVar, fetch, cleanSegmentText, () => Promise.resolve(), lastStats, document, parseTimecode, livePlayerResponse
  );
  return { fn, log, lastStats, kinds: (k) => log.filter((l) => l.kind === k), timedtextUrl: () => (log.find((l) => l.kind === "timedtext") || {}).url || "" };
}

// ytxt_lang is read from localStorage; the harness runs in bare Node, so a stub
// is installed for the duration of a case and removed again.
async function withLang(lang, run) {
  const had = Object.prototype.hasOwnProperty.call(globalThis, "localStorage");
  const prev = globalThis.localStorage;
  globalThis.localStorage = { getItem: (k) => (k === "ytxt_lang" && lang ? lang : null) };
  try {
    return await run();
  } finally {
    if (had) globalThis.localStorage = prev;
    else delete globalThis.localStorage;
  }
}

const track = (baseUrl, languageCode, kind) => (kind ? { baseUrl, languageCode, kind } : { baseUrl, languageCode });

// =========================================================
// 3. The caption LANGUAGE that gets copied
// =========================================================
{
  // The video's own language is Arabic, but only as auto-captions, while a
  // manual English track exists. "Prefer manual over ASR" used to win here and
  // copy the English translation.
  {
    const b = build({
      tracks: [track("https://tt/api/timedtext?v=x&lang=ar&kind=asr", "ar", "asr"), track("https://tt/api/timedtext?v=x&lang=en", "en")],
      audioTracks: [{ captionTrackIndices: [0] }],
    });
    await b.fn();
    check("the video's own language wins over a manual other-language track", /[?&]lang=ar\b/.test(b.timedtextUrl()), b.timedtextUrl());
    check("...and capLang reports that language", b.lastStats.capLang === "ar", String(b.lastStats.capLang));
    check("...with no mismatch flagged", b.lastStats.capLangMismatch === false);
  }

  // Within one language the manual track is still preferred over the ASR one.
  {
    const b = build({
      tracks: [
        track("https://tt/api/timedtext?v=x&lang=ar&kind=asr", "ar", "asr"),
        track("https://tt/api/timedtext?v=x&lang=ar", "ar"),
        track("https://tt/api/timedtext?v=x&lang=en", "en"),
      ],
      audioTracks: [{ captionTrackIndices: [0] }],
    });
    await b.fn();
    check("within one language, manual still beats ASR", /lang=ar&fmt=json3$/.test(b.timedtextUrl()), b.timedtextUrl());
    check("capLang is the language, not the kind", b.lastStats.capLang === "ar", String(b.lastStats.capLang));
  }

  // vssId alone (no languageCode) still identifies the language.
  {
    const b = build({ tracks: [{ vssId: "a.ar", kind: "asr", baseUrl: "https://tt/api/timedtext?v=x&lang=ar&kind=asr" }, { vssId: ".en", baseUrl: "https://tt/api/timedtext?v=x&lang=en" }] });
    await b.fn();
    check("a vssId-only payload resolves the default language", /[?&]lang=ar\b/.test(b.timedtextUrl()), b.timedtextUrl());
  }

  // An explicit request: a native Arabic track is used even though the page's
  // own default is English.
  {
    await withLang("ar", async () => {
      const b = build({
        tracks: [track("https://tt/api/timedtext?v=x&lang=en", "en"), track("https://tt/api/timedtext?v=x&lang=ar&kind=asr", "ar", "asr")],
        audioTracks: [{ captionTrackIndices: [0] }],
      });
      await b.fn();
      check("ytxt_lang=ar selects the Arabic track over the page default", /[?&]lang=ar\b/.test(b.timedtextUrl()), b.timedtextUrl());
      check("...capLang=ar, no mismatch", b.lastStats.capLang === "ar" && b.lastStats.capLangMismatch === false, `${b.lastStats.capLang} / ${b.lastStats.capLangMismatch}`);
    });
  }

  // A requested language with no track of its own is served by tlang.
  {
    await withLang("fr", async () => {
      const b = build({ tracks: [track("https://tt/api/timedtext?v=x&lang=ar&kind=asr", "ar", "asr")], audioTracks: [{ captionTrackIndices: [0] }] });
      await b.fn();
      check("a language with no track is requested via tlang", /[?&]tlang=fr\b/.test(b.timedtextUrl()), b.timedtextUrl());
      check("...and the copy is reported as that language", b.lastStats.capLang === "fr" && b.lastStats.capLangMismatch === false, `${b.lastStats.capLang} / ${b.lastStats.capLangMismatch}`);
    });
  }

  // A requested language the answering source cannot honor must not pass
  // silently: get_panel has no language parameter, so it is flagged.
  {
    await withLang("fr", async () => {
      const b = build({
        tracks: [track("https://tt/api/timedtext?v=x&lang=ar", "ar")],
        audioTracks: [{ captionTrackIndices: [0] }],
        timedtext: () => ({ status: 200, body: "" }),
        panel: () => ({ status: 200, json: panelJson([panelSeg("٠:٠٠", "مرحبا بكم"), panelSeg("١:٠٢", "الفقرة الثانية")]) }),
      });
      const rows = await b.fn();
      check("the Arabic get_panel rows are parsed", Array.isArray(rows) && rows.length === 2, JSON.stringify(rows));
      check("...source is getpanel, capLang the video default", b.lastStats.capSource === "getpanel" && b.lastStats.capLang === "ar", `${b.lastStats.capSource} / ${b.lastStats.capLang}`);
      check("...and the unhonorable request is flagged", b.lastStats.capLangMismatch === true, String(b.lastStats.capLangMismatch));
    });
  }
}

// =========================================================
// 4. get_panel response with Arabic-Indic timestamps
// =========================================================
{
  const b = build({
    tracks: [track("https://tt/api/timedtext?v=x&lang=ar", "ar")],
    timedtext: () => ({ status: 200, body: "" }),
    panel: () => ({
      status: 200,
      json: panelJson([panelSeg("٠:٠٠", "مرحبا بكم في الدورة"), panelSeg("١:٠٢", "الفقرة الثانية"), panelSeg("٧:٢٩:٠٩", "كلمة أخيرة")]),
    }),
  });
  const rows = await b.fn();
  check("localized timestamps do not drop get_panel rows", Array.isArray(rows) && rows.length === 3, JSON.stringify(rows) + " " + b.lastStats.capFail);
  check("...the Arabic text is intact", Array.isArray(rows) && rows[0].txt === "مرحبا بكم في الدورة", JSON.stringify(rows && rows[0]));
  check("...and the times are right", Array.isArray(rows) && rows[1].t === 62 && rows[2].t === 26949, JSON.stringify(rows));
  check("source = getpanel", b.lastStats.capSource === "getpanel", String(b.lastStats.capSource));
}

// =========================================================
// 5. Panel DOM scrape on a localized page
// =========================================================
{
  const fnSrc = extract("  async function loadTranscriptSegments(", "\n\n  function collectedMaxT");
  const segTimestamp = (seg) => {
    const el = seg.querySelector(".segment-timestamp");
    return el ? parseTimecode(el.textContent) : null;
  };
  const segText = (seg) => cleanSegmentText(seg.querySelector(".segment-text").textContent);
  const fmt = (t) => {
    const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = t % 60;
    return h > 0 ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
  };
  const N = 40;
  const words = Array.from({ length: N }, (_, i) => ({ t: i * 5, txt: "نص" + i }));
  const run = async (localized) => {
    const scroller = { clientHeight: 200, scrollHeight: N * 24, scrollTop: 0 };
    const panel = {
      querySelectorAll: () =>
        words.map((r) => ({
          querySelector: (q) => {
            if (q === ".segment-timestamp") return { textContent: localized ? arabicIndic(fmt(r.t)) : fmt(r.t) };
            if (q === ".segment-text") return { textContent: r.txt };
            return null;
          },
        })),
    };
    const fn = new Function("sleep", "segmentTimestamp", "segmentText", "findSegmentScroller", "getVideoDuration", "SUSPECT_GAP_SEC", "lastStats", `return (${fnSrc});`)(
      () => Promise.resolve(), segTimestamp, segText, () => scroller, () => N * 5, 30, {}
    );
    return fn(panel, Infinity, 0);
  };
  const latin = await run(false);
  check("control: ASCII panel timestamps -> all rows", latin.size === N, `size=${latin.size}`);
  const arabic = await run(true);
  check("Arabic-Indic panel timestamps -> all rows", arabic.size === N, `size=${arabic.size}`);
  check("...not flagged incomplete", !arabic.incomplete);
  const persian = await (async () => {
    const fnSrc2 = fnSrc;
    const scroller = { clientHeight: 200, scrollHeight: N * 24, scrollTop: 0 };
    const panel = {
      querySelectorAll: () =>
        words.map((r) => ({
          querySelector: (q) => {
            if (q === ".segment-timestamp") return { textContent: persianIndic(fmt(r.t)) };
            if (q === ".segment-text") return { textContent: r.txt };
            return null;
          },
        })),
    };
    const fn = new Function("sleep", "segmentTimestamp", "segmentText", "findSegmentScroller", "getVideoDuration", "SUSPECT_GAP_SEC", "lastStats", `return (${fnSrc2});`)(
      () => Promise.resolve(), segTimestamp, segText, () => scroller, () => N * 5, 30, {}
    );
    return fn(panel, Infinity, 0);
  })();
  check("Persian-Indic panel timestamps -> all rows", persian.size === N, `size=${persian.size}`);
}

// =========================================================
// 6. Chapter shelf on a localized page
// =========================================================
{
  const fnSrc = extract("  function chaptersFromChapterShelf(", "\n\n  function getChapters(");
  const run = (times) => {
    const items = times.map((t, i) => ({
      querySelector: (sel) => (sel.includes("#time") ? { textContent: t } : { getAttribute: () => "الفصل " + i, textContent: "الفصل " + i }),
    }));
    const document = { querySelectorAll: () => items };
    return new Function("document", "parseTimecode", "cleanSegmentText", "foldDigits", `return (${fnSrc});`)(
      document,
      parseTimecode,
      cleanSegmentText,
      foldDigits
    )();
  };
  const latin = run(["0:00", "2:40", "10:00"]);
  check("control: ASCII chapter shelf times resolve", Array.isArray(latin) && latin.length === 3, JSON.stringify(latin));
  const arabic = run([arabicIndic("0:00"), arabicIndic("2:40"), arabicIndic("10:00")]);
  check("Arabic-Indic chapter shelf times resolve", Array.isArray(arabic) && arabic.length === 3, JSON.stringify(arabic));
  check("...with the right seconds", Array.isArray(arabic) && arabic[1].start === 160, JSON.stringify(arabic));
  const persian = run([persianIndic("0:00"), persianIndic("2:40"), persianIndic("10:00")]);
  check("Persian-Indic chapter shelf times resolve", Array.isArray(persian) && persian.length === 3, JSON.stringify(persian));
}

// =========================================================
// 7. Chunking an RTL transcript
// =========================================================
{
  const chunksSrc = extract("  function buildChunks(", "\n\n  // =========================================================\n  // FALLBACK: CAPTION SOURCES");
  const buildChunks = new Function("CHUNK_MAX_CHARS", `return (${chunksSrc});`)(50);
  const LRI = "\u2066", PDI = "\u2069";

  const arabicRows = Array.from({ length: 8 }, (_, i) => ({ t: i * 5, txt: "كلمة" + i + "ا".repeat(12) }));
  const arabicChunks = buildChunks([{ title: "المقدمة", start: 0, end: 600 }], arabicRows);
  check("an Arabic chapter is split into parts", arabicChunks.length > 1, `got ${arabicChunks.length}`);
  check(
    "the part marker is isolated so bidi cannot reorder it into the title",
    arabicChunks.every((c) => c.title.startsWith("المقدمة " + LRI) && c.title.endsWith(PDI)),
    JSON.stringify(arabicChunks.map((c) => c.title))
  );
  check(
    "the Arabic title itself is untouched (no controls inside it)",
    arabicChunks.every((c) => c.title.slice(0, "المقدمة".length) === "المقدمة" && !c.title.slice(0, "المقدمة".length).includes("\u2066")),
    JSON.stringify(arabicChunks.map((c) => c.title))
  );
  check(
    "no Arabic segment is cut in half",
    (() => {
      let at = 0;
      return arabicChunks.every((c) => {
        const expect = arabicRows.slice(at, at + c.rowCount).map((r) => r.txt).join(" ");
        at += c.rowCount;
        return c.text.replace(/^.*\n/, "") === expect;
      });
    })()
  );
  check(
    "the parts reassemble into the whole body",
    arabicChunks.map((c) => c.text.replace(/^.*\n/, "")).join(" ") === arabicRows.map((r) => r.txt).join(" "),
    "parts did not reassemble"
  );
  check("every part body stays under the cap", arabicChunks.every((c) => c.text.replace(/^.*\n/, "").length <= 50), JSON.stringify(arabicChunks.map((c) => c.text.length)));

  // Hebrew is RTL too, and Latin titles must stay byte-identical to before.
  const hebrew = buildChunks([{ title: "פרק", start: 0, end: 600 }], Array.from({ length: 8 }, (_, i) => ({ t: i * 5, txt: "מילה" + i + "א".repeat(12) })));
  check("a Hebrew title is isolated as well", hebrew.every((c) => c.title.includes(LRI) && c.title.includes(PDI)), JSON.stringify(hebrew.map((c) => c.title)));

  const latinRows = Array.from({ length: 8 }, (_, i) => ({ t: i * 5, txt: "word" + i + "x".repeat(12) }));
  const latin = buildChunks([{ title: "Solo", start: 0, end: 600 }], latinRows);
  check(
    "a Latin title is byte-identical to the old format (no isolate added)",
    latin.every((c) => !c.title.includes(LRI) && !c.title.includes(PDI) && /^Solo \(part \d+\/\d+\)$/.test(c.title)),
    JSON.stringify(latin.map((c) => c.title))
  );
  const untitled = buildChunks([{ title: "", start: 0, end: Infinity }], latinRows);
  check(
    "an untitled span is still numbered by position, with no controls",
    untitled.every((c, i) => c.title === `Part ${i + 1}/${untitled.length}`),
    JSON.stringify(untitled.map((c) => c.title))
  );
  const one = buildChunks([{ title: "Solo", start: 0, end: 600 }], latinRows.slice(0, 2));
  check("a chapter that fits one chunk is still a plain title line", one.length === 1 && one[0].text.startsWith("Solo\n"), JSON.stringify(one[0].text));
  const arabicOne = buildChunks([{ title: "المقدمة", start: 0, end: 600 }], arabicRows.slice(0, 2));
  check("an Arabic chapter that fits keeps its bare title line", arabicOne.length === 1 && arabicOne[0].text.startsWith("المقدمة\n"), JSON.stringify(arabicOne[0].text));
  check(
    "a copy with no part marker carries no bidi controls at all",
    !arabicOne[0].text.includes("\u2066") && !arabicOne[0].text.includes("\u2068") && !arabicOne[0].text.includes("\u2069"),
    JSON.stringify(arabicOne[0].text)
  );
  check(
    "the pasted body itself is never altered by the marker guard",
    arabicChunks.every((c) => c.text.split("\n").slice(1).join("\n") === c.text.replace(/^.*\n/, "") && !/[\u2066\u2068\u2069]/.test(c.text.replace(/^.*\n/, ""))),
    "a control character leaked into the transcript body"
  );
}

// =========================================================
// 8. RTL guard on the UI strings that embed user content
// =========================================================
{
  const guardSrc = extract(
    "  // =========================================================\n  // BIDI (RTL) GUARD FOR UI STRINGS",
    "\n\n  // =========================================================\n  // UI STRINGS"
  );
  const { isolateRtl } = new Function(`${guardSrc}\n    return { isolateRtl };`)();

  check("an LTR value passes through untouched", isolateRtl("Intro") === "Intro", JSON.stringify(isolateRtl("Intro")));
  check("an RTL value is wrapped in an FSI/PDI isolate", isolateRtl("المقدمة") === "\u2068المقدمة\u2069", JSON.stringify(isolateRtl("المقدمة")));
  check("Hebrew is treated as RTL too", isolateRtl("פרק") === "\u2068פרק\u2069", JSON.stringify(isolateRtl("פרק")));
  check("null/undefined become an empty string", isolateRtl(null) === "" && isolateRtl(undefined) === "", JSON.stringify([isolateRtl(null), isolateRtl(undefined)]));
  check("a title with no strong character is left alone", isolateRtl("123 - 456") === "123 - 456", JSON.stringify(isolateRtl("123 - 456")));

  const makeEl = () => ({
    type: "",
    className: "",
    textContent: "",
    title: "",
    dataset: {},
    attrs: {},
    listeners: [],
    setAttribute(k, v) {
      this.attrs[k] = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] === undefined ? null : this.attrs[k];
    },
    addEventListener(k, fn) {
      this.listeners.push([k, fn]);
    },
    remove() {},
  });

  // The chapter badge in the description.
  {
    const fnSrc = extract("  function makeChapterButton(", "\n\n  function injectChapterButtons(");
    const make = new Function("document", "CHAPTER_BTN_CLS", "isolateRtl", "copyChapterRange", "t", `return (${fnSrc});`)(
      { createElement: () => makeEl() },
      "my-yt-chapter-copy",
      isolateRtl,
      () => {},
      buildUi().t
    );
    const arabic = make(null, { title: "المقدمة", start: 0, end: 10 });
    check("chapter badge tooltip isolates an Arabic title", arabic.title === "Copy transcript of chapter: \u2068المقدمة\u2069", arabic.title);
    check(
      "...and the tooltip restored when a chunk session ends carries it too",
      arabic.attrs["data-tip"] === arabic.title && arabic.attrs["aria-label"] === arabic.title,
      JSON.stringify(arabic.attrs)
    );
    const latin = make(null, { title: "Intro", start: 0, end: 10 });
    check("a Latin chapter tooltip is byte-identical to before", latin.title === "Copy transcript of chapter: Intro", latin.title);

    // ...and with the label table switched to Arabic, the whole sentence is
    // Arabic while the title keeps its own isolate.
    const makeAr = new Function("document", "CHAPTER_BTN_CLS", "isolateRtl", "copyChapterRange", "t", `return (${fnSrc});`)(
      { createElement: () => makeEl() },
      "my-yt-chapter-copy",
      isolateRtl,
      () => {},
      buildUi({ ui: "ar" }).t
    );
    const arBadge = makeAr(null, { title: "المقدمة", start: 0, end: 10 });
    check(
      "an Arabic UI tooltip is one Arabic sentence around the isolated title",
      arBadge.title === "نسخ نص الفصل: \u2068المقدمة\u2069",
      arBadge.title
    );
  }

  // The current-chapter badge in the player.
  {
    const fnSrc = extract("  function injectPlayerChapterButton(", "\n\n  // =========================================================\n  // MAIN BUTTON INJECTION ENGINE");
    const inserted = [];
    const container = { parentElement: { insertBefore: (el) => inserted.push(el) }, nextSibling: null };
    const document = { getElementById: () => null, querySelector: () => null, createElement: () => makeEl() };
    const run = (chapter) => {
      const inject = new Function("window", "document", "getChapters", "findVisiblePlayerChapterContainer", "playerCurrentChapter", "PLAYER_BTN_ID", "isolateRtl", "t", `return (${fnSrc});`)(
        { location: { pathname: "/watch" } },
        document,
        () => [chapter, { title: "Second", start: 100, end: 200 }],
        () => container,
        () => chapter,
        "my-yt-player-chapter-btn",
        isolateRtl,
        buildUi().t
      );
      inject();
    };
    run({ title: "المقدمة", start: 0, end: 100 });
    check(
      "player badge tooltip isolates an Arabic chapter title",
      inserted[0] && inserted[0].title === "Copy transcript of current chapter: \u2068المقدمة\u2069",
      String(inserted[0] && inserted[0].title)
    );
    inserted.length = 0;
    run({ title: "Intro", start: 0, end: 100 });
    check(
      "a Latin player tooltip is byte-identical to before",
      inserted[0] && inserted[0].title === "Copy transcript of current chapter: Intro",
      String(inserted[0] && inserted[0].title)
    );
  }
}

// =========================================================
// 9. The debug overlay and the CSS that carries user content
// =========================================================
{
  const guardSrc = extract(
    "  // =========================================================\n  // BIDI (RTL) GUARD FOR UI STRINGS",
    "\n\n  // =========================================================\n  // UI STRINGS"
  );
  const { isolateRtl } = new Function(`${guardSrc}\n    return { isolateRtl };`)();
  const fnSrc = extract("  function updateStatsOverlay(", "\n\n  // =========================================================\n  // UTILITIES");

  const makeEl = () => {
    const e = {
      id: "",
      className: "",
      type: "",
      textContent: "",
      attrs: {},
      __sub: {},
      append() {},
      appendChild() {},
      addEventListener() {},
      setAttribute(k, v) { this.attrs[k] = v; },
      getAttribute(k) { return this.attrs[k] === undefined ? null : this.attrs[k]; },
      remove() {},
      querySelector(sel) {
        return (this.__sub[sel] = this.__sub[sel] || makeEl());
      },
    };
    return e;
  };

  const render = (label) => {
    const created = [];
    const document = {
      getElementById: () => null,
      createElement: () => {
        const e = makeEl();
        created.push(e);
        return e;
      },
      body: { appendChild() {} },
    };
    const lastStats = {
      label,
      source: "panel",
      rows: 1120,
      panelRows: 1120,
      sweep: false,
      sweepSteps: 0,
      incomplete: false,
      fallbacks: 0,
      capSource: "timedtext",
      capLang: "ar",
      capLangMismatch: false,
      capRetries: 0,
      range: "[0s, end]",
      durationMs: 12,
      capFail: null,
      staleBlob: null,
      error: null,
    };
    const fn = new Function(
      "document",
      "lastStats",
      "isDebugEnabled",
      "currentVideoId",
      "DEBUG_OVERLAY_ID",
      "copyTextToClipboard",
      "isolateRtl",
      "t",
      `return (${fnSrc});`
    )(document, lastStats, () => true, () => "abc123def45", "my-yt-debug-overlay", async () => {}, isolateRtl, buildUi().t);
    fn();
    const overlay = created[0];
    return {
      summary: overlay.__sub[".my-yt-debug-summary"].textContent,
      report: overlay.__sub[".my-yt-debug-json"].textContent,
    };
  };

  const arabic = render("Chapter: المقدمة");
  check("the overlay isolates an RTL label so the diagnostics keep their order", arabic.summary.includes("\u2068Chapter: المقدمة\u2069"), arabic.summary);
  check("...the diagnostics are still all there", /source=panel rows=1120/.test(arabic.summary), arabic.summary);
  check(
    "...and the copied JSON report stays free of bidi controls",
    !/\u2066|\u2068|\u2069/.test(arabic.report) && arabic.report.includes('"label": "Chapter: المقدمة"'),
    arabic.report.slice(0, 160)
  );
  const latin = render("Full transcript");
  check("a Latin label is displayed byte-identically", latin.summary.startsWith("Full transcript — source=panel"), latin.summary);

  // The chapter badge is positioned logically, so a mirrored RTL watch page
  // cannot put it on top of the chapter title it belongs to.
  const css = fs.readFileSync("content.css", "utf8").replace(/\r\n/g, "\n");
  const badgeRule = css.slice(css.indexOf(".my-yt-chapter-copy {"), css.indexOf(".my-yt-chapter-copy:hover"));
  check("the chapter badge uses a logical inline-end inset", /inset-inline-end: 6px/.test(badgeRule), badgeRule.replace(/\s+/g, " ").slice(0, 120));
  check("...and no physical `right` offset", !/^\s*right:/m.test(badgeRule), "a physical right offset is still there");
  check("the overlay is positioned logically too", /inset-inline-end: 16px/.test(css), "no logical inset on the overlay");
  check(
    "the overlay text is direction-neutral for display",
    (css.match(/unicode-bidi: plaintext/g) || []).length >= 2,
    "the overlay rules lost their unicode-bidi guard"
  );
}

// =========================================================
// 10. A digit-only chapter title is rejected in either script
// =========================================================
{
  const fnSrc = extract("  function chaptersFromChapterShelf(", "\n\n  function getChapters(");
  const run = (pairs) => {
    const items = pairs.map(([time, title]) => ({
      querySelector: (sel) => (sel.includes("#time") ? { textContent: time } : { getAttribute: () => title, textContent: title }),
    }));
    return new Function("document", "parseTimecode", "cleanSegmentText", "foldDigits", `return (${fnSrc});`)(
      { querySelectorAll: () => items },
      parseTimecode,
      cleanSegmentText,
      foldDigits
    )();
  };
  check("control: real Arabic titles resolve", Array.isArray(run([["0:00", "المقدمة"], ["1:00", "الدرس الأول"], ["2:00", "الخاتمة"]])), "expected 3 chapters");
  check("numeric-only Latin titles are rejected", run([["0:00", "27"], ["1:00", "28"]]) === null, JSON.stringify(run([["0:00", "27"], ["1:00", "28"]])));
  check(
    "numeric-only Arabic-Indic titles are rejected too",
    run([["0:00", "٢٧"], ["1:00", "٢٨"]]) === null,
    JSON.stringify(run([["0:00", "٢٧"], ["1:00", "٢٨"]]))
  );
}

// =========================================================
// 11. Chunk counters in the page's numerals
// =========================================================
{
  // The real formatter, driven through the shared harness so the numerals are
  // resolved exactly as content.js would resolve them.
  const makeCounter = ({ lang = null, navLang = null, override = null } = {}) =>
    buildUi({ lang: lang || "", navLang: navLang || undefined, override });

  const en = makeCounter({ lang: "en" });
  check("an English page counts in ASCII digits", en.countText(1, 3) === "1/3", en.countText(1, 3));
  check("a bare count formats the same way", en.countText(4) === "4", en.countText(4));
  check("the slash stays between the two numbers", en.countText(2, 10).indexOf("/") === 1, en.countText(2, 10));

  // The trap this exists for: Intl resolves the region-less tag "ar" to LATIN
  // digits, and a page's <html lang> very often carries no region - without the
  // pin, the Arabic UI would show ASCII digits, the one case it is for.
  const ar = makeCounter({ lang: "ar" });
  check("a region-less Arabic page gets Arabic-Indic digits", ar.countText(1, 3) === "١/٣", ar.countText(1, 3));
  check("a bare count is Arabic-Indic too", ar.countText(7) === "٧", ar.countText(7));
  check("a regioned Arabic page does too", makeCounter({ lang: "ar-EG" }).countText(1, 3) === "١/٣", makeCounter({ lang: "ar-EG" }).countText(1, 3));
  check(
    "the Maghreb keeps Latin digits (region wins over the language pin)",
    makeCounter({ lang: "ar-MA" }).countText(1, 3) === "1/3",
    makeCounter({ lang: "ar-MA" }).countText(1, 3)
  );
  check("a Persian page gets Persian-Indic digits", makeCounter({ lang: "fa" }).countText(1, 3) === "۱/۳", makeCounter({ lang: "fa" }).countText(1, 3));
  check("a German page keeps ASCII digits", makeCounter({ lang: "de-DE" }).countText(1, 3) === "1/3", makeCounter({ lang: "de-DE" }).countText(1, 3));

  check(
    "no <html lang> falls back to navigator.language",
    makeCounter({ navLang: "ar-EG" }).countText(1, 3) === "١/٣",
    makeCounter({ navLang: "ar-EG" }).countText(1, 3)
  );
  check("neither available falls back to ASCII", makeCounter({}).countText(1, 3) === "1/3", makeCounter({}).countText(1, 3));

  check(
    "ytxt_numerals=arab forces Arabic-Indic digits on any page",
    makeCounter({ lang: "en", override: "arab" }).countText(1, 3) === "١/٣",
    makeCounter({ lang: "en", override: "arab" }).countText(1, 3)
  );
  check(
    "ytxt_numerals=latn forces ASCII on an Arabic page",
    makeCounter({ lang: "ar-EG", override: "latn" }).countText(1, 3) === "1/3",
    makeCounter({ lang: "ar-EG", override: "latn" }).countText(1, 3)
  );
  check(
    "a bogus numbering system degrades to ASCII instead of throwing",
    makeCounter({ lang: "ar", override: "bogus" }).countText(1, 3) === "1/3",
    makeCounter({ lang: "ar", override: "bogus" }).countText(1, 3)
  );
  const unknown = makeCounter({ lang: "xx-YY" });
  check("an unknown locale does not throw", typeof unknown.countText(2, 5) === "string" && unknown.countText(2, 5).includes("/"), unknown.countText(2, 5));

  // Localizing chrome must not localize content: the copied part markers, which
  // users grep for, stay ASCII on an Arabic page too.
  const chunkSrc = extract("  function buildChunks(", "\n\n  // =========================================================\n  // FALLBACK: CAPTION SOURCES");
  const build = new Function("CHUNK_MAX_CHARS", `return (${chunkSrc});`)(50);
  const rows = Array.from({ length: 8 }, (_, i) => ({ t: i * 5, txt: "كلمة" + i + "ا".repeat(12) }));
  const chunkTitles = build([{ title: "المقدمة", start: 0, end: 600 }], rows).map((c) => c.title.replace(/[\u2066\u2069]/g, ""));
  check("copied part markers stay ASCII even on an Arabic page", chunkTitles.every((t) => /\(part \d+\/\d+\)$/.test(t)), JSON.stringify(chunkTitles));
  check("and carry no Arabic-Indic or Persian-Indic digits", chunkTitles.every((t) => !/[٠-٩۰-۹]/.test(t)), JSON.stringify(chunkTitles));
}

// =========================================================
// 12. The UI label table
// =========================================================
{
  const en = buildUi();
  check("English is the default with no ytxt_ui", en.t("button.idle") === "📜 Transcript", en.t("button.idle"));
  check("placeholders are filled in", en.t("chapter.tip", { title: "Intro" }) === "Copy transcript of chapter: Intro", en.t("chapter.tip", { title: "Intro" }));
  check("an unfilled placeholder is left alone", en.t("chapter.tip") === "Copy transcript of chapter: {title}", en.t("chapter.tip"));

  const ar = buildUi({ ui: "ar" });
  check("ytxt_ui=ar translates the main button", ar.t("button.idle") === "📜 النص", ar.t("button.idle"));
  check("...the chunk labels, around localized digits", ar.t("badge.chunkNext", { count: ar.countText(2, 3) }) === "⏭٢/٣", ar.t("badge.chunkNext", { count: ar.countText(2, 3) }));
  check("...the overlay chrome", ar.t("debug.copy") === "📋 نسخ التقرير" && ar.t("debug.closeTip") === "إخفاء نافذة التصحيح", `${ar.t("debug.copy")} / ${ar.t("debug.closeTip")}`);
  check("...and the alerts, which is what a failed copy shows", ar.t("error.noRange") === "لا يوجد نص لهذا النطاق من الفصل." && ar.t("error.captionSources") === "فشلت جميع مصادر الترجمة:", `${ar.t("error.noRange")} / ${ar.t("error.captionSources")}`);
  check(
    "the Arabic tooltip sentence gets the isolated title",
    ar.t("chapter.tip", { title: "\u2068المقدمة\u2069" }) === "نسخ نص الفصل: \u2068المقدمة\u2069",
    ar.t("chapter.tip", { title: "\u2068المقدمة\u2069" })
  );
  // The report's label is translated, but its title stays raw: the report is
  // machine-readable and must not carry bidi controls.
  check("the report label is translated with the title raw", ar.t("label.chapter", { title: "المقدمة" }) === "الفصل: المقدمة", ar.t("label.chapter", { title: "المقدمة" }));

  check(
    "ytxt_ui=auto follows the page into a built-in table",
    buildUi({ ui: "auto", lang: "ar" }).t("button.idle") === "📜 النص",
    buildUi({ ui: "auto", lang: "ar" }).t("button.idle")
  );
  check(
    "...and stays English for a page language with no table",
    buildUi({ ui: "auto", lang: "de-DE" }).t("button.idle") === "📜 Transcript",
    buildUi({ ui: "auto", lang: "de-DE" }).t("button.idle")
  );
  check("an unknown ytxt_ui language falls back to English", buildUi({ ui: "zz" }).t("button.idle") === "📜 Transcript", buildUi({ ui: "zz" }).t("button.idle"));

  // A user-supplied table: add a language, or override single built-in labels.
  const custom = JSON.stringify({ de: { "button.idle": "📜 Transkript" }, en: { "error.noText": "Nothing to copy." } });
  const de = buildUi({ ui: "de", custom });
  check("a user-supplied language is used", de.t("button.idle") === "📜 Transkript", de.t("button.idle"));
  check(
    "...with built-in English filling every key it leaves out",
    de.t("error.noText") === "No transcript text was loaded.",
    de.t("error.noText")
  );
  const overridden = buildUi({ custom });
  check("a user can override a single built-in label", overridden.t("error.noText") === "Nothing to copy.", overridden.t("error.noText"));
  check("without disturbing the rest of the table", overridden.t("chapter.noTitleTip") === "Copy transcript of this chapter", overridden.t("chapter.noTitleTip"));
  check(
    "a malformed ytxt_ui_strings is ignored, not fatal",
    buildUi({ ui: "de", custom: "{not json" }).t("button.idle") === "📜 Transcript",
    buildUi({ ui: "de", custom: "{not json" }).t("button.idle")
  );

  // Every key the extension asks for must exist in the built-in English table -
  // a typo would otherwise show the raw key to a user.
  const keysInSource = [...src.matchAll(/t\("([a-z]+\.[A-Za-z]+)"/g)].map((m) => m[1]);
  const enTable = new Function(`${uiSrc}\n    return UI_STRINGS.en;`)();
  const missing = [...new Set(keysInSource)].filter((k) => typeof enTable[k] !== "string");
  check(
    `every t() key in content.js exists in the English table (${new Set(keysInSource).size} keys)`,
    missing.length === 0 && keysInSource.length > 10,
    `missing: ${missing.join(", ") || "none"}; found ${keysInSource.length} call sites`
  );
  // ...and that the Arabic table does not translate a diagnostic field name.
  const arTable = new Function(`${uiSrc}\n    return UI_STRINGS.ar;`)();
  check(
    "no diagnostic field name is translated",
    Object.keys(arTable).every((k) => /^(button|badge|chapter|player|chunk|label|debug|error)\./.test(k)),
    Object.keys(arTable).filter((k) => !/^(button|badge|chapter|player|chunk|label|debug|error)\./.test(k)).join(",")
  );
  check(
    "the Arabic table covers every English key",
    Object.keys(enTable).filter((k) => typeof arTable[k] !== "string").length === 0,
    Object.keys(enTable).filter((k) => typeof arTable[k] !== "string").join(",")
  );
}

console.log(failures === 0 ? "\nALL ARABIC / RTL TESTS PASSED" : `\n${failures} ARABIC / RTL TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
