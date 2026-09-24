// Capture what YouTube's transcript panel sends when its LANGUAGE is switched.
//
// Why: the extension's get_panel source builds `params` from the video id alone
// (documented in docs/caption-sources.md), so it can only ever ask for the
// video's default transcript. The panel UI has its own language selector, so a
// language-bearing request shape very likely exists - but which protobuf field
// carries it (and whether the panel even uses get_panel again, or re-requests
// timedtext) cannot be guessed from the default request. This script captures
// both requests from a real page and diffs them.
//
// What it does, driven over the Chrome DevTools Protocol:
//   1. launches Chrome with a THROWAWAY profile (your normal profile, cookies
//      and logins are not touched) and a debugging port,
//   2. picks a video that actually has several caption languages (or uses
//      --video=<id>),
//   3. opens the transcript panel and records the get_panel request + response,
//   4. clicks through the panel's interactive controls one at a time until
//      YouTube fires another transcript request, then records that too,
//   5. gunzips and decodes both `params` payloads and prints the diff.
//
// Artifacts (raw bodies + a JSON summary) are written to tmp/getpanel-lang/.
//
//   node tools/capture-getpanel-lang.mjs                # auto-pick a video
//   node tools/capture-getpanel-lang.mjs --video=<id>   # a specific video
//   node tools/capture-getpanel-lang.mjs --query="..."  # search term to pick from
//   node tools/capture-getpanel-lang.mjs --headless     # no visible window
//   CHROME_PATH=/path/to/chrome node tools/...
//
// Playwright is NOT needed: this speaks CDP over Node's built-in WebSocket.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const OUT_DIR = path.join("tmp", "getpanel-lang");
const PORT = Number(arg("port", "9223"));
const HEADLESS = flag("headless");
const VIDEO_ID = arg("video");
const QUERY = arg("query", "freeCodeCamp full course");
// How many videos to inspect while looking for one with 2+ caption languages.
const MAX_CANDIDATES = Number(arg("candidates", "12"));

const art = (name, data) => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const p = path.join(OUT_DIR, name);
  fs.writeFileSync(p, typeof data === "string" ? data : JSON.stringify(data, null, 2));
  return p;
};
const log = (...a) => console.log("[capture]", ...a);

// =========================================================
// Chrome
// =========================================================
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const candidates = [
    "C:/Program Files/Google/Chrome/Application/chrome.exe",
    "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
    process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, "Google/Chrome/Application/chrome.exe"),
    "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
    "C:/Program Files/Microsoft/Edge/Application/msedge.exe",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const c of candidates) if (fs.existsSync(c)) return c;
  throw new Error("No Chrome/Edge found. Set CHROME_PATH to the browser binary.");
}

function launchChrome(bin) {
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ytxt-capture-"));
  const argv = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--window-size=1400,1000",
    ...(HEADLESS ? ["--headless=new"] : []),
    "about:blank",
  ];
  log("launching", bin, "with a throwaway profile at", profile);
  const child = spawn(bin, argv, { stdio: "ignore", detached: false });
  child.on("exit", (code) => log("chrome exited", code));
  return { child, profile };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForDevtools(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return await res.json();
    } catch (e) {}
    await sleep(250);
  }
  throw new Error("Chrome's DevTools endpoint never came up on port " + PORT);
}

// =========================================================
// Minimal CDP client (browser endpoint + one attached page session)
// =========================================================
class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.handlers = new Set();
    ws.addEventListener("message", (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(msg.error.message));
        else resolve(msg.result);
        return;
      }
      for (const h of this.handlers) h(msg);
    });
  }
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      ws.addEventListener("open", resolve, { once: true });
      ws.addEventListener("error", (e) => reject(new Error("websocket error: " + (e.message || "unknown"))), { once: true });
    });
    return new CDP(ws);
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    this.ws.send(JSON.stringify(payload));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  on(handler) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

// =========================================================
// Protobuf / params decoding
// =========================================================
function readVarint(buf, i) {
  let shift = 0;
  let value = 0;
  while (i < buf.length) {
    const b = buf[i++];
    value |= (b & 0x7f) << shift;
    if (!(b & 0x80)) return [value >>> 0, i];
    shift += 7;
    if (shift > 35) break;
  }
  return [value >>> 0, i];
}

