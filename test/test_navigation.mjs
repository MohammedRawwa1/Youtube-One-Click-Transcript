// Regression tests for in-page navigation: playlist next/previous, a
// related-video click, a chapter link.
//
// The bug these cover: YouTube is a single-page app, so the inline
// `ytInitialPlayerResponse` script is written once on the first hard load and
// is NEVER rewritten when the page moves to another video. Resolving captions
// from it therefore fetched the PREVIOUS video's caption track and copied the
// previous video's transcript - correct only after a manual browser refresh.
//
// The real helpers and the real `fetchCaptionsFallback` are extracted straight
// out of content.js (the same technique test_capfetch.mjs uses), so what runs
// here is the shipped code rather than a copy of it.
import fs from "node:fs";
import zlib from "node:zlib";

// CRLF-safe: a Windows checkout (core.autocrlf) restores CRLF line endings while
// every anchor below is written against LF, so normalize before matching.
const src = fs.readFileSync("content.js", "utf8").replace(/\r\n/g, "\n");

function extract(startMarker, endMarker, label) {
  const start = src.indexOf(startMarker);
  const end = src.indexOf(endMarker, start);
  if (start < 0 || end < 0) {
    console.error(`FAIL: could not extract ${label}`);
    process.exit(1);
  }
  return src.slice(start, end);
}

// The real label table (verbatim from content.js), so the guard under test uses
// the same strings the extension ships.
const numbersSrc = src.slice(
  src.indexOf("  // =========================================================\n  // NUMERALS IN THE UI"),
  src.indexOf("\n\n  // =========================================================\n  // BIDI (RTL) GUARD FOR UI STRINGS")
);
const stringsSrc = src.slice(
  src.indexOf("  // =========================================================\n  // UI STRINGS"),
  src.indexOf("\n\n  // =========================================================\n  // PAGE DATA")
);
const buildUi = ({ lang = "en", ui = null, override = null, custom = null } = {}) =>
  new Function(
    "document",
    "navigator",
    "localStorage",
    `${numbersSrc}\n${stringsSrc}\n    return { countText, t };`
  )(
    { documentElement: { getAttribute: () => lang } },
    { language: lang },
    {
      getItem: (k) =>
        k === "ytxt_numerals" ? override : k === "ytxt_ui" ? ui : k === "ytxt_ui_strings" ? custom : null,
    }
  );
const t = buildUi().t;

const navFnSrc = extract(
  "  // =========================================================\n  // WHICH VIDEO IS PLAYING?",
  "  // =========================================================\n  // CHAPTERS",
  "the navigation/staleness guard"
);
const capFnSrc = extract(
  "  async function fetchCaptionsFallback",
  "  // =========================================================\n  // COPY HANDLERS",
  "fetchCaptionsFallback"
);
const panelFnSrc = extract(
  "  // A cheap identity for the rows currently rendered in the transcript panel:",
  "  function segmentTimestamp(seg) {",
  "the transcript-panel staleness guard"
);

const OLD_ID = "OLDid000000";
const NEW_ID = "NEWid111111";
const STALE_TRACK = "https://example.com/api/timedtext?v=" + OLD_ID + "&caps=asr";
const FRESH_TRACK = "https://example.com/api/timedtext?v=" + NEW_ID + "&caps=asr";
const FAKE_VISITOR = "CgsZm9vYmFyMTIzNDU2Nzg5MA==";

const cleanSegmentText = (t) => String(t || "").replace(/\s+/g, " ").trim();
const sleep = () => new Promise((r) => setTimeout(r, 1));
const parseTimecode = (text) => {
  if (!text) return null;
  const m = String(text).match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
};

const b64 = (bytes) => Buffer.from(bytes).toString("base64");
// get_panel params: field 149 -> { 1: video_id, 3: 1 }
function panelParamsFor(id) {
  const vid = [...Buffer.from(id, "utf8")];
  return b64([0xaa, 0x09, vid.length + 4, 0x0a, vid.length, ...vid, 0x18, 0x01]);
}
// get_transcript params: { 1: video_id }
function transcriptParamsFor(id) {
  const vid = [...Buffer.from(id, "utf8")];
  return encodeURIComponent(b64([0x0a, vid.length, ...vid]));
}

