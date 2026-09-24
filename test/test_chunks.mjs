// Unit tests for buildChunks (extracted verbatim from content.js): the main
// button's chunk-mode list builder, including the oversized-chapter sub-split
// that caps every chunk at CHUNK_MAX_CHARS characters.
import fs from "node:fs";

const src = fs.readFileSync("content.js", "utf8");
const start = src.indexOf("  function buildChunks(");
const end = src.indexOf("\n\n  // =========================================================\n  // FALLBACK: CAPTION SOURCES", start);
if (start < 0 || end < 0) {
  console.error("FAIL: could not extract buildChunks from content.js");
  process.exit(1);
}
const fnSrc = src.slice(start, end);

// Inject a small cap so splitting is exercised without huge fixtures.
const buildChunks = new Function("CHUNK_MAX_CHARS", `return (${fnSrc});`)(50);

// The real counter formatter and label table (verbatim from content.js), so the
// "n/N" labels are exercised with the digits and the wording the page would
// actually show. The page's language is supplied here because these tests run
// without a DOM.
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
const buildCountText = (opts = {}) => buildUi(opts).countText;

// Fixed-length row text so lengths are deterministic: "001yyyyy..." etc.
// (11 chars each -> +12 with the joining space, so 3 rows = 35 chars, well
// under the 50-char test cap; 4 rows = 47 chars, also under it).
function row(t, textLen = 8) {
  return { t, txt: String(t).padStart(3, "0") + "y".repeat(textLen) };
}

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// =========================================================
// Scenario 1: small chapters stay one chunk each
// =========================================================
{
  const chapters = [
    { title: "Intro", start: 0, end: 30 },
    { title: "Body", start: 30, end: 60 },
  ];
  const rows = [row(0), row(5), row(10), row(30), row(35), row(40)];
  const chunks = buildChunks(chapters, rows);
  check("small chapters -> one chunk each", chunks.length === 2, `got ${chunks.length}`);
  check("chunks numbered 1..N", chunks[0].n === 1 && chunks[1].n === 2, JSON.stringify(chunks.map((c) => c.n)));
  check("each text starts with its title line", chunks[0].text.startsWith("Intro\n") && chunks[1].text.startsWith("Body\n"));
  check("row counts match", chunks[0].rowCount === 3 && chunks[1].rowCount === 3);
}