const printable = (buf) =>
  buf.length > 0 && [...buf].every((b) => b === 9 || b === 10 || b === 13 || (b >= 32 && b < 127));

// Decodes a protobuf message without knowing its schema: enough to see which
// field changes between two requests.
function decodeProto(buf, depth = 0) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const start = i;
    const [tag, afterTag] = readVarint(buf, i);
    i = afterTag;
    const field = tag >>> 3;
    const wire = tag & 7;
    if (field === 0) break;
    if (wire === 0) {
      const [v, ni] = readVarint(buf, i);
      i = ni;
      out.push({ field, wire, varint: v });
    } else if (wire === 2) {
      const [len, ni] = readVarint(buf, i);
      i = ni;
      const sub = buf.subarray(i, i + len);
      i += len;
      const entry = { field, wire, len };
      if (printable(sub)) entry.str = sub.toString("utf8");
      else if (depth < 6) {
        const nested = decodeProto(sub, depth + 1);
        if (nested.length) entry.nested = nested;
        else entry.hex = Buffer.from(sub).toString("hex");
      } else entry.hex = Buffer.from(sub).toString("hex");
      out.push(entry);
    } else if (wire === 5) {
      out.push({ field, wire, u32: buf.readUInt32LE(i) });
      i += 4;
    } else if (wire === 1) {
      out.push({ field, wire, u64: buf.readBigUInt64LE(i).toString() });
      i += 8;
    } else {
      out.push({ field, wire, undecodableAt: start });
      break; // unknown wire type - stop rather than guess
    }
  }
  return out;
}

function decodeParams(base64) {
  try {
    const buf = Buffer.from(base64, "base64");
    return { bytes: buf.length, hex: buf.toString("hex"), fields: decodeProto(buf) };
  } catch (e) {
    return { error: e.message };
  }
}

// Turns a captured request body (JSON, possibly gzipped) into an object, with
// `params` additionally decoded from its base64 protobuf.
function describeBody(raw) {
  let text = raw;
  if (typeof raw === "string") {
    if (raw.startsWith("{")) text = raw;
    else if (raw.length > 2) {
      try {
        text = zlib.gunzipSync(Buffer.from(raw, "binary")).toString("utf8");
      } catch (e) {
        try {
          text = zlib.gunzipSync(Buffer.from(raw, "base64")).toString("utf8");
        } catch (e2) {
          text = raw;
        }
      }
    }
  }
  let json = null;
  try {
    json = JSON.parse(text);
  } catch (e) {}
  const out = { rawText: text, json };
  if (json && typeof json.params === "string") {
    out.paramsDecoded = decodeParams(replacePlusSlash(json.params));
  }
  return out;
}

// bodies are sometimes URL-encoded percent or have +/ swapped; normalise to
// standard base64 for Buffer.
const replacePlusSlash = (s) => {
  let v = String(s);
  try {
    v = decodeURIComponent(v);
  } catch (e) {}
  return v.replace(/-/g, "+").replace(/_/g, "/");
};

// Flattens a decoded field tree into "field path = value" lines for diffing.
function flatFields(fields, prefix = "") {
  const lines = [];
  for (const f of fields || []) {
    const p = prefix ? `${prefix}.${f.field}` : String(f.field);
    if (f.str !== undefined) lines.push(`${p} = ${JSON.stringify(f.str)}`);
    else if (f.varint !== undefined) lines.push(`${p} = ${f.varint}`);
    else if (f.u32 !== undefined) lines.push(`${p} = u32:${f.u32}`);
    else if (f.u64 !== undefined) lines.push(`${p} = u64:${f.u64}`);
    else if (f.hex !== undefined) lines.push(`${p} = 0x${f.hex}`);
    else if (f.nested) lines.push(...flatFields(f.nested, p));
  }
  return lines;
}

