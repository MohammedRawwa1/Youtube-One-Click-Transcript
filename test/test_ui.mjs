// Tests for the injected UI: the split main button with its action menu, and the
// settings bubble that hangs from the description's action row.
//
// These are the parts of the extension a unit test can still own without a
// browser: which element ends up where, which operation a menu item runs, and
// which settings key a control writes. Whether a panel lands on top of something
// it should not is a question of rendered boxes, and that is checked in a real
// browser by tools/check-badge-layout.mjs - this file is about the wiring.
//
// The DOM is a small stand-in (no jsdom): elements record their children,
// attributes, classes, style and listeners, so the real functions are driven
// through their own event handlers.
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
const str = (name) => (src.match(new RegExp(`const ${name} = "([^"]+)"`)) || [])[1];

let failures = 0;
function check(name, cond, detail) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  -> " + detail}`);
  if (!cond) failures++;
}

// =========================================================
// A DOM small enough to read
// =========================================================
let nodes = [];

const makeStyle = () => ({
  setProperty(k, v) {
    this[k] = String(v);
  },
  removeProperty(k) {
    delete this[k];
  },
});

// A very small selector matcher: class selectors, tag selectors (including the
// loose descendant form the anchor lookup uses) and simple [attr] / [attr=value]
// tests. That is all the injected UI asks the DOM for.
const attrMatch = (el, sel) => {
  const m = sel.match(/^([a-zA-Z-]*)\[([^=\]]+)(?:=['"]?([^'"\]]*)['"]?)?\]$/);
  if (!m) return false;
  const [, tag, attr, val] = m;
  if (tag && el.tagName !== tag.toUpperCase()) return false;
  const got = el.attrs[attr];
  return val === undefined ? got !== undefined : got === val;
};
const matchesOne = (el, sel) => {
  sel = sel.trim();
  if (!sel) return false;
  if (sel.startsWith(".")) return el.classList.contains(sel.slice(1));
  if (sel.includes("[")) return attrMatch(el, sel);
  const parts = sel.split(/\s+/);
  // A descendant selector is matched on its last part: enough to tell a button
  // from a div, which is all the anchor lookup needs.
  return el.tagName === parts[parts.length - 1].toUpperCase();
};
const matches = (el, sel) => String(sel).split(",").some((s) => matchesOne(el, s));

function makeEl(tag = "div") {
  // `className` and `classList` are one set: the injected code uses both (it
  // assigns className for the elements it builds and adds classes for the
  // states a session puts them in), and a selector would be wrong if they
  // disagreed.
  const classSet = new Set();
  const el = {
    tagName: String(tag).toUpperCase(),
    id: "",
    type: "",
    textContent: "",
    title: "",
    value: "",
    checked: false,
    name: "",
    disabled: false,
    children: [],
    attrs: {},
    handlers: {},
    style: makeStyle(),
    parentElement: null,
    _rect: { left: 100, top: 200, right: 300, bottom: 230, width: 200, height: 30 },
    offsetWidth: 300,
    offsetHeight: 180,
    classList: {
      _s: classSet,
      add(c) {
        classSet.add(c);
      },
      remove(c) {
        classSet.delete(c);
      },
      contains(c) {
        return classSet.has(c);
      },
    },
    setAttribute(k, v) {
      this.attrs[k] = String(v);
      if (k === "id") this.id = String(v);
      if (k === "class") this.className = String(v);
    },
    getAttribute(k) {
      return this.attrs[k] === undefined ? null : this.attrs[k];
    },
    addEventListener(kind, fn) {
      (this.handlers[kind] = this.handlers[kind] || []).push(fn);
    },
    removeEventListener(kind, fn) {
      this.handlers[kind] = (this.handlers[kind] || []).filter((f) => f !== fn);
    },
    contains(other) {
      if (other === this) return true;
      return this.children.some((c) => c.contains(other));
    },
    // Descendants, not just children: the settings rows are labels wrapping
    // their input, which is how the real DOM is asked for them.
    querySelectorAll(sel) {
      const out = [];
      const walk = (el) => {
        for (const child of el.children) {
          if (matches(child, sel)) out.push(child);
          walk(child);
        }
      };
      walk(this);
      return out;
    },
    querySelector(sel) {
      return this.querySelectorAll(sel)[0] || null;
    },
    getBoundingClientRect() {
      return this._rect;
    },
    append(...kids) {
      kids.forEach((k) => this.appendChild(k));
    },
    prepend(...kids) {
      kids.reverse().forEach((k) => {
        k.parentElement = this;
        this.children.unshift(k);
      });
    },
    appendChild(k) {
      k.parentElement = this;
      this.children.push(k);
      return k;
    },
    remove() {
      if (this.parentElement) {
        this.parentElement.children = this.parentElement.children.filter((c) => c !== this);
        this.parentElement = null;
      }
      nodes = nodes.filter((n) => n !== this);
    },
    click() {
      for (const fn of this.handlers.click || []) {
        fn({ preventDefault() {}, stopPropagation() {}, target: this });
      }
    },
    change() {
      for (const fn of this.handlers.change || []) fn({ target: this });
    },
  };
  Object.defineProperty(el, "className", {
    get: () => [...classSet].join(" "),
    set: (v) => {
      classSet.clear();
      String(v || "")
        .split(/\s+/)
        .filter(Boolean)
        .forEach((c) => classSet.add(c));
    },
    enumerable: true,
  });
  nodes.push(el);
  return el;
}

