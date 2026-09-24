// Unit tests for the part builder (extracted verbatim from content.js): the
// ordered parts shared by the TWO independent batchers. The span arrives as an
// argument and so does the ceiling, so the builder itself is agnostic: the main
// Transcript button hands it one untitled whole-video span, a chapter badge
// hands it that one chapter, and each passes its own ceiling.
//
// Two properties are pinned beyond the wording of the labels: the number and
// size of the parts are DERIVED from the rows that were actually collected
// (never from a fixed target), and the parts are a LOSSLESS partition of them -
// nothing dropped, duplicated or reordered, so the copy can never paste a
// transcript with a hole in it.
import fs from "node:fs";

// CRLF-safe: a Windows checkout (core.autocrlf) restores CRLF line endings while
// every anchor below is written against LF, so normalize before matching.
const src = fs.readFileSync("content.js", "utf8").replace(/\r\n/g, "\n");
const start = src.indexOf("  function buildChunks(");
const end = src.indexOf("\n\n  // =========================================================\n  // FALLBACK: CAPTION SOURCES", start);
if (start < 0 || end < 0) {
  console.error("FAIL: could not extract buildChunks from content.js");
  process.exit(1);
}
const fnSrc = src.slice(start, end);

// The slice holds three declarations (the builder, the part splitter and the
// losslessness guard), so it is loaded as a small module rather than as one
// expression. Caps are passed per call now, so a small one is passed at each
// call site to exercise splitting without huge fixtures.
const loadChunkTools = () =>
  new Function(`${fnSrc}\n    return { buildChunks, splitRowsIntoParts, rowsLength, assertLosslessPartition };`)();
const { buildChunks, splitRowsIntoParts, rowsLength, assertLosslessPartition } = loadChunkTools();
const buildChunksOnly = () => loadChunkTools().buildChunks;
const CAP = 50;

// The real number formatters and label table (verbatim from content.js), so the
// "n/N" counts and the "%" share are exercised with the digits and the wording
// the page would actually show. The page's language is supplied here because
// these tests run without a DOM.
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
    `${numbersSrc}\n${stringsSrc}\n    return { countText, percentText, t };`
  )(
    { documentElement: { getAttribute: () => lang } },
    { language: lang },
    {
      getItem: (k) =>
        k === "ytxt_numerals" ? override : k === "ytxt_ui" ? ui : k === "ytxt_ui_strings" ? custom : null,
    }
  );
const buildCountText = (opts = {}) => buildUi(opts).countText;
const buildPercentText = (opts = {}) => buildUi(opts).percentText;

// Fixed-length row text so lengths are deterministic: "001yyyyy..." etc.
// (11 chars each -> +12 with the joining space, so 3 rows = 35 chars, well
// under the 50-char test cap; 4 rows = 47 chars, also under it).
function row(t, textLen = 8) {
  return { t, txt: String(t).padStart(3, "0") + "y".repeat(textLen) };
}

// Intl inserts invisible marks into RTL number formatting - an Arabic letter
// mark after a percent sign, so the sign cannot be reordered against the number
// - and a bidi control is not what an assertion should be about. Stripped for
// display comparisons only: the rendered label keeps its marks.
const visibleText = (s) => String(s).replace(/[\u061c\u200e\u200f]/g, "");

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// =========================================================
// Scenario 1: one node = one span; a span under the cap is a single piece
// =========================================================
// The builder is handed exactly one span, so it can only ever cut that span.
// Two nodes are two separate calls, each numbered from 1.
{
  const intro = { title: "Intro", start: 0, end: 30 };
  const chunks = buildChunks(intro, [row(0), row(5), row(10)], CAP);
  check("a span that fits -> exactly one chunk", chunks.length === 1, `got ${chunks.length}`);
  check("chunks are numbered from 1", chunks[0].n === 1, JSON.stringify(chunks.map((c) => c.n)));
  check("the text starts with its own title line", chunks[0].text.startsWith("Intro\n"), JSON.stringify(chunks[0].text));
  check("row counts match", chunks[0].rowCount === 3, String(chunks[0].rowCount));

  // A second node is a second call: it must not inherit the first node's rows,
  // numbering or state.
  const body = buildChunks({ title: "Body", start: 30, end: 60 }, [row(30), row(35), row(40)], CAP);
  check("another node's span is built on its own", body.length === 1 && body[0].text.startsWith("Body\n"), JSON.stringify(body[0]?.text));
  check("...and is numbered from 1, not continued", body[0].n === 1, String(body[0].n));

  // Rows outside the span belong to another node, so they are not this one's.
  const mixed = buildChunks(intro, [row(0), row(5), row(40)], CAP);
  check("rows outside the span are ignored", mixed.length === 1 && mixed[0].rowCount === 2, JSON.stringify(mixed[0]?.rowCount));
}

// =========================================================
// Scenario 2: a span over the cap is split into parts
// =========================================================
{
  const span = { title: "Huge", start: 0, end: 600 };
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(i * 5));
  const fullBody = rows.map((r) => r.txt).join(" ");
  const chunks = buildChunks(span, rows, CAP);
  check("a span over the cap is split into multiple parts", chunks.length > 1, `got ${chunks.length}`);
  check("every part body <= cap", chunks.every((c) => c.text.length - c.title.length - 1 <= 50), chunks.map((c) => c.text.length).join(","));
  check("parts titled (part i/N)", chunks.every((c) => /\(part \d+\/\d+\)/.test(c.title)), chunks.map((c) => c.title).join(" | "));
  check("concatenated parts equal the full chapter body", chunks.map((c) => c.text.replace(/^.*\n/, "")).join(" ") === fullBody);
  check("row counts sum to the chapter's rows", chunks.reduce((s, c) => s + c.rowCount, 0) === rows.length, `sum=${chunks.reduce((s, c) => s + c.rowCount, 0)}`);
  // Each part's body must be composed of whole segment texts - never a
  // fragment cut mid-segment.
  const rowSet = new Set(rows.map((r) => r.txt));
  const allWhole = chunks.every((c) =>
    c.text.replace(/^.*\n/, "").split(" ").every((tok) => rowSet.has(tok))
  );
  check("no segment is cut in half", allWhole);
}

