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
// THE RECORD (measured on both installed 1.8.0.13 databases)
//
//   [u32LE pathLen + 1][path][0x00][6 bytes][8-byte GUID, little-endian]
//
// The u32 counts the path **and its NUL terminator** — the NUL is inside the length, not after
// it. Requiring the u32 to agree with the path is what makes a record a record rather than a run
// of printable bytes that happens to end in a NUL. The path is ASCII with `/` as the separator
// (no `\`), and spaces occur in it — 244 paths in both databases
// (`anims/anm/editor_poses/poses/4_ medic.anm`) — so they are accepted.
//
// The GUID is read **7 bytes after the NUL**: skip 6, then 8 bytes reversed. Those six bytes are
// not interpreted, and they are **not one constant**: the first word is `06 00 00 00` in most of
// the client database and in two thirds of the server's, `16 00 00 00` in the rest of the
// server's (33 284 records), and `05 00 00 00` once. `info` prints the distribution rather than
// assuming a value, so a build that writes something else is visible instead of silently read.
//
// The two copies of the database are not the same file. The 1.8.0.13 client's holds 98 598
// records and the dedicated server's 98 755; each is **one-to-one** — as many distinct GUIDs and
// paths as records — which is why a `Map` in either direction loses nothing. `verify` checks that
// property rather than assuming it.
//
// THE FILE IS NOT ONE TABLE. It also contains other length-prefixed string data whose runs end
// in a NUL, and the naive reader — walk back over printable bytes from every NUL and read 8
// bytes as a GUID — picks some of it up: it invents entries such as `hqy.MA4` whose "GUID" is
// the ASCII tail of the next path (`...Assets/Decal`). The length field is what separates them:
// on each installed copy 11 candidates carry a u32 that contradicts the path, and 5 813 further
// candidates have no GUID at all (a different table again). Neither is a resource, and refusing
// them is what keeps `get` from answering with a path that does not exist and a GUID that names
// nothing.
//
// The published GUIDs — the 8 the BI wiki lists for the vanilla scenarios — are the guard, and
// `verify` reproduces them before anything else is trusted. A layout change would show up there
// first, as a mismatch rather than as a plausible wrong answer.
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

/**
 * The 8 GUIDs published on the BI wiki for the vanilla scenarios. They are the reason a wrong
 * offset is caught instead of trusted: a reader that shifts by a byte produces 8 mismatches here
 * long before it produces a wrong scenarioId somewhere else.
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
 * Returns:
 *   { file, bytes, records, map, gaps, extensions, rejected }
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
  const map = new Map();
  const gaps = new Map();
  const extensions = new Map();
  const rejected = { lengthField: 0, shape: 0, guid: 0 };
  let records = 0;

  // A NUL needs the 6 framing bytes and the 8-byte GUID behind it: `i + 1 + AFTER_NUL` must still
  // be inside the file. Every record is then read forward from its own NUL, so no offset has to
  // be known in advance and the scan is O(bytes), not O(bytes x records).
  for (let i = 0; i + 1 + AFTER_NUL <= buf.length; i++) {
    if (buf[i] !== 0) continue;
    let start = i;
    while (start > 0 && buf[start - 1] >= 0x20 && buf[start - 1] < 0x7f) start--;
    const len = i - start;
    if (len < MIN_PATH || len > MAX_PATH) continue;
    const path = buf.toString("latin1", start, i);
    if (!PATH_SHAPE.test(path) || path.includes("//") || !path.includes(".")) { rejected.shape++; continue; }
    // The u32 in front of the path is its length, the NUL counted. A candidate that contradicts
    // it is another table's bytes: the walk-back can start in the middle of one, and the 8 bytes
    // it would read as a GUID are then the tail of the next path. Measured: 11 such candidates,
    // all of them false, and no real record fails the check.
    if (start < 4 || buf.readUInt32LE(start - 4) !== len + 1) { rejected.lengthField++; continue; }
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

  return { file, bytes: buf.length, records, map, gaps, extensions, rejected };
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
 * Check a scanned database against the published GUIDs and against the properties every consumer
 * relies on: one GUID per record, one path per GUID, and a record that is not a duplicate of
 * another. Returns `{ ok, file, bytes, records, uniqueGuids, uniquePaths, unique, checks,
 * failures }`; `ok` is false when a published GUID is missing or different, or when the mapping
 * is not one-to-one.
 *
 * `known` can be overridden, which is what a test does to exercise both directions without the
 * installed file: a synthetic database verifies against its own pairs and fails against the
 * published ones.
 */
export function verifyRdb(db, { known = PUBLISHED_GUIDS } = {}) {
  const byPath = reverseRdb(db.map);
  const checks = Object.entries(known).map(([path, expected]) => {
    const found = byPath.get(path) ?? null;
    return { path, expected, found, ok: found === expected };
  });
  const failures = checks.filter((c) => !c.ok);
  const uniqueGuids = db.map.size;
  const uniquePaths = byPath.size;
  const unique = uniqueGuids === db.records && uniquePaths === db.records;
  return {
    file: db.file,
    bytes: db.bytes,
    records: db.records,
    uniqueGuids,
    uniquePaths,
    unique,
    checks,
    failures,
    ok: failures.length === 0 && unique,
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
turned back into a path. \`get\` exits 1 when the GUID names nothing; \`verify\` reproduces the
8 GUIDs published on the BI wiki before anything else is trusted.

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
  console.log(`  size          ${db.bytes} bytes`);
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
  // The published GUIDs are the guard that makes every other answer trustworthy: when they stop
  // matching, the layout has changed and the paths this reader produced are guesses.
  const lines = [];
  if (result.failures.length) {
    lines.push(`RDB self-check FAILED for ${result.failures.length}/${result.checks.length} published GUIDs: ` +
      result.failures.map((f) => `${f.path} (expected ${f.expected}, found ${f.found ?? "nothing"})`).join("; "));
    lines.push("The record layout no longer matches this resourceDatabase.rdb, so no path it yields can be trusted.");
  }
  if (!result.unique) {
    lines.push(`the mapping is not one-to-one: ${result.records} record(s), ${result.uniqueGuids} GUID(s), ` +
      `${result.uniquePaths} path(s) — a duplicate was dropped`);
  }
  if (flags.json) {
    console.log(JSON.stringify({
      file: db.file,
      ok: result.ok,
      bytes: db.bytes,
      records: result.records,
      uniqueGuids: result.uniqueGuids,
      uniquePaths: result.uniquePaths,
      unique: result.unique,
      framing: [...db.gaps].sort((a, b) => b[1] - a[1]).map(([bytes, count]) => ({ bytes, count })),
      rejected: db.rejected,
      checks: result.checks,
      failures: result.failures.map((f) => f.path),
      problems: lines,
    }, null, 2));
  } else {
    console.log(`${db.file}`);
    console.log(`  records      ${result.records}, ${result.uniqueGuids} unique GUID(s), ${result.uniquePaths} unique path(s)` +
      (result.unique ? "" : "  <- NOT one-to-one"));
    console.log(`  published    ${result.checks.length - result.failures.length}/${result.checks.length} GUIDs reproduced`);
    const canonical = [...db.gaps].sort((a, b) => b[1] - a[1]);
    console.log(`  framing      ${canonical.map(([hex, n]) => `${hex} x${n}`).join(", ")}`);
    if (lines.length) for (const l of lines) console.log(`  FAIL  ${l}`);
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
