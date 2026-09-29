// Unit tests for the TEXT layer (rows -> the text a copy holds) and the SRT
// builder (rows -> SubRip cues -> part files), extracted verbatim from content.js.
//
// Three properties are pinned here beyond the wording of a timestamp:
//  - the text layer is the ONLY place a format is chosen, and the plain format
//    is byte-identical to what the extension has always copied;
//  - a .srt file is well formed (numbered cues, `HH:MM:SS,mmm --> HH:MM:SS,mmm`,
//    a blank line between and after them) and a cue end is the next cue's start;
//  - the parts a big export is split into are a LOSSLESS partition of its cues,
//    sized by words, with no cue ever cut in half - the same guarantee the
//    clipboard parts get.
import fs from "node:fs";

// CRLF-safe: a Windows checkout (core.autocrlf) restores CRLF line endings while
// every anchor below is written against LF, so normalize before matching.
const src = fs.readFileSync("content.js", "utf8").replace(/\r\n/g, "\n");

const extract = (from, to) => {
  const start = src.indexOf(from);
  const end = src.indexOf(to, start);
  if (start < 0 || end < 0) {
    console.error(`FAIL: could not extract from content.js: ${from}`);
    process.exit(1);
  }
  return src.slice(start, end);
};

// The text layer and the SRT builder live inside the batcher region (that is
// what lets the partition check and the formatter travel together), so the slice
// is the same one test_chunks.mjs uses - everything from buildChunks to the
// caption sources.
const regionSrc = extract(
  "  function buildChunks(",
  "\n\n  // =========================================================\n  // FALLBACK: CAPTION SOURCES"
);

// The batcher's own numbers are read out of the source rather than injected, so
// the split below is exercised with the ceilings that ship.
const num = (name) => Number((src.match(new RegExp(`const ${name} = (\\d+)`)) || [])[1]);
const SRT_CHUNK_THRESHOLD_WORDS = num("SRT_CHUNK_THRESHOLD_WORDS");
const SRT_CHUNK_MAX_WORDS = num("SRT_CHUNK_MAX_WORDS");

const buildLib = ({ storage = {}, videoTitle = () => "A Video" } = {}) =>
  new Function(
    "localStorage",
    "videoTitle",
    "cleanSegmentText",
    // The batcher's pair is declared in content.js's constants block, outside the
    // extracted region, so it is injected with the values that ship.
    "SRT_CHUNK_THRESHOLD_WORDS",
    "SRT_CHUNK_MAX_WORDS",
    `${regionSrc}
    return {
      buildChunks,
      splitRowsIntoParts,
      rowsLength,
      assertLosslessPartition,
      clockText,
      timeText,
      renderRow,
      formatBody,
      transcriptOptions,
      transcriptAction,
      saveTranscriptOption,
      readTimeStyle,
      TEXT_TITLE_KEY,
      TEXT_FORMAT_KEY,
      TEXT_TIME_KEY,
      TEXT_ACTION_KEY,
      FORMAT_PARAGRAPH,
      FORMAT_LINES,
      TIME_BRACKET,
      TIME_PLAIN,
      TIME_PAREN,
      ACTION_COPY,
      ACTION_SRT,
      buildSrtCues,
      buildSrtParts,
      splitCuesIntoParts,
      assertLosslessSrt,
      srtText,
      srtTime,
      srtFilename,
      srtWords,
      SRT_CHUNK_THRESHOLD_WORDS,
      SRT_CHUNK_MAX_WORDS,
    };`
  )(
    {
      getItem: (k) => (k in storage ? storage[k] : null),
      setItem: (k, v) => {
        storage[k] = String(v);
      },
    },
    videoTitle,
    // Verbatim from content.js (a pure function), so the file-name rules are
    // exercised against the same whitespace collapsing every other text path uses.
    (text) => String(text || "").replace(/\s+/g, " ").trim(),
    SRT_CHUNK_THRESHOLD_WORDS,
    SRT_CHUNK_MAX_WORDS
  );

const lib = buildLib();

// Fixed-length row text so lengths are deterministic ("001yyyyy..."), like the
// chunk suite's rows.
const row = (t, textLen = 8) => ({ t, txt: String(t).padStart(3, "0") + "y".repeat(textLen) });

