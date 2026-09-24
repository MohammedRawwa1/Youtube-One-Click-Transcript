// Checks that a chunk-session badge never covers the chapter title it sits on.
//
// Why this needs a real browser: the badge is absolutely positioned inside its
// chapter row, so however wide its label gets it never pushes the title aside -
// it lands on top of it, and the end of a long title is exactly where it lands.
// Whether a label fits is a question of rendered text width (font, digit set,
// how many parts there are), and the only honest answer comes from laying the
// row out and measuring the boxes. A unit test can prove the reservation is
// applied; it cannot prove the boxes miss each other.
//
// What it does, driven over the Chrome DevTools Protocol (no Playwright needed -
// the plumbing mirrors tools/capture-getpanel-lang.mjs):
//   1. launches Chrome with a THROWAWAY profile (your normal profile, cookies
//      and logins are not touched) and a debugging port,
//   2. builds a fixture page that inlines the REAL content.css and models the
//      three places a badge is injected plus the player control bar,
//   3. injects the REAL setChunkLabel() / reserveBadgeRoom() / resetMainButton()
//      from content.js and drives them exactly as a chunk session does, with the
//      widest labels the extension can produce (and the idle glyph),
//   4. measures the badge against the title in each state and fails if their
//      boxes intersect, or if the badge escapes the row it belongs to.
//
//   node tools/check-badge-layout.mjs
//   node tools/check-badge-layout.mjs --keep        # leave Chrome open
//   node tools/check-badge-layout.mjs --verbose
//   CHROME_PATH=/path/to/chrome node tools/check-badge-layout.mjs
//
// What it does NOT prove: the fixture rows are a model of YouTube's (children in
// flow inside the host, which is what the reserved padding can shrink). YouTube
// could give a title a fixed width or position it absolutely, and no offline
// fixture would notice that. The measured pill widths, on the other hand, are
// real - they are the numbers the reservation is built from.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const args = process.argv.slice(2);
const arg = (name, dflt = null) => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const flag = (name) => args.includes(`--${name}`);

const PORT = Number(arg("port", "9224"));
const KEEP = flag("keep");
const VERBOSE = flag("verbose");
const log = (...a) => console.log("[layout]", ...a);

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
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ytxt-layout-"));
  const argv = [
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-background-networking",
    "--disable-sync",
    "--disable-extensions",
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1400,1000",
    "--headless=new",
    "about:blank",
  ];
  log("launching", bin);
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
      }
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
  close() {
    try {
      this.ws.close();
    } catch (e) {}
  }
}

async function evaluate(cdp, sessionId, expression) {
  const res = await cdp.send(
    "Runtime.evaluate",
    { expression, awaitPromise: true, returnByValue: true, userGesture: true },
    sessionId
  );
  if (res.exceptionDetails) {
    throw new Error("page eval failed: " + (res.exceptionDetails.exception?.description || res.exceptionDetails.text));
  }
  return res.result?.value;
}

// =========================================================
// What to read out of the extension
// =========================================================
const readSrc = () => fs.readFileSync("content.js", "utf8").replace(/\r\n/g, "\n");
const readCss = () => fs.readFileSync("content.css", "utf8");

const num = (src, name) => Number((src.match(new RegExp(`const ${name} = (\\d+)`)) || [])[1]);
const str = (src, name) => (src.match(new RegExp(`const ${name} = "([^"]+)"`)) || [])[1];

// The four things that have to agree: what the JS sets, what the CSS matches,
// which rows it matches on, and the gap between the pill and the text.
function readContract(src) {
  const contract = {
    chunkCls: str(src, "CHUNK_LABEL_CLS"),
    pillCls: str(src, "BADGE_PILL_CLS"),
    roomVar: str(src, "BADGE_ROOM_VAR"),
    roomGap: num(src, "BADGE_ROOM_GAP"),
    chapterTags: [
      ...((src.match(/const CHAPTER_ITEM_SELECTOR = \[([\s\S]*?)\]\.join/) || [])[1] || "").matchAll(/"([^"]+)"/g),
    ].map((m) => m[1]),
    playerId: str(src, "PLAYER_BTN_ID"),
  };
  const missing = Object.entries(contract)
    .filter(([, v]) => !v || (Array.isArray(v) && !v.length))
    .map(([k]) => k);
  if (missing.length) throw new Error("could not read from content.js: " + missing.join(", "));
  return contract;
}