// =========================================================
// Scenario 3: a span with no rows of its own yields nothing
// =========================================================
{
  const span = { title: "Empty", start: 100, end: 200 };
  const chunks = buildChunks(span, [row(0), row(20)], CAP);
  check("a span with no rows yields no chunks", chunks.length === 0, `got ${chunks.length}`);
}

// =========================================================
// Scenario 4: a single row longer than the cap still lands in its own chunk
// =========================================================
{
  const span = { title: "LongRow", start: 0, end: 10 };
  const longRow = { t: 0, txt: "z".repeat(200) };
  const chunks = buildChunks(span, [longRow], CAP);
  check("single oversized row -> one chunk containing it whole", chunks.length === 1 && chunks[0].text === "LongRow\n" + "z".repeat(200), chunks[0]?.text?.length);
  check("rowCount is 1", chunks[0].rowCount === 1);
}

// =========================================================
// Scenario 5: the cap is per call - the two batchers can use different numbers
// =========================================================
// The main button passes MAIN_CHUNK_MAX_CHARS and a chapter badge passes
// CHAPTER_CHUNK_MAX_CHARS, so the same rows may be one part for one node and
// several for the other. That is exactly the decoupling this file pins.
{
  const span = { title: "Solo", start: 0, end: 600 };
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(i * 5));
  const tight = buildChunks(span, rows, CAP);
  const loose = buildChunks(span, rows, 5000);
  check("a small cap splits the same rows into parts", tight.length > 1, `got ${tight.length}`);
  check("a cap that fits leaves exactly one part", loose.length === 1, `got ${loose.length}`);
  check("every part stays within the cap it was given", tight.every((c) => c.text.length - c.title.length - 1 <= CAP), tight.map((c) => c.text.length).join(","));
  check("numbering is sequential", tight.every((c, i) => c.n === i + 1));
  check(
    "both builds reassemble the identical body",
    tight.map((c) => c.text.replace(/^.*\n/, "")).join(" ") === loose[0].text.replace(/^.*\n/, ""),
    "the two caps produced different text"
  );
}

// =========================================================
// Scenario 7: the chapter path (a single chapter through the same builder)
// =========================================================
// copyChapterRows() hands buildChunks that one chapter as the span, so a
// chapter that fits stays a single write and only an oversized one becomes
// parts. The single-chunk text must stay byte-identical to the old behaviour
// (title line, then the body) so normal chapters are unaffected.
{
  const chapter = { title: "Solo", start: 0, end: 600 };
  const body = (rows) => rows.map((r) => r.txt).join(" ");

  const fitting = [row(0), row(5), row(10)];
  const one = buildChunks(chapter, fitting, CAP);
  check("chapter that fits -> exactly one chunk", one.length === 1, `got ${one.length}`);
  check(
    "fitting chapter copies title line + body, as before",
    one[0].text === "Solo\n" + body(fitting),
    JSON.stringify(one[0].text)
  );
  check("fitting chapter keeps its row count", one[0].rowCount === fitting.length, String(one[0].rowCount));

  const oversized = [];
  for (let i = 0; i < 8; i++) oversized.push(row(i * 5));
  const many = buildChunks(chapter, oversized, CAP);
  check("oversized chapter -> multiple parts", many.length > 1, `got ${many.length}`);
  check("every part body <= cap", many.every((c) => c.text.length - c.title.length - 1 <= 50), many.map((c) => c.text.length).join(","));
  check("parts are titled (part i/N)", many.every((c) => /^Solo \(part \d+\/\d+\)$/.test(c.title)), many.map((c) => c.title).join(" | "));
  check(
    "no caption is cut in half across parts",
    many.every((c) => c.text.replace(/^.*\n/, "").split(" ").every((tok) => oversized.some((r) => r.txt === tok))),
    "a part contained a fragment that is not a whole segment"
  );
  check(
    "concatenated parts equal the chapter's whole body",
    many.map((c) => c.text.replace(/^.*\n/, "")).join(" ") === body(oversized),
    "parts did not reassemble into the original body"
  );
  check(
    "every row lands in exactly one part",
    many.reduce((s, c) => s + c.rowCount, 0) === oversized.length,
    `sum=${many.reduce((s, c) => s + c.rowCount, 0)} of ${oversized.length}`
  );
}

// =========================================================
// Scenario 7b: the main button's whole-video span
// =========================================================
// The main Transcript button's only unit is the transcript itself, handed over
// as this one untitled span - whatever the video's chapters are. It must not be
// labelled "Chapter 1" / "Intro", and an unsplit copy must still be just the
// body, byte-identical to what a chapterless video produced before.
{
  const span = { title: "", start: 0, end: Infinity };
  const body = (rows) => rows.map((r) => r.txt).join(" ");

  const small = [row(0), row(5), row(10)];
  const one = buildChunks(span, small, CAP);
  check("untitled span that fits -> one chunk", one.length === 1, `got ${one.length}`);
  check("untitled span adds no header line", one[0].text === body(small), JSON.stringify(one[0].text));

  const big = [];
  for (let i = 0; i < 8; i++) big.push(row(i * 5));
  const many = buildChunks(span, big, CAP);
  check("untitled span over the cap -> multiple parts", many.length > 1, `got ${many.length}`);
  check(
    "untitled parts are numbered by position, not called chapters",
    many.every((c, i) => c.title === `Part ${i + 1}/${many.length}`),
    many.map((c) => c.title).join(" | ")
  );
  check(
    "untitled parts reassemble into the whole body",
    many.map((c) => c.text.replace(/^.*\n/, "")).join(" ") === body(big),
    "parts did not reassemble"
  );
}

