import fs from "node:fs";
import zlib from "node:zlib";

const src = fs.readFileSync("content.js", "utf8");
const start = src.indexOf("  async function fetchCaptionsFallback");
const end = src.indexOf("  // =========================================================\n  // COPY HANDLERS", start);
if (start < 0 || end < 0) {
  console.error("FAIL: could not extract fetchCaptionsFallback");
  process.exit(1);
}
const fnSrc = src.slice(start, end);

const cleanSegmentText = (t) => String(t || "").replace(/\s+/g, " ").trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, 1));
const parseTimecode = (text) => {
  if (!text) return null;
  const m = String(text).match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
};
const lastStats = { fallbacks: 0, capFail: null, capRetries: 0, capSource: null };

const VIDEO_ID = "abc123def45";
const EXPECTED_PARAMS = encodeURIComponent(
  Buffer.from([0x0a, 0x0b, ...Buffer.from(VIDEO_ID, "utf8")]).toString("base64")
);
const EXPECTED_PANEL_PARAMS = Buffer.from([
  0xaa, 0x09, 0x0f, 0x0a, 0x0b, ...Buffer.from(VIDEO_ID, "utf8"), 0x18, 0x01,
]).toString("base64");
const EXPECTED_KEY = "AIzaSyAO_FJ2SlqU8Q4STEHLGCilw_Y9_11qcW8";
const FAKE_VISITOR = "CgsZm9vYmFyMTIzNDU2Nzg5MA==";

const okTimedtextJson = JSON.stringify({
  events: [
    { tStartMs: 1000, segs: [{ utf8: "hello " }, { utf8: "world" }] },
    { tStartMs: 6000, segs: [{ utf8: "second line" }] },
  ],
});
const emptyEventsTimedtext = JSON.stringify({ events: [] });

// ---- innertube get_transcript response builders ----
function cue(startOffsetMs, text, runs) {
  return {
    transcriptCueRenderer: {
      startOffsetMs,
      cue: runs ? { runs: [{ text }] } : { simpleText: text },
    },
  };
}
function innertubeJson({ nested = false, runs = false } = {}) {
  const body = {
    transcriptBodyRenderer: {
      cueGroups: [
        {
          transcriptCueGroupRenderer: {
            cues: [cue(1000, "innertube hello ", runs), cue(6000, "second cue", runs)],
          },
        },
      ],
    },
  };
  const content = nested
    ? { transcriptRenderer: { content: { transcriptSearchPanelRenderer: { body } } } }
    : { transcriptRenderer: { body } };
  return {
    actions: [{ updateEngagementPanelAction: { targetId: "engagement-panel-transcript", content } }],
  };
}
const innertubeNoBody = { actions: [] };
const innertubeError = { error: { code: 400, message: "Bad Request" } };

