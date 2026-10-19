#!/usr/bin/env node
// Read Arma Reforger text resources: `.et` prefabs, `.conf` configs, `.ct` component templates,
// `.layout` UI layouts, and a Workbench project's `.meta` and `.gproj`.
//
//   node tools/etconf.mjs info       <source>... [--rdb <rdb>]... [--use-addons-rdbs] [--limit N|0]
//                                    [--json]
//   node tools/etconf.mjs cat        <source> [<lines>] [--lines N] [--numbers] [--json]
//   node tools/etconf.mjs tree       <source> [--depth N] [--limit N|0] [--all] [--numbers] [--json]
//   node tools/etconf.mjs get        <source> <path>... [--missing-ok] [--depth N] [--numbers] [--json]
//   node tools/etconf.mjs components <source> [--limit N|0] [--all] [--numbers] [--json]
//   node tools/etconf.mjs refs       <source>... [--rdb <rdb>]... [--check] [--strict] [--json]
//   node tools/etconf.mjs chain      <source> [--rdb <rdb>]... [--pak <pak|dir>]... [--addon <dir>]...
//                                    [--addons <root>]... [--use-addons-rdbs] [--depth N] [--json]
//   node tools/etconf.mjs find       <source>... <query> [--regex] [--in name|value|class|all] [--json]
//   node tools/etconf.mjs check      <source>... [--rdb <rdb>]... [--strict] [--limit N|0] [--json]
//
// A **source** is a file on disk, one entry inside a `.pak` written `<pak>:<entry>`, or a directory —
// which info, check, refs and find read document by document. The pak split is the rule
// `tools/loc.mjs` uses (it lives in `pak.mjs`, so both readers share one copy):
//
//   node tools/etconf.mjs tree \
//     "<install>/addons/data/data007.pak:Prefabs/Props/Industrial/BarrelMetal_01_Base.et"
//
// Also usable as a library:
//
//   import { parseText, lookup, refsOf, componentsOf } from "./etconf.mjs";
//   const doc = parseText(bytes, { name: "BarrelMetal_01_Base.et" });
//   doc.className;                                      // "GenericEntity"
//   doc.parent;                                          // { guid: "4CC2C69DE1AEF103", path: "Prefabs/…et" }
//   lookup(doc, "components/RigidBody/Static").value;    // { kind: "int", value: 1, … }
//   componentsOf(doc).map((c) => [c.className, c.guid]);
//   refsOf(doc).map((r) => r.path);
//
// ---------------------------------------------------------------------------
// THE FORMAT, as measured on the installed 1.8.0.13 client and its 11 `data*.pak` archives
// (21 994 files: 19 435 `.et`, 2 448 `.conf`, 111 `.ct`; every one of them read by this parser
// with 0 errors):
//
//   .et, .conf and .ct are ONE format — an object serialized as text, exactly one object per file:
//
//     Class [name] [":" "{GUID}path"] {          <- the root object
//      ID "F0DBA538AC2A0552"                     <- a member: name, then its value on one line
//      components {                              <- a member whose value is a block
//       MeshObject "{5872F0EB7FA40561}" {        <- an object: class, optional slot GUID, block
//        Object "{D73D5FE0EEFBCD9B}Assets/…xob"  <- a resource reference: GUID + path, quoted
//       }
//      }
//      coords 0 0 0                              <- numbers on one line: a vector
//      Flags 0x80503 0                           <- two words: a bit mask
//      ParentContextList +{ }                    <- `+` appends to the array the parent already has
//      m_aFactionLimits { SCR_FactionLimit "…" { m_sFactionKey "FIA" } }   <- array of objects
//     }
//
// The extension only says what the root object *means*: `.et` is an entity template (a prefab),
// `.conf` a config object of any class, `.ct` a component template a prefab can inherit a
// component from. 424 distinct root classes in `.conf`, 166 in `.et`, 53 in `.ct`. A document has
// no comments, and no `$` directive beyond `$grp`, the group header 1 284 prefab compositions use
// the way worlds do: `$grp GenericEntity : "{GUID}…et" { { … } { … } }`.
//
// The same syntax, with a different root, is also a UI `.layout` (1 238 in the shipped paks), the
// `.meta` and `.gproj` of a Workbench project, and a world `.layer`. A `.layer` is the odd one: it
// writes a *sequence* of roots — `GenericWorldEntity world { … }` then `GenericTerrainEntity Terrain
// { … }`, `SCR_MapEntity MapEntity : …` — so only a layer that holds one root is readable here, and
// the rest are refused with that sentence. A `.layer` also names its root unquoted, which is the one
// place this format does that.
//
// Five `.layout` files do not parse, and that is malformed *data* rather than a reader gap: their
// markup string escapes the opening quote of the first attribute and not the closing one —
// `Text "<image set=\"{GUID}…imageset" name=\"…\"…` — so the string ends early. They are
// `QuickMenu.layout`, `ToolMenu.layout`, `WarningWidgetDeploy.layout`, `PreviewRichText-Backup.layout`
// and `PreviewRichText_AsianFontTesting.layout`; the other 1 233 parse.
//
// What the writer does, and what this reader therefore assumes:
//
//  * **One entry per line.** A member is its name plus the value tokens on the same line (or a
//    block that follows); an array element is a value with no name. A quoted string followed on
//    its line by anything is a *name* (`"Radio encryption key" "Sandbox"`); one that stands alone
//    is an *element* (`Ids { "AR-X" … }`). This is the one assumption a reader of this format
//    cannot avoid — how many tokens belong to a value is decided by the class schema, which is not
//    in the file.
//  * **A quote closes a string unless the character before it is a backslash**, and `\\"` (two
//    backslashes then a quote) is an escaped quote written double-escaped: 15 files carry one,
//    inside `<color rgba=\\"226,168,79,255\\">` markup, which a C-style scanner closes early.
//    The escape set is the one `tools/loc.mjs` decodes (`\n \t \r \" \\`); any other `\X` stays
//    verbatim, so a literal `\u1f600` in a tag survives.
//  * **A lone `\` after the closing quote continues the value** in the strings that follow; 33
//    files use it (13 localization tables and 20 odd configs), and the pieces are joined.
//  * Indentation is **one space per level** but is not significant: 34 lines in 5 files disagree.
//    21 968 of the 21 994 files do not end with a newline; 58 use CRLF; 3 use tabs; none has a BOM.
//
// What the file normally does **not** contain: its own resource GUID. The `ID` member is a 16-hex
// editor-assigned id, not a resource GUID — 19 378 of the 19 435 `.et` carry one, but there are only
// 2 654 distinct values, because a derived prefab is written with its **parent's** ID: of the 18 632
// prefabs whose parent is in the corpus, 15 722 carry exactly their parent's value and only 2 910 a
// value of their own. So the ID identifies a prefab *family*, and cannot identify a step of a chain —
// `chain` prints the resource GUID instead, which comes from `resourceDatabase.rdb` (`--rdb`) or, in
// a Workbench project, from the `.meta` beside every file: `X.et.meta` holds `Name "{GUID}path"`.
// That `.meta` also shows that a parent may be a **class** rather than a resource
// (`EntityTemplateResourceClass XBOX_ONE : PC`), which `.et`, `.conf` and `.ct` never do.
//
// The exception to "no identity in the file" is a document that opens `Class "{GUID}ownpath" : …`:
// 33 files do, and all 33 name their own database entry. The identity otherwise lives in the
// database — see `tools/rdb.mjs`. And when several databases declare one GUID (a mod overriding a
// prefab), every copy of that resource must agree on **one parent**: otherwise which parent applies
// depends on the mount order, and `chain` stops with `Multiple parents detected at …`.
//
// And the path next to a GUID is **decoration**: the engine resolves the GUID. Across the corpus
// 125 869 references are written as `"{GUID}path"`: 125 827 name the resource the path says, **10
// contradict it** — the GUID names another file than the path does (`refs --rdb` reports them, and
// they are real shipped data, e.g. `Calvary_02.et`) — and 32 name a GUID the database does not
// hold at all (editor-only or removed assets, which `check` reports as a warning, not an error).
//
// What this reader cannot know: whether the **first ident of an entry is a member name or a
// class**. `UIInfo SCR_ActionUIInfo "…" : "…"` is a member named `UIInfo` holding an object of
// class `SCR_ActionUIInfo`, while `SCR_CharacterHitZone Head : "…"` is an array element of class
// `SCR_CharacterHitZone` named `Head` — the same token shape, opposite reading, decided by the
// class schema. So an entry keeps its tokens in order (`entry.spec`), and the helpers that only
// make sense in one context (`componentsOf`) apply that context's rule explicitly.
//
// `--json` everywhere, `--compact` for the reader that pays per token; exit 0 success, 1 when the
// input is at fault (a parse error, a `check`/`refs --check` problem), 2 when the command line is
// (USAGE), 3 when a `get` path is not in the document (a miss, not a defect; --missing-ok keeps 0).
// A failure under `--json` is an object with a code, not prose:
// {ok:false, error:{code, message, source?, line?, column?}}.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve as resolvePath, dirname, join, relative, isAbsolute, extname } from "node:path";
import { pathToFileURL } from "node:url";
import { openPak, findEntry, normalisePath, parseSourceSpec } from "./pak.mjs";
import { openRdbFiles, describeMergeProblems } from "./rdb.mjs";
import { decodeBsp, describeBsp } from "./bsp.mjs";

/**
 * The extensions this reader accepts, in the order the header describes them.
 *
 * All six are the same text format — one object per file — and each was scanned on the installed
 * 1.8.0.13 client: 21 994 `.et`/`.conf`/`.ct`, **1 233 of 1 238** `.layout` (the five others are
 * malformed *data*: their markup string escapes the opening quote of an attribute and not the
 * closing one, so the string ends early and the line is refused at that column), 133 `.meta` and 7
 * `.gproj` from the Workbench addons on this machine.
 *
 * Two extensions are deliberately absent. `.layer` is a **sequence** of root objects — a world
 * layer writes `GenericWorldEntity world { … }` and then `GenericTerrainEntity Terrain { … }` — and
 * this reader models one object per file, so 1 of 5 scanned layers reads. `.ent` is `EBIN` in the
 * shipped paks (4 of 4), which `tools/ebin.mjs` reads; a text stub in a project does parse, but the
 * extension is not this format's.
 */
export const EXTENSIONS = [".et", ".conf", ".ct", ".layout", ".meta", ".gproj"];

/**
 * A source as the command line writes it — a file on disk, or one entry inside a `.pak`.
 *
 * The rule lives in `pak.mjs`, because every reader that accepts a `.pak` entry needs the same one;
 * re-exported here so this tool is a single import for a caller.
 */
export { parseSourceSpec };

/** Escapes the writer emits. Every other `\X` is kept verbatim. */
const ESCAPES = { n: "\n", t: "\t", r: "\r", '"': '"', "\\": "\\" };

const BOM = 0xfeff;

const GUID_ONLY = /^\{([0-9A-Fa-f]{16})\}$/;
const GUID_REF = /^\{([0-9A-Fa-f]{16})\}([^]*)$/;
const ID_SHAPE = /^[0-9A-F]{16}$/;