// =========================================================
// Scenario 8: a rejected single write degrades into parts
// =========================================================
// copyRowsWithSplitFallback() is the recovery for the fragile half of a write:
// the async clipboard path is not size-sensitive, but the execCommand fallback
// taken when writeText is unavailable lays the text out in a hidden textarea
// first and has been reported to struggle from ~180k characters. A write that is
// rejected must therefore become the same ordered sequence a too-large copy uses,
// instead of surfacing an error.
{
  const fallbackSrc = src.slice(
    src.indexOf("  // The main Transcript button's single unit of work:"),
    src.indexOf("  async function copyChapterRows(")
  );
  check("the fallback helpers were extracted", fallbackSrc.length > 200, `len=${fallbackSrc.length}`);
  const buildChunksTiny = buildChunksOnly();
  const buildHelpers = new Function(
    "buildChunks",
    "copyTextToClipboard",
    "copyNextChunk",
    "console",
    `${fallbackSrc}\n    return { wholeVideoSpan, copyRowsWithSplitFallback };`
  );

  const setup = ({ writeFails = false, partFails = false } = {}) => {
    const calls = { writes: [], parts: 0 };
    const helpers = buildHelpers(
      buildChunksTiny,
      async (text) => {
        calls.writes.push(text);
        if (writeFails) throw new Error("Clipboard write failed.");
      },
      async () => {
        calls.parts++;
        if (partFails) throw new Error("part write failed");
      },
      { warn: () => {} }
    );
    return { helpers, calls };
  };

  const span = { title: "T", start: 0, end: 999 };

  const smallRows = [row(0), row(5), row(10)];
  const bigRows = [];
  for (let i = 0; i < 8; i++) bigRows.push(row(i * 5));

  {
    const { helpers, calls } = setup();
    const outcome = await helpers.copyRowsWithSplitFallback(smallRows, span, "T\nbody", null, CAP);
    check("a write that succeeds is left alone", outcome === "whole", String(outcome));
    check("a write that succeeds writes exactly once", calls.writes.length === 1 && calls.parts === 0, JSON.stringify(calls));
  }

  {
    const { helpers, calls } = setup({ writeFails: true });
    const outcome = await helpers.copyRowsWithSplitFallback(bigRows, span, "T\nbig", {}, CAP);
    check("a rejected write falls back to parts", outcome === "parts", String(outcome));
    check("the fallback hands over to the first part", calls.parts === 1, JSON.stringify(calls));
    check("the oversized text is not written as one piece", calls.writes.length === 1, JSON.stringify(calls.writes.length));
  }

  {
    const { helpers, calls } = setup({ writeFails: true });
    let threw = null;
    try {
      await helpers.copyRowsWithSplitFallback(smallRows, span, "T\nsmall", {}, CAP);
    } catch (e) {
      threw = e;
    }
    check("nothing to split -> the original error is reported, not swallowed", /Clipboard write failed/.test(String(threw && threw.message)), String(threw && threw.message));
    check("nothing to split -> no part is attempted", calls.parts === 0, JSON.stringify(calls));
  }

  {
    const { helpers } = setup({ writeFails: true, partFails: true });
    let threw = null;
    try {
      await helpers.copyRowsWithSplitFallback(bigRows, span, "T\nbig", {}, CAP);
    } catch (e) {
      threw = e;
    }
    check("a failing part write still surfaces an error", /part write failed/.test(String(threw && threw.message)), String(threw && threw.message));
  }

  // The main button's unit of work is the whole video and nothing else: no
  // title (so its parts are "Part i/N", never a chapter title), and a fresh
  // object per call so one node can never hand another node its span.
  {
    const { helpers } = setup();
    const whole = helpers.wholeVideoSpan();
    check("the whole-video span covers the video and carries no title", whole.title === "" && whole.start === 0 && whole.end === Infinity, JSON.stringify(whole));
    check("...and is not shared between callers", whole !== helpers.wholeVideoSpan(), "the same span object was reused");
  }
}

// =========================================================
// Scenario 6: each batcher has its own pair, and each pair stays coherent
// =========================================================
// The threshold is the size at which a copy is considered worth splitting and
// the cap is what one clipboard write may contain, so a pair is coherent when
// the threshold sits at or below the cap - a threshold above the cap would make
// the extension split a copy into pieces it still considers un-writeable. The
// pairs are checked separately, because they are what makes the two operations
// independent: retuning one must never silently move the other.
{
  const num = (name) => Number((src.match(new RegExp(`const ${name} = (\\d+)`)) || [])[1]);
  const mainCap = num("MAIN_CHUNK_MAX_CHARS");
  const mainThreshold = num("MAIN_CHUNK_THRESHOLD");
  const chapterCap = num("CHAPTER_CHUNK_MAX_CHARS");
  const chapterThreshold = num("CHAPTER_CHUNK_THRESHOLD");
  check(
    "both batchers' constants are readable numbers",
    mainCap > 0 && mainThreshold > 0 && chapterCap > 0 && chapterThreshold > 0,
    `main=${mainThreshold}/${mainCap} chapter=${chapterThreshold}/${chapterCap}`
  );
  check(
    "the main pair starts splitting at or below its own cap",
    mainThreshold <= mainCap,
    `threshold=${mainThreshold} cap=${mainCap}`
  );
  check(
    "the chapter pair starts splitting at or below its own cap",
    chapterThreshold <= chapterCap,
    `threshold=${chapterThreshold} cap=${chapterCap}`
  );
}

// =========================================================
// Scenario 10: the main button's batch never consults chapters
// =========================================================
// This is the whole point of the split: a chaptered 19-hour video has to batch
// by size like any other, instead of being cut into one piece per chapter and
// labelled with chapter titles. The output of a regression here looks
// plausible, so it is pinned in source.
{
  const mainSrc = src.slice(
    src.indexOf("  async function handleClick("),
    src.indexOf("  // =========================================================\n  // CHAPTER BUTTON INJECTION")
  );
  check("the main copy handler was extracted", mainSrc.includes("wholeVideoSpan"), `len=${mainSrc.length}`);
  check(
    "the main button does not read the chapter list to batch",
    !/getChapters|chunkSpans/.test(mainSrc),
    (mainSrc.match(/getChapters|chunkSpans/g) || []).join(",")
  );
  check(
    "the main button batches on its own span and its own cap",
    /copyRowsWithSplitFallback\(\s*rows,\s*span,\s*fullText,\s*btn,\s*MAIN_CHUNK_MAX_CHARS\s*\)/.test(mainSrc) &&
      /buildChunks\(span, rows, MAIN_CHUNK_MAX_CHARS\)/.test(mainSrc),
    "the main path did not use MAIN_CHUNK_* with the whole-video span"
  );
}

