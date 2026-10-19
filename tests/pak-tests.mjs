// Test suite for tools/pak.mjs (the PAC1 archive reader).
//
//   node tests/pak-tests.mjs
//
// The fixtures are built here byte by byte, so the suite pins the container
// layout itself rather than a captured archive: a synthetic pak is the only way
// to assert both offset bases without shipping 2 GB of game data.
//
// What it exists to prevent: reading entry payloads relative to the DATA chunk
// body instead of from the start of the file. That 56-byte error is invisible on
// stored entries (it silently shifts the bytes) and fatal on compressed ones
// (`incorrect header check`), and it is what earlier versions of the pak tool
// did. `offset base` cases below fail if that regression ever comes back.
//
// The CLI is exercised as a real child process with stdio ignored and results
// written to files, so it keeps working in sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  openPak, detectOffsetBase, verifyPak, compressionName, describeUnusablePath,
  findTarget, entriesUnder,
} from "../tools/pak.mjs";
// The writer these fixtures are built with: one copy, in tests/helpers/, because `ebin-tests.mjs`
// now needs an archive of its own to read an EBIN resource out of.
import { buildPak } from "./helpers/pak-builder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "pak.mjs");
const tmp = join(root, "tests", ".tmp-pak");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) {
    console.log(`OK    ${what}`);
  } else {
    failures++;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

const CONFIG_TEXT = "TXOCommonClass {\n  Width 1024\n}\n";
const SCRIPT_TEXT = `void main()\n{\n  Print("hello from a synthetic pak");\n}\n`.repeat(4);
const files = [
  { path: "configs/thing.conf", data: CONFIG_TEXT },
  { path: "scripts/Core/thing.c", data: SCRIPT_TEXT, compress: true },
  { path: "readme.txt", data: "plain\n" },
];
const goodPath = join(tmp, "good.pak");
writeFileSync(goodPath, buildPak(files));
const legacyPath = join(tmp, "data-relative.pak");
writeFileSync(legacyPath, buildPak(files, { absoluteOffsets: false }));

// Vanilla archives nest real directories whose names start with a dot
// (`worlds/GameMaster/Navmeshes/.NavData/...`), so one fixture carries them.
const DOTTED = "NTILE".repeat(8);
const dottedPak = join(tmp, "dotted.pak");
writeFileSync(dottedPak, buildPak([
  { path: "scripts/.NavData/GM_Eden/navData_1.ntile", data: DOTTED, compress: true },
  { path: "audio/.hidden/note.ogg", data: "OGG" },
]));

// A needle in three entries: `find`'s cap is only observable when more than one
// entry matches, and `list`'s when the cap is smaller than the index.
const FINDABLE = "MARKER";
const findablePak = join(tmp, "findable.pak");
writeFileSync(findablePak, buildPak([
  { path: "a/one.txt", data: `${FINDABLE} one\n` },
  { path: "b/two.txt", data: `${FINDABLE} two\n` },
  { path: "c/three.txt", data: `${FINDABLE} three\n` },
]));

// --- the library -----------------------------------------------------------

{
  const pak = openPak(goodPath);
  try {
    check("tree: three files under three paths", pak.entries.length === 3, `got ${pak.entries.length}`);
    check("paths carry no leading slash",
      pak.entries.every((e) => !e.path.startsWith("/")),
      pak.entries.map((e) => e.path).join(", "));
    check("nested paths use forward slashes",
      pak.entries.some((e) => e.path === "scripts/Core/thing.c"));

    const stored = pak.entries.find((e) => e.path === "configs/thing.conf");
    check("stored entry is byte-exact",
      pak.read(stored).toString("utf8") === CONFIG_TEXT);

    const compressed = pak.entries.find((e) => e.path === "scripts/Core/thing.c");
    check("compressed entry inflates to the indexed length",
      pak.read(compressed).toString("utf8") === SCRIPT_TEXT,
      `${compressed.storedLength} -> ${pak.read(compressed).length}, index says ${compressed.originalLength}`);
    check("compressed entry reports its compression",
      compressionName(compressed.compressionType) === "zlib");

    check("offset base detected as absolute", detectOffsetBase(pak).base === "absolute");
    const { problems } = verifyPak(pak, { sample: 10 });
    check("verify finds no problems in a well-formed archive", problems.length === 0, problems.join("; "));

    check("the index exposes its directories, root excluded",
      pak.dirs.map((d) => d.path).join(", ") === "configs, scripts, scripts/Core",
      pak.dirs.map((d) => d.path).join(", "));
    check("findTarget resolves a directory and says so",
      findTarget(pak, "scripts/Core").kind === "dir");
    check("findTarget resolves a file and says so",
      findTarget(pak, "readme.txt").kind === "file");
    check("entriesUnder lists a subtree only",
      entriesUnder(pak, "scripts").map((e) => e.path).join(", ") === "scripts/Core/thing.c",
      entriesUnder(pak, "scripts").map((e) => e.path).join(", "));
  } finally {
    pak.close();
  }
}

{
  // The regression this suite exists for: with the payloads 56 bytes further
  // along, reading from the start of the file returns the wrong bytes -- exactly
  // the defect that produced `incorrect header check`.
  const pak = openPak(legacyPath);
  try {
    check("legacy layout is detected as data-relative", detectOffsetBase(pak).base === "data-relative");
    const compressed = pak.entries.find((e) => e.path === "scripts/Core/thing.c");
    let threw = null;
    try { pak.read(compressed); } catch (err) { threw = err; }
    check("legacy layout: absolute read fails with a diagnostic that names the cause",
      threw !== null && /did not inflate/.test(threw.message) && /verify/.test(threw.message),
      threw ? threw.message : "no error thrown");
    check("legacy layout: --data-relative reads it correctly",
      pak.read(compressed, { dataRelative: true }).toString("utf8") === SCRIPT_TEXT);
    const { problems } = verifyPak(pak, { sample: 10, dataRelative: true });
    check("legacy layout: verify with the matching base is clean", problems.length === 0, problems.join("; "));
  } finally {
    pak.close();
  }
}

{
  const unknownPath = join(tmp, "unknown-compression.pak");
  writeFileSync(unknownPath, buildPak([
    { path: "odd.bin", data: "not really compressed", compressionType: 0x999 },
  ]));
  const pak = openPak(unknownPath);
  try {
    const entry = pak.entries[0];
    let threw = null;
    try { pak.read(entry); } catch (err) { threw = err; }
    check("unknown compression rejects rather than guesses",
      threw !== null && /0x999/.test(threw.message) && /--raw/.test(threw.message),
      threw ? threw.message : "no error thrown");
    check("unknown compression: --raw still yields the stored bytes",
      pak.read(entry, { raw: true }).toString("utf8") === "not really compressed");
  } finally {
    pak.close();
  }
}

{
  // A truncated FILE chunk must be reported, not silently half-parsed.
  const buf = buildPak(files);
  const bad = join(tmp, "truncated.pak");
  writeFileSync(bad, buf.subarray(0, buf.length - 8));
  let threw = null;
  try { openPak(bad).close(); } catch (err) { threw = err; }
  check("a FILE chunk that runs past the end of the file is reported",
    threw !== null && /truncated/.test(threw.message), threw ? threw.message : "no error thrown");
}

// --- the CLI ---------------------------------------------------------------

function run(args) {
  return spawnSync(process.execPath, [tool, ...args], { stdio: "ignore" });
}

/** The same, with stdout+stderr written to a file: sandboxes forbid piped stdio. */
function runLogged(args, logPath) {
  const fd = openSync(logPath, "w");
  try {
    return spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", fd, fd] });
  } finally {
    closeSync(fd);
  }
}

/** The same, with stdout only: a JSON answer must not be mixed with diagnostics. */
function runStdout(args, outPath) {
  const fd = openSync(outPath, "w");
  try {
    return spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", fd, "ignore"] });
  } finally {
    closeSync(fd);
  }
}

{
  const out = join(tmp, "thing.c");
  const proc = run(["get", goodPath, "scripts/Core/thing.c", out]);
  check("get exits 0", proc.status === 0, `status ${proc.status}`);
  check("get writes the decompressed bytes",
    existsSync(out) && readFileSync(out).toString("utf8") === SCRIPT_TEXT);

  const rawOut = join(tmp, "thing.raw");
  const rawProc = run(["get", goodPath, "scripts/Core/thing.c", rawOut, "--raw"]);
  const rawBytes = existsSync(rawOut) ? readFileSync(rawOut) : Buffer.alloc(0);
  check("get --raw exits 0 and writes the compressed bytes", rawProc.status === 0 && rawBytes.length > 0 &&
    rawBytes.length < SCRIPT_TEXT.length && rawBytes[0] === 0x78);

  const missing = run(["get", goodPath, "scripts/Core/nope.c", join(tmp, "nope.c")]);
  check("get of an absent entry exits 1", missing.status === 1, `status ${missing.status}`);

  check("verify exits 0 on a well-formed archive", run(["verify", goodPath]).status === 0);
  check("verify exits 1 on a data-relative archive", run(["verify", legacyPath]).status === 1);
  check("verify exits 0 on a data-relative archive read with --data-relative",
    run(["verify", legacyPath, "--data-relative"]).status === 0);
  check("info exits 0", run(["info", goodPath]).status === 0);
  check("tree exits 0", run(["tree", goodPath]).status === 0);
  check("an unknown command exits 1", run(["frobnicate", goodPath]).status === 1);
  check("a file that is not a pak exits 1", run(["info", join(root, "package.json")]).status === 1);

  const namedOut = join(tmp, "named.conf");
  const namedLog = join(tmp, "named.log");
  runLogged(["get", goodPath, "configs/thing.conf", namedOut], namedLog);
  check("get reports the resolved destination it wrote to",
    readFileSync(namedLog, "utf8").includes(resolve(namedOut)),
    readFileSync(namedLog, "utf8").trim());
}

// --- --limit: 0 and --all mean "every one", and a bad value is refused ------
//
// The defect this section exists for: `--limit 0` reached `slice(0, 0)`, so the
// command printed its header and no rows and `--json` answered `[]` -- which a
// caller cannot tell from "nothing matched". Every other reader in this
// repository treats 0 as "no cap", and a misspelt or sign-prefixed value used to
// travel on as NaN or -1 instead of being refused.

/** The data rows of a `list` log: no header line, no `#` footer. */
function listRows(text) {
  return text.trim().split("\n").slice(1).filter((l) => l && !l.startsWith("#"));
}

/** The `HIT` lines of a `find` log. */
function hitLines(text) {
  return text.split("\n").filter((l) => l.startsWith("HIT "));
}

{
  const log = (name) => join(tmp, `limit-${name}.log`);

  const all = log("zero");
  const allProc = runLogged(["list", goodPath, "--limit", "0"], all);
  const allText = readFileSync(all, "utf8");
  check("list --limit 0 exits 0", allProc.status === 0, `status ${allProc.status}`);
  check("list --limit 0 prints every entry, not none",
    listRows(allText).length === 3, allText.trim());
  check("list --limit 0 prints no truncation footer", !/use --limit 0/.test(allText), allText.trim());

  const allJson = log("zero-json");
  runLogged(["list", goodPath, "--limit", "0", "--json"], allJson);
  let parsed = null;
  try { parsed = JSON.parse(readFileSync(allJson, "utf8")); } catch { /* reported below */ }
  check("list --limit 0 --json is the whole index, not []",
    parsed?.archives?.[0]?.rows?.length === 3,
    parsed ? `${parsed.archives?.[0]?.rows?.length} rows` : "not JSON");
  check("a JSON list answer carries the counts a caller needs",
    parsed?.archives?.[0]?.entries === 3 && parsed?.archives?.[0]?.total === 3 &&
      parsed?.archives?.[0]?.truncated === false && parsed?.total === 3,
    JSON.stringify(parsed?.archives?.[0] ?? null));

  const allAlias = log("all");
  runLogged(["list", goodPath, "--all"], allAlias);
  check("list --all is --limit 0",
    listRows(readFileSync(allAlias, "utf8")).length === 3, readFileSync(allAlias, "utf8").trim());

  const capped = log("two");
  runLogged(["list", goodPath, "--limit", "2"], capped);
  const cappedText = readFileSync(capped, "utf8");
  check("list --limit 2 prints two rows",
    listRows(cappedText).length === 2, cappedText.trim());
  check("a capped list says how many matched and how many it showed",
    /# 3 row\(s\), 2 shown/.test(cappedText) && /--limit 0/.test(cappedText), cappedText.trim());

  const cappedJson = log("two-json");
  runLogged(["list", goodPath, "--limit", "2", "--json"], cappedJson);
  const twoRows = JSON.parse(readFileSync(cappedJson, "utf8"));
  check("--json obeys the same cap as the text form",
    twoRows.archives[0].rows.length === 2 && twoRows.archives[0].truncated === true,
    JSON.stringify(twoRows.archives[0]));

  // Paging: `--from` says which row to start at, and the footer names the next page.
  const paged = log("from");
  runLogged(["list", goodPath, "--from", "1", "--limit", "1"], paged);
  const pagedText = readFileSync(paged, "utf8");
  check("--from skips rows and the footer names the next page",
    listRows(pagedText).length === 1 && /from 1/.test(pagedText) && /--from 2/.test(pagedText),
    pagedText.trim());

  const findAll = log("find-zero");
  runLogged(["find", findablePak, FINDABLE, "--limit", "0"], findAll);
  const findAllText = readFileSync(findAll, "utf8");
  check("find --limit 0 reports every hit",
    hitLines(findAllText).length === 3 &&
      /# scanned 3, skipped 0 \(0 empty, 0 oversized, 0 unreadable\), hits 3/.test(findAllText),
    findAllText.trim());

  const findCapped = log("find-two");
  runLogged(["find", findablePak, FINDABLE, "--limit", "2"], findCapped);
  const findCappedText = readFileSync(findCapped, "utf8");
  check("find --limit 2 stops after two hits and says it stopped",
    hitLines(findCappedText).length === 2 && /stopped at the --limit 2 cap/.test(findCappedText),
    findCappedText.trim());

  // A value the tool cannot mean is a usage error, not a silently empty list.
  for (const [label, value, pattern] of [
    ["a sign", "-1", /non-negative whole number/],
    ["a word", "abc", /non-negative whole number/],
  ]) {
    const bad = log(`bad-${label.replace(/\W/g, "")}`);
    const proc = runLogged(["list", goodPath, "--limit", value], bad);
    const text = readFileSync(bad, "utf8");
    check(`--limit ${value} (${label}) exits 1 and names the rule`,
      proc.status === 1 && pattern.test(text), text.trim());
  }

  const missing = log("missing");
  const missingProc = runLogged(["list", goodPath, "--limit"], missing);
  check("--limit with no value exits 1 and says so",
    missingProc.status === 1 && /--limit needs a value/.test(readFileSync(missing, "utf8")),
    readFileSync(missing, "utf8").trim());

  const unknown = log("unknown");
  const unknownProc = runLogged(["list", goodPath, "--jsom"], unknown);
  const unknownText = readFileSync(unknown, "utf8");
  check("a misspelt option is refused instead of becoming the path regex",
    unknownProc.status === 1 && /unknown option "--jsom"/.test(unknownText), unknownText.trim());
}

// --- text: `find` decodes entries, `cat` reads lines ------------------------
//
// The defect this section exists for: `find` encoded the needle as Latin-1
// (`Buffer.from(needle, "latin1")`), so a needle with a character above U+00FF
// became a byte that cannot occur and the answer was always "0 hits" -- a false
// negative an agent has no way to notice. The entries are decoded as UTF-8 when
// they are UTF-8, and Latin-1 otherwise, and the hit reports line and column.
{
  const UTF8_TEXT = 'Id "#AR-Test" "Привет, мир"\nsecond line\n';
  const utf8Pak = join(tmp, "utf8.pak");
  writeFileSync(utf8Pak, buildPak([
    { path: "Language/localization.ru_ru.conf", data: UTF8_TEXT, compress: true },
  ]));
  const колонка = UTF8_TEXT.indexOf("Привет") + 1;

  const log = join(tmp, "find-utf8.log");
  runLogged(["find", utf8Pak, "Привет"], log);
  const text = readFileSync(log, "utf8");
  check("find matches a UTF-8 needle", hitLines(text).length === 1, text.trim());
  check("find reports the line and column of the hit",
    new RegExp(`line 1:${колонка}\\b`).test(text), text.trim());
  check("find prints the matched line, not dots in place of the text",
    /Привет, мир/.test(text), text.trim());

  const jsonLog = join(tmp, "find-json.log");
  runLogged(["find", utf8Pak, "мир", "--json"], jsonLog);
  const findJson = JSON.parse(readFileSync(jsonLog, "utf8"));
  const hit = findJson.archives[0].hits[0];
  check("find --json carries path, line, column, byte offset and the line",
    findJson.archives[0].hits.length === 1 && hit.line === 1 &&
      hit.column === UTF8_TEXT.indexOf("мир") + 1 &&
      hit.offset === Buffer.byteLength(UTF8_TEXT.slice(0, UTF8_TEXT.indexOf("мир")), "utf8") &&
      /Привет, мир/.test(hit.text),
    JSON.stringify(hit));
  check("find --json reports the file and the needle it searched for",
    findJson.archives[0].file === utf8Pak && findJson.archives[0].needle === "мир" &&
      findJson.archives[0].totalExact === true,
    JSON.stringify(findJson.archives[0]));

  const regexLog = join(tmp, "find-regex.log");
  runLogged(["find", utf8Pak, "При.ет", "--regex"], regexLog);
  check("find --regex matches a pattern", hitLines(readFileSync(regexLog, "utf8")).length === 1,
    readFileSync(regexLog, "utf8").trim());

  const caseLog = join(tmp, "find-case.log");
  runLogged(["find", utf8Pak, "привет"], caseLog);
  check("find is case-sensitive by default", hitLines(readFileSync(caseLog, "utf8")).length === 0,
    readFileSync(caseLog, "utf8").trim());

  const icLog = join(tmp, "find-ic.log");
  runLogged(["find", utf8Pak, "ПРИВЕТ", "--ignore-case"], icLog);
  check("find --ignore-case matches what the default does not",
    hitLines(readFileSync(icLog, "utf8")).length === 1, readFileSync(icLog, "utf8").trim());

  const badRegex = join(tmp, "find-bad-regex.log");
  const badProc = runLogged(["find", utf8Pak, "(", "--regex"], badRegex);
  check("an invalid regex is a usage error that names the option",
    badProc.status === 1 && /--?needle|needle/.test(readFileSync(badRegex, "utf8")),
    readFileSync(badRegex, "utf8").trim());

  // A needle that begins with a hyphen would otherwise be read as an option; `--`
  // ends the options, the way every POSIX tool spells it.
  const dashPak = join(tmp, "dash.pak");
  writeFileSync(dashPak, buildPak([{ path: "counter.c", data: "int i = 5;\nwhile (i-- > 0) {}\n" }]));
  const dashLog = join(tmp, "find-dash.log");
  runLogged(["find", dashPak, "--", "--"], dashLog);
  check("find -- finds a needle that begins with a hyphen",
    hitLines(readFileSync(dashLog, "utf8")).length === 1, readFileSync(dashLog, "utf8").trim());

  const extraLog = join(tmp, "find-extra.log");
  const extraProc = runLogged(["find", dashPak, "--", "--", "--limit", "2"], extraLog);
  check("a word the command has no place for is refused, not ignored",
    extraProc.status === 1 && /has no place for "--limit 2"/.test(readFileSync(extraLog, "utf8")),
    readFileSync(extraLog, "utf8").trim());

  // cat: the bytes by default, numbered lines when a range is asked for.
  const catRaw = join(tmp, "cat-raw.bin");
  runLogged(["cat", goodPath, "readme.txt"], catRaw);
  check("cat prints the bytes unchanged", readFileSync(catRaw, "utf8") === "plain\n",
    JSON.stringify(readFileSync(catRaw, "utf8")));

  const catStored = join(tmp, "cat-stored.bin");
  runLogged(["cat", goodPath, "scripts/Core/thing.c", "--raw"], catStored);
  const storedBytes = readFileSync(catStored);
  check("cat --raw still prints the stored bytes",
    storedBytes.length > 0 && storedBytes.length < SCRIPT_TEXT.length && storedBytes[0] === 0x78,
    `${storedBytes.length} bytes, first 0x${storedBytes[0]?.toString(16)}`);

  const catRange = join(tmp, "cat-range.log");
  runLogged(["cat", utf8Pak, "Language/localization.ru_ru.conf", "2"], catRange);
  const catRangeText = readFileSync(catRange, "utf8");
  check("cat <lines> prints that line numbered", /2\tsecond line/.test(catRangeText) &&
    /line 2 of 2/.test(catRangeText), catRangeText.trim());

  const catWhole = join(tmp, "cat-whole.log");
  runLogged(["cat", utf8Pak, "Language/localization.ru_ru.conf", "--numbers"], catWhole);
  check("cat --numbers numbers the whole entry",
    /1\tId "#AR-Test"/.test(readFileSync(catWhole, "utf8")), readFileSync(catWhole, "utf8").trim());

  const catJson = join(tmp, "cat-json.log");
  runLogged(["cat", utf8Pak, "Language/localization.ru_ru.conf", "--json"], catJson);
  const cat = JSON.parse(readFileSync(catJson, "utf8"));
  check("cat --json carries the lines with their numbers",
    cat.fileLines === 2 && cat.lines.length === 2 && cat.lines[1].line === 2 &&
      cat.lines[1].text === "second line",
    JSON.stringify(cat.lines));

  const catBad = join(tmp, "cat-bad-range.log");
  const catBadProc = runLogged(["cat", utf8Pak, "Language/localization.ru_ru.conf", "5-1"], catBad);
  check("a backwards line range is a usage error",
    catBadProc.status === 1 && /ends before it starts/.test(readFileSync(catBad, "utf8")),
    readFileSync(catBad, "utf8").trim());
}

// --- tree: bounded, and machine-readable ------------------------------------
{
  const text = join(tmp, "tree-text.log");
  runLogged(["tree", goodPath], text);
  const treeText = readFileSync(text, "utf8");
  check("tree prints a directory before its children",
    /^configs\/\nconfigs\/ thing\.conf/m.test(treeText), treeText.trim());

  const capped = join(tmp, "tree-capped.log");
  runLogged(["tree", goodPath, "--limit", "2"], capped);
  const cappedText = readFileSync(capped, "utf8");
  check("tree --limit caps the lines and says so",
    cappedText.trim().split("\n").filter((l) => !l.startsWith("#")).length === 2 &&
      /use --limit 0 for every one/.test(cappedText),
    cappedText.trim());

  const shallow = join(tmp, "tree-depth.log");
  runLogged(["tree", goodPath, "--depth", "1"], shallow);
  const shallowText = readFileSync(shallow, "utf8");
  // `scripts/Core/thing.c` is two levels down; `configs/thing.conf` is one, so it
  // is still there. Testing for "thing.c" alone would match "thing.conf" too.
  check("tree --depth stops before the entries below",
    /scripts\/ Core\//.test(shallowText) && !/Core\/ thing\.c/.test(shallowText) &&
      /configs\/ thing\.conf/.test(shallowText),
    shallowText.trim());

  const json = join(tmp, "tree.json");
  runLogged(["tree", goodPath, "--json"], json);
  const parsed = JSON.parse(readFileSync(json, "utf8"));
  const names = parsed.tree.children.map((c) => c.name).sort().join(",");
  check("tree --json is a real tree with the counts a caller needs",
    names === "configs,readme.txt,scripts" && parsed.total === 6 &&
      parsed.returned === 6 && parsed.truncated === false && parsed.file === goodPath,
    JSON.stringify({ names, total: parsed.total, returned: parsed.returned }));
}

// --- get: a subset, and a plan before writing ------------------------------
{
  const dryDest = join(tmp, "dry-out");
  const dryLog = join(tmp, "get-dry.log");
  const dryProc = runLogged(["get", goodPath, "scripts", dryDest, "--dry-run"], dryLog);
  check("get --dry-run writes nothing",
    dryProc.status === 0 && !existsSync(dryDest), readFileSync(dryLog, "utf8").trim());
  check("get --dry-run says what it would write",
    /would be written/.test(readFileSync(dryLog, "utf8")), readFileSync(dryLog, "utf8").trim());

  const onlyConf = join(tmp, "only-conf");
  const filterLog = join(tmp, "get-filter.log");
  runLogged(["get", goodPath, "/", onlyConf, "--path-regex", "\\.conf$"], filterLog);
  check("get --path-regex extracts only the matching entries",
    existsSync(join(onlyConf, "configs", "thing.conf")) && !existsSync(join(onlyConf, "readme.txt")),
    readFileSync(filterLog, "utf8").trim());

  const noneLog = join(tmp, "get-none.log");
  const noneProc = runLogged(["get", goodPath, "/", join(tmp, "none"), "--path-regex", "\\.absent$"], noneLog);
  check("a filter that matches nothing fails and names the count",
    noneProc.status === 1 && /matched none of the 3/.test(readFileSync(noneLog, "utf8")),
    readFileSync(noneLog, "utf8").trim());

  const getJson = join(tmp, "get.json");
  runLogged(["get", goodPath, "configs", join(tmp, "json-out"), "--json"], getJson);
  const plan = JSON.parse(readFileSync(getJson, "utf8"));
  check("get --json lists what it wrote, with the destination",
    plan.files.length === 1 && plan.files[0].path === "configs/thing.conf" &&
      plan.files[0].written === true && plan.dest === resolve(join(tmp, "json-out")),
    JSON.stringify(plan.files));

  const getFiltered = join(tmp, "get-filtered.json");
  runLogged(["get", goodPath, "/", join(tmp, "filtered"), "--path-regex", "\\.conf$", "--json"], getFiltered);
  const narrowed = JSON.parse(readFileSync(getFiltered, "utf8"));
  check("get --json says how much the filter narrowed, without calling it truncation",
    narrowed.entries === 3 && narrowed.total === 1 && narrowed.returned === 1 &&
      narrowed.truncated === false && narrowed.filter === "\\.conf$",
    JSON.stringify({ entries: narrowed.entries, total: narrowed.total, truncated: narrowed.truncated }));
}

// --- verify: an answer a script can gate on --------------------------------
{
  const json = join(tmp, "verify.json");
  runLogged(["verify", goodPath, "--json"], json);
  const parsed = JSON.parse(readFileSync(json, "utf8"));
  check("verify --json reports ok, the base and the sample",
    parsed.archives[0].ok === true && parsed.archives[0].offsetBase.base === "absolute" &&
      parsed.archives[0].sample.sampled >= 1 && parsed.archives[0].problemCount === 0,
    JSON.stringify(parsed.archives[0]));
  check("verify --json still exits 1 when the archive is broken",
    run(["verify", legacyPath, "--json"]).status === 1);
}

// --- one call over a folder of archives ------------------------------------
{
  const folder = join(tmp, "addons");
  mkdirSync(join(folder, "nested"), { recursive: true });
  writeFileSync(join(folder, "a.pak"), buildPak([{ path: "one.txt", data: "alpha MARKER\n" }]));
  writeFileSync(join(folder, "nested", "b.pak"), buildPak([{ path: "two.txt", data: "beta MARKER\n" }]));

  const listJson = join(tmp, "folder-list.json");
  runLogged(["list", folder, "--limit", "0", "--json"], listJson);
  const listed = JSON.parse(readFileSync(listJson, "utf8"));
  check("a folder lists every archive under it, recursively",
    listed.archives.length === 2 && listed.archives.every((a) => a.rows.length === 1) && listed.total === 2,
    JSON.stringify(listed.archives.map((a) => a.file)));

  const findLog = join(tmp, "folder-find.log");
  runLogged(["find", folder, "MARKER"], findLog);
  const findText = readFileSync(findLog, "utf8");
  check("find over a folder names the archive of each hit",
    hitLines(findText).length === 2 && /# .*a\.pak/.test(findText) && /# .*b\.pak/.test(findText),
    findText.trim());

  const verifyJson = join(tmp, "folder-verify.json");
  runLogged(["verify", folder, "--json"], verifyJson);
  const verified = JSON.parse(readFileSync(verifyJson, "utf8"));
  check("verify over a folder reports every archive",
    verified.archives.length === 2 && verified.archives.every((a) => a.ok), JSON.stringify(verified.archives));

  const infoJson = join(tmp, "info.json");
  runLogged(["info", goodPath, "--json"], infoJson);
  const info = JSON.parse(readFileSync(infoJson, "utf8"));
  check("info --json names the file and its size",
    info.file === goodPath && info.bytes > 0 && info.entries === 3, JSON.stringify({ file: info.file }));

  check("a command that needs one archive refuses a folder",
    run(["info", folder]).status === 1);
  check("get refuses a folder of archives",
    run(["get", folder, "configs", join(tmp, "nope")]).status === 1);
}

// --- one unreadable archive must not swallow the others --------------------
{
  const mixed = join(tmp, "mixed");
  mkdirSync(mixed, { recursive: true });
  writeFileSync(join(mixed, "a.pak"), buildPak([{ path: "one.txt", data: "alpha MARKER\n" }]));
  writeFileSync(join(mixed, "broken.pak"), "not a pak at all\n");
  writeFileSync(join(mixed, "z.pak"), buildPak([{ path: "two.txt", data: "beta MARKER\n" }]));

  const log = join(tmp, "mixed-list.log");
  const proc = runLogged(["list", mixed, "--limit", "0"], log);
  const text = readFileSync(log, "utf8");
  check("a folder with one unreadable archive still lists the readable ones",
    text.includes("one.txt") && text.includes("two.txt") && /could not be read/.test(text), text.trim());
  check("and the exit code says an archive was missed", proc.status === 1, `status ${proc.status}`);

  const json = join(tmp, "mixed.json");
  runStdout(["verify", mixed, "--json"], json);
  const parsed = JSON.parse(readFileSync(json, "utf8"));
  check("the JSON answer names the failed archive and counts it",
    parsed.archives.length === 3 && parsed.failed === 1 &&
      parsed.archives.some((a) => a.ok === false && /not a PAC1 archive/.test(a.error)),
    JSON.stringify(parsed.archives.map((a) => ({ file: a.file, ok: a.ok }))));
  check("verify over a folder with a broken archive exits 1",
    run(["verify", mixed]).status === 1);
}

// --- get: directories, and what <outFile> means ----------------------------

{
  // A directory, to a path that does not exist: that path becomes the root of it.
  const tree = join(tmp, "tree");
  const proc = run(["get", goodPath, "scripts", tree]);
  check("get of a directory exits 0", proc.status === 0, `status ${proc.status}`);
  check("get of a directory recreates the paths under it",
    existsSync(join(tree, "Core", "thing.c")) &&
      readFileSync(join(tree, "Core", "thing.c")).toString("utf8") === SCRIPT_TEXT);
  check("get of a directory writes only that subtree",
    !existsSync(join(tree, "thing.conf")) && !existsSync(join(tree, "configs")));
  check("a stored entry is written by the same loop as a compressed one",
    run(["get", goodPath, "configs", join(tmp, "stored-tree")]).status === 0 &&
      readFileSync(join(tmp, "stored-tree", "thing.conf"), "utf8") === CONFIG_TEXT);

  // Case-insensitive, and with a trailing slash on the virtual path.
  check("get of a directory matches case-insensitively",
    run(["get", goodPath, "SCRIPTS", join(tmp, "ci")]).status === 0 &&
      existsSync(join(tmp, "ci", "Core", "thing.c")));

  // An existing directory, or a path ending in a separator, means "inside it,
  // under the entry's own name" -- for a file and for a directory alike.
  const into = join(tmp, "into");
  mkdirSync(into, { recursive: true });
  check("a file goes into an existing directory under its own name",
    run(["get", goodPath, "readme.txt", into]).status === 0 &&
      readFileSync(join(into, "readme.txt"), "utf8") === "plain\n");
  check("a directory goes into an existing directory under its own name",
    run(["get", goodPath, "scripts", into]).status === 0 &&
      existsSync(join(into, "scripts", "Core", "thing.c")));
  check("a trailing separator means the same for a file",
    run(["get", goodPath, "configs/thing.conf", join(tmp, "fresh") + "/"]).status === 0 &&
      readFileSync(join(tmp, "fresh", "thing.conf"), "utf8") === CONFIG_TEXT);
  check("a trailing separator means the same for a directory",
    run(["get", goodPath, "scripts", join(tmp, "fresh2") + "/"]).status === 0 &&
      existsSync(join(tmp, "fresh2", "scripts", "Core", "thing.c")));

  // A directory needs a directory destination.
  const fileDest = join(tmp, "a-file");
  writeFileSync(fileDest, "not a directory\n");
  const dirLog = join(tmp, "dir-into-file.log");
  const dirProc = runLogged(["get", goodPath, "scripts", fileDest], dirLog);
  check("a directory into an existing file exits 1",
    dirProc.status === 1 && /is an existing file/.test(readFileSync(dirLog, "utf8")),
    readFileSync(dirLog, "utf8").trim());

  // --verbose lists every file; the default is one summary line.
  const verboseLog = join(tmp, "verbose.log");
  runLogged(["get", goodPath, "scripts", join(tmp, "loud"), "--verbose"], verboseLog);
  const verboseText = readFileSync(verboseLog, "utf8");
  check("--verbose names each file of a directory",
    verboseText.includes("Core/thing.c"), verboseText.trim());
  const quietLog = join(tmp, "quiet.log");
  runLogged(["get", goodPath, "scripts", join(tmp, "hushed")], quietLog);
  const quietText = readFileSync(quietLog, "utf8");
  check("the default prints one summary line for a directory",
    quietText.trim().split("\n").length === 1 && /1 file\b/.test(quietText), quietText.trim());

  // cat prints bytes, so a directory has to be refused with an explanation.
  const catLog = join(tmp, "cat-dir.log");
  const catProc = runLogged(["cat", goodPath, "scripts"], catLog);
  const catText = readFileSync(catLog, "utf8");
  check("cat of a directory exits 1 and points at list/get",
    catProc.status === 1 && /is a directory/.test(catText) && /get/.test(catText), catText.trim());
}

// --- get: the archive root ("/") -------------------------------------------

{
  const rootPak = openPak(goodPath);
  const rootTarget = findTarget(rootPak, "/");
  check("findTarget of a bare separator is the archive root",
    rootTarget.kind === "dir" && rootTarget.path === "" && rootTarget.entry === rootPak.root);
  rootPak.close();

  // Every entry, at its own path, in one go.
  const all = join(tmp, "root");
  const proc = run(["get", goodPath, "/", all]);
  check("get of the archive root exits 0", proc.status === 0, `status ${proc.status}`);
  check("get of the archive root writes every entry at its own path",
    readFileSync(join(all, "configs", "thing.conf"), "utf8") === CONFIG_TEXT &&
      readFileSync(join(all, "scripts", "Core", "thing.c"), "utf8") === SCRIPT_TEXT &&
      readFileSync(join(all, "readme.txt"), "utf8") === "plain\n");
  check("get of the root recreates the directories the index holds",
    existsSync(join(all, "scripts", "Core")));

  // Several separators, and the root straight into an existing directory: the
  // root has no name of its own, so nothing is nested under one.
  const intoRoot = join(tmp, "root-into");
  mkdirSync(intoRoot, { recursive: true });
  check("more separators are the same root, written straight into the destination",
    run(["get", goodPath, "///", intoRoot]).status === 0 &&
      readFileSync(join(intoRoot, "readme.txt"), "utf8") === "plain\n" &&
      existsSync(join(intoRoot, "scripts", "Core", "thing.c")));

  const rootLog = join(tmp, "root-summary.log");
  runLogged(["get", goodPath, "//", join(tmp, "root-summary")], rootLog);
  const rootText = readFileSync(rootLog, "utf8");
  check("the root is reported as / with its file count",
    /^\/: directory, 3 files\b/.test(rootText.trim()), rootText.trim());

  const catRootLog = join(tmp, "cat-root.log");
  const catRoot = runLogged(["cat", goodPath, "/"], catRootLog);
  check("cat of the root refuses and names it /",
    catRoot.status === 1 && /"\/" is a directory/.test(readFileSync(catRootLog, "utf8")),
    readFileSync(catRootLog, "utf8").trim());

  // The archives nest dot-directories, so "recreate every path" has to include them.
  const hidden = join(tmp, "hidden");
  check("a directory whose name starts with a dot is recreated like any other",
    run(["get", dottedPak, "/", hidden]).status === 0 &&
      readFileSync(join(hidden, "scripts", ".NavData", "GM_Eden", "navData_1.ntile"), "utf8") === DOTTED &&
      readFileSync(join(hidden, "audio", ".hidden", "note.ogg"), "utf8") === "OGG");
}

// --- output paths ----------------------------------------------------------

{
  const clean = resolve(tmp, "out", "thing.c");
  check("a plain path is usable on Windows", describeUnusablePath(clean, { platform: "win32" }) === null);
  check("a path with a space and a dash is usable", describeUnusablePath("C:\\out\\a b\\x-y.c", { platform: "win32" }) === null);
  check("a drive root is not mistaken for an illegal colon",
    describeUnusablePath("C:\\out\\x.c", { platform: "win32" }) === null);

  const question = describeUnusablePath("C:\\out\\x?.c", { platform: "win32" });
  check("a Windows-illegal character is named, with the component",
    question !== null && question.includes('"?"') && question.includes("x?.c"), String(question));
  check("an illegal character is not rejected on a POSIX platform",
    describeUnusablePath("/out/x?.c", { platform: "linux" }) === null);

  const reserved = describeUnusablePath("C:\\out\\CON\\x.c", { platform: "win32" });
  check("a reserved device name is named", reserved !== null && reserved.includes("CON"), String(reserved));
  const reservedFile = describeUnusablePath("C:\\out\\nul.txt", { platform: "win32" });
  check("a reserved name with an extension is caught too",
    reservedFile !== null && reservedFile.includes("NUL"), String(reservedFile));

  const long = describeUnusablePath(`C:\\out\\${"z".repeat(300)}\\x.c`, { platform: "win32" });
  check("a component longer than 255 characters is named",
    long !== null && long.includes("300"), String(long));

  const control = describeUnusablePath(`C:\\out\\a${String.fromCharCode(7)}b\\x.c`, { platform: "win32" });
  check("a control character is named", control !== null && control.includes("0x07"), String(control));
}

if (process.platform === "win32") {
  // The defect this check exists for: mkdirSync and writeFileSync both answer
  // `ENOENT: no such file or directory` here, which names a missing directory
  // that creating the parent does not fix. The tool must say what is wrong.
  const log = join(tmp, "illegal.log");
  const proc = runLogged(["get", goodPath, "configs/thing.conf", join(tmp, "bad?name.conf")], log);
  const text = readFileSync(log, "utf8");
  check("get on an uncreatable Windows path exits 1", proc.status === 1, `status ${proc.status}`);
  check("the failure names the character and the component, not ENOENT",
    text.includes('"?"') && text.includes("bad?name.conf") && !/ENOENT/.test(text), text.trim());

  const longLog = join(tmp, "long.log");
  const longName = `${"z".repeat(300)}.conf`;
  const longProc = runLogged(["get", goodPath, "configs/thing.conf", join(tmp, longName)], longLog);
  check("get on an over-long component exits 1 with the length",
    longProc.status === 1 && readFileSync(longLog, "utf8").includes(`is ${longName.length} characters long`),
    readFileSync(longLog, "utf8").trim());
}

rmSync(tmp, { recursive: true, force: true });

if (failures) {
  console.log(`\n${failures} PAK TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nALL PAK TESTS PASSED");