function prFor(id, baseUrl) {
  return {
    videoDetails: { videoId: id },
    captions: {
      playerCaptionsTracklistRenderer: {
        captionTracks: baseUrl ? [{ baseUrl, kind: "asr" }] : [],
      },
    },
  };
}

function panelJson(text) {
  return {
    content: {
      engagementPanelSectionListRenderer: {
        content: {
          sectionListRenderer: {
            contents: [
              {
                itemSectionRenderer: {
                  contents: [
                    {
                      timelineItemViewModel: {
                        contentItems: [
                          { transcriptSegmentViewModel: { timestamp: "0:00", simpleText: text } },
                        ],
                      },
                    },
                  ],
                },
              },
            ],
          },
        },
      },
    },
  };
}

function innertubeJson(text) {
  return {
    actions: [
      {
        updateEngagementPanelAction: {
          content: {
            transcriptRenderer: {
              body: {
                transcriptBodyRenderer: {
                  cueGroups: [
                    {
                      transcriptCueGroupRenderer: {
                        cues: [
                          { transcriptCueRenderer: { startOffsetMs: 1000, cue: { simpleText: text } } },
                        ],
                      },
                    },
                  ],
                },
              },
            },
          },
        },
      },
    ],
  };
}

const timedtextJson = (text) =>
  JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: text }] }] });

const T_DEFAULT = () => ({ status: 200, body: timedtextJson("stale old track") });
const P_DEFAULT = () => ({ status: 200, json: panelJson("panel segment") });
const I_DEFAULT = () => ({ status: 200, json: innertubeJson("innertube segment") });