// Verbatim from the extension: the timecode parser a copied line has to survive.
const parseTimecode = (text) => {
  const m = String(text).match(/(?:(\d{1,2}):)?(\d{1,2}):(\d{2})/);
  if (!m) return null;
  const h = m[1] ? parseInt(m[1], 10) : 0;
  return h * 3600 + parseInt(m[2], 10) * 60 + parseInt(m[3], 10);
};

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// =========================================================
// Scenario 1: the timestamps a copy carries
// =========================================================
{
  check("under an hour is MM:SS", lib.clockText(5) === "0:05", lib.clockText(5));
  check("a minute rolls over", lib.clockText(65) === "1:05", lib.clockText(65));
  check("the hour is only printed when there is one", lib.clockText(3661) === "1:01:01", lib.clockText(3661));
  check("a fractional second is floored, never rounded up past the cue", lib.clockText(59.9) === "0:59", lib.clockText(59.9));
  check("a negative time cannot be emitted", lib.clockText(-4) === "0:00", lib.clockText(-4));

  // The one property that makes the timestamp useful on the page it came from:
  // the page's own timecode parser reads the line back.
  check(
    "a written timestamp parses back to the second it came from",
    [0, 7, 59, 60, 599, 3600, 7325].every((s) => parseTimecode(lib.clockText(s)) === s),
    [0, 7, 59, 60, 599, 3600, 7325].map((s) => `${s}->${parseTimecode(lib.clockText(s))}`).join(", ")
  );
}

// =========================================================
// Scenario 2: the two formats of a copy
// =========================================================
{
  const rows = [row(0), row(5), row(10)];
  const plain = { format: "paragraph", header: "" };
  const lines = { format: "lines", header: "" };

  check(
    "the plain format is the space-joined text the extension has always copied",
    lib.formatBody(rows, plain) === rows.map((r) => r.txt).join(" "),
    lib.formatBody(rows, plain)
  );
  check(
    "...and rendering a row without options is the plain format too",
    lib.renderRow(rows[0], undefined) === rows[0].txt,
    lib.renderRow(rows[0], undefined)
  );
  check(
    "the timestamped format puts one segment per line, each with its own time",
    lib.formatBody(rows, lines) === rows.map((r) => `[${lib.clockText(r.t)}] ${r.txt}`).join("\n"),
    JSON.stringify(lib.formatBody(rows, lines))
  );
  check(
    "...with no bidi control character anywhere (the text stays greppable)",
    !/[\u200e\u200f\u2066-\u2069\u202a-\u202e]/.test(lib.formatBody(rows, lines)),
    "a bidi control leaked into the copied text"
  );

  // The size the batcher measures is the size the text has: a shared function,
  // so the decision to split and the split itself cannot disagree.
  check(
    "rowsLength measures the rendered line plus its separator, in both formats",
    lib.rowsLength(rows, plain) === plain_len(rows) && lib.rowsLength(rows, lines) === lines_len(rows),
    `${lib.rowsLength(rows, plain)} vs ${plain_len(rows)} / ${lib.rowsLength(rows, lines)} vs ${lines_len(rows)}`
  );
  function plain_len(rs) {
    return rs.reduce((n, r) => n + r.txt.length + 1, 0);
  }
  function lines_len(rs) {
    return rs.reduce((n, r) => n + `[${lib.clockText(r.t)}] ${r.txt}`.length + 1, 0);
  }
  check(
    "...and the body it produces is one separator shorter, exactly as before",
    lib.rowsLength(rows, plain) === lib.formatBody(rows, plain).length + 1,
    `${lib.rowsLength(rows, plain)} vs ${lib.formatBody(rows, plain).length}`
  );
}

