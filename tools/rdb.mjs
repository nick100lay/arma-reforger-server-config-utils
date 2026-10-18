// Read resourceDatabase.rdb — the resource GUID table: GUID -> path, and back.
//
//   node tools/rdb.mjs get    <rdb> <guid> [--json]
//   node tools/rdb.mjs guid   <rdb> <path> [--json]
//   node tools/rdb.mjs list   <rdb> [regex] [--limit N|0] [--json]
//   node tools/rdb.mjs info   <rdb> [--json]
//   node tools/rdb.mjs verify <rdb> [--json]
//
// Also usable as a library:
//   import { readRdb, scanRdb, reverseRdb, verifyRdb } from "./rdb.mjs";
//   const guids = readRdb("<install>/addons/data/resourceDatabase.rdb");
//   guids.get("1EA95DAE3230BEB0")          // -> "worlds/Cain/Cain.et"
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
// A resource reference is a GUID plus a path — `{2B4183DF23E88249}Missions/CAH_Morton.conf`.
// The GUID is stored in Workbench `<file>.meta` sidecars, which are NOT shipped inside the .pak
// archives: a full content scan of data007.pak for one published GUID returns zero hits among
// 28 161 entries. The one place the shipped game carries the mapping in bulk is
//
//     <install>/addons/data/resourceDatabase.rdb
//
// so this file is the only way to turn a GUID read out of a world, a `.conf` or another `.rdb`
// back into a path — and the only way to answer the reverse question, which is what a scenario
// GUID in `server.json` actually is.
//
// ---------------------------------------------------------------------------
// THE CONTAINER (measured on the vanilla client and dedicated-server databases
// and on six workshop addons' ones, all 1.8.0.13)
//
//   offset 0  "FORM" | u32BE size - 8 | "RDBC" | u32LE version | u32LE size | ...
//
// Every copy checked starts this way, with version 7, `size` equal to the file
// length, and the FORM length equal to the file length - 8. That is the first
// thing `scanRdb` checks: a truncated, padded or foreign file is refused by its
// own header, not discovered later as a path that does not resolve. Without that
// check a 2 MB prefix of a database parses as 19 837 perfectly good records and
// answers "not found" for everything after byte 2 097 152.
//
// ---------------------------------------------------------------------------
// A RECORD, AND WHAT THIS READER DOES NOT PARSE
//
//   [u32LE pathLen + 1][path][0x00][u32LE kind][u16 0][8-byte GUID, little-endian]
//
// The u32 counts the path **and its NUL terminator**. Requiring it to agree with
// the path is what makes a record a record rather than a run of printable bytes
// that happens to end in a NUL. The path is ASCII with `/` as the separator (no
// `\`), and spaces occur in it — 244 paths in both installed databases
// (`anims/anm/editor_poses/poses/4_ medic.anm`) — so they are accepted.
//
// The GUID is read **7 bytes after the NUL**: skip 6, then 8 bytes reversed. The
// six bytes are a u32 "kind" and a u16, not interpreted: `06 00 00 00` in most of
// the client database and in two thirds of the server's, `16 00 00 00` in the
// rest of the server's (33 284 records, all but one `.wav` or `.edds`),
// `06 00 01 00` in 9, `05 00 00 00` once. `info` prints the distribution rather
// than assuming a value.
//
// The rest of the container is not decoded. Records are 82 % of the bytes of the
// server file, and between two of them there are usually 8 bytes (90 476 of
// 98 754 gaps) whose meaning is unknown. So a record is found by its own framing:
// the honest model is "records carved out of a container whose index is not
// parsed", not a full parse of the format.
//
// THE FILE IS NOT ONE TABLE. It also contains other length-prefixed string data
// whose runs end in a NUL, and a reader that only walks back over printable bytes
// and reads 8 bytes as a GUID picks some of it up: it invents entries such as
// `hqy.MA4`, whose "GUID" is the ASCII tail of the next path (`...Assets/Decal`).
// The length field separates them: on each installed copy 11 candidates
// contradict it, and 5 813 more carry no GUID at all.
//
// THE PUBLISHED GUIDS ARE A FIXTURE, NOT THE PROOF. The 8 pairs the BI wiki
// publishes for the vanilla scenarios are the only check that needs nothing but
// the file, and the only external evidence for *where* in a record the GUID sits
// — a reader shifted by a byte cannot match them. But they are 8 records of
// ~98 600, all `Missions/*.conf`, all kind 6, and a workshop database
// legitimately contains none of them. So `verify` reports two facts separately:
// `ok` is the structural check (container header, record framing, one-to-one
// mapping, non-empty) and applies to any database, while `vanilla` says whether
// the 8 were present and reproduced. `ebin --rdb` needs `ok`, not `vanilla`: a
// mod's database is a database.
//
// The GUID offset does not rest on those 8 pairs alone. Two checks that use no
// hardcoded value agree with it on 1.8.0.13: the `{GUID}path` pairs written in
// the game's own text resources (132 843 references in data007.pak: 132 699
// exact, 3 stale references in the game's data, 136 paths absent, 5 case-only),
// and the client's and server's copies, which agree on the GUID of all 98 590
// paths they share — including all 33 119 of the server's kind-22 records.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

