#!/usr/bin/env node
// Read Arma Reforger **Enforce Script** sources (`.c`): declarations, signatures, doc comments,
// class schemas, inheritance chains, subclass trees, and modded overrides. A source is a file on
// disk or one entry inside a `.pak`, written `<pak>:<entry>` ... the same rule `tools/loc.mjs`,
// `tools/etconf.mjs` and `tools/ebin.mjs` use (it lives in `pak.mjs`, so every reader shares it).
//
//   node tools/cscript.mjs check             <source>... [--pak <pak|dir>]... [--addon <dir>]...
//                                            [--file <file>]... [--json]
//   node tools/cscript.mjs find-defs         <needle> [--pak ...] [--addon ...] [--file ...]
//                                            [--kind class|enum|method|field|function] [--regex]
//                                            [--original | --only-modded] [--files-only] [--stats]
//                                            [--limit N|0] [--json]
//   node tools/cscript.mjs schema            <source> <needle> [--members all|fields|methods]
//                                            [--inherited] [--limit N|0] [--json]
//   node tools/cscript.mjs signature         <source> <needle> [--json]
//   node tools/cscript.mjs inheritance-chain <source> [<class>] [--pak ...] [--addon ...]
//                                            [--depth N] [--json]
//   node tools/cscript.mjs subclass-tree     <source> [<class>] [--pak ...] [--addon ...]
//                                            [--depth N] [--no-modded] [--limit N|0] [--json]
//   node tools/cscript.mjs outline           <source> [--limit N|0] [--json]
//   node tools/cscript.mjs cat               <source> [<lines>] [--plain] [--json]
//
// Also usable as a library:
//
//   import { parseScript, findDefinitions, ScriptUniverse, schemaOf } from "./cscript.mjs";
//   const file = parseScript(text, { name: "SCR_Timer.c" });
//   file.declarations.map((d) => [d.kind, d.name, d.signature]);
//   const cls = findDeclaration(file, "SCR_Timer");          // one declaration by name
//   const schema = schemaOf(cls);                            // fields + methods, with lines
//
// ---------------------------------------------------------------------------
// THE LANGUAGE, as measured on the installed 1.8.0.13 client: 6 568 vanilla `.c` files inside
// `data007.pak` and `core/data.pak` (27.4 MB, 6 533 of them declaring at least one type, 94 568
// declarations in all), plus 971 files inside 14 downloaded Workshop addons (4.6 MB, 944 declaring a
// type, 15 711 declarations). Every number in this header is what this reader reports on those
// files -- `node tools/cscript.mjs check --pak <install>/addons/data --pak <install>/addons/core`
// and the same parse over the addons -- and the vanilla 6 568 parse with **0 errors and 0 warnings**
// (one note: a field vanilla really does declare without its `;`). Nothing here is quoted from the
// wiki without saying so; where the wiki and the corpus disagree, the corpus wins and says why.
//
// What a `.c` file contains: top-level `class`, `enum` and `typedef` declarations, plus global
// functions and global variables; one file may hold any number of each, and the convention is one
// type per file. A class body holds fields, methods, and (rarely) nested types.
//
//   [Attribute("1", uiwidget: UIWidgets.CheckBox, desc: "...")]   <- decorators, `[Name(args)]`, may
//   [NonSerialized()]                       [A(), B("x")]         be several in one bracket
//   modded class SCR_Timer : SCR_TimerBase                       <- `modded` replaces the original
//   {                                                            <- `sealed`, `extends` too
//    protected ref array<ref X> m_aX = {};                      <- field: modifiers, type, name, init
//    static const float SPEED = 0.25; //!< trailing doc comment
//    //! ... or /*! ... */                                        <- doc comments (Doxygen, `\param`)
//    proto external string GetWorldFile();                       <- prototype: engine-side, ends `;`
//    sealed World GetWorld() { return m_World; }                  <- body, one line or many
//    modded void MyMethod() { super.MyMethod(); }                 <- override inside a modded class
//   }
//
// Shapes a reader must survive, all present in the corpus and each one a fixture in the tests:
//
//  * **`modded class X` carries its base clause** in the real data (`modded class ArmaReforgerScripted
//    : ChimeraGame`, ACE Core): the wiki never shows one, and a reader that refuses it loses 203
//    declarations across the 14 addons read here. `modded enum X { ... }` adds constants -- 24 of
//    those, and their values continue the original's numbering, which is why `schema` resolves the
//    original when the sources are given and prints `?` when they are not.
//  * **An enum may have a base enum** (`enum ECharacterHitZoneGroup : EHitZoneGroup`), which the
//    wiki does not mention at all. `enum EDiagMenuGame : EDiagMenuGameLib { }` is empty.
//  * **Template classes**: `class Tuple1<Class T1> extends Tuple`, `class Item<Class T>`.
//  * **`enum` values are expressions**: `HEALTHY = 1 << 0`; every vanilla enum ends with a comma and
//    some mods do not -- both are accepted, and an omitted value continues the previous one.
//  * **Doc comments have five spellings**: `//!`, `//!<` (documents what precedes it), `///`,
//    `/*! ... */`, `/** ... */`; the wiki asks for the first two. `/* ... */` and `// ...` are not
//    docs, but vanilla puts a class's description in a plain `/* ... */` banner, so it is reported
//    separately as `banner` rather than being mistaken for a docstring.
//  * **Preprocessor directives** matter to a reader because they wrap *declarations*: a field inside
//    `#ifdef AI_DEBUG`, a whole class inside `#ifdef BREAK_COMPILATION` (with deliberate garbage in
//    it, in `scripts/Game/game.c`). Each declaration records the condition stack it sits under, and
//    two declarations with the same name are only a duplicate when their conditions match --
//    SCR_FuelNode declares nine methods in *each* branch of its `#ifdef`, on purpose.
//  * **`};` after a method body**, `#include` inside a class body, `>>` closing nested generics,
//    `[Attribute("100", desc: "...", "0 500")]` (a positional argument *after* a named one),
//    `enums: { ParamEnum("a", "1"), }` (an array literal with a trailing comma), a string continued
//    with a trailing backslash, and a field declared with no `;` at all: all tolerated.
//  * What is **not** in the language in this build: operator overloads (0 occurrences; the word
//    `operator` only appears in comments and as a variable name), out-of-class method definitions
//    (`Scope::Method`, 0 occurrences outside strings and comments), and `#if`/`#elif`/`#undef`/
//    `#pragma`/`#error` (0 occurrences; only `#define`, `#ifdef`, `#ifndef`, `#else`, `#endif` do).
//
// What this reader cannot know: a type's real identity. Enforce Script has no namespaces, no module
// prefix and no per-file type scope, so a class name is global, which is why two mods may both ship
// `modded class SCR_X` and why `find-defs` reports every copy instead of one. Nor can it know which
// `#ifdef` flags the game was compiled with, so a declaration inside a conditional is reported with
// its condition rather than assumed present.
//
// `--json` everywhere; exit 1 on a parse error, on a `check` error, and on a needle that is absent.
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve as resolvePath, dirname, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { openPak, findEntry, normalisePath, parseSourceSpec } from "./pak.mjs";

/** The one extension this reader accepts. A `.c` file is a script; nothing else is. */
export const EXTENSIONS = [".c"];

/** Re-exported so a caller needs one import: the `<pak>:<entry>` rule lives in `pak.mjs`. */
export { parseSourceSpec };

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** A script that does not parse, reported with the line and column that gave it away. */
export class ScriptSyntaxError extends Error {
  constructor(name, message, text, at) {
    const { line, column } = lineColumn(text, at);
    super(`${name}: ${message} (line ${line}, column ${column})`);
    this.name = "ScriptSyntaxError";
    this.line = line;
    this.column = column;
    this.at = at;
  }
}

/** Line and column (both 1-based) of an offset, for error messages only. */
export function lineColumn(text, at) {
  let line = 1;
  let lineStart = 0;
  for (let i = 0; i < at && i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      line++;
      lineStart = i + 1;
    }
  }
  return { line, column: at - lineStart + 1 };
}

// ---------------------------------------------------------------------------
// Lexer
// ---------------------------------------------------------------------------

/**
 * How each kind of punctuation token is spelled. Longest first, so `>>=` never reads as `>` `>=`.
 *
 * `>>` and `<<` are single tokens, which is what a type like `array<array<int>>` needs: the two
 * closing brackets of a nested generic are one token and must still close two levels.
 */
const PUNCTUATION = [
  "<<=", ">>=",
  "==", "!=", "<=", ">=", "&&", "||", "++", "--", "+=", "-=", "*=", "/=", "%=", "&=", "|=", "^=",
  "<<", ">>", "::", "->", "=>",
  "{", "}", "(", ")", "[", "]", ";", ",", ":", ".", "=", "<", ">", "+", "-", "*", "/", "%", "!",
  "~", "&", "|", "^", "?", "@", "#", "$",
];

/** The characters that may start an identifier. `$` is tolerated; the engine does not use it. */
const isIdentStart = (c) => c !== undefined && ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || c === "_");
const isIdentChar = (c) =>
  c !== undefined && ((c >= "A" && c <= "Z") || (c >= "a" && c <= "z") || (c >= "0" && c <= "9") || c === "_");
const isDigit = (c) => c !== undefined && c >= "0" && c <= "9";
const isSpace = (c) => c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v";

/**
 * Split a script into tokens, comments and directives.
 *
 * Tokens are `{ type, value, start, end }` with `type` one of `ident`, `number`, `string`, `punct`,
 * `directive`, `eof`; `line` is added by the caller's line index. Comments are kept **out** of the
 * token stream (so `{` inside a comment can never unbalance anything) and returned in their own
 * list, where each carries its marker (`//`, `//!`, `//!<`, `///`, `/*`, `/*!`, `/**`) and whether
 * that marker makes it a doc comment. A directive is one token per line: from `#` at the start of a
 * line (`#endif // WORKBENCH` becomes just `#endif`, because the comment is stripped first).
 *
 * Directives stay in the token stream, in order, because they carry structure: `#ifdef` opens a
 * condition that every declaration inside it records, and `check` counts the ones that never close.
 */