// ---- get_panel response builders ----
const panelSeg = (timestamp, text) => ({
  transcriptSegmentViewModel: { timestamp, simpleText: text },
});
function panelJson() {
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
                          panelSeg("0:00", "welcome to the course "),
                          panelSeg("1:02", "second segment"),
                          panelSeg("7:29:09", "final words"),
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

// timedtext responder styles
const T_OK = (i) => ({ status: 200, body: okTimedtextJson });
const T_EMPTY = () => ({ status: 200, body: "" });
const T_EMPTY_THEN_OK = (i) => ({ status: 200, body: i === 1 ? "" : okTimedtextJson });
const T_NOEVENTS = () => ({ status: 200, body: emptyEventsTimedtext });
const T_NONJSON = () => ({ status: 200, body: "<html>error</html>" });
const T_404 = () => ({ status: 404, body: "" });

// innertube responder styles
const I_ROWS = () => ({ status: 200, json: innertubeJson() });
const I_NESTED_ROWS = () => ({ status: 200, json: innertubeJson({ nested: true }) });
const I_RUNS_ROWS = () => ({ status: 200, json: innertubeJson({ runs: true }) });
const I_NOBODY = () => ({ status: 200, json: innertubeNoBody });
const I_ERROR = () => ({ status: 200, json: innertubeError });
const I_REJECTED = () => ({ status: 400, json: { error: { code: 400, message: "Precondition check failed." } } });
const I_HTML_503 = () => ({ status: 503, json: "<html>nope</html>" });
const I_NOTJSON = () => ({ status: 200, json: "<html>error</html>" });
const I_EMPTY = () => ({ status: 200, json: "" });

// get_panel responder styles
const P_ROWS = () => ({ status: 200, json: panelJson() });
const P_NOBODY = () => ({ status: 200, json: { content: {} } });
const P_NOTJSON = () => ({ status: 200, json: "<html>error</html>" });
const P_HTML_503 = () => ({ status: 503, json: "<html>nope</html>" });
const P_FAIL = () => ({ status: 400, json: { error: { code: 400, message: "Precondition check failed." } } });

function build(opts = {}) {
  const {
    track = "asr",
    timedtext = T_OK,
    innertube = I_ROWS,
    panel = P_FAIL,
    docScript = `"VISITOR_DATA":"${FAKE_VISITOR}"`,
  } = opts;
  const pr = {
    videoDetails: { videoId: VIDEO_ID },
    captions: { playerCaptionsTracklistRenderer: { captionTracks: [] } },
  };
  if (track === "asr")
    pr.captions.playerCaptionsTracklistRenderer.captionTracks = [
      { baseUrl: "https://example.com/api/timedtext?v=x&caps=asr", kind: "asr" },
    ];
  if (track === "noBaseUrl")
    pr.captions.playerCaptionsTracklistRenderer.captionTracks = [{ kind: "asr" }];
  if (track === "gated")
    pr.captions.playerCaptionsTracklistRenderer.captionTracks = [
      { baseUrl: "https://example.com/api/timedtext?v=x&caps=asr&exp=xpe", kind: "asr" },
    ];
  if (track === "gatedList")
    pr.captions.playerCaptionsTracklistRenderer.captionTracks = [
      { baseUrl: "https://example.com/api/timedtext?v=x&caps=asr&exp=foo,xpe,bar", kind: "asr" },
    ];
  const readPageVar = () => pr;
  // The extension resolves captions from the live player response first and
  // only falls back to the page variable. These tests exercise the source
  // chain, so both are fed the same fixture (the staleness guard itself is
  // covered by test_navigation.mjs).
  const livePlayerResponse = () => pr;
  const document = {
    querySelectorAll: () => [{ textContent: docScript }],
    getElementById: () => null,
    querySelector: () => null,
    cookie: "",
  };
  const log = [];
  let tCalls = 0;
  const fetch = async (u, init) => {
    const url = String(u);
    if (url.includes("get_panel")) {
      const r = panel();
      let bodyText = "";
      if (init?.body) {
        if (init.body && typeof init.body.getReader === "function") {
          // the extension gzips the get_panel body (matching the real page)
          const ab = await new Response(init.body).arrayBuffer();
          bodyText = zlib.gunzipSync(Buffer.from(ab)).toString("utf8");
        } else {
          bodyText = String(init.body);
        }
      }
      let parsed = null;
      try { parsed = JSON.parse(bodyText); } catch (e) {}
      log.push({ kind: "getpanel", url, body: parsed, headers: init?.headers || {} });
      const bodyStr = typeof r.json === "string" ? r.json : JSON.stringify(r.json);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => bodyStr,
        json: async () => (typeof r.json === "string" ? JSON.parse(bodyStr) : r.json),
      };
    }
    if (url.includes("youtubei")) {
      const r = innertube();
      log.push({
        kind: "innertube",
        url,
        body: init?.body ? JSON.parse(init.body) : null,
      });
      const bodyStr = typeof r.json === "string" ? r.json : JSON.stringify(r.json);
      return {
        ok: r.status >= 200 && r.status < 300,
        status: r.status,
        text: async () => bodyStr,
        json: async () => (typeof r.json === "string" ? JSON.parse(bodyStr) : r.json),
      };
    }
    tCalls++;
    const b = timedtext(tCalls);
    log.push({ kind: "timedtext", url, call: tCalls });
    const bodyStr = typeof b.body === "string" ? b.body : JSON.stringify(b.body);
    return {
      ok: b.status >= 200 && b.status < 300,
      status: b.status,
      text: async () => bodyStr,
      json: async () => JSON.parse(bodyStr),
    };
  };
  const buildFn = new Function(
    "readPageVar",
    "fetch",
    "cleanSegmentText",
    "sleep",
    "lastStats",
    "document",
    "parseTimecode",
    "livePlayerResponse",
    `return (${fnSrc});`
  );
  const fn = buildFn(
    readPageVar,
    fetch,
    cleanSegmentText,
    sleep,
    lastStats,
    document,
    parseTimecode,
    livePlayerResponse
  );
  return { fn, log, tCalls: () => tCalls };
}

