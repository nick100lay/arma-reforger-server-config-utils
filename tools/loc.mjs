#!/usr/bin/env node
// Read Arma Reforger localization tables (Language/*.conf): resolve `#AR-...` keys, list, search,
// compare two languages, and check a table for the mistakes the game accepts silently.
//
//   node tools/loc.mjs info  <source>... [--lenient] [--json]
//   node tools/loc.mjs get   <source> <id|#id>... [--raw] [--missing-ok] [--json]
//   node tools/loc.mjs list  <source>... [--limit N|0] [--all] [--raw] [--lenient] [--json]
//   node tools/loc.mjs find  <source>... <query> [--in id|text|both] [--regex]
//                            [--limit N|0] [--all] [--raw] [--lenient] [--json]
//   node tools/loc.mjs diff  <sourceA> <sourceB> [--limit N|0] [--all] [--json]
//   node tools/loc.mjs check <source>... [--lenient] [--json]
//
// A **source** is a `.conf` file on disk, or one entry inside a `.pak`, written `<pak>:<entry>`:
//
//   node tools/loc.mjs get \
//     "/…/addons/data/data007.pak:Language/localization.ru_ru.conf" \
//     "#AR-Campaign_MapLocation_Cain_Kamensk"
//
// The split is at the last colon and only when what precedes it ends in `.pak`, so a Windows path
// stays a path; `--no-pak-path-split` turns it off entirely. A directory is not a source.
//
// Also usable as a library:
//
//   import { parseStringTable, openStringTables, MergedStringTable, languageOfName } from "./loc.mjs";
//   const table = parseStringTable(bytes, { name: "en_us" });   // StringTable
//   table.get("AR-MapIcon_Tower");                              // "Tower"
//   table.resolve("#AR-MapIcon_Tower");                         // { key, id, found, text, raw, at }
//   const merged = new MergedStringTable(openStringTables([modSpec, vanillaSpec]));
//   merged.get("AR-MapIcon_Tower");                             // the mod's text, if it overrides
//   readStringTables([a, b], { lenient: true });                // { parts, failures }
//
// ---------------------------------------------------------------------------
// The format, as measured on the installed 1.8.0.13 client and its 240 .pak files
// (584 localization entries: the 13 vanilla languages and the workshop addons' own, 573 of them
// with the `Ids`/`Texts` pair, 11 an empty `StringTableRuntime { }`, and 583 of the 584 readable —
// the one that is not carries an unterminated `\"` and is refused with its line and column):
//
//   StringTableRuntime {
//    Ids {
//     "AR-Account_Authenticating"
//     …
//    }
//    Texts {
//     "Authenticating"
//     …
//    }
//   }
//
// `Ids` and `Texts` are parallel arrays: entry *k* of one is entry *k* of the other, and nothing
// else links them. Three consequences decide this reader:
//
//  * **A text may be split into several physical strings**, each but the last followed by a lone
//    `\` — a continuation marker *outside* the quotes. Joining them is what makes the two arrays
//    the same length: 265 529 ids are written as 291 119 physical strings over the whole corpus,
//    and the vanilla `en_us` table alone holds 18 097 strings for its 16 217 ids (196 of its texts
//    are split, one of them into 640 pieces). A reader that counts quoted strings and stops there
//    reports a mismatch the file does not have; one that stops at the first `\` loses text.
//  * **An escaped quote is written double-escaped**, `\\"`, not `\"` — in 15 of the 584 files.
//    Reading that classically ends the string inside the BBCode tag it belongs to; the vanilla
//    `en_us` entry is `… <color rgba=\\"226,168,79,255\\">Player List</color> …`, so the reader
//    consumes one backslash and reads the quote as an escaped quote.
//  * **Escapes are not JSON.** `\n`, `\t`, `\r`, `\"` and `\\` are decoded; any other `\X` is kept
//    verbatim, which is what keeps the literal `\u1f600` in some `<ucs codepoints=…/>` tags intact
//    instead of turning it into a code point.
//
// No file in the corpus carries a `Languages { … }` block, so a table in that shape is refused by
// name rather than misread. `--json` everywhere, and exit codes 0/1/2/3 that mean what they mean in
// `etconf`: success, the input at fault, the command line at fault, a `get` id that is missing.
import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import { openPak, findEntry, parseSourceSpec } from "./pak.mjs";

export const MAGIC = "StringTableRuntime";

/** The two blocks a table is made of. Any other name is a shape this reader does not know. */
export const KNOWN_BLOCKS = ["Ids", "Texts"];

/** Escapes the writer emits. Every other `\X` is kept verbatim — see the header. */
const ESCAPES = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };

const BOM = 0xfeff;

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

/** A file that is not a string table, reported with the line and column it gave itself away. */
export class StringTableError extends Error {
  constructor(name, message, text, at) {
    const { line, column } = lineColumn(text, at);
    super(`${name}: ${message} (line ${line}, column ${column})`);
    this.name = "StringTableError";
    /** The source the file was read as, so a caller can say which one failed. */
    this.source = name;
    this.line = line;
    this.column = column;
  }
}

function lineColumn(text, at) {
  let line = 1;
  let start = 0;
  for (let i = 0; i < at && i < text.length; i++) {
    if (text[i] === "\n") {
      line++;
      start = i + 1;
    }
  }
  return { line, column: at - start + 1 };
}

/**
 * Line numbers for many offsets in one pass, probed by binary search.
 *
 * `lineColumn` scans from the start of the file, which is right for one error message and wrong
 * for every entry: asking it for each of the vanilla `en_us` table's 16 217 ids made the parse
 * O(n²) — **9.6 s** for a 1.5 MB file, and 10 s for any command that touched it, which reads as a
 * hung tool. One pass over the newlines and a binary search per lookup: 9 ms, the index costs
 * nothing next to the scan itself.
 */
function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (at) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

const describeChar = (c) =>
  c === undefined ? "the end of the file" : c === "\n" ? "a line break" : c === "\r" ? "a carriage return" : `"${c}"`;

/**
 * The token scanner: `StringTableRuntime { <block> { <string>… } … }`.
 *
 * It returns the blocks in file order with each string's raw and decoded form, and throws — never
 * guesses — on anything else. `strict` is not an option: a table that does not tile is a table this
 * reader does not understand, and a plausible half-answer is worse than an error.
 */