function build(opts = {}) {
  const {
    urlId = NEW_ID,
    pageVars = {},
    playerElement = null,
    flexy = null,
    timedtext = T_DEFAULT,
    panel = P_DEFAULT,
    innertube = I_DEFAULT,
    docScript = `"VISITOR_DATA":"${FAKE_VISITOR}"`,
  } = opts;

  const document = {
    getElementById: (id) => (id === "movie_player" ? playerElement : null),
    querySelector: (sel) => (sel === "ytd-watch-flexy" ? flexy : null),
    querySelectorAll: () => [{ textContent: docScript }],
    cookie: "",
  };
  const readPageVar = (name) => pageVars[name] ?? null;
  const currentVideoId = () => urlId;
  const lastStats = {
    fallbacks: 0,
    capFail: null,
    capRetries: 0,
    capSource: null,
    staleBlob: null,
  };

  const buildNav = new Function(
    "document",
    "readPageVar",
    "currentVideoId",
    `${navFnSrc}
    return { blobVideoId, blobIsCurrent, pageDataForCurrentVideo, livePlayerResponse };`
  );
  const nav = buildNav(document, readPageVar, currentVideoId);

  const log = [];
  const mk = (r, bodyStr) => ({
    ok: r.status >= 200 && r.status < 300,
    status: r.status,
    text: async () => bodyStr,
    json: async () => (typeof r.json === "string" ? JSON.parse(bodyStr) : r.json),
  });
  let tCalls = 0;
  const fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("get_panel")) {
      const r = panel();
      let bodyText = "";
      if (init?.body && typeof init.body.getReader === "function") {
        const ab = await new Response(init.body).arrayBuffer();
        bodyText = zlib.gunzipSync(Buffer.from(ab)).toString("utf8");
      } else {
        bodyText = String(init?.body || "");
      }
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch (e) {}
      log.push({ kind: "getpanel", url, body: parsed });
      const bodyStr = typeof r.json === "string" ? r.json : JSON.stringify(r.json);
      return mk(r, bodyStr);
    }
    if (url.includes("youtubei")) {
      const r = innertube();
      log.push({ kind: "innertube", url, body: init?.body ? JSON.parse(init.body) : null });
      const bodyStr = typeof r.json === "string" ? r.json : JSON.stringify(r.json);
      return mk(r, bodyStr);
    }
    tCalls++;
    const b = timedtext(tCalls);
    log.push({ kind: "timedtext", url, call: tCalls });
    const bodyStr = typeof b.body === "string" ? b.body : JSON.stringify(b.body);
    return mk(b, bodyStr);
  };

  const buildFn = new Function(
    "readPageVar",
    "fetch",
    "cleanSegmentText",
    "sleep",
    "lastStats",
    "document",
    "parseTimecode",
    "currentVideoId",
    "livePlayerResponse",
    `return (${capFnSrc});`
  );
  const capFn = buildFn(
    readPageVar,
    fetch,
    cleanSegmentText,
    sleep,
    lastStats,
    document,
    parseTimecode,
    currentVideoId,
    nav.livePlayerResponse
  );

  return { nav, capFn, log, lastStats, kinds: (k) => log.filter((l) => l.kind === k) };
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// ---- the transcript-panel staleness guard -----------------------------------
//
// The panel outlives an in-page navigation: YouTube keeps the element and
// repopulates it asynchronously, so right after a playlist jump its DOM can
// still hold the previous video's rows. These build a panel whose rows only
// change if the "native button" is really clicked again.
function buildPanelWorld({ rows = ["old segment one", "old segment two"], snapshot = null, refreshed = null, reopenClicks = true } = {}) {
  const state = { rows: [...rows], visibility: "ENGAGEMENT_PANEL_VISIBILITY_EXPANDED" };
  const calls = { openTranscript: 0, waitForTranscriptPanel: 0, collapsed: 0, order: [] };
  const panel = {
    setAttribute(k, v) {
      if (k === "visibility") {
        state.visibility = v;
        if (v === "ENGAGEMENT_PANEL_VISIBILITY_COLLAPSED") {
          calls.collapsed++;
          calls.order.push("collapse");
        }
      }
    },
    getAttribute: (k) => (k === "visibility" ? state.visibility : null),
    querySelectorAll: () => state.rows.map((t) => ({ textContent: t })),
    querySelector: () => null,
  };
  const findTranscriptPanel = () => panel;
  const openTranscript = async () => {
    calls.openTranscript++;
    calls.order.push("open");
    if (reopenClicks && refreshed) state.rows = [...refreshed];
  };
  const waitForTranscriptPanel = async () => {
    calls.waitForTranscriptPanel++;
    return panel;
  };
  const fn = new Function(
    "panelRowsAtNav",
    "findTranscriptPanel",
    "waitForTranscriptPanel",
    "openTranscript",
    "sleep",
    "cleanSegmentText",
    "t",
    // The slice holds two declarations, so it goes into a function body rather
    // than an expression position.
    `${panelFnSrc}
    return ensureFreshTranscriptPanel;`
  )(snapshot, findTranscriptPanel, waitForTranscriptPanel, openTranscript, sleep, cleanSegmentText, t);
  return { fn, calls, state };
}

const OLD_ROWS = ["old segment one", "old segment two"];
const signatureOf = (rows) => {
  let out = rows.length + ":";
  for (const r of rows) out += r + "|";
  return out;
};

{
  // Before a navigation the panel is trusted as-is: one signature read, no
  // close, no reopen.
  const w = buildPanelWorld({ snapshot: null });
  const panel = await w.fn();
  check("no navigation since: panel returned as-is", panel !== null, String(panel));
  check(
    "no navigation since: panel not closed or reopened",
    w.calls.collapsed === 0 && w.calls.openTranscript === 0 && w.calls.waitForTranscriptPanel === 1,
    JSON.stringify(w.calls)
  );
}

{
  // Rows that differ from what was on screen at navigation time were rendered
  // for this video, so they are used without forcing a reopen.
  const w = buildPanelWorld({
    rows: ["new segment one", "new segment two"],
    snapshot: signatureOf(OLD_ROWS),
  });
  const panel = await w.fn();
  check("re-rendered rows are accepted", panel !== null);
  check(
    "re-rendered rows: no reopen needed",
    w.calls.collapsed === 0 && w.calls.openTranscript === 0,
    JSON.stringify(w.calls)
  );
}