const reset = () => {
  lastStats.fallbacks = 0;
  lastStats.capFail = null;
  lastStats.capRetries = 0;
  lastStats.capSource = null;
};

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// ---- timedtext-first behaviors ----
reset();
{
  const { fn, log, tCalls } = build({ timedtext: T_OK });
  const rows = await fn();
  check("timedtext ok returns rows", Array.isArray(rows) && rows.length === 2, JSON.stringify(rows));
  check("source = timedtext", lastStats.capSource === "timedtext", lastStats.capSource);
  check("no retry, no other sources", lastStats.capRetries === 0 && tCalls() === 1 && log.length === 1, `calls=${tCalls()} log=${log.length}`);
  check("rows sorted", rows[0].t === 1 && rows[1].t === 6);
}

reset();
{
  const { fn, log, tCalls } = build({ timedtext: T_EMPTY_THEN_OK });
  const rows = await fn();
  check("empty then ok retries once and returns rows", Array.isArray(rows) && rows.length === 2);
  check("retry counter = 1, two timedtext calls, no other sources", lastStats.capRetries === 1 && tCalls() === 2 && log.length === 2, `calls=${tCalls()}`);
  check("source = timedtext", lastStats.capSource === "timedtext");
}

// ---- get_panel rescues when timedtext is gated ----
reset();
{
  const { fn, log, tCalls } = build({ timedtext: T_EMPTY, panel: P_ROWS });
  const rows = await fn();
  check("persistent empty timedtext falls through to get_panel rows", Array.isArray(rows) && rows.length === 3 && rows[0].txt === "welcome to the course", JSON.stringify(rows));
  check("source = getpanel", lastStats.capSource === "getpanel", lastStats.capSource);
  check("retried once + getpanel called, innertube NOT called", lastStats.capRetries === 1 && tCalls() === 2 && log.filter((l) => l.kind === "getpanel").length === 1 && log.filter((l) => l.kind === "innertube").length === 0);
}

reset();
{
  const { fn, log } = build({ track: "none", panel: P_ROWS });
  const rows = await fn();
  check("no caption tracks still tries get_panel (video id only)", Array.isArray(rows) && rows.length === 3);
  check("zero timedtext calls", log.filter((l) => l.kind === "timedtext").length === 0);
  check("source = getpanel", lastStats.capSource === "getpanel");
}

reset();
{
  const { fn, log, tCalls } = build({ timedtext: T_EMPTY, panel: P_FAIL, innertube: I_ROWS });
  const rows = await fn();
  check("getpanel failure falls through to innertube rows", Array.isArray(rows) && rows.length === 2 && rows[0].txt.startsWith("innertube"));
  check("source = innertube", lastStats.capSource === "innertube");
  check("all three sources attempted", log.filter((l) => l.kind === "timedtext").length === 2 && log.filter((l) => l.kind === "getpanel").length === 1 && log.filter((l) => l.kind === "innertube").length === 1);
}

// ---- get_panel request shape ----
reset();
{
  const { fn, log } = build({ timedtext: T_EMPTY, panel: P_ROWS });
  await fn();
  const req = log.find((l) => l.kind === "getpanel");
  check("POST to get_panel with prettyPrint=false", !!req && req.url.includes("/youtubei/v1/get_panel") && req.url.includes("prettyPrint=false"), req?.url);
  check("gzip Content-Encoding header", req?.headers?.["Content-Encoding"] === "gzip", JSON.stringify(req?.headers));
  check("panelId = PAmodern_transcript_view", req?.body?.panelId === "PAmodern_transcript_view", req?.body?.panelId);
  check("params protobuf encodes video id", req?.body?.params === EXPECTED_PANEL_PARAMS, `params=${req?.body?.params} expected=${EXPECTED_PANEL_PARAMS}`);
  check("client has visitorData from page cfg", req?.body?.context?.client?.visitorData === FAKE_VISITOR);
  check("client has WEB + version + os fields", req?.body?.context?.client?.clientName === "WEB" && !!req?.body?.context?.client?.clientVersion && !!req?.body?.context?.client?.osName && !!req?.body?.context?.client?.platform && !!req?.body?.context?.client?.userAgent);
}