function scanBlocks(text, name) {
  let i = 0;
  const fail = (message, at = i) => {
    throw new StringTableError(name, message, text, at);
  };
  const atEnd = () => i >= text.length;
  const skipWhitespace = () => {
    while (!atEnd() && /\s/.test(text[i])) i++;
  };

  const readName = () => {
    const from = i;
    while (!atEnd() && /[A-Za-z0-9_]/.test(text[i])) i++;
    if (i === from) fail(`expected a name, found ${describeChar(text[i])}`, from);
    return text.slice(from, i);
  };

  const expect = (ch) => {
    if (text[i] !== ch) fail(`expected "${ch}", found ${describeChar(text[i])}`);
    i++;
  };

  const readString = () => {
    const start = i;
    expect('"');
    let raw = "";
    let value = "";
    for (;;) {
      if (atEnd()) fail("unterminated string: the file ends before the closing quote", start);
      const c = text[i];
      if (c === '"') {
        i++;
        break;
      }
      if (c === "\\") {
        const next = text[i + 1];
        if (next === undefined) fail("unterminated escape sequence", i);
        // The writer double-escapes an escaped quote: the bytes are `\` `\` `"`. Consume one
        // backslash so the pair that follows is read as `\"`, which is what it means.
        if (next === "\\" && text[i + 2] === '"') {
          raw += "\\";
          value += "\\";
          i += 1;
          continue;
        }
        raw += "\\" + next;
        value += Object.hasOwn(ESCAPES, next) ? ESCAPES[next] : "\\" + next;
        i += 2;
        continue;
      }
      raw += c;
      value += c;
      i++;
    }
    // A `\` after the closing quote marks a continuation: the same text continues in the next
    // string. It sits *outside* the quotes, which is why counting quoted strings misses it.
    let continued = false;
    const afterQuote = i;
    while (!atEnd() && (text[i] === " " || text[i] === "\t")) i++;
    if (text[i] === "\\") {
      continued = true;
      i++;
    } else i = afterQuote;
    return { at: start, raw, value, continued };
  };

  const readBlock = () => {
    const strings = [];
    let last = null;
    for (;;) {
      skipWhitespace();
      if (atEnd()) fail("unterminated block: the file ends before its closing brace");
      if (text[i] === "}") {
        i++;
        return strings;
      }
      if (text[i] !== '"') {
        // The usual cause is a string whose closing quote was left out, or written as an escape:
        // it swallows the rest of its line, ends at the next `"` on the following one, and leaves
        // bare text behind. Saying so turns "found \"С\"" into something a reader can act on.
        const hint =
          last && last.value.includes("\n")
            ? ` — the string that starts at line ${lineColumn(text, last.at).line} runs across a line break,` +
              ` which the writer never does: its closing quote is missing or written as an escape`
            : "";
        fail(`expected a quoted string or "}", found ${describeChar(text[i])}${hint}`);
      }
      last = readString();
      strings.push(last);
    }
  };

  if (text.charCodeAt(0) === BOM) i = 1;
  skipWhitespace();
  const magicAt = i;
  const magic = readName();
  if (magic !== MAGIC) {
    fail(`expected "${MAGIC}", found "${magic}" — this is not a string table`, magicAt);
  }
  skipWhitespace();
  expect("{");

  const blocks = [];
  for (;;) {
    skipWhitespace();
    if (atEnd()) fail("unterminated StringTableRuntime: the file ends before its closing brace");
    if (text[i] === "}") {
      i++;
      break;
    }
    const at = i;
    const blockName = readName();
    skipWhitespace();
    expect("{");
    blocks.push({ name: blockName, at, strings: readBlock() });
  }

  skipWhitespace();
  if (!atEnd()) fail("unexpected content after the closing brace");
  return blocks;
}

/** Join the physical strings a continuation marker splits, reporting one that dangles. */
function joinContinuations(strings, name, blockName, text, problems) {
  const out = [];
  let current = null;
  for (const s of strings) {
    if (current === null) current = { at: s.at, raw: s.raw, value: s.value, pieces: 1 };
    else {
      current.raw += s.raw;
      current.value += s.value;
      current.pieces++;
    }
    if (!s.continued) {
      out.push(current);
      current = null;
    }
  }
  if (current !== null) {
    problems.push({
      severity: "error",
      message:
        `the last string of the "${blockName}" block ends with a continuation marker and nothing follows it` +
        ` (line ${lineColumn(text, current.at).line})`,
    });
    out.push(current);
  }
  return out;
}

/** `true` for a buffer-ish input, so `parseStringTable` can tell bytes from text. */
const isBytes = (input) => input instanceof Uint8Array;

/**
 * Parse a string table.
 *
 * `input` is the file's bytes (a `Buffer`/`Uint8Array`) or the file's text (a `string`). A path is
 * **not** accepted here — `readStringTable(path)` does that, so text and bytes can never be
 * confused with a file name.
 *
 * Throws `StringTableError` for a file that is not an `Ids`/`Texts` pair. Returns a `StringTable`
 * whose `problems` list the defects the game tolerates (a duplicate id, an empty text). The
 * language is taken from `language`, or — when that is not given — from a `…<lang>.conf` file name.
 */