// =========================================================
// Page driving
// =========================================================
async function evaluate(cdp, sessionId, expression, { awaitPromise = true } = {}) {
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise, returnByValue: true, userGesture: true },
    sessionId
  );
  if (res.exceptionDetails) {
    throw new Error("page eval failed: " + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result?.value;
}

// Records the transcript requests the PAGE ITSELF makes, from inside the page's
// own JS world. This matters for the request *body*: get_panel's body is
// gzip-compressed, and reading it back over CDP can mangle the binary (the
// protocol hands it over as a string). The page compresses a plain JSON string,
// so hooking Blob (and fetch's string bodies) captures that JSON intact - which
// is all the diff below needs.
const RECORDER = `(() => {
  if (window.__ytxtRecorder) return;
  const rec = { entries: [] };
  window.__ytxtRecorder = rec;
  const transcriptish = (u) => /get_panel|timedtext|get_transcript/.test(String(u || ''));
  const note = (e) => { rec.entries.push(e); };

  const origFetch = window.fetch;
  window.fetch = function (input, init) {
    try {
      const url = typeof input === 'string' ? input : (input && input.url) || '';
      if (transcriptish(url)) {
        const entry = {
          ts: Date.now(), note: 'fetch', url,
          method: (init && init.method) || (input && input.method) || 'GET',
          bodyText: null, bodyBlobText: null,
        };
        note(entry);
        const body = init && init.body;
        if (typeof body === 'string') entry.bodyText = body;
        else if (body && typeof body.text === 'function') body.text().then((t) => { entry.bodyBlobText = t; }).catch(() => {});
      }
    } catch (e) {}
    return origFetch.apply(this, arguments);
  };

  const OrigBlob = window.Blob;
  window.Blob = function (parts, opts) {
    try {
      const text = (parts || []).map((p) => (typeof p === 'string' ? p : '')).join('');
      if (text && /"panelId"|"params"/.test(text)) {
        note({ ts: Date.now(), note: 'blob', type: (opts && opts.type) || '', bodyText: text });
      }
    } catch (e) {}
    return new OrigBlob(parts, opts);
  };
  window.Blob.prototype = OrigBlob.prototype;

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__ytxtUrl = String(url || '');
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function (body) {
    try {
      if (transcriptish(this.__ytxtUrl)) {
        note({ ts: Date.now(), note: 'xhr', url: this.__ytxtUrl, method: 'POST', bodyText: typeof body === 'string' ? body : null });
      }
    } catch (e) {}
    return origSend.apply(this, arguments);
  };
})();`;

const WATCH_TRACKS = `(() => {
  const p = document.getElementById('movie_player');
  const pr = p && p.getPlayerResponse ? p.getPlayerResponse() : null;
  const r = pr && pr.captions && pr.captions.playerCaptionsTracklistRenderer;
  if (!r || !Array.isArray(r.captionTracks)) return null;
  return {
    videoId: pr.videoDetails && pr.videoDetails.videoId,
    defaultAudioTrackIndex: r.defaultAudioTrackIndex,
    captionTrackIndices: r.audioTracks && r.audioTracks[r.defaultAudioTrackIndex || 0]
      ? r.audioTracks[r.defaultAudioTrackIndex || 0].captionTrackIndices : null,
    tracks: r.captionTracks.map(t => ({ languageCode: t.languageCode, vssId: t.vssId, kind: t.kind, name: t.name && (t.name.simpleText || t.name.runs && t.name.runs.map(x=>x.text).join('')) })),
  };
})()`;

async function gotoAndReadTracks(cdp, sessionId, videoId) {
  await cdp.send("Page.navigate", { url: `https://www.youtube.com/watch?v=${videoId}` }, sessionId);
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    try {
      const info = await evaluate(cdp, sessionId, WATCH_TRACKS);
      if (info && info.tracks && info.tracks.length) return info;
      // no captions at all yet: keep waiting a little, the player may still boot
    } catch (e) {}
  }
  return null;
}

// The page-world recorder's entries, newest last.
async function recorderEntries(cdp, sessionId) {
  try {
    const raw = await evaluate(cdp, sessionId, `JSON.stringify((window.__ytxtRecorder && window.__ytxtRecorder.entries) || [])`);
    return JSON.parse(raw || "[]");
  } catch (e) {
    return [];
  }
}