// =========================================================
// Scenario 9: a chapter copy reports progress like the main button
// =========================================================
// Both chapter badges (the 22px one on each chapter row and the 24px one in the
// player) and the main Transcript button drive the same chunk session, so an
// oversized chapter has to show the same "n/N" progress and a chapter that fits
// one write has to show a plain checkmark. The counts also have to widen the
// badge (the "my-yt-chunking" class content.css turns into a pill), because a
// 22px circle cannot hold "3/10".
//
// On top of the count, the session reports how much of the WHOLE transcript is
// already on the clipboard: the main button has room to put that share in its
// label, a 22px badge does not (it would cover the chapter title), so there it
// lives in the tooltip - and in both cases in the debug report.
{
  const btnSrc = src.slice(
    src.indexOf("  async function resetMainButton("),
    src.indexOf("  async function handleClick(")
  );
  check(
    "the chunk button helpers were extracted",
    btnSrc.includes("async function copyNextChunk") && btnSrc.includes("async function resetMainButton"),
    `len=${btnSrc.length}`
  );

  const buildButtons = new Function(
    "chunkSession",
    "CHUNK_LABEL_CLS",
    "setButtonState",
    "setChunkLabel",
    "resetStats",
    "lastStats",
    "logStats",
    "copyTextToClipboard",
    "console",
    "setTimeout",
    "isolateRtl",
    "countText",
    "percentText",
    "t",
    `${btnSrc}\n    return { copyNextChunk, resetMainButton, session: () => chunkSession };`
  );

  // Deliberately UNEVEN part bodies: the share shown has to come from the text
  // that was actually copied, not from the part index (which would make it
  // 33% / 67% / 100%). With these sizes it is 11% / 41% / 100%.
  const chunk = (n, title, bodyLen) => ({
    n,
    title,
    body: "b".repeat(bodyLen),
    text: `${title}\n${"b".repeat(bodyLen)}`,
    rowCount: 1,
  });
  const chunkList = [chunk(1, "One", 10), chunk(2, "Two", 30), chunk(3, "Three", 60)];

  // A stand-in for a real button: textContent/disabled/classList plus the two
  // data attributes copyNextChunk and resetMainButton read.
  const makeButton = ({ orig = null, tip = "" } = {}) => {
    const btn = {
      textContent: orig || "📜 Transcript",
      disabled: false,
      title: tip,
      classes: new Set(),
    };
    btn.classList = {
      add: (c) => btn.classes.add(c),
      remove: (c) => btn.classes.delete(c),
    };
    btn.getAttribute = (name) => (name === "data-orig" ? orig : name === "data-tip" ? tip : null);
    return btn;
  };

  const wire = (session, btn, countText = buildCountText(), percentText = buildPercentText(), t = buildUi().t) => {
    const seen = { writes: [], labelsWhileWriting: [], timers: [] };
    // A stand-in for lastStats: copyNextChunk records the part's share there.
    const stats = {};
    const helpers = buildButtons(
      session,
      "my-yt-chunking",
      (b, label, disabled) => {
        b.textContent = label;
        b.disabled = !!disabled;
      },
      (b, label, disabled) => {
        b.classes.add("my-yt-chunking");
        b.textContent = label;
        b.disabled = !!disabled;
      },
      () => {},
      stats,
      () => {},
      async (text) => {
        seen.writes.push(text);
        // Read the label mid-write: it is the "copying part n" state.
        seen.labelsWhileWriting.push(btn.textContent);
      },
      { warn: () => {}, error: () => {} },
      (fn) => {
        seen.timers.push(fn);
        return seen.timers.length;
      },
      // Verbatim idea from content.js: an RTL value is wrapped in an FSI/PDI
      // isolate so the bidi algorithm cannot reorder the English sentence it is
      // embedded in; an LTR value is returned unchanged.
      (v) => {
        const s = String(v == null ? "" : v);
        return /[\u0590-\u05ff\u0600-\u06ff]/.test(s) ? "\u2068" + s + "\u2069" : s;
      },
      countText,
      percentText,
      t
    );
    return { helpers, seen, stats };
  };

  // The chapter badge (compact: it has a data-orig glyph instead of a label).
  {
    const btn = makeButton({ orig: "📋", tip: "Copy transcript of chapter: Intro" });
    const session = { chunks: chunkList, idx: 0, owner: btn };
    const { helpers, seen, stats } = wire(session, btn);

    await helpers.copyNextChunk(btn);
    check(
      "an oversized chapter shows its part count while copying",
      seen.labelsWhileWriting[0] === "⏳1/3",
      String(seen.labelsWhileWriting[0])
    );
    check("the count widens the badge into a pill", btn.classes.has("my-yt-chunking"), [...btn.classes].join(","));
    check(
      "the next part is offered once the current one is copied, with the share",
      btn.textContent === "⏭2/3 · 11%",
      btn.textContent
    );
    check(
      "...and the tooltip says the same share in words",
      btn.title.endsWith("11% of the transcript copied so far."),
      btn.title
    );
    check("the report records the share copied", stats.progress === 11, String(stats.progress));

    await helpers.copyNextChunk(btn);
    check(
      "the count and the share both advance part by part",
      seen.labelsWhileWriting[1] === "⏳2/3" && btn.textContent === "⏭3/3 · 41%",
      `${seen.labelsWhileWriting[1]} / ${btn.textContent}`
    );
    check(
      "the share grows with the text actually copied, not with the part index",
      stats.progress === 41 && btn.title.endsWith("41% of the transcript copied so far."),
      `progress=${stats.progress} / ${btn.title}`
    );

    await helpers.copyNextChunk(btn);
    check("the last part ends on a checkmark", btn.textContent === "✓", btn.textContent);
    check("finishing the session reports the whole transcript copied", stats.progress === 100, String(stats.progress));
    check("every part was written exactly once", seen.writes.length === 3, String(seen.writes.length));
    check("finishing schedules the badge's return to idle", seen.timers.length === 1, String(seen.timers.length));

    seen.timers.forEach((fn) => fn());
    check("the badge returns to its clipboard glyph", btn.textContent === "📋" && btn.disabled === false, btn.textContent);
    check("the badge becomes a circle again", !btn.classes.has("my-yt-chunking"), [...btn.classes].join(","));
    check("the chapter tooltip is restored, not left on the chunk instruction", btn.title === "Copy transcript of chapter: Intro", btn.title);
  }

  // The main button keeps its wordier labels (it has room for them).
  {
    const btn = makeButton();
    const session = { chunks: chunkList, idx: 0, owner: btn };
    const { helpers, seen, stats } = wire(session, btn);
    await helpers.copyNextChunk(btn);
    check(
      "the main button keeps its wordier count",
      seen.labelsWhileWriting[0] === "⏳ 1/3" && btn.textContent === "⏭ Copy 2/3 · 11%",
      `${seen.labelsWhileWriting[0]} / ${btn.textContent}`
    );
    check(
      "the button says how much of the whole transcript is copied",
      btn.textContent.endsWith("· 11%") && stats.progress === 11,
      `${btn.textContent} / progress=${stats.progress}`
    );
    check(
      "the tooltip repeats the share in words",
      btn.title.endsWith("11% of the transcript copied so far."),
      btn.title
    );
    check(
      "a Latin chunk title is embedded without bidi controls",
      btn.title.includes("(Two)") && !btn.title.includes("\u2068"),
      btn.title
    );
  }

  // RTL guard: the chunk instruction embeds the chunk's own title, which may be
  // Arabic - it has to be isolated, or the bidi algorithm reorders the English
  // sentence (and its parentheses) around it.
  {
    const rtlChunks = [
      { n: 1, title: "المقدمة", body: "body", text: "المقدمة\nbody", rowCount: 1 },
      { n: 2, title: "الدرس الأول", body: "body", text: "الدرس الأول\nbody", rowCount: 1 },
    ];
    const btn = makeButton({ orig: "📋", tip: "Copy transcript of chapter: \u2068المقدمة\u2069" });
    const session = { chunks: rtlChunks, idx: 0, owner: btn };
    const { helpers } = wire(session, btn);
    await helpers.copyNextChunk(btn);
    check(
      "an RTL chunk title is isolated inside the chunk instruction",
      btn.title.includes("\u2068المقدمة\u2069") && btn.title.includes("\u2068الدرس الأول\u2069"),
      btn.title
    );
    check(
      "...and the instruction's own words are still intact",
      btn.title.startsWith("Paste chunk 1 (") && btn.title.includes("). 50% of the transcript"),
      btn.title
    );
  }

  // The counters follow the page's numerals: a page whose language is Arabic
  // shows "⏳١/٣" and "⏭٢/٣" rather than ASCII digits.
  {
    const arabicCounts = buildCountText({ lang: "ar" });
    const arabicPercents = buildPercentText({ lang: "ar" });
    const btn = makeButton({ orig: "📋", tip: "t" });
    const session = { chunks: chunkList, idx: 0, owner: btn };
    const { helpers, seen } = wire(session, btn, arabicCounts, arabicPercents);
    await helpers.copyNextChunk(btn);
    check("an Arabic page shows Arabic-Indic counter digits", seen.labelsWhileWriting[0] === "⏳١/٣", String(seen.labelsWhileWriting[0]));
    check(
      "...and offers the next part, and the share, in the same digits",
      visibleText(btn.textContent) === "⏭٢/٣ · ١١٪",
      btn.textContent
    );
    check("...with the slash still between the two numbers", seen.labelsWhileWriting[0].includes("١/٣"), String(seen.labelsWhileWriting[0]));

    const mainBtn = makeButton();
    const mainSession = { chunks: chunkList, idx: 0, owner: mainBtn };
    const mainHelpers = wire(mainSession, mainBtn, arabicCounts, arabicPercents).helpers;
    await mainHelpers.copyNextChunk(mainBtn);
    check(
      "the main button's wordier count is localized too",
      visibleText(mainBtn.textContent) === "⏭ Copy ٢/٣ · ١١٪",
      mainBtn.textContent
    );
  }

  // ...and a Latin page is byte-identical to what shipped before.
  {
    const btn = makeButton({ orig: "📋", tip: "t" });
    const session = { chunks: chunkList, idx: 0, owner: btn };
    const { helpers, seen } = wire(session, btn, buildCountText({ lang: "en-GB" }));
    await helpers.copyNextChunk(btn);
    check("an English page keeps ASCII counter digits", seen.labelsWhileWriting[0] === "⏳1/3" && btn.textContent === "⏭2/3 · 11%", `${seen.labelsWhileWriting[0]} / ${btn.textContent}`);
  }

  // The chapter copy path that owns the session (copyChapterRows).
  {
    const rowsSrc = src.slice(
      src.indexOf("  async function copyChapterRows("),
      src.indexOf("  async function copyChapterRange(")
    );
    check("the chapter copy helper was extracted", rowsSrc.includes("copyRowsWithSplitFallback"), `len=${rowsSrc.length}`);

    // The chapter node's deps include its OWN pair of constants - the harness
    // injects small ones so the split is exercised without huge fixtures, and
    // copyChapterRows must reach for these and not the main button's.
    const buildChapterCopy = new Function(
      "chunkSession",
      "wholeVideoSpan",
      "buildChunks",
      "CHAPTER_CHUNK_THRESHOLD",
      "CHAPTER_CHUNK_MAX_CHARS",
      "rowsLength",
      "copyNextChunk",
      "copyRowsWithSplitFallback",
      "setButtonState",
      "setChunkLabel",
      "resetMainButton",
      "lastStats",
      "logStats",
      "setTimeout",
      "t",
      `${rowsSrc}\n    return { copyChapterRows, session: () => chunkSession };`
    );

    check(
      "the chapter node splits on the CHAPTER_* pair, not the main button's",
      !/MAIN_CHUNK/.test(rowsSrc),
      (rowsSrc.match(/MAIN_CHUNK\w+/g) || []).join(",")
    );

    const buildChunksTiny = buildChunksOnly();
    const chapter = { title: "Huge", start: 0, end: 600 };
    const bigRows = [];
    for (let i = 0; i < 8; i++) bigRows.push(row(i * 5));
    const smallRows = [row(0), row(5)];

    const makeChapterBadge = () => {
      const btn = { textContent: "📋", disabled: false, title: "", classes: new Set() };
      btn.classList = {
        add: (c) => btn.classes.add(c),
        remove: (c) => btn.classes.delete(c),
      };
      btn.getAttribute = (name) => (name === "data-orig" ? "📋" : null);
      return btn;
    };
    const realSetButtonState = (b, label, disabled) => {
      b.textContent = label;
      b.disabled = !!disabled;
    };
    const realSetChunkLabel = (b, label, disabled) => {
      b.classes.add("my-yt-chunking");
      realSetButtonState(b, label, disabled);
    };
    const realReset = (b) => {
      b.classes.delete("my-yt-chunking");
      b.textContent = b.getAttribute("data-orig") || "📜 Transcript";
      b.disabled = false;
    };

    // An oversized chapter whose first part cannot be written must not leave a
    // live session behind: the badge goes back to idle, so a later click has to
    // start over instead of silently resuming a copy the user thinks failed.
    {
      let threw = null;
      const helpers = buildChapterCopy(
        null,
        () => ({ title: "", start: 0, end: Infinity }),
        buildChunksTiny,
        50,
        50,
        rowsLength,
        async () => {
          throw new Error("Clipboard write failed.");
        },
        async () => "whole",
        realSetButtonState,
        realSetChunkLabel,
        realReset,
        {},
        () => {},
        () => {},
        buildUi().t
      );
      try {
        await helpers.copyChapterRows(bigRows, chapter, makeChapterBadge());
      } catch (e) {
        threw = e;
      }
      check("a failed first part is reported", /Clipboard write failed/.test(String(threw && threw.message)), String(threw && threw.message));
      check("a failed first part leaves no live chunk session behind", helpers.session() === null, JSON.stringify(helpers.session()));
    }

    // A chapter that fits one write copies at once and shows only a checkmark.
    {
      const btn = makeChapterBadge();
      const timers = [];
      const writes = [];
      const helpers = buildChapterCopy(
        null,
        () => ({ title: "", start: 0, end: Infinity }),
        buildChunksTiny,
        50,
        50,
        rowsLength,
        async () => {},
        async (rows, splitBy, text) => {
          writes.push(text);
          return "whole";
        },
        realSetButtonState,
        realSetChunkLabel,
        realReset,
        {},
        () => {},
        (fn) => {
          timers.push(fn);
          return timers.length;
        },
        buildUi().t
      );
      const handled = await helpers.copyChapterRows(smallRows, chapter, btn);
      check("a chapter that fits one write is handled", handled === true, String(handled));
      check("it is written in one go", writes.length === 1, String(writes.length));
      check("a chapter that fits shows only a checkmark", btn.textContent === "✓", btn.textContent);
      check("a chapter that fits leaves no count behind", !btn.classes.has("my-yt-chunking"), [...btn.classes].join(","));
      check("a starting chunk session is not left live", helpers.session() === null, JSON.stringify(helpers.session()));
      timers.forEach((fn) => fn());
      check("the checkmark gives way to the idle glyph", btn.textContent === "📋", btn.textContent);
    }
  }
}