// The page as YouTube renders it: a body, the description's action row (holding
// YouTube's own transcript button and, beside it, the ⋮ menu), and the row the
// main button is injected into.
const body = makeEl("body");
const descriptionRow = makeEl("div");
const nativeTranscriptButton = makeEl("button");
nativeTranscriptButton.id = "description-transcript-button";
const dotsButton = makeEl("button");
dotsButton.classList.add("my-yt-dots");
dotsButton.setAttribute("aria-haspopup", "true");
descriptionRow.append(nativeTranscriptButton, dotsButton);
const topButtons = makeEl("div");
topButtons.id = "top-level-buttons-computed";
topButtons.append(makeEl("button"));

// The page's theme is read off <html> (the main button follows it inline).
const html = makeEl("html");
html.hasAttribute = () => false;
html.getAttribute = () => null;

const documentListeners = {};
const documentStub = {
  body,
  documentElement: html,
  getElementById(id) {
    return nodes.find((n) => n.id === id && n.parentElement) || null;
  },
  createElement: (tag) => makeEl(tag),
  querySelector(sel) {
    if (sel.includes("top-level-buttons-computed")) return topButtons;
    return null;
  },
  addEventListener(kind, fn) {
    (documentListeners[kind] = documentListeners[kind] || []).push(fn);
  },
  removeEventListener(kind, fn) {
    documentListeners[kind] = (documentListeners[kind] || []).filter((f) => f !== fn);
  },
};
const fireDocument = (kind, ev = {}) => {
  for (const fn of [...(documentListeners[kind] || [])]) fn(ev);
};
const listenerCount = () => Object.values(documentListeners).reduce((n, l) => n + l.length, 0);

const windowStub = {
  location: { pathname: "/watch" },
  innerWidth: 1400,
  innerHeight: 1000,
  addEventListener() {},
  removeEventListener() {},
};

// =========================================================
// The real code, with its collaborators supplied
// =========================================================
const uiSrc = extract("  const UI_STRINGS = {", "\n\n  const uiTables = new Map();");
const textSrc = extract(
  "  // =========================================================\n  // TRANSCRIPT TEXT (rows -> the text that leaves the extension)",
  "\n\n  // =========================================================\n  // FALLBACK: CAPTION SOURCES"
);
const menuSrc = extract(
  "  // =========================================================\n  // MAIN BUTTON INJECTION ENGINE",
  "  // Chapter entries can appear at any time"
);
check(
  "the UI code was extracted",
  menuSrc.includes("function injectButton") &&
    menuSrc.includes("function toggleMainMenu") &&
    menuSrc.includes("function toggleSettingsPopup"),
  `len=${menuSrc.length}`
);