// =========================================================
// Scenario 2b: how the timestamp is decorated
// =========================================================
// Three styles, one timestamp spelling: the decoration around clockText() is a
// preference of its own, and the plain format ignores it (there is nothing to
// decorate).
{
  const rows = [row(0), row(65), row(3661)];
  const lines = (time) => ({ format: lib.FORMAT_LINES, header: "", time });
  const firstLine = (opts) => lib.formatBody(rows, opts).split("\n")[0];

  check(
    "the bracketed style is the default",
    firstLine(lines(undefined)) === `[0:00] ${rows[0].txt}`,
    firstLine(lines(undefined))
  );
  check(
    "...and can be asked for by name",
    firstLine(lines(lib.TIME_BRACKET)) === firstLine(lines(undefined)),
    firstLine(lines(lib.TIME_BRACKET))
  );
  check(
    "a bare timestamp is just the time",
    firstLine(lines(lib.TIME_PLAIN)) === `0:00 ${rows[0].txt}`,
    firstLine(lines(lib.TIME_PLAIN))
  );
  check(
    "parentheses are the third style",
    firstLine(lines(lib.TIME_PAREN)) === `(0:00) ${rows[0].txt}`,
    firstLine(lines(lib.TIME_PAREN))
  );
  check(
    "an unknown style degrades to the default rather than to no line at all",
    firstLine(lines("dashes")) === firstLine(lines(undefined)),
    firstLine(lines("dashes"))
  );
  check(
    "the hour still rolls into the same decoration",
    lib.formatBody([row(3661)], lines(lib.TIME_PAREN)) === `(1:01:01) ${rows[2].txt}`,
    lib.formatBody([row(3661)], lines(lib.TIME_PAREN))
  );
  check(
    "every style parses back to the second it came from",
    [lib.TIME_BRACKET, lib.TIME_PLAIN, lib.TIME_PAREN].every(
      (style) => parseTimecode(firstLine(lines(style))) === 0
    ),
    [lib.TIME_BRACKET, lib.TIME_PLAIN, lib.TIME_PAREN].map((s) => parseTimecode(firstLine(lines(s)))).join(",")
  );
  check(
    "the size a row contributes follows the decoration it renders",
    [lib.TIME_BRACKET, lib.TIME_PLAIN, lib.TIME_PAREN].every(
      (style) => lib.rowsLength(rows, lines(style)) === lib.formatBody(rows, lines(style)).length + 1
    ),
    [lib.TIME_BRACKET, lib.TIME_PLAIN, lib.TIME_PAREN]
      .map((s) => lib.rowsLength(rows, lines(s)) - lib.formatBody(rows, lines(s)).length)
      .join(",")
  );
  check(
    "the plain format carries no timestamp at all, whatever style is set",
    lib.formatBody(rows, { format: lib.FORMAT_PARAGRAPH, header: "", time: lib.TIME_PAREN }) ===
      rows.map((r) => r.txt).join(" "),
    lib.formatBody(rows, { format: lib.FORMAT_PARAGRAPH, header: "", time: lib.TIME_PAREN })
  );
  check(
    "a title line is written plain, never timestamped",
    lib
      .buildChunks({ title: "", start: 0, end: Infinity }, rows, 1000, {
        format: lib.FORMAT_LINES,
        header: "A Video",
        time: lib.TIME_PLAIN,
      })[0]
      .text.startsWith("A Video\n0:00 "),
    "the header line got a timestamp"
  );
}