// =========================================================
// Scenario 11: the part size comes from the data, not from a constant
// =========================================================
// The ceiling is the only number the extension imposes; how a transcript is
// divided into parts is derived from the rows the caption source actually
// returned. The rows are split into as few parts as the ceiling allows and then
// sized evenly, so a part that came in under its target raises the next one's
// instead of leaving a stub at the end.
{
  // Six 100-character rows under a 500-character ceiling. Packing greedily up
  // to the ceiling would produce 404 + 202; sized from the text instead, the
  // two parts come out even. (302, not 303: each row is accounted with the
  // joining space that follows it, so a part's body stays strictly under its
  // ceiling rather than exactly at it.)
  const even = Array.from({ length: 6 }, (_, i) => ({ t: i * 5, txt: "y".repeat(100) }));
  const parts = buildChunks({ title: "", start: 0, end: Infinity }, even, 500);
  check("as few parts as the ceiling allows", parts.length === 2, `got ${parts.length}`);
  check(
    "the parts come out even rather than full-then-stub",
    parts[0].body.length === 302 && parts[1].body.length === 302,
    parts.map((p) => p.body.length).join("+")
  );

  // A copy only just over the ceiling still splits - any size at all can be
  // batched, with no size that falls through the cracks.
  const justOver = Array.from({ length: 3 }, (_, i) => ({ t: i * 5, txt: "z".repeat(50) }));
  const two = buildChunks({ title: "", start: 0, end: Infinity }, justOver, 120);
  check("a copy just over the ceiling still splits", two.length >= 2, `got ${two.length}`);
  check(
    "...and every part still fits the ceiling",
    two.every((p) => p.body.length <= 120),
    two.map((p) => p.body.length).join("+")
  );

  // The splitter itself: a transcript that fits is one whole part, untouched.
  const fits = splitRowsIntoParts([row(0), row(5)], CAP);
  check("a transcript that fits stays one whole part", fits.length === 1 && fits[0].length === 2, JSON.stringify(fits.map((g) => g.length)));
}