reset();
{
  const { fn, log } = build({ timedtext: T_EMPTY, panel: P_ROWS, innertube: I_NOBODY, docScript: `"OTHER":"x"` });
  const rows = await fn();
  check("no visitor data on page -> getpanel skipped, still null", rows === null && log.filter((l) => l.kind === "getpanel").length === 0);
  check("capFail includes getpanel reason", String(lastStats.capFail).includes("getpanel: no visitor data on the page"), lastStats.capFail);
}

reset();
{
  // CompressionStream missing -> getpanel must be skipped, chain degrades to innertube
  const orig = globalThis.CompressionStream;
  globalThis.CompressionStream = undefined;
  let rows = null, log = [];
  try {
    const b = build({ timedtext: T_EMPTY, panel: P_ROWS, innertube: I_NOBODY });
    rows = await b.fn();
    log = b.log;
  } finally {
    globalThis.CompressionStream = orig;
  }
  check("CompressionStream missing -> getpanel skipped, degrades to innertube", rows === null && log.filter((l) => l.kind === "getpanel").length === 0 && log.filter((l) => l.kind === "innertube").length === 1);
  check("capFail reports CompressionStream reason", String(lastStats.capFail).includes("getpanel: CompressionStream unavailable"), lastStats.capFail);
}

// ---- everything fails: precise combined reason ----
reset();
{
  const { fn, log, tCalls } = build({ timedtext: T_EMPTY, panel: P_FAIL, innertube: I_REJECTED });
  const rows = await fn();
  check("all fail -> null", rows === null);
  check("combined capFail has all three legs", lastStats.capFail === "timedtext: caption response was empty; getpanel: getpanel error 400 (Precondition check failed.); innertube: innertube error 400 (Precondition check failed.)", lastStats.capFail);
  check("no capSource on failure", lastStats.capSource === null);
  check("retried once before giving up", lastStats.capRetries === 1 && tCalls() === 2);
}

reset();
{
  const { fn, log, tCalls } = build({ timedtext: T_NONJSON, panel: P_FAIL, innertube: I_ERROR });
  const rows = await fn();
  check("non-JSON timedtext not retried, getpanel+innertube errors surfaced", rows === null && lastStats.capRetries === 0 && tCalls() === 1);
  check("capFail mentions all three", lastStats.capFail === "timedtext: caption response was not JSON; getpanel: getpanel error 400 (Precondition check failed.); innertube: innertube error 400", lastStats.capFail);
}

reset();
{
  const { fn, log } = build({ track: "none", panel: P_NOBODY, innertube: I_NOBODY });
  const rows = await fn();
  check("no tracks + no panel body + no innertube body -> null", rows === null);
  check("capFail = no tracks + no segments + no body", lastStats.capFail === "timedtext: no caption tracks in player response; getpanel: getpanel response had no transcript segments; innertube: innertube response had no transcript body", lastStats.capFail);
}

reset();
{
  const { fn } = build({ timedtext: T_EMPTY, panel: P_HTML_503, innertube: I_HTML_503 });
  const rows = await fn();
  check("non-JSON error bodies fall back to http status", rows === null && lastStats.capFail === "timedtext: caption response was empty; getpanel: getpanel http 503; innertube: innertube http 503", lastStats.capFail);
}

// ---- get_panel response parsing variants ----
reset();
{
  const { fn } = build({ timedtext: T_EMPTY, panel: P_NOTJSON, innertube: I_NOBODY });
  const rows = await fn();
  check("getpanel non-JSON body reported", rows === null && lastStats.capFail.includes("getpanel response was not JSON"), lastStats.capFail);
}

reset();
{
  const { fn } = build({ timedtext: T_EMPTY, panel: P_NOBODY, innertube: I_NOBODY });
  const rows = await fn();
  check("getpanel no segments reported", rows === null && lastStats.capFail.includes("getpanel response had no transcript segments"));
}

// ---- innertube parsing (getpanel fails by default) ----
reset();
{
  const { fn, log } = build({ timedtext: T_EMPTY, panel: P_FAIL, innertube: I_NESTED_ROWS });
  const rows = await fn();
  check("searchable-panel nested body path parsed", Array.isArray(rows) && rows.length === 2 && rows[0].txt === "innertube hello", JSON.stringify(rows));
}