// The label table with {placeholders} filled in, exactly as t() does.
const buildT = (lang = "en") => {
  const table = new Function(`${uiSrc}\n    return UI_STRINGS.${lang};`)();
  return (key, vars) => {
    const raw = typeof table[key] === "string" ? table[key] : key;
    if (!vars) return raw;
    return raw.replace(/\{(\w+)\}/g, (m, name) => (name in vars ? String(vars[name]) : m));
  };
};

const storage = {};
const localStorageStub = {
  getItem: (k) => (k in storage ? storage[k] : null),
  setItem: (k, v) => {
    storage[k] = String(v);
  },
  removeItem: (k) => {
    delete storage[k];
  },
};

// The text layer (where the settings live) over stub storage. Its constants are
// read out of the source, so a renamed key cannot leave these tests writing a
// preference the extension never reads.
const textLib = new Function(
  "localStorage",
  "videoTitle",
  "cleanSegmentText",
  `${textSrc}
    return { transcriptOptions, saveTranscriptOption, transcriptAction };`
)(localStorageStub, () => "A Video", (text) => String(text || "").replace(/\s+/g, " ").trim());

const calls = { handleClick: [], resetMainButton: [] };
// The anchor lookup is a function of what the page renders right now, so the
// test can take YouTube's transcript button away and put it back.
let nativeButton = nativeTranscriptButton;

const ui = new Function(
  "document",
  "window",
  "t",
  "handleClick",
  "resetMainButton",
  "chunkSession",
  "findNativeTranscriptButton",
  "transcriptOptions",
  "saveTranscriptOption",
  "transcriptAction",
  "setTimeout",
  "BUTTON_ID",
  "CARET_ID",
  "MENU_ID",
  "SPLIT_WRAP_ID",
  "SETTINGS_BTN_ID",
  "SETTINGS_POPUP_ID",
  "TEXT_TITLE_KEY",
  "TEXT_FORMAT_KEY",
  "TEXT_TIME_KEY",
  "TEXT_ACTION_KEY",
  "FORMAT_PARAGRAPH",
  "FORMAT_LINES",
  "TIME_BRACKET",
  "TIME_PLAIN",
  "TIME_PAREN",
  "ACTION_COPY",
  "ACTION_SRT",
  `${menuSrc}
   return {
     injectButton,
     toggleMainMenu,
     closeMainMenu,
     runMainAction,
     injectSettingsButton,
     toggleSettingsPopup,
     closeSettingsPopup,
     settingsAnchor,
     session: () => chunkSession,
     setSession: (s) => (chunkSession = s),
   };`
)(
  documentStub,
  windowStub,
  buildT(),
  (mode) => calls.handleClick.push(mode),
  (btn) => calls.resetMainButton.push(btn),
  null,
  () => nativeButton,
  textLib.transcriptOptions,
  textLib.saveTranscriptOption,
  textLib.transcriptAction,
  (fn) => {
    fn();
    return 0;
  },
  str("BUTTON_ID"),
  str("CARET_ID"),
  str("MENU_ID"),
  str("SPLIT_WRAP_ID"),
  str("SETTINGS_BTN_ID"),
  str("SETTINGS_POPUP_ID"),
  str("TEXT_TITLE_KEY"),
  str("TEXT_FORMAT_KEY"),
  str("TEXT_TIME_KEY"),
  str("TEXT_ACTION_KEY"),
  str("FORMAT_PARAGRAPH"),
  str("FORMAT_LINES"),
  str("TIME_BRACKET"),
  str("TIME_PLAIN"),
  str("TIME_PAREN"),
  str("ACTION_COPY"),
  str("ACTION_SRT")
);

const $ = (id) => documentStub.getElementById(id);
const $class = (el, cls) => el.querySelector(`.${cls}`);