// =========================================================
// Scenario 12: the parts are honest - a lossless partition, at every size
// =========================================================
// The copy is only trustworthy if the parts reassemble into exactly the
// transcript that was collected: nothing dropped, nothing duplicated, nothing
// reordered, and no part silently over the ceiling it was split to respect.
// Exercised across a spread of sizes and ceilings, because the interesting
// failures live at the boundaries (one row exactly at the ceiling, one char
// over it, an empty transcript).
{
  const build = (src, cap) => buildChunks({ title: "", start: 0, end: Infinity }, src, cap);
  const caps = [1, 7, 12, 13, 24, 25, 50, 99, 500];
  const counts = [0, 1, 2, 3, 17, 40];
  let checked = 0;
  let lossless = true;
  let withinCeiling = true;
  for (const n of counts) {
    for (const cap of caps) {
      const src = Array.from({ length: n }, (_, i) => row(i));
      const parts = build(src, cap);
      checked++;
      if (parts.map((p) => p.body).join(" ") !== src.map((r) => r.txt).join(" ")) lossless = false;
      if (parts.reduce((a, p) => a + p.rowCount, 0) !== n) lossless = false;
      // Row order is preserved part by part: no reordering, no repeats.
      let at = 0;
      for (const p of parts) {
        if (p.body !== src.slice(at, at + p.rowCount).map((r) => r.txt).join(" ")) lossless = false;
        at += p.rowCount;
      }
      // A part may only exceed its ceiling by being one single segment.
      if (parts.some((p) => p.body.length > cap && p.rowCount > 1)) withinCeiling = false;
    }
  }
  check(`every fixture is a lossless partition (${checked} builds)`, lossless, "a part dropped, duplicated or reordered transcript text");
  check("no part exceeds its ceiling unless it is a single segment", withinCeiling, "a multi-segment part was over the ceiling");

  // The callers decide whether to batch with rowsLength(), and the splitter
  // splits on the same measurement - so "fits one write" and "is one part" can
  // never disagree by a character, which would mean making a write the size
  // test has already rejected (or splitting a copy that fits).
  let agree = true;
  for (const cap of caps) {
    const src = Array.from({ length: 12 }, (_, i) => row(i));
    const fits = rowsLength(src) <= cap;
    if (fits !== (build(src, cap).length === 1)) agree = false;
  }
  check("the size test the callers use agrees with the split", agree, "rowsLength() and the splitter disagreed");
}

