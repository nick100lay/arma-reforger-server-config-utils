#!/usr/bin/env node
// Check the encoding rules this repository relies on.
//
//   node tools/check-encoding.mjs [--quiet]
//
// Every text file must be UTF-8 without a BOM, LF-only, and end with a newline. That is not
// house style: data/manifest.json records file hashes, and a tool that rewrites a file with
// CRLF, or a BOM, turns an edit into a whole-file diff for everyone downstream.
//
// The last check is the one that actually bit this repository. Windows PowerShell 5.1
// (`powershell`, not `pwsh`) decodes a BOM-less UTF-8 file as the ANSI code page — CP1251 on a
// Russian-locale system — and writes it back as UTF-8, so a Get-Content / WriteAllText round
// trip silently corrupts every em dash. Nothing fails; the text is simply wrong from then on.
//
// The residue consists of Cyrillic letters from the Serbian and Macedonian range — code points
// U+0402, U+0403, U+0452, U+0453 and U+0409-U+040F — which never occur in Russian text and
// therefore cannot be false positives in a translation. They are matched by code point: the
// characters themselves are quoted neither here nor in CHANGELOG.md, so this check stays strict.
//
// CONTRIBUTING.md is the one exception: it quotes the residue on purpose, in the paragraph that
// documents the trap for the next person. Those lines are counted and reported as exempt rather
// than silently skipped.
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const quiet = process.argv.includes("--quiet");

const TEXT_EXT = [".md", ".json", ".mjs", ".cjs", ".js", ".ps1", ".yml", ".yaml", ".txt", ".editorconfig"];
const TEXT_NAMES = [".editorconfig", ".gitignore", ".gitattributes"];
// `out/` and `build/` are gitignored artefacts (extracted game data, generated output): they are
// not this repository's text, and a tool's scratch file must not fail the check that guards it.
const SKIP_DIRS = new Set([".git", "node_modules", "tests/.tmp", "out", "build"]);

/** Code points that only ever appear here as the residue of a CP1251 misreading. */
const MOJIBAKE = /[\u0402\u0403\u0452\u0453\u0409\u040A\u040B\u040C\u040F]/;

/** Files allowed to contain those code points, and why. */
const ALLOWED = {
  "CONTRIBUTING.md": "quotes the mangled sequences in the section that documents the trap",
};

function collect(dir, out = []) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const rel = join(dir, e.name).slice(root.length + 1).replace(/\\/g, "/");
    if (e.isDirectory()) {
      if (SKIP_DIRS.has(rel) || e.name.startsWith(".")) continue;
      collect(join(dir, e.name), out);
    } else if (TEXT_EXT.some((x) => e.name.endsWith(x)) || TEXT_NAMES.includes(e.name)) {
      out.push(rel);
    }
  }
  return out;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const problems = [];
let checked = 0;
let exempt = 0;

for (const rel of collect(root).sort()) {
  const bytes = readFileSync(join(root, rel));
  checked++;

  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    problems.push([rel, "starts with a UTF-8 BOM — it must not (see CONTRIBUTING.md, 'Encoding')"]);
    continue;
  }

  let text;
  try {
    text = decoder.decode(bytes);
  } catch {
    problems.push([rel, "is not valid UTF-8"]);
    continue;
  }

  if (text.includes("\r\n")) problems.push([rel, "contains CRLF line endings — use LF"]);
  if (!text.endsWith("\n")) problems.push([rel, "does not end with a newline"]);

  const hits = text.split("\n").filter((l) => MOJIBAKE.test(l));
  if (hits.length) {
    if (ALLOWED[rel]) {
      exempt += hits.length;
    } else {
      problems.push([
        rel,
        `${hits.length} line(s) contain CP1251-mojibake residue, e.g. ${JSON.stringify(hits[0].slice(0, 70))} — ` +
          `the file was round-tripped through a shell that decoded UTF-8 as the ANSI code page`,
      ]);
    }
  }
}

if (!quiet) {
  console.log(`=== ${checked} text file(s) ===`);
  for (const [rel, msg] of problems) console.log(`FAIL  ${rel}: ${msg}`);
  if (exempt) {
    console.log(`      ${exempt} deliberately quoted mangled sequence(s) in ${Object.keys(ALLOWED).join(", ")} — exempt`);
  }
}
console.log(`\n${problems.length === 0 ? "ENCODING OK" : problems.length + " ENCODING PROBLEM(S)"}`);
process.exit(problems.length ? 1 : 0);
