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
import { deflateSync } from "node:zlib";
import {
  openPak, detectOffsetBase, verifyPak, compressionName, COMPRESSION_ZLIB, describeUnusablePath,
  findTarget, entriesUnder,
} from "../tools/pak.mjs";

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

// ---------------------------------------------------------------------------
// A minimal PAC1 writer
// ---------------------------------------------------------------------------

const HEAD_BODY = 28; // same size as every observed archive
const FORM_AND_HEAD = 12 + 8 + HEAD_BODY; // DATA body would start here
const DATA_BODY_START = FORM_AND_HEAD + 8;

function encodeTree(nodes) {
  // nodes: [{ name, children }] | { name, offset, storedLength, originalLength, compressionType, timestamp }
  const parts = [];
  for (const node of nodes) {
    const nameBuf = Buffer.from(node.name, "utf8");
    if (node.children) {
      parts.push(Buffer.from([0, nameBuf.length]), nameBuf, u32le(node.children.length), encodeTree(node.children));
    } else {
      parts.push(
        Buffer.from([1, nameBuf.length]),
        nameBuf,
        u32le(node.offset), u32le(node.storedLength), u32le(node.originalLength),
        u32le(0), u32be(node.compressionType), u32le(node.timestamp ?? 0),
      );
    }
  }
  return Buffer.concat(parts);
}

const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

/**
 * Build a PAC1 archive.
 * files: [{ path, data, compress?, compressionType?, timestamp? }]
 * absoluteOffsets: true writes the offsets the game writes (from the start of
 * the file); false writes them relative to the DATA body, which is the layout
 * the old tool assumed and which this suite must keep recognising as broken.
 */
function buildPak(files, { absoluteOffsets = true } = {}) {
  const payloads = [];
  const flat = [];
  let cursor = 0;
  for (const f of files) {
    const compressionType = f.compressionType ?? (f.compress ? COMPRESSION_ZLIB : 0);
    const stored = compressionType === COMPRESSION_ZLIB ? deflateSync(Buffer.from(f.data)) : Buffer.from(f.data);
    const offset = absoluteOffsets ? DATA_BODY_START + cursor : cursor;
    payloads.push(stored);
    flat.push({ path: f.path, offset, storedLength: stored.length, originalLength: f.data.length, compressionType, timestamp: f.timestamp });
    cursor += stored.length;
  }

  // Tree: split the flat paths into directories.
  const rootChildren = [];
  const dirs = new Map();
  const dirFor = (segments) => {
    let list = rootChildren, prefix = "";
    for (const seg of segments) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let dir = dirs.get(prefix);
      if (!dir) { dir = { name: seg, children: [] }; dirs.set(prefix, dir); list.push(dir); }
      list = dir.children;
    }
    return list;
  };
  for (const f of flat) {
    const segments = f.path.split("/");
    const name = segments.pop();
    dirFor(segments).push({
      name,
      offset: f.offset,
      storedLength: f.storedLength,
      originalLength: f.originalLength,
      compressionType: f.compressionType,
      timestamp: f.timestamp,
    });
  }

  const tree = Buffer.concat([Buffer.from([0, 0]), u32le(rootChildren.length), encodeTree(rootChildren)]);
  const dataBody = Buffer.concat(payloads);
  const head = Buffer.alloc(HEAD_BODY);
  const file = Buffer.alloc(12);
  file.write("FORM", 0, "latin1");
  file.writeUInt32BE(12 + 8 + HEAD_BODY + 8 + dataBody.length + 8 + tree.length, 4);
  file.write("PAC1", 8, "latin1");
  return Buffer.concat([
    file,
    Buffer.from("HEAD", "latin1"), u32be(HEAD_BODY), head,
    Buffer.from("DATA", "latin1"), u32be(dataBody.length), dataBody,
    Buffer.from("FILE", "latin1"), u32be(tree.length), tree,
  ]);
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

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