// =========================================================
// Scenario 13: the losslessness guard refuses a dishonest partition
// =========================================================
// buildChunks() cannot produce a bad partition by construction, so the guard
// is exercised directly. If it ever stopped working, the failure it is meant to
// catch - a pasted transcript with a hole in it - would be indistinguishable
// from a successful copy.
{
  const src = [row(0), row(5), row(10), row(15)];
  const source = src.map((r) => r.txt).join(" ");

  let accepted = true;
  try {
    assertLosslessPartition([{ body: source, rowCount: src.length }], src, CAP);
  } catch (e) {
    accepted = false;
  }
  check("an honest partition is accepted", accepted, "the guard rejected a lossless partition");

  const tampered = [
    ["a dropped row", [{ body: src.slice(0, 3).map((r) => r.txt).join(" "), rowCount: 3 }]],
    ["a duplicated row", [{ body: source + " " + src[0].txt, rowCount: src.length + 1 }]],
    ["a part claiming more rows than it holds", [{ body: source, rowCount: src.length + 1 }]],
  ];
  for (const [name, bad] of tampered) {
    let threw = false;
    try {
      assertLosslessPartition(bad, src, CAP);
    } catch (e) {
      threw = true;
    }
    check(`the guard refuses ${name}`, threw, "the partition was accepted");
  }

  // The ceiling clause on its own: a partition that IS lossless, but whose part
  // holds more than one segment and is too big to write.
  const longRows = [
    { t: 0, txt: "q".repeat(40) },
    { t: 5, txt: "q".repeat(40) },
  ];
  const longBody = longRows.map((r) => r.txt).join(" ");
  let bigRefused = false;
  try {
    assertLosslessPartition([{ body: longBody, rowCount: 2 }], longRows, CAP);
  } catch (e) {
    bigRefused = true;
  }
  check("the guard refuses a lossless part that is still over its ceiling", bigRefused, "an overfull multi-segment part was accepted");

  // ...while one segment longer than the ceiling stays legal: a caption is
  // never cut in half just to satisfy a size limit.
  let longSegmentOk = true;
  try {
    assertLosslessPartition([{ body: longBody, rowCount: 1 }], [{ t: 0, txt: longBody }], CAP);
  } catch (e) {
    longSegmentOk = false;
  }
  check("a single segment longer than the ceiling is not treated as dishonest", longSegmentOk, "one long segment was rejected");
}