const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";
const isHexDigit = (c) => isDigit(c) || (c !== undefined && /[A-Fa-f]/.test(c));
const isIdentStart = (c) => c !== undefined && /[A-Za-z_$#]/.test(c);
const isIdentChar = (c) => c !== undefined && /[A-Za-z0-9_$#-]/.test(c);

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A document that does not parse, reported with the line and column it gave itself away. */
export class ConfSyntaxError extends Error {
  constructor(name, message, text, at) {
    const { line, column } = lineColumn(text, at);
    super(`${name}: ${message} (line ${line}, column ${column})`);
    this.name = "ConfSyntaxError";
    this.code = "PARSE";
    this.source = name;
    this.line = line;
    this.column = column;
    this.at = at;
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

const describeChar = (c) =>
  c === undefined
    ? "the end of the file"
    : c === "\n"
      ? "a line break"
      : c === "\r"
        ? "a carriage return"
        : `"${c}"`;

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

/**
 * The token scanner.
 *
 * It resolves the three things a naive split gets wrong: a quoted string (with the writer's escape
 * rules), a `{GUID}path` reference, and the `\` that continues a value rather than escaping it. A
 * reference written *without* quotes is accepted and marked `quoted: false`, so `check` can point
 * it out — the shipped writer quotes all 125 869 references in the corpus.
 */
export function tokenize(text, { name = "<text>" } = {}) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let lineStart = 0;
  const atEnd = () => i >= text.length;
  const fail = (message, at = i) => {
    throw new ConfSyntaxError(name, message, text, at);
  };
  const push = (token, at, startLine, startCol) =>
    tokens.push({ ...token, line: startLine, column: startCol, at });

  if (text.charCodeAt(0) === BOM) i = 1;
  while (!atEnd()) {
    const c = text[i];
    if (c === "\n") {
      line++;
      i++;
      lineStart = i;
      continue;
    }
    if (c === " " || c === "\t" || c === "\r") {
      i++;
      continue;
    }
    const start = i;
    const startLine = line;
    const startCol = i - lineStart + 1;

    if (c === '"') {
      i++;
      let raw = "";
      let value = "";
      for (;;) {
        if (atEnd()) fail("unterminated string: the file ends before the closing quote", start);
        const d = text[i];
        if (d === '"') {
          i++;
          break;
        }
        if (d === "\\") {
          const after = text[i + 1];
          if (after === undefined) fail("unterminated escape sequence", i);
          // An escaped quote is written double-escaped (`\` `\` `"`): consume one backslash so the
          // pair that follows reads as `\"`, which is what the writer means. Same rule as loc.mjs.
          if (after === "\\" && text[i + 2] === '"') {
            raw += "\\";
            value += "\\";
            i += 1;
            continue;
          }
          raw += "\\" + after;
          value += Object.hasOwn(ESCAPES, after) ? ESCAPES[after] : "\\" + after;
          i += 2;
          continue;
        }
        if (d === "\n") {
          fail(
            "a string runs across a line break, which the writer never does: its closing quote is missing or written as an escape",
            start,
          );
        }
        raw += d;
        value += d;
        i++;
      }
      const only = GUID_ONLY.exec(value);
      if (only) push({ type: "guid", guid: only[1].toUpperCase(), raw: value }, start, startLine, startCol);
      else {
        const ref = GUID_REF.exec(value);
        // A string that only *starts* with a GUID is not always a reference: UI markup carries
        // `<image path="{GUID}…imageset"/>`, and the decoded text then holds `"` `<` `>` or a
        // backslash. No resource path has those characters, so such a string stays a string rather
        // than becoming a reference that names nothing.
        if (ref && !/[\\"<>|*?]/.test(ref[2])) {
          push({ type: "ref", guid: ref[1].toUpperCase(), path: ref[2], quoted: true, raw: value }, start, startLine, startCol);
        } else push({ type: "string", value, raw }, start, startLine, startCol);
      }
      continue;
    }

    // A reference written without quotes: `{GUID}path`. Read, and flagged by `check`.
    if (c === "{" && text[i + 17] === "}" && /^[0-9A-Fa-f]{16}$/.test(text.slice(i + 1, i + 17))) {
      const after = text[i + 18];
      if (after !== undefined && !/[\s{}"]/.test(after)) {
        let j = i + 18;
        while (j < text.length && !/[\s{}"]/.test(text[j])) j++;
        push(
          { type: "ref", guid: text.slice(i + 1, i + 17).toUpperCase(), path: text.slice(i + 18, j), quoted: false },
          start,
          startLine,
          startCol,
        );
        i = j;
        continue;
      }
    }
    if (c === "{" || c === "}" || c === ":" || c === "+" || c === "\\") {
      push({ type: c === "\\" ? "cont" : c }, start, startLine, startCol);
      i++;
      continue;
    }
    if (c === "0" && (text[i + 1] === "x" || text[i + 1] === "X")) {
      let j = i + 2;
      while (j < text.length && isHexDigit(text[j])) j++;
      if (j === i + 2) fail("a hexadecimal number with no digits", start);
      push({ type: "hex", value: Number.parseInt(text.slice(start, j), 16), raw: text.slice(start, j) }, start, startLine, startCol);
      i = j;
      continue;
    }
    if (c === "-" || isDigit(c)) {
      i++;
      while (i < text.length && /[0-9.eE]/.test(text[i])) {
        if ((text[i] === "e" || text[i] === "E") && !/[0-9+-]/.test(text[i + 1] ?? "")) break;
        if ((text[i] === "e" || text[i] === "E") && /[+-]/.test(text[i + 1] ?? "")) i++;
        i++;
      }
      const raw = text.slice(start, i);
      if (!/^-?[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/.test(raw)) fail(`"${raw}" is not a number`, start);
      push(
        raw.includes(".") || /[eE]/.test(raw)
          ? { type: "float", value: Number(raw), raw }
          : { type: "int", value: Number(raw), raw },
        start,
        startLine,
        startCol,
      );
      continue;
    }
    if (isIdentStart(c)) {
      let j = i + 1;
      while (j < text.length && isIdentChar(text[j])) j++;
      push({ type: "ident", value: text.slice(start, j) }, start, startLine, startCol);
      i = j;
      continue;
    }
    fail(`unexpected character ${describeChar(c)}`);
  }
  return tokens;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

/**
 * Group the tokens of one value into the shape the writer meant.
 *
 * A value is one of: a number, a string, an identifier (an enum), a reference, a GUID, a vector of
 * 2–4 numbers, a bit mask (a hex word followed by more words), a list of strings or references, or
 * — when nothing else fits — the token list itself, reported rather than guessed away.
 */
function scalarFrom(tokens) {
  const line = tokens[0]?.line ?? 0;
  if (tokens.length === 1) {
    const t = tokens[0];
    switch (t.type) {
      case "string":
        return { kind: "string", value: t.value, raw: t.raw, pieces: t.pieces ?? 1, line };
      case "ident":
        return { kind: "ident", value: t.value, line };
      case "int":
        return { kind: "int", value: t.value, raw: t.raw, line };
      case "float":
        return { kind: "float", value: t.value, raw: t.raw, line };
      case "hex":
        return { kind: "hex", value: t.value, raw: t.raw, line };
      case "guid":
        return { kind: "guid", guid: t.guid, line };
      case "ref":
        return { kind: "ref", guid: t.guid, path: t.path, quoted: t.quoted, line };
      default:
        return { kind: "unknown", tokens: tokens.map((x) => x.type), line };
    }
  }
  if (tokens.every((t) => t.type === "int" || t.type === "float" || t.type === "hex")) {
    const numbers = tokens.map((t) => t.value);
    if (tokens[0].type === "hex") return { kind: "mask", value: numbers, raw: tokens.map((t) => t.raw ?? String(t.value)), line };
    if (numbers.length >= 2 && numbers.length <= 4) return { kind: "vector", value: numbers, line };
    return { kind: "numbers", value: numbers, line };
  }
  if (tokens.every((t) => t.type === "string")) return { kind: "strings", value: tokens.map((t) => t.value), line };
  if (tokens.every((t) => t.type === "ref")) {
    return { kind: "refs", value: tokens.map((t) => ({ guid: t.guid, path: t.path, quoted: t.quoted })), line };
  }
  if (tokens.every((t) => t.type === "guid")) return { kind: "guids", value: tokens.map((t) => t.guid), line };
  return { kind: "mixed", tokens: tokens.map((t) => t.raw ?? t.value ?? t.type), line };
}

/** The text a value would be written as, for printing and searching. */
export function formatValue(value) {
  if (!value) return "";
  switch (value.kind) {
    case "string":
      return JSON.stringify(value.value);
    case "ref":
      return `"{${value.guid}}${value.path}"`;
    case "refs":
      return value.value.map((r) => `"{${r.guid}}${r.path}"`).join(" ");
    case "guid":
      return `{${value.guid}}`;
    case "guids":
      return value.value.map((g) => `{${g}}`).join(" ");
    case "int":
    case "float":
    case "hex":
      return value.raw ?? String(value.value);
    case "ident":
      return value.value;
    case "vector":
    case "numbers":
      return value.value.join(" ");
    case "mask":
      return value.raw.join(" ");
    case "strings":
      return value.value.map((s) => JSON.stringify(s)).join(" ");
    case "mixed":
      return value.tokens.join(" ");
    case "block":
      return `{ ${value.items.length} item(s) }`;
    case "object":
      return formatHead(value) || "{ }";
    case "bsp":
      return describeBsp(value);
    default:
      return "";
  }
}

/**
 * `BSP` holds a world's tree, and the writer puts its integers on the member's line — 17 277 of them
 * in `EmptyCain.ent` — so the member is decoded here rather than left as a list a caller would have
 * to count. Any other member's value is returned untouched, and a `BSP` that does not hold together
 * keeps its `error` instead of a tree (see `tools/bsp.mjs`).
 */
function bspMember(name, value) {
  if (name !== "BSP" || !value) return value;
  let numbers = null;
  if (value.kind === "numbers" || value.kind === "vector") numbers = value.value;
  else if (value.kind === "int") numbers = [value.value];
  if (!numbers) return value;
  const tree = decodeBsp(numbers);
  return { kind: "bsp", count: tree.count, nodes: tree.nodes, error: tree.error, line: value.line };
}

/** `Class "name" "{slot}" : "{GUID}parent"` for a document or an object value. */
export function formatHead(node) {
  if (!node) return "";
  const parts = [];
  if (node.className) parts.push(node.className);
  if (node.name) parts.push(JSON.stringify(node.name));
  if (node.objectName) parts.push(JSON.stringify(node.objectName));
  if (node.guid) parts.push(`"{${node.guid}}"`);
  if (node.parent) parts.push(`: "{${node.parent.guid}}${node.parent.path}"`);
  return parts.join(" ");
}

/** The tokens of an entry's spec, as the file writes them. */
function renderSpec(spec) {
  return (spec ?? [])
    .map((x) => {
      if (x.type === "guid") return `"{${x.guid}}"`;
      if (x.type === "ref") return x.role === "parent" ? `: "{${x.guid}}${x.path}"` : `"{${x.guid}}${x.path}"`;
      if (x.type === "string") return JSON.stringify(x.value);
      return x.value;
    })
    .join(" ");
}

/** One line for one entry, without its block. */
export function formatEntry(entry) {
  const name = entry.quoted ? JSON.stringify(entry.name) : entry.name;
  const spec = renderSpec(entry.spec);
  const head = spec ? `${name} ${spec}` : name;
  return entry.append ? `${head} +` : head;
}

/** One line for one entry: its head, and its value when the value is not a block. */
export function entryLabel(item) {
  if (item.kind === "element") return formatValue(item.value);
  const head = formatEntry(item);
  return blockOf(item.value) ? head : `${head} ${formatValue(item.value)}`.trim();
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const isBytes = (input) => input instanceof Uint8Array;

/**
 * The extensions a source may carry: the six this format uses, plus `.layer`, which is the same
 * syntax holding a *sequence* of roots — a layer with one root parses, and the rest is refused by
 * `parseText` with the sentence that says so.
 */
const READABLE_EXTENSIONS = new Set([...EXTENSIONS, ".layer"]);

/** A source this reader cannot read, with the tool that can. */
function inputError(message, { source = null, hint = null } = {}) {
  const err = new Error(message);
  err.code = "INPUT";
  err.source = source;
  err.hint = hint;
  return err;
}

const ELSEWHERE = {
  ".ent": {
    why: "a shipped .ent is EBIN, not this text format",
    hint: "read it with tools/ebin.mjs",
  },
  ".pak": {
    why: "a .pak is an archive, not a document",
    hint: "name one entry inside it: <pak>:<entry>",
  },
  ".rdb": {
    why: "a resourceDatabase.rdb is an index, not a document",
    hint: "read it with tools/rdb.mjs",
  },
  ".c": {
    why: "a .c file is Enforce Script, not this text format",
    hint: "read it with tools/cscript.mjs",
  },
};

/** Refuse a source whose extension this reader does not read, naming the tool that does. */
function checkSourceExtension(spec) {
  const value = spec.kind === "pak" ? spec.entry : spec.path;
  const ext = extname(String(value)).toLowerCase();
  if (READABLE_EXTENSIONS.has(ext)) return;
  const elsewhere = ELSEWHERE[ext];
  if (elsewhere) {
    throw inputError(`${spec.display}: ${elsewhere.why}`, { source: spec.display, hint: elsewhere.hint });
  }
  throw inputError(
    `${spec.display}: "${ext || "no extension"}" is not a format this reader reads — it reads ` +
      ".et, .conf, .ct, .layout, a project's .meta and .gproj, and a single-root .layer",
    { source: spec.display, hint: "if the file is one of those, name it with its own extension" },
  );
}

/**
 * Parse a text document into its root objects — the one place the bytes are read.
 *
 * `input` is the file's text (a `string`) or its bytes (a `Buffer`/`Uint8Array`); a path is **not**
 * accepted — `readDocument` does that, so text and bytes can never be confused with a file name.
 * Throws `ConfSyntaxError` (with the line and column) for anything this reader does not understand.
 *
 * A root object is a plain object graph, safe for `JSON.stringify`:
 *
 *   { type: "object", className, name, guid, self, parent, block, line, bytes, lines, source, index }
 *   block  = { type: "block", items: [entry…], line }
 *   entry  = { kind: "member", name, quoted, append, spec, value, line }
 *          | { kind: "element", spec, value, line }
 *   value  = scalar (see `formatValue`) | block | object
 *   object = { type: "object", className, objectName, guid, parent, reference, specs, block, line }
 *
 * Returns `{ roots, starts, text }`, where `starts[n]` is the offset of root *n*'s class token —
 * what `parseText` needs to point a refused second root at its own line and column.
 */
function parseAll(input, { name = "<text>", source = null } = {}) {
  let text;
  let bytes = null;
  if (typeof input === "string") text = input;
  else if (isBytes(input)) {
    bytes = Buffer.isBuffer(input) ? input : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
    text = new TextDecoder("utf-8").decode(bytes);
  } else {
    throw new TypeError(`parseAll needs a string, a Buffer or a Uint8Array, not ${typeof input}`);
  }

  const tokens = tokenize(text, { name });
  let i = 0;
  const peek = (k = 0) => tokens[i + k];
  const next = () => tokens[i++];
  const fail = (message, token = tokens[i]) => new ConfSyntaxError(name, message, text, token?.at ?? text.length);
  const expect = (type, what) => {
    const t = peek();
    if (!t || t.type !== type) {
      throw fail(`expected ${what ?? `"${type}"`}, found ${t ? `"${t.type}"` : "the end of the file"}`);
    }
    return next();
  };

  /**
   * One value: the tokens on this line, joined by `\` continuations. A continuation belongs to the
   * string before it, so the pieces are concatenated and counted.
   */
  const readValue = () => {
    const first = peek();
    if (!first) throw fail("expected a value, found the end of the file", null);
    const collected = [];
    let line = first.line;
    for (;;) {
      const t = peek();
      if (!t) break;
      if (t.type === "}" || t.type === "{" || t.type === ":") break;
      if (t.type === "cont") {
        const previous = collected[collected.length - 1];
        if (!previous || previous.type !== "string") {
          throw fail('a "\\" continues a string, and there is no string before it here', t);
        }
        next();
        const more = expect("string", 'the continued string after a "\\"');
        collected[collected.length - 1] = {
          ...previous,
          value: previous.value + more.value,
          raw: previous.raw + more.raw,
          pieces: (previous.pieces ?? 1) + 1,
        };
        line = more.line;
        continue;
      }
      if (t.line !== line) break;
      if (
        t.type === "ident" ||
        t.type === "string" ||
        t.type === "guid" ||
        t.type === "ref" ||
        t.type === "int" ||
        t.type === "float" ||
        t.type === "hex"
      ) {
        collected.push(next());
        continue;
      }
      break;
    }
    if (!collected.length) {
      throw fail(`expected a value, found ${peek() ? `"${peek().type}"` : "the end of the file"}`, first);
    }
    return scalarFrom(collected);
  };

  const readBlock = () => {
    const open = expect("{", '"{"');
    const block = { type: "block", items: [], line: open.line };
    for (;;) {
      const t = peek();
      if (!t) throw fail("unterminated block: the file ends before its closing brace", open);
      if (t.type === "}") {
        next();
        return block;
      }
      block.items.push(readItem());
    }
  };

  /**
   * A quoted string is a **name** when its line carries something that can follow a name (a block,
   * `:`, `+`, a value), and an **element** when it stands alone — the writer puts one array element
   * per line. A `\` right after it means the text continues, so that is an element too.
   */
  const stringIsName = () => {
    const t = peek();
    const after = peek(1);
    if (!after || after.type === "cont") return false;
    return after.line === t.line;
  };

  /**
   * Does a block open on this entry's line? That is what separates an object (`MeshObject "{…}" {`,
   * `UIInfo SCR_ActionUIInfo "…" : "…" {`) from a member whose value merely looks like one of those
   * tokens — `ID "508AB2013EEE1E00"` is 16 hex digits, so its value is a *GUID token*, not the slot
   * of an object that never opens.
   */
  const hasBlockAhead = (from, line) => {
    for (let k = from; k < tokens.length; k++) {
      const t = tokens[k];
      if (t.line !== line) return false;
      if (t.type === "{") return true;
      if (t.type === "ident" || t.type === "string" || t.type === "guid" || t.type === "ref" || t.type === ":" || t.type === "+") continue;
      return false;
    }
    return false;
  };

  const readItem = () => {
    const first = peek();
    if (first.type === "{") {
      const block = readBlock();
      return { kind: "element", spec: [], value: block, line: first.line };
    }
    if (first.type !== "ident" && first.type !== "string") {
      return { kind: "element", spec: [], value: readValue(), line: first.line };
    }
    if (first.type === "string" && !stringIsName()) {
      return { kind: "element", spec: [], value: readValue(), line: first.line };
    }
    return readNamed();
  };

  const readNamed = () => {
    const nameToken = next();
    const name = nameToken.value;
    const quoted = nameToken.type === "string";
    const line = nameToken.line;
    const spec = [];
    let append = false;
    const after = peek();
    if (!after || after.type === "}" || (after.line !== line && after.type !== "{")) {
      // Nothing follows on this line: the name *is* the value — an enum in an array.
      return {
        kind: "element",
        spec: [],
        value:
          nameToken.type === "string"
            ? { kind: "string", value: name, raw: nameToken.raw, pieces: 1, line }
            : { kind: "ident", value: name, line },
        line,
      };
    }
    if (!hasBlockAhead(i, line)) {
      if (peek()?.type === ":") {
        throw fail(`member ${JSON.stringify(name)} has no value: it names a parent but opens no block`);
      }
      return { kind: "member", name, quoted, append, spec, value: bspMember(name, readValue()), line };
    }
    for (;;) {
      const t = peek();
      if (!t) throw fail(`member ${JSON.stringify(name)} has no value: the file ends inside its block`);
      if (t.type === "{") {
        const block = readBlock();
        const value = spec.length
          ? objectFrom(spec, block, line, nameToken)
          : { type: "block", items: block.items, line: block.line };
        return { kind: "member", name, quoted, append, spec, value, line };
      }
      if (t.type === "+") {
        append = true;
        next();
        continue;
      }
      if (t.type === ":") {
        next();
        const after = peek();
        if (after?.type === "ref") {
          const ref = next();
          spec.push({ type: "ref", guid: ref.guid, path: ref.path, quoted: ref.quoted, role: "parent" });
        } else if (after?.type === "ident" || after?.type === "string") {
          // A parent that is a *class*, not a resource. `.meta` writes a platform variant this way
          // (`EntityTemplateResourceClass XBOX_ONE : PC`), and `.et`/`.conf`/`.ct` never do.
          const token = next();
          spec.push({ type: "ident", value: token.value, raw: token.raw, role: "parentClass" });
        } else {
          throw fail('expected a "{GUID}path" reference or a class name after ":"');
        }
        continue;
      }
      if (t.type === "ident" || t.type === "string" || t.type === "guid" || t.type === "ref") {
        const token = next();
        if (token.type === "guid") spec.push({ type: "guid", guid: token.guid });
        else if (token.type === "ref") spec.push({ type: "ref", guid: token.guid, path: token.path, quoted: token.quoted, role: "value" });
        else spec.push({ type: token.type, value: token.value, raw: token.raw });
        continue;
      }
      throw fail(`member ${JSON.stringify(name)} — unexpected "${t.type}"`);
    }
  };

  function objectFrom(spec, block, line, nameToken) {
    const idents = spec.filter((x) => x.type === "ident");
    const strings = spec.filter((x) => x.type === "string");
    const guid = spec.find((x) => x.type === "guid") ?? null;
    const parent = spec.find((x) => x.type === "ref" && x.role === "parent") ?? null;
    const parentClass = spec.find((x) => x.type === "ident" && x.role === "parentClass") ?? null;
    const reference = spec.find((x) => x.type === "ref" && x.role === "value") ?? null;
    // Which token is the class cannot be decided syntactically: `MeshObject "{GUID}"` is a class
    // and a slot, `UIInfo SCR_ActionUIInfo "{GUID}"` a member and a class, and `SCR_HitZone Default`
    // a class and a name. The rule that fits every shape in the corpus: a slot GUID means the spec's
    // ident is the class (a member holding an object), and without one the entry's own name is.
    let className = null;
    let objectName = null;
    if (idents.length && guid) {
      className = idents[0].value;
      objectName = idents[1]?.value ?? strings[0]?.value ?? null;
    } else if (idents.length) {
      className = nameToken.type === "ident" ? nameToken.value : null;
      objectName = idents[0].value;
    } else {
      className = nameToken.type === "ident" ? nameToken.value : null;
      objectName = strings[0]?.value ?? null;
    }
    return {
      type: "object",
      className,
      objectName,
      guid: guid?.guid ?? null,
      parent: parent
        ? { guid: parent.guid, path: parent.path }
        : parentClass
          ? { guid: null, path: null, className: parentClass.value }
          : null,
      reference: reference ? { guid: reference.guid, path: reference.path } : null,
      specs: spec,
      block,
      line,
    };
  }

  const first = peek();
  if (!first) return { roots: [], starts: [], text };
  const readRoot = () => {
    const classToken = next();
    let rootName = null;
    let rootGuid = null;
    let self = null;
    let parent = null;
    // 33 files write their own resource reference here: `Class "{GUID}ownpath" : "{GUID}parent"`.
    if (peek()?.type === "ref" && peek().line === classToken.line) {
      const own = next();
      self = { guid: own.guid, path: own.path };
    }
    if (peek()?.type === "guid" && peek().line === classToken.line) rootGuid = next().guid;
    if (peek()?.type === "string" && peek().line === classToken.line) rootName = next().value;
    // A world `.layer` writes its root name unquoted — `GenericWorldEntity world { … }` — while `.et`,
    // `.conf`, `.ct`, `.layout`, `.meta` and `.gproj` quote it or leave it out.
    if (peek()?.type === "ident" && peek().line === classToken.line) rootName = next().value;
    if (peek()?.type === ":" && peek().line === classToken.line) {
      const after = peek(1);
      if (after?.type === "ref") {
        next();
        const ref = next();
        parent = { guid: ref.guid, path: ref.path, quoted: ref.quoted !== false };
      } else if (after?.type === "ident") {
        // A root that inherits a *class* rather than a resource — see `objectFrom`.
        next();
        parent = { guid: null, path: null, className: next().value };
      }
    }
    return {
      type: "object",
      className: classToken.value,
      name: rootName,
      guid: rootGuid,
      self,
      parent,
      block: readBlock(),
      line: classToken.line,
      source: source ?? null,
      bytes: bytes?.length ?? Buffer.byteLength(text),
      lines: text.split("\n").length,
    };
  };

  /**
   * A `.layer` is a **sequence** of roots — `GenericWorldEntity world { … }` then `GenericTerrainEntity
   * Terrain { … }` — and every other extension holds one. The loop is here because the sequence is
   * the format's shape, not an anomaly: `parseText` refuses more than one, `parseRoots` returns them
   * all, and both report the same place when the bytes are wrong.
   */
  const roots = [];
  const starts = [];
  for (;;) {
    const t = peek();
    if (!t) break;
    if (t.type !== "ident" && t.type !== "string") {
      throw fail(`expected an object class, found "${t.type}"`, t);
    }
    starts.push(t.at);
    const root = readRoot();
    root.index = roots.length;
    roots.push(root);
  }
  return { roots, starts, text };
}

/**
 * The roots a document holds, in file order, each carrying its `index`: 0 for the first. A `.layer`
 * that writes several roots is read whole; every other extension, and a single-root layer, yields
 * one. This is what `tools/layer.mjs` is built on — the reader itself never had a second parser.
 */
export function parseRoots(input, options = {}) {
  return parseAll(input, options).roots;
}

/**
 * One root object — the shape every `.et`, `.conf`, `.ct`, `.layout`, `.meta`, `.gproj` and a
 * single-root `.layer` has. A document that writes several roots is refused here by name, because a
 * caller that asked for *the* object would otherwise silently get the first; `parseRoots` (and
 * `tools/layer.mjs`) reads them all.
 */
export function parseText(input, options = {}) {
  const { roots, starts, text } = parseAll(input, options);
  const name = options.name ?? "<text>";
  if (roots.length === 1) return roots[0];
  if (roots.length === 0) {
    throw new ConfSyntaxError(name, "the file is empty: an object class is expected", text, text.length);
  }
  throw new ConfSyntaxError(
    name,
    "unexpected content after the closing brace of the root object — a file of this format holds one " +
      "object, and a world `.layer` that writes several is not one of them (tools/layer.mjs reads them all)",
    text,
    starts[1],
  );
}

// ---------------------------------------------------------------------------
// Reading a source
// ---------------------------------------------------------------------------

/** Read one `.et` / `.conf` / `.ct` from disk. */
export function readDocument(path, { name = path } = {}) {
  return parseText(readFileSync(path), { name, source: path });
}

/**
 * Expand the sources a command line names into concrete specs — a file, or a `.pak` entry.
 *
 * A directory becomes every document under it, sorted, filtered by `extensions` when `--ext` asked
 * for that; when `multi` is false a directory is refused with the commands that take one.
 */
export function expandSources(specs, { noPakPathSplit = false, multi = false, extensions = EXTENSIONS } = {}) {
  const parsed = [];
  for (const spec of specs) {
    const source = parseSourceSpec(spec, { noPakPathSplit });
    if (source.kind === "file" && existsSync(source.path) && statSync(source.path).isDirectory()) {
      if (!multi) {
        throw inputError(`${source.display} is a directory, and this command reads one document — name a file inside it`, {
          source: source.display,
          hint: "info, check, refs and find take a directory and read every document under it",
        });
      }
      const documents = documentsUnder(source.path, { extensions });
      if (!documents.length) {
        const wanted = [...extensions].join(", ");
        throw inputError(`${source.display}: no document under it — a directory source reads ${wanted}`, {
          source: source.display,
          hint: extensions === EXTENSIONS ? null : "the filter is --ext; drop it to read every extension",
        });
      }
      for (const file of documents) parsed.push(parseSourceSpec(file, { noPakPathSplit }));
      continue;
    }
    checkSourceExtension(source);
    parsed.push(source);
  }
  return parsed;
}

/** Read one expanded source, with the paks the caller has already opened. */
function readSource(spec, index, paks) {
  let bytes;
  try {
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
        // `!` is what an earlier tool used, so name the rule instead of reporting a missing file.
        if (err.code === "ENOENT" && spec.path.includes("!")) {
          throw new Error(`${spec.path}: no such file — the pak/entry separator is ":", not "!": write <pak>:<entry>`);
        }
        throw err;
      }
    }
  } catch (err) {
    // Every failure while reading a source names the source, so a caller does not have to guess
    // which of several sources went wrong.
    if (err.source === undefined) err.source = spec.display ?? spec.path ?? spec.pak;
    throw err;
  }
  const doc = parseText(bytes, { name: spec.display, source: spec.display });
  return {
    source: {
      index,
      kind: spec.kind,
      display: spec.display,
      pak: spec.pak ?? null,
      entry: spec.entry ?? null,
      path: spec.path ?? null,
      bytes: bytes.length,
      lines: doc.lines,
    },
    doc,
  };
}

/**
 * Read expanded sources, opening each `.pak` once and closing it before returning.
 *
 * With `lenient`, a source that cannot be read or parsed is returned as a failure — `{ source,
 * code, message, line?, column? }` — instead of stopping the run: an audit that dies on the first
 * commented `.layout` in a mod cannot audit the mod. Paks are closed either way: the documents are
 * already in memory.
 */
export function readDocuments(sources, { lenient = false } = {}) {
  const paks = new Map();
  const docs = [];
  const failures = [];
  try {
    sources.forEach((spec, index) => {
      try {
        docs.push(readSource(spec, index, paks));
      } catch (err) {
        if (!lenient) throw err;
        failures.push({
          source: spec.display,
          code: err.code ?? "IO",
          message: err.message,
          line: err.line ?? null,
          column: err.column ?? null,
        });
      }
    });
  } finally {
    for (const pak of paks.values()) pak.close();
  }
  return { docs, failures };
}

/** Read the sources the command line names; throws on the first that cannot be read. */
export function openDocuments(specs, options = {}) {
  return readDocuments(expandSources(specs, options)).docs;
}

/**
 * The resource identity a Workbench project keeps **beside** a file: `X.et` has `X.et.meta`, whose
 * `Name "{GUID}path"` is the GUID the build moves into `resourceDatabase.rdb`. A shipped resource
 * has no `.meta`; a project on disk always does — which is how a mod with no `.pak` still has an
 * identity, and why `chain` can name a GUID for a file no database mentions.
 *
 * Returns `{ guid, path }`, or `null` when the file has no readable `.meta`.
 */
export function metaOf(filePath) {
  const metaPath = `${filePath}.meta`;
  let doc;
  try {
    doc = parseText(readFileSync(metaPath), { name: metaPath, source: metaPath });
  } catch {
    return null;
  }
  const name = valueOf(doc, "Name");
  if (!name || name.kind !== "ref") return null;
  return { guid: name.guid, path: name.path };
}

/**
 * The resource GUID of one document, and the databases that declare it.
 *
 * `loaded` is a `DocumentLoader` result (`{ path, resourcePath, file, from }`), or a descriptor of
 * the same shape for the command's own source. `db` is the dictionary `openRdbFiles` gives, or
 * `null` when no `--rdb` was passed. The database wins, because that is what the engine reads; the
 * `.meta` is the fallback, and the only identity a project on disk has.
 *
 * `rdbs` are **0-based** indices into the merged set, in override order — `tools/rdb.mjs`'s
 * convention, which the command line prints from 1.
 */
export function identityOf(loaded, db = null) {
  if (!loaded) return null;
  const meta = loaded.from === "file" && loaded.file ? metaOf(loaded.file) : null;
  const resourcePath = loaded.resourcePath ?? meta?.path ?? null;
  let guid = null;
  let rdbs = [];
  if (db && resourcePath) {
    const found = db.byPath?.get(resourcePath.toLowerCase()) ?? null;
    if (found) {
      guid = found;
      rdbs = db.resolve?.(found)?.rdbs ?? [];
    }
  }
  if (!guid && meta) guid = meta.guid;
  if (!guid) return null;
  return { guid, rdbs, from: rdbs.length ? "rdb" : "meta" };
}

/**
 * How the chain names one step: `{GUID}path` when its identity is known, `"path"` when it is not.
 * One helper, so a warning and the row it is about spell a resource the same way.
 */
function resourceLabel(identity, path) {
  return identity?.guid ? `{${identity.guid}}${path}` : `"${path}"`;
}

/**
 * Resolve resource paths to documents while walking a prefab's inheritance chain.
 *
 * The search order is the **override order**: the first hit wins.
 *
 *   1. every `--addon` directory — a mod project on disk, which has no `.pak` yet;
 *   2. every `.pak` given (a directory contributes its `*.pak` files, sorted) — the source's own
 *      archive first, then `--pak` in command-line order;
 *   3. on disk, under each of `roots` — the ancestors of the source file, nearest first — so a file
 *      that sits beside the one referencing it is found without any option.
 *
 * `load(path)` answers the first copy — `{ path, resourcePath, file, container, from, doc }` — or
 * `null`; `loadAll(path)` answers every copy, which is what makes an override visible. Paks are
 * opened lazily; `close()` is the caller's job.
 */
export class DocumentLoader {
  constructor({ paks = [], addons = [], roots = [], noPakPathSplit = false } = {}) {
    this.noPakPathSplit = noPakPathSplit;
    this.addons = addons.map((dir) => resolvePath(dir));
    this.roots = roots.map((dir) => resolvePath(dir));
    this.pakPaths = [];
    this.dirs = [];
    for (const p of paks) {
      if (!p) continue;
      const spec = parseSourceSpec(p, { noPakPathSplit });
      const target = spec.kind === "pak" ? spec.pak : spec.path;
      if (existsSync(target) && statSync(target).isDirectory()) this.dirs.push(target);
      else this.pakPaths.push(target);
    }
    this.opened = new Map();
    this.expanded = null;
  }

  open(path) {
    const key = resolvePath(path).toLowerCase();
    let pak = this.opened.get(key);
    if (!pak) {
      pak = openPak(path);
      this.opened.set(key, pak);
    }
    return pak;
  }

  /** Every `.pak` this loader searches, in order. Directories are expanded once. */
  paks() {
    if (!this.expanded) {
      this.expanded = [...this.pakPaths];
      for (const dir of this.dirs) {
        let names = [];
        try {
          names = readdirSync(dir).filter((n) => /\.pak$/i.test(n)).sort();
        } catch {
          names = [];
        }
        for (const n of names) this.expanded.push(join(dir, n));
      }
    }
    return this.expanded;
  }

  /** The containers to search, in override order: the addons, the paks, the source's ancestors. */
  containers() {
    const out = [];
    const seen = new Set();
    const add = (container) => {
      const key = (container.kind === "pak" ? container.file : container.root).toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(container);
    };
    for (const root of this.addons) add({ kind: "dir", root });
    for (const file of this.paks()) add({ kind: "pak", file });
    for (const root of this.roots) add({ kind: "dir", root });
    return out;
  }

  /** Every copy of one resource path in the order searched; the first one is the one that wins. */
  loadAll(resourcePath) {
    const wanted = normalisePath(String(resourcePath ?? ""));
    if (!wanted) return [];
    const out = [];
    const seenFiles = new Set();
    for (const container of this.containers()) {
      if (container.kind === "pak") {
        let pak;
        try {
          pak = this.open(container.file);
        } catch {
          continue;
        }
        let entry = null;
        try {
          entry = findEntry(pak, wanted);
        } catch {
          entry = null;
        }
        if (!entry) continue;
        const display = `${container.file}:${entry.path}`;
        out.push({
          path: display,
          resourcePath: entry.path,
          file: display,
          container: container.file,
          from: "pak",
          doc: parseText(pak.read(entry), { name: display, source: entry.path }),
        });
        continue;
      }
      const candidate = join(container.root, wanted);
      if (!existsSync(candidate) || !statSync(candidate).isFile()) continue;
      const key = resolvePath(candidate).toLowerCase();
      if (seenFiles.has(key)) continue;
      seenFiles.add(key);
      out.push({
        path: candidate,
        resourcePath: wanted,
        file: candidate,
        container: container.root,
        from: "file",
        doc: readDocument(candidate),
      });
    }
    return out;
  }

  load(resourcePath) {
    return this.loadAll(resourcePath)[0] ?? null;
  }

  /** Where the loader looks, for the error that says a parent was not found. */
  describeSearch() {
    const parts = [];
    const paks = this.paks();
    if (paks.length) parts.push(`${paks.length} .pak archive(s)`);
    if (this.addons.length) parts.push(`${this.addons.length} addon director${this.addons.length === 1 ? "y" : "ies"}`);
    if (this.roots.length) parts.push(`${this.roots.length} director${this.roots.length === 1 ? "y" : "ies"} above the source`);
    return parts.join(", ") || "nowhere";
  }

  close() {
    for (const pak of this.opened.values()) pak.close();
    this.opened.clear();
  }
}

/** The directories from the file's own folder up to the root, nearest first. */
export function ancestorRoots(filePath) {
  const out = [];
  let dir = dirname(resolvePath(filePath));
  for (;;) {
    out.push(dir);
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Querying a document
// ---------------------------------------------------------------------------

/** The block a document, block or object holds. */
export function blockOf(node) {
  if (!node) return null;
  if (node.type === "block") return node;
  if (node.type === "object") return node.block;
  return null;
}

/** Named entries of a block, in file order; `name` narrows to one name. */
export function membersOf(block, name = null) {
  const items = blockOf(block)?.items ?? [];
  return items.filter((item) => item.kind === "member" && (name === null || item.name === name));
}

/** The first member with that name, or `null`. */
export function memberOf(block, name) {
  return membersOf(block, name)[0] ?? null;
}

/** The value of the first member with that name, or `null`. */
export function valueOf(block, name) {
  return memberOf(block, name)?.value ?? null;
}

/**
 * Resolve a `/`-separated path inside a document.
 *
 * A segment is a member name (`components`), a repeated name (`components[2]` is the third member
 * called `components`), or a position in the block reached so far (`#3`, 0-based — which is how a
 * component list is indexed: `components/#0`). Returns `{ found, value, entry, missing }`.
 */
export function lookup(node, path) {
  const segments = String(path)
    .split("/")
    .map((s) => s.trim())
    .filter((s) => s.length);
  let current = node;
  let entry = null;
  for (const segment of segments) {
    const block = blockOf(current);
    if (!block) return { found: false, value: null, entry: null, missing: segment };
    let item = null;
    const positional = /^#(\d+)$/.exec(segment);
    if (positional) item = block.items[Number(positional[1])] ?? null;
    else {
      // A name may be quoted as the file spells it: `"Sort Priority"` and `Sort Priority` are the
      // same member.
      const named = /^(?:"(.*)"|(.*?))(?:\[(\d+)\])?$/.exec(segment);
      const wanted = named[1] ?? named[2];
      const index = named[3] === undefined ? 0 : Number(named[3]);
      item = block.items.filter((x) => x.kind === "member" && x.name === wanted)[index] ?? null;
    }
    if (!item) return { found: false, value: null, entry: null, missing: segment };
    entry = item;
    current = item.value;
  }
  return { found: true, value: current, entry, missing: null };
}

/** Walk every entry depth-first, with its path and depth. */
export function walk(node, visit, { path = "", depth = 0 } = {}) {
  const block = blockOf(node);
  if (!block) return;
  for (const [index, item] of block.items.entries()) {
    const segment = item.kind === "member" ? item.name : `#${index}`;
    const itemPath = path ? `${path}/${segment}` : segment;
    visit(item, { path: itemPath, index, depth });
    walk(item.value, visit, { path: itemPath, depth: depth + 1 });
  }
}

/**
 * The components of a prefab: the entries of the top-level `components` block.
 *
 * Inside that block every entry is a class followed by its slot GUID, so the class is the first
 * ident — the entry's own name (`MeshObject "…"`) or the first token of its spec (`Class "…"`).
 * `derived` is the `.ct` or prefab the component inherits from, when it does.
 */
export function componentsOf(doc) {
  const block = blockOf(valueOf(doc, "components"));
  if (!block) return [];
  return block.items.map((item) => {
    const object = item.value?.type === "object" ? item.value : null;
    return {
      className: object?.className ?? item.name,
      name: object?.objectName ?? null,
      guid: object?.guid ?? null,
      derived: object?.parent ?? null,
      entries: object?.block.items.length ?? 0,
      block: object?.block ?? null,
      line: item.line,
    };
  });
}

/**
 * Every resource reference the file writes, in file order:
 * `{ guid, path, line, where, member, quoted }`.
 *
 * `where` is `derivation` (a `:` parent, including the root's), `value` (a member whose value is a
 * reference), `element` (an array element) or `reference` (an object's own resource, written
 * without `:`). `member` is the path to the entry that carries it. The root's *self* reference —
 * `Class "{GUID}ownpath"` — is identity, not a reference, and is not listed here (`doc.self` is).
 */
export function refsOf(doc) {
  const out = [];
  if (doc.parent) {
    out.push({
      guid: doc.parent.guid,
      path: doc.parent.path,
      line: doc.line,
      where: "derivation",
      member: "",
      quoted: doc.parent.quoted !== false,
    });
  }
  walk(doc, (item, at) => {
    for (const token of item.spec ?? []) {
      if (token.type !== "ref") continue;
      out.push({
        guid: token.guid,
        path: token.path,
        line: item.line,
        where: token.role === "parent" ? "derivation" : "reference",
        member: at.path,
        quoted: token.quoted !== false,
      });
    }
    const value = item.value;
    if (value?.kind === "ref") {
      out.push({
        guid: value.guid,
        path: value.path,
        line: value.line ?? item.line,
        where: item.kind === "member" ? "value" : "element",
        member: at.path,
        quoted: value.quoted !== false,
      });
    } else if (value?.kind === "refs") {
      for (const ref of value.value) {
        out.push({
          guid: ref.guid,
          path: ref.path,
          line: value.line ?? item.line,
          where: item.kind === "member" ? "value" : "element",
          member: at.path,
          quoted: ref.quoted !== false,
        });
      }
    }
  });
  return out;
}

/**
 * What a block holds: `array` (only values), `objects` (only entries that carry a class or a slot
 * GUID — a component list or an array of objects), `object` (only named members), `mixed`, `empty`.
 */
export function classify(block) {
  const items = blockOf(block)?.items ?? [];
  if (!items.length) return "empty";
  if (items.every((x) => x.kind === "element")) return "array";
  if (items.every((x) => x.kind === "member" && x.spec.length)) return "objects";
  if (items.every((x) => x.kind === "member")) return "object";
  return "mixed";
}

/** Depth of the deepest block in a document. */
export function depthOf(node) {
  const block = blockOf(node);
  if (!block || !block.items.length) return 0;
  let max = 0;
  for (const item of block.items) max = Math.max(max, depthOf(item.value));
  return 1 + max;
}

/** Counts a reader usually wants first: entries, components, references, depth. */
export function describe(doc) {
  let members = 0;
  let elements = 0;
  walk(doc, (item) => {
    if (item.kind === "member") members++;
    else elements++;
  });
  const components = componentsOf(doc);
  const id = valueOf(doc, "ID");
  return {
    source: doc.source,
    className: doc.className,
    name: doc.name,
    id: id?.kind === "string" ? id.value : null,
    self: doc.self ?? null,
    parent: doc.parent,
    entries: doc.block.items.length,
    members,
    elements,
    components: components.length,
    componentsWithSlot: components.filter((c) => c.guid).length,
    componentsDerived: components.filter((c) => c.derived).length,
    refs: refsOf(doc).length,
    depth: depthOf(doc),
    bytes: doc.bytes,
    lines: doc.lines,
  };
}

/**
 * Walk the inheritance chain: this document, its `: "{GUID}path"` parent, and so on.
 *
 * `load(path)` is the caller's job (the CLI passes a `DocumentLoader`), so the library does not
 * decide where a prefab lives. `resolve(guid)` — optional — turns the GUID into the path to follow;
 * without it the path written in the file is used, and every row says which one it used
 * (`via: "rdb" | "path"`). A contradiction between the two is reported; a cycle is stopped.
 *
 * **Identity is not in the document.** `identify(loaded)` — optional — answers the resource GUID and
 * the databases that declare it (`identityOf` does it for the CLI); the row field is `identity`, and
 * `memberId` is the document's own `ID` member, which a derived prefab inherits from its parent and
 * therefore cannot identify a step.
 *
 * `copies(loaded)` — optional — answers every copy of that resource in every container searched
 * (`[{ parent, container }]`). When two copies of one resource name **different parents**, the chain
 * depends on mount order, so the walk stops with `Multiple parents detected at …` and an error.
 *
 * A parent whose **file extension** differs from the target's is a `warning` — `In resource … parent
 * … has different extension, it seems broken` — because a prefab derives from a prefab: not one of
 * the 21 994 shipped `.et`, `.conf` and `.ct` breaks that. Those warnings are also collected in
 * `warnings`, so a caller can list them without filtering `problems`.
 *
 * `max` is a **limit the caller asked for**, so hitting it is not a defect: the result carries
 * `truncated: true` and an `info` problem, and only a chain that cannot be followed at all is an
 * `error`.
 */
export function inheritance(doc, { load, resolve = null, max = 64, self = null, identify = null, copies = null, where = null } = {}) {
  const start = self ?? { path: doc.source, doc };
  const rows = [
    {
      depth: 0,
      path: start.path,
      className: doc.className,
      memberId: valueOf(doc, "ID")?.value ?? null,
      parent: doc.parent,
      via: null,
      identity: identify ? (identify(start) ?? null) : null,
      loaded: start,
      doc,
    },
  ];
  const problems = [];
  let truncated = false;
  const seen = new Set([normalisePath(String(doc.source ?? "")).toLowerCase()]);

  // A prefab derives from a prefab, a config from a config: not one of the 21 994 shipped `.et`,
  // `.conf` and `.ct` names a parent with another extension, so a differing one is a broken
  // resource rather than a rule of the format. The extension of the **target** is the reference,
  // whatever the extension of the step that names the parent.
  const extensionWarnings = [];
  const targetExtension = extname(String(start.resourcePath ?? doc.source ?? "")).toLowerCase();

  /** The copies that disagree about who the parent is, or `null`. */
  const disagreeingParents = (row) => {
    if (!copies || !row.loaded) return null;
    let found;
    try {
      found = copies(row.loaded);
    } catch {
      return null;
    }
    if (!found || found.length < 2) return null;
    const groups = new Map();
    for (const copy of found) {
      const key = copy.parent ? `${copy.parent.guid}|${normalisePath(copy.parent.path).toLowerCase()}` : "";
      let group = groups.get(key);
      if (!group) {
        group = { parent: copy.parent, containers: [] };
        groups.set(key, group);
      }
      group.containers.push(copy.container);
    }
    return groups.size > 1 ? [...groups.values()] : null;
  };

  const ambiguous = (row) => {
    const groups = disagreeingParents(row);
    if (!groups) return false;
    const resourcePath = row.loaded?.resourcePath ?? row.path;
    const at = resourceLabel(row.identity, resourcePath);
    const rdbs = row.identity?.rdbs?.length > 1 ? ` in rdbs ${row.identity.rdbs.map((i) => i + 1).join(",")}` : "";
    const each = groups
      .map((g) => `${g.parent ? `"{${g.parent.guid}}${g.parent.path}"` : "(no parent)"} (${g.containers.join(", ")})`)
      .join(" and ");
    problems.push({
      severity: "error",
      message: `Multiple parents detected at ${at}${rdbs}: ${each} — which one applies depends on the mount order`,
    });
    return true;
  };

  let current = doc;
  if (!ambiguous(rows[0])) {
    while (current?.parent) {
      if (rows.length > max) {
        truncated = true;
        problems.push({ severity: "info", message: `stopped after ${max} step(s): the chain is longer` });
        break;
      }
      let target = null;
      let via = "path";
      if (!current.parent.guid && !current.parent.path && current.parent.className) {
        problems.push({
          severity: "info",
          message: `the parent is the class "${current.parent.className}", not a resource — the chain ends here`,
        });
        break;
      }
      if (resolve) {
        const fromRdb = resolve(current.parent.guid);
        if (fromRdb) {
          target = fromRdb;
          via = "rdb";
          if (current.parent.path && normalisePath(current.parent.path).toLowerCase() !== normalisePath(fromRdb).toLowerCase()) {
            problems.push({
              severity: "warning",
              message: `"{${current.parent.guid}}${current.parent.path}" contradicts the database, which names "${fromRdb}" — following the GUID`,
            });
          }
        }
      }
      if (!target) target = current.parent.path;
      if (!target) {
        problems.push({ severity: "error", message: `the parent at depth ${rows.length} has a GUID but no path, and no database resolves it` });
        break;
      }
      const loaded = load ? load(target) : null;
      if (!loaded) {
        // Name where it looked: "not found" alone leaves the caller guessing whether the archive is
        // wrong or the search was too small, and the answer is usually the second.
        const searched = where ? ` — searched ${where()}` : "";
        problems.push({ severity: "error", message: `parent "${target}" was not found${searched}` });
        rows.push({ depth: rows.length, path: target, className: null, memberId: null, parent: null, via, identity: null, loaded: null, doc: null });
        break;
      }
      const key = normalisePath(loaded.path).toLowerCase();
      if (seen.has(key)) {
        problems.push({ severity: "error", message: `the chain loops back to "${loaded.path}"` });
        break;
      }
      seen.add(key);
      const parentIdentity = identify ? (identify(loaded) ?? null) : null;
      if (targetExtension) {
        const parentPath = loaded.resourcePath ?? target;
        const parentExtension = extname(String(parentPath)).toLowerCase();
        if (parentExtension && parentExtension !== targetExtension) {
          const child = rows[rows.length - 1];
          const warning = {
            severity: "warning",
            message:
              `In resource ${resourceLabel(child.identity, child.loaded?.resourcePath ?? child.path)} ` +
              `parent ${resourceLabel(parentIdentity, parentPath)} has different extension, it seems broken`,
          };
          problems.push(warning);
          extensionWarnings.push(warning);
        }
      }
      const row = {
        depth: rows.length,
        path: loaded.path,
        className: loaded.doc.className,
        memberId: valueOf(loaded.doc, "ID")?.value ?? null,
        parent: loaded.doc.parent,
        via,
        identity: parentIdentity,
        loaded,
        doc: loaded.doc,
      };
      rows.push(row);
      if (ambiguous(row)) break;
      current = loaded.doc;
    }
  }
  return { rows, problems, truncated, warnings: extensionWarnings };
}

/**
 * The defects this reader can prove, plus — when `byGuid`/`byPath` are given — the ones only a
 * resource database can see. `severity: "error"` means the file contradicts itself.
 *
 * `byGuid` is a `Map` of GUID to path; `byPath` a `Map` of lowercased path to GUID (what
 * `reverseRdb` gives). Both come from `tools/rdb.mjs` in the CLI, and a caller can pass its own.
 */
export function checkDocument(doc, { byGuid = null, byPath = null, extension = null } = {}) {
  const problems = [];
  const add = (severity, message, line = null) => problems.push({ severity, message, line });

  // `ID` is a prefab family's editor-assigned id *for the three document kinds that are a prefab*.
  // A `.gproj` writes its addon id there (`ID "ArmaReforger"`), and a `.meta`/`.layout` has other
  // things to say, so the 16-hex rule is not theirs — it used to fire on every Workbench project.
  const ext = (extension ?? extname(String(doc.source ?? ""))).toLowerCase();
  const idIsAPrefabId = !ext || [".et", ".conf", ".ct"].includes(ext);
  if (idIsAPrefabId) {
    const id = memberOf(doc, "ID");
    if (id && !(id.value.kind === "string" && ID_SHAPE.test(id.value.value))) {
      add("warning", `ID is ${formatValue(id.value)}, not 16 hexadecimal digits — the shipped writer always writes 16`, id.line);
    }
  }

  // Duplicate member names in one block: the engine keeps one of them, and no shipped file has one.
  // Two kinds of block are exempt, because repetition is their point: an entry that carries a class
  // or a slot GUID is an object (an array element, a component), and a block that is itself an
  // *element* is a child list — `{ Building {…} Building {…} }` is a street of buildings, not a
  // member defined twice.
  const checkBlock = (block, path) => {
    const seen = new Map();
    for (const child of block.items) {
      if (child.kind !== "member" || child.spec.length) continue;
      if (seen.has(child.name)) {
        add(
          "error",
          `duplicate member ${JSON.stringify(child.name)} at line ${child.line}, already defined at line ${seen.get(child.name)}` +
            (path ? ` in "${path}"` : " in the root object"),
          child.line,
        );
      } else seen.set(child.name, child.line);
    }
  };
  const visitBlock = (block, path, isMemberBlock) => {
    if (isMemberBlock) checkBlock(block, path);
    for (const [index, item] of block.items.entries()) {
      const inner = blockOf(item.value);
      if (!inner) continue;
      const segment = item.kind === "member" ? item.name : `#${index}`;
      visitBlock(inner, path ? `${path}/${segment}` : segment, item.kind === "member");
    }
  };
  visitBlock(doc.block, "", true);

  // A `BSP` whose integers do not form a tree. The document parses, and the tree it claims to hold
  // is not one — which is why every reader shows the reason instead of a node count, and why this
  // is an error rather than a count a reader would have to trust.
  const visitBsp = (block) => {
    for (const child of block.items) {
      if (child.kind === "member" && child.value?.kind === "bsp" && child.value.error) {
        add("error", `BSP at line ${child.line} holds no tree: ${child.value.error}`, child.line);
      }
      const inner = blockOf(child.value);
      if (inner) visitBsp(inner);
    }
  };
  visitBsp(doc.block);

  if (doc.self && byGuid) {
    const target = byGuid.get(doc.self.guid) ?? null;
    if (!target) add("error", `the document names itself "${doc.self.path}", but no resource has the GUID ${doc.self.guid}`, doc.line);
    else if (normalisePath(target).toLowerCase() !== normalisePath(doc.self.path).toLowerCase()) {
      add("error", `the document names itself "{${doc.self.guid}}${doc.self.path}", but that GUID is "${target}"`, doc.line);
    }
  }

  for (const ref of refsOf(doc)) {
    if (ref.quoted === false) {
      add("warning", `unquoted reference "{${ref.guid}}${ref.path}" — the shipped writer quotes every reference`, ref.line);
      continue;
    }
    if (!byGuid && !byPath) continue;
    if (byGuid) {
      const target = byGuid.get(ref.guid) ?? null;
      if (target) {
        if (normalisePath(target).toLowerCase() !== normalisePath(ref.path).toLowerCase()) {
          add("error", `"{${ref.guid}}${ref.path}" — that GUID names "${target}"`, ref.line);
        }
        continue;
      }
      // The GUID names nothing. A path that *is* in the database under another GUID is a stale
      // reference; one that is in neither is an asset the build does not ship.
      if (byPath?.has(ref.path.toLowerCase())) {
        add("error", `"{${ref.guid}}${ref.path}" — no resource has the GUID ${ref.guid}, though the path exists`, ref.line);
      } else {
        add("warning", `"{${ref.guid}}${ref.path}" — neither the GUID nor the path is in the database (editor-only or removed)`, ref.line);
      }
      continue;
    }
    if (!byPath.has(ref.path.toLowerCase())) {
      add("warning", `"{${ref.guid}}${ref.path}" is not in the resource database (editor-only or removed)`, ref.line);
    }
  }

  for (const component of componentsOf(doc)) {
    if (!component.guid) add("warning", `component ${component.className} has no slot GUID`, component.line);
  }
  return problems;
}

// ---------------------------------------------------------------------------
// Printing
// ---------------------------------------------------------------------------

/**
 * An indented outline of a document: the root, its members, and their blocks.
 *
 * `depth` limits how deep it goes (0 = no limit); `limit` caps the number of lines (0 or Infinity
 * = no cap). `clipped` says whether anything was left out, so a short outline is never mistaken
 * for a complete one.
 */
export function outline(doc, { depth = 4, limit = 200, numbers = false } = {}) {
  const maxLines = limit === Infinity ? Infinity : limit;
  const width = String(doc.lines ?? 0).length;
  const number = (line) => (numbers ? `${String(line).padStart(width)}  ` : "");
  const lines = [`${number(doc.line ?? 1)}${formatHead(doc)}`];
  let clipped = false;
  const emit = (node, indent, level) => {
    const block = blockOf(node);
    if (!block) return;
    if (depth && level >= depth && block.items.length) {
      clipped = true;
      lines.push(`${" ".repeat(indent)}${numbers ? " ".repeat(width + 2) : ""}… ${block.items.length} item(s)`);
      return;
    }
    for (const item of block.items) {
      if (lines.length >= maxLines) {
        clipped = true;
        return;
      }
      const prefix = " ".repeat(indent);
      const inner = blockOf(item.value);
      if (!inner) {
        lines.push(`${prefix}${number(item.line)}${entryLabel(item)}`);
        continue;
      }
      const label = item.kind === "member" ? formatEntry(item) : formatHead(item.value) || "{";
      lines.push(`${prefix}${number(item.line)}${label} {${inner.items.length}}`);
      emit(item.value, indent + 1, level + 1);
    }
  };
  emit(doc, 1, 0);
  return { lines, clipped, total: lines.length };
}

/** How many entries a document (or any node) holds, at every depth, so `total` can be exact. */
export function countNodes(node) {
  const block = blockOf(node);
  if (!block) return 0;
  let total = 0;
  for (const item of block.items) total += 1 + countNodes(item.value);
  return total;
}

/**
 * The document as a `--json` tree, limited the way `outline` limits its lines.
 *
 * `depth` stops the descent (0 = no limit), and `budget` — `{ left, used, cut }`, one row per entry
 * — stops the rows, so `--limit` bounds the JSON as it bounds the text and `total`/`returned` say
 * exactly how much was left out. `truncated` is `clipped || cut`.
 */
export function treeJson(node, { depth = 0, level = 0, budget = null } = {}) {
  const block = blockOf(node);
  const row = { kind: node.type === "object" ? "object" : "block", class: node.className ?? null };
  if (node.type === "object") {
    if (node.name) row.name = node.name;
    if (node.objectName) row.objectName = node.objectName;
    if (node.guid) row.guid = node.guid;
    if (node.self) row.self = node.self;
    if (node.parent) row.parent = node.parent;
  }
  row.items = block.items.length;
  if (depth && level >= depth) {
    row.clipped = block.items.length > 0;
    return row;
  }
  const entries = [];
  for (const item of block.items) {
    if (budget && budget.left <= 0) {
      budget.cut = true;
      row.clipped = true;
      break;
    }
    if (budget) {
      budget.left--;
      budget.used++;
    }
    if (item.kind === "element") {
      const inner = blockOf(item.value);
      entries.push(
        inner
          ? { kind: "element", value: treeJson(item.value, { depth, level: level + 1, budget }) }
          : { kind: "element", value: item.value },
      );
      continue;
    }
    const inner = blockOf(item.value);
    entries.push({
      kind: "member",
      name: item.name,
      ...(item.append ? { append: true } : {}),
      line: item.line,
      value: inner ? treeJson(item.value, { depth, level: level + 1, budget }) : item.value,
    });
  }
  if (entries.length) row.entries = entries;
  return row;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Read Arma Reforger text resources: .et prefabs, .conf configs, .ct component templates,
.layout UI layouts, and a Workbench project's .meta and .gproj

  node tools/etconf.mjs info       <source>... [--rdb <rdb>]... [--use-addons-rdbs] [--addon <dir>]...
                                   [--addons <root>]... [--ext <list>] [--lenient]
                                   [--limit N|0] [--json]
  node tools/etconf.mjs cat        <source> [<lines>] [--lines N] [--numbers] [--json]
  node tools/etconf.mjs tree       <source> [--depth N] [--limit N|0] [--all] [--numbers] [--json]
  node tools/etconf.mjs get        <source> <path>... [--missing-ok] [--depth N] [--numbers] [--json]
  node tools/etconf.mjs components <source> [--limit N|0] [--all] [--numbers] [--json]
  node tools/etconf.mjs refs       <source>... [--rdb <rdb>]... [--use-addons-rdbs] [--check]
                                   [--strict] [--ext <list>] [--lenient] [--limit N|0] [--all] [--json]
  node tools/etconf.mjs chain      <source> [--rdb <rdb>]... [--pak <pak|dir>]... [--addon <dir>]...
                                   [--addons <root>]... [--use-addons-rdbs] [--depth N] [--json]
  node tools/etconf.mjs find       <source>... <query> [--regex] [--in name|value|class|all]
                                   [--ext <list>] [--lenient] [--limit N|0] [--all] [--json]
  node tools/etconf.mjs check      <source>... [--rdb <rdb>]... [--use-addons-rdbs] [--strict]
                                   [--lenient] [--ext <list>] [--limit N|0] [--json]

  <source>   a file on disk, one entry inside a .pak written <pak>:<entry>, or a directory — info,
             check, refs and find read every document under it; the other commands need one. A
             resource can also be named by --guid, which needs a database

Every command takes --guid <guid> (repeatable) as an alternative source, and the container options
it can use for that are --rdb, --pak, --addon DIR, --addons ROOT and --use-addons-rdbs; --limit and
--all cap the rows, in text and in --json — refs and find still name every source they read in
"sources", because the rows index into that list, so an answer over a large corpus carries the
source table whatever the row cap is. The syntax lines above name only what each command
needs most often — the Options list below is the complete set. Two options are narrower than the
syntax lines suggest: --ext filters what a **directory** and --addons contribute, and never a document
named as a file or by --guid, and --lenient belongs to the four commands that read many documents —
info, check, refs and find — because a command that reads one has nothing left to answer with when
the document it read is skipped.

info        what the document is: class, the prefab it inherits, its resource GUID, its ID member,
            entry and component counts. Reads a directory and every addon under --addons.
cat         the file's text as stored. A range as the second word prints those lines — "cat <source>
            20", "20-30" (both ends included) or "20-" (to the end), 1-based, so a line number that
            refs, find or check just reported can be read in context. --lines N prints the first N
            lines instead; the two are not combined.
tree        an indented outline. --depth N stops after N levels (0 = no limit); --limit caps the
            lines, and a truncated outline says so.
get         the value at a path. A segment is a member name, so components/MeshObject/Object walks
            two members; components[1] is the second member called components, and components/#1
            is the second component. A missing path exits 3 (--missing-ok keeps it 0): the document
            parsed and the query was wrong, which is not the same failure as a broken file.
            --depth limits how much of a subtree is printed.
components  the components block: class, slot GUID, the .ct or prefab it inherits, entry count.
refs        every "{GUID}path" the sources write, with its line and what carries it; every source it
            is given is read, and with more than one each row names its source. With --rdb the
            GUID is resolved, and a reference whose GUID names another file than its path does is
            marked "!" — ten such references ship in the vanilla data. --check exits 1 on a
            contradiction. A reference no resource holds stays a warning (32 of those ship too, for
            editor-only assets) — the same severity check gives it; --strict fails on it as well.
chain       the inheritance chain: follow ":" parents, resolving each GUID through --rdb and
            reading the parent out of the source's .pak, the --pak archives, the --addon project
            directories, or the directories above the source file. Each step is shown by its
            **resource GUID** — from the databases, or from the .meta file a Workbench project
            keeps beside it — never by its ID member, which a derived prefab inherits from its
            parent and which therefore repeats down a chain. --depth stops earlier and says so
            (exit 0); a parent that cannot be found, a loop, or two copies of one resource naming
            different parents ("Multiple parents detected at …") is an error (exit 1). A parent
            whose file extension differs from the target's is a **warning** — "In resource …
            parent … has different extension, it seems broken" — and --json lists those in
            "warnings" as well as in "problems".
find        member names, values and class names matching a query, case-insensitively. Every source
            it is given is searched (a directory included), and with more than one the rows are
            grouped by source. The query is the last word, so a directory followed by a query works.
check       the defects this reader can prove (a duplicate member, a malformed ID, a document that
            names the wrong GUID for itself) and, with --rdb, the references whose GUID and path
            disagree. Reads a directory and every addon under --addons. Exits 1 on an error, and
            --strict makes a warning count too. info, refs and find take --lenient as well, so the
            same mod audits and answers questions without stopping at a file the format cannot read.

A source is a file, one entry of a .pak, or a directory (info, check, refs and find read every
document under it):

  node tools/etconf.mjs tree \\
    "<install>/addons/data/data007.pak:Prefabs/Props/Industrial/BarrelMetal_01_Base.et"

That split happens at the **last** colon, and only when everything before it ends in \`.pak\` — so
C:\\dir\\X.et stays a file path (its only colon is the drive's). \`--no-pak-path-split\` turns the
split off.

Read are the six extensions this format uses — .et, .conf, .ct, .layout, and a project's .meta and
.gproj — because each of them holds one object, plus .layer when it holds a single root. Not read:
a shipped .ent, which is EBIN (tools/ebin.mjs), and a .pak (name an entry) or a .c (tools/cscript.mjs).
Any other extension is refused rather than parsed as text, and the error names the reader that does
read it.

Exit is 0 on success, 1 when the input is at fault (a document that does not parse, a defect check
found, a document --lenient had to skip), 2 when the command line is (USAGE), and 3 when a get path
is not in the document (--missing-ok keeps that 0): a query that missed is not a broken file.
--strict moves the warnings into the failure set.

Options
  --limit N     maximum rows or lines to print (default 100; 0 = every one). refs and find count a
                source that produced nothing in one line once the corpus is larger than N, instead
                of listing every empty one
  --all         same as --limit 0
  --depth N     tree: how many levels to show (default 4, 0 = no limit); get: how much of a
                subtree to print (0 = no limit, as in tree); chain: the longest chain to follow
                (default 64)
  --lines N     cat: print only the first N lines
  --rdb FILE    a resourceDatabase.rdb to resolve GUIDs through; repeatable, merged in the order
                given — the first database wins an override, exactly like "rdb merge", and so does
                a copy it is searched against
  --guid GUID   read the resource with that GUID instead of a path: the database answers the path
                (--rdb or --use-addons-rdbs) and the document is then read out of the --pak archives
                and --addon directories; repeatable, so info/check/refs/find take many. Braces and
                lower case are accepted. With get, every positional is a path
  --pak PATH    an extra .pak, or a directory of them, to search for parents in chain; repeatable
  --addon DIR   a mod project directory: searched for parents in chain, the base of the resource path
                info reports, and a place --use-addons-rdbs looks; repeatable. What a modder needs:
                a Workbench addon is a tree of files on disk, with no .pak and no build, and each
                file's .meta carries its resource GUID
  --addons ROOT every directory directly under ROOT is one addon, the rule tools/cscript.mjs states
                for the same option. Their documents are sources for info, check, refs and find;
                their directories are searched like --addon; their databases are read by
                --use-addons-rdbs. Repeatable
  --use-addons-rdbs
                also resolve through the resourceDatabase.rdb beside each addon. The --rdb databases
                are asked first and an addon database fills the GUIDs they do not know — which is
                what makes a mod's own GUIDs resolve beside the vanilla ones. Each group is merged
                and checked on its own, so a set that contradicts itself is still refused, and the
                envelope's "shadowed" counts the addon records a --rdb database answered first
  --ext LIST    directory sources and --addons only: read the extensions in LIST instead of all six.
                LIST is comma-separated, the dot is optional — "--ext .et" audits a mod's prefabs and
                leaves out the .meta identity files beside them, "--ext et,conf" reads two kinds, and
                ".layer" is readable when it holds a single root. A document named as a file, or by
                --guid, is always read, whatever the filter says: it was named, not scanned
  --in WHERE    find: name, value, class or all (default all)
  --regex       find: the query is a regular expression, matched case-insensitively
  --check       refs: exit 1 on a contradiction
  --lenient     info, check, refs and find: a document that cannot be read or parsed is reported as a
                failure and the run goes on — an audit should not stop at the first commented .layout
                in a mod. Each failure is printed as a FAIL line and named in "parseFailures" under
                --json, the answer says how many documents were skipped, and the exit code is still 1
                (the document is broken). cat, tree, get, components and chain refuse the option:
                they read one document, so skipping it would leave nothing to answer with
  --strict      refs and check: a warning fails too — an unresolved reference, or any warning check
                reports. Without it a warning is reported and the exit code stays 0
  --numbers     tree, get, components and cat: print the line number beside every row, so a row can
                be read with a cat range or jumped to in an editor
  --missing-ok  get: exit 0 even when a path is not in the document
  --no-pak-path-split
                read every source as a file on disk: no <pak>:<entry> split
  --json        machine-readable output; every command answers with an envelope that names what it
                read — "source" for one document, "sources" for many, and then each row carries the
                index — and carries total/returned/truncated, never a bare array. A failure is an
                object instead — {ok:false, error:{code, message, source?, line?, column?}} on
                stdout — so a caller reads one shape either way. The codes are USAGE (the command
                line is wrong), PARSE (the document is), IO, MERGE, INPUT and ERROR.
  --compact     with --json (it implies it): print without indentation and leave out what carries no
                information — false, an empty array, an empty object — and the value-node keys that
                only repeat the node (raw when it spells the same text, pieces when there is one).
                An absent field therefore means false or empty.
`;

function usageError(message) {
  const err = new Error(message);
  err.code = "USAGE";
  err.usage = true;
  return err;
}

const OPTION_SPELLING = { missingOk: "missing-ok", noPakPathSplit: "no-pak-path-split", useAddonsRdbs: "use-addons-rdbs" };
const spell = (name) => OPTION_SPELLING[name] ?? name;

function parseArgs(argv) {
  const flags = { _: [], given: [], rdb: [], pak: [], addon: [], addons: [], guid: [], ext: [] };
  const valueOf = (option, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw usageError(`${option} needs a value`);
    return v;
  };
  const BOOLEAN = {
    "--json": "json",
    "--compact": "compact",
    "--all": "all",
    "--check": "check",
    "--strict": "strict",
    "--regex": "regex",
    "--numbers": "numbers",
    "--lenient": "lenient",
    "--use-addons-rdbs": "useAddonsRdbs",
    "--missing-ok": "missingOk",
    "--no-pak-path-split": "noPakPathSplit",
  };
  const COUNTED = { "--limit": "limit", "--depth": "depth", "--lines": "lines" };
  const MULTI = { "--rdb": "rdb", "--pak": "pak", "--addon": "addon", "--addons": "addons", "--guid": "guid", "--ext": "ext" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (Object.hasOwn(BOOLEAN, a)) {
      flags[BOOLEAN[a]] = true;
      flags.given.push(BOOLEAN[a]);
    } else if (Object.hasOwn(COUNTED, a)) {
      const raw = valueOf(a, i);
      i++;
      if (!/^\d+$/.test(raw)) throw usageError(`${a} needs a non-negative whole number, not "${raw}"`);
      flags[COUNTED[a]] = Number(raw);
      flags.given.push(COUNTED[a]);
    } else if (Object.hasOwn(MULTI, a)) {
      const raw = valueOf(a, i);
      i++;
      flags[MULTI[a]].push(raw);
      flags.given.push(MULTI[a]);
    } else if (a === "--in") {
      const raw = valueOf(a, i);
      i++;
      if (!["name", "value", "class", "all"].includes(raw)) {
        throw usageError(`--in takes name, value, class or all, not "${raw}"`);
      }
      flags.in = raw;
      flags.given.push("in");
    } else if (a === "-h" || a === "--help") flags.help = true;
    else if (a.startsWith("-") && a !== "-") throw usageError(`unknown option "${a}"`);
    else flags._.push(a);
  }
  // `--compact` selects a JSON shape, so asking for it is asking for JSON.
  if (flags.compact) flags.json = true;
  return flags;
}

const COMMAND_OPTIONS = {
  info: ["rdb", "pak", "addon", "addons", "useAddonsRdbs", "guid", "ext", "lenient", "limit", "all"],
  cat: ["lines", "numbers", "guid", "rdb", "pak", "addon", "addons", "useAddonsRdbs"],
  tree: ["depth", "limit", "all", "numbers", "guid", "rdb", "pak", "addon", "addons", "useAddonsRdbs"],
  get: ["depth", "missingOk", "numbers", "guid", "rdb", "pak", "addon", "addons", "useAddonsRdbs"],
  components: ["limit", "all", "numbers", "guid", "rdb", "pak", "addon", "addons", "useAddonsRdbs"],
  refs: ["rdb", "pak", "addon", "addons", "useAddonsRdbs", "ext", "check", "strict", "lenient", "limit", "all", "guid"],
  chain: ["rdb", "pak", "addon", "addons", "useAddonsRdbs", "depth", "guid"],
  find: ["addon", "addons", "ext", "limit", "all", "regex", "in", "lenient", "guid", "rdb", "pak", "useAddonsRdbs"],
  check: ["rdb", "pak", "addon", "addons", "useAddonsRdbs", "ext", "strict", "lenient", "guid", "limit", "all"],
};
const GLOBAL_OPTIONS = ["json", "compact", "noPakPathSplit"];

/** The commands that read one document, so a document they cannot read leaves nothing to answer with. */
const SINGLE_DOCUMENT_COMMANDS = new Set(["cat", "tree", "get", "components", "chain"]);

function checkOptions(command, flags) {
  const allowed = new Set([...COMMAND_OPTIONS[command], ...GLOBAL_OPTIONS]);
  for (const given of flags.given) {
    if (allowed.has(given)) continue;
    if (given === "lenient" && SINGLE_DOCUMENT_COMMANDS.has(command)) {
      throw usageError(
        `--lenient is for the commands that read many documents (info, check, refs, find): ${command} reads one, ` +
          "so a document it cannot read leaves nothing to answer with",
      );
    }
    throw usageError(`${command} does not take --${spell(given)}`);
  }
}

function rowLimit(flags, fallback = 100) {
  if (flags.all) return Infinity;
  if (flags.limit === undefined) return fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

function load(specs, flags, { multi = false } = {}) {
  return openDocuments([...specs, ...guidSpecs(flags)], {
    noPakPathSplit: !!flags.noPakPathSplit,
    multi,
    extensions: extensionFilter(flags),
  });
}

/**
 * The sources a command that reads a whole corpus reads: what it was given, the documents under every
 * `--addons` child, and every `--guid`.
 *
 * One place, because each of the three has been forgotten by one command or another, and the answer
 * was a clean, empty result instead of an error: `check` dropped a `--guid`, `info` ignored
 * `--addons`, and the empty-`--addons` guard then fired on a command line that did name a file.
 */
function corpusSources(specs, flags) {
  const addonSpecs = addonSourceSpecs(flags, { required: addonsAreTheOnlySource(specs, flags) });
  return expandSources([...specs, ...addonSpecs, ...guidSpecs(flags)], {
    multi: true,
    noPakPathSplit: !!flags.noPakPathSplit,
    extensions: extensionFilter(flags),
  });
}

/** Read a corpus. Without `--lenient` the first unreadable document ends the run; with it, the rest is read. */
function loadCorpus(specs, flags) {
  return readDocuments(corpusSources(specs, flags), { lenient: !!flags.lenient });
}

/** One line per document a `--lenient` run could not read, before the answer it is missing from. */
function printParseFailures(failures) {
  for (const failure of failures) {
    const detail = failure.message.startsWith(`${failure.source}: `)
      ? failure.message.slice(failure.source.length + 2)
      : failure.message;
    console.log(`FAIL  ${failure.source}: ${detail}`);
  }
}

/**
 * Say that part of the corpus was skipped, so an answer cannot read as covering everything asked for.
 *
 * `read` is how many documents the answer actually has. When it is zero the sentence must not say "the
 * rest were read", because there is no rest: a corpus where nothing parsed is the one case where the
 * answer *is* the failure list.
 */
function parseFailureFooter(failures, { read = 0 } = {}) {
  if (!failures.length) return;
  const tail = read
    ? "the rest were read, and the exit code is 1"
    : "nothing in this corpus could be read, and the exit code is 1";
  console.log(`# ${failures.length} document(s) could not be read and are not in the list above — ${tail}`);
}

/**
 * `--guid G`: the resource to read, named by its GUID instead of its path.
 *
 * The database answers the path (`--rdb`, or `--use-addons-rdbs`), and the document is then read out
 * of the containers the flags name — a `.pak` (or a directory of them) and an addon directory — the
 * same order `chain` searches in. So an agent that has a GUID from an `.ebin` world, a log line or
 * another tool does not have to resolve it by hand first.
 */
function guidSpecs(flags) {
  const guids = flags.guid ?? [];
  if (!guids.length) return [];
  const db = loadRdb(flags);
  if (!db.byGuid) {
    throw usageError("--guid needs a database to turn a GUID into a path: pass --rdb <rdb>, or --use-addons-rdbs with --addon");
  }
  const loader = new DocumentLoader({
    paks: flags.pak ?? [],
    addons: addonDirs(flags),
    roots: [],
    noPakPathSplit: !!flags.noPakPathSplit,
  });
  try {
    return guids.map((raw) => {
      const guid = String(raw).replace(/[{}]/g, "").trim().toUpperCase();
      const path = db.byGuid.get(guid) ?? null;
      if (!path) {
        throw inputError(`no resource has the GUID ${guid}`, {
          source: String(raw),
          hint: "the database[s] given do not name it; --use-addons-rdbs adds the ones beside the addons",
        });
      }
      // A GUID names any resource, not only a document: `.xob`, `.emat`, `.ptc` are assets the
      // engine loads, and parsing one as text would be a syntax error about a binary.
      const ext = extname(String(path)).toLowerCase();
      if (!READABLE_EXTENSIONS.has(ext)) {
        throw inputError(`the GUID ${guid} is ${path} — ${ext || "an extensionless resource"}, not a document this reader reads`, {
          source: String(raw),
          hint: "this reader reads .et, .conf, .ct, .layout, .meta and .gproj; a model or texture is an asset, not a document",
        });
      }
      const found = loader.load(path);
      if (!found) {
        throw inputError(`the GUID ${guid} is ${path}, but none of the --pak/--addon containers has that file`, {
          source: String(raw),
          hint: "pass --pak <pak|dir> or --addon <dir> so the document can be read",
        });
      }
      return found.path;
    });
  } finally {
    loader.close();
  }
}

function loadOne(spec, flags) {
  const docs = load(spec === undefined ? [] : [spec], flags);
  if (!docs.length) throw usageError("this command reads one document: name a source, or a --guid with --rdb");
  const [{ source, doc }] = docs;
  return { source, doc };
}

/**
 * The loadRdb body lives beside `addonRdbs` (see "the databases the flags build"), because it
 * needs both the CLI options and the addon discovery; this is the one entry point every command
 * uses.
 */

/**
 * The command's own source in the shape `load` answers, so its identity is resolved the same way
 * as every step's: a `.pak` entry carries its path, a file on disk carries the path relative to the
 * `--addon` that contains it (and no path at all when none does — its `.meta` still has one).
 */
function sourceDescriptor(source, addons) {
  if (source.kind === "pak") {
    return { path: source.display, resourcePath: source.entry, file: source.display, container: source.pak, from: "pak" };
  }
  const file = resolvePath(source.path);
  let resourcePath = null;
  for (const dir of addons) {
    const rel = relative(resolvePath(dir), file);
    if (rel && !rel.startsWith("..") && !isAbsolute(rel)) {
      resourcePath = normalisePath(rel);
      break;
    }
  }
  return { path: source.display, resourcePath, file, container: dirname(file), from: "file" };
}

function sourceRow(source) {
  return {
    index: source.index,
    kind: source.kind,
    display: source.display,
    pak: source.pak,
    entry: source.entry,
    path: source.path,
    bytes: source.bytes,
    lines: source.lines,
  };
}

/** The extension the document behind a source carries, lower-cased: `.et`, `.gproj`, `.layer`, … */
function extensionOf(source) {
  return extname(source.kind === "pak" ? source.entry : source.path ?? "").toLowerCase();
}

/** The extensions a directory source may contribute: every one this reader reads, or the --ext list. */
function extensionFilter(flags) {
  if (!flags.ext?.length) return EXTENSIONS;
  const wanted = [];
  for (const raw of flags.ext) {
    for (const piece of String(raw).split(",")) {
      const name = piece.trim().toLowerCase();
      if (!name) continue;
      const ext = name.startsWith(".") ? name : `.${name}`;
      if (!READABLE_EXTENSIONS.has(ext)) {
        throw usageError(
          `--ext takes extensions this reader reads (${EXTENSIONS.join(", ")}, .layer), not "${piece}"`,
        );
      }
      if (!wanted.includes(ext)) wanted.push(ext);
    }
  }
  if (!wanted.length) throw usageError("--ext needs at least one extension, for example --ext .et");
  return wanted;
}

/** Every document under a directory, sorted, so a run over a project is deterministic. */
export function documentsUnder(dir, { extensions = EXTENSIONS } = {}) {
  const wanted = new Set([...extensions].map((ext) => ext.toLowerCase()));
  const out = [];
  const walk = (current) => {
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && wanted.has(extname(entry.name).toLowerCase())) out.push(full);
    }
  };
  walk(dir);
  return out;
}

/**
 * The `*.rdb` files an addon directory carries, in a deterministic order.
 *
 * A Workbench project writes `resourceDatabase.rdb` at its root; a built addon may keep one under
 * `data/`. When neither is there the tree is searched (four levels, sorted), because a downloaded
 * addon lays its files out for the runtime rather than for the editor.
 */
export function addonRdbs(dir) {
  const root = resolvePath(dir);
  const direct = ["resourceDatabase.rdb", join("data", "resourceDatabase.rdb")]
    .map((rel) => join(root, rel))
    .filter((file) => existsSync(file));
  if (direct.length) return direct;
  const found = [];
  const walk = (current, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /\.rdb$/i.test(entry.name)) found.push(full);
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * The addon directories the options name: every `--addon`, and every directory directly under an
 * `--addons` root — the rule `tools/cscript.mjs` states for the same option, so one addons folder
 * with forty mods is one argument there and here.
 */
export function addonDirs(flags) {
  return [...(flags.addon ?? []), ...addonRoots(flags)];
}

/** The child directories of every `--addons` root: the addons themselves. */
export function addonRoots(flags) {
  const found = [];
  for (const root of flags.addons ?? []) {
    let entries;
    try {
      entries = readdirSync(root, { withFileTypes: true });
    } catch (err) {
      throw inputError(`${root}: cannot read the addons folder — ${err.message}`, { source: root });
    }
    const dirs = entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => join(root, entry.name))
      .sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    if (!dirs.length) {
      throw inputError(`${root}: no addon directory inside it — --addons takes a folder whose child directories are the addons`, {
        source: root,
      });
    }
    found.push(...dirs);
  }
  return found;
}

/** The documents of every `--addons` child: the folder is a universe, and each child is an addon. */
function addonSourceSpecs(flags, { required = false } = {}) {
  if (!flags.addons?.length) return [];
  const extensions = extensionFilter(flags);
  const roots = addonRoots(flags);
  const out = [];
  for (const dir of roots) out.push(...documentsUnder(dir, { extensions }));
  if (!out.length && required) {
    // A silent empty answer would read as a clean audit of nothing: a downloaded addon keeps its
    // files inside data.pak, and none of them is a loose document. Only when --addons was the whole
    // source list, though — naming a file *and* a built addon is not an error.
    const filtered = flags.ext?.length ? ` matching --ext ${[...extensions].join(", ")}` : "";
    throw inputError(
      `no document under the ${roots.length} addon director${roots.length === 1 ? "y" : "ies"} of --addons${filtered}` +
        " — a built addon keeps its files in data.pak",
      {
        source: flags.addons.join(", "),
        hint: "pass a Workbench project (loose files), or name an entry as <pak>:<entry>",
      },
    );
  }
  return out;
}

/** True when `--addons` is the only thing that could supply a source, so an empty one is an error. */
function addonsAreTheOnlySource(specs, flags) {
  return specs.length === 0 && !(flags.guid ?? []).length;
}

/** The `*.rdb` files the addons named by `--addon`/`--addons` carry, in the order the addons were given. */
function addonRdbPaths(flags) {
  const dirs = addonDirs(flags);
  if (!dirs.length) {
    throw usageError("--use-addons-rdbs needs --addon <dir> or --addons <root>: there is nowhere to look for a database");
  }
  const out = [];
  const seen = new Set();
  for (const dir of dirs) {
    for (const file of addonRdbs(dir)) {
      const key = resolvePath(file).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  return out;
}

/**
 * The GUID dictionary the flags build: the `--rdb` databases first, then — with
 * `--use-addons-rdbs` — the databases beside the addons, as a **fallback** layer.
 *
 * Each layer is merged and verified on its own (`openRdbFiles`), so a set that contradicts itself
 * is still refused, and inside a layer `rdb merge`'s rule holds. Across the layers the explicit
 * `--rdb` wins and an addon database fills the GUIDs it does not know: that is what makes a mod's
 * own GUIDs resolvable *and* the vanilla ones, without requiring the two databases to agree — they
 * do not, because their `scripts/…` directory records differ by a digit. `shadowed` counts the
 * addon records the explicit set answered first, so a caller can see the precedence at work.
 */
/** The databases are read once per process: `--guid` resolution and the command both need them. */
let rdbMemo = null;

function loadRdb(flags) {
  const key = JSON.stringify([flags.rdb ?? [], flags.addon ?? [], flags.addons ?? [], !!flags.useAddonsRdbs]);
  if (rdbMemo && rdbMemo.key === key) return rdbMemo.value;
  const value = buildRdb(flags);
  rdbMemo = { key, value };
  return value;
}

function buildRdb(flags) {
  const explicit = [...(flags.rdb ?? [])];
  const explicitKeys = new Set(explicit.map((path) => resolvePath(path).toLowerCase()));
  const addonOnly = (flags.useAddonsRdbs ? addonRdbPaths(flags) : []).filter(
    (path) => !explicitKeys.has(resolvePath(path).toLowerCase()),
  );
  const layers = [];
  if (explicit.length) layers.push({ paths: explicit, addon: false });
  if (addonOnly.length) layers.push({ paths: addonOnly, addon: true });
  if (!layers.length) {
    return { byGuid: null, byPath: null, files: [], resolve: () => null, shadowed: 0, multi: false };
  }
  const byGuid = new Map();
  const byPath = new Map();
  const rdbOf = new Map();
  const files = [];
  let shadowed = 0;
  for (const layer of layers) {
    const opened = openRdbFiles(layer.paths);
    if (!opened.check.ok) {
      const err = new Error(
        `the ${layer.paths.length} ${layer.addon ? "addon " : ""}databases do not merge: ${describeMergeProblems(opened.check, 3)}. ` +
          `Run \`node tools/rdb.mjs verify-merge ${layer.paths.map((p) => JSON.stringify(p)).join(" ")}\` for the full list.`,
      );
      err.code = "MERGE";
      if (layer.addon) {
        err.hint = "the databases --use-addons-rdbs found do not merge with each other; name the ones you want with --rdb instead";
      }
      throw err;
    }
    const offset = files.length;
    for (const file of opened.merged.databases) files.push(layer.addon ? { ...file, fromAddons: true } : file);
    for (const [guid, found] of opened.merged.map) {
      const known = byGuid.get(guid);
      if (known !== undefined) {
        if (layer.addon && known !== found.path) shadowed++;
        continue;
      }
      byGuid.set(guid, found.path);
      rdbOf.set(guid, found.rdbs.map((index) => index + offset));
      const key = found.path.toLowerCase();
      if (!byPath.has(key)) byPath.set(key, guid);
    }
  }
  return {
    byGuid,
    byPath,
    files,
    shadowed,
    multi: files.length > 1,
    resolve: (guid) => {
      const path = byGuid.get(guid);
      return path === undefined ? null : { path, rdbs: [...(rdbOf.get(guid) ?? [])] };
    },
  };
}

function footer(flags, total, returned) {
  if (returned < total) console.log(`# ${total} row(s), ${returned} shown — use --limit 0 for every one`);
}

/**
 * Print a JSON envelope: compactly with `--compact`.
 *
 * `--compact` drops what carries no information — `false`, `[]`, `{}` — and the value-node keys
 * that only repeat the node (`raw` when it spells the same text, `pieces` when there is one), and
 * prints without indentation. An absent field therefore means false or empty, the same rule
 * `tools/cscript.mjs` states for its own `--compact`.
 */
function printJson(payload, flags) {
  console.log(JSON.stringify(flags.compact ? compactEnvelope(payload) : payload, null, flags.compact ? 0 : 2));
}

function compactEnvelope(payload) {
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    if (typeof value.kind === "string" && Object.hasOwn(value, "raw") && value.raw === String(value.value)) delete value.raw;
    if (value.pieces === 1) delete value.pieces;
    for (const key of Object.keys(value)) {
      const child = value[key];
      walk(child);
      if (child === false) delete value[key];
      else if (Array.isArray(child) && child.length === 0) delete value[key];
      else if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) delete value[key];
    }
  };
  walk(payload);
  return { ...payload, compact: true };
}

/** A value as lines: scalars on one line, objects and blocks with their subtree, one space a level. */
function valueLines(value, { depth = 4 } = {}) {
  const block = blockOf(value);
  if (!block) return [formatValue(value)];
  if (!block.items.length) return [value.type === "object" ? `${formatHead(value)} { }` : "{ }"];
  const inner = outline(value, { depth: depth === 0 ? 0 : Math.max(1, depth), limit: 500 });
  const open = value.type === "object" ? `${formatHead(value)} {` : "{";
  // `outline` already indents one space a level and treats this value as its root, so its children
  // are the lines to print after the opening brace -- no extra indent, so the block reads like the
  // file it came from and can be pasted back into one.
  return [open, ...inner.lines.slice(1), "}"];
}

function cmdInfo(specs, flags) {
  const { docs, failures } = loadCorpus(specs, flags);
  const db = loadRdb(flags);
  const addons = addonDirs(flags);
  const rows = docs.map(({ source, doc }) => ({
    source,
    info: describe(doc),
    identity: identityOf(sourceDescriptor(source, addons), db),
    problems: checkDocument(doc, { extension: extensionOf(source) }),
  }));
  const limit = rowLimit(flags);
  const shown = rows.slice(0, limit === Infinity ? rows.length : limit);
  // A source that could not be read is still a source: counting only the readable ones would let a
  // gap in the answer look like the whole set.
  const total = rows.length + failures.length;
  if (flags.json) {
    printJson({
      sources: shown.map((r) => ({
        ...sourceRow(r.source),
        ...r.info,
        resource: r.identity ? { guid: r.identity.guid, rdbs: r.identity.rdbs } : null,
        problems: r.problems.length,
      })),
      ...(failures.length ? { parseFailures: failures } : {}),
      total,
      returned: shown.length + failures.length,
      truncated: shown.length < rows.length,
    }, flags);
  } else {
    printParseFailures(failures);
    for (const { source, info, identity, problems } of shown) {
      const parent = info.parent ? `, parent "{${info.parent.guid}}${info.parent.path}"` : ", no parent";
      console.log(`${source.display}`);
      console.log(`  ${info.className}${parent}`);
      if (info.self) console.log(`  self "{${info.self.guid}}${info.self.path}"`);
      if (identity) {
        const rdbs = identity.rdbs.length > 1 ? ` (rdb ${identity.rdbs.map((i) => i + 1).join(",")})` : "";
        console.log(`  resource {${identity.guid}}${rdbs}`);
      }
      if (info.id) console.log(`  ID ${JSON.stringify(info.id)}  (a member, not the resource identity)`);
      console.log(
        `  ${info.entries} entries at the top; ${info.members} members and ${info.elements} array elements in all;` +
          ` ${info.components} component(s) (${info.componentsWithSlot} with a slot GUID, ${info.componentsDerived} derived);` +
          ` ${info.refs} reference(s); depth ${info.depth}`,
      );
      console.log(
        `  ${info.bytes} bytes, ${info.lines} lines` + (problems.length ? `, ${problems.length} problem(s) — see check` : ", no problems"),
      );
    }
  }
  if (!flags.json) {
    footer(flags, total, shown.length + failures.length);
    parseFailureFooter(failures, { read: rows.length });
  }
  if (failures.length) process.exitCode = 1;
}

/**
 * A line range as `cat` takes it: `20` (that line), `20-30` (both ends included), `20-` (to the
 * end). 1-based, like the line numbers every other command reports.
 */
function parseLineRange(raw, total) {
  const match = /^(\d+)(?:-(\d*))?$/.exec(String(raw));
  if (!match) throw usageError(`cat takes a line range like 20, 20-30 or 20-, not "${raw}"`);
  const from = Number(match[1]);
  if (from < 1) throw usageError(`cat: a line number starts at 1, not ${from}`);
  const to = match[2] === undefined ? from : match[2] === "" ? total : Number(match[2]);
  if (to < from) throw usageError(`cat: the range "${raw}" ends at ${to}, before it starts at ${from}`);
  return { from, to: Math.min(to, total) };
}

function cmdCat(specs, flags) {
  const byGuid = (flags.guid ?? []).length > 0;
  if (byGuid ? specs.length > 1 : specs.length < 1 || specs.length > 2) {
    throw usageError("cat takes one source and optionally a line range: cat <source> 20-30");
  }
  const [spec, range] = byGuid ? [undefined, specs[0]] : specs;
  if (range !== undefined && flags.lines !== undefined) throw usageError("cat takes a range or --lines, not both");
  const [{ source }] = load([spec], flags);
  let text;
  if (source.kind === "pak") {
    const pak = openPak(source.pak);
    try {
      text = pak.read(findEntry(pak, source.entry)).toString("utf8");
    } finally {
      pak.close();
    }
  } else text = readFileSync(source.path, "utf8");
  const lines = text.split("\n");
  let wanted = lines;
  let from = 1;
  let to = lines.length;
  if (range !== undefined) {
    ({ from, to } = parseLineRange(range, lines.length));
    wanted = lines.slice(from - 1, to);
  } else if (flags.lines !== undefined) {
    wanted = lines.slice(0, flags.lines);
    to = wanted.length;
  }
  if (flags.json) {
    printJson({
      source: sourceRow(source),
      from,
      to,
      total: lines.length,
      returned: wanted.length,
      truncated: wanted.length < lines.length,
      text: wanted.join("\n"),
    }, flags);
    return;
  }
  if (flags.numbers) {
    const first = range !== undefined ? from : 1;
    const width = String(lines.length).length;
    const numbered = wanted.map((line, k) => `${String(first + k).padStart(width)}  ${line}`);
    process.stdout.write(numbered.join("\n"));
  } else process.stdout.write(wanted.join("\n"));
  // A range is the answer the caller asked for, so it carries no footer of its own; `--lines` clips
  // a view and says how much it left out.
  if (range === undefined && wanted.length < lines.length) {
    process.stdout.write(`\n# ${lines.length} lines, ${wanted.length} shown\n`);
  }
}

function cmdTree(specs, flags) {
  if (specs.length > 1) throw usageError("tree takes exactly one source");
  const { source, doc } = loadOne(specs[0], flags);
  const depth = flags.depth ?? 4;
  const result = outline(doc, { depth, limit: rowLimit(flags), numbers: !!flags.numbers });
  if (flags.json) {
    const limit = rowLimit(flags);
    const budget = { left: limit === Infinity ? Infinity : limit, used: 0, cut: false };
    const root = treeJson(doc, { depth, budget });
    printJson({
      source: sourceRow(source),
      depth,
      total: countNodes(doc),
      returned: budget.used,
      truncated: result.clipped || budget.cut || root.clipped === true,
      root,
    }, flags);
    return;
  }
  for (const line of result.lines) console.log(line);
  if (result.clipped) console.log("# outline truncated — raise --depth, or --limit 0 for every line");
}

function cmdGet(specs, flags) {
  const byGuid = (flags.guid ?? []).length > 0;
  // With --guid every positional is a path; there is no source word to skip.
  const [spec, ...rest] = specs;
  const paths = byGuid ? specs : rest;
  if (paths.length === 0 || (!byGuid && spec === undefined)) {
    throw usageError("get needs a path: get <source> <path>..., or get --guid <guid> <path>...");
  }
  const { source, doc } = loadOne(byGuid ? undefined : spec, flags);
  const depth = flags.depth ?? 4;
  const rows = paths.map((path) => {
    const hit = lookup(doc, path);
    return { path, found: hit.found, value: hit.value, line: hit.entry?.line ?? null, missing: hit.missing };
  });
  const missing = rows.filter((r) => !r.found);
  if (flags.json) {
    printJson({
      source: sourceRow(source),
      total: rows.length,
      returned: rows.length,
      truncated: false,
      missing: missing.length,
      entries: rows.map((r) => ({ path: r.path, found: r.found, line: r.line, value: r.found ? r.value : null })),
    }, flags);
  } else {
    for (const r of rows) {
      if (!r.found) {
        process.stderr.write(`! ${r.path} — not in ${source.display} (no "${r.missing}")\n`);
        continue;
      }
      const lines = valueLines(r.value, { depth });
      const where = flags.numbers ? `  (line ${r.line})` : "";
      if (lines.length === 1) console.log(`${r.path} = ${lines[0]}${where}`);
      else console.log(`${r.path} = ${lines.join("\n")}${where}`);
    }
  }
  if (missing.length && !flags.missingOk) process.exitCode = 3;
}

function cmdComponents(specs, flags) {
  if (specs.length > 1) throw usageError("components takes exactly one source");
  const { source, doc } = loadOne(specs[0], flags);
  const all = componentsOf(doc);
  const limit = rowLimit(flags);
  const shown = all.slice(0, limit === Infinity ? all.length : limit);
  if (flags.json) {
    printJson({
      source: sourceRow(source),
      total: all.length,
      returned: shown.length,
      truncated: shown.length < all.length,
      components: shown.map((c) => ({
        class: c.className,
        name: c.name,
        guid: c.guid,
        derived: c.derived,
        entries: c.entries,
        line: c.line,
      })),
    }, flags);
    return;
  }
  if (!all.length) {
    console.log(`# ${source.display} has no components block`);
    return;
  }
  const nameWidth = Math.max(...all.map((c) => c.className.length), 5);
  const numberWidth = String(source.lines ?? 0).length;
  for (const c of shown) {
    const slot = c.guid ? `{${c.guid}}` : "(no slot)";
    const derived = c.derived ? `  : {${c.derived.guid}}${c.derived.path}` : "";
    const number = flags.numbers ? `${String(c.line ?? 0).padStart(numberWidth)}  ` : "";
    console.log(`${number}${c.className.padEnd(nameWidth)}  ${slot}  ${c.entries} entr${c.entries === 1 ? "y" : "ies"}${derived}`);
  }
  footer(flags, all.length, shown.length);
}

function cmdRefs(specs, flags) {
  const { docs, failures } = loadCorpus(specs, flags);
  const { byGuid, files, shadowed } = loadRdb(flags);
  const classify = (ref) => {
    if (!byGuid) return { status: "unchecked", target: null };
    const target = byGuid.get(ref.guid) ?? null;
    if (!target) return { status: "unresolved", target: null };
    if (normalisePath(target).toLowerCase() !== normalisePath(ref.path).toLowerCase()) {
      return { status: "contradiction", target };
    }
    return { status: "ok", target };
  };
  const rows = [];
  for (const { source, doc } of docs) {
    for (const ref of refsOf(doc)) rows.push({ source: source.index, ...ref, ...classify(ref) });
  }
  const counts = { ok: 0, unresolved: 0, contradiction: 0, unchecked: 0 };
  for (const r of rows) counts[r.status]++;
  const limit = rowLimit(flags);
  const shown = rows.slice(0, limit === Infinity ? rows.length : limit);
  const many = docs.length + failures.length > 1;
  if (flags.json) {
    printJson({
      ...(many || !docs.length ? { sources: docs.map(({ source }) => sourceRow(source)) } : { source: sourceRow(docs[0].source) }),
      rdbs: files,
      ...(shadowed ? { shadowed } : {}),
      ...(failures.length ? { parseFailures: failures } : {}),
      total: rows.length,
      returned: shown.length,
      truncated: shown.length < rows.length,
      counts,
      references: shown.map((r) => ({
        ...(many ? { source: r.source } : {}),
        guid: r.guid,
        path: r.path,
        line: r.line,
        where: r.where,
        member: r.member,
        quoted: r.quoted,
        status: r.status,
        target: r.target,
      })),
    }, flags);
  } else {
    const printRef = (r) => {
      const mark = r.status === "contradiction" ? "!" : r.status === "unresolved" ? "?" : r.status === "ok" ? "+" : " ";
      const where = r.member ? `${r.where} of ${r.member}` : r.where;
      console.log(`${mark} {${r.guid}}${r.path}  line ${r.line}  ${where}`);
      if (r.status === "contradiction") console.log(`    ! that GUID names "${r.target}"`);
      if (r.status === "unresolved") console.log("    ? no resource has that GUID");
    };
    printParseFailures(failures);
    if (many) {
      // Every source gets its header, including the one with nothing under it: "was this file read?"
      // must not be a guess. But only while that list fits the row budget — on a corpus larger than
      // --limit, naming every empty source was 4 000 lines for --limit 3 (measured on 2 000
      // documents), which is the wall the cap exists to prevent. There they are counted in one line.
      const cap = limit === Infinity ? Infinity : limit;
      const listEmpty = docs.length <= cap;
      const bySource = new Map();
      for (const r of rows) {
        if (!bySource.has(r.source)) bySource.set(r.source, []);
        bySource.get(r.source).push(r);
      }
      let printed = 0;
      let emptyNotListed = 0;
      for (const { source } of docs) {
        const own = bySource.get(source.index) ?? [];
        if (!own.length) {
          if (!listEmpty) {
            emptyNotListed++;
            continue;
          }
          console.log(`${source.display}:`);
          console.log("  (no references)");
          continue;
        }
        // A header we cannot fill is worse than no header: it claims a read with nothing to show.
        if (printed >= cap) break;
        console.log(`${source.display}:`);
        for (const r of own) {
          if (printed >= cap) break;
          printRef(r);
          printed++;
        }
      }
      footer(flags, rows.length, printed);
      if (emptyNotListed) {
        console.log(`# ${emptyNotListed} source(s) with no references are not listed — use --limit 0 to list them`);
      }
    } else if (docs.length) {
      for (const r of shown) printRef(r);
      footer(flags, rows.length, shown.length);
    }
    if (byGuid) {
      console.log(
        `${rows.length} reference(s) to ${new Set(rows.map((r) => r.path.toLowerCase())).size} path(s): ` +
          `${counts.ok} ok, ${counts.contradiction} contradict the database, ${counts.unresolved} unresolved`,
      );
    } else console.log(`${rows.length} reference(s); pass --rdb to resolve them`);
    parseFailureFooter(failures, { read: docs.length });
  }
  if (flags.check && (counts.contradiction || (flags.strict && counts.unresolved))) process.exitCode = 1;
  if (failures.length) process.exitCode = 1;
}

function cmdChain(specs, flags) {
  if (specs.length > 1) throw usageError("chain takes exactly one source");
  const { source, doc } = loadOne(specs[0], flags);
  const db = loadRdb(flags);
  const addons = addonDirs(flags);
  const roots = source.path ? ancestorRoots(source.path) : [];
  const loader = new DocumentLoader({ paks: [source.pak, ...flags.pak].filter(Boolean), addons, roots, noPakPathSplit: !!flags.noPakPathSplit });
  try {
    const result = inheritance(doc, {
      load: (path) => loader.load(path),
      resolve: db.byGuid ? (guid) => db.byGuid.get(guid) ?? null : null,
      max: flags.depth ?? 64,
      self: sourceDescriptor(source, addons),
      identify: (loaded) => identityOf(loaded, db),
      copies: (loaded) =>
        loader.loadAll(loaded.resourcePath).map((copy) => ({ parent: copy.doc.parent, container: copy.container })),
      where: () => `${loader.describeSearch()}; pass --pak <pak|dir> or --addon <dir> to search more`,
    });
    if (flags.json) {
      printJson({
        source: sourceRow(source),
        rdbs: db.files,
        ...(db.shadowed ? { shadowed: db.shadowed } : {}),
        total: result.rows.length,
        returned: result.rows.length,
        truncated: result.truncated,
        problems: result.problems,
        warnings: result.warnings,
        chain: result.rows.map((r) => ({
          depth: r.depth,
          path: r.path,
          class: r.className,
          guid: r.identity?.guid ?? null,
          rdbs: r.identity?.rdbs ?? [],
          memberId: r.memberId,
          parent: r.parent,
          via: r.via,
        })),
      }, flags);
    } else {
      const strip = (filePath) => {
        if (!source.pak) return filePath;
        const prefix = `${source.pak}:`;
        return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
      };
      const multi = db.multi ?? false;
      for (const r of result.rows) {
        const pad = "  ".repeat(r.depth);
        const guid = r.identity ? `  {${r.identity.guid}}` : "  (no GUID)";
        const rdbs = multi && r.identity?.rdbs?.length ? `  rdb ${r.identity.rdbs.map((i) => i + 1).join(",")}` : "";
        const via = r.depth > 0 && r.via === "path" && db.byGuid ? "  (path)" : "";
        console.log(`${pad}${r.className ?? "?"}  ${strip(r.path)}${guid}${rdbs}${via}`);
      }
      for (const p of result.problems) console.log(`[${p.severity}] ${p.message}`);
      console.log(`${result.rows.length} step(s) in the chain${result.truncated ? " — raise --depth for more" : ""}`);
      const unresolved = result.rows.filter((r) => !r.identity).length;
      if (unresolved) {
        console.log(`# ${unresolved} step(s) without a resource GUID — pass --rdb, or keep the .meta file beside a project's`);
      }
    }
    if (result.problems.some((p) => p.severity === "error")) process.exitCode = 1;
  } finally {
    loader.close();
  }
}

function cmdFind(specs, flags) {
  const query = specs[specs.length - 1];
  if (query === undefined) throw usageError("find needs a query: find <source> <query>");
  const sourceSpecs = specs.slice(0, -1);
  if (!sourceSpecs.length && !flags.addons?.length && !flags.guid?.length) {
    throw usageError("find needs a source, or --addons <root>: find <source> <query>");
  }
  const { docs, failures } = loadCorpus(sourceSpecs, flags);
  const re = flags.regex ? new RegExp(query, "i") : null;
  const needle = String(query).toLowerCase();
  const matches = (s) => (re ? re.test(String(s)) : String(s).toLowerCase().includes(needle));
  const where = flags.in ?? "all";
  const rows = [];
  const add = (source, path, kind, value, line) => rows.push({ source, path, kind, value, line });

  for (const { source, doc } of docs) {
    for (const ref of refsOf(doc)) {
      if (where === "name" || where === "class") break;
      if (matches(ref.path) || matches(ref.guid)) {
        add(source.index, ref.member || "(root)", "reference", formatValue({ kind: "ref", guid: ref.guid, path: ref.path }), ref.line);
      }
    }
    walk(doc, (item, at) => {
      if (item.kind === "member" && (where === "all" || where === "name") && matches(item.name)) {
        add(source.index, at.path, "name", entryLabel(item), item.line);
      }
      const value = item.value;
      if (value?.type === "object" && value.className && (where === "all" || where === "class") && matches(value.className)) {
        add(source.index, at.path, "class", value.className, item.line);
      }
      if (!value || where === "name" || where === "class") return;
      if (value.kind === "string" || value.kind === "ident") {
        if (matches(value.value)) add(source.index, at.path, "value", formatValue(value), item.line);
      } else if (value.kind === "ref") {
        if (matches(value.path) || matches(value.guid)) add(source.index, at.path, "value", formatValue(value), item.line);
      }
    });
  }

  const unique = [];
  const seen = new Map();
  for (const row of rows) {
    const key = `${row.source}|${row.path}|${row.line}|${row.value}`;
    const previous = seen.get(key);
    if (previous) {
      // A reference is also a value: refsOf and walk both see the same token, so the same hit
      // arrived twice with two kind labels. One row, and the narrower reading wins.
      if (row.kind === "value") previous.kind = "value";
      continue;
    }
    seen.set(key, row);
    unique.push(row);
  }
  const limit = rowLimit(flags);
  const shown = unique.slice(0, limit === Infinity ? unique.length : limit);
  const many = docs.length + failures.length > 1;
  if (flags.json) {
    printJson({
      ...(many || !docs.length ? { sources: docs.map(({ source }) => sourceRow(source)) } : { source: sourceRow(docs[0].source) }),
      query,
      in: where,
      regex: !!flags.regex,
      ...(failures.length ? { parseFailures: failures } : {}),
      total: unique.length,
      returned: shown.length,
      truncated: shown.length < unique.length,
      entries: shown,
    }, flags);
  } else {
    const printRow = (row) => console.log(`${row.path} = ${row.value}  (${row.kind}, line ${row.line})`);
    printParseFailures(failures);
    if (many) {
      // A source that matched nothing still gets its header and says so, so "was this file read?" is
      // not guessed from the absence of a line — while the list fits the row budget. A corpus larger
      // than --limit gets one line that counts them instead (4 000 lines for --limit 3, measured).
      const cap = limit === Infinity ? Infinity : limit;
      const listEmpty = docs.length <= cap;
      const bySource = new Map();
      for (const row of unique) {
        if (!bySource.has(row.source)) bySource.set(row.source, []);
        bySource.get(row.source).push(row);
      }
      let printed = 0;
      let emptyNotListed = 0;
      for (const { source } of docs) {
        const own = bySource.get(source.index) ?? [];
        if (!own.length) {
          if (!listEmpty) {
            emptyNotListed++;
            continue;
          }
          console.log(`${source.display}:`);
          console.log("  (no matches)");
          continue;
        }
        if (printed >= cap) break;
        console.log(`${source.display}:`);
        for (const row of own) {
          if (printed >= cap) break;
          printRow(row);
          printed++;
        }
      }
      if (printed < unique.length) footer(flags, unique.length, printed);
      if (emptyNotListed) {
        console.log(`# ${emptyNotListed} source(s) matched nothing and are not listed — use --limit 0 to list them`);
      }
    } else if (docs.length) {
      for (const row of shown) printRow(row);
      if (!unique.length) console.log(`# nothing matches ${JSON.stringify(query)} in ${docs[0].source.display}`);
      else footer(flags, unique.length, shown.length);
    }
    parseFailureFooter(failures, { read: docs.length });
  }
  if (failures.length) process.exitCode = 1;
}

function cmdCheck(specs, flags) {
  // `--lenient`: a document that cannot be read is a reported failure, not the end of the run, so one
  // commented .layout in a mod does not hide the other 200 documents.
  const { docs, failures } = loadCorpus(specs, flags);
  const { byGuid, byPath, files, shadowed } = loadRdb(flags);
  const rows = docs.map(({ source, doc }) => ({
    source,
    info: describe(doc),
    problems: checkDocument(doc, { byGuid, byPath, extension: extensionOf(source) }),
  }));
  const errors =
    failures.length + rows.reduce((n, r) => n + r.problems.filter((p) => p.severity === "error").length, 0);
  const warnings = rows.reduce((n, r) => n + r.problems.filter((p) => p.severity === "warning").length, 0);
  const totalSources = rows.length + failures.length;
  const limit = rowLimit(flags);
  const shown = rows.slice(0, limit === Infinity ? rows.length : limit);
  if (flags.json) {
    printJson({
      sources: shown.map((r) => ({ ...sourceRow(r.source), ...r.info })),
      ...(failures.length ? { parseFailures: failures } : {}),
      rdbs: files,
      ...(shadowed ? { shadowed } : {}),
      total: totalSources,
      returned: shown.length + failures.length,
      truncated: shown.length < rows.length,
      ok: errors === 0,
      errors,
      warnings,
      problems: rows.flatMap((r) => r.problems.map((p) => ({ source: r.source.display, ...p }))),
    }, flags);
  } else {
    printParseFailures(failures);
    for (const { source, info, problems } of shown) {
      const own = problems.filter((p) => p.severity === "error").length;
      console.log(
        `${own ? "FAIL" : "OK  "}  ${source.display}: ${info.className}, ${info.entries} entries, ` +
          `${info.components} component(s), ${info.refs} reference(s)` +
          (problems.length ? `, ${problems.length} problem(s)` : ", no problems"),
      );
      for (const p of problems) console.log(`        [${p.severity}] line ${p.line}: ${p.message}`);
    }
    footer(flags, totalSources, shown.length + failures.length);
    // A capped list must not look clean: the exit code still reports the whole set, and the text
    // has to say that defects are hiding above the cut rather than leaving only "OK" lines.
    const hidden = rows.slice(shown.length).filter((r) => r.problems.length);
    if (hidden.length) {
      const hiddenProblems = hidden.reduce((n, r) => n + r.problems.length, 0);
      const hiddenErrors = hidden.reduce((n, r) => n + r.problems.filter((p) => p.severity === "error").length, 0);
      console.log(
        `# ${hidden.length} source(s) with problems are not shown, ${hiddenProblems} problem(s) among them` +
          (hiddenErrors ? ` including ${hiddenErrors} error(s)` : "") +
          " — use --limit 0 for the whole list",
      );
    }
    if (files.length) console.log(`against ${files.map((f) => f.file).join(", ")}`);
  }
  if (errors || (flags.strict && warnings)) process.exitCode = 1;
}

function main(argv) {
  const flags = parseArgs(argv);
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (flags._.length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const [command, ...rest] = flags._;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw usageError(`unknown command "${command}"`);
  if (rest.length === 0 && !flags.addons?.length && !flags.guid?.length) {
    throw usageError(`${command} needs a source: <file>, <pak>:<entry>, --addons <root>, or --guid <guid>`);
  }
  checkOptions(command, flags);
  switch (command) {
    case "info": cmdInfo(rest, flags); break;
    case "cat": cmdCat(rest, flags); break;
    case "tree": cmdTree(rest, flags); break;
    case "get": cmdGet(rest, flags); break;
    case "components": cmdComponents(rest, flags); break;
    case "refs": cmdRefs(rest, flags); break;
    case "chain": cmdChain(rest, flags); break;
    case "find": cmdFind(rest, flags); break;
    case "check": cmdCheck(rest, flags); break;
    default: throw usageError(`unknown command "${command}"`);
  }
}

/**
 * The failure as one object: a code a caller can branch on, the sentence a human reads, and the
 * position when there is one. `USAGE` means the command line was wrong (exit 2); everything else
 * means the input was (exit 1) — a script can tell "I called it wrong" from "the file is broken"
 * without reading English.
 */
function errorObject(err) {
  const code = err instanceof ConfSyntaxError
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
    if (error.code === "USAGE") process.stderr.write("run `node tools/etconf.mjs --help` for the commands and options\n");
  }
  process.exitCode = error.code === "USAGE" ? 2 : 1;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  const argv = process.argv.slice(2);
  try {
    main(argv);
  } catch (err) {
    reportError(err, { json: argv.includes("--json") || argv.includes("--compact"), compact: argv.includes("--compact") });
  }
}