// =========================================================
// Scenario 3: the video-title line and the settings behind it
// =========================================================
{
  const rows = [row(0), row(5)];
  const span = { title: "", start: 0, end: Infinity };
  const withTitle = { format: "paragraph", header: "A Video" };

  const bare = lib.buildChunks(span, rows, 1000)[0];
  check("with no header the copy starts with the text itself", bare.text === lib.formatBody(rows), bare.text.slice(0, 40));
  check("...and with no title line either, a whole-video part has no header at all", !bare.text.includes("\n"));

  const titled = lib.buildChunks(span, rows, 1000, withTitle)[0];
  check(
    "the title line is the copy's first line, alone",
    titled.text === `A Video\n${lib.formatBody(rows, withTitle)}`,
    JSON.stringify(titled.text)
  );
  check(
    "...and is not part of the body the partition check compares",
    titled.body === lib.formatBody(rows, withTitle),
    JSON.stringify(titled.body)
  );

  const chapter = { title: "Intro", start: 0, end: 600 };
  const chapterText = lib.buildChunks(chapter, rows, 1000, withTitle)[0];
  check(
    "a chapter copy keeps the video title above the chapter title",
    chapterText.text.startsWith("A Video\nIntro\n"),
    JSON.stringify(chapterText.text)
  );

  // The settings are read per operation, so flipping one applies to the next
  // copy - and an unknown value can never leave the copy in a broken format.
  const storage = {};
  const settingLib = buildLib({ storage });
  check("the default format is the plain paragraph", settingLib.transcriptOptions().format === "paragraph", JSON.stringify(settingLib.transcriptOptions()));
  check("...and the default has no title line", settingLib.transcriptOptions().header === "", JSON.stringify(settingLib.transcriptOptions()));
  settingLib.saveTranscriptOption("ytxt_format", "lines");
  settingLib.saveTranscriptOption("ytxt_title", "1");
  check(
    "the settings bubble's two choices come back out of storage",
    settingLib.transcriptOptions().format === "lines" && settingLib.transcriptOptions().header === "A Video",
    JSON.stringify(settingLib.transcriptOptions())
  );
  storage.ytxt_format = "srt";
  storage.ytxt_title = "maybe";
  check(
    "an unknown setting value degrades to the default instead of breaking a copy",
    settingLib.transcriptOptions().format === "paragraph" && settingLib.transcriptOptions().header === "",
    JSON.stringify(settingLib.transcriptOptions())
  );

  // The timestamp style is its own preference, with the same rules.
  check("the timestamp style defaults to the bracketed one", settingLib.transcriptOptions().time === lib.TIME_BRACKET, JSON.stringify(settingLib.transcriptOptions()));
  settingLib.saveTranscriptOption(lib.TEXT_TIME_KEY, lib.TIME_PAREN);
  check("...and is read back from storage", settingLib.transcriptOptions().time === lib.TIME_PAREN, JSON.stringify(settingLib.transcriptOptions()));
  settingLib.saveTranscriptOption(lib.TEXT_TIME_KEY, "dashes");
  check("...while a style the extension does not know falls back to it", settingLib.transcriptOptions().time === lib.TIME_BRACKET, JSON.stringify(settingLib.transcriptOptions()));

  // ...and so is the operation the main button's own click runs.
  check("the button's own click copies by default", settingLib.transcriptAction() === lib.ACTION_COPY, settingLib.transcriptAction());
  settingLib.saveTranscriptOption(lib.TEXT_ACTION_KEY, lib.ACTION_SRT);
  check("a remembered download is read back", settingLib.transcriptAction() === lib.ACTION_SRT, settingLib.transcriptAction());
  settingLib.saveTranscriptOption(lib.TEXT_ACTION_KEY, "pdf");
  check("an operation the extension does not know falls back to copying", settingLib.transcriptAction() === lib.ACTION_COPY, settingLib.transcriptAction());

  // The settings keys are the strings the whole file uses: a renamed key would
  // leave the bubble writing a preference the copy never reads.
  check(
    "the settings keys and the values are the words the tests use",
    lib.TEXT_TITLE_KEY === "ytxt_title" &&
      lib.TEXT_FORMAT_KEY === "ytxt_format" &&
      lib.TEXT_TIME_KEY === "ytxt_time" &&
      lib.TEXT_ACTION_KEY === "ytxt_action" &&
      lib.ACTION_COPY === "copy" &&
      lib.ACTION_SRT === "srt",
    JSON.stringify({
      title: lib.TEXT_TITLE_KEY,
      format: lib.TEXT_FORMAT_KEY,
      time: lib.TEXT_TIME_KEY,
      action: lib.TEXT_ACTION_KEY,
    })
  );
  settingLib.saveTranscriptOption("ytxt_title", 1);
  check("a setting is stored as a string, whatever was passed", storage.ytxt_title === "1", JSON.stringify(storage.ytxt_title));
}