export function parseStringTable(input, { name = "<buffer>", language = null } = {}) {
  language = language ?? languageOfName(name);
  let text;
  let bytes = null;
  if (typeof input === "string") text = input;
  else if (isBytes(input)) {
    bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    text = new TextDecoder("utf-8").decode(bytes);
  } else {
    throw new TypeError(`parseStringTable needs a string, a Buffer or a Uint8Array, not ${typeof input}`);
  }

  const problems = [];
  const blocks = scanBlocks(text, name);

  const byName = new Map();
  for (const block of blocks) {
    if (byName.has(block.name)) {
      throw new StringTableError(name, `block "${block.name}" appears twice`, text, block.at);
    }
    if (!KNOWN_BLOCKS.includes(block.name)) {
      throw new StringTableError(
        name,
        `unknown block "${block.name}" — this reader knows the "Ids"/"Texts" pair a StringTableRuntime is made of; ` +
          `a table in another shape (a "Languages" block, for instance) is refused rather than misread`,
        text,
        block.at,
      );
    }
    byName.set(block.name, block);
  }

  if (byName.size === 0) {
    // `StringTableRuntime { }` is a real thing: 11 of the 584 installed files are exactly this.
    return new StringTable([], { name, language, problems, bytes: bytes?.length ?? Buffer.byteLength(text) });
  }
  for (const required of KNOWN_BLOCKS) {
    if (!byName.has(required)) {
      throw new StringTableError(
        name,
        `no "${required}" block — a table needs both "Ids" and "Texts"; found ${[...byName.keys()].map((b) => `"${b}"`).join(", ")}`,
        text,
        0,
      );
    }
  }

  const lineAt = lineIndex(text);
  const ids = joinContinuations(byName.get("Ids").strings, name, "Ids", text, problems);
  const texts = joinContinuations(byName.get("Texts").strings, name, "Texts", text, problems);
  if (ids.length !== texts.length) {
    throw new StringTableError(
      name,
      `"Ids" holds ${ids.length} entries but "Texts" holds ${texts.length}: the two are parallel, so the file cannot be read by position`,
      text,
      byName.get(texts.length < ids.length ? "Ids" : "Texts").at,
    );
  }

  const entries = ids.map((id, k) => ({
    id: id.value,
    text: texts[k].value,
    raw: texts[k].raw,
    at: id.at,
    line: lineAt(id.at),
    pieces: texts[k].pieces,
  }));

  const firstSeen = new Map();
  for (const e of entries) {
    if (e.id === "") {
      problems.push({ severity: "error", message: `an empty id at line ${e.line}` });
      continue;
    }
    if (e.id !== e.id.trim()) {
      problems.push({ severity: "warning", message: `id ${JSON.stringify(e.id)} has surrounding whitespace (line ${e.line})` });
    }
    if (e.text === "") {
      problems.push({ severity: "warning", message: `id "${e.id}" has an empty text (line ${e.line})` });
    }
    if (e.text.includes("\uFFFD")) {
      problems.push({
        severity: "warning",
        message: `id "${e.id}" contains U+FFFD, so the bytes are not valid UTF-8 (line ${e.line})`,
      });
    }
    if (firstSeen.has(e.id)) {
      problems.push({
        severity: "error",
        message: `duplicate id "${e.id}" at line ${e.line}, already defined at line ${firstSeen.get(e.id)}`,
      });
    } else firstSeen.set(e.id, e.line);
  }

  return new StringTable(entries, { name, language, problems, bytes: bytes?.length ?? Buffer.byteLength(text) });
}

/** Read one `.conf` file from disk. */
export function readStringTable(path, { name = path, language = languageOfName(path) } = {}) {
  return parseStringTable(readFileSync(path), { name, language });
}

/**
 * The language a file name declares: `localization.ru_ru.conf` and `ACE_Core_localization.ru_ru.conf`
 * both give `ru_ru`; a name without a language tag gives `null` rather than a guess.
 */
export function languageOfName(name) {
  const base = String(name).replace(/\\/g, "/").split("/").pop() ?? "";
  const m = /(?:^|\.)([a-z]{2}_[a-z]{2})$/i.exec(base.replace(/\.conf$/i, ""));
  return m ? m[1].toLowerCase() : null;
}

// ---------------------------------------------------------------------------
// The table
// ---------------------------------------------------------------------------

/** One localization table: the `Ids`/`Texts` pair of a single source. */
export class StringTable {
  constructor(entries, { name = "<buffer>", language = null, problems = [], bytes = null } = {}) {
    this.entries = entries;
    /** File name or `<pak>:<entry>`, whatever the caller called it. */
    this.name = name;
    /** `ru_ru` when the file name says so, otherwise `null`. */
    this.language = language;
    /** Defects the game tolerates, plus the ones that cannot be: `{ severity, message }`. */
    this.problems = problems;
    this.bytes = bytes;
    /** First occurrence wins: the file is read by position, and a duplicate is already a problem. */
    this.index = new Map();
    for (const e of entries) if (!this.index.has(e.id)) this.index.set(e.id, e);
  }

  get size() {
    return this.entries.length;
  }

  ids() {
    return this.entries.map((e) => e.id);
  }

  has(id) {
    return this.index.has(id);
  }

  /** The whole entry — `{ id, text, raw, at, line }` — or `null`. */
  entry(id) {
    return this.index.get(id) ?? null;
  }

  /** The decoded text, or `null` when the id is not in this table. */
  get(id) {
    return this.index.get(id)?.text ?? null;
  }

  /** The text exactly as the file spells it, escapes and all. */
  raw(id) {
    return this.index.get(id)?.raw ?? null;
  }

  /**
   * Resolve a key as it appears in a `.conf`: `#AR-MapIcon_Tower` and `AR-MapIcon_Tower` are the
   * same key. The `#` is the game's marker for "this is a string-table id", not part of it.
   */
  resolve(key) {
    const wanted = String(key);
    const id = wanted.replace(/^#/, "");
    const entry = this.entry(id);
    return {
      key: wanted,
      id,
      found: entry !== null,
      text: entry?.text ?? null,
      raw: entry?.raw ?? null,
      line: entry?.line ?? null,
    };
  }

  find(query, { regex = false, in: where = "both", limit = Infinity } = {}) {
    const re = regex ? new RegExp(query, "i") : null;
    const needle = String(query).toLowerCase();
    const matches = (s) => (re ? re.test(s) : s.toLowerCase().includes(needle));
    const hits = [];
    for (const e of this.entries) {
      const hit = (where !== "text" && matches(e.id)) || (where !== "id" && matches(e.text));
      if (!hit) continue;
      hits.push({ id: e.id, text: e.text, raw: e.raw, line: e.line, source: 0 });
      if (hits.length >= limit) break;
    }
    return hits;
  }
}

/**
 * Several tables read as one dictionary, in command-line order.
 *
 * The order is the **override order**: a mod is mounted after the base game, so the mod's file is
 * listed first and its text wins — the same rule `ebin.mjs --rdb` uses for resource GUIDs. Every id
 * keeps all its variants, so an override is visible rather than silent.
 */
export class MergedStringTable {
  constructor(parts) {
    /** `[{ source, table }]`, in override order. */
    this.parts = parts;
  }