{
  // The bug: the panel still shows exactly the rows that were on screen when the
  // page navigated. It must be re-opened, and the new rows used.
  const w = buildPanelWorld({ rows: OLD_ROWS, snapshot: signatureOf(OLD_ROWS), refreshed: ["new segment one", "new segment two"] });
  const panel = await w.fn();
  check("rows from the previous video are detected", w.calls.collapsed === 1, JSON.stringify(w.calls));
  check(
    "the stale panel is closed before it is reopened",
    JSON.stringify(w.calls.order) === '["collapse","open"]',
    JSON.stringify(w.calls.order)
  );
  check("the panel is reopened through the native button", w.calls.openTranscript === 1, String(w.calls.openTranscript));
  check(
    "the panel handed back carries the new video's rows",
    panel.querySelectorAll("ytd-transcript-segment-renderer")[0].textContent === "new segment one",
    panel.querySelectorAll("ytd-transcript-segment-renderer")[0].textContent
  );
}

{
  // If the rows cannot be made to change the panel may still be the previous
  // video's, so the call fails instead of copying the wrong transcript.
  const w = buildPanelWorld({ rows: OLD_ROWS, snapshot: signatureOf(OLD_ROWS), reopenClicks: false });
  let threw = null;
  try {
    await w.fn();
  } catch (e) {
    threw = e;
  }
  check("unrefreshable stale panel refuses to be used", threw !== null, "returned the stale panel");
  check(
    "the refusal says what to do",
    /previous video/.test(String(threw && threw.message)) && /manually/.test(String(threw && threw.message)),
    String(threw && threw.message)
  );
}

{
  // A panel that had rendered nothing when the navigation began has nothing to
  // inherit, so the first rows it renders are this video's.
  const w = buildPanelWorld({ rows: ["fresh segment"], snapshot: "" });
  const panel = await w.fn();
  check("empty-at-navigation panel is accepted once rows appear", panel !== null);
  check("empty-at-navigation panel: no reopen", w.calls.openTranscript === 0, JSON.stringify(w.calls));
}

{
  // A panel holding no rows at all is never suspected.
  const w = buildPanelWorld({ rows: [], snapshot: signatureOf(OLD_ROWS) });
  const panel = await w.fn();
  check("panel with no rows is accepted", panel !== null && w.calls.openTranscript === 0);
}

// ---- the guard itself -------------------------------------------------------
{
  const w = build({ pageVars: { ytInitialPlayerResponse: prFor(NEW_ID, FRESH_TRACK) } });
  const pr = w.nav.livePlayerResponse();
  check(
    "a player response for the URL's video is accepted",
    pr?.videoDetails?.videoId === NEW_ID,
    JSON.stringify(pr?.videoDetails)
  );
}

{
  const w = build({ pageVars: { ytInitialPlayerResponse: prFor(OLD_ID, STALE_TRACK) } });
  check(
    "the previous video's player response is rejected",
    w.nav.livePlayerResponse() === null,
    JSON.stringify(w.nav.livePlayerResponse()?.videoDetails)
  );
}

{
  // The player element's own response is the live one even when the page
  // variable still holds the previous video.
  const w = build({
    pageVars: { ytInitialPlayerResponse: prFor(OLD_ID, STALE_TRACK) },
    playerElement: { getPlayerResponse: () => prFor(NEW_ID, FRESH_TRACK) },
  });
  check(
    "the player element's response wins over a stale page variable",
    w.nav.livePlayerResponse()?.videoDetails?.videoId === NEW_ID,
    JSON.stringify(w.nav.livePlayerResponse()?.videoDetails)
  );
}

{
  const w = build({
    pageVars: { ytInitialPlayerResponse: prFor(OLD_ID, STALE_TRACK) },
    flexy: { playerData: prFor(NEW_ID, FRESH_TRACK) },
  });
  check(
    "ytd-watch-flexy.playerData is used when the page variable is stale",
    w.nav.livePlayerResponse()?.videoDetails?.videoId === NEW_ID,
    JSON.stringify(w.nav.livePlayerResponse()?.videoDetails)
  );
}

{
  const w = build({ pageVars: { ytInitialPlayerResponse: { videoDetails: {} } } });
  check(
    "a blob that names no video is accepted (nothing to contradict)",
    w.nav.livePlayerResponse() !== null,
    "rejected"
  );
}