// =========================================================
// Scenario 4: rows -> cues
// =========================================================
{
  const rows = [row(0), row(5), row(12)];
  const cues = lib.buildSrtCues(rows, { title: "", start: 0, end: Infinity });
  check("every segment becomes one cue", cues.length === 3, String(cues.length));
  check("a cue starts where its segment does", cues.map((c) => c.start).join(",") === "0,5,12", cues.map((c) => c.start).join(","));
  check("a cue ends where the next one starts", cues[0].end === 5 && cues[1].end === 12, `${cues[0].end},${cues[1].end}`);
  check(
    "the last cue gets a sane length instead of zero",
    cues[2].end > cues[2].start,
    String(cues[2].end)
  );
  check("cue text is the segment text, untouched", cues[0].text === rows[0].txt, cues[0].text);
  check(
    "...and carries no bidi control character",
    !/[\u200e\u200f\u2066-\u2069]/.test(cues.map((c) => c.text).join("")),
    "a bidi control leaked into the cue text"
  );

  // A chapter's subtitles stop at the chapter boundary: they must not run on
  // into the next chapter. (A chapter's rows are all strictly inside its range -
  // the slice is cut with `t < chapter.end` - which is why the last cue can end
  // exactly on the boundary.)
  const chapterCues = lib.buildSrtCues([row(0), row(5)], { title: "C", start: 0, end: 12 });
  check(
    "a bounded span closes its last cue at its own end",
    chapterCues[1].end === 12 && chapterCues[0].end === 5,
    `${chapterCues[0].end} / ${chapterCues[1].end}`
  );
  check(
    "a zero-length cue is never emitted",
    lib.buildSrtCues([row(10), row(10)], { title: "C", start: 10, end: 10 }).every((c) => c.end > c.start),
    JSON.stringify(lib.buildSrtCues([row(10), row(10)], { title: "C", start: 10, end: 10 }))
  );
  check(
    "unsorted rows are ordered by time, never reordered against the video",
    lib.buildSrtCues([row(12), row(0), row(5)], { title: "", start: 0, end: Infinity })
      .map((c) => c.start)
      .join(",") === "0,5,12",
    "cues came out unsorted"
  );
}

// =========================================================
// Scenario 5: cues -> a SubRip file
// =========================================================
{
  check("milliseconds are three digits with a comma", lib.srtTime(5.5) === "00:00:05,500", lib.srtTime(5.5));
  check("an hour is padded to two digits", lib.srtTime(3661.007) === "01:01:01,007", lib.srtTime(3661.007));

  const cues = [
    { start: 0, end: 2.5, text: "First line" },
    { start: 2.5, end: 4, text: "Second line" },
  ];
  const file = lib.srtText(cues);
  check(
    "the file is numbered from 1 with an arrow line between the times",
    file.startsWith("1\n00:00:00,000 --> 00:00:02,500\nFirst line\n\n2\n"),
    JSON.stringify(file.slice(0, 60))
  );
  check("...and ends with the blank line parsers expect", file.endsWith("Second line\n\n"), JSON.stringify(file.slice(-20)));
  check("...with nothing between a cue's lines but the newlines SubRip defines", !/[ \t]\n/.test(file), "a cue line carries trailing whitespace");
}

