// Test suite for tools/loc.mjs (the localization / StringTableRuntime reader).
//
//   node tests/localization-tests.mjs
//
// The fixtures are written here as text, so the suite pins the *format rules* rather than a
// captured table: the game's own files are inside 2 GB .pak archives and cannot be committed.
// What is pinned, and why each one is worth a test:
//   * `Ids` and `Texts` are parallel by position — the only link between the two halves;
//   * a lone `\` *outside* the quotes continues a text in the next string, and joining the pieces
//     is what makes the counts agree (the vanilla `en_us` table writes 16 217 ids as 18 097
//     physical strings; a reader that ignores the marker reports a mismatch the file does not have);
//   * `\\"` is an escaped quote written double-escaped, and reading it classically ends the
//     string inside the BBCode tag it belongs to (one vanilla entry is exactly this);
//   * any other `\X` stays verbatim, so `<ucs codepoints="\u1f600"/>` is not turned into a code
//     point the engine never saw;
//   * an empty `StringTableRuntime { }` is a table, not a defect — 11 installed files are this;
//   * everything else is refused **by name**: a missing block, a count mismatch, a `Languages`
//     block, a dangling continuation.
//
// The CLI is exercised as a real child process with its output written to files, so the suite
// keeps working in sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseStringTable,
  openStringTables,
  compareStringTables,
  languageOfName,
  parseSourceSpec,
  MergedStringTable,
  StringTableError,
} from "../tools/loc.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "loc.mjs");
const tmp = join(root, "tests", ".tmp-loc");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else {
    failures++;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Write a fixture and return its path. `\.` cases are quoted from the game on purpose. */
function fixture(name, text, { bom = false, crlf = false } = {}) {
  const body = crlf ? text.replace(/\n/g, "\r\n") : text;
  writeFileSync(join(tmp, name), Buffer.concat([bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0), Buffer.from(body, "utf8")]));
  return join(tmp, name);
}

/** Run the CLI, with stdout and stderr going to files rather than to pipes. */
function runCli(args) {
  const outPath = join(tmp, "cli.out");
  const errPath = join(tmp, "cli.err");
  writeFileSync(outPath, "");
  writeFileSync(errPath, "");
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  let status;
  try {
    status = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", out, err] }).status;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return { status, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8") };
}