/** Bytes between the path's NUL terminator and the first byte of the GUID. */
export const GUID_OFFSET = 7;
/** Bytes after the NUL that a record needs before a GUID can be read: 6 framing + 8 GUID. */
const AFTER_NUL = 6 + 8;
const MIN_PATH = 4;
const MAX_PATH = 250;
/** A resource path: printable, `/`-separated, spaces allowed (the database has 244 of them). */
const PATH_SHAPE = /^[A-Za-z0-9_\-/. ]+$/;
const GUID_SHAPE = /^[0-9A-F]{16}$/;

export const MAGIC_FORM = "FORM";
export const MAGIC_RDBC = "RDBC";
/** The prologue: FORM(4) + u32BE size-8(4) + RDBC(4) + u32LE version(4) + u32LE size(4). */
const PROLOGUE = 20;
/** The only version any checked copy carries: client, dedicated server, six workshop addons. */
export const RDB_VERSION = 7;

/** Print four bytes as text when they are printable, as hex when they are not. */
function showFour(bytes) {
  return /^[\x20-\x7e]{4}$/.test(bytes) ? `"${bytes}"` : [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/**
 * Read the container's prologue and check it. Throws when the file is not an RDBC
 * container of the version this reader understands — the sizes are exact, so a
 * truncated or padded file is named as such instead of being carved for records.
 */
export function readHeader(buf) {
  if (buf.length < PROLOGUE) {
    throw new Error(`truncated resource database: ${buf.length} byte(s), the prologue is ${PROLOGUE}`);
  }
  const magic = buf.toString("latin1", 0, 4);
  if (magic !== MAGIC_FORM) {
    throw new Error(`not a resource database: the prologue starts with ${showFour(magic)}, not "FORM"`);
  }
  const tag = buf.toString("latin1", 8, 12);
  if (tag !== MAGIC_RDBC) {
    throw new Error(`not a resource database: bytes 8..11 are ${showFour(tag)}, not "RDBC"`);
  }
  const formSize = buf.readUInt32BE(4);
  if (formSize !== buf.length - 8) {
    throw new Error(`the FORM length is ${formSize}, but the file has ${buf.length - 8} byte(s) after the ` +
      "8-byte prologue — truncated or padded");
  }
  const version = buf.readUInt32LE(12);
  const size = buf.readUInt32LE(16);
  if (size !== buf.length) {
    throw new Error(`the header says the file is ${size} byte(s), but it is ${buf.length} — truncated or padded`);
  }
  if (version !== RDB_VERSION) {
    throw new Error(`unsupported resource database version ${version}: this reader understands version ${RDB_VERSION}`);
  }
  return { version, size, formSize };
}

/**
 * The 8 GUIDs published on the BI wiki for the vanilla scenarios — a **fixture**,
 * not the format check. They are external evidence for the GUID's position inside
 * a record (a shifted reader cannot match them), and `verify` reports them
 * separately from `ok`; a workshop database contains none of them and is still a
 * valid database. See the header of this file.
 */
export const PUBLISHED_GUIDS = Object.freeze({
  "Missions/23_Campaign.conf": "ECC61978EDCC2B5A",
  "Missions/21_GM_Eden.conf": "59AD59368755F41A",
  "Missions/22_GM_Arland.conf": "2BBBE828037C6F4B",
  "Missions/Tutorial.conf": "002AF7323E0129AF",
  "Missions/CAH_Castle.conf": "F1A1BEA67132113E",
  "Missions/CAH_Factory.conf": "9405201CBD22A30C",
  "Missions/CAH_LeMoule.conf": "7C491B1FCC0FF0E1",
  "Missions/CAH_Morton.conf": "2B4183DF23E88249",
});

/**
 * Scan a resource database. `input` is a path, or the bytes themselves (a `Buffer`/`Uint8Array`),
 * which keeps the reader usable in a test that builds a database instead of finding one; `name`
 * labels a byte input in errors and in `file`, and defaults to `"<buffer>"`.
 *
 * The container prologue is checked first and a file that is not an RDBC of this version is
 * refused there. Returns:
 *   { file, bytes, header, records, map, gaps, extensions, rejected }
 *
 * `map` is GUID -> path, first record wins (a GUID that appeared twice would be a database a
 * consumer cannot read one way). `gaps` is the hex of the six bytes between the path and the
 * GUID, counted, so `info` can show what a build actually writes. `extensions` counts paths by
 * their extension. `rejected` counts candidates that looked like records and failed a check:
 * a `lengthField` that contradicts the path, a `shape` that is not a clean path, an all-zero
 * `guid`. Those counts are diagnostics, not a permitted reason to guess.
 */
export function scanRdb(input, { name = null } = {}) {
  const fromBytes = Buffer.isBuffer(input) || input instanceof Uint8Array;
  const buf = fromBytes ? Buffer.from(input) : readFileSync(input);
  const file = fromBytes ? name ?? "<buffer>" : String(input);
  let header;
  try {
    header = readHeader(buf);
  } catch (err) {
    // The header's own errors do not know where they came from; a caller reading several files does.
    throw new Error(`${file}: ${err.message}`);
  }
  const map = new Map();
  const gaps = new Map();
  const extensions = new Map();
  const rejected = { lengthField: 0, shape: 0, guid: 0 };
  let records = 0;

  // The prologue is not record data: the scan starts after it, so the header's own NULs cannot be
  // taken for a path terminator.
  for (let i = PROLOGUE; i + 1 + AFTER_NUL <= buf.length; i++) {
    if (buf[i] !== 0) continue;
    let start = i;
    while (start > PROLOGUE && buf[start - 1] >= 0x20 && buf[start - 1] < 0x7f) start--;
    const len = i - start;
    if (len < MIN_PATH || len > MAX_PATH) continue;
    const path = buf.toString("latin1", start, i);
    if (!PATH_SHAPE.test(path) || path.includes("//") || !path.includes(".")) { rejected.shape++; continue; }
    // The u32 in front of the path is its length, the NUL counted. A candidate that contradicts
    // it is another table's bytes: the walk-back can start in the middle of one, and the 8 bytes
    // it would read as a GUID are then the tail of the next path. Measured: 11 such candidates,
    // all of them false, and no real record fails the check.
    if (start < PROLOGUE + 4 || buf.readUInt32LE(start - 4) !== len + 1) { rejected.lengthField++; continue; }
    const guid = Buffer.from(buf.subarray(i + GUID_OFFSET, i + GUID_OFFSET + 8)).reverse().toString("hex").toUpperCase();
    if (!GUID_SHAPE.test(guid) || guid === "0000000000000000") { rejected.guid++; continue; }

    records++;
    const gap = buf.subarray(i + 1, i + GUID_OFFSET).toString("hex");
    gaps.set(gap, (gaps.get(gap) ?? 0) + 1);
    const dot = path.lastIndexOf(".");
    const ext = dot > path.lastIndexOf("/") ? path.slice(dot).toLowerCase() : "(none)";
    extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
    if (!map.has(guid)) map.set(guid, path);
  }

  return { file, bytes: buf.length, header, records, map, gaps, extensions, rejected };
}

/**
 * Build a GUID -> path map, which is all most callers need. `scanRdb` is the same read when the
 * record counts, the framing or the rejected candidates are the question.
 */
export function readRdb(input, options = {}) {
  return scanRdb(input, options).map;
}

/**
 * The other direction: path -> GUID. A `.conf` read out of a pak names its world by path, and the
 * GUID a `server.json` needs is this lookup. Where two GUIDs claim one path the first record wins,
 * exactly as `scanRdb` keeps the first GUID; `verify` reports whether that happened at all.
 */
export function reverseRdb(map) {
  const out = new Map();
  for (const [guid, path] of map) if (!out.has(path)) out.set(path, guid);
  return out;
}

/**
 * Check a scanned database: the container is already validated by `scanRdb`, so this checks what
 * is left — that the records form a one-to-one mapping and that there are any — and compares the
 * database with the **fixture** of 8 published vanilla GUIDs.
 *
 * The two answers are deliberately separate:
 *   - `ok` — the structural check, and the one `ebin --rdb` requires. True for a workshop
 *     database that contains none of the vanilla resources.
 *   - `vanilla` — whether all 8 published pairs were present and reproduced. True on the vanilla
 *     client and server databases; false on a mod's.
 *
 * `contradicted` are the pairs whose path is present with a *different* GUID: that is the layout
 * disagreeing with itself, and it is an error for any database. `missing` are the pairs absent
 * altogether — the check could not run for them.
 *
 * `known` can be overridden, which is what a test does to exercise both directions without the
 * installed file.
 */
export function verifyRdb(db, { known = PUBLISHED_GUIDS } = {}) {
  const byPath = reverseRdb(db.map);
  const checks = Object.entries(known).map(([path, expected]) => {
    const found = byPath.get(path) ?? null;
    return { path, expected, found, present: found !== null, ok: found === expected };
  });
  const contradicted = checks.filter((c) => c.present && !c.ok);
  const missing = checks.filter((c) => !c.present);
  const uniqueGuids = db.map.size;
  const uniquePaths = byPath.size;
  const unique = uniqueGuids === db.records && uniquePaths === db.records;
  return {
    file: db.file,
    bytes: db.bytes,
    header: db.header,
    records: db.records,
    uniqueGuids,
    uniquePaths,
    unique,
    checks,
    contradicted,
    missing,
    vanilla: missing.length === 0 && contradicted.length === 0,
    ok: unique && db.records > 0 && contradicted.length === 0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Read resourceDatabase.rdb — the resource GUID table (GUID <-> path)

  node tools/rdb.mjs get    <rdb> <guid> [--json]
  node tools/rdb.mjs guid   <rdb> <path> [--json]
  node tools/rdb.mjs list   <rdb> [regex] [--limit N|0] [--json]
  node tools/rdb.mjs info   <rdb> [--json]
  node tools/rdb.mjs verify <rdb> [--json]

The database is <install>/addons/data/resourceDatabase.rdb (~11 MB). It is the only shipped
place that maps a resource GUID to its path, and the reason a GUID read out of a world can be
turned back into a path. \`get\` exits 1 when the GUID names nothing. \`verify\` checks the
container and the one-to-one mapping of any database, and separately reports the 8 GUIDs the BI
wiki publishes for the vanilla scenarios — a workshop database legitimately has none of them.

Arguments
  <guid>          with or without braces; case does not matter
  <path>          resource path, forward slashes; backslashes are converted
  [regex]         case-insensitive match on the path

Options
  --limit N       maximum rows to print (default 100; 0 = every one)
  --all           same as --limit 0
  --json          machine-readable output
`;

/** A bad command line: reported with the usage, and the exit status is 1. */
function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") flags.json = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--limit") {
      const raw = argv[++i];
      if (raw === undefined || raw.startsWith("--")) throw usageError("--limit needs a value");
      if (!/^\d+$/.test(raw)) throw usageError(`--limit needs a non-negative whole number, not "${raw}"`);
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) throw usageError(`--limit is too large: ${raw}`);
      flags.limit = n;
    } else if (a === "-h" || a === "--help") flags.help = true;
    // An option this tool does not know would otherwise change the answer silently.
    else if (a.startsWith("-") && a !== "-") throw usageError(`unknown option "${a}"`);
    else flags._.push(a);
  }
  return flags;
}