// =========================================================
// Scenario 1: the split main button
// =========================================================
{
  ui.injectButton();
  const wrap = $("my-yt-transcript-split");
  const button = $(str("BUTTON_ID"));
  const caret = $(str("CARET_ID"));
  check("the main button is injected inside its own wrapper", !!wrap && !!button && button.parentElement === wrap, "no wrapper or button");
  check("the caret sits beside it, in the same wrapper", !!caret && caret.parentElement === wrap, "the caret is elsewhere");
  check("...and the pair is the page row's first child", topButtons.children[0] === wrap, topButtons.children.map((c) => c.id).join(","));
  check("the button keeps the label the page has always shown", button.textContent === "📜 Transcript", button.textContent);
  check("the caret is a caret, with the menu tooltip", caret.textContent === "▾" && caret.title === "More transcript actions", `${caret.textContent} / ${caret.title}`);
  check("...and says it opens a menu", caret.attrs["aria-haspopup"] === "true", JSON.stringify(caret.attrs));

  button.click();
  check("clicking the button runs the copy, with no mode of its own", calls.handleClick.join(",") === "copy", calls.handleClick.join(","));

  // Injecting again (the page re-renders on every tick) must not stack a second
  // control on top of the first.
  ui.injectButton();
  check(
    "a second injection is a no-op while the button is in place",
    topButtons.children.filter((c) => c.id === str("SPLIT_WRAP_ID")).length === 1,
    String(topButtons.children.length)
  );

  // The operation the button's own click runs is remembered across loads (it is
  // chosen in the caret menu), so an injected button has to come back labelled
  // for it - and doing it.
  storage[str("TEXT_ACTION_KEY")] = str("ACTION_SRT");
  $(str("SPLIT_WRAP_ID")).remove();
  ui.injectButton();
  const srtButton = $(str("BUTTON_ID"));
  check(
    "a remembered .srt action labels the injected button and marks it on the button",
    srtButton.textContent === "📜 Transcript · SRT" && srtButton.getAttribute("data-mode") === str("ACTION_SRT"),
    `${srtButton.textContent} / ${srtButton.getAttribute("data-mode")}`
  );
  calls.handleClick.length = 0;
  srtButton.click();
  check("...and its own click downloads the SRT", calls.handleClick.join(",") === str("ACTION_SRT"), calls.handleClick.join(","));

  storage[str("TEXT_ACTION_KEY")] = str("ACTION_COPY");
  $(str("SPLIT_WRAP_ID")).remove();
  ui.injectButton();
  check(
    "...while the default is a plain copy again",
    $(str("BUTTON_ID")).textContent === "📜 Transcript",
    $(str("BUTTON_ID")).textContent
  );
}