export function tokenize(text) {
  const tokens = [];
  const comments = [];
  const problems = [];
  let i = 0;
  let atLineStart = true; // only whitespace has been seen since the last newline

  const push = (type, start, end, value) => {
    tokens.push({ type, value: value ?? text.slice(start, end), start, end });
  };

  while (i < text.length) {
    const c = text[i];

    if (c === "\n") {
      atLineStart = true;
      i++;
      continue;
    }
    if (isSpace(c)) {
      i++;
      continue;
    }

    // A directive is `#` as the first non-blank character of a line, and runs to the end of it.
    if (c === "#" && atLineStart) {
      const start = i;
      while (i < text.length && text[i] !== "\n") {
        // Inside a directive a comment starts a comment and ends the directive's content.
        if (text[i] === "/" && text[i + 1] === "/") break;
        if (text[i] === "/" && text[i + 1] === "*") break;
        i++;
      }
      const end = i;
      const raw = text.slice(start, end).replace(/[ \t]+$/, "");
      const word = (raw.match(/^#\s*([A-Za-z_]+)/) ?? [])[1] ?? "";
      const argument = raw.replace(/^#\s*[A-Za-z_]*[ \t]*/, "").trim();
      tokens.push({ type: "directive", value: raw, word, argument, start, end });
      atLineStart = false;
      continue;
    }

    // Comments: line and block, four doc spellings plus the plain ones.
    if (c === "/" && text[i + 1] === "/") {
      const start = i;
      i += 2;
      let marker = "//";
      if (text[i] === "!") {
        marker = text[i + 1] === "<" ? "//!<" : "//!";
        i += marker.length - 2;
      } else if (text[i] === "/") marker = "///";
      while (i < text.length && text[i] !== "\n") i++;
      comments.push({ marker, start, end: i, text: text.slice(start, i), doc: marker !== "//", trailing: marker === "//!<" });
      continue;
    }
    if (c === "/" && text[i + 1] === "*") {
      const start = i;
      let marker = "/*";
      if (text[i + 2] === "!") marker = "/*!";
      else if (text[i + 2] === "*" && text[i + 3] !== "/") marker = "/**";
      i += marker.length;
      let closed = false;
      while (i < text.length) {
        if (text[i] === "*" && text[i + 1] === "/") {
          i += 2;
          closed = true;
          break;
        }
        i++;
      }
      if (!closed) {
        problems.push({ severity: "error", code: "unterminated-comment", message: "block comment is never closed", start });
      }
      comments.push({ marker, start, end: i, text: text.slice(start, i), doc: marker === "/*!" || marker === "/**", trailing: false });
      atLineStart = false;
      continue;
    }

    // Strings. `\"` and `\\` are the escapes the engine documents; any other `\X` is kept verbatim,
    // and a backslash before the newline continues the string on the next line (RHS-StatusQuo writes
    // a three-line message that way, with CRLF endings, so the `\r` is skipped too).
    if (c === '"') {
      const start = i;
      i++;
      let closed = false;
      while (i < text.length) {
        if (text[i] === "\\") {
          i += text[i + 1] === "\r" && text[i + 2] === "\n" ? 3 : 2;
          continue;
        }
        if (text[i] === '"') {
          i++;
          closed = true;
          break;
        }
        if (text[i] === "\n") break;
        i++;
      }
      if (!closed) {
        problems.push({ severity: "error", code: "unterminated-string", message: "string literal is never closed", start });
      }
      push("string", start, i);
      atLineStart = false;
      continue;
    }

    if (isIdentStart(c)) {
      const start = i;
      i++;
      while (isIdentChar(text[i])) i++;
      push("ident", start, i);
      atLineStart = false;
      continue;
    }

    if (isDigit(c) || (c === "." && isDigit(text[i + 1]))) {
      const start = i;
      i++;
      // 0x1F, 1.5, 1e-3, 1.0f -- consume the shape and let the evaluator decide what it is.
      while (i < text.length) {
        const d = text[i];
        if (isIdentChar(d) || d === ".") {
          i++;
          continue;
        }
        if ((d === "+" || d === "-") && /[eE]/.test(text[i - 1])) {
          i++;
          continue;
        }
        break;
      }
      push("number", start, i);
      atLineStart = false;
      continue;
    }

    let matched = null;
    for (const p of PUNCTUATION) {
      if (text.startsWith(p, i)) {
        matched = p;
        break;
      }
    }
    if (!matched) {
      problems.push({
        severity: "error",
        code: "unexpected-character",
        message: `unexpected character ${JSON.stringify(c)}`,
        start: i,
      });
      i++;
      atLineStart = false;
      continue;
    }
    push("punct", i, i + matched.length, matched);
    i += matched.length;
    atLineStart = false;
  }

  tokens.push({ type: "eof", value: "", start: text.length, end: text.length });
  return { tokens, comments, problems };
}

/** A line index: offset -> 1-based line, in O(log n). Built once per file. */
export function lineIndex(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

/**
 * The lines of a file, counted the way an editor counts them.
 *
 * A final newline does not open an empty last line (so a 15-line file that ends with `\n` is 15
 * lines, not 16), an empty file is 0 lines, and a CRLF line ending is stripped so a range printed by
 * `cat` is the text and not the text plus a `\r`. 58 of the 21 994 vanilla resources use CRLF, and
 * mod scripts are worse.
 */
export function splitLines(text) {
  const lines = text.split("\n");
  if (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
}

/**
 * Parse the `<lines>` argument of `cat`: `400` is line 400, `400-500` is that inclusive range, and
 * `400-` runs to the end of the file.
 *
 * `fileLines` is what the file actually has: a range that starts past the end is an error (an empty
 * answer would look like an empty file), and one that ends past it is clamped and says so.
 */
export function parseLineSpec(spec, fileLines) {
  const raw = String(spec).trim();
  const m = raw.match(/^(\d+)(?:\s*-\s*(\d*))?$/);
  if (!m) throw new Error(`<lines> must be 400, 400-500 or 400-, not ${JSON.stringify(spec)}`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : m[2] === "" ? fileLines : Number(m[2]);
  if (from < 1) throw new Error(`lines are counted from 1, not ${from}`);
  if (to < from) throw new Error(`the range ${from}-${to} runs backwards`);
  if (from > fileLines) {
    throw new Error(`the file has ${fileLines} line(s); ${fileLines ? `${from} is past its end` : "it is empty"}`);
  }
  const end = Math.min(to, fileLines);
  return { from, to: end, requestedTo: to, clamped: end !== to };
}

// ---------------------------------------------------------------------------
// Doc comments
// ---------------------------------------------------------------------------

/** A line that is only a rule or a divider, which the conventions put between members. */
const SEPARATOR_LINE = /^\/[/*=~_-]{3,}\s*$/;

/** Doxygen commands that describe a *group*, not the declaration below them. Both spellings. */
const GROUP_COMMAND = /[@\\](?:addtogroup|defgroup|ingroup|mainpage|subpage|weakgroup|group)\b\s*([^\s{}]+)?/;

/**
 * The text of a comment with its markers removed ... one string, lines joined.
 *
 * `//!` and `///` lose their marker and one following space; a block comment loses its opening and
 * closing marker and the common leading indentation of its lines. Nothing inside is rewritten, so a
 * `\param` or a markdown link survives verbatim.
 */
export function docText(comment) {
  const lines = comment.text.split("\n");
  const out = [];
  for (let n = 0; n < lines.length; n++) {
    let line = lines[n];
    if (n === 0) {
      if (comment.marker === "/*!" || comment.marker === "/**") line = line.slice(3);
      else if (comment.marker === "/*") line = line.slice(2);
      else if (comment.marker === "///") line = line.slice(3);
      else if (comment.marker === "//!<") line = line.slice(4);
      else if (comment.marker === "//!") line = line.slice(3);
      else if (comment.marker === "//") line = line.slice(2);
    } else if (comment.marker === "//!<" || comment.marker === "//!" || comment.marker === "///" || comment.marker === "//") {
      line = line.replace(/^\s*\/\/[/!]?</, "");
    }
    if (n === lines.length - 1 && line.trimEnd().endsWith("*/")) line = line.slice(0, line.trimEnd().length - 2);
    out.push(line.replace(/\s+$/, ""));
  }
  // Drop the empty first and last lines a block comment usually has.
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  // Remove the indentation the comment shares with the asterisks of a `/** ... */` block.
  const indents = out.filter((l) => l.trim()).map((l) => (l.match(/^[ \t]*/) ?? [""])[0].length);
  const common = indents.length ? Math.min(...indents) : 0;
  return out.map((l) => l.slice(common).replace(/^\s*\* ?/, "")).join("\n").trim();
}

/** The `\tag text` and `@tag text` lines of a doc comment, in order: what an agent reads first. */
export function docTags(text) {
  const tags = [];
  for (const line of String(text ?? "").split("\n")) {
    const m = line.match(/^\s*[@\\]([A-Za-z_]+(?:\[[^\]]*\])?)\s*(.*)$/);
    if (m) tags.push({ tag: m[1], text: m[2].trim() });
  }
  return tags;
}

/**
 * Work out what a declaration's leading trivia says about it: `doc` (the docstring), `banner` (a
 * plain block comment directly above ... vanilla writes its class descriptions this way), and `group`
 * (an `\addtogroup`/`\defgroup` name from a doc comment that documents a *group*, not the type).
 *
 * The scan walks **backwards** from the declaration through the comments that are contiguous with
 * it: only blank lines and divider lines are allowed in between (that is what the conventions
 * prescribe: divider, doc lines, declaration). A doc comment that is group-only is skipped and the
 * scan continues ... in a generated file the group marker sits between the banner and the class, and
 * both are worth reporting.
 */
export function docOf(comments, text, declStart, previousTokenEnd) {
  const before = comments.filter((c) => c.end <= declStart && c.start >= previousTokenEnd);
  // Keep only the comments that touch the declaration: the gap between one comment and the next
  // (or the declaration) may hold whitespace and at most one newline -- no blank line.
  const selected = [];
  let boundary = declStart;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (!contiguous(text.slice(c.end, boundary))) break;
    selected.unshift(c);
    boundary = c.start;
  }
  return classifyTrivia(selected, text);
}

/**
 * True when the text between a comment and what follows it holds **at most one blank line**.
 *
 * One blank line is allowed because vanilla writes `/*! \addtogroup X \{ *\/` , an empty line and
 * only then the class (`Attribute.c` lines 7-12), and the big `/* ... *\/` banner of a hand-written
 * class is separated the same way. Two blank lines end the block: that is the convention's "this
 * comment belongs to nothing" spacing.
 */
function contiguous(gap) {
  let newlines = 0;
  for (let i = 0; i < gap.length; i++) {
    const ch = gap[i];
    if (ch === "\n") {
      newlines++;
      if (newlines > 2) return false;
    } else if (ch !== " " && ch !== "\t" && ch !== "\r") return false;
  }
  return true;
}

/** A `//----`, `//====`, `////` divider: the conventions put one above every documented method. */
function isSeparator(comment) {
  if (comment.marker !== "//") return false;
  return /^\/\/[-=~_+*/#\s]{3,}$/.test(comment.text.trimEnd());
}

/** True when a doc comment only carries group markup (`\addtogroup X`, `@ingroup X`, `\{`, `\}`). */
function isGroupOnly(comment) {
  let body = docText(comment);
  body = body.replace(GROUP_COMMAND, " ");
  body = body.replace(/[@\\][{}]/g, " ");
  return !body.replace(/[\s*]/g, "");
}

/** The name in `\addtogroup X` / `\defgroup X`, or null. */
function groupName(comment) {
  const m = docText(comment).match(GROUP_COMMAND);
  if (!m) return null;
  const name = (m[1] ?? "").replace(/[^\w:.-].*$/, "");
  return name || null;
}

/** Assemble a doc/banner/group answer from the comments that touch a declaration. */
function classifyTrivia(selected, text) {
  const lineAt = lineIndex(text);
  const answer = { doc: null, banner: null, group: null, groupStart: null };
  let docComments = [];
  for (let i = selected.length - 1; i >= 0; i--) {
    const c = selected[i];
    if (isSeparator(c)) continue;
    if (c.doc && c.trailing) continue; // `//!<` documents what precedes it, not what follows
    if (c.doc && isGroupOnly(c) && !docComments.length) {
      answer.group ??= groupName(c);
      if (answer.group) answer.groupStart ??= lineAt(c.start);
      continue;
    }
    if (c.doc) {
      docComments.unshift(c);
      // A run of `//!` lines is one docstring; keep collecting while the marker matches.
      const want = c.marker;
      while (i > 0) {
        const above = selected[i - 1];
        if (!above.doc || above.marker !== want || above.trailing || isSeparator(above)) break;
        if (isGroupOnly(above)) break;
        docComments.unshift(above);
        i--;
      }
      break;
    }
    if (c.marker === "/*" && !answer.banner) {
      answer.banner = {
        marker: c.marker,
        start: lineAt(c.start),
        end: lineAt(Math.max(c.start, c.end - 1)),
        text: docText(c),
      };
      break;
    }
    break; // a plain `//` line that is not a divider: not ours
  }
  // A group marker can sit anywhere in the block -- vanilla writes `/// @ingroup X` *above* the
  // banner in a hand-written file and `/*! \addtogroup X *\/` *below* it in a generated one -- so it is
  // looked for on its own, after the docstring/banner question is settled.
  for (let i = selected.length - 1; i >= 0 && !answer.group; i--) {
    const c = selected[i];
    if (!c.doc || c.trailing || !isGroupOnly(c)) continue;
    const name = groupName(c);
    if (name) {
      answer.group = name;
      answer.groupStart = lineAt(c.start);
    }
  }
  if (docComments.length) {
    const first = docComments[0];
    const last = docComments[docComments.length - 1];
    answer.doc = {
      marker: first.marker,
      start: lineAt(first.start),
      end: lineAt(Math.max(last.start, last.end - 1)),
      text: docComments.map((c) => docText(c)).join("\n").trim(),
      tags: docTags(docComments.map((c) => docText(c)).join("\n")),
      trailing: false,
    };
  }
  return answer;
}

/** A `//!<` comment on one of the declaration's own lines, if there is one. Lines, not offsets. */
function trailingDoc(comments, text, fromLine, toLine = fromLine) {
  const lineAt = lineIndex(text);
  for (const c of comments) {
    if (c.marker !== "//!<") continue;
    const at = lineAt(c.start);
    if (at < fromLine || at > toLine) continue;
    return {
      marker: c.marker,
      start: at,
      end: at,
      text: docText(c),
      tags: docTags(docText(c)),
      trailing: true,
    };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Token rendering
// ---------------------------------------------------------------------------

/**
 * Render tokens as a signature: single spaces between words, none inside brackets or around a dot.
 *
 * Signatures are for reading and for comparing, not for re-compiling, and the corpus is wildly
 * inconsistent about spacing (`class X: Y`, `class X : Y`, `void Foo(out  int x)`), so one spelling
 * is chosen: `class X : Y`, `array<array<int>>`, `void Foo(out int x)`.
 *
 * `<` is glued to both of its neighbours because a type argument list is the only place it appears in
 * a signature -- a default value that compares two numbers would lose a space, which is a trade a
 * reader of signatures can take.
 */
export function joinTokens(tokens) {
  const NO_SPACE_BEFORE = new Set([")", "]", ",", ";", ".", "::", ">", ">>", "(", "[", "<"]);
  const NO_SPACE_AFTER = new Set(["(", "[", "<", ".", "::", "~"]);
  let out = "";
  for (const t of tokens) {
    const value = t.value;
    if (!out) {
      out = value;
      continue;
    }
    const prev = out.slice(-1);
    if (NO_SPACE_BEFORE.has(value) || NO_SPACE_AFTER.has(prev)) out += value;
    else out += ` ${value}`;
  }
  return out;
}

/** Everything except `private`/`protected`/`public`: a signature reads without its visibility. */
const VISIBILITY = new Set(["private", "protected", "public"]);

/**
 * Drop the modifiers a declaration header starts with, and keep every later `ref`.
 *
 * `protected ref array<ref SCR_Item> m_aItems` is a strong reference to an array of strong references:
 * filtering every `ref` out of the header would lose the inner one, so only the run at the front goes.
 */
export function stripLeadingModifiers(tokens) {
  let i = 0;
  while (i < tokens.length && tokens[i].type === "ident" && MODIFIERS.has(tokens[i].value)) i++;
  return tokens.slice(i);
}


/** The words a declaration may be prefixed with. Order is free in the corpus (`override static`). */
const MODIFIERS = new Set([
  "static", "const", "ref", "autoptr", "owned", "notnull", "volatile", "event", "override", "proto",
  "native", "external", "sealed", "private", "protected", "public", "modded", "final", "reference",
  "out", "inout", "in",
]);

// ---------------------------------------------------------------------------
// Parser
// ---------------------------------------------------------------------------

/**
 * Parse one script file into declarations.
 *
 * The parser is a **structural** reader: it understands declaration headers (modifiers, name, type
 * parameters, base clause, parameter list, attributes, doc comments) and *skips* method bodies and
 * initialisers by matching brackets. That is deliberate ... a body is arbitrary code, and the only
 * thing this tool promises about it is where it starts and where it ends.
 */
class Parser {
  constructor(text, name, tokens, comments, problems) {
    this.text = text;
    this.name = name;
    this.tokens = tokens;
    this.comments = comments;
    this.problems = problems;
    this.i = 0;
    this.lineAt = lineIndex(text);
    this.conditions = []; // the open `#ifdef`/`#ifndef`/`#else` frames
    this.directives = [];
    this.declarations = [];
  }

  peek(k = 0) {
    return this.tokens[Math.min(this.i + k, this.tokens.length - 1)];
  }

  next() {
    const t = this.tokens[this.i];
    if (t.type !== "eof") this.i++;
    return t;
  }

  problem(severity, code, message, at) {
    this.problems.push({ severity, code, message, line: this.lineAt(at ?? this.peek().start) });
  }

  conditionsNow() {
    return this.conditions.map((f) => (f.branch === "else" ? `!${f.raw}` : f.raw));
  }

  handleDirective(token) {
    const word = token.word;
    this.directives.push({ directive: word, argument: token.argument, line: this.lineAt(token.start) });
    const frame = { raw: token.value.replace(/^#\s*/, "#"), word, branch: "if" };
    if (word === "ifdef" || word === "ifndef" || word === "if") {
      this.conditions.push(frame);
    } else if (word === "else") {
      if (!this.conditions.length) this.problem("error", "stray-else", `#else without an open #if`, token.start);
      else this.conditions[this.conditions.length - 1].branch = "else";
    } else if (word === "elif") {
      if (!this.conditions.length) this.problem("error", "stray-elif", `#elif without an open #if`, token.start);
    } else if (word === "endif") {
      if (!this.conditions.length) this.problem("error", "stray-endif", `#endif without an open #if`, token.start);
      else this.conditions.pop();
    } else if (!["define", "undef", "include", "pragma", "error", "warning", "line", "insert"].includes(word)) {
      this.problem("warning", "unknown-directive", `unknown preprocessor directive "#${word}"`, token.start);
    }
  }

  /** `[Name(args)]`, `[A(), B("x")]` ... one bracket may hold several attributes. */
  parseAttributes() {
    const attrs = [];
    while (this.peek().type === "punct" && this.peek().value === "[") {
      const open = this.peek();
      const saved = this.i;
      this.next();
      let depth = 1;
      const inner = [];
      let close = null;
      while (depth > 0) {
        const t = this.next();
        if (t.type === "eof") break;
        if (t.type === "punct" && t.value === "[") depth++;
        else if (t.type === "punct" && t.value === "]") {
          depth--;
          if (depth === 0) {
            close = t;
            break;
          }
        }
        inner.push(t);
      }
      if (!close) {
        this.problem("error", "unterminated-attribute", "attribute bracket is never closed", open.start);
        this.i = saved;
        return attrs;
      }
      // Split at top-level commas: `[Attribute("x"), Custom("y")]` is two attributes.
      let current = [];
      const groups = [];
      let nest = 0;
      for (const t of inner) {
        if (t.type === "punct" && (t.value === "(" || t.value === "{" || t.value === "[")) nest++;
        else if (t.type === "punct" && (t.value === ")" || t.value === "}" || t.value === "]")) nest--;
        if (nest === 0 && t.type === "punct" && t.value === ",") {
          groups.push(current);
          current = [];
        } else current.push(t);
      }
      if (current.length) groups.push(current);
      for (const group of groups) {
        if (!group.length) continue;
        const name = group[0].type === "ident" ? group[0].value : null;
        if (!name) continue;
        let args = null;
        if (group[1]?.type === "punct" && group[1].value === "(") {
          // The arguments run to the bracket that *matches* this one: an attribute's argument list
          // may contain calls (`ParamEnumArray.FromEnum(X)`), array literals (`{ ... }`) and nested
          // parentheses, so the first `)` is not the end of it.
          let nest = 0;
          let closeAt = -1;
          for (let n = 1; n < group.length; n++) {
            const t = group[n];
            if (t.type !== "punct") continue;
            if (t.value === "(") nest++;
            else if (t.value === ")") {
              nest--;
              if (nest === 0) {
                closeAt = n;
                break;
              }
            }
          }
          const argTokens = group.slice(2, closeAt < 0 ? undefined : closeAt);
          args = argTokens.length ? this.text.slice(argTokens[0].start, argTokens[argTokens.length - 1].end) : "";
        }
        attrs.push({
          name,
          args,
          line: this.lineAt(group[0].start),
          raw: this.text.slice(group[0].start, group[group.length - 1].end),
        });
      }
    }
    return attrs;
  }

  /** Consume the modifier words of a declaration header; anything else is left in place. */
  parseModifiers() {
    const modifiers = [];
    const tokens = [];
    while (this.peek().type === "ident" && MODIFIERS.has(this.peek().value)) {
      // `class` may follow `modded`, but `class` is never a modifier; and `const` cannot be a name
      // in this position, so a known modifier word here is always the modifier.
      const t = this.next();
      modifiers.push(t.value);
      tokens.push(t);
    }
    return { modifiers, tokens };
  }

  visibilityOf(modifiers) {
    if (modifiers.includes("private")) return "private";
    if (modifiers.includes("protected")) return "protected";
    return "public";
  }

  parseFile() {
    this.parseBody(null);
    if (this.conditions.length) {
      for (const frame of this.conditions) {
        this.problem("error", "unclosed-ifdef", `${frame.raw} is never closed by #endif`, this.peek().start);
      }
      this.conditions = [];
    }
    return this.declarations;
  }

  /**
   * Parse declarations until `}` (when `owner` is a class) or EOF.
   *
   * `owner` is the class declaration whose members these are; null at file scope.
   */
  parseBody(owner) {
    const out = owner ? owner.members : this.declarations;
    while (true) {
      const t = this.peek();
      if (t.type === "eof") return;
      if (t.type === "directive") {
        this.handleDirective(this.next());
        continue;
      }
      if (t.type === "punct" && t.value === "}") {
        if (owner) return;
        // A stray `}` at file scope: report it and keep going, so one bad brace does not lose the file.
        this.problem("error", "stray-brace", "closing brace without an opening one at file scope", t.start);
        this.next();
        continue;
      }
      if (t.type === "punct" && t.value === ";") {
        this.next();
        continue;
      }
      const startIndex = this.i;
      const startOffset = t.start;
      // Attributes, and the stray `;` vanilla sometimes writes after one (`[Attribute("0")];`).
      // The attributes still belong to the declaration that follows.
      let attrs = [];
      while (true) {
        attrs = attrs.concat(this.parseAttributes());
        if (this.peek().type === "punct" && this.peek().value === ";") {
          this.next();
          continue;
        }
        break;
      }
      const { modifiers, tokens: modifierTokens } = this.parseModifiers();
      const keyword = this.peek();
      let decl = null;
      if (keyword.type === "ident" && keyword.value === "class") {
        decl = this.parseClass(attrs, modifiers, modifierTokens, startIndex, startOffset);
        if (owner) (owner.nested ??= []).push(decl);
      } else if (keyword.type === "ident" && keyword.value === "enum") {
        decl = this.parseEnum(attrs, modifiers, modifierTokens, startIndex, startOffset);
        if (owner) (owner.nested ??= []).push(decl);
      } else if (keyword.type === "ident" && keyword.value === "typedef") {
        decl = this.parseTypedef(attrs, startIndex, startOffset);
        if (owner) (owner.nested ??= []).push(decl);
      } else {
        decl = this.parseMember(owner, attrs, modifiers, modifierTokens, startIndex, startOffset);
      }
      if (decl) out.push(decl);
      if (this.i === startIndex) {
        // Safety net: never loop forever on a token this parser does not understand.
        this.problem("error", "unparsable", `cannot parse ${JSON.stringify(this.peek().value)} here`, this.peek().start);
        this.next();
      }
    }
  }

  /** Shared header bookkeeping: doc comments, banner, conditions, range. */
  finishHeader(decl, startOffset, startIndex) {
    const previousEnd = startIndex > 0 ? this.tokens[startIndex - 1].end : 0;
    const trivia = docOf(this.comments, this.text, startOffset, previousEnd);
    decl.doc = trivia.doc;
    decl.banner = trivia.banner;
    decl.group = trivia.group;
    decl.conditions = this.conditionsNow();
    return decl;
  }

  parseClass(attrs, modifiers, modifierTokens, startIndex, startOffset) {
    const classToken = this.next(); // `class`
    const nameToken = this.peek().type === "ident" ? this.next() : null;
    if (!nameToken) {
      this.problem("error", "missing-class-name", "class without a name", classToken.start);
      return null;
    }
    const decl = {
      kind: "class",
      name: nameToken.value,
      owner: null,
      attrs,
      modifiers,
      visibility: this.visibilityOf(modifiers),
      modded: modifiers.includes("modded"),
      sealed: modifiers.includes("sealed"),
      base: null,
      typeParams: [],
      members: [],
      signature: "",
      signatureRange: null,
      range: { start: this.lineAt(startOffset), end: this.lineAt(classToken.start) },
      forward: false,
    };
    // Type parameters: `class Item<Class T>`, `class Tuple3<Class T1, Class T2, Class T3>`.
    const typeParamTokens = [];
    if (this.peek().type === "punct" && this.peek().value === "<") {
      let depth = 0;
      do {
        const t = this.next();
        typeParamTokens.push(t);
        if (t.type === "punct" && t.value === "<") depth++;
        else if (t.type === "punct" && t.value === ">") depth--;
        else if (t.type === "punct" && t.value === ">>") depth -= 2;
        if (t.type === "eof") break;
      } while (depth > 0);
      decl.typeParams = splitTopLevel(typeParamTokens.slice(1, -1), this.text).map((part) =>
        joinTokens(part).trim(),
      );
    }
    // Base clause: `:` or `extends`, then a type expression, up to the body or the `;`.
    const baseTokens = [];
    if (this.peek().type === "ident" && this.peek().value === "extends") baseTokens.push(this.next());
    if (this.peek().type === "punct" && this.peek().value === ":") baseTokens.push(this.next());
    while (true) {
      const t = this.peek();
      if (t.type === "eof") break;
      if (t.type === "punct" && (t.value === "{" || t.value === ";")) break;
      if (t.type === "directive") break;
      baseTokens.push(this.next());
    }
    if (baseTokens.length) {
      decl.base = joinTokens(baseTokens.filter((t) => t.value !== ":" && t.value !== "extends")).trim() || null;
    }
    // The signature is rebuilt from the tokens in order, which keeps `modded`/`sealed`/generics.
    const signatureTokens = [
      ...modifierTokens.filter((t) => !VISIBILITY.has(t.value)),
      classToken,
      nameToken,
      ...typeParamTokens,
      ...baseTokens,
    ];
    decl.signature = joinTokens(signatureTokens);
    decl.signatureRange = {
      start: this.lineAt(signatureTokens[0].start),
      end: this.lineAt(Math.max(signatureTokens[0].start, signatureTokens[signatureTokens.length - 1].end - 1)),
    };
    this.finishHeader(decl, startOffset, startIndex);
    if (this.peek().type === "punct" && this.peek().value === ";") {
      decl.forward = true;
      const semi = this.next();
      decl.range = { start: decl.range.start, end: this.lineAt(semi.start) };
      decl.members = [];
      return decl;
    }
    if (!(this.peek().type === "punct" && this.peek().value === "{")) {
      this.problem("warning", "class-without-body", `class ${decl.name} has no body`, this.peek().start);
      decl.range = { start: decl.range.start, end: this.lineAt(this.peek().start) };
      return decl;
    }
    this.next(); // `{`
    this.parseBody(decl);
    const close = this.peek().type === "punct" && this.peek().value === "}" ? this.next() : null;
    if (!close) {
      this.problem("error", "unclosed-class", `class ${decl.name} is never closed`, this.peek().start);
      decl.range.end = this.lineAt(this.text.length);
      return decl;
    }
    decl.range.end = this.lineAt(close.start);
    if (this.peek().type === "punct" && this.peek().value === ";") this.next();
    for (const member of decl.members) member.owner = decl;
    for (const nested of decl.nested ?? []) nested.owner = decl;
    return decl;
  }

  parseEnum(attrs, modifiers, modifierTokens, startIndex, startOffset) {
    const enumToken = this.next(); // `enum`
    const nameToken = this.peek().type === "ident" ? this.next() : null;
    if (!nameToken) {
      this.problem("error", "missing-enum-name", "enum without a name", enumToken.start);
      return null;
    }
    const decl = {
      kind: "enum",
      name: nameToken.value,
      owner: null,
      attrs,
      modifiers,
      visibility: this.visibilityOf(modifiers),
      modded: modifiers.includes("modded"),
      base: null,
      values: [],
      signature: "",
      signatureRange: null,
      range: { start: this.lineAt(startOffset), end: this.lineAt(enumToken.start) },
    };
    const baseTokens = [];
    if (this.peek().type === "punct" && this.peek().value === ":") {
      baseTokens.push(this.next());
      while (true) {
        const t = this.peek();
        if (t.type === "eof") break;
        if (t.type === "punct" && (t.value === "{" || t.value === ";")) break;
        if (t.type === "directive") break;
        baseTokens.push(this.next());
      }
      decl.base = joinTokens(baseTokens.filter((t) => t.value !== ":")).trim() || null;
    }
    const signatureTokens = [
      ...modifierTokens.filter((t) => !VISIBILITY.has(t.value)),
      enumToken,
      nameToken,
      ...baseTokens,
    ];
    decl.signature = joinTokens(signatureTokens);
    decl.signatureRange = {
      start: this.lineAt(signatureTokens[0].start),
      end: this.lineAt(Math.max(signatureTokens[0].start, signatureTokens[signatureTokens.length - 1].end - 1)),
    };
    this.finishHeader(decl, startOffset, startIndex);
    if (!(this.peek().type === "punct" && this.peek().value === "{")) {
      if (this.peek().type === "punct" && this.peek().value === ";") this.next();
      decl.range.end = this.lineAt(this.peek().start);
      return decl;
    }
    this.next(); // `{`
    while (true) {
      const t = this.peek();
      if (t.type === "eof") {
        this.problem("error", "unclosed-enum", `enum ${decl.name} is never closed`, t.start);
        break;
      }
      if (t.type === "directive") {
        this.handleDirective(this.next());
        continue;
      }
      if (t.type === "punct" && t.value === "}") break;
      if (t.type === "punct" && t.value === ",") {
        this.next();
        continue;
      }
      if (t.type === "punct" && t.value === ";") {
        this.next();
        continue;
      }
      const valueStartIndex = this.i;
      const valueAttrs = this.parseAttributes();
      const previousEnd = valueStartIndex > 0 ? this.tokens[valueStartIndex - 1].end : 0;
      const valueStart = this.tokens[valueStartIndex].start;
      const valueToken = this.next();
      if (valueToken.type !== "ident") {
        this.problem("warning", "enum-value", `unexpected ${JSON.stringify(valueToken.value)} in enum ${decl.name}`, valueToken.start);
        continue;
      }
      const value = {
        kind: "enumValue",
        name: valueToken.value,
        owner: decl,
        attrs: valueAttrs,
        expr: null,
        value: null,
        computed: true,
        line: this.lineAt(valueToken.start),
        endLine: this.lineAt(valueToken.start),
        doc: null,
      };
      if (this.peek().type === "punct" && this.peek().value === "=") {
        this.next();
        const exprTokens = [];
        while (true) {
          const e = this.peek();
          if (e.type === "eof") break;
          if (e.type === "punct" && (e.value === "," || e.value === "}")) break;
          if (e.type === "directive") break;
          exprTokens.push(this.next());
        }
        value.expr = joinTokens(exprTokens);
        value.exprTokens = exprTokens;
        value.computed = false;
        if (exprTokens.length) value.endLine = this.lineAt(exprTokens[exprTokens.length - 1].end);
      }
      // A constant may be documented above it (`//! A rifle`) or after it (`//!< a rifle`).
      const above = docOf(this.comments, this.text, valueStart, previousEnd);
      value.doc = trailingDoc(this.comments, this.text, value.line, value.endLine) ?? above.doc ?? null;
      decl.values.push(value);
    }
    const close = this.peek().type === "punct" && this.peek().value === "}" ? this.next() : null;
    if (!close) {
      decl.range.end = this.lineAt(this.text.length);
      return decl;
    }
    decl.range.end = this.lineAt(close.start);
    if (this.peek().type === "punct" && this.peek().value === ";") this.next();
    return decl;
  }

  parseTypedef(attrs, startIndex, startOffset) {
    const typedefToken = this.next(); // `typedef`
    const tokens = [];
    while (true) {
      const t = this.peek();
      if (t.type === "eof") break;
      if (t.type === "punct" && (t.value === ";" || t.value === "}")) break;
      if (t.type === "directive") break;
      tokens.push(this.next());
    }
    const semi = this.peek().type === "punct" && this.peek().value === ";" ? this.next() : null;
    const nameToken = [...tokens].reverse().find((t) => t.type === "ident") ?? typedefToken;
    const decl = {
      kind: "typedef",
      name: nameToken.value,
      alias: joinTokens(tokens.filter((t) => t !== nameToken)),
      owner: null,
      attrs,
      modifiers: [],
      visibility: "public",
      modded: false,
      signature: joinTokens([typedefToken, ...tokens]),
      signatureRange: { start: this.lineAt(typedefToken.start), end: this.lineAt((semi ?? nameToken).start) },
      range: { start: this.lineAt(startOffset), end: this.lineAt((semi ?? nameToken).start) },
    };
    this.finishHeader(decl, startOffset, startIndex);
    return decl;
  }

  /**
   * A field or a method ... decided by the first `(`, `=` or `;` at bracket depth 0.
   *
   * `int x = f(1);` stops at `=` (a field with a call in its initialiser); `void F(int a)` stops at
   * `(` (a method). No type in the corpus needs angle-bracket tracking to tell those apart.
   */
  parseMember(owner, attrs, modifiers, modifierTokens, startIndex, startOffset) {
    const headerTokens = [];
    let brackets = 0;
    let stop = null;
    while (true) {
      const t = this.peek();
      if (t.type === "eof") break;
      if (t.type === "directive") break;
      if (t.type === "punct") {
        if (t.value === "[") brackets++;
        else if (t.value === "]") brackets = Math.max(0, brackets - 1);
        else if (brackets === 0 && (t.value === "(" || t.value === "=" || t.value === ";" || t.value === "{" || t.value === "}")) {
          stop = t;
          break;
        }
      }
      headerTokens.push(this.next());
    }
    if (!headerTokens.length && !stop) return null;
    if (stop && stop.value === "{") {
      // A header followed straight by a block is neither a field nor a method: a real syntax error.
      // Skip the block so the rest of the file still parses, and report it.
      this.problem(
        "error",
        "unexpected-block",
        `a declaration ending in "{" is neither a field nor a method: ${joinTokens(headerTokens)}`,
        stop.start,
      );
      const open = this.next();
      this.collectBalanced(open, "{", "}");
      return null;
    }
    const nameIndex = headerTokens.findLastIndex((t) => t.type === "ident");
    const nameToken = nameIndex >= 0 ? headerTokens[nameIndex] : null;
    if (!nameToken) {
      if (stop && (stop.value === ";" || stop.value === "}")) {
        // Nothing but punctuation: a stray `;` or a body that is empty already.
        if (stop.value === ";") this.next();
        return null;
      }
      this.problem("error", "missing-name", `declaration without a name before ${JSON.stringify(stop?.value ?? "EOF")}`, startOffset);
      if (stop) this.next();
      return null;
    }
    if (stop && stop.value === "}") {
      // A field declared without its trailing `;`, right before the class closes: 1 ships in vanilla
      // (`ResourceName Prefab` in EntitySerializerDefaultSpawnData.c). Report it as the field it is.
      this.problem("note", "field-without-semicolon", `field ${nameToken.value} has no trailing ";"`, nameToken.start);
    }
    const isMethod = stop && stop.value === "(";
    const beforeName = headerTokens.slice(0, nameIndex);
    const notNull = modifiers.includes("notnull");
    // The declared type is what is left of the header once the leading modifiers are taken out; a
    // `ref` inside a type argument (`array<ref X>`) is part of the type and stays.
    const declaredType = joinTokens(stripLeadingModifiers(beforeName)).trim() || null;
    const decl = {
      kind: isMethod ? (owner ? "method" : "function") : (owner ? "field" : "variable"),
      name: nameToken.value,
      owner,
      attrs,
      modifiers,
      visibility: this.visibilityOf(modifiers),
      modded: modifiers.includes("modded"),
      static: modifiers.includes("static"),
      const: modifiers.includes("const"),
      ref: modifiers.includes("ref"),
      override: modifiers.includes("override"),
      sealed: modifiers.includes("sealed"),
      proto: modifiers.includes("proto"),
      native: modifiers.includes("native"),
      external: modifiers.includes("external"),
      volatile: modifiers.includes("volatile"),
      event: modifiers.includes("event"),
      notnull: notNull,
      type: declaredType,
      signature: "",
      signatureRange: null,
      range: { start: this.lineAt(startOffset), end: this.lineAt(nameToken.start) },
      doc: null,
      banner: null,
      group: null,
      conditions: [],
    };
    // A field's C-style declarator: `ref X m_a[10];`.
    const arrayTail = headerTokens.slice(nameIndex + 1);
    if (arrayTail.length) decl.arraySize = joinTokens(arrayTail.filter((t) => t.value !== "[" && t.value !== "]")).trim() || null;
    if (isMethod) {
      const parenToken = stop;
      const isDestructor = beforeName.length && beforeName[beforeName.length - 1].value === "~";
      decl.isDestructor = !!isDestructor;
      decl.isConstructor = !!owner && owner.kind === "class" && owner.name === decl.name && !isDestructor;
      decl.returnType = joinTokens(stripLeadingModifiers(beforeName).filter((t) => t.value !== "~")).trim() || null;
      this.next(); // the `(` itself
      const paramTokens = this.collectBalanced(parenToken, "(", ")");
      decl.params = parseParams(paramTokens, this.text);
      const signatureTokens = [
        ...modifierTokens.filter((t) => !VISIBILITY.has(t.value)),
        ...stripLeadingModifiers(beforeName),
        nameToken,
      ];
      if (isDestructor) signatureTokens.splice(signatureTokens.indexOf(nameToken), 0, { type: "punct", value: "~" });
      decl.signature = `${joinTokens(signatureTokens)}(${joinTokens(paramTokens)})`;
      decl.signatureRange = {
        start: this.lineAt(signatureTokens.length ? signatureTokens[0].start : nameToken.start),
        end: this.lineAt(parenToken.start),
      };
      const after = this.peek();
      if (after.type === "punct" && after.value === "{") {
        const open = this.next();
        this.collectBalanced(open, "{", "}");
        // `collectBalanced` has already consumed the closing `}`: it is the token before the cursor,
        // and an empty body (`{\n}`) has no inner token at all -- which is why the end line comes
        // from that brace and not from the last thing inside.
        const close = this.tokens[this.i - 1] ?? open;
        decl.hasBody = true;
        decl.bodyRange = { start: this.lineAt(open.start), end: this.lineAt(close.start) };
        decl.range.end = decl.bodyRange.end;
      } else if (after.type === "punct" && after.value === ";") {
        decl.hasBody = false;
        decl.range.end = this.lineAt(this.next().start);
      } else {
        // A method header followed by neither `{` nor `;` -- RHS-StatusQuo writes the body of
        // `override UIInfo GetUIInfoScript()` on the next line without braces. That is a syntax
        // error, and skipping to the `;` keeps the statement out of the member list.
        decl.hasBody = false;
        decl.range.end = this.lineAt(parenToken.start);
        if (after.type !== "eof") {
          this.problem("error", "method-without-body", `method ${decl.name} has neither a body nor a trailing ";"`, after.start);
          while (this.peek().type !== "eof") {
            const t = this.next();
            if (t.type === "punct" && t.value === ";") break;
            if (t.type === "punct" && t.value === "}") break;
          }
        }
      }
      // A stray `;` after a body is tolerated -- 4 of them ship in vanilla.
      if (decl.hasBody && this.peek().type === "punct" && this.peek().value === ";") this.next();
    } else {
      if (stop && stop.value === "=") {
        this.next();
        const initTokens = [];
        let nest = 0;
        while (true) {
          const t = this.peek();
          if (t.type === "eof") break;
          if (t.type === "directive") break;
          if (t.type === "punct") {
            if (t.value === "(" || t.value === "[" || t.value === "{") nest++;
            else if (t.value === ")" || t.value === "]" || t.value === "}") {
              if (nest === 0) break;
              nest--;
            } else if (t.value === ";" && nest === 0) break;
          }
          initTokens.push(this.next());
        }
        // An initialiser is reported as it is written: braces, spacing and strings included.
        decl.init = initTokens.length ? this.text.slice(initTokens[0].start, initTokens[initTokens.length - 1].end) : null;
      }
      const semi = this.peek().type === "punct" && this.peek().value === ";" ? this.next() : null;
      if (!semi && this.peek().type !== "eof" && this.peek().value !== "}" && this.peek().type !== "directive") {
        this.problem("warning", "field-without-semicolon", `field ${decl.name} has no trailing ";"`, this.peek().start);
      }
      decl.range.end = this.lineAt((semi ?? nameToken).start);
      decl.signature = joinTokens([
        ...modifierTokens.filter((t) => !VISIBILITY.has(t.value)),
        ...stripLeadingModifiers(beforeName),
        nameToken,
        ...arrayTail,
      ]);
      decl.signatureRange = {
        start: this.lineAt((modifierTokens[0] ?? beforeName[0] ?? nameToken).start),
        end: this.lineAt((semi ?? arrayTail[arrayTail.length - 1] ?? nameToken).start),
      };
    }
    this.finishHeader(decl, startOffset, startIndex);
    if (!decl.doc) {
      // A `//!<` on the declaration's own last line documents what it follows.
      const trailing = trailingDoc(this.comments, this.text, decl.range.start, decl.range.end);
      if (trailing) decl.doc = trailing;
    }
    return decl;
  }

  /** Collect the tokens up to the bracket that closes `open`, returning what is inside. */
  collectBalanced(open, openChar, closeChar) {
    const inner = [];
    let depth = 0;
    while (true) {
      const t = this.peek();
      if (t.type === "eof") {
        this.problem("error", "unclosed-bracket", `"${openChar}" is never closed`, open.start);
        break;
      }
      if (t.type === "punct" && t.value === closeChar) {
        if (depth === 0) {
          this.next();
          break;
        }
        depth--;
      } else if (t.type === "punct" && t.value === openChar) depth++;
      inner.push(this.next());
    }
    return inner;
  }
}

/** Split tokens at top-level commas (generics, parens, brackets and braces nest). */
export function splitTopLevel(tokens, text) {
  const parts = [];
  let current = [];
  let nest = 0;
  for (const t of tokens) {
    if (t.type === "punct") {
      if (t.value === "(" || t.value === "[" || t.value === "{" || t.value === "<") nest++;
      else if (t.value === ")" || t.value === "]" || t.value === "}" || t.value === ">") nest = Math.max(0, nest - 1);
      else if (t.value === ">>") nest = Math.max(0, nest - 2);
    }
    if (nest === 0 && t.type === "punct" && t.value === ",") {
      parts.push(current);
      current = [];
      continue;
    }
    current.push(t);
  }
  if (current.length) parts.push(current);
  void text;
  return parts;
}

/** One parameter list as `{ modifiers, type, name, defaultValue, signature }` objects. */
export function parseParams(tokens, text) {
  const params = [];
  for (const part of splitTopLevel(tokens, text)) {
    if (!part.length) continue;
    const eq = part.findIndex((t) => t.type === "punct" && t.value === "=");
    const declTokens = eq < 0 ? part : part.slice(0, eq);
    const defaultTokens = eq < 0 ? [] : part.slice(eq + 1);
    const modifiers = [];
    let n = 0;
    while (n < declTokens.length && declTokens[n].type === "ident" && MODIFIERS.has(declTokens[n].value) && n < declTokens.length - 1) {
      // The last identifier is the parameter's name, never a modifier.
      modifiers.push(declTokens[n].value);
      n++;
    }
    const nameIndex = declTokens.findLastIndex((t) => t.type === "ident");
    const name = nameIndex >= 0 ? declTokens[nameIndex].value : null;
    const typeTokens = declTokens.slice(n, nameIndex >= 0 ? nameIndex : declTokens.length);
    params.push({
      name,
      type: joinTokens(typeTokens).trim() || null,
      modifiers,
      defaultValue: defaultTokens.length ? joinTokens(defaultTokens) : null,
      signature: joinTokens(part),
    });
  }
  return params;
}

/**
 * Parse a script's text into declarations.
 *
 * `name` is only used in messages. The answer carries the declarations, the comments and directives
 * (for callers that want them), and the *structural* problems the parser can prove: an unterminated
 * string or comment, a bracket that never closes, an unbalanced `#ifdef`.
 *
 * The problem list is the answer `check` prints, so nothing is thrown by default: a file with one
 * unterminated string still yields every declaration before it. `strict: true` is for a caller that
 * wants the first error as an exception instead -- a build step that must not accept a broken file.
 */
export function parseScript(text, { name = "<script>", strict = false } = {}) {
  const { tokens, comments, problems } = tokenize(text);
  const parser = new Parser(text, name, tokens, comments, problems);
  const declarations = parser.parseFile();
  // The lexer reports offsets; every problem a caller sees carries a line as well.
  const lineAt = lineIndex(text);
  for (const problem of problems) if (problem.line === undefined) problem.line = lineAt(problem.start ?? 0);
  if (strict) {
    const first = problems.filter((p) => p.severity === "error").sort((a, b) => (a.start ?? 0) - (b.start ?? 0))[0];
    if (first) throw new ScriptSyntaxError(name, first.message, text, first.start ?? 0);
  }
  return {
    kind: "script",
    name,
    text,
    bytes: Buffer.byteLength(text, "utf8"),
    lines: splitLines(text).length,
    tokens,
    comments,
    directives: parser.directives,
    declarations,
    problems,
  };
}

/** Parse a buffer, tolerating a UTF-8 BOM (a Workbench project's file may carry one). */
export function parseText(bytes, { name = "<script>", strict = false } = {}) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : String(bytes);
  return parseScript(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text, { name, strict });
}

/**
 * Every declaration in a file, at every depth, in source order -- enum constants included.
 *
 * `visit(decl, owner)` gets the declaration and the class it sits in (null at file scope), which is
 * what `find-defs` needs to answer "which class is this method in".
 */
export function walk(script, visit) {
  for (const decl of script.declarations) walkDeclaration(decl, visit, null);
}

function walkDeclaration(decl, visit, owner) {
  visit(decl, owner);
  for (const value of decl.values ?? []) visit(value, decl);
  for (const member of decl.members ?? []) walkDeclaration(member, visit, decl);
  for (const nested of decl.nested ?? []) walkDeclaration(nested, visit, owner);
}

/** Flatten a file's declarations: classes, enums, typedefs, then every member, in source order. */
export function declarationsOf(script) {
  const out = [];
  walk(script, (decl) => out.push(decl));
  return out;
}

/** One declaration by name (and optionally by owner), case-sensitively first. */
export function findDeclaration(script, name, { owner = null } = {}) {
  const all = declarationsOf(script);
  const pool = owner ? all.filter((d) => d.owner?.name === owner) : all;
  return pool.find((d) => d.name === name) ?? pool.find((d) => d.name.toLowerCase() === String(name).toLowerCase()) ?? null;
}

/** Every declaration with this name ... a name may repeat (`modded class`, `#ifdef` branches). */
export function findDeclarations(script, name) {
  const exact = declarationsOf(script).filter((d) => d.name === name);
  if (exact.length) return exact;
  const lowered = String(name).toLowerCase();
  return declarationsOf(script).filter((d) => d.name.toLowerCase() === lowered);
}

// ---------------------------------------------------------------------------
// Enum values
// ---------------------------------------------------------------------------

/** Evaluate an integer constant expression over enum members. Returns null when it cannot. */
export function evaluateExpression(tokens, scope) {
  let i = 0;
  const peek = () => tokens[i];
  const at = (value) => tokens[i]?.type === "punct" && tokens[i].value === value;

  function primary() {
    const t = peek();
    if (!t) return null;
    if (t.type === "number") {
      i++;
      const raw = t.value.replace(/_/g, "");
      if (/^0[xX][0-9a-fA-F]+$/.test(raw)) return parseInt(raw, 16);
      if (/^[0-9]+$/.test(raw)) return parseInt(raw, 10);
      const f = Number(raw.replace(/[fF]$/, ""));
      return Number.isFinite(f) ? Math.trunc(f) : null;
    }
    if (at("-")) {
      i++;
      const v = primary();
      return v === null ? null : -v;
    }
    if (at("+")) {
      i++;
      return primary();
    }
    if (at("~")) {
      i++;
      const v = primary();
      return v === null ? null : ~v;
    }
    if (at("(")) {
      i++;
      const v = expression(0);
      if (at(")")) i++;
      return v;
    }
    if (t.type === "ident") {
      i++;
      // `Enum.MEMBER` or a bare member of the enum being evaluated.
      let name = t.value;
      while (at(".")) {
        i++;
        const next = peek();
        if (!next || next.type !== "ident") return null;
        name = next.value;
        i++;
      }
      return scope[name] ?? null;
    }
    return null;
  }

  const PRECEDENCE = [
    ["|"],
    ["^"],
    ["&"],
    ["<<", ">>"],
    ["+", "-"],
    ["*", "/", "%"],
  ];

  function expression(level) {
    if (level >= PRECEDENCE.length) return primary();
    let left = expression(level + 1);
    while (left !== null && peek()?.type === "punct" && PRECEDENCE[level].includes(peek().value)) {
      const op = tokens[i].value;
      i++;
      const right = expression(level + 1);
      if (right === null) return null;
      switch (op) {
        case "|": left |= right; break;
        case "^": left ^= right; break;
        case "&": left &= right; break;
        case "<<": left = left * 2 ** right; break;
        case ">>": left = Math.floor(left / 2 ** right); break;
        case "+": left += right; break;
        case "-": left -= right; break;
        case "*": left *= right; break;
        case "/": left = right === 0 ? null : Math.trunc(left / right); break;
        case "%": left = right === 0 ? null : left % right; break;
        default: return null;
      }
    }
    return left;
  }

  const value = expression(0);
  return i === tokens.length ? value : null;
}

/**
 * Number an enum's constants.
 *
 * The rule the language uses: the first constant is 0, each later one is one more than the previous,
 * unless it says `= expression`. An expression may use numbers, earlier members and `Enum.MEMBER`.
 *
 * A **`modded enum`** is a different animal: it adds constants to an enum declared elsewhere, so an
 * omitted value continues from a number this file does not contain. `inheritedLast` is that number
 * when the original enum was found in the searched sources; without it, the value stays unknown and
 * `valueKnown` is false rather than a guess.
 */
export function numberEnum(decl, { inheritedLast = null, inherited = new Map() } = {}) {
  const values = decl.values ?? [];
  const scope = new Map(inherited);
  let previous = decl.modded && inheritedLast === null ? null : (inheritedLast ?? -1);
  let ok = decl.modded ? inheritedLast !== null : true;
  for (const value of values) {
    let computed = null;
    if (value.exprTokens?.length) {
      computed = evaluateExpression(value.exprTokens, Object.fromEntries(scope));
      value.valueKnown = computed !== null;
      if (computed === null) ok = false;
    } else if (previous !== null) {
      computed = previous + 1;
      value.valueKnown = true;
    } else {
      value.valueKnown = false;
      ok = false;
    }
    if (!value.exprTokens?.length) value.computed = true;
    else value.computed = false;
    value.value = computed;
    if (computed !== null) {
      previous = computed;
      scope.set(value.name, computed);
      scope.set(`${decl.name}.${value.name}`, computed);
    } else {
      previous = null;
      ok = false;
    }
  }
  decl.valuesKnown = ok;
  return decl;
}

// ---------------------------------------------------------------------------
// Sources: a universe of scripts to search
// ---------------------------------------------------------------------------

/** Directories that never hold game code, and are expensive or wrong to walk. */
const SKIP_DIRS = new Set(["saves", "node_modules", ".git", ".svn", "logs"]);

/** The directory that owns a Workbench project or a downloaded addon, or null. */
export function enclosingAddon(filePath) {
  let dir = dirname(resolvePath(filePath));
  for (let n = 0; n < 12; n++) {
    let names = [];
    try {
      names = readdirSync(dir);
    } catch {
      return null;
    }
    if (names.some((name) => name.endsWith(".gproj"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
  return null;
}

/** Every `*.pak` under a directory, in name order, skipping `saves/` and the like. */
export function pakFilesUnder(dir, depth = 8) {
  const out = [];
  const walk = (at, level) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (level < depth && !SKIP_DIRS.has(e.name)) walk(join(at, e.name), level + 1);
      } else if (/\.pak$/i.test(e.name)) out.push(join(at, e.name));
    }
  };
  if (statSync(dir).isFile()) return [dir];
  walk(dir, 0);
  return out.sort();
}

/** Every `.c` file under a directory, skipping the usual noise. */
export function scriptFilesUnder(dir, depth = 24) {
  const out = [];
  const walk = (at, level) => {
    let entries;
    try {
      entries = readdirSync(at, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (e.isDirectory()) {
        if (level < depth && !SKIP_DIRS.has(e.name)) walk(join(at, e.name), level + 1);
      } else if (/\.c$/i.test(e.name)) out.push(join(at, e.name));
    }
  };
  walk(dir, 0);
  return out.sort();
}

/** The addon label of a source: its directory, or the addon folder a `.pak` sits in. */
function addonLabel(pakPath) {
  return basename(dirname(pakPath));
}

/**
 * A set of scripts to search, built from `--pak`/`--addon`/`--file`.
 *
 * Three kinds of source, because that is what a modder actually has:
 *  * `--pak <file.pak>` or `--pak <dir>` ... the vanilla archives, or a folder of them;
 *  * `--addon <dir>` ... a Workbench project (a tree of `.c` on disk) **or** a downloaded addon
 *    (`addon.gproj` + `data.pak` next to it, with the scripts only inside the archive): both work,
 *    because an addon directory is read as "every `.c` under it, plus every `.pak` directly inside";
 *  * `--file <path>` ... one script, or one `<pak>:<entry>`.
 *
 * Texts are read once and kept, and a declaration index is built by one regular-expression pass over
 * the raw text (fast and cheap) so that "who declares X" never needs a second scan. Every lookup then
 * *parses* only the candidate files, which is why searching 6 568 vanilla scripts for one class takes
 * a second rather than a minute.
 */
export class ScriptUniverse {
  constructor({ sources = [], noPakPathSplit = false } = {}) {
    this.specs = sources.map((s) => (typeof s === "string" ? { kind: "auto", value: s } : s));
    this.noPakPathSplit = noPakPathSplit;
    this.paks = new Map(); // path -> open Pak
    this.entries = new Map(); // "pak|entry" -> PakEntry, so a lookup is not a linear scan
    this.texts = new Map(); // display -> string
    this.lowered = new Map(); // display -> lower-cased string
    this.parsed = new Map(); // display -> parsed script
    this._sources = null;
    this._index = null;
    this.closed = false;
  }

  /** Resolve the specs into a flat, ordered list of sources. Cached. */
  sources() {
    if (this._sources) return this._sources;
    const out = [];
    const seen = new Set();
    const add = (source) => {
      const key = source.display.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      source.index = out.length;
      out.push(source);
    };
    // One addon: an unpacked tree and/or the archives it ships. `--addons ROOT` calls this per
    // addon directory, so a server's addons folder is one option instead of forty.
    const seenAddons = new Set();
    const addAddonDirectory = (dirPath) => {
      const key = resolvePath(dirPath).toLowerCase();
      if (seenAddons.has(key)) return;
      seenAddons.add(key);
      const label = basename(resolvePath(dirPath));
      for (const file of scriptFilesUnder(dirPath)) {
        add({ kind: "file", display: file, path: resolvePath(file), addon: label });
      }
      // A downloaded addon keeps its scripts inside an archive, with no unpacked tree.
      for (const name of readdirSync(dirPath).sort()) {
        if (!/\.pak$/i.test(name)) continue;
        const pakPath = join(dirPath, name);
        const pak = this.pak(pakPath);
        for (const entry of pak.entries) {
          if (!/\.c$/i.test(entry.path)) continue;
          add({ kind: "pak", display: `${pakPath}:${normalisePath(entry.path)}`, pak: pakPath, entry: normalisePath(entry.path), pakEntry: entry, addon: label });
        }
      }
    };
    for (const spec of this.specs) {
      const kind = spec.kind === "auto" ? guessKind(spec.value) : spec.kind;
      if (kind === "file") {
        const parsed = parseSourceSpec(spec.value, { noPakPathSplit: this.noPakPathSplit });
        if (parsed.kind === "pak") {
          const pak = this.pak(parsed.pak);
          const entry = findEntry(pak, parsed.entry);
          add({ kind: "pak", display: `${parsed.pak}:${normalisePath(entry.path)}`, pak: parsed.pak, entry: normalisePath(entry.path), pakEntry: entry, addon: addonLabel(parsed.pak) });
          continue;
        }
        if (!existsSync(parsed.path)) throw new Error(`no such file: ${parsed.path}`);
        const st = statSync(parsed.path);
        if (st.isDirectory()) {
          throw new Error(`${spec.value} is a directory: pass --addon for a tree of scripts, or --pak for an archive`);
        }
        add({ kind: "file", display: parsed.path, path: resolvePath(parsed.path), addon: addonLabel(parsed.path) });
      } else if (kind === "pak") {
        if (!existsSync(spec.value)) throw new Error(`no such archive or directory: ${spec.value}`);
        for (const pakPath of pakFilesUnder(spec.value)) {
          const pak = this.pak(pakPath);
          for (const entry of pak.entries) {
            if (!/\.c$/i.test(entry.path)) continue;
            add({ kind: "pak", display: `${pakPath}:${normalisePath(entry.path)}`, pak: pakPath, entry: normalisePath(entry.path), pakEntry: entry, addon: addonLabel(pakPath) });
          }
        }
      } else if (kind === "addons") {
        if (!existsSync(spec.value)) throw new Error(`no such addons root: ${spec.value}`);
        if (!statSync(spec.value).isDirectory()) throw new Error(`--addons needs a directory, not ${spec.value}`);
        const before = out.length;
        for (const name of readdirSync(spec.value).sort()) {
          const dir = join(spec.value, name);
          let st;
          try {
            st = statSync(dir);
          } catch {
            continue;
          }
          if (st.isDirectory()) addAddonDirectory(dir);
        }
        if (out.length === before) {
          throw new Error(`no scripts under ${spec.value}: --addons reads the addon directories one level down`);
        }
      } else {
        if (!existsSync(spec.value)) throw new Error(`no such addon directory: ${spec.value}`);
        if (!statSync(spec.value).isDirectory()) throw new Error(`--addon needs a directory, not ${spec.value}`);
        addAddonDirectory(spec.value);
      }
    }
    this._sources = out;
    return out;
  }

  pak(path) {
    const key = resolvePath(path);
    let pak = this.paks.get(key);
    if (!pak) {
      pak = openPak(key);
      this.paks.set(key, pak);
    }
    return pak;
  }

  /**
   * The text of one source (cached).
   *
   * The archive entry is found through a per-archive map rather than `findEntry`, which scans every
   * entry of the archive: with 6 568 scripts in two archives that scan made one lookup 4 ms.
   */
  read(source) {
    let text = this.texts.get(source.display);
    if (text === undefined) {
      if (source.kind === "pak") {
        const pak = this.pak(source.pak);
        const entry = source.pakEntry ?? this.entryOf(source.pak, source.entry);
        text = pak.read(entry).toString("utf8");
      } else text = readFileSync(source.path, "utf8");
      if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
      this.texts.set(source.display, text);
    }
    return text;
  }

  /** One archive entry by virtual path, cached per archive. */
  entryOf(pakPath, entryPath) {
    const key = `${pakPath}|${String(entryPath).toLowerCase()}`;
    let entry = this.entries.get(key);
    if (!entry) {
      const pak = this.pak(pakPath);
      entry = findEntry(pak, entryPath);
      this.entries.set(key, entry);
    }
    return entry;
  }

  /** The parsed file for a source (cached). */
  parse(source) {
    let script = this.parsed.get(source.display);
    if (!script) {
      script = parseScript(this.read(source), { name: source.display });
      script.source = source;
      this.parsed.set(source.display, script);
    }
    return script;
  }

  /** Sources whose text contains `needle` (case-insensitively unless `caseSensitive`). */
  sourcesMentioning(needle, { caseSensitive = false } = {}) {
    const hit = [];
    for (const source of this.sources()) {
      const text = this.read(source);
      if (text.includes(needle)) {
        hit.push(source);
        continue;
      }
      if (caseSensitive) continue;
      let lower = this.lowered.get(source.display);
      if (lower === undefined) {
        lower = text.toLowerCase();
        this.lowered.set(source.display, lower);
      }
      if (lower.includes(needle.toLowerCase())) hit.push(source);
    }
    return hit;
  }

  /** Sources whose text matches a regular expression (a prefilter; callers confirm by parsing). */
  sourcesMatching(regex) {
    return this.sources().filter((source) => regex.test(this.read(source)));
  }

  /**
   * `name -> Set(display)` for every class, enum and typedef the raw text mentions in a declaration.
   *
   * This is a *textual* index: it can list a name that only appears in a comment or a string, so
   * every caller confirms the hit by parsing the file. That costs one regex pass over the corpus
   * (~0.4 s for 6 568 files) instead of a parse of all of it, and makes `modded class X` lookups
   * cheap enough to run for every declaration in `check`.
   */
  index() {
    if (this._index) return this._index;
    const index = new Map();
    const patterns = [/\b(?:modded\s+)?class\s+([A-Za-z_]\w*)/g, /\b(?:modded\s+)?enum\s+([A-Za-z_]\w*)/g, /\btypedef\b[^;\n]*?([A-Za-z_]\w*)\s*;/g];
    for (const source of this.sources()) {
      const text = this.read(source);
      for (const pattern of patterns) {
        pattern.lastIndex = 0;
        let m;
        while ((m = pattern.exec(text))) {
          const name = m[1];
          const key = name.toLowerCase();
          let set = index.get(key);
          if (!set) index.set(key, (set = new Set()));
          set.add(source.display);
        }
      }
    }
    this._index = index;
    return index;
  }

  /** The sources that might declare this name (indexed), in source order. */
  candidateSources(name) {
    const set = this.index().get(String(name).toLowerCase());
    if (!set) return [];
    return this.sources().filter((s) => set.has(s.display));
  }

  close() {
    if (this.closed) return;
    for (const pak of this.paks.values()) pak.close();
    this.paks.clear();
    this.closed = true;
  }
}

/** Decide what a bare path is: a `.pak`, a directory, or a script. */
function guessKind(value) {
  if (/\.pak$/i.test(value)) return "pak";
  try {
    if (statSync(value).isDirectory()) return "pak";
  } catch {
    return "file";
  }
  return "file";
}

/** The base type without its generic arguments: `array<int>` -> `array`. */
export function bareTypeName(text) {
  return String(text ?? "").replace(/<.*$/, "").trim();
}

/**
 * The universe a command should search when none was given: the source's own addon, or the archive
 * the source lives in, or the directory the file is in. That is what a modder means by "the rest of
 * my mod", and it keeps `inheritance-chain` useful without a single option.
 */
export function universeForSource(source, { noPakPathSplit = false } = {}) {
  if (source.kind === "pak") return new ScriptUniverse({ sources: [{ kind: "pak", value: source.pak }], noPakPathSplit });
  const addon = enclosingAddon(source.path);
  if (addon) return new ScriptUniverse({ sources: [{ kind: "addon", value: addon }], noPakPathSplit });
  return new ScriptUniverse({ sources: [{ kind: "addon", value: dirname(source.path) }], noPakPathSplit });
}

// ---------------------------------------------------------------------------
// Searching declarations
// ---------------------------------------------------------------------------

/** Kinds a needle can resolve to, in the order results are reported. */
const KIND_ORDER = ["class", "enum", "typedef", "function", "variable", "method", "field", "enumValue"];

/** Map a `--kind` option onto the declaration kinds it selects. */
export function kindsFor(option) {
  switch (option) {
    case undefined:
    case null:
    case "all":
      return null;
    case "class":
      return new Set(["class"]);
    case "enum":
      return new Set(["enum"]);
    case "typedef":
      return new Set(["typedef"]);
    case "method":
      return new Set(["method"]);
    case "field":
      return new Set(["field"]);
    case "function":
      return new Set(["function"]);
    case "variable":
      return new Set(["variable"]);
    case "enum-value":
      return new Set(["enumValue"]);
    case "type":
      return new Set(["class", "enum", "typedef"]);
    case "member":
      return new Set(["method", "field", "enumValue"]);
    default:
      throw new Error(`unknown --kind "${option}"`);
  }
}

/** A compact descriptor of a source, as JSON and human output report it. */
export function sourceRow(source) {
  return {
    kind: source.kind,
    display: source.display,
    pak: source.pak ?? null,
    entry: source.entry ?? null,
    path: source.path ?? null,
    addon: source.addon ?? null,
  };
}

/** The owner chain of a declaration, outermost first. */
export function ownerChain(decl) {
  const out = [];
  let at = decl.owner;
  while (at) {
    out.unshift(at);
    at = at.owner;
  }
  return out;
}

/** `Class.Method`, `Enum.MEMBER`, or the bare name. */
export function qualifiedName(decl) {
  const chain = ownerChain(decl);
  return [...chain.map((d) => d.name), decl.name].join(".");
}

/**
 * One result row for a declaration: everything `find-defs` promises, including the class range a
 * method sits in.
 */
export function definitionRow(decl, source) {
  const owners = ownerChain(decl);
  // An enum constant is a declaration too, but it carries a line rather than a range and its
  // "signature" is its name and value as written.
  const range = decl.range ?? { start: decl.line ?? 0, end: decl.endLine ?? decl.line ?? 0 };
  const signatureRange = decl.signatureRange ?? range;
  const signature =
    decl.signature ??
    (decl.kind === "enumValue" ? `${decl.name}${decl.expr ? ` = ${decl.expr}` : ""}` : decl.name ?? "");
  // A member of a `modded class` is part of the modification even though the member itself carries
  // no `modded` keyword -- "overridden inside a modded class" is exactly what a reader looks for.
  const modded = !!decl.modded || owners.some((o) => o.modded);
  const row = {
    kind: decl.kind,
    name: decl.name,
    qualifiedName: qualifiedName(decl),
    modded,
    ownModded: !!decl.modded,
    signature,
    source: sourceRow(source),
    file: source.kind === "file" ? source.path : null,
    pak: source.kind === "pak" ? source.pak : null,
    entry: source.kind === "pak" ? source.entry : null,
    line: range.start,
    start: range.start,
    end: range.end,
    // `start` begins at the first decorator, `signatureStart` at the keyword, and `fullStart` at the
    // docstring when there is one -- "the definition, docstring included" is the union of those.
    fullStart: Math.min(range.start, decl.doc?.start ?? range.start),
    fullEnd: range.end,
    signatureStart: signatureRange.start,
    signatureEnd: signatureRange.end,
    doc: decl.doc ?? null,
    banner: decl.banner ?? null,
    group: decl.group ?? null,
    attrs: (decl.attrs ?? []).map((a) => ({ name: a.name, args: a.args, line: a.line })),
    conditions: decl.conditions ?? [],
  };
  if (decl.kind === "class" || decl.kind === "enum") {
    row.base = decl.base ?? null;
    if (decl.typeParams?.length) row.typeParams = decl.typeParams;
    row.forward = !!decl.forward;
  }
  if (decl.kind === "method" || decl.kind === "function") {
    row.returnType = decl.returnType ?? null;
    row.params = decl.params ?? [];
    row.hasBody = !!decl.hasBody;
    row.constructor = !!decl.isConstructor;
    row.destructor = !!decl.isDestructor;
    row.static = !!decl.static;
    row.override = !!decl.override;
    row.proto = !!decl.proto;
    row.native = !!decl.native;
    row.external = !!decl.external;
    row.volatile = !!decl.volatile;
    row.event = !!decl.event;
    row.sealed = !!decl.sealed;
    row.visibility = decl.visibility;
  }
  if (decl.kind === "field" || decl.kind === "variable") {
    row.type = decl.type ?? null;
    row.static = !!decl.static;
    row.const = !!decl.const;
    row.ref = !!decl.ref;
    row.init = decl.init ?? null;
    row.visibility = decl.visibility;
  }
  if (decl.kind === "enumValue") {
    row.value = decl.value;
    row.expr = decl.expr;
    row.valueKnown = !!decl.valueKnown;
    row.line = decl.line;
    row.start = decl.line;
    row.end = decl.endLine ?? decl.line;
  }
  if (decl.kind === "typedef") row.alias = decl.alias ?? null;
  // The class (or enum) a member is declared in, with its own range -- what a method hit must show.
  row.owner = owners.length
    ? {
        kind: owners[owners.length - 1].kind,
        name: owners[owners.length - 1].name,
        signature: owners[owners.length - 1].signature,
        modded: !!owners[owners.length - 1].modded,
        start: owners[owners.length - 1].range.start,
        end: owners[owners.length - 1].range.end,
        doc: owners[owners.length - 1].doc ?? null,
      }
    : null;
  return row;
}

/** Sort rows: originals before modded copies, types before members, then by source path. */
export function sortRows(rows) {
  const kindRank = (kind) => {
    const at = KIND_ORDER.indexOf(kind);
    return at < 0 ? KIND_ORDER.length : at;
  };
  return rows.sort(
    (a, b) =>
      kindRank(a.kind) - kindRank(b.kind) ||
      Number(a.modded) - Number(b.modded) ||
      String(a.source.display).localeCompare(String(b.source.display)) ||
      a.start - b.start,
  );
}

/**
 * Search a universe for a needle: `Class`, `Enum`, `Class.Method`, `Enum.MEMBER` or a bare member
 * name.
 *
 * A bare name is looked for among **types** first (class, enum, typedef, global function, global
 * variable) and, when nothing matches, among members ... so `find-defs BaseWeaponComponent` finds the
 * class and `find-defs GetUIInfo` still finds the methods. A qualified name always means a member of
 * that owner. `--kind` overrides both rules.
 */
export function findDefinitions(needle, { universe, kind = null, regex = false, originalOnly = false, moddedOnly = false } = {}) {
  if (originalOnly && moddedOnly) throw new Error("--original and --only-modded cannot be combined");
  const kinds = kindsFor(kind);
  const rows = [];
  const stats = { filesParsed: 0, needle };
  const seen = new Set();
  const add = (decl, source) => {
    const row = definitionRow(decl, source);
    const key = `${row.kind}|${row.qualifiedName}|${row.source.display}|${row.start}|${row.end}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (originalOnly && row.modded) return;
    if (moddedOnly && !row.modded) return;
    if (kinds && !kinds.has(row.kind)) return;
    rows.push(row);
  };

  const pattern = regex ? new RegExp(needle, "i") : null;
  const matches = (name) => (pattern ? pattern.test(name) : name.toLowerCase() === needle.toLowerCase());

  if (regex) {
    // A regex cannot be answered from the declaration index (it may match a member, not a type), so
    // it is a prefilter over the raw text, and the *names* are then matched for real. The prefilter
    // drops `^` and `$` because a name's anchor is a name boundary in the text, not a line boundary:
    // `^SCR_` must find `class SCR_Thing`, which starts a line only after the word `class`.
    const loose = new RegExp(String(needle).replace(/^\^/, "").replace(/\$$/, ""), "i");
    for (const source of universe.sourcesMatching(loose)) {
      const script = universe.parse(source);
      stats.filesParsed++;
      walk(script, (decl) => {
        if (decl.name && matches(decl.name)) add(decl, source);
      });
    }
    return { rows: sortRows(rows), stats };
  }

  const parts = String(needle).split(".");
  if (parts.length > 2) throw new Error(`${needle} has more than one "." -- write Class.Member`);
  if (parts.length === 2) {
    const [ownerName, memberName] = parts;
    for (const source of universe.candidateSources(ownerName)) {
      const script = universe.parse(source);
      stats.filesParsed++;
      walk(script, (decl) => {
        if (!decl.name) return;
        if (!matchesMember(decl.name, memberName)) return;
        const owners = ownerChain(decl);
        if (!owners.length) return;
        if (!matchesMember(owners[owners.length - 1].name, ownerName)) return;
        add(decl, source);
      });
    }
    return { rows: sortRows(rows), stats };
  }

  const name = parts[0];
  for (const source of universe.candidateSources(name)) {
    const script = universe.parse(source);
    stats.filesParsed++;
    walk(script, (decl) => {
      if (matches(decl.name) && !decl.owner) add(decl, source);
    });
  }
  // A greedy `--kind member` (or a bare method name) never matches a type: search members instead.
  const wantsMember = kinds && ![...kinds].some((k) => ["class", "enum", "typedef", "function", "variable"].includes(k));
  if (!rows.length || wantsMember) {
    for (const source of universe.sourcesMentioning(name)) {
      const script = universe.parse(source);
      stats.filesParsed++;
      walk(script, (decl) => {
        if (decl.owner && matches(decl.name)) add(decl, source);
      });
    }
  }
  return { rows: sortRows(rows), stats };
}

/** Compare one name with a needle: exact first, then case-insensitively. */
function matchesMember(name, needle) {
  return name === needle || String(name).toLowerCase() === String(needle).toLowerCase();
}

/** A string as a literal regular expression, so a class name can be searched for as text. */
function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The index of the first range that contains `at`, or -1. Ranges are sorted and disjoint. */
function rangeAt(ranges, at) {
  let lo = 0;
  let hi = ranges.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (at < ranges[mid].start) hi = mid - 1;
    else if (at > ranges[mid].end) lo = mid + 1;
    else return mid;
  }
  return -1;
}

/**
 * Every place a source contains `needle`, as **text**: file, line, column, the line, and whether the
 * hit is code, a comment or a string literal.
 *
 * This is not a call graph and does not pretend to be one. It answers the question a grep answers —
 * "where does this name appear" — but inside an archive and without extracting it, and it separates
 * the three kinds of hit, because a name in a comment and a name being called are both matches and
 * only one of them is a use. The default pattern is the needle as a whole word; `regex` uses it raw.
 */
export function findText(needle, { universe, regex = false, caseSensitive = false } = {}) {
  const pattern = new RegExp(regex ? String(needle) : `\\b${escapeRegExp(needle)}\\b`, caseSensitive ? "g" : "gi");
  const matches = [];
  for (const source of universe.sources()) {
    const text = universe.read(source);
    const lexed = tokenize(text);
    const comments = lexed.comments.map((c) => ({ start: c.start, end: c.end })).sort((a, b) => a.start - b.start);
    const strings = lexed.tokens.filter((t) => t.type === "string").map((t) => ({ start: t.start, end: t.end })).sort((a, b) => a.start - b.start);
    const lineOf = lineIndex(text);
    pattern.lastIndex = 0;
    let m;
    while ((m = pattern.exec(text))) {
      if (m[0] === "") {
        pattern.lastIndex++;
        continue;
      }
      const at = m.index;
      const lineStart = text.lastIndexOf("\n", at - 1) + 1;
      const lineEnd = text.indexOf("\n", at);
      const where = rangeAt(comments, at) >= 0 ? "comment" : rangeAt(strings, at) >= 0 ? "string" : "code";
      matches.push({
        source,
        line: lineOf(at),
        column: at - lineStart + 1,
        text: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim(),
        where,
        match: m[0],
      });
    }
  }
  return matches;
}

/** Every declaration of one name in a universe, originals and `modded` copies. */
export function declarationsNamed(name, universe) {
  const found = [];
  for (const source of universe.candidateSources(name)) {
    const script = universe.parse(source);
    walk(script, (decl) => {
      if (decl.name.toLowerCase() === String(name).toLowerCase()) found.push({ decl, source });
    });
  }
  return found;
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

/** One field or method as the schema reports it. */
export function memberRow(decl) {
  const row = definitionRow(decl, { kind: null, display: null });
  // A member's own source is the file it came from; `definitionRow` is given a null source here and
  // the caller fills `source` in, so nothing about a member is invented when it is inherited.
  delete row.source;
  delete row.file;
  delete row.pak;
  delete row.entry;
  return row;
}

/**
 * The schema of a declaration: a class with its fields and methods, an enum with its constants, or one
 * method with its owner's range.
 *
 * `inherited` appends the members of the base classes (resolved through the universe), each marked
 * with the class it came from ... the question "what can I call on this?" that a modder actually asks.
 */
export function schemaOf(decl, source, { inherited = false, universe = null, maxDepth = 16 } = {}) {
  const row = definitionRow(decl, source);
  if (decl.kind === "class") {
    row.kind = "class";
    row.fields = decl.members.filter((m) => m.kind === "field").map((m) => ({ ...memberRow(m), source: sourceRow(source) }));
    row.methods = decl.members.filter((m) => m.kind === "method").map((m) => ({ ...memberRow(m), source: sourceRow(source) }));
    row.nested = (decl.nested ?? []).map((d) => ({ kind: d.kind, name: d.name, signature: d.signature, start: d.range.start, end: d.range.end }));
    if (inherited && universe && decl.base) {
      row.inherited = inheritedMembers(decl, { universe, maxDepth });
    }
    return row;
  }
  if (decl.kind === "enum") {
    row.kind = "enum";
    row.values = decl.values.map((v) => ({
      name: v.name,
      value: v.value,
      expr: v.expr,
      computed: !!v.computed,
      valueKnown: !!v.valueKnown,
      line: v.line,
      endLine: v.endLine,
      doc: v.doc ?? null,
      attrs: (v.attrs ?? []).map((a) => ({ name: a.name, args: a.args, line: a.line })),
    }));
    row.valuesKnown = !!decl.valuesKnown;
    return row;
  }
  return row;
}

/** Members inherited from the base classes, nearest base first, overridden names removed. */
function inheritedMembers(decl, { universe, maxDepth = 16 }) {
  const own = new Set(decl.members.map((m) => m.name.toLowerCase()));
  const out = [];
  const seen = new Set([decl.name.toLowerCase()]);
  let base = bareTypeName(decl.base);
  let depth = 0;
  while (base && depth < maxDepth) {
    const key = base.toLowerCase();
    if (seen.has(key)) break;
    seen.add(key);
    const found = declarationsNamed(base, universe).filter((f) => f.decl.kind === "class");
    if (!found.length) {
      out.push({ name: base, missing: true, members: [] });
      break;
    }
    const original = found.find((f) => !f.decl.modded) ?? found[0];
    const members = original.decl.members
      .filter((m) => !own.has(m.name.toLowerCase()))
      .map((m) => ({ ...memberRow(m), source: sourceRow(original.source), inheritedFrom: original.decl.name }));
    for (const m of members) own.add(m.name.toLowerCase());
    out.push({ name: original.decl.name, modded: !!original.decl.modded, start: original.decl.range.start, end: original.decl.range.end, members });
    base = bareTypeName(original.decl.base);
    depth++;
  }
  return out;
}

/**
 * Number an enum declaration, resolving a base enum (`enum X : Y`) and, for a `modded enum`, the
 * enum it extends ... both through the universe, both optional and both reported when absent.
 */
export function numberEnumWithSources(decl, { universe = null } = {}) {
  let inheritedLast = null;
  let baseValues = null;
  if (decl.base && universe) {
    const found = declarationsNamed(decl.base, universe).filter((f) => f.decl.kind === "enum");
    const original = found.find((f) => !f.decl.modded) ?? found[0];
    if (original) {
      numberEnum(original.decl);
      baseValues = original.decl.values.map((v) => ({ name: v.name, value: v.value }));
      const last = [...original.decl.values].reverse().find((v) => v.value !== null);
      if (last) inheritedLast = last.value;
      decl.baseResolved = {
        name: original.decl.name,
        source: sourceRow(original.source),
        start: original.decl.range.start,
        end: original.decl.range.end,
        values: baseValues,
      };
    } else decl.baseResolved = null;
  } else if (decl.base) decl.baseResolved = null;
  if (decl.modded) {
    // A modded enum adds constants to an enum declared elsewhere: its numbering continues from the
    // original, which is knowable only when the original was found.
    let last = inheritedLast;
    if (last === null && universe) {
      const found = declarationsNamed(decl.name, universe).filter((f) => f.decl.kind === "enum" && f.decl !== decl && !f.decl.modded);
      if (found.length) {
        numberEnum(found[0].decl);
        const lastValue = [...found[0].decl.values].reverse().find((v) => v.value !== null);
        if (lastValue) last = lastValue.value;
        decl.originalResolved = { source: sourceRow(found[0].source), start: found[0].decl.range.start, end: found[0].decl.range.end };
      }
    }
    numberEnum(decl, { inheritedLast: last });
    return decl;
  }
  numberEnum(decl, { inheritedLast: null });
  return decl;
}

// ---------------------------------------------------------------------------
// Inheritance chain and subclass tree
// ---------------------------------------------------------------------------

/**
 * The inheritance chain of a class, following `:`/`extends` parents through the universe.
 *
 * Each **step** is one declaration: the source's own (possibly `modded`), then, for a name that a mod
 * replaced, the original it replaces and every other `modded` copy ... because a modded class *is* the
 * class, and a chain that hides it would be a lie. A base that cannot be found, a loop, and two modded
 * copies declaring different bases are reported as problems rather than guessed at.
 */
export function inheritanceChain(startDecl, startSource, { universe, max = 64 } = {}) {
  const rows = [];
  const problems = [];
  const seen = new Set();
  let current = { decl: startDecl, source: startSource };
  let depth = 0;
  let truncated = false;
  while (current) {
    const key = current.decl.name.toLowerCase();
    if (seen.has(key)) {
      problems.push({ severity: "error", code: "cyclic-inheritance", message: `inheritance loops back to ${current.decl.name}`, name: current.decl.name, line: current.decl.range.start });
      break;
    }
    seen.add(key);
    rows.push({ ...definitionRow(current.decl, current.source), depth, role: depth === 0 ? "root" : "ancestor" });
    if (rows.length >= max) {
      truncated = !!current.decl.base;
      if (truncated) problems.push({ severity: "info", code: "depth-limit", message: `stopped after ${max} step(s): raise --depth for more`, name: current.decl.name, line: current.decl.range.start });
      break;
    }
    // The cross-file picture of this name: the original, and every modded copy of it.
    const copies = declarationsNamed(current.decl.name, universe).filter((f) => f.decl.kind === "class");
    const original = copies.find((f) => !f.decl.modded && f.source.display !== current.source.display) ?? copies.find((f) => !f.decl.modded) ?? null;
    const moddedCopies = copies.filter((f) => f.decl.modded && f.source.display !== current.source.display);
    if (current.decl.modded && !original) {
      problems.push({
        severity: "warning",
        code: "modded-original-missing",
        message: `modded class ${current.decl.name} replaces a class that is not in the searched sources`,
        name: current.decl.name,
        line: current.decl.range.start,
      });
    }
    // A modded class must declare the same base as the original; the corpus shows it does, and a
    // mismatch means the mod is documenting a chain it does not have.
    const effectiveBase = bareTypeName(original?.decl.base ?? current.decl.base);
    if (current.decl.modded && original && original.decl.base && current.decl.base) {
      if (bareTypeName(current.decl.base) !== bareTypeName(original.decl.base)) {
        problems.push({
          severity: "warning",
          code: "modded-base-mismatch",
          message: `modded class ${current.decl.name} declares base ${bareTypeName(current.decl.base)} but the original declares ${bareTypeName(original.decl.base)}`,
          name: current.decl.name,
          line: current.decl.range.start,
        });
      }
    }
    for (const copy of moddedCopies) {
      rows.push({ ...definitionRow(copy.decl, copy.source), depth, role: "modded" });
      if (original && copy.decl.base && original.decl.base && bareTypeName(copy.decl.base) !== bareTypeName(original.decl.base)) {
        problems.push({
          severity: "warning",
          code: "modded-base-mismatch",
          message: `modded class ${copy.decl.name} declares base ${bareTypeName(copy.decl.base)} but the original declares ${bareTypeName(original.decl.base)}`,
          name: copy.decl.name,
          line: copy.decl.range.start,
        });
      }
    }
    // Starting *from* a modded copy: the original it replaces belongs in the chain as its own step,
    // otherwise the chain would jump from the mod's declaration straight to the base and hide the
    // class the mod is replacing.
    if (current.decl.modded && original) {
      rows.push({ ...definitionRow(original.decl, original.source), depth, role: "original" });
    }
    if (!effectiveBase) break;
    const parents = declarationsNamed(effectiveBase, universe).filter((f) => f.decl.kind === "class");
    if (!parents.length) {
      problems.push({
        severity: "warning",
        code: "base-not-found",
        message: `base class ${effectiveBase} is not in the searched sources (pass --pak or --addon for it)`,
        name: current.decl.name,
        line: current.decl.range.start,
      });
      break;
    }
    const parent = parents.find((f) => !f.decl.modded) ?? parents[0];
    for (const copy of parents.filter((f) => f.decl.modded)) {
      rows.push({ ...definitionRow(copy.decl, copy.source), depth: depth + 1, role: "modded" });
    }
    current = parent;
    depth++;
  }
  return { rows, problems, truncated };
}

/**
 * The subclass tree of a class: every class whose base is it, transitively, plus the `modded` copies
 * of each node (a modded class *is* that class, so it belongs in the tree even though it does not
 * declare a base of its own).
 */
export function subclassTree(rootName, { universe, maxDepth = 0, includeModded = true, limit = Infinity } = {}) {
  const problems = [];
  const rootDecls = declarationsNamed(rootName, universe).filter((f) => f.decl.kind === "class");
  const root = {
    name: rootDecls[0]?.decl.name ?? rootName,
    base: null,
    modded: false,
    depth: 0,
    declarations: rootDecls.map((f) => definitionRow(f.decl, f.source)),
    children: [],
  };
  if (!rootDecls.length) {
    problems.push({ severity: "warning", code: "class-not-found", message: `class ${rootName} is not in the searched sources`, name: rootName });
  }
  const visited = new Set([root.name.toLowerCase()]);
  let total = 0;
  let truncated = false;

  const fill = (node) => {
    if (maxDepth > 0 && node.depth >= maxDepth) return;
    if (total >= limit) {
      truncated = true;
      return;
    }
    for (const child of subclassesOf(node.name, universe)) {
      const key = child.name.toLowerCase();
      if (visited.has(key)) continue;
      visited.add(key);
      total++;
      const entry = {
        name: child.name,
        base: node.name,
        modded: !!child.modded,
        depth: node.depth + 1,
        declarations: [{ ...definitionRow(child.decl, child.source), role: "subclass" }],
        children: [],
      };
      if (includeModded) {
        for (const copy of moddedCopiesOf(child.name, universe)) {
          if (copy.source.display === child.source.display) continue;
          entry.declarations.push({ ...definitionRow(copy.decl, copy.source), role: "modded" });
        }
      }
      node.children.push(entry);
      fill(entry);
      if (total >= limit) {
        truncated = true;
        return;
      }
    }
  };
  fill(root);
  return { root, problems, total, truncated };
}

/** Every class whose base clause names `name`: the direct subclasses. */
export function subclassesOf(name, universe) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\bclass\\s+([A-Za-z_]\\w*)\\s*(?::|extends)\\s*${escaped}\\b`);
  const out = [];
  const seen = new Set();
  for (const source of universe.sourcesMatching(pattern)) {
    const script = universe.parse(source);
    walk(script, (decl) => {
      if (decl.kind !== "class" || !decl.base) return;
      if (bareTypeName(decl.base) !== name && bareTypeName(decl.base).toLowerCase() !== name.toLowerCase()) return;
      const key = `${decl.name.toLowerCase()}|${source.display}`;
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ name: decl.name, decl, source, modded: !!decl.modded });
    });
  }
  return out;
}

/** Every `modded class` with this name: the copies that replace it. */
export function moddedCopiesOf(name, universe) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`\\bmodded\\s+class\\s+${escaped}\\b`);
  const out = [];
  for (const source of universe.sourcesMatching(pattern)) {
    const script = universe.parse(source);
    walk(script, (decl) => {
      if (decl.kind !== "class" || !decl.modded) return;
      if (decl.name.toLowerCase() !== name.toLowerCase()) return;
      out.push({ name: decl.name, decl, source });
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Statistics
// ---------------------------------------------------------------------------

/**
 * The flag a declaration's condition names: `#ifdef AI_DEBUG` -> `AI_DEBUG`, and `!…` (the `#else`
 * branch of a condition) names the same flag. A condition that is not a bare `#ifdef`/`#ifndef`
 * is reported as written, because a number nobody can trace is worse than a label.
 */
function conditionFlag(condition) {
  const text = String(condition).replace(/^!/, "").trim();
  const match = /^#\s*(?:ifdef|ifndef)\s+([A-Za-z_]\w*)/.exec(text);
  return match ? match[1] : text.replace(/^#\s*/, "");
}

/**
 * Counts over a set of parsed scripts: what is in them by kind, how much of it is `modded`, and how
 * much sits under an `#ifdef`.
 *
 * This is the number `stats` prints, and it exists because prose numbers age: every count in the
 * skills should be reproducible by running one command rather than by re-deriving a script. Nothing
 * here is a verdict — `check` decides what is defective.
 */
export function scriptStats(scripts) {
  const stats = {
    files: 0,
    bytes: 0,
    declarations: 0,
    byKind: {},
    modded: { total: 0, classes: 0, enums: 0 },
    classes: { total: 0, noMembers: 0, sealed: 0 },
    methods: { total: 0, protoNative: 0, override: 0, static: 0, global: 0 },
    enums: { total: 0, values: 0 },
    conditional: { declarations: 0, flags: [] },
  };
  const flags = new Map();
  for (const script of scripts) {
    stats.files++;
    stats.bytes += Buffer.byteLength(script.text, "utf8");
    for (const decl of declarationsOf(script)) {
      stats.declarations++;
      stats.byKind[decl.kind] = (stats.byKind[decl.kind] ?? 0) + 1;
      if (decl.modded) {
        stats.modded.total++;
        if (decl.kind === "class") stats.modded.classes++;
        else if (decl.kind === "enum") stats.modded.enums++;
      }
      if (decl.kind === "class") {
        stats.classes.total++;
        if (!(decl.members ?? []).length) stats.classes.noMembers++;
        if (decl.sealed) stats.classes.sealed++;
      } else if (decl.kind === "method") {
        stats.methods.total++;
        if (decl.proto || decl.native) stats.methods.protoNative++;
        if (decl.override) stats.methods.override++;
        if (decl.static) stats.methods.static++;
      } else if (decl.kind === "function") {
        stats.methods.global++;
      } else if (decl.kind === "enum") {
        stats.enums.total++;
        stats.enums.values += (decl.values ?? []).length;
      }
      if (decl.conditions?.length) {
        stats.conditional.declarations++;
        for (const condition of decl.conditions) {
          const flag = conditionFlag(condition);
          flags.set(flag, (flags.get(flag) ?? 0) + 1);
        }
      }
    }
  }
  stats.conditional.flags = [...flags]
    .map(([flag, declarations]) => ({ flag, declarations }))
    .sort((a, b) => b.declarations - a.declarations || a.flag.localeCompare(b.flag));
  return stats;
}

// ---------------------------------------------------------------------------
// Checks
// ---------------------------------------------------------------------------

/**
 * The defects this reader can prove about one file, and ... with a universe ... about what it replaces.
 *
 * What it does **not** report, deliberately: a method override whose base method is missing or has a
 * different signature. The corpus shows declarations that exist only under an `#ifdef` flag the game
 * may or may not have defined, and a method's signature can be split across those branches, so a
 * "no such base method" verdict would be a guess. Everything here is decidable from the text.
 */
export function checkScript(script, { universe = null, source = script.source } = {}) {
  const problems = [...script.problems];
  const add = (severity, code, message, line, name) => problems.push({ severity, code, message, line, name });

  // A name may repeat freely across *kinds*: `typedef int DateTimeUtcAsInt;` next to
  // `class DateTimeUtcAsInt` ships in `scripts/GameLib/workbench/workbench.c`, and a `modded class X`
  // next to `class X` is the whole point of `modded`. Only the same kind twice is a duplicate, and
  // only under the same `#ifdef` condition -- `#ifdef A ... #else ... #endif` repeats a name on purpose.
  const byName = new Map();
  const addTop = (decl) => {
    if (decl.modded) return;
    const key = `${decl.kind}:${decl.name}`;
    let list = byName.get(key);
    if (!list) byName.set(key, (list = []));
    list.push(decl);
  };
  for (const decl of script.declarations) {
    if (["class", "enum", "typedef"].includes(decl.kind)) addTop(decl);
  }
  for (const list of byName.values()) {
    if (list.length < 2) continue;
    // Report the *later* declaration of each pair, once: two copies are one mistake, not two.
    for (let n = 1; n < list.length; n++) {
      const decl = list[n];
      const twin = list.slice(0, n).find((other) => sameConditions(other.conditions, decl.conditions));
      if (!twin) continue;
      const conditional = (decl.conditions ?? []).length > 0;
      add(
        conditional ? "warning" : "error",
        "duplicate-declaration",
        `${decl.kind} ${decl.name} is declared again at line ${twin.range.start}` +
          (conditional ? `, both under ${decl.conditions.join(" && ")}` : ""),
        decl.range.start,
        decl.name,
      );
    }
  }

  for (const decl of script.declarations) {
    if (decl.kind === "class") {
      if (decl.base && bareTypeName(decl.base).toLowerCase() === decl.name.toLowerCase()) {
        add("error", "self-inheritance", `class ${decl.name} inherits from itself`, decl.range.start, decl.name);
      }
      // Two methods with one signature clash -- unless they sit in two branches of an `#ifdef`, which
      // is how vanilla keeps a body for one build and a prototype for another (SCR_FuelNode declares
      // 9 methods in each branch of its `#ifdef`). Inside a condition the clash is real but only for
      // the build that takes that branch, so it is reported as a warning, not an error.
      const signatures = new Map();
      for (const member of decl.members) {
        if (member.kind !== "method") continue;
        const key = methodKey(member);
        const list = signatures.get(key) ?? [];
        const twin = list.find((other) => sameConditions(other.conditions, member.conditions));
        if (twin) {
          const conditional = (member.conditions ?? []).length > 0;
          add(
            conditional ? "warning" : "error",
            "duplicate-method",
            `${decl.name}.${member.name} is declared twice with the same parameter list (line ${twin.range.start})` +
              (conditional ? `, both under ${member.conditions.join(" && ")}` : ""),
            member.range.start,
            member.name,
          );
        }
        list.push(member);
        signatures.set(key, list);
      }
    }
    if (decl.kind === "enum") {
      const seen = new Map();
      for (const value of decl.values) {
        const twin = seen.get(value.name);
        if (twin) add("error", "duplicate-enum-member", `${decl.name}.${value.name} is declared twice (line ${twin})`, value.line, value.name);
        else seen.set(value.name, value.line);
      }
      if (!decl.values.length) add("note", "empty-enum", `enum ${decl.name} has no constants`, decl.range.start, decl.name);
    }
  }

  // Cross-file checks: only what a universe can settle.
  if (universe) {
    for (const decl of script.declarations) {
      if ((decl.kind === "class" || decl.kind === "enum") && decl.modded) {
        const copies = declarationsNamed(decl.name, universe).filter((f) => f.decl.kind === decl.kind && !f.decl.modded);
        if (!copies.length) {
          add(
            "warning",
            "modded-original-missing",
            `modded ${decl.kind} ${decl.name} replaces a ${decl.kind} that is not in the searched sources`,
            decl.range.start,
            decl.name,
          );
        } else if (decl.kind === "class" && decl.base) {
          const original = copies[0].decl;
          if (original.base && bareTypeName(original.base) !== bareTypeName(decl.base)) {
            add(
              "warning",
              "modded-base-mismatch",
              `modded class ${decl.name} declares base ${bareTypeName(decl.base)} but ${copies[0].source.display} declares ${bareTypeName(original.base)}`,
              decl.range.start,
              decl.name,
            );
          }
        }
      }
      if (decl.kind === "enum" && decl.base && !decl.modded) {
        const found = declarationsNamed(bareTypeName(decl.base), universe).filter((f) => f.decl.kind === "enum");
        if (!found.length) {
          add("note", "enum-base-unknown", `enum ${decl.name} extends ${decl.base}, which is not an enum in the searched sources`, decl.range.start, decl.name);
        }
      }
    }
  }
  return problems;
}

function sameConditions(a, b) {
  const left = a ?? [];
  const right = b ?? [];
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

/**
 * A method's identity for duplicate detection: the name (with the `~` of a destructor, so that
 * `void X()` and `void ~X()` never look like a pair) and the parameter types.
 */
function methodKey(method) {
  const name = `${method.isDestructor ? "~" : ""}${method.name}`;
  return `${name}(${(method.params ?? []).map((p) => p.type ?? "?").join(",")})`;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Read Arma Reforger Enforce Script sources (.c): declarations, signatures, doc comments,
class schemas, inheritance chains, subclass trees and modded overrides -- from a file, a .pak entry,
a directory of .c files, or an archive of them.

  node tools/cscript.mjs check             <source>... [--pak <pak|dir>]... [--addon <dir>]...
                                           [--addons <root>]... [--file <file>]... [--json]
  node tools/cscript.mjs stats             [<source>...] [--pak ...] [--addon ...] [--addons ...]
                                           [--json]
  node tools/cscript.mjs refs              <needle> [--pak ...] [--addon ...] [--addons ...] [--file ...]
                                           [--regex] [--case-sensitive] [--code-only]
                                           [--limit N|0] [--json]
  node tools/cscript.mjs find-defs         <needle> [--pak ...] [--addon ...] [--file ...]
                                           [--kind class|enum|typedef|method|field|function|variable|type|member]
                                           [--regex] [--original | --only-modded] [--files-only]
                                           [--stats] [--limit N|0] [--json]
  node tools/cscript.mjs schema            <source> <needle> [--members all|fields|methods]
                                           [--inherited] [--limit N|0] [--json]
  node tools/cscript.mjs signature         <source> <needle> [--json]
  node tools/cscript.mjs inheritance-chain <source> [<class>] [--pak ...] [--addon ...] [--file ...]
                                           [--depth N] [--json]
  node tools/cscript.mjs subclass-tree     <source> [<class>] [--pak ...] [--addon ...]
                                           [--file ...] [--depth N] [--no-modded] [--limit N|0] [--json]
  node tools/cscript.mjs outline           <source> [--limit N|0] [--json]
  node tools/cscript.mjs cat               <source> [<lines>] [--plain] [--json]

  <source>   a .c file, a directory of them, or one entry inside a .pak written <pak>:<entry>
  <needle>   Class, Enum, Class.Method, Enum.MEMBER, or (find-defs only) a bare member name
  <lines>    400 (one line), 400-500 (that range, both ends included), or 400- (to the end)

check        the defects this reader can prove in one script: an unterminated string or comment, a
             bracket that never closes, an unbalanced #ifdef, a type or method declared twice with
             the same parameters, an enum constant declared twice, a class inheriting from itself.
             With --pak/--addon it also settles what a mod claims: a "modded class X" whose
             original is not in the searched sources, and a modded class whose base clause differs
             from the original's. Exits 1 on an error.
stats        what is in the sources, counted: files, bytes, declarations by kind, how many classes
             have no members and how many are sealed, how many methods are proto/native and how many
             override, how many declarations are modded, and how many sit under a condition together
             with the flags they name. A count, not a verdict -- check decides what is defective.
             The same numbers a document can quote and a reader can re-run.
refs         every place the needle appears, as text: file:line:column, the line, and whether the hit
             is code, a [comment] or a [string]. This is the search a reader has instead of a
             call graph -- it answers "where is this name", including who mentions it -- and
             --code-only drops the two kinds of mention that are not a use. The needle is matched as
             a whole word, case-insensitively; --regex takes a pattern and --case-sensitive changes
             the case rule. Exits 1 when nothing matches.
find-defs    where a class, enum, enum constant, method or field is declared. Every copy is
             reported: the original and each "modded class" that replaces it, unless --original or
             --only-modded narrows it. A method hit carries its own range **and** the range of the
             class it is declared in; an enum constant carries its enum's range. A bare needle
             matches types first (class, enum, typedef, global function/variable) and falls back to
             members, so "find-defs GetUIInfo" still works. Each row also gives "signatureStart"
             (the keyword line), "start" (the first decorator) and "fullStart" (the docstring, when
             there is one). Exits 1 when nothing matches.
schema       the whole schema of one class (fields and methods with visibility, static, decorators,
             docstring and line ranges), of one enum (its constants with values, auto-numbered where
             that is knowable), or of one method (signature, parameters, docstring, its own range and
             its class's). --inherited adds the members of the base classes. Each list is capped at
             --limit rows; "counts" and the trailing "N more" line say what the cap hid.
signature    only the signature and the docstring, with the line ranges.
inheritance-chain
             the parent chain of a class, following ":"/"extends" through the sources: the class in
             <source>, then each base. "modded class" copies of a step are shown as their own rows,
             because a modded class *is* the class. --depth stops early and says so; an unresolvable
             base, a loop and two modded copies naming different bases are problems, not guesses.
subclass-tree
             the classes that extend a class, transitively, with the modded copies of each node.
             --depth limits the tree (0 = no limit); --no-modded leaves the modded copies out.
outline      the declarations of one file, with their ranges: the table of contents of a script.
cat          the text of a file, or of one line, or of a range of them: "cat <source> 400-500" prints
             lines 400 to 500, both ends included, each with its number. Without <lines> the whole
             file is printed; --plain drops the number column. A range that starts past the end of
             the file is an error, one that ends past it is clamped and says so. Exits 1 on an error.

A source is a file, a directory of .c files, or one entry of a .pak:

  node tools/cscript.mjs outline \\
    "<install>/addons/data/data007.pak:scripts/Game/GameMode/SCR_BaseGameMode.c"

That split happens at the **last** colon, and only when everything before it ends in .pak -- so
C:\\\\dir\\\\X.c stays a file path (its only colon is the drive's). --no-pak-path-split turns it off.

Where the search happens
  --file PATH   one script on disk, or one <pak>:<entry>; repeatable
  --addon DIR   a Workbench project (a tree of .c on disk) or a downloaded addon (addon.gproj +
                data.pak, scripts only inside the archive); repeatable
  --addons ROOT every directory directly under ROOT is one addon: its unpacked tree and its *.pak
                files. What a dedicated server's addons folder looks like; repeatable. A server
                with forty mods is one option, not forty --addon ones.
  --pak PATH    a .pak archive, or a directory searched for *.pak (recursively); repeatable
  The options are searched in the order they are given. Without any of them, find-defs has nothing to
  search and says so; inheritance-chain and subclass-tree fall back to the addon that contains
  <source> (the nearest parent directory with a .gproj), or to <source>'s own directory.

Options
  --limit N     maximum rows (default 100 as text, 25 with --json, because a JSON member row is
                about twenty text lines; 0 = every one). outline defaults to 0: a table of contents
                is short by nature, while a schema of a large class is not. schema --json also
                reports the real totals in "counts", with "truncated" true when anything was cut.
  --all         same as --limit 0
  --depth N     inheritance-chain: the longest chain to follow (default 64).
                subclass-tree: how many levels below the class (default 0 = no limit)
  --members W   schema: all, fields or methods (default all)
  --inherited   schema: append the members of the base classes, each marked with where it came from
  --kind K      find-defs: class, enum, typedef, method, field, function, variable, enum-value, type,
                member or all (default: any)
  --regex       find-defs and refs: the needle is a regular expression, matched case-insensitively
  --case-sensitive
                refs: match case exactly
  --code-only   refs: drop hits inside a comment or a string literal, leaving the uses
  --original    find-defs: only declarations that are not "modded"
  --only-modded find-defs: only "modded" declarations
  --no-modded   subclass-tree: leave the modded copies of a node out
  --files-only  find-defs: print just the source of each hit, one per line
  --stats       find-defs: report how many files were read and parsed
  --plain       cat: print the text without the line-number column
  --no-pak-path-split
                read every source as a file on disk: no <pak>:<entry> split
  --json        machine-readable output; every command answers with an envelope that names the
                source and carries total/returned/truncated, never a bare array
  --compact     with --json (it implies it): each row's "source" becomes an integer id into one
                shared "sourceTable", the keys that only repeated the source are dropped, and
                fields that are false, [] or {} are left out -- an absent field means false or
                empty. schema --inherited of CharacterControllerComponent with --limit 0: 517 KB -> 292 KB
`;

function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

const OPTION_SPELLING = {
  noPakPathSplit: "no-pak-path-split",
  onlyModded: "only-modded",
  filesOnly: "files-only",
  noModded: "no-modded",
  caseSensitive: "case-sensitive",
  codeOnly: "code-only",
};

function parseArgs(argv) {
  const flags = { _: [], given: [], sources: [] };
  const valueOf = (option, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw usageError(`${option} needs a value`);
    return v;
  };
  const BOOLEAN = {
    "--json": "json",
    "--compact": "compact",
    "--case-sensitive": "caseSensitive",
    "--code-only": "codeOnly",
    "--all": "all",
    "--regex": "regex",
    "--original": "original",
    "--only-modded": "onlyModded",
    "--no-modded": "noModded",
    "--files-only": "filesOnly",
    "--stats": "stats",
    "--inherited": "inherited",
    "--plain": "plain",
    "--no-pak-path-split": "noPakPathSplit",
  };
  const COUNTED = { "--limit": "limit", "--depth": "depth" };
  const MULTI = { "--pak": "pak", "--addon": "addon", "--addons": "addons", "--file": "file" };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const at = a.indexOf("=");
    const name = at > 0 && a.startsWith("--") ? a.slice(0, at) : a;
    const inline = at > 0 && a.startsWith("--") ? a.slice(at + 1) : null;
    const value = (option) => {
      if (inline !== null) return inline;
      const v = valueOf(option, i);
      i++;
      return v;
    };
    if (Object.hasOwn(BOOLEAN, name)) {
      if (inline !== null) throw usageError(`${name} does not take a value`);
      flags[BOOLEAN[name]] = true;
      flags.given.push(BOOLEAN[name]);
    } else if (Object.hasOwn(COUNTED, name)) {
      const raw = value(name);
      if (!/^\d+$/.test(raw)) throw usageError(`${name} needs a non-negative whole number, not "${raw}"`);
      flags[COUNTED[name]] = Number(raw);
      flags.given.push(COUNTED[name]);
    } else if (Object.hasOwn(MULTI, name)) {
      const raw = value(name);
      flags[MULTI[name]] ??= [];
      flags[MULTI[name]].push(raw);
      flags.sources.push({ kind: MULTI[name], value: raw });
      flags.given.push(MULTI[name]);
    } else if (name === "--kind") {
      const raw = value(name);
      kindsFor(raw); // throws on an unknown kind
      flags.kind = raw;
      flags.given.push("kind");
    } else if (name === "--members") {
      const raw = value(name);
      if (!["all", "fields", "methods"].includes(raw)) throw usageError(`--members takes all, fields or methods, not "${raw}"`);
      flags.members = raw;
      flags.given.push("members");
    } else if (name === "-h" || name === "--help") flags.help = true;
    else if (a.startsWith("-") && a !== "-") throw usageError(`unknown option "${a}"`);
    else flags._.push(a);
  }
  // `--compact` selects a JSON shape, so asking for it is asking for JSON.
  if (flags.compact) flags.json = true;
  return flags;
}

const COMMAND_OPTIONS = {
  check: ["pak", "addon", "addons", "file"],
  stats: ["pak", "addon", "addons", "file"],
  refs: ["pak", "addon", "addons", "file", "regex", "caseSensitive", "codeOnly", "limit", "all"],
  findDefs: ["pak", "addon", "addons", "file", "kind", "regex", "original", "onlyModded", "filesOnly", "stats", "limit", "all"],
  schema: ["pak", "addon", "addons", "file", "members", "inherited", "limit", "all"],
  signature: ["pak", "addon", "addons", "file"],
  chain: ["pak", "addon", "addons", "file", "depth"],
  tree: ["pak", "addon", "addons", "file", "depth", "noModded", "limit", "all"],
  outline: ["limit", "all"],
  cat: ["plain"],
};
const GLOBAL_OPTIONS = ["json", "compact", "noPakPathSplit"];

const COMMANDS = {
  check: "check",
  stats: "stats",
  refs: "refs",
  "find-defs": "findDefs",
  schema: "schema",
  signature: "signature",
  "inheritance-chain": "chain",
  "subclass-tree": "tree",
  outline: "outline",
  cat: "cat",
};

/** Refuse an option the command does not take, naming the command the way the user typed it. */
function checkOptions(key, name, flags) {
  const allowed = new Set([...COMMAND_OPTIONS[key], ...GLOBAL_OPTIONS]);
  for (const given of flags.given) {
    if (!allowed.has(given)) throw usageError(`${name} does not take --${OPTION_SPELLING[given] ?? given}`);
  }
}

/**
 * Print a JSON envelope, compactly with `--compact`.
 *
 * Two things make an envelope large, and both are repetition rather than data. Every row carries a
 * `source` object, and most rows also repeat pieces of it (`pak`, `entry`, `path`, `file`, `addon`);
 * and most rows carry the whole flag set as booleans, of which usually one is true. So `--compact`
 * (a) replaces each row's `source` with an integer id and collects the objects once in
 * `sourceTable`, (b) drops the sibling keys that only repeated the source, and (c) omits the fields
 * that carry no information: `false`, an empty array, an empty object. An absent field therefore
 * means false or empty -- the same answer a truthiness test gives -- and nothing else changes, so a
 * consumer reads `sourceTable[row.source]`. Strings and `null` are kept: an empty line in `cat` and
 * an unresolved enum value are both facts.
 */
function printJson(envelope, flags) {
  console.log(JSON.stringify(flags.compact ? compactEnvelope(envelope) : envelope, null, 2));
}

/** Row keys that mirror a field of the row's `source`, and the field each one mirrors. */
const SOURCE_MIRRORS = { pak: "pak", entry: "entry", path: "path", file: "path", addon: "addon" };

function compactEnvelope(envelope) {
  const table = [];
  const ids = new Map();
  const idOf = (source) => {
    const key = `${source.kind}\u0000${source.display}`;
    let id = ids.get(key);
    if (id === undefined) {
      id = table.length;
      ids.set(key, id);
      table.push({ id, ...source });
    }
    return id;
  };
  const walk = (value) => {
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (!value || typeof value !== "object") return;
    const source = value.source;
    if (source && typeof source === "object" && typeof source.display === "string" && typeof source.kind === "string") {
      value.source = idOf(source);
      for (const [key, mirror] of Object.entries(SOURCE_MIRRORS)) {
        if (Object.hasOwn(value, key) && value[key] === source[mirror]) delete value[key];
      }
    }
    for (const key of Object.keys(value)) {
      const child = value[key];
      walk(child);
      if (child === false) delete value[key];
      else if (Array.isArray(child) && child.length === 0) delete value[key];
      else if (child && typeof child === "object" && !Array.isArray(child) && Object.keys(child).length === 0) {
        delete value[key];
      }
    }
  };
  walk(envelope);
  const out = { ...envelope };
  if (table.length) out.sourceTable = table;
  out.compact = true;
  return out;
}

/** `--limit`/`--all`: a number, or Infinity for "every one". A fallback of 0 means "all". */
function rowLimit(flags, fallback = 100) {
  if (flags.all) return Infinity;
  if (flags.limit === undefined) return fallback === 0 ? Infinity : fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

/** The universe the `--pak`/`--addon`/`--file` options build, or null when none was given. */
function universeFromFlags(flags) {
  if (!flags.sources.length) return null;
  return new ScriptUniverse({ sources: flags.sources, noPakPathSplit: !!flags.noPakPathSplit });
}

/** Open one `<source>` positional as a source plus its parsed file. */
function openSource(spec, flags) {
  const universe = new ScriptUniverse({ sources: [{ kind: "file", value: spec }], noPakPathSplit: !!flags.noPakPathSplit });
  const source = universe.sources()[0];
  return { universe, source, script: universe.parse(source) };
}

/** Resolve `<needle>` inside one file, or explain why it is not there. */
function resolveInSource(script, source, needle) {
  const parts = String(needle).split(".");
  if (parts.length > 2) throw new Error(`${needle} has more than one "." -- write Class.Member`);
  const all = declarationsOf(script);
  const match = (name, want) => name === want || name.toLowerCase() === String(want).toLowerCase();
  if (parts.length === 2) {
    const [ownerName, memberName] = parts;
    const owners = all.filter((d) => ["class", "enum"].includes(d.kind) && match(d.name, ownerName));
    if (!owners.length) {
      throw new Error(`${source.display} declares no class or enum named ${ownerName}` +
        (all.length ? `\n  it declares: ${all.filter((d) => !d.owner).slice(0, 8).map((d) => d.name).join(", ")}` : ""));
    }
    for (const owner of owners) {
      const member = (owner.members ?? []).find((m) => match(m.name, memberName)) ?? (owner.values ?? []).find((v) => match(v.name, memberName));
      if (member) return member;
    }
    const available = (owners[0].members ?? []).map((m) => m.name).concat((owners[0].values ?? []).map((v) => v.name));
    throw new Error(`${owners[0].name} has no member named ${memberName}` +
      (available.length ? `\n  it declares ${available.length} member(s), e.g. ${available.slice(0, 8).join(", ")}` : ""));
  }
  const found = all.filter((d) => match(d.name, parts[0]));
  if (!found.length) {
    throw new Error(`${source.display} declares nothing named ${parts[0]}` +
      (all.length ? `\n  it declares: ${all.filter((d) => !d.owner).slice(0, 10).map((d) => d.name).join(", ")}` : ""));
  }
  const order = { class: 0, enum: 1, typedef: 2, function: 3, variable: 4 };
  return found.sort((a, b) => (order[a.kind] ?? 9) - (order[b.kind] ?? 9))[0];
}

/** The 1-based line range as `12-345`, or `12` for one line. */
function lines(range) {
  if (!range) return "";
  return range.start === range.end ? `${range.start}` : `${range.start}-${range.end}`;
}

/** The first non-empty line of a docstring, trimmed for a one-line summary. */
function summary(doc, max = 92) {
  if (!doc?.text) return "";
  // The first line that is prose: a `\param` or `@example` line describes a detail, not the thing.
  const line = doc.text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l && !/^[@\\]/.test(l)) ?? "";
  return line.length > max ? `${line.slice(0, max - 1)}...` : line;
}

/** Where a source is, in one phrase: a path, or a pak and an entry. */
function where(source) {
  return source.kind === "pak" ? `${source.pak}:${source.entry}` : source.path;
}

/** The source without the archive it came from, for a compact human line. */
function shortWhere(source) {
  return source.kind === "pak" ? source.entry : source.path;
}

function docLine(doc) {
  if (!doc) return null;
  const text = summary(doc);
  const range = doc.start === doc.end ? `${doc.start}` : `${doc.start}-${doc.end}`;
  return `doc ${doc.trailing ? "(trailing) " : ""}${range}${text ? ` :: ${text}` : ""}`;
}

function attrLine(attrs) {
  if (!attrs?.length) return null;
  return `attrs ${attrs.map((a) => `[${a.name}${a.args === null ? "" : `(...)`})]`).join(" ")} (line ${attrs[0].line})`;
}

function conditionLine(conditions) {
  return conditions?.length ? `#if ${conditions.join(" && ")}` : null;
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCheck(positional, flags) {
  const universe = universeFromFlags(flags) ?? new ScriptUniverse({ sources: [] });
  // Positional sources are files or directories; a directory is read like --addon.
  for (const spec of positional) {
    const st = existsSync(spec) ? statSync(spec) : null;
    universe.specs.push({ kind: st?.isDirectory() ? "addon" : "file", value: spec });
  }
  const sources = universe.sources();
  if (!sources.length) throw usageError("check needs a source: a .c file, a directory, or --pak/--addon");
  const problems = [];
  let declarations = 0;
  const rows = [];
  try {
    for (const source of sources) {
      const script = universe.parse(source);
      const own = checkScript(script, { universe, source });
      declarations += declarationsOf(script).length;
      for (const p of own) problems.push({ source: source.display, ...p });
      rows.push({ source, script, problems: own });
    }
  } finally {
    universe.close();
  }
  const errors = problems.filter((p) => p.severity === "error").length;
  const warnings = problems.filter((p) => p.severity === "warning").length;
  const notes = problems.filter((p) => p.severity === "note").length;
  if (flags.json) {
    printJson(
      {
        command: "check",
        ok: errors === 0,
        files: sources.length,
        declarations,
        errors,
        warnings,
        notes,
        sources: sources.map(sourceRow),
        problems: problems.map((p) => ({
          source: p.source,
          severity: p.severity,
          code: p.code,
          message: p.message,
          line: p.line ?? null,
          symbol: p.name ?? null,
        })),
      },
      flags,
    );
  } else {
    const noisy = new Set(rows.filter((r) => r.problems.length).map((r) => r.source.display));
    for (const row of rows) {
      if (!noisy.has(row.source.display)) continue;
      const own = row.problems.filter((p) => p.severity === "error").length;
      console.log(`${own ? "FAIL" : "ok  "}  ${shortWhere(row.source)}`);
      for (const p of row.problems) console.log(`        [${p.severity}] line ${p.line ?? "?"}: ${p.message}`);
    }
    console.log(
      `${sources.length} file(s), ${declarations} declaration(s): ` +
        `${errors} error(s), ${warnings} warning(s), ${notes} note(s)` +
        (errors || warnings || notes ? "" : " -- no problems"),
    );
  }
  if (errors) process.exitCode = 1;
}

/**
 * `refs <needle> [--pak ...] [--addon ...] [--addons ...] [--file ...] [--regex] [--case-sensitive]
 * [--code-only] [--limit N|0]` -- where a name appears, in text.
 *
 * The search this reader has instead of a call graph. `where` separates code from a comment and
 * from a string literal, which is the difference between a use and a mention; `--code-only` drops
 * the other two. Exits 1 when nothing matches, like `find-defs`, so "no callers" is an answer and
 * not an empty screen.
 */
function cmdRefs(positional, flags) {
  if (positional.length !== 1) throw usageError("refs takes exactly one needle");
  const universe = universeFromFlags(flags);
  if (!universe) throw usageError("refs has nothing to search: pass --pak, --addon, --addons or --file");
  const needle = positional[0];
  if (flags.regex) {
    try {
      new RegExp(needle);
    } catch (err) {
      throw usageError(`--regex ${JSON.stringify(needle)} is not a regular expression: ${err.message}`);
    }
  }
  try {
    const found = findText(needle, { universe, regex: !!flags.regex, caseSensitive: !!flags.caseSensitive });
    const matches = flags.codeOnly ? found.filter((m) => m.where === "code") : found;
    const limit = rowLimit(flags);
    const shown = matches.slice(0, limit === Infinity ? matches.length : limit);
    if (flags.json) {
      printJson(
        {
          command: "refs",
          needle,
          regex: !!flags.regex,
          caseSensitive: !!flags.caseSensitive,
          codeOnly: !!flags.codeOnly,
          searched: { files: universe.sources().length },
          total: matches.length,
          returned: shown.length,
          truncated: shown.length < matches.length,
          matches: shown.map((m) => ({ source: m.source, line: m.line, column: m.column, where: m.where, text: m.text })),
        },
        flags,
      );
    } else {
      const files = new Set(matches.map((m) => m.source.display)).size;
      console.log(`${needle}: ${matches.length} match(es) in ${files} file(s) of ${universe.sources().length}`);
      for (const m of shown) {
        const tag = m.where === "code" ? "" : `  [${m.where}]`;
        console.log(`  ${shortWhere(m.source)}:${m.line}:${m.column}  ${m.text}${tag}`);
      }
      if (!matches.length) console.log(`# nothing mentions ${JSON.stringify(needle)} in the searched sources`);
      else if (shown.length < matches.length) console.log(`# ${matches.length} match(es), ${shown.length} shown -- use --limit 0 for every one`);
    }
    if (!matches.length) process.exitCode = 1;
  } finally {
    universe.close();
  }
}

/**
 * `stats [<source>] [--pak ...] [--addon ...] [--addons ...]` -- what is in the sources, counted.
 *
 * The point is reproducibility: a document that says "5 892 declarations sit under an #ifdef" should
 * be checkable by running one command, not by writing a script against the library. Every number
 * here comes from the parser, so a parser fix moves it and says so in the next run.
 */
function cmdStats(positional, flags) {
  const universe = universeFromFlags(flags) ?? new ScriptUniverse({ sources: [] });
  for (const spec of positional) {
    const st = existsSync(spec) ? statSync(spec) : null;
    universe.specs.push({ kind: st?.isDirectory() ? "addon" : "file", value: spec });
  }
  const sources = universe.sources();
  if (!sources.length) throw usageError("stats needs a source: a .c file, a directory, or --pak/--addon/--addons");
  let scripts;
  try {
    scripts = sources.map((source) => universe.parse(source));
  } finally {
    universe.close();
  }
  const stats = scriptStats(scripts);
  if (flags.json) {
    printJson({ command: "stats", ...stats }, flags);
    return;
  }
  const group = (value) => String(value).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const mb = (stats.bytes / 1e6).toFixed(1);
  console.log(`${group(stats.files)} file(s), ${mb} MB, ${group(stats.declarations)} declaration(s)`);
  const rows = [
    ["class", stats.classes.total, `${group(stats.classes.noMembers)} with no members, ${group(stats.classes.sealed)} sealed`],
    ["method", stats.methods.total, `${group(stats.methods.protoNative)} proto/native, ${group(stats.methods.override)} override`],
    ["field", stats.byKind.field ?? 0, ""],
    ["enum", stats.enums.total, `${group(stats.enums.values)} constant(s)`],
    ["typedef", stats.byKind.typedef ?? 0, ""],
    ["function", stats.byKind.function ?? 0, "global"],
    ["variable", stats.byKind.variable ?? 0, ""],
  ];
  for (const [label, count, note] of rows) {
    console.log(`  ${label.padEnd(11)}${group(count).padStart(7)}   ${note}`.trimEnd());
  }
  const moddedNote = [
    stats.modded.classes ? `${group(stats.modded.classes)} class` : null,
    stats.modded.enums ? `${group(stats.modded.enums)} enum` : null,
  ].filter(Boolean).join(", ");
  console.log(`  ${"modded".padEnd(11)}${group(stats.modded.total).padStart(7)}   ${moddedNote}`.trimEnd());
  const shown = stats.conditional.flags.slice(0, 5).map((f) => `${f.flag} ${group(f.declarations)}`).join(", ");
  const more = stats.conditional.flags.length - Math.min(5, stats.conditional.flags.length);
  const conditionalNote = `${stats.conditional.flags.length} flag(s)${shown ? `: ${shown}` : ""}${more > 0 ? ` (and ${more} more)` : ""}`;
  console.log(`  ${"conditional".padEnd(11)}${group(stats.conditional.declarations).padStart(7)}   ${conditionalNote}`.trimEnd());
}

function cmdFindDefs(positional, flags) {
  if (positional.length !== 1) throw usageError("find-defs takes exactly one needle");
  const universe = universeFromFlags(flags);
  if (!universe) throw usageError("find-defs has nothing to search: pass --pak, --addon or --file");
  const needle = positional[0];
  try {
    const result = findDefinitions(needle, {
      universe,
      kind: flags.kind ?? null,
      regex: !!flags.regex,
      originalOnly: !!flags.original,
      moddedOnly: !!flags.onlyModded,
    });
    const limit = rowLimit(flags);
    const shown = result.rows.slice(0, limit === Infinity ? result.rows.length : limit);
    if (flags.json) {
      printJson(
        {
          command: "find-defs",
          needle,
          kind: flags.kind ?? "all",
          regex: !!flags.regex,
          filter: flags.original ? "original" : flags.onlyModded ? "only-modded" : "all",
          searched: { files: universe.sources().length, parsed: result.stats.filesParsed },
          total: result.rows.length,
          returned: shown.length,
          truncated: shown.length < result.rows.length,
          definitions: shown,
        },
        flags,
      );
    } else if (flags.filesOnly) {
      for (const row of shown) console.log(where(row.source));
    } else {
      console.log(`${needle}: ${result.rows.length} definition(s) in ${universe.sources().length} file(s)` +
        (flags.stats ? `, ${result.stats.filesParsed} parsed` : ""));
      let n = 0;
      for (const row of shown) {
        n++;
        const tag = row.modded ? "modded" : "original";
        console.log("");
        console.log(`${n}. ${row.kind} ${row.qualifiedName}  [${tag}]`);
        console.log(`   ${row.signature}`);
        // With `--addons` the same entry path can exist in several addons: without a label two
        // real copies read as one row printed twice.
        const fromAddon = row.modded && row.source.addon ? `  [${row.source.addon}]` : "";
        console.log(`   ${shortWhere(row.source)}:${lines({ start: row.start, end: row.end })}${fromAddon}   (signature ${lines({ start: row.signatureStart, end: row.signatureEnd })})`);
        if (row.owner) console.log(`   in ${row.owner.kind} ${row.owner.name} (${lines(row.owner)})`);
        const doc = docLine(row.doc);
        if (doc) console.log(`   ${doc}`);
        const banner = row.banner ? `banner ${lines(row.banner)}` : null;
        if (banner) console.log(`   ${banner}`);
        const attrs = attrLine(row.attrs);
        if (attrs) console.log(`   ${attrs}`);
        const cond = conditionLine(row.conditions);
        if (cond) console.log(`   ${cond}`);
      }
      if (!result.rows.length) console.log(`# nothing matches ${JSON.stringify(needle)} in the searched sources`);
      else if (shown.length < result.rows.length) console.log(`# ${result.rows.length} row(s), ${shown.length} shown -- use --limit 0 for every one`);
    }
    if (!result.rows.length) process.exitCode = 1;
  } finally {
    universe.close();
  }
}

function cmdSchema(positional, flags) {
  if (positional.length !== 2) throw usageError("schema takes a source and a needle: schema <source> <needle>");
  const [spec, needle] = positional;
  const { universe, source, script } = openSource(spec, flags);
  let search = null;
  try {
    const decl = resolveInSource(script, source, needle);
    search = universeFromFlags(flags) ?? (flags.inherited ? universeForSource(source, { noPakPathSplit: !!flags.noPakPathSplit }) : null);
    if (decl.kind === "enum") numberEnumWithSources(decl, { universe: search });
    const schema = schemaOf(decl, source, { inherited: !!flags.inherited, universe: search });
    if (decl.kind === "enum" && decl.baseResolved) schema.baseResolved = decl.baseResolved;
    if (decl.kind === "enum" && decl.originalResolved) schema.originalResolved = decl.originalResolved;
    // A schema row is not the same size in the two modes: a text line is about a hundred bytes, a
    // JSON method object about two thousand (params, doc object, owner, flags). So the default is a
    // page of 100 lines as text and 25 rows as JSON, and the budget is shared across the lists
    // rather than per list -- a 242-method class with four base classes is 500 rows otherwise.
    // Without the cap the same answer is 517 KB of JSON, the one thing an agent cannot afford by
    // accident; `counts` keeps the truth about how many rows there are, so a truncated answer never
    // reads as a complete one.
    const limit = rowLimit(flags, flags.json ? 25 : 100);
    const wanted = flags.members ?? "all";
    const fieldsAll = wanted === "methods" ? [] : (schema.fields ?? []);
    const methodsAll = wanted === "fields" ? [] : (schema.methods ?? []);
    const valuesAll = schema.values ?? [];
    const inheritedAll = (schema.inherited ?? []).map((group) => ({ ...group, members: group.members ?? [] }));
    let budget = limit;
    const take = (list) => {
      const n = budget === Infinity ? list.length : Math.min(list.length, Math.max(0, budget));
      if (budget !== Infinity) budget -= n;
      return list.slice(0, n);
    };
    const shownFields = take(fieldsAll);
    const shownMethods = take(methodsAll);
    const shownValues = take(valuesAll);
    const shownInherited = inheritedAll.map((group) => ({ ...group, members: take(group.members) }));
    const counts = {
      fields: (schema.fields ?? []).length,
      methods: (schema.methods ?? []).length,
      values: valuesAll.length,
      inherited: inheritedAll.reduce((n, group) => n + group.members.length, 0),
    };
    const truncated =
      shownFields.length < fieldsAll.length ||
      shownMethods.length < methodsAll.length ||
      shownValues.length < valuesAll.length ||
      inheritedAll.some((group, i) => shownInherited[i].members.length < group.members.length);
    if (flags.json) {
      const shownSchema = {
        ...schema,
        ...(schema.fields ? { fields: shownFields } : {}),
        ...(schema.methods ? { methods: shownMethods } : {}),
        ...(schema.values ? { values: shownValues } : {}),
        ...(schema.inherited ? { inherited: shownInherited } : {}),
      };
      printJson({ command: "schema", needle, kind: decl.kind, total: 1, returned: 1, truncated, counts, schema: shownSchema }, flags);
    } else {
      const printDoc = (doc, indent = "  ") => {
        if (!doc) return;
        const range = doc.start === doc.end ? `${doc.start}` : `${doc.start}-${doc.end}`;
        console.log(`${indent}doc ${doc.trailing ? "(trailing) " : ""}lines ${range}`);
        for (const line of doc.text.split("\n")) console.log(`${indent}  ${line}`);
      };
      if (schema.kind === "class") {
        console.log(`${schema.signature}   lines ${lines(schema)}${schema.modded ? "  [modded]" : ""}`);
        console.log(`  source   ${shortWhere(source)}`);
        if (schema.conditions.length) console.log(`  ${conditionLine(schema.conditions)}`);
        printDoc(schema.doc);
        if (schema.banner && !schema.doc) {
          console.log(`  banner lines ${lines(schema.banner)}`);
          for (const line of schema.banner.text.split("\n").slice(0, 6)) console.log(`    ${line}`);
        }
        if (schema.attrs.length) for (const a of schema.attrs) console.log(`  attr     [${a.name}${a.args === null ? "" : `(${a.args})`}]  line ${a.line}`);
        // A docstring that carries only tooling tags (`@example`, `\param`) has no one-line summary;
        // the line is printed without its trailing gap rather than with three stray spaces.
        const tail = (doc, max) => {
          const text = doc ? summary(doc, max) : "";
          return text ? `   ${text}` : "";
        };
        const fieldTail = (doc, max) => {
          const text = doc ? summary(doc, max) : "";
          return text ? `   //!< ${text}` : "";
        };
        console.log(`  fields (${schema.fields.length})`);
        for (const f of shownFields) console.log(`    ${f.signature}   line ${lines(f)}${fieldTail(f.doc, 60)}`);
        if (shownFields.length < fieldsAll.length) console.log(`    ... ${fieldsAll.length - shownFields.length} more (--limit 0)`);
        console.log(`  methods (${schema.methods.length})`);
        for (const m of shownMethods) console.log(`    ${m.signature}   lines ${lines(m)}${tail(m.doc, 60)}`);
        if (shownMethods.length < methodsAll.length) console.log(`    ... ${methodsAll.length - shownMethods.length} more (--limit 0)`);
        for (let i = 0; i < inheritedAll.length; i++) {
          const group = inheritedAll[i];
          console.log(`  inherited from ${group.name}${group.missing ? " (NOT FOUND -- pass --pak/--addon for it)" : ""}${group.members.length ? ` (${group.members.length})` : ""}`);
          for (const m of shownInherited[i].members) console.log(`    ${m.signature}   lines ${lines(m)}`);
          if (shownInherited[i].members.length < group.members.length) {
            console.log(`    ... ${group.members.length - shownInherited[i].members.length} more (--limit 0)`);
          }
        }
        if (schema.nested?.length) {
          console.log(`  nested (${schema.nested.length})`);
          for (const n of schema.nested) console.log(`    ${n.kind} ${n.name}   lines ${lines(n)}`);
        }
      } else if (schema.kind === "enum") {
        console.log(`${schema.signature}   lines ${lines(schema)}`);
        console.log(`  source   ${shortWhere(source)}`);
        printDoc(schema.doc);
        if (schema.attrs.length) for (const a of schema.attrs) console.log(`  attr     [${a.name}${a.args === null ? "" : `(${a.args})`}]  line ${a.line}`);
        if (schema.base) {
          const resolved = schema.baseResolved
            ? ` (${schema.baseResolved.source.display ? shortWhere(schema.baseResolved.source) : "resolved"}:${lines(schema.baseResolved)})`
            : " (NOT FOUND -- pass --pak/--addon to resolve its values)";
          console.log(`  base     ${schema.base}${resolved}`);
        }
        if (schema.originalResolved) console.log(`  original ${shortWhere(schema.originalResolved.source)}:${lines(schema.originalResolved)}`);
        console.log(`  values (${schema.values.length})${schema.valuesKnown || !schema.modded ? "" : "  -- numbering continues from the original, which was not found"}`);
        for (const v of shownValues) {
          const value = v.valueKnown || v.value !== null ? String(v.value) : "?";
          const expr = v.expr ? `  (= ${v.expr})` : "";
          const doc = v.doc && summary(v.doc, 50) ? `   //!< ${summary(v.doc, 50)}` : "";
          console.log(`    ${v.name.padEnd(28)} = ${value.padStart(6)}   line ${v.line}${expr}${doc}`);
        }
        if (shownValues.length < valuesAll.length) console.log(`    ... ${valuesAll.length - shownValues.length} more (--limit 0)`);
      } else {
        console.log(`${schema.kind} ${schema.qualifiedName}   lines ${lines(schema)}${schema.modded ? "  [modded]" : ""}`);
        console.log(`  ${schema.signature}`);
        console.log(`  source   ${shortWhere(source)}`);
        if (schema.owner) console.log(`  in ${schema.owner.kind} ${schema.owner.name}   lines ${lines(schema.owner)}`);
        printDoc(schema.doc);
        if (schema.params?.length) {
          console.log(`  params (${schema.params.length})`);
          for (const p of schema.params) console.log(`    ${p.signature}${p.defaultValue ? `  = ${p.defaultValue}` : ""}`);
        }
        if (schema.attrs.length) for (const a of schema.attrs) console.log(`  attr     [${a.name}${a.args === null ? "" : `(${a.args})`}]  line ${a.line}`);
      }
    }
  } finally {
    universe.close();
    // The universe `--inherited` or an enum base was resolved through, when it was one of ours.
    if (search && search !== universe) search.close();
  }
}

function cmdSignature(positional, flags) {
  if (positional.length !== 2) throw usageError("signature takes a source and a needle: signature <source> <needle>");
  const [spec, needle] = positional;
  const { universe, source, script } = openSource(spec, flags);
  try {
    const decl = resolveInSource(script, source, needle);
    if (decl.kind === "enum") numberEnumWithSources(decl, { universe: null });
    const row = definitionRow(decl, source);
    if (flags.json) {
      printJson(
        {
          command: "signature",
          needle,
          found: 1,
          definitions: [
            {
              kind: row.kind,
              name: row.name,
              qualifiedName: row.qualifiedName,
              modded: row.modded,
              signature: row.signature,
              source: row.source,
              signatureStart: row.signatureStart,
              signatureEnd: row.signatureEnd,
              start: row.start,
              end: row.end,
              owner: row.owner,
              doc: row.doc,
              banner: row.banner,
              conditions: row.conditions,
            },
          ],
        },
        flags,
      );
      return;
    }
    console.log(row.signature);
    console.log(`  ${shortWhere(source)}:${lines({ start: row.start, end: row.end })}   (signature ${lines({ start: row.signatureStart, end: row.signatureEnd })})`);
    if (row.owner) console.log(`  in ${row.owner.kind} ${row.owner.name}   lines ${lines(row.owner)}`);
    if (row.conditions.length) console.log(`  ${conditionLine(row.conditions)}`);
    if (row.doc) {
      const range = row.doc.start === row.doc.end ? `${row.doc.start}` : `${row.doc.start}-${row.doc.end}`;
      console.log(`  doc lines ${range}`);
      for (const line of row.doc.text.split("\n")) console.log(`    ${line}`);
    } else if (row.banner) {
      console.log(`  (no docstring; banner lines ${lines(row.banner)})`);
    }
  } finally {
    universe.close();
  }
}

function cmdChain(positional, flags) {
  if (!positional.length || positional.length > 2) throw usageError("inheritance-chain takes a source and an optional class name");
  const [spec, wanted] = positional;
  const { universe: own, source, script } = openSource(spec, flags);
  const search = universeFromFlags(flags) ?? universeForSource(source, { noPakPathSplit: !!flags.noPakPathSplit });
  try {
    const decl = wanted ? resolveInSource(script, source, wanted) : script.declarations.find((d) => d.kind === "class");
    if (!decl || decl.kind !== "class") throw new Error(`${source.display} declares no class${wanted ? ` named ${wanted}` : ""}`);
    const max = flags.depth ?? 64;
    const result = inheritanceChain(decl, source, { universe: search, max });
    if (flags.json) {
      printJson(
        {
          command: "inheritance-chain",
          class: decl.name,
          source: sourceRow(source),
          searched: { files: search.sources().length },
          total: result.rows.length,
          returned: result.rows.length,
          truncated: result.truncated,
          problems: result.problems,
          chain: result.rows.map((r) => ({
            depth: r.depth,
            role: r.role,
            kind: r.kind,
            name: r.name,
            modded: r.modded,
            signature: r.signature,
            base: r.base ?? null,
            source: r.source,
            start: r.start,
            end: r.end,
            doc: r.doc,
          })),
        },
        flags,
      );
    } else {
      for (const row of result.rows) {
        const pad = "  ".repeat(row.depth);
        const tag = row.role === "modded" ? "  [modded]" : "";
        console.log(`${row.depth} ${pad}${row.signature}${tag}`);
        const chainDoc = row.doc && summary(row.doc, 70) ? `   ${summary(row.doc, 70)}` : "";
        console.log(`${row.depth} ${pad}    ${shortWhere(row.source)}:${lines({ start: row.start, end: row.end })}${chainDoc}`);
      }
      for (const p of result.problems) console.log(`[${p.severity}] ${p.message}`);
      console.log(`${result.rows.length} step(s) in the chain${result.truncated ? " -- raise --depth for more" : ""}`);
    }
    if (result.problems.some((p) => p.severity === "error")) process.exitCode = 1;
  } finally {
    own.close();
    if (search !== own) search.close();
  }
}

function cmdTree(positional, flags) {
  if (!positional.length || positional.length > 2) throw usageError("subclass-tree takes a source and an optional class name");
  const [spec, wanted] = positional;
  const { universe: own, source, script } = openSource(spec, flags);
  const search = universeFromFlags(flags) ?? universeForSource(source, { noPakPathSplit: !!flags.noPakPathSplit });
  try {
    const decl = wanted ? resolveInSource(script, source, wanted) : script.declarations.find((d) => d.kind === "class");
    if (!decl || decl.kind !== "class") throw new Error(`${source.display} declares no class${wanted ? ` named ${wanted}` : ""}`);
    const limit = rowLimit(flags, 200);
    const result = subclassTree(decl.name, {
      universe: search,
      maxDepth: flags.depth ?? 0,
      includeModded: !flags.noModded,
      limit,
    });
    // The root's own declarations come from the source that was named, then from the universe;
    // `--no-modded` leaves the modded copies out of this list too, not only out of the tree.
    const rootDecls = [...(decl ? [{ decl, source }] : []), ...declarationsNamed(decl.name, search).filter((f) => f.decl.kind === "class")].filter(
      (f) => !flags.noModded || !f.decl.modded,
    );
    const seenRoot = new Set();
    const root = result.root;
    root.declarations = rootDecls
      .filter((f) => {
        const key = `${f.source.display}|${f.decl.range.start}`;
        if (seenRoot.has(key)) return false;
        seenRoot.add(key);
        return true;
      })
      .map((f) => ({ ...definitionRow(f.decl, f.source), role: f.decl.modded ? "modded" : "original" }));
    const countNodes = (node) => 1 + node.children.reduce((n, c) => n + countNodes(c), 0);
    if (flags.json) {
      printJson(
        {
          command: "subclass-tree",
          class: decl.name,
          source: sourceRow(source),
          searched: { files: search.sources().length },
          depth: flags.depth ?? 0,
          modded: !flags.noModded,
          total: countNodes(root) - 1,
          truncated: result.truncated,
          problems: result.problems,
          tree: root,
        },
        flags,
      );
    } else {
      const print = (node, level) => {
        const pad = "  ".repeat(level);
        console.log(`${pad}${node.name}${node.base ? ` : ${node.base}` : ""}${level === 0 ? "" : ""}`);
        for (const d of node.declarations) {
          const treeDoc = d.doc && summary(d.doc, 60) ? `   ${summary(d.doc, 60)}` : "";
          console.log(`${pad}  ${d.modded ? "[modded] " : ""}${shortWhere(d.source)}:${lines({ start: d.start, end: d.end })}${treeDoc}`);
        }
        for (const child of node.children) print(child, level + 1);
      };
      print(root, 0);
      for (const p of result.problems) console.log(`[${p.severity}] ${p.message}`);
      console.log(`${countNodes(root) - 1} subclass(es) below ${root.name}${result.truncated ? " -- --limit reached, raise it or use --depth" : ""}`);
    }
    if (result.problems.some((p) => p.severity === "error")) process.exitCode = 1;
  } finally {
    own.close();
    if (search !== own) search.close();
  }
}

/**
 * `cat <source> [<lines>]` -- the file's text, or one line, or an inclusive range of them.
 *
 * This is the command that answers "show me what is at line 400", which every other command only
 * points at: `find-defs` and `schema` report ranges, and a range is useful only if the text behind it
 * can be read without extracting a 2 GB archive. Numbers are printed so a range can be navigated and
 * a snippet can be quoted with its lines; `--plain` drops the column for a copy-paste.
 */
function cmdCat(positional, flags) {
  if (!positional.length || positional.length > 2) throw usageError("cat takes a source and an optional <lines>: cat <source> 400-500");
  const [spec, lineSpec] = positional;
  const { universe, source, script } = openSource(spec, flags);
  try {
    const all = splitLines(script.text);
    const range = lineSpec === undefined ? { from: 1, to: all.length, requestedTo: all.length, clamped: false } : parseLineSpec(lineSpec, all.length);
    const shown = all.slice(range.from - 1, range.to);
    if (flags.json) {
      printJson(
        {
          command: "cat",
          source: sourceRow(source),
          from: range.from,
          to: range.to,
          requestedTo: range.requestedTo,
          clamped: range.clamped,
          fileLines: all.length,
          total: all.length,
          returned: shown.length,
          truncated: range.clamped,
          text: shown.join("\n"),
          lines: shown.map((text, n) => ({ line: range.from + n, text })),
        },
        flags,
      );
      return;
    }
    const where = shortWhere(source);
    const span = range.from === range.to ? `line ${range.from}` : `lines ${range.from}-${range.to}`;
    console.log(`${where}: ${span} of ${all.length}${range.clamped ? ` (asked for ${range.from}-${range.requestedTo}, the file ends at ${all.length})` : ""}`);
    if (!flags.plain) {
      const width = String(range.to).length;
      for (let n = 0; n < shown.length; n++) console.log(`${String(range.from + n).padStart(width)}\t${shown[n]}`);
    } else for (const line of shown) console.log(line);
  } finally {
    universe.close();
  }
}

function cmdOutline(positional, flags) {
  if (positional.length !== 1) throw usageError("outline takes exactly one source");
  const { universe, source, script } = openSource(positional[0], flags);
  try {
    const rows = [];
    const visit = (decl, depth) => {
      rows.push({
        kind: decl.kind,
        name: decl.name,
        qualifiedName: qualifiedName(decl),
        modded: !!decl.modded,
        signature: decl.signature,
        depth,
        start: decl.range.start,
        end: decl.range.end,
        doc: decl.doc ?? null,
        conditions: decl.conditions ?? [],
      });
    };
    const walkDepth = (decls, depth) => {
      for (const d of decls) {
        visit(d, depth);
        if (d.members?.length) walkDepth(d.members, depth + 1);
        if (d.nested?.length) walkDepth(d.nested, depth);
      }
    };
    walkDepth(script.declarations, 0);
    const limit = rowLimit(flags, 0);
    const shown = limit === Infinity ? rows : rows.slice(0, limit);
    if (flags.json) {
      printJson(
        {
          command: "outline",
          source: sourceRow(source),
          total: rows.length,
          returned: shown.length,
          truncated: shown.length < rows.length,
          declarations: shown,
          directives: script.directives,
          problems: script.problems,
        },
        flags,
      );
      return;
    }
    console.log(`${shortWhere(source)}: ${rows.length} declaration(s), ${script.lines} line(s)`);
    for (const row of shown) {
      const pad = "  ".repeat(row.depth);
      const range = `${lines({ start: row.start, end: row.end })}`.padEnd(12);
      const tag = row.modded ? "  [modded]" : "";
      // A class, enum or typedef signature already starts with its keyword; a member's does not.
      const keyword = ["class", "enum", "typedef"].includes(row.kind) ? "" : `${row.kind.padEnd(8)} `;
      console.log(`  ${range}${pad}${keyword}${row.signature}${tag}`);
      const outlineDoc = row.doc && summary(row.doc, 80) ? summary(row.doc, 80) : "";
      if (outlineDoc) console.log(`  ${"".padEnd(12)}${pad}${"".padEnd(9)} //! ${outlineDoc}`);
    }
    if (shown.length < rows.length) console.log(`# ${rows.length} row(s), ${shown.length} shown -- use --limit 0 for every one`);
    for (const p of script.problems) console.log(`[${p.severity}] line ${p.line}: ${p.message}`);
  } finally {
    universe.close();
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (!flags._.length) {
    process.stderr.write(USAGE);
    process.exitCode = 1;
    return;
  }
  const [command, ...rest] = flags._;
  const key = COMMANDS[command];
  if (!key) throw usageError(`unknown command "${command}" -- one of ${Object.keys(COMMANDS).join(", ")}`);
  checkOptions(key, command, flags);
  switch (key) {
    case "check": cmdCheck(rest, flags); break;
    case "stats": cmdStats(rest, flags); break;
    case "refs": cmdRefs(rest, flags); break;
    case "findDefs": cmdFindDefs(rest, flags); break;
    case "schema": cmdSchema(rest, flags); break;
    case "signature": cmdSignature(rest, flags); break;
    case "chain": cmdChain(rest, flags); break;
    case "tree": cmdTree(rest, flags); break;
    case "outline": cmdOutline(rest, flags); break;
    case "cat": cmdCat(rest, flags); break;
    default: throw usageError(`unknown command "${command}"`);
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.usage) process.stderr.write(`\n${USAGE}`);
    process.exitCode = 1;
  }
}