  /** `[{ index, kind, display, pak, entry, path, language, entries, bytes, problems }]`. */
  get sources() {
    return this.parts.map((p) => p.source);
  }

  ids() {
    const seen = new Set();
    for (const p of this.parts) for (const e of p.table.entries) seen.add(e.id);
    return [...seen];
  }

  get size() {
    return this.ids().length;
  }

  /** `{ id, text, source, variants: [{ text, raw, source }] }`, first source winning, or `null`. */
  lookup(id) {
    const variants = [];
    for (const p of this.parts) {
      const entry = p.table.entry(id);
      // `source` is the source's own `index` (its place on the command line), not its position in
      // `parts` — a `--lenient` run skips a source, and the two stop agreeing.
      if (entry) variants.push({ text: entry.text, raw: entry.raw, source: p.source.index });
    }
    if (!variants.length) return null;
    return { id, text: variants[0].text, raw: variants[0].raw, source: variants[0].source, variants };
  }

  has(id) {
    return this.lookup(id) !== null;
  }

  get(id) {
    return this.lookup(id)?.text ?? null;
  }

  resolve(key) {
    const wanted = String(key);
    const id = wanted.replace(/^#/, "");
    const hit = this.lookup(id);
    return {
      key: wanted,
      id,
      found: hit !== null,
      text: hit?.text ?? null,
      raw: hit?.raw ?? null,
      source: hit?.source ?? null,
      variants: hit?.variants ?? [],
    };
  }

  /** Every id once, in first-seen order, as lookup rows. */
  entries() {
    return this.ids().map((id) => this.lookup(id));
  }

  find(query, { regex = false, in: where = "both", limit = Infinity } = {}) {
    const re = regex ? new RegExp(query, "i") : null;
    const needle = String(query).toLowerCase();
    const matches = (s) => (re ? re.test(s) : s.toLowerCase().includes(needle));
    const hits = [];
    for (const row of this.entries()) {
      const hit = (where !== "text" && matches(row.id)) || (where !== "id" && matches(row.text));
      if (!hit) continue;
      hits.push({ id: row.id, text: row.text, raw: row.raw, source: row.source, variants: row.variants });
      if (hits.length >= limit) break;
    }
    return hits;
  }

  /** Ids named by more than one source. */
  overrides() {
    return this.entries().filter((e) => e.variants.length > 1);
  }

  /** The subset of `overrides()` where the sources do not agree — a real difference, not a copy. */
  conflicts() {
    return this.overrides().filter((e) => e.variants.some((v) => v.text !== e.text));
  }

  /** `{ source, severity, message }`: each source's own defects, then the cross-source conflicts. */
  problems() {
    const out = [];
    for (const s of this.sources) {
      for (const p of s.problems) out.push({ source: s.index, display: s.display, severity: p.severity, message: p.message });
    }
    // By `index`, not by position: a `--lenient` run leaves holes in the numbering.
    const byIndex = new Map(this.sources.map((s) => [s.index, s]));
    for (const c of this.conflicts()) {
      out.push({
        source: c.source,
        display: byIndex.get(c.source).display,
        severity: "warning",
        message:
          `id "${c.id}" is given different text by ${c.variants.length} sources; ` +
          `the first wins ("${c.variants[0].text}"), ` +
          c.variants
            .slice(1)
            .map((v) => `${byIndex.get(v.source).display}`)
            .join(", ") +
          ` differs`,
      });
    }
    return out;
  }
}

/** Two tables compared by id: what one has and the other lacks, and where the texts differ. */
export function compareStringTables(a, b) {
  const aIds = new Set(a.ids());
  const bIds = new Set(b.ids());
  const onlyInA = [];
  const onlyInB = [];
  const differing = [];
  let same = 0;
  for (const id of aIds) {
    if (!bIds.has(id)) onlyInA.push(id);
    else if (a.get(id) === b.get(id)) same++;
    else differing.push({ id, a: a.get(id), b: b.get(id) });
  }
  for (const id of bIds) if (!aIds.has(id)) onlyInB.push(id);
  return { onlyInA, onlyInB, differing, same };
}

// ---------------------------------------------------------------------------
// Sources: a file, or one entry of a .pak
// ---------------------------------------------------------------------------

/**
 * A source as the command line writes it.
 *
 * `<pak>:<entry>` names one entry inside a `.pak`; anything else is a path on disk. The rule lives
 * in `pak.mjs` — every reader that accepts a `.pak` entry needs the same one, and a second copy is
 * how the two drift apart — and is re-exported here so `loc.mjs` stays a single import for callers.
 */
export { parseSourceSpec };

/**
 * Read every source, in the order given, opening each `.pak` once.
 *
 * Returns `[{ source, table }]` — ready for `new MergedStringTable(...)` — and ends the run on the
 * first source it cannot read. `readStringTables` is the same read that can carry on instead.
 * Paks are closed before returning: the tables are already in memory, so no handle outlives the
 * call.
 */
export function openStringTables(specs, options = {}) {
  return readStringTables(specs, options).parts;
}

/**
 * Read every source, and say which ones could not be read.
 *
 * With `lenient`, a source that cannot be read or parsed is returned in `failures` —
 * `{ code, message, source?, line?, column? }`, the same object `--json` reports a run failure
 * with — instead of ending the run: `check` is the command that answers "are these tables sound?",
 * and a single unterminated table in a folder of them (the corpus has exactly one) used to hide
 * the other 583. Without it the first bad source throws, which is what a command reading one
 * source wants.
 *
 * `source.index` is the source's position on the command line, so a lenient run still says which
 * argument a row came from; `failures` refers to a source by name, because it has no row.
 */
export function readStringTables(specs, { noPakPathSplit = false, lenient = false } = {}) {
  const parsed = specs.map((spec) => parseSourceSpec(spec, { noPakPathSplit }));
  const paks = new Map();
  const parts = [];
  const failures = [];
  try {
    parsed.forEach((spec, index) => {
      try {
        parts.push(readOneSource(spec, index, paks));
      } catch (err) {
        if (!lenient) throw err;
        failures.push(errorObject(err));
      }
    });
    return { parts, failures };
  } finally {
    for (const pak of paks.values()) pak.close();
  }
}

/** One source: its bytes, its table, and the row the answer describes it by. */
function readOneSource(spec, index, paks) {
  let bytes;
  if (spec.kind === "pak") {
    const key = resolvePath(spec.pak).toLowerCase();
    let pak = paks.get(key);
    if (!pak) {
      pak = openPak(spec.pak);
      paks.set(key, pak);
    }
    bytes = pak.read(findEntry(pak, spec.entry));
  } else {
    try {
      bytes = readFileSync(spec.path);
    } catch (err) {
      // `!` is what an earlier cut of this tool used, so name the rule instead of reporting a
      // missing file whose name contains a bang.
      if (err.code === "ENOENT" && spec.path.includes("!")) {
        throw new Error(`${spec.path}: no such file — the pak/entry separator is ":", not "!": write <pak>:<entry>`);
      }
      // A directory is the first thing anyone tries for "check every table in this folder", and
      // Node's bare `EISDIR: illegal operation on a directory, read` says nothing about what this
      // reader does accept.
      if (err.code === "EISDIR" || err.code === "EPERM") {
        const wrapped = new Error(`${spec.path}: a directory is not a source — pass the .conf files`);
        wrapped.code = err.code;
        wrapped.path = spec.path;
        wrapped.hint =
          "a source is one .conf file or one .pak entry (<pak>:<entry>), not a directory — pass each " +
          "table, or list a pak's entries with `node tools/pak.mjs find <pak> Language --limit 0`. " +
          "`--lenient` keeps `check` going when one of them is broken.";
        throw wrapped;
      }
      throw err;
    }
  }
  const table = parseStringTable(bytes, { name: spec.display, language: languageOfName(spec.display) });
  return {
    source: {
      index,
      kind: spec.kind,
      display: spec.display,
      pak: spec.pak ?? null,
      entry: spec.entry ?? null,
      path: spec.path ?? null,
      language: table.language,
      entries: table.size,
      bytes: bytes.length,
      problems: table.problems,
    },
    table,
  };
}

/** `openStringTables` plus the merge: the one call a caller usually wants. */
export function loadStringTables(specs, options = {}) {
  return new MergedStringTable(openStringTables(specs, options));
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Read Arma Reforger localization tables (Language/*.conf)

  node tools/loc.mjs info  <source>... [--lenient] [--json]
  node tools/loc.mjs get   <source> <id|#id>... [--raw] [--missing-ok] [--json]
  node tools/loc.mjs list  <source>... [--limit N|0] [--all] [--raw] [--lenient] [--json]
  node tools/loc.mjs find  <source>... <query> [--in id|text|both] [--regex]
                           [--limit N|0] [--all] [--raw] [--lenient] [--json]
  node tools/loc.mjs diff  <sourceA> <sourceB> [--limit N|0] [--all] [--json]
  node tools/loc.mjs check <source>... [--lenient] [--json]

  <source>   a .conf file on disk, or one entry inside a .pak written <pak>:<entry>

info    what each source holds: entries, language, defects; and how the merged dictionary looks.
get     the text behind ids. A leading # is optional: "#AR-MapIcon_Tower" and "AR-MapIcon_Tower"
        are the same key. Exits 3 when an id is not in the table (--missing-ok keeps it 0) — a
        missing key is what a wrong spelling of it looks like, and silence would hide that.
list    every id in the merged table, in file order, truncated by --limit (default 100).
find    ids or texts matching a query, case-insensitively; --regex reads the query as a regular
        expression. --in narrows it to the ids or to the texts.
diff    two sources side by side: ids only in A, only in B, and ids whose texts differ.
check   the defects in each source and the ids its sources disagree about. Exits 1 on an error
        (a duplicate id, a dangling continuation) — a warning (an empty text) does not fail.

Exit status: 0 success; 1 the input is at fault (a table that does not parse, a defect \`check\`
found, a source --lenient had to skip); 2 the command line is (USAGE); 3 a \`get\` id that is not in
the table, which --missing-ok keeps 0 — a query that missed is not a broken file.

Several sources are merged in **command-line order**, which is the override order: a mod is mounted
after the base game, so its file goes first and its text wins. Every id keeps its variants, and
\`check\` reports the ones the sources disagree about.

Sources may be inside a .pak, which is where localization normally lives:

  node tools/loc.mjs get \\
    "<install>/addons/data/data007.pak:Language/localization.ru_ru.conf" \\
    "#AR-Campaign_MapLocation_Cain_Kamensk"

That split happens at the **last** colon, and only when everything before it ends in \`.pak\` — so
C:\\dir\\localization.ru_ru.conf stays a file path (its only colon is the drive's) while
C:\\dir\\data007.pak:Language/... is an entry. \`--no-pak-path-split\` turns the split off.

Options
  --limit N     maximum rows to print (default 100; 0 = every one)
  --all         same as --limit 0; giving both --all and --limit is refused, not resolved
  --raw         print the text exactly as the file spells it, escapes undecoded. Under --json the
                text stays decoded and the file's own spelling arrives as \`raw\`, so adding --raw
                never changes what \`text\` means
  --in WHERE    find: id, text or both (default both)
  --regex       find: the query is a regular expression, matched case-insensitively
  --missing-ok  get: exit 0 even when an id is not in the table
  --lenient     info, list, find, check: a source that cannot be read or parsed is reported as a
                failure and the run goes on — an audit should not stop at the one bad table in a
                folder of 584. Each failure is named under \`parseFailures\` with --json, and the
                exit code is still 1. A table that cannot be read is not in the merged dictionary,
                so an id it alone carries reads as missing
  --no-pak-path-split
                read every source as a file on disk: no <pak>:<entry> split, even when the name
                ends in .pak or carries a colon
  --json        machine-readable output; every command answers with an envelope that names the
                sources and carries total/returned/truncated, never a bare array. A failure is the
                one object {ok:false, error:{code, message[, source, line, column]}} on stdout,
                with code USAGE, PARSE, IO or ERROR — the shape etconf, rdb and ebin print
  --compact     --json on one line, for a caller rather than a reader
  --            ends the options: everything after it is a source, an id or a query, so a text or
                an id that begins with a dash can be asked for (\`find <table> -- "-1"\`)
`;

/** A bad command line: reported with the usage, and the exit status is 2. */
function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

/**
 * What a refusal costs, in the codes `etconf`, `rdb` and `ebin` already use — so a script that
 * drives several readers does not have to relearn what 1 means.
 *
 *   0  success
 *   1  the input is at fault — a table that does not parse, a defect `check` found
 *   2  the command line is at fault (USAGE)
 *   3  `get`: an id that is not in the table (`--missing-ok` keeps that 0). A query that missed
 *      is not a broken file, and conflating the two made "did I spell the key right?" and "is the
 *      pak corrupt?" the same answer.
 */
const EXIT = { ok: 0, input: 1, usage: 2, miss: 3 };

/**
 * The failure as one object: a code a caller can branch on, the sentence a human reads, and the
 * position when there is one. Under `--json` this is the whole stdout, which is the shape
 * `etconf`, `rdb` and `ebin` answer with — a caller that asked for JSON never has to read prose
 * off stderr to find out what went wrong.
 */
function errorObject(err) {
  const code = err instanceof StringTableError
    ? "PARSE"
    : err.usage || err.code === "USAGE"
      ? "USAGE"
      : typeof err.code === "string"
        ? ({ ENOENT: "IO", EISDIR: "IO", ENOTDIR: "IO", EACCES: "IO", EPERM: "IO" }[err.code] ?? err.code)
        : "ERROR";
  const error = { code, message: err.message };
  if (err.source !== undefined) error.source = err.source;
  else if (typeof err.path === "string") error.source = err.path;
  if (Number.isInteger(err.line)) error.line = err.line;
  if (Number.isInteger(err.column)) error.column = err.column;
  if (err.hint) error.hint = err.hint;
  return error;
}

function reportError(err, { json = false, compact = false } = {}) {
  const error = errorObject(err);
  if (json) console.log(JSON.stringify({ ok: false, error }, null, compact ? 0 : 2));
  else {
    process.stderr.write(`error: ${error.message}\n`);
    if (error.hint) process.stderr.write(`${error.hint}\n`);
    if (error.code === "USAGE") {
      process.stderr.write("run `node tools/loc.mjs --help` for the commands and options\n");
    }
  }
  process.exitCode = error.code === "USAGE" ? EXIT.usage : EXIT.input;
}

/** Camel-case flag names, and the spelling the caller typed. */
const OPTION_SPELLING = { missingOk: "missing-ok", noPakPathSplit: "no-pak-path-split" };
const spell = (name) => OPTION_SPELLING[name] ?? name;

function parseArgs(argv) {
  const flags = { _: [], given: [] };
  const valueOf = (option, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw usageError(`${option} needs a value`);
    return v;
  };
  /** The switches, so a flag's code name and its command-line spelling live in one place. */
  const BOOLEAN = {
    "--json": "json",
    "--all": "all",
    "--raw": "raw",
    "--regex": "regex",
    "--missing-ok": "missingOk",
    "--no-pak-path-split": "noPakPathSplit",
    "--lenient": "lenient",
    "--compact": "compact",
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // Everything after `--` is a source, an id or a query, so a text that starts with a dash can be
    // asked for: `find <table> -- "-1"` used to be `unknown option "-1"`.
    if (a === "--") {
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (Object.hasOwn(BOOLEAN, a)) {
      flags[BOOLEAN[a]] = true;
      flags.given.push(BOOLEAN[a]);
    } else if (a === "--limit") {
      const raw = valueOf(a, i);
      i++;
      if (!/^\d+$/.test(raw)) throw usageError(`--limit needs a non-negative whole number, not "${raw}"`);
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) throw usageError(`--limit is too large: ${raw}`);
      flags.limit = n;
      flags.given.push("limit");
    } else if (a === "--in") {
      const raw = valueOf(a, i);
      i++;
      if (!["id", "text", "both"].includes(raw)) throw usageError(`--in takes id, text or both, not "${raw}"`);
      flags.in = raw;
      flags.given.push("in");
    } else if (a === "-h" || a === "--help") flags.help = true;
    // An option this tool does not know would otherwise change the answer silently.
    else if (a.startsWith("-") && a !== "-") throw usageError(`unknown option "${a}"`);
    else flags._.push(a);
  }
  // `--compact` is about how JSON is written, so it cannot mean anything but JSON.
  if (flags.compact) flags.json = true;
  return flags;
}

/** The options each command can honour; an option outside its row is refused, not ignored. */
const COMMAND_OPTIONS = {
  info: ["lenient"],
  get: ["missingOk", "raw"],
  list: ["limit", "all", "raw", "lenient"],
  find: ["limit", "all", "raw", "regex", "in", "lenient"],
  diff: ["limit", "all"],
  check: ["lenient"],
};
/** Accepted everywhere: `--json` changes how the answer is presented, `--no-pak-path-split` which answer it is. */
const GLOBAL_OPTIONS = ["json", "compact", "noPakPathSplit"];
/** The commands that read many sources, and so can carry on past one they cannot read. */
const SURVEYING_COMMANDS = ["info", "list", "find", "check"];

/** `--all` and `--limit` both say how many rows to keep; two answers must not be resolved silently. */
function checkContradictions(flags) {
  if (flags.all && flags.limit !== undefined) {
    throw usageError(
      `--all and --limit ${flags.limit} contradict each other: --all means --limit 0, so give one of them`,
    );
  }
}

function checkOptions(command, flags) {
  const allowed = new Set([...COMMAND_OPTIONS[command], ...GLOBAL_OPTIONS]);
  for (const given of flags.given) {
    if (allowed.has(given)) continue;
    if (given === "lenient" && !SURVEYING_COMMANDS.includes(command)) {
      throw usageError(
        `--lenient is for the commands that read many sources (${SURVEYING_COMMANDS.join(", ")}): ${command} ` +
          "reads one, so a table it cannot read leaves nothing to answer with",
      );
    }
    throw usageError(`${command} does not take --${spell(given)}`);
  }
}

/** Rows to print: `--limit 0` and `--all` mean "every one"; the default stops at 100. */
function rowLimit(flags, fallback = 100) {
  if (flags.all) return Infinity;
  if (flags.limit === undefined) return fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

/** One JSON answer: indented for a person, one line per object for a program. */
function emit(flags, value) {
  console.log(JSON.stringify(value, null, flags.compact ? 0 : 2));
}

function load(specs, flags) {
  return new MergedStringTable(openStringTables(specs, { noPakPathSplit: !!flags?.noPakPathSplit }));
}

/**
 * `load` for the commands that read many sources: with `--lenient` the ones that cannot be read
 * come back in `failures` instead of ending the run.
 */
function loadSurveying(specs, flags) {
  const { parts, failures } = readStringTables(specs, {
    noPakPathSplit: !!flags?.noPakPathSplit,
    lenient: !!flags?.lenient,
  });
  return { merged: new MergedStringTable(parts), failures };
}

/** A source that could not be read: one FAIL line, before the answer it is missing from. */
function printParseFailures(failures) {
  for (const failure of failures) {
    const detail = failure.source && failure.message.startsWith(`${failure.source}: `)
      ? failure.message.slice(failure.source.length + 2)
      : failure.message;
    console.log(`FAIL  ${failure.source ?? "?"}: ${detail}`);
  }
}

/** The source rows as `--json` reports them, without the per-source problem list it repeats. */
function sourceRows(merged) {
  return merged.sources.map((s) => ({
    index: s.index,
    kind: s.kind,
    display: s.display,
    pak: s.pak,
    entry: s.entry,
    path: s.path,
    language: s.language,
    entries: s.entries,
    bytes: s.bytes,
    problems: s.problems.length,
  }));
}

/** `sourceRows` with the problem list itself, for the two commands that report it. */
function sourceRowsWithProblems(merged) {
  const rows = sourceRows(merged);
  // `problems` stays a number in every command; the list is `problemList`. The same key carrying a
  // count in `list --json` and an array in `check --json` is the kind of thing a caller only finds
  // out when its `for` loop starts walking a number.
  return rows.map((row, i) => ({ ...row, problemList: merged.sources[i].problems }));
}

function rowJson(row, flags) {
  return {
    id: row.id,
    // Decoded either way: `--raw` adds the file's own spelling, it does not redefine `text`.
    text: row.text,
    ...(flags.raw ? { raw: row.raw } : {}),
    ...(row.source === undefined ? {} : { source: row.source }),
    ...(row.variants && row.variants.length > 1 ? { variants: row.variants.map((v) => ({ text: v.text, source: v.source })) } : {}),
  };
}

function footer(flags, total, returned) {
  if (returned < total) {
    console.log(`# ${total} row(s), ${returned} shown — use --limit 0 for every one`);
  }
}

function cmdInfo(specs, flags) {
  const { merged, failures } = loadSurveying(specs, flags);
  const overrides = merged.overrides();
  const conflicts = merged.conflicts();
  if (flags.json) {
    emit(flags, {
      sources: sourceRowsWithProblems(merged),
      total: merged.size,
      overrides: overrides.length,
      conflicts: conflicts.length,
      problems: merged.problems().length,
      ...(failures.length ? { parseFailures: failures } : {}),
    });
    return;
  }
  printParseFailures(failures);
  for (const s of merged.sources) {
    const counts = { error: 0, warning: 0 };
    for (const p of s.problems) counts[p.severity]++;
    console.log(
      `${s.display}\n  ${s.entries} entries${s.language ? `, language ${s.language}` : ""}, ${s.bytes} bytes` +
        (s.problems.length ? `, ${counts.error} error(s) and ${counts.warning} warning(s) — see check` : ", no problems"),
    );
  }
  console.log(
    `${merged.sources.length} source(s), ${merged.size} id(s)` +
      (overrides.length ? `, ${overrides.length} named by more than one source (${conflicts.length} with different text)` : ""),
  );
}

function cmdGet(specs, flags) {
  const [spec, ...keys] = specs;
  if (spec === undefined || keys.length === 0) {
    throw usageError("get needs a source and at least one id: node tools/loc.mjs get <source> <id>...");
  }
  const merged = load([spec], flags);
  const rows = keys.map((k) => merged.resolve(k));
  const missing = rows.filter((r) => !r.found);
  if (flags.json) {
    emit(flags, {
      sources: sourceRows(merged),
      total: merged.size,
      returned: rows.length,
      truncated: false,
      missing: missing.length,
      entries: rows.map((r) => ({
        key: r.key,
        id: r.id,
        found: r.found,
        // `text` is always the decoded text; `--raw` *adds* the file's own spelling rather than
        // overwriting `text`, so a caller that adds --raw to look closer does not silently start
        // reading escaped text as if it were the string the game shows.
        text: r.text,
        ...(r.found && flags.raw ? { raw: r.raw } : {}),
        source: r.source,
        ...(r.variants.length > 1 ? { variants: r.variants.map((v) => ({ text: v.text, source: v.source })) } : {}),
      })),
    });
  } else {
    for (const r of rows) {
      if (!r.found) process.stderr.write(`! ${r.key} — not in ${merged.sources[0].display} (${merged.size} ids)\n`);
      // The key as it was asked for: `#AR-X -> …` proves the `#` was accepted, `AR-X -> …` does not.
      else console.log(`${r.key} -> ${flags.raw ? r.raw : r.text}`);
    }
  }
  if (missing.length && !flags.missingOk) process.exitCode = EXIT.miss;
}

function cmdList(specs, flags) {
  const { merged, failures } = loadSurveying(specs, flags);
  const limit = rowLimit(flags);
  const all = merged.entries();
  const shown = all.slice(0, limit === Infinity ? all.length : limit);
  if (flags.json) {
    emit(flags, {
      sources: sourceRows(merged),
      total: all.length,
      returned: shown.length,
      truncated: shown.length < all.length,
      entries: shown.map((e) => rowJson(e, flags)),
      ...(failures.length ? { parseFailures: failures } : {}),
    });
    return;
  }
  printParseFailures(failures);
  for (const e of shown) console.log(`${e.id} -> ${flags.raw ? e.raw : e.text}`);
  footer(flags, all.length, shown.length);
}

function cmdFind(specs, flags) {
  if (specs.length < 2) {
    throw usageError("find needs at least one source and a query: node tools/loc.mjs find <source>... <query>");
  }
  const query = specs[specs.length - 1];
  const { merged, failures } = loadSurveying(specs.slice(0, -1), flags);
  let hits;
  try {
    hits = merged.find(query, { regex: flags.regex, in: flags.in ?? "both", limit: rowLimit(flags) });
  } catch (err) {
    throw usageError(`"${query}" is not a valid regular expression: ${err.message}`);
  }
  const total = merged.find(query, { regex: flags.regex, in: flags.in ?? "both" }).length;
  if (flags.json) {
    emit(flags, {
      sources: sourceRows(merged),
      query,
      in: flags.in ?? "both",
      regex: !!flags.regex,
      total,
      returned: hits.length,
      truncated: hits.length < total,
      entries: hits.map((h) => rowJson(h, flags)),
      ...(failures.length ? { parseFailures: failures } : {}),
    });
    return;
  }
  printParseFailures(failures);
  for (const h of hits) console.log(`${h.id} -> ${flags.raw ? h.raw : h.text}`);
  if (!hits.length) console.log(`# no id or text matches ${JSON.stringify(query)} in ${merged.size} id(s)`);
  else footer(flags, total, hits.length);
}

function cmdDiff(specs, flags) {
  const [aSpec, bSpec] = specs;
  if (aSpec === undefined || bSpec === undefined) {
    throw usageError("diff needs two sources: node tools/loc.mjs diff <sourceA> <sourceB>");
  }
  if (specs.length > 2) {
    // Silently diffing the first two and dropping the rest answers a question nobody asked.
    throw usageError(
      `diff compares exactly two sources, and ${specs.length} were given — run it once per pair, ` +
        "or use `check` (which merges every source in order) when the question is what they disagree about",
    );
  }
  const a = load([aSpec], flags);
  const b = load([bSpec], flags);
  const cmp = compareStringTables(a, b);
  const limit = rowLimit(flags);
  const cap = (list) => (limit === Infinity ? list : list.slice(0, limit));
  const onlyA = cap(cmp.onlyInA);
  const onlyB = cap(cmp.onlyInB);
  const differing = cap(cmp.differing);
  if (flags.json) {
    const pack = (list, shown, map) => ({ total: list.length, returned: shown.length, truncated: shown.length < list.length, entries: shown.map(map) });
    emit(flags, {
      a: sourceRows(a)[0],
      b: sourceRows(b)[0],
      counts: { a: a.size, b: b.size, same: cmp.same, onlyInA: cmp.onlyInA.length, onlyInB: cmp.onlyInB.length, differing: cmp.differing.length },
      onlyInA: pack(cmp.onlyInA, onlyA, (id) => ({ id, text: a.get(id) })),
      onlyInB: pack(cmp.onlyInB, onlyB, (id) => ({ id, text: b.get(id) })),
      differing: pack(cmp.differing, differing, (d) => ({ id: d.id, a: d.a, b: d.b })),
    });
    return;
  }
  console.log(`A: ${a.sources[0].display} (${a.size} ids)`);
  console.log(`B: ${b.sources[0].display} (${b.size} ids)`);
  console.log(`\nonly in A (${cmp.onlyInA.length}):`);
  for (const id of onlyA) console.log(`  ${id} -> ${a.get(id)}`);
  footer(flags, cmp.onlyInA.length, onlyA.length);
  console.log(`\nonly in B (${cmp.onlyInB.length}):`);
  for (const id of onlyB) console.log(`  ${id} -> ${b.get(id)}`);
  footer(flags, cmp.onlyInB.length, onlyB.length);
  console.log(`\ndiffering (${cmp.differing.length}):`);
  for (const d of differing) console.log(`  ${d.id}\n    A: ${d.a}\n    B: ${d.b}`);
  footer(flags, cmp.differing.length, differing.length);
  console.log(`\n${cmp.same} id(s) identical in both`);
}

function cmdCheck(specs, flags) {
  const { merged, failures } = loadSurveying(specs, flags);
  const problems = merged.problems();
  const errors = problems.filter((p) => p.severity === "error");
  const failed = failures.length;
  if (flags.json) {
    emit(flags, {
      sources: sourceRowsWithProblems(merged),
      total: merged.size,
      ok: errors.length === 0 && failed === 0,
      errors: errors.length,
      warnings: problems.length - errors.length,
      // `problems` is a count in every command; the list is `problemList`, so a caller can read
      // both without asking which shape this command chose.
      problems: problems.length,
      problemList: problems,
      ...(failed ? { parseFailures: failures } : {}),
    });
  } else {
    printParseFailures(failures);
    for (const s of merged.sources) {
      const own = s.problems;
      const ownErrors = own.filter((p) => p.severity === "error").length;
      console.log(
        `${ownErrors ? "FAIL" : "OK  "}  ${s.display}: ${s.entries} entries` +
          (own.length ? `, ${own.length} problem(s)` : ", no problems"),
      );
      for (const p of own) console.log(`        [${p.severity}] ${p.message}`);
    }
    const conflicts = merged.conflicts();
    if (conflicts.length) {
      console.log(`      ${conflicts.length} id(s) the sources give different text (the first source wins):`);
      for (const c of conflicts.slice(0, 5)) console.log(`        ${c.id}: ${c.variants.map((v) => v.text).join(" | ")}`);
      if (conflicts.length > 5) console.log(`        ... and ${conflicts.length - 5} more`);
    }
  }
  if (errors.length || failed) process.exitCode = EXIT.input;
}

function main() {
  const argv = process.argv.slice(2);
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (flags._.length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = EXIT.usage;
    return;
  }
  const [command, ...rest] = flags._;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) {
    const commands = Object.keys(COMMAND_OPTIONS).join(", ");
    throw usageError(`unknown command "${command}" — one of ${commands}`);
  }
  if (rest.length === 0) throw usageError(`${command} needs a source: <file> or <pak>:<entry>`);
  checkOptions(command, flags);
  checkContradictions(flags);
  switch (command) {
    case "info": cmdInfo(rest, flags); break;
    case "get": cmdGet(rest, flags); break;
    case "list": cmdList(rest, flags); break;
    case "find": cmdFind(rest, flags); break;
    case "diff": cmdDiff(rest, flags); break;
    case "check": cmdCheck(rest, flags); break;
    default: throw usageError(`unknown command "${command}"`);
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  const args = process.argv.slice(2);
  try {
    main();
  } catch (err) {
    reportError(err, { json: args.includes("--json") || args.includes("--compact"), compact: args.includes("--compact") });
  }
}