// =========================================================
// Scenario 2: an oversized chapter is split into parts
// =========================================================
{
  const chapters = [{ title: "Huge", start: 0, end: 600 }];
  const rows = [];
  for (let i = 0; i < 20; i++) rows.push(row(i * 5));
  const fullBody = rows.map((r) => r.txt).join(" ");
  const chunks = buildChunks(chapters, rows);
  check("oversized chapter split into multiple parts", chunks.length > 1, `got ${chunks.length}`);
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
// Scenario 3: chapters without rows are skipped, numbering continues
// =========================================================
{
  const chapters = [
    { title: "A", start: 0, end: 10 },
    { title: "B", start: 10, end: 20 }, // no rows -> skipped
    { title: "C", start: 20, end: 30 },
  ];
  const rows = [row(0), row(20)];
  const chunks = buildChunks(chapters, rows);
  check("empty chapter skipped", chunks.length === 2 && chunks[0].title === "A" && chunks[1].title === "C", chunks.map((c) => c.title).join(","));
  check("numbering is sequential after skip", chunks[0].n === 1 && chunks[1].n === 2);
}

// =========================================================
// Scenario 4: a single row longer than the cap still lands in its own chunk
// =========================================================
{
  const chapters = [{ title: "LongRow", start: 0, end: 10 }];
  const longRow = { t: 0, txt: "z".repeat(200) };
  const chunks = buildChunks(chapters, [longRow]);
  check("single oversized row -> one chunk containing it whole", chunks.length === 1 && chunks[0].text === "LongRow\n" + "z".repeat(200), chunks[0]?.text?.length);
  check("rowCount is 1", chunks[0].rowCount === 1);
}

// =========================================================
// Scenario 5: mixed chapters - small ones whole, big one split
// =========================================================
{
  const chapters = [
    { title: "Small", start: 0, end: 30 },
    { title: "Big", start: 30, end: 600 },
  ];
  const rows = [];
  for (let i = 0; i < 3; i++) rows.push(row(i * 5));
  for (let i = 0; i < 20; i++) rows.push(row(30 + i * 5));
  const chunks = buildChunks(chapters, rows);
  check("small chapter single, big chapter split", chunks[0].title === "Small" && chunks.slice(1).every((c) => c.title.startsWith("Big (part")), chunks.map((c) => c.title).join(","));
  check("all chunks <= cap body", chunks.every((c) => c.text.length - c.title.length - 1 <= 50));
  check("numbering sequential across both", chunks.every((c, i) => c.n === i + 1));
}

// =========================================================
// Scenario 7: the chapter path (a single chapter through the same builder)
// =========================================================
// copyChapterRows() feeds buildChunks a one-entry chapter list, so a chapter
// that fits stays a single write and only an oversized one becomes parts. The
// single-chunk text must stay byte-identical to the old behaviour (title line,
// then the body) so normal chapters are unaffected.
{
  const chapter = { title: "Solo", start: 0, end: 600 };
  const body = (rows) => rows.map((r) => r.txt).join(" ");

  const fitting = [row(0), row(5), row(10)];
  const one = buildChunks([chapter], fitting);
  check("chapter that fits -> exactly one chunk", one.length === 1, `got ${one.length}`);
  check(
    "fitting chapter copies title line + body, as before",
    one[0].text === "Solo\n" + body(fitting),
    JSON.stringify(one[0].text)
  );
  check("fitting chapter keeps its row count", one[0].rowCount === fitting.length, String(one[0].rowCount));

  const oversized = [];
  for (let i = 0; i < 8; i++) oversized.push(row(i * 5));
  const many = buildChunks([chapter], oversized);
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
// Scenario 7b: a video with no chapters (one untitled span)
// =========================================================
// The cap is a limit on one clipboard write, not a chapter feature, so a
// chapterless video is split through the same builder with a single untitled
// span. It must not be labelled "Chapter 1", and an unsplit copy must still be
// just the body.
{
  const span = { title: "", start: 0, end: Infinity };
  const body = (rows) => rows.map((r) => r.txt).join(" ");

  const small = [row(0), row(5), row(10)];
  const one = buildChunks([span], small);
  check("untitled span that fits -> one chunk", one.length === 1, `got ${one.length}`);
  check("untitled span adds no header line", one[0].text === body(small), JSON.stringify(one[0].text));

  const big = [];
  for (let i = 0; i < 8; i++) big.push(row(i * 5));
  const many = buildChunks([span], big);
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
    src.indexOf("  // The spans a copy should be split along:"),
    src.indexOf("  async function copyChapterRows(")
  );
  check("the fallback helpers were extracted", fallbackSrc.length > 200, `len=${fallbackSrc.length}`);
  const buildChunksTiny = new Function("CHUNK_MAX_CHARS", `return (${fnSrc});`)(50);
  const buildHelpers = new Function(
    "getChapters",
    "buildChunks",
    "copyTextToClipboard",
    "copyNextChunk",
    "console",
    `${fallbackSrc}\n    return { chunkSpans, copyRowsWithSplitFallback };`
  );

  const setup = ({ writeFails = false, partFails = false, chapters = null } = {}) => {
    const calls = { writes: [], parts: 0 };
    const helpers = buildHelpers(
      () => chapters,
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

  const smallRows = [row(0), row(5), row(10)];
  const bigRows = [];
  for (let i = 0; i < 8; i++) bigRows.push(row(i * 5));

  {
    const { helpers, calls } = setup();
    const outcome = await helpers.copyRowsWithSplitFallback(smallRows, [{ title: "T", start: 0, end: 999 }], "T\nbody", null);
    check("a write that succeeds is left alone", outcome === "whole", String(outcome));
    check("a write that succeeds writes exactly once", calls.writes.length === 1 && calls.parts === 0, JSON.stringify(calls));
  }

  {
    const { helpers, calls } = setup({ writeFails: true });
    const outcome = await helpers.copyRowsWithSplitFallback(bigRows, [{ title: "T", start: 0, end: 999 }], "T\nbig", {});
    check("a rejected write falls back to parts", outcome === "parts", String(outcome));
    check("the fallback hands over to the first part", calls.parts === 1, JSON.stringify(calls));
    check("the oversized text is not written as one piece", calls.writes.length === 1, JSON.stringify(calls.writes.length));
  }

  {
    const { helpers, calls } = setup({ writeFails: true });
    let threw = null;
    try {
      await helpers.copyRowsWithSplitFallback(smallRows, [{ title: "T", start: 0, end: 999 }], "T\nsmall", {});
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
      await helpers.copyRowsWithSplitFallback(bigRows, [{ title: "T", start: 0, end: 999 }], "T\nbig", {});
    } catch (e) {
      threw = e;
    }
    check("a failing part write still surfaces an error", /part write failed/.test(String(threw && threw.message)), String(threw && threw.message));
  }

  {
    const chapters = [
      { title: "One", start: 0, end: 10 },
      { title: "Two", start: 10, end: 20 },
      { title: "Three", start: 20, end: 30 },
    ];
    const withChapters = setup({ chapters });
    check("splits follow the chapter list when there is one", withChapters.helpers.chunkSpans() === chapters, "did not reuse the chapter list");
    const lone = setup({ chapters: [{ title: "Only", start: 0, end: 10 }] });
    const spans = lone.helpers.chunkSpans();
    check("a single chapter does not disable splitting", Array.isArray(spans) && spans.length === 1 && spans[0].title === "" && spans[0].end === Infinity, JSON.stringify(spans));
    const none = setup({ chapters: null });
    const spans2 = none.helpers.chunkSpans();
    check("no chapters at all still yields a splittable span", Array.isArray(spans2) && spans2.length === 1 && spans2[0].start === 0 && spans2[0].end === Infinity, JSON.stringify(spans2));
  }
}

// =========================================================
// Scenario 6: the two chunk constants stay coherent
// =========================================================
// The cap is what one clipboard write may contain; the threshold is the size at
// which a copy is considered too big to make in a single write. A chunk must
// therefore never be larger than the threshold - if the two ever drift the
// extension would be making a write it has already decided is too large.
{
  const cap = Number((src.match(/const CHUNK_MAX_CHARS = (\d+)/) || [])[1]);
  const threshold = Number((src.match(/const CHUNK_THRESHOLD = (\d+)/) || [])[1]);
  check("CHUNK_MAX_CHARS and CHUNK_THRESHOLD are readable numbers", cap > 0 && threshold > 0, `cap=${cap} threshold=${threshold}`);
  check(
    "one chunk never exceeds the size treated as pasteable in one write",
    cap <= threshold,
    `cap=${cap} threshold=${threshold}`
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
    "t",
    `${btnSrc}\n    return { copyNextChunk, resetMainButton, session: () => chunkSession };`
  );

  const chunkList = [
    { n: 1, title: "One", text: "One\nbody", rowCount: 1 },
    { n: 2, title: "Two", text: "Two\nbody", rowCount: 1 },
    { n: 3, title: "Three", text: "Three\nbody", rowCount: 1 },
  ];

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

  const wire = (session, btn, countText = buildCountText(), t = buildUi().t) => {
    const seen = { writes: [], labelsWhileWriting: [], timers: [] };
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
      {},
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
      t
    );
    return { helpers, seen };
  };

  // The chapter badge (compact: it has a data-orig glyph instead of a label).
  {
    const btn = makeButton({ orig: "📋", tip: "Copy transcript of chapter: Intro" });
    const session = { chunks: chunkList, idx: 0, owner: btn };
    const { helpers, seen } = wire(session, btn);

    await helpers.copyNextChunk(btn);
    check(
      "an oversized chapter shows its part count while copying",
      seen.labelsWhileWriting[0] === "⏳1/3",
      String(seen.labelsWhileWriting[0])
    );
    check("the count widens the badge into a pill", btn.classes.has("my-yt-chunking"), [...btn.classes].join(","));
    check("the next part is offered once the current one is copied", btn.textContent === "⏭2/3", btn.textContent);

    await helpers.copyNextChunk(btn);
    check("the count advances part by part", seen.labelsWhileWriting[1] === "⏳2/3" && btn.textContent === "⏭3/3", `${seen.labelsWhileWriting[1]} / ${btn.textContent}`);

    await helpers.copyNextChunk(btn);
    check("the last part ends on a checkmark", btn.textContent === "✓", btn.textContent);
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
    const { helpers, seen } = wire(session, btn);
    await helpers.copyNextChunk(btn);
    check(
      "the main button keeps its wordier count",
      seen.labelsWhileWriting[0] === "⏳ 1/3" && btn.textContent === "⏭ Copy 2/3",
      `${seen.labelsWhileWriting[0]} / ${btn.textContent}`
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
      { n: 1, title: "المقدمة", text: "المقدمة\nbody", rowCount: 1 },
      { n: 2, title: "الدرس الأول", text: "الدرس الأول\nbody", rowCount: 1 },
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
      btn.title.startsWith("Paste chunk 1 (") && btn.title.endsWith(")."),
      btn.title
    );
  }

  // The counters follow the page's numerals: a page whose language is Arabic
  // shows "⏳١/٣" and "⏭٢/٣" rather than ASCII digits.
  {
    const arabicCounts = buildCountText({ lang: "ar" });
    const btn = makeButton({ orig: "📋", tip: "t" });
    const session = { chunks: chunkList, idx: 0, owner: btn };
    const { helpers, seen } = wire(session, btn, arabicCounts);
    await helpers.copyNextChunk(btn);
    check("an Arabic page shows Arabic-Indic counter digits", seen.labelsWhileWriting[0] === "⏳١/٣", String(seen.labelsWhileWriting[0]));
    check("...and offers the next part in the same digits", btn.textContent === "⏭٢/٣", btn.textContent);
    check("...with the slash still between the two numbers", seen.labelsWhileWriting[0].includes("١/٣"), String(seen.labelsWhileWriting[0]));

    const mainBtn = makeButton();
    const mainSession = { chunks: chunkList, idx: 0, owner: mainBtn };
    const mainHelpers = wire(mainSession, mainBtn, arabicCounts).helpers;
    await mainHelpers.copyNextChunk(mainBtn);
    check("the main button's wordier count is localized too", mainBtn.textContent === "⏭ Copy ٢/٣", mainBtn.textContent);
  }

  // ...and a Latin page is byte-identical to what shipped before.
  {
    const btn = makeButton({ orig: "📋", tip: "t" });
    const session = { chunks: chunkList, idx: 0, owner: btn };
    const { helpers, seen } = wire(session, btn, buildCountText({ lang: "en-GB" }));
    await helpers.copyNextChunk(btn);
    check("an English page keeps ASCII counter digits", seen.labelsWhileWriting[0] === "⏳1/3" && btn.textContent === "⏭2/3", `${seen.labelsWhileWriting[0]} / ${btn.textContent}`);
  }

  // The chapter copy path that owns the session (copyChapterRows).
  {
    const rowsSrc = src.slice(
      src.indexOf("  async function copyChapterRows("),
      src.indexOf("  async function copyChapterRange(")
    );
    check("the chapter copy helper was extracted", rowsSrc.includes("copyRowsWithSplitFallback"), `len=${rowsSrc.length}`);

    const buildChapterCopy = new Function(
      "chunkSession",
      "chunkSpans",
      "buildChunks",
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

    const buildChunksTiny = new Function("CHUNK_MAX_CHARS", `return (${fnSrc});`)(50);
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
        () => [chapter],
        buildChunksTiny,
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
        () => [chapter],
        buildChunksTiny,
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

console.log(failures === 0 ? "\nALL CHUNK TESTS PASSED" : `\n${failures} CHUNK TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);