reset();
{
  const { fn, log } = build({ timedtext: T_EMPTY, panel: P_FAIL, innertube: I_RUNS_ROWS });
  const rows = await fn();
  check("cue.runs text variant parsed", Array.isArray(rows) && rows[0].txt === "innertube hello", JSON.stringify(rows));
}

reset();
{
  const { fn, log } = build({ timedtext: T_EMPTY, panel: P_FAIL, innertube: I_ROWS });
  await fn();
  const req = log.find((l) => l.kind === "innertube");
  check("POST to get_transcript with key", !!req && req.url.includes("/youtubei/v1/get_transcript") && req.url.includes("key=" + EXPECTED_KEY), req?.url);
  check("protobuf params encode video id", req?.body?.params === EXPECTED_PARAMS, `params=${req?.body?.params} expected=${EXPECTED_PARAMS}`);
  check("WEB context + version + hl/gl", req?.body?.context?.client?.clientName === "WEB" && !!req?.body?.context?.client?.clientVersion && req?.body?.context?.client?.hl === "en" && req?.body?.context?.client?.gl === "US");
}

reset();
{
  const { fn } = build({ timedtext: T_EMPTY, panel: P_FAIL, innertube: I_NOTJSON });
  const rows = await fn();
  check("innertube non-JSON body reported", rows === null && lastStats.capFail.includes("innertube response was not JSON"), lastStats.capFail);
}

reset();
{
  const { fn } = build({ timedtext: T_NOEVENTS, panel: P_FAIL, innertube: I_EMPTY });
  const rows = await fn();
  check("no-events timedtext retried, empty innertube -> null", rows === null && lastStats.capRetries === 1 && lastStats.capFail.includes("innertube response was not JSON"), lastStats.capFail);
}

// ---- PO-token gating (exp=xpe) ----
reset();
{
  const { fn, log, tCalls } = build({ track: "gated", timedtext: T_EMPTY, panel: P_FAIL, innertube: I_NOBODY });
  const rows = await fn();
  check("gated empty 200 -> no retry (token can't be minted)", rows === null && lastStats.capRetries === 0 && tCalls() === 1, `retries=${lastStats.capRetries} calls=${tCalls()}`);
  check("capFail explains PO token requirement", typeof lastStats.capFail === "string" && lastStats.capFail.includes("PO-token-gated: exp=xpe"), lastStats.capFail);
  check("getpanel+innertube still attempted after gated timedtext", log.filter((l) => l.kind === "getpanel").length === 1 && log.filter((l) => l.kind === "innertube").length === 1);
}

reset();
{
  const { fn, log, tCalls } = build({ track: "gatedList", timedtext: T_EMPTY, panel: P_FAIL, innertube: I_ROWS });
  const rows = await fn();
  check("exp list value (foo,xpe,bar) detected as gated", rows !== null && lastStats.capRetries === 0 && tCalls() === 1, `calls=${tCalls()}`);
  check("gated failure falls through to innertube rows", Array.isArray(rows) && lastStats.capSource === "innertube");
}

reset();
{
  const { fn, tCalls } = build({ track: "gated", timedtext: T_OK });
  const rows = await fn();
  check("gated URL that serves content still returns rows", Array.isArray(rows) && rows.length === 2);
  check("source = timedtext, no retry", lastStats.capSource === "timedtext" && lastStats.capRetries === 0 && tCalls() === 1);
}

reset();
{
  const { fn, tCalls } = build({ track: "gated", timedtext: T_404, panel: P_FAIL, innertube: I_NOBODY });
  const rows = await fn();
  check("gated http 404 annotated without retry", rows === null && lastStats.capRetries === 0 && tCalls() === 1);
  check("capFail keeps http reason + PO note", lastStats.capFail.includes("caption fetch http 404") && lastStats.capFail.includes("PO-token-gated: exp=xpe"), lastStats.capFail);
}

reset();
{
  const { fn, tCalls } = build({ timedtext: T_EMPTY_THEN_OK });
  const rows = await fn();
  check("non-gated empty still retries once and succeeds", Array.isArray(rows) && lastStats.capRetries === 1 && tCalls() === 2);
  check("no PO note on non-gated failure", !String(lastStats.capFail || "").includes("PO-token-gated"));
}

console.log(failures === 0 ? "\nALL CAPTION-FETCH TESTS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);