// =========================================================
// Scenario 2: the caret's action menu
// =========================================================
{
  const caret = $(str("CARET_ID"));
  caret.click();
  const menu = $(str("MENU_ID"));
  check("the caret opens the action menu", !!menu && menu.parentElement === documentStub.body, "no menu");
  check("...which is a menu, not a bare div", menu.attrs.role === "menu", JSON.stringify(menu.attrs));

  const items = menu.children;
  check("the menu offers both operations", items.length === 2, String(items.length));
  check(
    "the first item copies the transcript, marked as the button's current action",
    items[0].children[0].textContent === "✓ 📋 Copy transcript" && items[0].classList.contains("my-yt-menu-active"),
    JSON.stringify(items.map((i) => i.children.map((c) => c.textContent)))
  );
  check(
    "...and the other one is not marked",
    !items[1].classList.contains("my-yt-menu-active") && items[1].children[0].textContent === "⤓ Download .srt file",
    items[1].children[0].textContent
  );
  check(
    "the second downloads the subtitles, and says so",
    items[1].children.length === 2 &&
      items[1].children[0].textContent === "⤓ Download .srt file" &&
      items[1].children[1].textContent.length > 0,
    JSON.stringify(items[1].children.map((c) => c.textContent))
  );
  check(
    "the panel is positioned under the caret and inside the viewport",
    menu.style.top === "238px" && menu.style.left === "100px",
    JSON.stringify({ top: menu.style.top, left: menu.style.left })
  );

  calls.handleClick.length = 0;
  items[1].click();
  check("choosing the download runs the SRT operation", calls.handleClick.join(",") === "srt", calls.handleClick.join(","));
  check("...and closes the menu", !$(str("MENU_ID")), "the menu is still open");
  check("...and drops its document listeners with it", listenerCount() === 0, String(listenerCount()));

  calls.handleClick.length = 0;
  caret.click();
  $(str("MENU_ID")).children[0].click();
  check("choosing the copy runs the copy operation", calls.handleClick.join(",") === "copy", calls.handleClick.join(","));

  // Escape closes it too.
  caret.click();
  fireDocument("keydown", { key: "Escape" });
  check("Escape closes the menu", !$(str("MENU_ID")), "the menu is still open");

  // A click anywhere else closes it; a click inside it does not.
  caret.click();
  fireDocument("click", { target: makeEl("div") });
  check("a click outside closes the menu", !$(str("MENU_ID")), "the menu is still open");
  caret.click();
  fireDocument("click", { target: $(str("MENU_ID")) });
  check("...but a click inside it does not", !!$(str("MENU_ID")), "the menu closed on its own click");
  ui.closeMainMenu();

  // A live chunk session is abandoned when an action is chosen: the menu is a
  // new decision, never \"continue the sequence\".
  ui.setSession({ idx: 1, chunks: [{}, {}, {}], owner: null });
  calls.resetMainButton.length = 0;
  ui.runMainAction("copy");
  check("choosing an action abandons a live chunk session", ui.session() === null, JSON.stringify(ui.session()));
  check("...and puts the button back to idle", calls.resetMainButton.length === 1, String(calls.resetMainButton.length));
  check("...and runs the chosen operation", calls.handleClick.join(",") === "copy,copy", calls.handleClick.join(","));

  // Which item is the button's default is visible in the menu, and choosing the
  // other one changes it for good.
  caret.click();
  const marked = $(str("MENU_ID"));
  check(
    "the menu marks the operation the button's own click runs",
    marked.children[0].classList.contains("my-yt-menu-active") && marked.children[0].children[0].textContent.startsWith("✓ "),
    marked.children.map((c) => c.children[0].textContent).join(" | ")
  );
  check(
    "...and says so in words",
    marked.children[0].children[marked.children[0].children.length - 1].textContent === "This is what the Transcript button does now.",
    JSON.stringify(marked.children[0].children.map((c) => c.textContent))
  );
  marked.children[1].click();
  check("choosing the download remembers it", storage[str("TEXT_ACTION_KEY")] === str("ACTION_SRT"), JSON.stringify(storage));
  caret.click();
  check(
    "...so the mark moves to the download next time",
    $(str("MENU_ID")).children[1].classList.contains("my-yt-menu-active") &&
      !$(str("MENU_ID")).children[0].classList.contains("my-yt-menu-active"),
    "the mark did not move"
  );
  ui.closeMainMenu();
  calls.handleClick.length = 0;
  $(str("BUTTON_ID")).click();
  check("the button's own click now downloads the SRT", calls.handleClick.join(",") === str("ACTION_SRT"), calls.handleClick.join(","));

  // Back to the default for the rest of the file.
  storage[str("TEXT_ACTION_KEY")] = str("ACTION_COPY");
  $(str("BUTTON_ID")).setAttribute("data-mode", str("ACTION_COPY"));
}