// =========================================================
// Fixture
// =========================================================
const LONG_TITLE =
  "Building the whole thing from scratch, part three: wiring the collector to the batcher and checking every boundary case along the way, with a deliberately long chapter title so the row is filled end to end";
const LONG_TITLE_AR =
  "بناء المشروع من الصفر، الجزء الثالث: ربط المجمّع بالدُفعات والتحقق من كل حالة على الحدود أثناء العمل، مع عنوان فصل طويل عن قصد حتى يمتلئ الصف من أوله إلى آخره";

const badge = (id, extra = "") =>
  `<button type="button" class="my-yt-chapter-copy" data-orig="📋" ${id ? `id="${id}"` : ""} ${extra}>📋</button>`;

function fixtureHtml(css) {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<style>
/* A model of the watch page's own layout: the parts that decide whether a
   floating badge has somewhere to sit. */
body { margin: 0; font-family: Roboto, Arial, sans-serif; background: #0f0f0f; color: #f1f1f1; }
.columns { display: flex; flex-direction: column; gap: 24px; padding: 16px; }
.desc { width: 615px; box-sizing: border-box; padding: 8px; background: #181818; }
.row { display: flex; align-items: center; gap: 10px; }
.chapter-time { flex: none; width: 44px; color: #aaa; font-size: 12px; }
.chapter-title { flex: 1; min-width: 0; font-size: 14px; line-height: 18px; overflow-wrap: anywhere; }
.thumb { flex: none; width: 160px; height: 90px; background: #333; border-radius: 8px; }
/* The vertical chapter card: thumbnail on top, title underneath. */
ytd-macro-markers-list-item-renderer[layout="VERTICAL"] { display: block; width: 180px; }
ytd-macro-markers-list-item-renderer[layout="VERTICAL"] .thumb { display: block; width: 180px; height: 100px; }
ytd-macro-markers-list-item-renderer[layout="VERTICAL"] .chapter-title { display: block; margin-top: 6px; font-size: 12px; line-height: 16px; }
/* The player's control bar, beside the chapter title it shows. */
#player-bar { display: flex; align-items: center; gap: 8px; width: 1000px; box-sizing: border-box; padding: 0 12px; height: 40px; background: #212121; }
#player-bar .ytp-chapter-title { flex: 0 1 auto; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-size: 14px; }
/* The player badge keeps its own id/class, as the extension gives it. */
.my-yt-player-chapter-copy { width: 24px; height: 24px; border: none; border-radius: 50%; background: rgba(255,255,255,0.25); color: #fff; }
.my-yt-player-chapter-copy.my-yt-chunking { width: auto; min-width: 24px; padding: 0 7px; border-radius: 12px; font-size: 11px; white-space: nowrap; }
</style>
<style>${css}</style>
</head>
<body>
<div class="columns">

  <!-- Classic description row, badge beside the title -->
  <div class="desc">
    <ytd-video-description-chapter-thumbnail-renderer class="row" id="row-classic">
      <div class="chapter-time">12:34</div>
      <div class="chapter-title" id="title-classic">${LONG_TITLE}</div>
      ${badge("badge-classic")}
    </ytd-video-description-chapter-thumbnail-renderer>
  </div>

  <!-- Same row mirrored for RTL: the badge has to stay clear of the title there too -->
  <div class="desc" dir="rtl" lang="ar">
    <ytd-video-description-chapter-thumbnail-renderer class="row" id="row-rtl">
      <div class="chapter-time">١٢:٣٤</div>
      <div class="chapter-title" id="title-rtl">${LONG_TITLE_AR}</div>
      ${badge("badge-rtl")}
    </ytd-video-description-chapter-thumbnail-renderer>
  </div>

  <!-- Horizontal chapter-list item (modern layout), badge beside the title -->
  <div class="desc">
    <ytd-macro-markers-list-item-renderer class="row" layout="HORIZONTAL" id="row-horizontal">
      <div class="thumb"></div>
      <div class="chapter-title" id="title-horizontal">${LONG_TITLE}</div>
      ${badge("badge-horizontal")}
    </ytd-macro-markers-list-item-renderer>
  </div>

  <!-- Vertical chapter card: the badge sits over the thumbnail, title below -->
  <div class="desc">
    <ytd-macro-markers-list-item-renderer layout="VERTICAL" id="row-vertical">
      <div class="thumb"></div>
      <div class="chapter-title" id="title-vertical">${LONG_TITLE}</div>
      ${badge("badge-vertical")}
    </ytd-macro-markers-list-item-renderer>
  </div>

  <!-- The player's control bar -->
  <div id="player-bar">
    <button type="button" id="my-yt-player-chapter-btn" class="my-yt-player-chapter-copy" data-orig="📋">📋</button>
    <span class="ytp-chapter-title" id="title-player">${LONG_TITLE}</span>
  </div>

</div>
</body></html>`;
}

// =========================================================
// In-page harness: the real badge logic, the real labels
// =========================================================
function badgeLogicSource(src, contract) {
  const labelSrc = src.slice(
    src.indexOf("  function setChunkLabel("),
    src.indexOf("  // The main Transcript button's single unit of work:")
  );
  const resetSrc = src.slice(
    src.indexOf("  async function resetMainButton("),
    src.indexOf("  async function handleClick(")
  );
  const numbersSrc = src.slice(
    src.indexOf("  // =========================================================\n  // NUMERALS IN THE UI"),
    src.indexOf("\n\n  // =========================================================\n  // BIDI (RTL) GUARD FOR UI STRINGS")
  );
  const stringsSrc = src.slice(
    src.indexOf("  // =========================================================\n  // UI STRINGS"),
    src.indexOf("\n\n  // =========================================================\n  // PAGE DATA")
  );
  if (!labelSrc.includes("reserveBadgeRoom") || !resetSrc.includes("resetMainButton") || !numbersSrc || !stringsSrc) {
    throw new Error("could not extract the badge logic from content.js");
  }
  return {
    labelSrc,
    resetSrc,
    numbersSrc,
    stringsSrc,
    contract,
  };
}

const PAGE_HARNESS = String.raw`
window.__ytxtBuild = (parts) => {
  const { labelSrc, resetSrc, numbersSrc, stringsSrc, contract, lang } = parts;
  const ui = new Function(
    "document",
    "navigator",
    "localStorage",
    numbersSrc + "\n" + stringsSrc + "\n    return { t, countText, percentText };"
  )(
    { documentElement: { getAttribute: () => lang } },
    { language: lang },
    { getItem: () => null }
  );
  const helpers = new Function(
    "CHUNK_LABEL_CLS",
    "BADGE_PILL_CLS",
    "BADGE_ROOM_VAR",
    "BADGE_ROOM_GAP",
    "CHAPTER_ITEM_SELECTOR",
    "setButtonState",
    "t",
    labelSrc + "\n" + resetSrc + "\n    return { setChunkLabel, reserveBadgeRoom, resetMainButton };"
  )(
    contract.chunkCls,
    contract.pillCls,
    contract.roomVar,
    contract.roomGap,
    contract.chapterTags.join(", "),
    (b, label, disabled) => {
      b.textContent = label;
      b.disabled = !!disabled;
    },
    ui.t
  );
  window.__ytxt = { helpers, ui, contract };
  return true;
};

window.__ytxtMeasure = async (labels, { reserve }) => {
  const { helpers, contract } = window.__ytxt;
  const out = [];
  const box = (el) => {
    const r = el.getBoundingClientRect();
    return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, w: r.width, h: r.height };
  };
  const hits = (a, b) => !(a.right <= b.x + 0.5 || b.right <= a.x + 0.5 || a.bottom <= b.y + 0.5 || b.bottom <= a.y + 0.5);
  // What the row actually reserved for the pill: the padding content.css applies
  // through the class, in the row's own inline direction (so RTL is covered).
  const reservedRoom = (row) => Math.round((parseFloat(getComputedStyle(row).paddingInlineEnd) || 0) * 10) / 10;

  const cases = [
    { id: "classic row (badge beside title)", row: "#row-classic", badge: "#badge-classic", title: "#title-classic", expectRoom: true },
    { id: "classic row, RTL", row: "#row-rtl", badge: "#badge-rtl", title: "#title-rtl", expectRoom: true },
    { id: "horizontal chapter item", row: "#row-horizontal", badge: "#badge-horizontal", title: "#title-horizontal", expectRoom: true },
    { id: "vertical chapter card", row: "#row-vertical", badge: "#badge-vertical", title: "#title-vertical", expectRoom: false },
    { id: "player bar", row: "#player-bar", badge: "#my-yt-player-chapter-btn", title: "#title-player", expectRoom: false },
  ];

  for (const c of cases) {
    const row = document.querySelector(c.row);
    const btn = document.querySelector(c.badge);
    const title = document.querySelector(c.title);
    if (getComputedStyle(row).position === "static") row.style.position = "relative";

    // Idle first: the circle the badge spends most of its life as.
    await helpers.resetMainButton(btn);
    const idleTitleWidth = box(title).w;
    const idlePadding = reservedRoom(row);

    for (const label of labels) {
      helpers.setChunkLabel(btn, label, false);
      // Without the reservation, pretend the row never learned about the pill:
      // this is what the layout looked like before the room was reserved, and it
      // is what proves the measurement above is doing something.
      const applied = row.classList.contains(contract.pillCls);
      const room = row.style.getPropertyValue(contract.roomVar) || null;
      if (!reserve) {
        row.classList.remove(contract.pillCls);
        row.style.removeProperty(contract.roomVar);
      }
      const b = box(btn);
      const tl = box(title);
      const rw = box(row);
      out.push({
        case: c.id,
        label,
        reserve,
        reserved: applied,
        room,
        reservedRoom: reservedRoom(row),
        // The row's own padding before any pill existed: the page has paddings
        // of its own, so what matters is how much the reservation ADDED.
        basePad: idlePadding,
        pillWidth: Math.round(b.w * 10) / 10,
        titleWidth: Math.round(tl.w * 10) / 10,
        overlap: hits(b, tl),
        escapesRow: b.x < rw.x - 0.5 || b.right > rw.right + 0.5,
        expectRoom: c.expectRoom,
      });
    }

    // And the room goes back when the session ends.
    await helpers.resetMainButton(btn);
    const back = box(title);
    out.push({
      case: c.id,
      label: "(idle)",
      reserve,
      reserved: row.classList.contains(contract.pillCls),
      room: row.style.getPropertyValue(contract.roomVar) || null,
      reservedRoom: reservedRoom(row),
      basePad: idlePadding,
      pillWidth: Math.round(box(btn).w * 10) / 10,
      titleWidth: Math.round(back.w * 10) / 10,
      overlap: hits(box(btn), back),
      escapesRow: false,
      restored: Math.abs(back.w - idleTitleWidth) < 1 && idlePadding === reservedRoom(row),
      expectRoom: c.expectRoom,
    });
  }
  return out;
};
`;

// =========================================================
// Main
// =========================================================
async function main() {
  const src = readSrc();
  const css = readCss();
  const contract = readContract(src);
  const logic = badgeLogicSource(src, contract);
  log(
    "contract:",
    `${contract.chunkCls} / ${contract.pillCls} / ${contract.roomVar} / gap=${contract.roomGap} / rows=${contract.chapterTags.join(",")}`
  );

  const bin = findChrome();
  const { child } = launchChrome(bin);
  let cdp = null;
  let failures = 0;
  const check = (name, cond, detail) => {
    console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
    if (!cond) failures++;
  };
  try {
    const version = await waitForDevtools();
    cdp = await CDP.connect(version.webSocketDebuggerUrl);
    const { targetId } = await cdp.send("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId, flatten: true });
    await cdp.send("Page.enable", {}, sessionId);
    await cdp.send("Runtime.enable", {}, sessionId);

    const { frameTree } = await cdp.send("Page.getFrameTree", {}, sessionId);
    await cdp.send(
      "Page.setDocumentContent",
      { frameId: frameTree.frame.id, html: fixtureHtml(css) },
      sessionId
    );
    await evaluate(cdp, sessionId, PAGE_HARNESS);

    await evaluate(
      cdp,
      sessionId,
      `window.__ytxtBuild(${JSON.stringify({
        labelSrc: logic.labelSrc,
        resetSrc: logic.resetSrc,
        numbersSrc: logic.numbersSrc,
        stringsSrc: logic.stringsSrc,
        contract,
        lang: "en",
      })})`
    );

    // The labels under test, worst case first. They are compared against what
    // the extension's own formatters produce, so a change to the label format
    // cannot leave this tool measuring a string the extension never shows.
    const produced = await evaluate(
      cdp,
      sessionId,
      `(() => { const ui = window.__ytxt.ui; return \`⏭\${ui.countText(2, 5)} · \${ui.percentText(43)}\`; })()`
    );
    const labels = [
      // Beyond realistic (100 parts would be a 100M-character transcript) but
      // exactly what "as wide as this label can get" means.
      "⏭100/100 · 100%",
      "⏭12/100 · 9%",
      "⏭2/5 · 43%",
      // The bare count, the widest label that shipped before the share existed.
      "⏭2/5",
    ];
    check(
      "the labels under test are the ones the formatters produce",
      produced === "⏭2/5 · 43%",
      `formatters produced ${JSON.stringify(produced)}`
    );
    log("labels under test:", labels.map((l) => JSON.stringify(l)).join(", "));

    const reserved = await evaluate(
      cdp,
      sessionId,
      `window.__ytxtMeasure(${JSON.stringify(labels)}, { reserve: true })`
    );
    const unreserved = await evaluate(
      cdp,
      sessionId,
      `window.__ytxtMeasure(${JSON.stringify(labels)}, { reserve: false })`
    );

    // ---- report ----
    const row = (r) =>
      [
        r.case.padEnd(30),
        String(r.label).padEnd(18),
        `pill=${String(r.pillWidth).padStart(6)}px`,
        `title=${String(r.titleWidth).padStart(6)}px`,
        `pad=${String(r.reservedRoom).padStart(5)}px`,
        r.overlap ? "OVERLAP" : "clear",
      ].join("  ");

    console.log("\n=== with the reservation (what ships) ===");
    for (const r of reserved) if (VERBOSE || r.label !== "⏭2/5") console.log(row(r));
    console.log("\n=== without it (what the reservation is for) ===");
    for (const r of unreserved) if (VERBOSE || r.label !== "⏭2/5") console.log(row(r));
    console.log(
      "\n(idle = the 22px circle in the corner, which is the layout the badge has\n" +
        " always had and is deliberately not changed; only a PILL has to be clear of\n" +
        " the title, and the check above only fails on the pill states.)"
    );

    for (const r of reserved) {
      if (r.label === "(idle)") {
        check(
          `${r.case}: the room is given back when the badge goes idle`,
          !r.reserved && !r.room && r.reservedRoom === r.basePad && r.restored !== false,
          JSON.stringify({ reserved: r.reserved, room: r.room, padEnd: r.reservedRoom, basePad: r.basePad, restored: r.restored })
        );
        continue;
      }
      check(
        `${r.case}: ${r.label} does not cover the chapter title`,
        !r.overlap,
        `pill=${r.pillWidth}px, title ${r.titleWidth}px, reserved ${r.reservedRoom}px`
      );
      check(`${r.case}: ${r.label} stays inside its row`, !r.escapesRow, "the badge left the row's box");
    }

    // The reservation has to be the one the pill measured - a class no rule
    // matches, or a rule keyed on a row the extension never marks, would
    // otherwise "pass" by reserving nothing at all.
    for (const r of reserved) {
      if (r.label === "(idle)") continue;
      const added = Math.round((r.reservedRoom - r.basePad) * 10) / 10;
      if (r.expectRoom) {
        check(
          `${r.case}: the row reserved the pill's own width (${r.label})`,
          Math.abs(added - (r.pillWidth + contract.roomGap)) <= 1.5,
          `added ${added}px, pill=${r.pillWidth}px + gap ${contract.roomGap}px`
        );
      } else {
        check(
          `${r.case}: the badge's row is not squeezed (${r.label})`,
          added === 0,
          `the reservation added ${added}px where the badge does not sit beside the title`
        );
      }
    }

    // The check has to be able to fail: without the reservation the wide labels
    // must overlap, or this tool is measuring nothing.
    const wide = unreserved.filter((r) => r.expectRoom && r.label !== "(idle)" && r.label !== "⏭2/5");
    check(
      "the measurement is meaningful: unreserved, the wide labels do cover the title",
      wide.length > 0 && wide.every((r) => r.overlap),
      `${wide.filter((r) => !r.overlap).length}/${wide.length} did not overlap`
    );
  } finally {
    if (!KEEP) {
      try {
        await cdp?.send("Browser.close");
      } catch (e) {}
      try {
        child.kill();
      } catch (e) {}
    }
    cdp?.close();
  }

  console.log(failures === 0 ? "\nBADGE LAYOUT OK" : `\n${failures} BADGE LAYOUT CHECK(S) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
}

main().then(
  () => {},
  (err) => {
    console.error("[layout] FAILED:", err && err.message ? err.message : err);
    process.exit(1);
  }
);