// =========================================================
// Scenario 14: a pill reserves its room in the chapter row
// =========================================================
// The badge is absolutely positioned, so a wide pill lands ON TOP of the chapter
// title rather than pushing it aside - and the end of a long title is exactly
// where it lands. So the row is told the width the badge actually rendered at,
// and content.css reserves it. What this scenario cannot check is the geometry
// itself - that both boxes then really miss each other is measured in a real
// browser by tools/check-badge-layout.mjs.
{
  const labelSrc = src.slice(
    src.indexOf("  function setChunkLabel("),
    src.indexOf("  // The main Transcript button's single unit of work:")
  );
  check("the label helpers were extracted", labelSrc.includes("reserveBadgeRoom"), `len=${labelSrc.length}`);
  const resetSrc = src.slice(
    src.indexOf("  async function resetMainButton("),
    src.indexOf("  async function handleClick(")
  );

  // The names have to come from content.js and line up with content.css, or the
  // reservation would silently do nothing: the JS would set a class no rule
  // matches, and the pill would sit on the title again.
  const chunkCls = (src.match(/const CHUNK_LABEL_CLS = "([^"]+)"/) || [])[1];
  const pillCls = (src.match(/const BADGE_PILL_CLS = "([^"]+)"/) || [])[1];
  const roomVar = (src.match(/const BADGE_ROOM_VAR = "([^"]+)"/) || [])[1];
  const roomGap = Number((src.match(/const BADGE_ROOM_GAP = (\d+)/) || [])[1]);
  const itemTags = [
    ...((src.match(/const CHAPTER_ITEM_SELECTOR = \[([\s\S]*?)\]\.join/) || [])[1] || "").matchAll(/"([^"]+)"/g),
  ].map((m) => m[1]);
  check(
    "the reservation's class, variable and row selector are readable",
    !!chunkCls && !!pillCls && !!roomVar && roomGap > 0 && itemTags.length === 2,
    `${chunkCls} / ${pillCls} / ${roomVar} / ${roomGap} / ${itemTags.join("|")}`
  );

  const css = fs.readFileSync("content.css", "utf8").replace(/\r\n/g, "\n");
  // The selector of the rule that carries the reservation, so both halves can be
  // checked: it has to cover every row whose badge sits beside the title (the
  // classic description rows AND the horizontal chapter-list items), and it must
  // not touch a vertical card, where reserving inline room would only squeeze it.
  const roomRule = (css.match(new RegExp(`([^{}]*)\\{[^{}]*var\\(${roomVar}\\)[^{}]*\\}`)) || [])[1] || "";
  check(
    "content.css reserves the pill's room on both rows whose badge sits beside the title",
    itemTags.every((tag) => roomRule.includes(`${tag}.${pillCls}`)),
    JSON.stringify(roomRule.trim())
  );
  check(
    "...and leaves a VERTICAL chapter card out of it",
    /:not\(\[layout\*="VERTICAL"\]\)/.test(roomRule),
    JSON.stringify(roomRule.trim())
  );
  check(
    "the badge pill rule itself is still there",
    new RegExp(`\\.${chunkCls}[^{]*\\{[^}]*width: auto`).test(css),
    `no .${chunkCls} rule`
  );

  const buildLabels = new Function(
    "CHUNK_LABEL_CLS",
    "BADGE_PILL_CLS",
    "BADGE_ROOM_VAR",
    "BADGE_ROOM_GAP",
    "CHAPTER_ITEM_SELECTOR",
    "setButtonState",
    "t",
    `${labelSrc}\n${resetSrc}\n    return { setChunkLabel, reserveBadgeRoom, resetMainButton };`
  );

  // A chapter row: a Set-backed classList, a style that records what was set,
  // and matches() for the injected row selector.
  const makeRow = (tag) => {
    const row = { classes: new Set(), props: {}, tag };
    row.classList = {
      add: (c) => row.classes.add(c),
      remove: (c) => row.classes.delete(c),
      contains: (c) => row.classes.has(c),
    };
    row.style = {
      setProperty: (k, v) => {
        row.props[k] = v;
      },
      removeProperty: (k) => {
        delete row.props[k];
      },
    };
    row.matches = (sel) => String(sel).split(", ").includes(row.tag);
    return row;
  };
  const makeBadge = ({ orig = "📋", width = 0, row = null } = {}) => {
    const btn = { textContent: orig || "", disabled: false, classes: new Set(), parentElement: row };
    btn.classList = { add: (c) => btn.classes.add(c), remove: (c) => btn.classes.delete(c) };
    btn.getAttribute = (n) => (n === "data-orig" ? orig : null);
    btn.getBoundingClientRect = () => ({ width });
    return btn;
  };

  const helpers = buildLabels(
    chunkCls,
    pillCls,
    roomVar,
    roomGap,
    itemTags.join(", "),
    (b, label, disabled) => {
      b.textContent = label;
      b.disabled = !!disabled;
    },
    (key) => key
  );

  const row = makeRow(itemTags[0]);
  const btn = makeBadge({ width: 96, row });
  helpers.setChunkLabel(btn, "⏭2/5 · 43%", false);
  check("the row is told a pill is showing", row.classes.has(pillCls), [...row.classes].join(","));
  check(
    "...and exactly the width the badge rendered at, plus the gap",
    row.props[roomVar] === `${96 + roomGap}px`,
    `${roomVar}=${row.props[roomVar]} (expected ${96 + roomGap}px)`
  );

  // A wider label reserves more room, because the width is measured rather than
  // guessed: that is what makes it right for a three-digit count or another
  // digit set.
  const wideRow = makeRow(itemTags[1]);
  helpers.setChunkLabel(makeBadge({ width: 132, row: wideRow }), "⏭12/100 · 100%", false);
  check("a wider label reserves more room", wideRow.props[roomVar] === `${132 + roomGap}px`, `${roomVar}=${wideRow.props[roomVar]}`);

  {
    const mainRow = makeRow(itemTags[0]);
    helpers.setChunkLabel(makeBadge({ orig: null, width: 200, row: mainRow }), "⏳ 1/5", true);
    check(
      "the main button reserves nothing (its label is in the page flow)",
      !mainRow.classes.has(pillCls) && mainRow.props[roomVar] === undefined,
      JSON.stringify({ cls: [...mainRow.classes], props: mainRow.props })
    );
  }

  {
    const foreignRow = makeRow("div");
    helpers.setChunkLabel(makeBadge({ width: 96, row: foreignRow }), "⏭2/5", false);
    check(
      "a badge that is not in a chapter row leaves its parent alone",
      !foreignRow.classes.has(pillCls) && foreignRow.props[roomVar] === undefined,
      JSON.stringify({ cls: [...foreignRow.classes], props: foreignRow.props })
    );
  }

  {
    const unmeasuredRow = makeRow(itemTags[0]);
    helpers.setChunkLabel(makeBadge({ width: 0, row: unmeasuredRow }), "⏭2/5", false);
    check(
      "an unmeasurable badge reserves nothing rather than guessing",
      !unmeasuredRow.classes.has(pillCls) && unmeasuredRow.props[roomVar] === undefined,
      JSON.stringify({ cls: [...unmeasuredRow.classes], props: unmeasuredRow.props })
    );
  }

  {
    // Finishing a session gives the room back to the title.
    const doneRow = makeRow(itemTags[0]);
    const doneBtn = makeBadge({ width: 96, row: doneRow });
    helpers.setChunkLabel(doneBtn, "⏭2/5 · 43%", false);
    await helpers.resetMainButton(doneBtn);
    check(
      "the pill's room is given back when the badge returns to idle",
      !doneRow.classes.has(pillCls) && doneRow.props[roomVar] === undefined,
      JSON.stringify({ cls: [...doneRow.classes], props: doneRow.props })
    );
    check("the badge keeps its own glyph", doneBtn.textContent === "📋", doneBtn.textContent);
  }
}

console.log(failures === 0 ? "\nALL CHUNK TESTS PASSED" : `\n${failures} CHUNK TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);