/** A table as text: `pairs` is [[id, text], ...]. */
function table(pairs, { split = false } = {}) {
  const ids = pairs.map(([id]) => `  "${id}"`).join("\n");
  const texts = pairs.map(([, text]) => `  ${split ? text.split("\n").join("\n  ") : `"${text}"`}`).join("\n");
  return `StringTableRuntime {\n Ids {\n${ids}\n }\n Texts {\n${texts}\n }\n}\n`;
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// --- the parallel pair -------------------------------------------------------
const basic = fixture(
  "basic.en_us.conf",
  table([
    ["AR-One", "First"],
    ["AR-Two", "Second"],
    ["AR-MapIcon_Tower", "Tower"],
  ]),
);
const basicTable = parseStringTable(readFileSync(basic), { name: "basic.en_us.conf" });
check("basic: three entries", basicTable.size === 3, `size ${basicTable.size}`);
check("basic: the language is read off the file name", basicTable.language === "en_us", String(basicTable.language));
check("basic: get() returns the text", basicTable.get("AR-Two") === "Second", String(basicTable.get("AR-Two")));
check(
  "basic: resolve() takes the # the game writes",
  (() => {
    const r = basicTable.resolve("#AR-MapIcon_Tower");
    return r.found && r.id === "AR-MapIcon_Tower" && r.text === "Tower" && r.key === "#AR-MapIcon_Tower";
  })(),
  JSON.stringify(basicTable.resolve("#AR-MapIcon_Tower")),
);
check(
  "basic: a missing key is null and resolve() says found: false",
  basicTable.get("AR-Nope") === null && basicTable.resolve("AR-Nope").found === false,
);
check("basic: nothing is reported as a problem", basicTable.problems.length === 0, JSON.stringify(basicTable.problems));

// --- continuation ------------------------------------------------------------
const continued = fixture(
  "continued.en_us.conf",
  [
    "StringTableRuntime {",
    " Ids {",
    '  "AR-Brief"',
    '  "AR-Other"',
    " }",
    " Texts {",
    '  "Of critical importance is "\\',
    '  ""\\',
    '  "our defense of Point Osvald."\\',
    '  ""\\',
    '  "What they need is time."',
    '  "Second."',
    " }",
    "}",
    "",
  ].join("\n"),
);
const continuedTable = parseStringTable(readFileSync(continued), { name: "continued.en_us.conf" });
check(
  "continuation: the pieces are joined, not counted as entries",
  continuedTable.size === 2 && continuedTable.get("AR-Brief") === "Of critical importance is our defense of Point Osvald.What they need is time.",
  JSON.stringify(continuedTable.get("AR-Brief")),
);
check(
  "continuation: the empty `\"\"` pieces add nothing",
  continuedTable.get("AR-Brief").includes(" .") === false && continuedTable.get("AR-Brief").includes("Osvald.What") === true,
  JSON.stringify(continuedTable.get("AR-Brief")),
);
check(
  "continuation: the split is recorded per entry, and the next entry is untouched",
  continuedTable.entry("AR-Brief").pieces === 5 && continuedTable.entry("AR-Other").pieces === 1 && continuedTable.get("AR-Other") === "Second.",
  `${continuedTable.entry("AR-Brief").pieces} / ${continuedTable.entry("AR-Other").pieces}`,
);

// The vanilla en_us table keeps its texts in 2 000 physical strings more than ids: the whole point
// of the marker is that the arrays still line up.
const many = fixture(
  "many.en_us.conf",
  table(
    Array.from({ length: 150 }, (_, i) => [`AR-Key${i}`, `text ${i}`]),
  ),
);

// --- line numbers, at the size the game ships ---------------------------------
// Every entry carries its line, and computing that by rescanning the file per entry is O(n²): the
// vanilla `en_us` table (16 217 ids in 1.5 MB) took 9.6 s to parse that way, so each command looked
// like it had hung. The bound below is deliberately loose (0.1 s now, ~8 s before) — it is there to
// catch the quadratic shape returning, not to benchmark the machine.
{
  const big = fixture(
    "big.en_us.conf",
    table(Array.from({ length: 16000 }, (_, i) => [`AR-Big${i}`, `text ${i}`])),
  );
  const started = Date.now();
  const bigTable = parseStringTable(readFileSync(big), { name: "big.en_us.conf" });
  const elapsed = Date.now() - started;
  check(
    "line numbers: 16 000 entries parse in seconds, not minutes",
    bigTable.size === 16000 && elapsed < 3000,
    `${bigTable.size} entries in ${elapsed} ms`,
  );
  // The id on line 2 + 2k is the k-th entry; a wrong index would still be monotonic, so pin two.
  check(
    "line numbers: an entry's line is where its id really sits",
    bigTable.entries[0].line === 3 &&
      bigTable.entries[1].line === 4 &&
      bigTable.entries[999].line === 1002 &&
      bigTable.entries[15999].line === 16002,
    [bigTable.entries[999].line, bigTable.entries[15999].line].join(" / "),
  );
}

// --- escapes -----------------------------------------------------------------
const escaped = fixture(
  "escapes.en_us.conf",
  [
    "StringTableRuntime {",
    " Ids {",
    '  "AR-Newline"',
    '  "AR-Quote"',
    '  "AR-DoubleEscaped"',
    '  "AR-Codepoints"',
    " }",
    " Texts {",
    '  "line one\\nline two"',
    '  "say \\"hi\\""',
    '  "Open <color rgba=\\\\"226,168,79,255\\\\">Player List</color> to vote"',
    '  "GG <ucs codepoints=\\"\\u1f600\\u1f601\\"/>"',
    " }",
    "}",
    "",
  ].join("\n"),
);
const escapedTable = parseStringTable(readFileSync(escaped), { name: "escapes.en_us.conf" });
check("escapes: \\n becomes a newline", escapedTable.get("AR-Newline") === "line one\nline two", JSON.stringify(escapedTable.get("AR-Newline")));
check('escapes: \\" becomes a quote', escapedTable.get("AR-Quote") === 'say "hi"', JSON.stringify(escapedTable.get("AR-Quote")));
check(
  "escapes: the doubled \\\\\\\" keeps the string in one piece and its backslash",
  escapedTable.get("AR-DoubleEscaped") === 'Open <color rgba=\\"226,168,79,255\\">Player List</color> to vote',
  JSON.stringify(escapedTable.get("AR-DoubleEscaped")),
);
check(
  "escapes: an unknown \\X is kept verbatim, so \\u escapes are not decoded",
  escapedTable.get("AR-Codepoints") === 'GG <ucs codepoints="\\u1f600\\u1f601"/>',
  JSON.stringify(escapedTable.get("AR-Codepoints")),
);
check("escapes: raw() is the file's own spelling", escapedTable.raw("AR-Newline") === "line one\\nline two", JSON.stringify(escapedTable.raw("AR-Newline")));

// --- shapes the game ships ---------------------------------------------------
const empty = fixture("empty.ru_ru.conf", "StringTableRuntime {\n}\n");
const emptyTable = parseStringTable(readFileSync(empty), { name: "empty.ru_ru.conf" });
check("empty: `StringTableRuntime { }` is a table with no entries, not an error", emptyTable.size === 0 && emptyTable.problems.length === 0);

const bomCrlf = fixture("windows.en_us.conf", table([["AR-A", "A"]]), { bom: true, crlf: true });
const bomTable = parseStringTable(readFileSync(bomCrlf), { name: "windows.en_us.conf" });
check("BOM + CRLF: a Windows-saved table reads the same", bomTable.get("AR-A") === "A");

// --- refused by name ---------------------------------------------------------
function throwsNaming(name, text, needles) {
  try {
    parseStringTable(text, { name: "broken.conf" });
    check(name, false, "no error at all");
  } catch (err) {
    const okType = err instanceof StringTableError;
    const missing = needles.filter((n) => !err.message.includes(n));
    check(name, okType && missing.length === 0, `${err.message}${missing.length ? ` (missing ${JSON.stringify(missing)})` : ""}`);
  }
}

throwsNaming(
  "refused: Texts with one string fewer than Ids, with both counts named",
  'StringTableRuntime {\n Ids {\n  "A"\n  "B"\n }\n Texts {\n  "a"\n }\n}\n',
  ["2", "1", "parallel"],
);
throwsNaming("refused: a table without Texts", 'StringTableRuntime {\n Ids {\n  "A"\n }\n}\n', ['no "Texts" block']);
throwsNaming("refused: a Languages block, which is another shape", 'StringTableRuntime {\n Languages {\n }\n}\n', ["Languages", "another shape"]);
throwsNaming("refused: content after the closing brace", 'StringTableRuntime {\n}\njunk\n', ["after the closing brace"]);
throwsNaming("refused: something that is not a string table", 'SomethingElse {\n}\n', ['StringTableRuntime']);

// --- the defects the game tolerates ------------------------------------------
const dupes = fixture(
  "dupes.en_us.conf",
  table([
    ["AR-A", "first"],
    ["AR-B", "second"],
    ["AR-A", "third"],
  ]),
);
const dupesTable = parseStringTable(readFileSync(dupes), { name: "dupes.en_us.conf" });
const dupError = dupesTable.problems.find((p) => p.severity === "error");
check(
  "duplicates: an error that names the id and both lines",
  !!dupError && dupError.message.includes('"AR-A"') && dupError.message.includes("line 5") && dupError.message.includes("line 3"),
  JSON.stringify(dupesTable.problems),
);
check("duplicates: the first occurrence is the one get() returns", dupesTable.get("AR-A") === "first", String(dupesTable.get("AR-A")));

const empties = fixture("empties.en_us.conf", table([["AR-A", ""], ["AR-B", "B"]]));
const emptiesTable = parseStringTable(readFileSync(empties), { name: "empties.en_us.conf" });
check(
  "empty text: a warning, not an error — the game ships three of them",
  emptiesTable.problems.length === 1 && emptiesTable.problems[0].severity === "warning" && emptiesTable.problems[0].message.includes("AR-A"),
  JSON.stringify(emptiesTable.problems),
);

const dangling = fixture("dangling.en_us.conf", 'StringTableRuntime {\n Ids {\n  "A"\n }\n Texts {\n  "a"\\\n }\n}\n');
const danglingTable = parseStringTable(readFileSync(dangling), { name: "dangling.en_us.conf" });
check(
  "dangling continuation: an error, because the next piece never comes",
  danglingTable.problems.some((p) => p.severity === "error" && p.message.includes("continuation marker")),
  JSON.stringify(danglingTable.problems),
);

// The one shape the installed corpus contains that does not parse: a `\"` where the closing quote
// should be. Refused at the opening quote of the string that never ends — line 6, column 3.
const brokenText = fixture("broken.uk_ua.conf", 'StringTableRuntime {\n Ids {\n  "AR-X"\n }\n Texts {\n  "broken\\"\n }\n}\n');

// --- names, specs, merging ---------------------------------------------------
check(
  "languageOfName: three spellings the game uses, and one it does not",
  languageOfName("Language/localization.ru_ru.conf") === "ru_ru" &&
    languageOfName("Language/ACE_Core_localization.de_de.conf") === "de_de" &&
    languageOfName("en_us.conf") === "en_us" &&
    languageOfName("Language/localization.conf") === null,
  [languageOfName("Language/localization.ru_ru.conf"), languageOfName("en_us.conf"), languageOfName("Language/localization.conf")].join(" / "),
);

check(
  "parseSourceSpec: <pak>:<entry>, a plain path, and the last colon wins",
  (() => {
    const pak = parseSourceSpec("/install/addons/data/data007.pak:Language/localization.ru_ru.conf");
    const plain = parseSourceSpec("/work/Localization/My_mod.en_us.conf");
    const colonInPak = parseSourceSpec("C:\\we:ird\\data.pak:Language/x.en_us.conf");
    return (
      pak.kind === "pak" && pak.pak.endsWith("data007.pak") && pak.entry === "Language/localization.ru_ru.conf" &&
      plain.kind === "file" && plain.path === "/work/Localization/My_mod.en_us.conf" &&
      colonInPak.pak === "C:\\we:ird\\data.pak" && colonInPak.entry === "Language/x.en_us.conf"
    );
  })(),
  JSON.stringify(parseSourceSpec("C:\\we:ird\\data.pak:Language/x.en_us.conf")),
);
check(
  "parseSourceSpec: a Windows path is a path — its only colon is the drive's",
  (() => {
    const r = parseSourceSpec("D:\\work\\localization.ru_ru.conf");
    return r.kind === "file" && r.path === "D:\\work\\localization.ru_ru.conf";
  })(),
  JSON.stringify(parseSourceSpec("D:\\work\\localization.ru_ru.conf")),
);
check(
  "parseSourceSpec: --no-pak-path-split never splits, even for a name that looks like an entry",
  (() => {
    const spec = "C:\\work\\data.pak:Language/x.en_us.conf";
    return parseSourceSpec(spec, { noPakPathSplit: true }).kind === "file" && parseSourceSpec(spec).kind === "pak";
  })(),
  JSON.stringify(parseSourceSpec("C:\\work\\data.pak:Language/x.en_us.conf", { noPakPathSplit: true })),
);
check(
  "parseSourceSpec: a pak with no entry is an error, not a path with a colon in it",
  (() => {
    try {
      parseSourceSpec("data007.pak:");
      return false;
    } catch (err) {
      return /<pak>:<entry>/.test(err.message);
    }
  })(),
);

const base = fixture("base.en_us.conf", table([["AR-A", "base A"], ["AR-B", "base B"]]));
const over = fixture("over.ru_ru.conf", table([["AR-A", "mod A"], ["AR-C", "mod C"]]));
const merged = new MergedStringTable(openStringTables([over, base]));
check("merge: the first source wins", merged.get("AR-A") === "mod A", String(merged.get("AR-A")));
check("merge: the union is what the table holds", merged.size === 3, String(merged.size));
check(
  "merge: an override keeps both texts",
  (() => {
    const row = merged.lookup("AR-A");
    return row.variants.length === 2 && row.variants[0].text === "mod A" && row.variants[1].text === "base A";
  })(),
  JSON.stringify(merged.lookup("AR-A")),
);
check("merge: overrides() counts every id named twice", merged.overrides().length === 1, String(merged.overrides().length));
check(
  "merge: conflicts() is the subset whose text differs",
  merged.conflicts().length === 1 && merged.conflicts()[0].id === "AR-A",
  JSON.stringify(merged.conflicts()),
);
check(
  "merge: a conflict is a warning, so `check` does not fail on a legitimate override",
  (() => {
    const p = merged.problems().filter((x) => x.severity === "warning" && x.message.includes("different text"));
    return p.length === 1 && p[0].message.includes("the first wins");
  })(),
  JSON.stringify(merged.problems()),
);

const cmp = compareStringTables(new MergedStringTable(openStringTables([base])), new MergedStringTable(openStringTables([over])));
check(
  "compare: only-in-A, only-in-B and differing are separated",
  cmp.onlyInA.length === 1 && cmp.onlyInA[0] === "AR-B" && cmp.onlyInB.length === 1 && cmp.onlyInB[0] === "AR-C" &&
    cmp.differing.length === 1 && cmp.differing[0].id === "AR-A" && cmp.same === 0,
  JSON.stringify(cmp),
);

// --- the CLI -----------------------------------------------------------------
//
// Exit codes follow `etconf` (0 success, 1 the input at fault, 2 the command line, 3 a `get` id
// that is not there): one reader answering 1 for everything forced a caller to parse English to
// tell "I called it wrong" from "the table is broken". The fixtures below pin that, and the
// `--json` failure envelope `{ok:false, error:{code, message, …}}` the other readers print.
{
  const { status, out } = runCli(["get", basic, "#AR-MapIcon_Tower", "AR-One"]);
  check("cli get: exits 0 and prints `id -> text`", status === 0 && out.includes("AR-MapIcon_Tower -> Tower") && out.includes("AR-One -> First"), out);
}
{
  const { status, err } = runCli(["get", basic, "AR-Nope"]);
  check("cli get: a missing id exits 3 and names the key on stderr", status === 3 && err.includes("AR-Nope"), `status ${status} / ${err}`);
}
{
  const { status, out } = runCli(["get", basic, "#AR-Nope", "--json"]);
  const json = JSON.parse(out);
  check(
    "cli get --json: a miss is an answer, not a failure — the envelope still comes back, with found: false",
    status === 3 && json.entries[0].found === false && json.missing === 1,
    out.slice(0, 200),
  );
}
{
  const { status, err } = runCli(["get", basic, "AR-Nope", "--missing-ok"]);
  check("cli get --missing-ok: exits 0", status === 0, `status ${status} / ${err}`);
}
{
  const { status, out } = runCli(["get", basic, "#AR-Two", "--json"]);
  const json = JSON.parse(out);
  check(
    "cli get --json: an envelope with the sources, not a bare array",
    status === 0 && json.total === 3 && json.returned === 1 && json.entries[0].id === "AR-Two" && json.sources[0].entries === 3,
    out.slice(0, 200),
  );
}
{
  const { out } = runCli(["list", many, "--json"]);
  const json = JSON.parse(out);
  check(
    "cli list: the default stops at 100 and says so",
    json.total === 150 && json.returned === 100 && json.truncated === true,
    `total ${json.total} returned ${json.returned} truncated ${json.truncated}`,
  );
}
{
  const { out } = runCli(["list", many, "--limit", "0"]);
  const lines = out.trim().split("\n");
  check("cli list --limit 0: every row, and no truncation note", lines.length === 150 && !out.includes("use --limit 0"), `${lines.length} lines`);
}
{
  const { out } = runCli(["find", basic, "tower"]);
  check("cli find: a text match, case-insensitively", out.includes("AR-MapIcon_Tower -> Tower"), out);
}
{
  const { out } = runCli(["find", basic, "Two", "--in", "id"]);
  check("cli find --in id: the query is matched against ids only", out.includes("AR-Two -> Second") && !out.includes("Tower"), out);
}
{
  const { status, out } = runCli(["find", basic, "no-such-thing"]);
  check("cli find: a miss is reported, and is not a failure", status === 0 && out.includes("no id or text matches"), out);
}
{
  const { out } = runCli(["diff", base, over, "--json"]);
  const json = JSON.parse(out);
  check(
    "cli diff --json: the three lists with their counts",
    json.counts.a === 2 && json.counts.b === 2 && json.onlyInA.total === 1 && json.onlyInB.total === 1 && json.differing.total === 1,
    out.slice(0, 300),
  );
}
{
  const { status, err } = runCli(["diff", base, over, basic]);
  check(
    "cli diff: a third source is refused, not silently dropped",
    status === 2 && err.includes("exactly two sources") && err.includes("3 were given"),
    `status ${status} / ${err}`,
  );
}
{
  const { status, out } = runCli(["check", basic]);
  check("cli check: a clean table is OK and exits 0", status === 0 && out.includes("OK    "), out);
}
{
  const { status, out } = runCli(["check", dupes]);
  check("cli check: a duplicate id fails, with the line numbers", status === 1 && out.includes("FAIL") && out.includes("duplicate id"), out);
}
{
  const { status, out } = runCli(["check", empties]);
  check("cli check: an empty text warns but does not fail", status === 0 && out.includes("[warning]"), out);
}
{
  const { status, out } = runCli(["list", basic, "--nope"]);
  check("cli: an unknown option is refused, not ignored", status === 2 && out === "", `status ${status}`);
}
{
  const { status, err } = runCli(["list", basic, "--in", "id"]);
  check("cli: an option of another command is refused, not ignored", status === 2 && err.includes("list does not take --in"), err);
}
{
  const { status, out } = runCli(["get", basic, "#AR-Two", "--no-pak-path-split"]);
  check("cli --no-pak-path-split: accepted by every command, and a real file still reads", status === 0 && out.includes("#AR-Two -> Second"), out);
}
{
  const { status, err } = runCli(["get", basic, "#AR-Two", "--no-pak"]);
  check("cli: the old --no-pak is no longer an option, and is refused by name", status === 2 && err.includes("unknown option"), err);
}
{
  const { status, err } = runCli(["find", basic, "x", "--in", "everywhere"]);
  check("cli: a bad --in value is refused", status === 2 && err.includes("id, text or both"), err);
}
{
  const { status, err } = runCli(["get", basic]);
  check("cli: get without an id explains itself", status === 2 && err.includes("get needs a source and at least one id"), err);
}
{
  const { status, out } = runCli(["info", over, base, "--json"]);
  const json = JSON.parse(out);
  check(
    "cli info --json: both sources, their languages, and the merge",
    json.sources.length === 2 && json.sources[0].language === "ru_ru" && json.sources[1].language === "en_us" &&
      json.total === 3 && json.overrides === 1,
    out.slice(0, 300),
  );
}

// --- the three shapes that used to mislead a caller ---------------------------
{
  // `sources[].problems` was a count in four commands and a list in two. It is a count everywhere
  // now, and the list has its own name.
  const { out: checkOut } = runCli(["check", empties, "--json"]);
  const checkJson = JSON.parse(checkOut);
  const { out: listOut } = runCli(["list", empties, "--json"]);
  const listJson = JSON.parse(listOut);
  check(
    "json: `problems` is a number in every command, and the list is `problemList`",
    checkJson.problems === 1 && Array.isArray(checkJson.problemList) && checkJson.problemList.length === 1 &&
      typeof checkJson.sources[0].problems === "number" && Array.isArray(checkJson.sources[0].problemList) &&
      listJson.sources[0].problems === 1 && listJson.sources[0].problemList === undefined,
    `${JSON.stringify(checkJson.sources[0])} / ${JSON.stringify(listJson.sources[0])}`,
  );
}
{
  // --raw used to *replace* `text` under --json, so adding it quietly changed what `text` meant.
  const { out } = runCli(["get", escaped, "AR-Newline", "--raw", "--json"]);
  const entry = JSON.parse(out).entries[0];
  check(
    "json: --raw adds `raw` and leaves `text` decoded",
    entry.text === "line one\nline two" && entry.raw === "line one\\nline two",
    JSON.stringify(entry),
  );
}
{
  const { status, out } = runCli(["check", escaped, "--json", "--compact"]);
  check(
    "cli --compact: one JSON line, and it implies --json",
    status === 0 && out.trim().split("\n").length === 1 && JSON.parse(out).ok === true,
    out.slice(0, 120),
  );
}

// --- a failure a program can read --------------------------------------------
{
  const { status, out } = runCli(["check", brokenText, "--json"]);
  const json = JSON.parse(out);
  check(
    "cli --json: a parse failure is { ok: false, error: { code: PARSE, source, line, column } } on stdout",
    status === 1 && json.ok === false && json.error.code === "PARSE" && json.error.source === brokenText &&
      json.error.line === 6 && json.error.column === 3,
    out,
  );
}
{
  const { status, out } = runCli(["list", basic, "--nope", "--json"]);
  const json = JSON.parse(out);
  check(
    "cli --json: a bad command line is code USAGE and exits 2",
    status === 2 && json.ok === false && json.error.code === "USAGE",
    out,
  );
}
{
  const { status, out } = runCli(["info", tmp, "--json"]);
  const json = JSON.parse(out);
  check(
    "cli --json: a directory is refused with an actionable hint, not a bare EISDIR",
    status === 1 && json.error.code === "IO" && /directory is not a source/.test(json.error.message) &&
      /pak\.mjs find/.test(json.error.hint ?? ""),
    out,
  );
}

// --- one bad table must not hide the rest ------------------------------------
{
  const { status, out } = runCli(["check", basic, brokenText, "--lenient"]);
  check(
    "cli check --lenient: the table that cannot be read is a FAIL line, the other is still checked",
    status === 1 && out.includes("FAIL  ") && out.includes("basic.en_us.conf: 3 entries") && out.includes("unterminated string"),
    out,
  );
}
{
  const { status, out } = runCli(["check", basic, brokenText, "--lenient", "--json"]);
  const json = JSON.parse(out);
  check(
    "cli check --lenient --json: the skipped source is in parseFailures, and the answer still has its counts",
    status === 1 && json.ok === false && json.parseFailures.length === 1 && json.sources.length === 1 && json.total === 3,
    out.slice(0, 400),
  );
}
{
  const { status, err } = runCli(["check", basic, brokenText]);
  check(
    "cli check: without --lenient the first unreadable source ends the run, as before",
    status === 1 && err.includes("unterminated string"),
    err,
  );
}
{
  const { status, err } = runCli(["get", basic, "AR-One", "--lenient"]);
  check(
    "cli: --lenient belongs to the surveying commands, and says so when it is asked of get",
    status === 2 && err.includes("--lenient is for the commands that read many sources"),
    err,
  );
}

// --- two ways of saying the same thing are refused ---------------------------
{
  const { status, err } = runCli(["list", many, "--all", "--limit", "5"]);
  check(
    "cli: --all and --limit together are refused rather than silently resolved",
    status === 2 && err.includes("contradict each other"),
    err,
  );
}

rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL LOCALIZATION TESTS PASSED" : failures + " LOCALIZATION TEST(S) FAILED"}`);
process.exit(failures ? 1 : 0);