{
  const stale = { currentVideoEndpoint: { watchEndpoint: { videoId: OLD_ID } } };
  const fresh = { currentVideoEndpoint: { watchEndpoint: { videoId: NEW_ID } } };
  const bare = { contents: {} };
  const ws = build({ pageVars: { ytInitialData: stale } });
  const wf = build({ pageVars: { ytInitialData: fresh } });
  const wb = build({ pageVars: { ytInitialData: bare } });
  check("stale ytInitialData is rejected", ws.nav.pageDataForCurrentVideo("ytInitialData") === null, "accepted");
  check("matching ytInitialData is accepted", wf.nav.pageDataForCurrentVideo("ytInitialData") !== null, "rejected");
  check("id-less ytInitialData is accepted", wb.nav.pageDataForCurrentVideo("ytInitialData") !== null, "rejected");
}

// ---- the reported bug: a playlist jump must copy the NEW video ---------------
{
  const w = build({
    pageVars: { ytInitialPlayerResponse: prFor(OLD_ID, STALE_TRACK) },
    panel: () => ({ status: 200, json: panelJson("segment of the new video") }),
  });
  const rows = await w.capFn(true);

  check(
    "playlist jump: the stale caption track is never requested",
    w.kinds("timedtext").length === 0,
    JSON.stringify(w.kinds("timedtext"))
  );
  check(
    "playlist jump: rows come from the new video",
    Array.isArray(rows) && rows.length === 1 && rows[0].txt === "segment of the new video",
    JSON.stringify(rows)
  );
  check("playlist jump: source = getpanel", w.lastStats.capSource === "getpanel", w.lastStats.capSource);
  check(
    "playlist jump: get_panel is built for the URL's video id, not the blob's",
    w.kinds("getpanel")[0]?.body?.params === panelParamsFor(NEW_ID),
    `got=${w.kinds("getpanel")[0]?.body?.params} want=${panelParamsFor(NEW_ID)}`
  );
  check(
    "playlist jump: the discarded blob id is reported for debugging",
    w.lastStats.staleBlob === OLD_ID,
    String(w.lastStats.staleBlob)
  );
  check("playlist jump: no failure reported", w.lastStats.capFail === null, String(w.lastStats.capFail));
}

{
  // get_panel needs the page's visitor data; without it the chain must fall
  // through to get_transcript - still built from the URL's video id.
  const w = build({
    pageVars: { ytInitialPlayerResponse: prFor(OLD_ID, STALE_TRACK) },
    docScript: `"SOMETHING_ELSE":"x"`,
    innertube: () => ({ status: 200, json: innertubeJson("segment of the new video") }),
  });
  const rows = await w.capFn(true);

  check(
    "playlist jump: get_transcript also uses the URL's video id",
    w.kinds("innertube")[0]?.body?.params === transcriptParamsFor(NEW_ID),
    `got=${w.kinds("innertube")[0]?.body?.params} want=${transcriptParamsFor(NEW_ID)}`
  );
  check(
    "playlist jump: innertube rows returned",
    rows?.[0]?.txt === "segment of the new video",
    JSON.stringify(rows)
  );
  check(
    "playlist jump: still no request to the stale track",
    w.kinds("timedtext").length === 0,
    JSON.stringify(w.kinds("timedtext"))
  );
}

// ---- no regression: a hard load still uses the timedtext fast path ----------
{
  const w = build({
    pageVars: { ytInitialPlayerResponse: prFor(NEW_ID, FRESH_TRACK) },
    timedtext: () => ({ status: 200, body: timedtextJson("exact caption data") }),
  });
  const rows = await w.capFn(true);

  check(
    "hard load: exact caption data still used",
    rows?.[0]?.txt === "exact caption data" && w.lastStats.capSource === "timedtext",
    `${w.lastStats.capSource} ${JSON.stringify(rows)}`
  );
  check(
    "hard load: the requested track is the current video's",
    w.kinds("timedtext")[0]?.url?.includes(NEW_ID),
    String(w.kinds("timedtext")[0]?.url)
  );
  check(
    "hard load: no fallback sources touched",
    w.kinds("getpanel").length === 0 && w.kinds("innertube").length === 0,
    `panel=${w.kinds("getpanel").length} innertube=${w.kinds("innertube").length}`
  );
  check("hard load: nothing reported as stale", w.lastStats.staleBlob === null, String(w.lastStats.staleBlob));
}

console.log(failures === 0 ? "\nALL NAVIGATION TESTS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
