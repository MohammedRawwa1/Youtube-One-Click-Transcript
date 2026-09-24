// Simulation harness for loadTranscriptSegments (extracted verbatim from
// content.js) against mocked virtualized transcript lists, since real YouTube
// caption content is throttled in headless browsers.
import fs from "node:fs";

const src = fs.readFileSync("content.js", "utf8");
const start = src.indexOf("  async function loadTranscriptSegments(");
const end = src.indexOf("\n\n  function collectedMaxT", start);
if (start < 0 || end < 0) {
  console.error("FAIL: could not extract loadTranscriptSegments from content.js");
  process.exit(1);
}
const fnSrc = src.slice(start, end);

// --- verbatim helpers copied from content.js (pure functions) ---
function parseTimecode(text) {
  if (!text) return null;
  const m = String(text).match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!m) {
    const secOnly = String(text).match(/(\d{1,4})\s*s/);
    return secOnly ? parseInt(secOnly[1], 10) : null;
  }
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
}
function cleanSegmentText(text) {
  return String(text || "").replace(/\s+/g, " ").trim();
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

const sleep = (ms) => new Promise((r) => setTimeout(r, 1)); // fast-paced

const SUSPECT_GAP_SEC = 30;
let videoDuration = null; // per-scenario: video length in seconds (or null = unknown)
const getVideoDuration = () => videoDuration;

// Build the function with its free variables injected.
const lastStats = {};
const loadTranscriptSegments = new Function(
  "sleep",
  "segmentTimestamp",
  "segmentText",
  "findSegmentScroller",
  "getVideoDuration",
  "SUSPECT_GAP_SEC",
  "lastStats",
  `return (${fnSrc});`
)(sleep, segmentTimestamp, segmentText, (panel) => panel.__scroller, getVideoDuration, SUSPECT_GAP_SEC, lastStats);

// =========================================================
// Mock YouTube transcript list
// =========================================================
const SEG_H = 24; // px per row
const VIEW_H = 200; // px viewport

function fmt(t) {
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const mm = m < 10 && h > 0 ? "0" + m : "" + m;
  const ss = s < 10 ? "0" + s : "" + s;
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

// opts: { totalRows, secPerRow, batch, keepAll, skipFn }
function makePanel(opts) {
  const rows = [];
  for (let i = 0; i < opts.totalRows; i++) {
    const t = i * opts.secPerRow;
    if (opts.skipFn && opts.skipFn(t)) continue;
    rows.push({ t, txt: `word${i}` });
  }
  let loaded = 0; // how many source rows YouTube has fetched
  let domRows = [];
  let top = 0;

  const scroller = {
    clientHeight: VIEW_H,
    get scrollHeight() {
      return loaded * SEG_H;
    },
    get scrollTop() {
      return top;
    },
    set scrollTop(v) {
      top = Math.max(0, Math.min(v, Math.max(0, loaded * SEG_H - VIEW_H)));
      // YouTube loads another batch when you land near the bottom of what is loaded.
      if (top + VIEW_H >= loaded * SEG_H - 2 && loaded < rows.length) {
        loaded = Math.min(rows.length, loaded + opts.batch);
      }
      refresh();
    },
  };

  function refresh() {
    const viewFirst = Math.floor(top / SEG_H);
    const viewLast = Math.floor((top + VIEW_H) / SEG_H);
    if (opts.keepAll) {
      domRows = rows.slice(0, loaded);
      return;
    }
    // Windowed: only rows around the viewport (+ margin) exist in the DOM;
    // everything else was discarded / never rendered.
    const M = 12; // margin rows kept around the viewport
    const first = Math.max(0, viewFirst - M);
    const last = Math.min(loaded, viewLast + M);
    domRows = rows.slice(first, last);
  }

  const panel = {
    querySelectorAll(sel) {
      return domRows.map((r) => ({
        querySelector(q) {
          if (q === ".segment-timestamp") return { textContent: fmt(r.t) };
          if (q.startsWith("a[href")) return { textContent: fmt(r.t) };
          if (q === ".segment-text") return { textContent: r.txt };
          return null;
        },
      }));
    },
  };
  panel.__scroller = scroller;
  // initial render at top
  scroller.scrollTop = 0;
  return { panel, rows };
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// =========================================================
// Scenario 1: no virtualization, full copy, known duration
// =========================================================
{
  const N = 600;
  videoDuration = N * 5;
  const { panel, rows } = makePanel({ totalRows: N, secPerRow: 5, batch: 60, keepAll: true });
  const collected = await loadTranscriptSegments(panel, Infinity, 0);
  check(
    "keep-all full copy collects every row",
    collected.size === N,
    `collected ${collected.size}/${N}`
  );
  check("keep-all full copy not flagged incomplete", !collected.incomplete);
}

// =========================================================
// Scenario 2: windowed/virtualized list (rows discarded while
// scrolling deep, only viewport margin rendered)
// =========================================================
{
  const N = 600;
  videoDuration = N * 5;
  const { panel, rows } = makePanel({ totalRows: N, secPerRow: 5, batch: 60, keepAll: false });
  const collected = await loadTranscriptSegments(panel, Infinity, 0);
  check(
    "virtualized (discarding) full copy still collects every row",
    collected.size === N,
    `collected ${collected.size}/${N}`
  );
  check("virtualized full copy not flagged incomplete", !collected.incomplete);
}

// =========================================================
// Scenario 3: finite chapter range in a windowed list
// =========================================================
{
  const N = 600;
  videoDuration = N * 5;
  const { panel, rows } = makePanel({ totalRows: N, secPerRow: 5, batch: 60, keepAll: false });
  const fromSec = 300;
  const toSec = 600;
  const collected = await loadTranscriptSegments(panel, toSec, fromSec);
  const expected = rows.filter((r) => r.t >= fromSec && r.t < toSec);
  const got = [...collected.values()].filter((r) => r.t >= fromSec && r.t < toSec);
  check(
    "chapter range collects every row in range (virtualized)",
    got.length === expected.length,
    `collected ${got.length}/${expected.length} in [${fromSec},${toSec})`
  );
  check("chapter range not flagged incomplete", !collected.incomplete);
}

// =========================================================
// Scenario 4: genuine long hole in the transcript -> flagged
// =========================================================
{
  videoDuration = 200 * 5;
  const { panel } = makePanel({
    totalRows: 200,
    secPerRow: 5,
    batch: 60,
    keepAll: true,
    skipFn: (t) => t >= 300 && t < 360, // 60s real hole
  });
  const collected = await loadTranscriptSegments(panel, Infinity, 0);
  check(
    "genuine 60s hole is flagged incomplete (callers fall back to captions)",
    collected.incomplete === true,
    `incomplete=${collected.incomplete}`
  );
}

// =========================================================
// Scenario 5: unknown duration, full copy, no virtualization
// =========================================================
{
  const N = 200;
  videoDuration = null; // unknown duration
  const { panel } = makePanel({ totalRows: N, secPerRow: 5, batch: 60, keepAll: true });
  const collected = await loadTranscriptSegments(panel, Infinity, 0);
  check(
    "unknown-duration full copy collects every row",
    collected.size === N,
    `collected ${collected.size}/${N}`
  );
  check("unknown-duration copy not flagged incomplete", !collected.incomplete);
}

// =========================================================
// Scenario 6: panel opens but segments render late - the collector must
// wait for the first segment instead of racing ahead and returning empty
// (YouTube renders the panel content asynchronously after the shell opens;
// this is the race that made the panel fallback fail with "no transcript").
// =========================================================
{
  const N = 100;
  videoDuration = N * 5;
  const { panel, rows } = makePanel({ totalRows: N, secPerRow: 5, batch: 60, keepAll: true });
  // Hide the scroller behind a getter that only becomes visible after a few
  // findSegmentScroller probes, simulating a panel whose segments render late.
  const scroller = panel.__scroller;
  delete panel.__scroller;
  let probes = 0;
  Object.defineProperty(panel, "__scroller", {
    get() {
      probes++;
      return probes >= 4 ? scroller : undefined;
    },
  });
  const collected = await loadTranscriptSegments(panel, Infinity, 0);
  check(
    "late-rendering panel is waited for and fully collected",
    collected.size === N,
    `collected ${collected.size}/${N} (findSegmentScroller probes=${probes})`
  );
  check("late-rendering panel not flagged incomplete", !collected.incomplete);
}

console.log(failures === 0 ? "\nALL SCENARIOS PASSED" : `\n${failures} SCENARIO(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
