import fs from "node:fs";

// CRLF-safe: a Windows checkout (core.autocrlf) restores CRLF line endings while
// every anchor below is written against LF, so normalize before matching.
const src = fs.readFileSync("content.js", "utf8").replace(/\r\n/g, "\n");
const start = src.indexOf("  async function loadTranscriptSegments(");
const end = src.indexOf("\n\n  function collectedMaxT", start);
const fnSrc = src.slice(start, end);

function parseTimecode(text) {
  if (!text) return null;
  const m = String(text).match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
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
const sleep = (ms) => new Promise((r) => setTimeout(r, 1));
const SUSPECT_GAP_SEC = 30;

const lastStats = {};
const loadTranscriptSegments = new Function(
  "sleep", "segmentTimestamp", "segmentText", "findSegmentScroller", "getVideoDuration", "SUSPECT_GAP_SEC", "lastStats",
  `return (${fnSrc});`
)(sleep, segmentTimestamp, segmentText, (panel) => panel.__scroller, () => globalThis.videoDuration, SUSPECT_GAP_SEC, lastStats);

const SEG_H = 24, VIEW_H = 200;
function fmt(t) {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  const mm = m < 10 && h > 0 ? "0" + m : "" + m;
  const ss = s < 10 ? "0" + s : "" + s;
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

async function run(N, keepAll, duration, toSec, fromSec) {
  const rows = [];
  for (let i = 0; i < N; i++) rows.push({ t: i * 5, txt: `w${i}` });
  let loaded = 0, domRows = [], top = 0, sets = 0;
  const scroller = {
    clientHeight: VIEW_H,
    get scrollHeight() { return loaded * SEG_H; },
    get scrollTop() { return top; },
    set scrollTop(v) {
      sets++;
      top = Math.max(0, Math.min(v, Math.max(0, loaded * SEG_H - VIEW_H)));
      if (top + VIEW_H >= loaded * SEG_H - 2 && loaded < rows.length) loaded = Math.min(rows.length, loaded + 60);
      const viewFirst = Math.floor(top / SEG_H), viewLast = Math.floor((top + VIEW_H) / SEG_H);
      const M = 12;
      const first = keepAll ? 0 : Math.max(0, viewFirst - M);
      const last = keepAll ? loaded : Math.min(loaded, viewLast + M);
      domRows = rows.slice(first, last);
    },
  };
  const panel = {
    querySelectorAll() {
      return domRows.map((r) => ({
        querySelector(q) {
          if (q === ".segment-timestamp" || q.startsWith("a[href")) return { textContent: fmt(r.t) };
          if (q === ".segment-text") return { textContent: r.txt };
          return null;
        },
      }));
    },
  };
  panel.__scroller = scroller;
  scroller.scrollTop = 0;
  globalThis.videoDuration = duration;
  const collected = await loadTranscriptSegments(panel, toSec, fromSec);
  return { got: collected.size, collected, sets, incomplete: !!collected.incomplete };
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// keep-all full copy (common real-world layout): sweep must exit fast (~3 steps), not walk the list
{
  const r = await run(600, true, 3000, Infinity, 0);
  check("keep-all full: all rows", r.got === 600, `got ${r.got}`);
  check("keep-all full: sweep overhead small (<= 6 sets)", r.sets <= 14 + 6, `sets=${r.sets}`);
}

// virtualized full copy: must walk to the bottom to repair (~72 steps), all rows collected
{
  const r = await run(600, false, 3000, Infinity, 0);
  check("virtualized full: all rows", r.got === 600, `got ${r.got}`);
  check("virtualized full: walked to bottom (> 40 sets)", r.sets > 40, `sets=${r.sets}`);
}

// deep chapter in a virtualized 7h-class video: rows in range all present
{
  const N = 3000; // 3000*5s = ~4.2h
  const rows = [];
  for (let i = 0; i < N; i++) rows.push({ t: i * 5, txt: `w${i}` });
  const r = await run(N, false, N * 5, 10000, 8000); // chapter 8000-10000s
  // Count collected rows whose timestamp falls inside the requested range.
  const inRange = [...r.collected.values()].filter((x) => x.t >= 8000 && x.t < 10000).length;
  check(
    "deep chapter virtualized: all 400 in-range rows",
    inRange === 400,
    `got ${inRange}/400 in range (sets=${r.sets})`
  );
}

console.log(failures === 0 ? "\nALL PERF/ROBUSTNESS CHECKS PASSED" : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