// =========================================================
// Scenario 6: the parts of a big export
// =========================================================
{
  // One word per cue, so the word ceiling is easy to reason about.
  const wrows = (n) => Array.from({ length: n }, (_, i) => ({ t: i * 5, txt: `w${i}` }));

  // Under the ceiling: one part, one file, and it is the whole span.
  {
    const rows = wrows(5);
    const parts = lib.buildSrtParts({ title: "", start: 0, end: Infinity }, rows, 100);
    check("a span under the ceiling is one part", parts.length === 1 && parts[0].total === 1, String(parts.length));
    check("...whose file holds every cue", parts[0].cueCount === 5, String(parts[0].cueCount));
    check("...and renumbers them from 1 within that file", parts[0].text.startsWith("1\n"), JSON.stringify(parts[0].text.slice(0, 10)));
  }

  // Over the ceiling: as few parts as the ceiling allows, sized evenly, and
  // every cue placed exactly once.
  {
    const rows = wrows(60);
    const ceiling = 25; // 60 words -> ceil(60/25) = 3 parts of ~20 words
    const parts = lib.buildSrtParts({ title: "C", start: 0, end: 600 }, rows, ceiling);
    check("an oversized export is split into the fewest parts the ceiling allows", parts.length === 3, String(parts.length));
    check(
      "the parts are numbered 1..N and know their total",
      parts.every((p, i) => p.n === i + 1 && p.total === 3),
      parts.map((p) => `${p.n}/${p.total}`).join(",")
    );
    check(
      "every part stays within the word ceiling",
      parts.every((p) => p.words <= ceiling),
      parts.map((p) => p.words).join(",")
    );
    const reassembled = parts.map((p) => p.cues).flat();
    check(
      "the parts are a lossless partition of the cues, in order",
      reassembled.length === 60 && reassembled.every((c, i) => c.text === `w${i}`),
      `${reassembled.length} cues`
    );
    check(
      "each part is a complete file of its own",
      parts.every((p, i) => p.text.startsWith("1\n") && p.text.includes(`-->`) && p.text === p.body),
      "a part is not a standalone file"
    );
    check(
      "...and no cue is cut in half",
      parts.map((p) => p.cues).flat().every((c) => /^w\d+$/.test(c.text)),
      "a cue came out split"
    );
  }

  // A single cue longer than the whole ceiling still gets a part of its own:
  // cutting a subtitle in half to satisfy a size limit would lose text.
  {
    const huge = { t: 0, txt: Array.from({ length: 40 }, (_, i) => `w${i}`).join(" ") };
    const parts = lib.buildSrtParts({ title: "", start: 0, end: Infinity }, [huge, ...wrows(3)], 10);
    check("a cue bigger than the ceiling lands whole in its own part", parts[0].cueCount === 1 && parts[0].words === 40, JSON.stringify(parts.map((p) => p.words)));
    check(
      "...and the rest of the cues are still all there",
      parts.map((p) => p.cueCount).reduce((a, b) => a + b, 0) === 4,
      parts.map((p) => p.cueCount).join(",")
    );
  }

  // The thresholds that ship: the SRT pair is its own, in words, and coherent
  // (a threshold above the ceiling would split files it still calls fine).
  check(
    "the SRT pair ships readable word numbers",
    Number.isFinite(SRT_CHUNK_THRESHOLD_WORDS) && Number.isFinite(SRT_CHUNK_MAX_WORDS),
    `${SRT_CHUNK_THRESHOLD_WORDS}/${SRT_CHUNK_MAX_WORDS}`
  );
  check(
    "the SRT threshold sits at or below its own ceiling",
    SRT_CHUNK_THRESHOLD_WORDS <= SRT_CHUNK_MAX_WORDS,
    `${SRT_CHUNK_THRESHOLD_WORDS} > ${SRT_CHUNK_MAX_WORDS}`
  );
  check(
    "the SRT numbers are not the clipboard character numbers",
    SRT_CHUNK_MAX_WORDS !== num("MAIN_CHUNK_MAX_CHARS") || SRT_CHUNK_MAX_WORDS !== num("CHAPTER_CHUNK_MAX_CHARS"),
    "the batchers were conflated"
  );
}

// =========================================================
// Scenario 7: the file names an export is saved under
// =========================================================
{
  const one = { n: 1, total: 1 };
  const two = { n: 2, total: 3 };
  check("a single file is named after the video", lib.srtFilename("A Video", one) === "A Video.srt", lib.srtFilename("A Video", one));
  check(
    "a split export says which part it is",
    lib.srtFilename("A Video", two) === "A Video - part 2 of 3.srt",
    lib.srtFilename("A Video", two)
  );
  check(
    "a name a file system cannot take is cleaned, not dropped",
    lib.srtFilename('Why: "this" / that?', one) === "Why this that.srt",
    lib.srtFilename('Why: "this" / that?', one)
  );
  check(
    "...trailing dots and spaces go too",
    lib.srtFilename("Trailing dots... .", one) === "Trailing dots.srt",
    lib.srtFilename("Trailing dots... .", one)
  );
  check(
    "an empty title still yields a usable name",
    lib.srtFilename("   ", one) === "transcript.srt",
    lib.srtFilename("   ", one)
  );
  check(
    "a very long title cannot produce a name the file system refuses",
    lib.srtFilename("x".repeat(400), one).length <= 84,
    String(lib.srtFilename("x".repeat(400), one).length)
  );
  check(
    "an Arabic title survives, unharmed and unmarked",
    lib.srtFilename("مقدمة الفيديو", one) === "مقدمة الفيديو.srt",
    lib.srtFilename("مقدمة الفيديو", one)
  );
}

console.log(failures === 0 ? "\nALL SRT / FORMAT TESTS PASSED" : `\n${failures} SRT / FORMAT TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