/** `{2b4183df23e88249}` and `2B4183DF23E88249` are the same GUID; anything else is a mistake. */
function normaliseGuid(raw) {
  const guid = raw.replace(/[{}]/g, "").toUpperCase();
  if (!GUID_SHAPE.test(guid) || guid === "0000000000000000") {
    throw usageError(`"${raw}" is not a resource GUID: expected 16 hex digits, optionally in braces`);
  }
  return guid;
}

/** Rows to print: `--limit 0` and `--all` mean "every one"; the default stops at 100. */
function rowLimit(flags, fallback = 100) {
  if (flags.all) return Infinity;
  if (flags.limit === undefined) return fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

function cmdGet(db, flags) {
  const raw = flags._[2];
  if (raw === undefined) throw usageError("get needs a <guid>: node tools/rdb.mjs get <rdb> <guid>");
  const guid = normaliseGuid(raw);
  const path = db.map.get(guid) ?? null;
  if (flags.json) {
    console.log(JSON.stringify({ file: db.file, guid, path }, null, 2));
  } else if (path === null) {
    process.stderr.write(`${db.file}: no resource with the GUID {${guid}}\n`);
  } else {
    console.log(`{${guid}}  ${path}`);
  }
  if (path === null) process.exitCode = 1;
}

function cmdGuid(db, flags) {
  const raw = flags._[2];
  if (raw === undefined) throw usageError("guid needs a <path>: node tools/rdb.mjs guid <rdb> <path>");
  const path = raw.replace(/\\/g, "/");
  const guid = reverseRdb(db.map).get(path) ?? null;
  if (flags.json) {
    console.log(JSON.stringify({ file: db.file, path, guid }, null, 2));
  } else if (guid === null) {
    process.stderr.write(`${db.file}: no resource at "${path}"\n`);
  } else {
    console.log(`{${guid}}${path}`);
  }
  if (guid === null) process.exitCode = 1;
}

function cmdList(db, flags) {
  const pattern = flags._[2];
  let re = null;
  if (pattern !== undefined) {
    try { re = new RegExp(pattern, "i"); } catch (err) {
      throw usageError(`"${pattern}" is not a valid regular expression: ${err.message}`);
    }
  }
  const limit = rowLimit(flags);
  const rows = [];
  let total = 0;
  for (const [guid, path] of db.map) {
    if (re && !re.test(path)) continue;
    total++;
    if (rows.length < limit) rows.push({ guid, path });
  }
  if (flags.json) {
    // An envelope, not a bare array: the default stops at 100 rows, and without `total` a caller
    // cannot tell a complete database from a truncated list.
    console.log(JSON.stringify({
      file: db.file,
      total,
      returned: rows.length,
      truncated: rows.length < total,
      filter: pattern ?? null,
      entries: rows,
    }, null, 2));
    return;
  }
  for (const r of rows) console.log(`{${r.guid}}  ${r.path}`);
  if (rows.length < total) console.log(`... ${total - rows.length} more (--limit 0 for all)`);
}

function cmdInfo(db, flags) {
  const framing = [...db.gaps].sort((a, b) => b[1] - a[1]).map(([bytes, count]) => ({ bytes, count }));
  const extensions = [...db.extensions].sort((a, b) => b[1] - a[1]);
  const info = {
    file: db.file,
    bytes: db.bytes,
    header: db.header,
    records: db.records,
    uniqueGuids: db.map.size,
    uniquePaths: new Set(db.map.values()).size,
    framing,
    extensions: Object.fromEntries(extensions),
    rejected: db.rejected,
  };
  if (flags.json) { console.log(JSON.stringify(info, null, 2)); return; }
  const gap = (hex) => hex.match(/../g).join(" ");
  console.log(`${db.file}`);
  console.log(`  container     FORM/RDBC version ${db.header.version}, ${db.bytes} bytes ` +
    "(header sizes and file length agree)");
  console.log(`  records       ${info.records} (${info.uniqueGuids} unique GUIDs, ${info.uniquePaths} unique paths)`);
  console.log(`  framing       between the path and the GUID:`);
  for (const f of framing) console.log(`                  ${gap(f.bytes)}   ${f.count} record(s)`);
  const shown = extensions.slice(0, 6).map(([ext, n]) => `${ext} ${n}`).join(", ");
  console.log(`  extensions    ${extensions.length} kind(s): ${shown}${extensions.length > 6 ? ", ..." : ""}`);
  console.log(`  rejected      ${db.rejected.lengthField} candidate(s) whose length contradicted the path, ` +
    `${db.rejected.shape} that were not a clean path, ${db.rejected.guid} with no GUID`);
}

function cmdVerify(db, flags) {
  const result = verifyRdb(db);
  // Two separate answers, and the output keeps them separate: the structural check (`ok`) is
  // about this file and applies to any database; the published GUIDs are a fixture that only a
  // vanilla database carries, so their absence is reported, not treated as a broken file.
  const problems = [];
  if (result.contradicted.length) {
    problems.push(`the published GUIDs contradict this database: ` +
      result.contradicted.map((f) => `${f.path} is {${f.found}}, the wiki publishes {${f.expected}}`).join("; "));
  }
  if (!result.unique) {
    problems.push(`the mapping is not one-to-one: ${result.records} record(s), ${result.uniqueGuids} GUID(s), ` +
      `${result.uniquePaths} path(s) — a duplicate was dropped`);
  }
  if (!result.records) problems.push("it contains no records");
  const published = result.vanilla
    ? `${result.checks.length}/${result.checks.length} reproduced (the vanilla database)`
    : `${result.checks.length - result.missing.length}/${result.checks.length} present — not the vanilla database, ` +
      "so there is nothing to compare them with";
  if (flags.json) {
    console.log(JSON.stringify({
      file: db.file,
      ok: result.ok,
      vanilla: result.vanilla,
      header: db.header,
      bytes: db.bytes,
      records: result.records,
      uniqueGuids: result.uniqueGuids,
      uniquePaths: result.uniquePaths,
      unique: result.unique,
      framing: [...db.gaps].sort((a, b) => b[1] - a[1]).map(([bytes, count]) => ({ bytes, count })),
      rejected: db.rejected,
      published,
      checks: result.checks,
      contradicted: result.contradicted.map((f) => f.path),
      missing: result.missing.map((f) => f.path),
      problems,
    }, null, 2));
  } else {
    console.log(`${db.file}`);
    console.log(`  container    FORM/RDBC version ${db.header.version}, ${db.bytes} bytes (sizes agree)`);
    console.log(`  records      ${result.records}, ${result.uniqueGuids} unique GUID(s), ${result.uniquePaths} unique path(s)` +
      (result.unique ? "" : "  <- NOT one-to-one"));
    console.log(`  published    ${published}`);
    const canonical = [...db.gaps].sort((a, b) => b[1] - a[1]);
    console.log(`  framing      ${canonical.map(([hex, n]) => `${hex} x${n}`).join(", ")}`);
    if (problems.length) for (const l of problems) console.log(`  FAIL  ${l}`);
    else console.log("  ok");
  }
  if (!result.ok) process.exitCode = 1;
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  // `--help` is a request, not a failure; no arguments at all is a mistake.
  if (flags.help) { process.stdout.write(USAGE); return; }
  if (flags._.length === 0) { process.stderr.write(USAGE); process.exitCode = 1; return; }
  const [command, rdbPath] = flags._;
  if (rdbPath === undefined) { process.stderr.write(USAGE); process.exitCode = 1; return; }
  const db = scanRdb(rdbPath);
  switch (command) {
    case "get": cmdGet(db, flags); break;
    case "guid": cmdGuid(db, flags); break;
    case "list": cmdList(db, flags); break;
    case "info": cmdInfo(db, flags); break;
    case "verify": cmdVerify(db, flags); break;
    default:
      throw usageError(`unknown command "${command}"`);
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