// =========================================================
// Scenario 3: the settings bubble
// =========================================================
{
  ui.injectSettingsButton();
  const gear = $(str("SETTINGS_BTN_ID"));
  check("a settings button is added to the description's action row", !!gear && gear.parentElement === descriptionRow, "no settings button");
  check("...beside YouTube's own transcript button and ⋮ menu", descriptionRow.children.length === 3, String(descriptionRow.children.length));
  check("...and it says what it opens", gear.title === "Transcript settings (title line, format, timestamps)", gear.title);

  gear.click();
  const popup = $(str("SETTINGS_POPUP_ID"));
  check("the gear opens the settings bubble", !!popup && popup.parentElement === documentStub.body, "no bubble");
  check("...labelled as a dialog", popup.attrs.role === "dialog" && popup.attrs["aria-label"] === "Transcript settings", JSON.stringify(popup.attrs));

  const head = popup.children[0];
  check(
    "the bubble has a title and a close button",
    head.children[0].textContent === "Transcript settings" && head.children[1].textContent === "✕",
    JSON.stringify(head.children.map((c) => c.textContent))
  );

  // The title checkbox, the two choice groups (the format and the timestamp
  // style) and the note explaining that a .srt download has its own timestamps.
  const titleRow = popup.children[1];
  const titleBox = titleRow.children[0];
  check("the title line is a checkbox", titleBox.tagName === "INPUT" && titleBox.type === "checkbox", `${titleBox.tagName}/${titleBox.type}`);
  check("...unchecked by default", titleBox.checked === false, String(titleBox.checked));
  const groups = popup.querySelectorAll(".my-yt-bubble-group");
  check("the bubble offers two groups of choices", groups.length === 2, String(groups.length));
  const formatGroup = groups[0];
  const timeGroup = groups[1];
  const paragraphRadio = formatGroup.children[1].children[0];
  const linesRadio = formatGroup.children[2].children[0];
  check(
    "the format is offered as two choices, never both at once",
    formatGroup.querySelectorAll("input").length === 2 &&
      formatGroup.querySelectorAll("input").every((i) => i.type === "radio"),
    "the format group is not two radios"
  );
  check(
    "...the plain paragraph selected by default",
    paragraphRadio.checked === true && linesRadio.checked === false,
    JSON.stringify({ paragraph: paragraphRadio.checked, lines: linesRadio.checked })
  );
  check(
    "...the two choices share a name, so the browser keeps them exclusive",
    paragraphRadio.name === linesRadio.name && paragraphRadio.name === "ytxt-format",
    `${paragraphRadio.name}/${linesRadio.name}`
  );
  check(
    "...and each one says what it does",
    formatGroup.children[1].children[1].textContent === "Format as a single paragraph (no timestamps)" &&
      formatGroup.children[2].children[1].textContent === "Include timestamps (line-by-line)",
    JSON.stringify(formatGroup.children.map((c) => (c.children[1] || {}).textContent))
  );
  // The timestamp style, the setting that decides how a line of the
  // line-by-line format is decorated.
  const timeRadios = timeGroup.querySelectorAll("input");
  check(
    "the timestamp style is a group of three choices",
    timeRadios.length === 3 && timeRadios.every((i) => i.type === "radio" && i.name === "ytxt-time"),
    JSON.stringify(timeRadios.map((i) => `${i.value}/${i.type}/${i.name}`))
  );
  check(
    "...spelled out as examples, so the difference is visible",
    timeGroup.children[1].children[1].textContent === "[0:05] Segment text" &&
      timeGroup.children[2].children[1].textContent === "0:05 Segment text" &&
      timeGroup.children[3].children[1].textContent === "(0:05) Segment text",
    JSON.stringify(timeGroup.children.map((c) => (c.children[1] || {}).textContent))
  );
  check(
    "...with the bracketed style selected by default",
    timeRadios[0].checked === true && timeRadios[1].checked === false && timeRadios[2].checked === false,
    JSON.stringify(timeRadios.map((i) => i.checked))
  );
  check(
    "...and a title that says which format it applies to",
    timeGroup.children[0].textContent === "Timestamp style (line-by-line)",
    timeGroup.children[0].textContent
  );

  const note = popup.querySelector(".my-yt-bubble-note");
  check("...and the SRT note tells the user where the title goes", /file name/.test(note.textContent), note.textContent);
  check(
    "the bubble opens ABOVE the row it hangs from",
    popup.style.top === "12px",
    JSON.stringify({ top: popup.style.top, left: popup.style.left })
  );

  // Toggling a control writes the preference the copy reads.
  titleBox.checked = true;
  titleBox.change();
  check("ticking the title box stores the preference", storage[str("TEXT_TITLE_KEY")] === "1", JSON.stringify(storage));
  linesRadio.checked = true;
  linesRadio.change();
  check("choosing the timestamped format stores it", storage[str("TEXT_FORMAT_KEY")] === str("FORMAT_LINES"), JSON.stringify(storage));
  const parenRadio = timeGroup.children[3].children[0];
  parenRadio.checked = true;
  parenRadio.change();
  check(
    "choosing a timestamp style stores it",
    storage[str("TEXT_TIME_KEY")] === str("TIME_PAREN"),
    JSON.stringify(storage)
  );
  check(
    "...and the copy really renders lines that way",
    textLib.transcriptOptions().time === str("TIME_PAREN"),
    JSON.stringify(textLib.transcriptOptions())
  );
  check(
    "...and the copy really sees it",
    textLib.transcriptOptions().format === "lines" && textLib.transcriptOptions().header === "A Video",
    JSON.stringify(textLib.transcriptOptions())
  );
  paragraphRadio.checked = true;
  paragraphRadio.change();
  check("choosing the paragraph again stores that instead", storage[str("TEXT_FORMAT_KEY")] === str("FORMAT_PARAGRAPH"), JSON.stringify(storage));

  // Re-opening shows what is stored, not the defaults.
  ui.closeSettingsPopup();
  check("the close button's handler removes the bubble", !$(str("SETTINGS_POPUP_ID")), "the bubble is still open");
  gear.click();
  const reopened = $(str("SETTINGS_POPUP_ID"));
  const reopenedGroups = reopened.querySelectorAll(".my-yt-bubble-group");
  check(
    "re-opening the bubble shows the saved state",
    reopened.children[1].children[0].checked === true &&
      reopenedGroups[0].children[1].children[0].checked === true &&
      reopenedGroups[0].children[2].children[0].checked === false,
    JSON.stringify(reopened.children.map((c) => (c.children[0] || {}).checked))
  );
  check(
    "...including the timestamp style, which is remembered while it is not in use",
    reopenedGroups[1].children[3].children[0].checked === true && reopenedGroups[1].children[1].children[0].checked === false,
    JSON.stringify(reopenedGroups[1].children.map((c) => (c.children[0] || {}).checked))
  );
  fireDocument("keydown", { key: "Escape" });
  check("Escape closes the settings bubble too", !$(str("SETTINGS_POPUP_ID")), "the bubble is still open");
  check("...and its listeners go with it", listenerCount() === 0, String(listenerCount()));

  // The gear toggles: a second click on an open bubble closes it.
  gear.click();
  gear.click();
  check("clicking the gear again closes the bubble", !$(str("SETTINGS_POPUP_ID")), "the bubble is still open");

  check(
    "the bubble hangs from the row YouTube's own transcript button lives in",
    ui.settingsAnchor() !== null && ui.settingsAnchor().row === descriptionRow,
    JSON.stringify(Object.keys(ui.settingsAnchor() || {}))
  );

  // A page with no transcript button at all (a video without captions, or a
  // layout that has not rendered yet) simply gets no settings button.
  ui.closeSettingsPopup();
  gear.remove();
  nativeButton = null;
  ui.injectSettingsButton();
  check("a page without a transcript button gets no settings button", !$(str("SETTINGS_BTN_ID")), "a settings button appeared with nothing to hang from");
  nativeButton = nativeTranscriptButton;
  ui.injectSettingsButton();
  check("...and it comes back when the page renders one again", !!$(str("SETTINGS_BTN_ID")), "the settings button did not return");
  check(
    "...without stacking a second one on the row",
    descriptionRow.children.filter((c) => c.id === str("SETTINGS_BTN_ID")).length === 1,
    String(descriptionRow.children.length)
  );
}

console.log(failures === 0 ? "\nUI TESTS PASSED" : `\n${failures} UI TEST(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);