// The most recent recorded body that decodes to a JSON transcript request with
// a `params` field, at or after `sinceTs` (when given).
function lastRecordedBody(entries, sinceTs = 0) {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.ts < sinceTs) continue;
    const text = e.bodyText || e.bodyBlobText;
    if (!text) continue;
    const described = describeBody(text);
    if (described.json && described.json.params) return { entry: e, described };
  }
  return null;
}

async function openTranscriptPanel(cdp, sessionId) {
  // A consent/notice interstitial can cover a fresh profile's first page.
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const wanted = /accept all|reject all|i agree|agree to/i;
      const b = [...document.querySelectorAll('button, tp-yt-paper-button')].find((n) =>
        wanted.test(n.innerText || n.getAttribute('aria-label') || ''));
      if (b) { b.click(); return true; }
      return false;
    })()`
  );
  await evaluate(
    cdp,
    sessionId,
    `(() => {
      const btn = document.querySelector('#description ytd-video-description-transcript-section-renderer button')
        || document.querySelector('ytd-video-description-transcript-section-renderer button')
        || document.querySelector('button[aria-label*="transcript" i]')
        || document.querySelector('button[aria-label*="Transcript" i]');
      if (btn) { btn.click(); return 'clicked-transcript'; }
      const expand = document.querySelector('#description-inline-expander')
        || document.querySelector('tp-yt-paper-button#expand') || document.querySelector('#expand');
      if (expand) { expand.click(); return 'clicked-expand'; }
      return 'nothing-to-click';
    })()`
  );
  for (let i = 0; i < 40; i++) {
    await sleep(500);
    const open = await evaluate(
      cdp,
      sessionId,
      `!!document.querySelector('[target-id="engagement-panel-searchable-transcript"], ytd-transcript-search-panel-renderer')`
    );
    if (open) return true;
  }
  return false;
}

// A description of what a human could click inside the panel - the language
// selector has no selector we can hard-code, so the run reports what it sees.
const PANEL_CONTROLS = `(() => {
  const panel = document.querySelector('[target-id="engagement-panel-searchable-transcript"]')
    || document.querySelector('ytd-transcript-search-panel-renderer');
  if (!panel) return null;
  const out = [];
  const nodes = panel.querySelectorAll('button, [role="button"], tp-yt-paper-dropdown-menu, tp-yt-paper-icon-button, tp-yt-paper-item, ytd-menu-service-item-renderer, [aria-haspopup], [role="combobox"], [role="listbox"]');
  nodes.forEach((n, i) => {
    const r = n.getBoundingClientRect ? n.getBoundingClientRect() : { width: 0, height: 0 };
    if (r.width < 4 && r.height < 4) return;
    out.push({
      i: out.length,
      tag: n.tagName.toLowerCase(),
      cls: String(n.className || '').slice(0, 70),
      label: n.getAttribute('aria-label') || n.getAttribute('title') || '',
      role: n.getAttribute('role') || '',
      text: (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    });
  });
  return out;
})()`;

// =========================================================
// Main
// =========================================================
async function main() {
  const bin = findChrome();
  const { child } = launchChrome(bin);
  let cdp = null;
  try {
    const version = await waitForDevtools();
    log("devtools:", version.Browser);
    cdp = await CDP.connect(version.webSocketDebuggerUrl);

    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const attach = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    const sessionId = attach.sessionId;

    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);
    // Installed before any navigation, so it is present on the page it wraps.
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", { source: RECORDER }, sessionId);
    await cdp.send("Network.enable", { maxTotalBufferSize: 200 * 1024 * 1024, maxResourceBufferSize: 100 * 1024 * 1024 }, sessionId);
    // A plain desktop UA keeps the desktop transcript panel (the language
    // selector is not in the mobile panel).
    await cdp.send(
      "Network.setUserAgentOverride",
      { userAgent: version["User-Agent"] ? version["User-Agent"].replace(/HeadlessChrome/g, "Chrome") : undefined },
      sessionId
    );

    // ---- collect every transcript-related request ----
    const requests = []; // { seq, kind, url, method, postDataRef, responseBody, byteLen }
    cdp.on((msg) => {
      if (msg.method === "Network.requestWillBeSent") {
        const url = msg.params.request.url || "";
        if (!/get_panel|timedtext|get_transcript/.test(url)) return;
        requests.push({
          seq: requests.length,
          ts: msg.params.timestamp,
          kind: /get_panel/.test(url) ? "get_panel" : /timedtext/.test(url) ? "timedtext" : "get_transcript",
          url,
          method: msg.params.request.method,
          headers: msg.params.request.headers,
          postData: msg.params.request.postData || null,
          requestId: msg.params.requestId,
          sessionRef: msg.sessionId,
        });
      }
      if (msg.method === "Network.loadingFinished") {
        const r = requests.find((x) => x.requestId === msg.params.requestId);
        if (r) r.encodedDataLength = msg.params.encodedDataLength;
      }
    });

    // ---- pick a video ----
    let chosen = null;
    let tracks = null;
    let candidates = [];
    if (VIDEO_ID) {
      candidates = [VIDEO_ID];
    } else {
      await cdp.send("Page.navigate", { url: "https://www.youtube.com/" }, sessionId);
      await sleep(3000);
      const found = await evaluate(
        cdp,
        sessionId,
        `(async () => {
          const res = await fetch('https://www.youtube.com/results?search_query=' + encodeURIComponent(${JSON.stringify(QUERY)}), { credentials: 'include' });
          const html = await res.text();
          const ids = [];
          for (const m of html.matchAll(/"videoId":"([\\w-]{11})"/g)) {
            if (!ids.includes(m[1])) ids.push(m[1]);
            if (ids.length >= 40) break;
          }
          return ids;
        })()`
      );
      candidates = Array.isArray(found) ? found.slice(0, MAX_CANDIDATES) : [];
      log("candidate videos:", candidates.join(", ") || "(none found)");
    }

    for (const id of candidates) {
      log("inspecting", id);
      const info = await gotoAndReadTracks(cdp, sessionId, id);
      if (!info) {
        log("  no caption tracks (or the player never booted)");
        continue;
      }
      const langs = [...new Set(info.tracks.map((t) => t.languageCode).filter(Boolean))];
      log(`  ${info.tracks.length} track(s), languages: ${langs.join(", ") || "(none reported)"}`);
      if (!tracks || langs.length > [...new Set(tracks.tracks.map((t) => t.languageCode).filter(Boolean))].length) {
        tracks = info;
        chosen = id;
        // Keep looking for a video that is more likely to show the selector.
        if (langs.length >= 3) break;
      }
    }
    if (!chosen) throw new Error("No candidate video exposed caption tracks - pass --video=<id> for a video you know has captions.");

    log("using video", chosen);
    art("01-caption-tracks.json", { videoId: chosen, tracks });

    // ---- open the transcript panel and capture request #1 ----
    await gotoAndReadTracks(cdp, sessionId, chosen);
    const before = requests.length;
    const opened = await openTranscriptPanel(cdp, sessionId);
    for (let i = 0; i < 40 && requests.length === before; i++) await sleep(500);
    log(opened ? "transcript panel opened" : "WARNING: could not confirm the panel opened");

    const first = requests.filter((r) => r.kind === "get_panel")[0] || requests[before] || null;
    if (!first) {
      log("no transcript request was seen; panel controls are saved for inspection anyway");
    } else {
      log(`first ${first.kind} request captured`);
    }

    // Fetch the raw POST body of a captured request (gzip intact where the page
    // sent gzip; CDP hands it back as a binary string).
    const postDataOf = async (r) => {
      if (!r) return null;
      try {
        const res = await cdp.send("Network.getRequestPostData", { requestId: r.requestId }, r.sessionRef);
        return res.postData;
      } catch (e) {
        return r.postData;
      }
    };
    // The page's own pre-compression JSON is authoritative for the diff; the
    // CDP copy of a gzipped body is only kept as a raw artifact.
    const recEntries = await recorderEntries(cdp, sessionId);
    const recBaseline = recEntries.length;
    const capturedDefault = lastRecordedBody(recEntries);
    if (first) {
      art(`02-request-default-${first.kind}.raw`, (await postDataOf(first)) || "");
      art("02-request-default-headers.json", first.headers);
    }
    if (capturedDefault) {
      art(`02-request-default-${first ? first.kind : "panel"}.json`, capturedDefault.described);
      log("captured the default request body from the page world");
    } else if (first) {
      art(`02-request-default-${first.kind}.json`, describeBody((await postDataOf(first)) || ""));
      log("WARNING: no page-world body captured; falling back to the CDP copy (may be mangled if gzipped)");
    }
    art("02-recorder-entries.json", recEntries.map((e) => ({ ts: e.ts, note: e.note, url: e.url || null, hasBody: !!(e.bodyText || e.bodyBlobText) })));

    // ---- dump what the panel offers to click ----
    const controls = await evaluate(cdp, sessionId, PANEL_CONTROLS);
    art("03-panel-controls.json", controls || []);
    log("panel controls:", (controls || []).length, "- see", path.join(OUT_DIR, "03-panel-controls.json"));

    // ---- try to switch the language ----
    // The selector is a dropdown whose items only exist once it is opened, so
    // this opens each plausible control, then clicks the items that appear.
    const countRequests = () => requests.length;
    const tried = [];
    let switched = null;

    for (let c = 0; c < (controls || []).length && !switched; c++) {
      const ctl = controls[c];
      const isPlausible = /dropdown|listbox|combobox|menuitem|paper-item|menu-service-item|button/i.test(
        `${ctl.tag} ${ctl.role} ${ctl.cls}`
      );
      if (!isPlausible) continue;
      const beforeClick = countRequests();
      const clicked = await evaluate(
        cdp,
        sessionId,
        `(() => {
          const panel = document.querySelector('[target-id="engagement-panel-searchable-transcript"]')
            || document.querySelector('ytd-transcript-search-panel-renderer');
          if (!panel) return false;
          const nodes = [...panel.querySelectorAll('button, [role="button"], tp-yt-paper-dropdown-menu, tp-yt-paper-icon-button, tp-yt-paper-item, ytd-menu-service-item-renderer, [aria-haspopup], [role="combobox"], [role="listbox"]')]
            .filter((n) => { const r = n.getBoundingClientRect(); return r.width >= 4 || r.height >= 4; });
          const node = nodes[${c}];
          if (!node) return false;
          node.click();
          return true;
        })()`
      );
      if (!clicked) continue;
      await sleep(900);

      // The dropdown is open: click every item it revealed (one per language).
      for (const itemSel of ['tp-yt-paper-item', 'ytd-menu-service-item-renderer', '[role="option"]', '[role="menuitem"]']) {
        const itemCount = await evaluate(
          cdp,
          sessionId,
          `document.querySelectorAll('${itemSel}').length`
        );
        for (let it = 0; it < Math.min(itemCount || 0, 12); it++) {
          if (countRequests() > beforeClick) break;
          const label = await evaluate(
            cdp,
            sessionId,
            `(() => {
              const n = document.querySelectorAll('${itemSel}')[${it}];
              if (!n) return null;
              const r = n.getBoundingClientRect();
              if (r.width < 4 && r.height < 4) return null;
              const text = (n.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 40);
              n.click();
              return text;
            })()`
          );
          if (label === null) continue;
          await sleep(1200);
          tried.push({ control: ctl.tag + "/" + (ctl.text || ctl.label), item: label });
          if (countRequests() > beforeClick) {
            switched = requests.slice(beforeClick);
            log("language switch produced a new transcript request after clicking:", label);
            break;
          }
        }
        if (switched) break;
      }

      // Close whatever we opened before trying the next control.
      await evaluate(cdp, sessionId, `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
      await evaluate(cdp, sessionId, `document.body.click()`);
      await sleep(400);
    }

    art("04-controls-tried.json", tried);

    if (switched && switched.length) {
      const second = switched.find((r) => r.kind === first?.kind) || switched[0];
      const raw = await postDataOf(second);
      art(`05-request-switched-${second.kind}.raw`, raw || "");
      art("05-request-switched-url.txt", second.url);
      const recAfter = (await recorderEntries(cdp, sessionId)).slice(recBaseline);
      const capturedSwitch = lastRecordedBody(recAfter);
      const described = (capturedSwitch && capturedSwitch.described) || describeBody(raw || "");
      art(`05-request-switched-${second.kind}.json`, described);
      art("05-recorder-entries-after-switch.json", recAfter.map((e) => ({ ts: e.ts, note: e.note, url: e.url || null, hasBody: !!(e.bodyText || e.bodyBlobText) })));

      // ---- the answer this run exists for ----
      const a = capturedDefault
        ? capturedDefault.described
        : first
        ? describeBody((await postDataOf(first)) || "")
        : null;
      const b = described;
      console.log("\n================ transcript request diff ================");
      console.log("default  :", first ? first.kind + " " + first.url.slice(0, 120) : "(none captured)");
      console.log("switched :", second.kind + " " + second.url.slice(0, 120));
      if (a?.paramsDecoded && b.paramsDecoded) {
        const fa = flatFields(a.paramsDecoded.fields);
        const fb = flatFields(b.paramsDecoded.fields);
        const onlyA = fa.filter((l) => !fb.includes(l));
        const onlyB = fb.filter((l) => !fa.includes(l));
        console.log("params (default) :", fa.join(" | "));
        console.log("params (switched):", fb.join(" | "));
        console.log("only in default  :", onlyA.length ? onlyA.join(" | ") : "(none)");
        console.log("only in switched :", onlyB.length ? onlyB.join(" | ") : "(none)");
        if (!onlyA.length && !onlyB.length && a.rawText === b.rawText) {
          console.log("=> params are IDENTICAL. The language is NOT carried by get_panel's params;");
          console.log("   check 05-request-switched-*.json for a timedtext request instead.");
        } else {
          for (const line of onlyB) {
            const field = line.split(" = ")[0].split(".").pop();
            console.log(`=> candidate language field: ${line}  (a base64 protobuf field ${field})`);
          }
        }
        const ja = a.json && a.json.context && a.json.context.client;
        const jb = b.json && b.json.context && b.json.context.client;
        if (ja && jb) {
          const d = Object.keys({ ...ja, ...jb }).filter((k) => ja[k] !== jb[k]);
          console.log("context.client differs in:", d.length ? d.map((k) => `${k}: ${JSON.stringify(ja[k])} -> ${JSON.stringify(jb[k])}`).join(" | ") : "(nothing)");
        }
      } else {
        console.log("(one of the two bodies had no decodable `params` - inspect the artifacts)");
      }
      art("06-summary.json", {
        videoId: chosen,
        tracks: tracks.tracks,
        defaultRequest: first ? { kind: first.kind, url: first.url } : null,
        switchedRequest: { kind: second.kind, url: second.url },
        allRequests: requests.map((r) => ({ kind: r.kind, url: r.url })),
        tried,
      });
      console.log("\nartifacts written to", path.resolve(OUT_DIR));
    } else {
      art("05-recorder-entries.json", (await recorderEntries(cdp, sessionId)).map((e) => ({ ts: e.ts, note: e.note, url: e.url || null, hasBody: !!(e.bodyText || e.bodyBlobText) })));
      console.log("\nNo language switch produced a new transcript request.");
      console.log("Controls that were clicked:", JSON.stringify(tried, null, 1));
      console.log("All transcript requests seen:", requests.map((r) => r.kind + " " + r.url.slice(0, 100)).join("\n  ") || "(none)");
      console.log("Inspect 03-panel-controls.json - pass --query/--video for a video whose panel really has a language menu.");
      art("06-summary.json", {
        videoId: chosen,
        tracks: tracks.tracks,
        allRequests: requests.map((r) => ({ kind: r.kind, url: r.url })),
        tried,
        controls,
      });
    }
  } finally {
    cdp?.close();
    try {
      await cdp?.send("Browser.close");
    } catch (e) {}
    try {
      child.kill();
    } catch (e) {}
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error("[capture] FAILED:", err && err.message ? err.message : err);
    process.exit(1);
  }
);
