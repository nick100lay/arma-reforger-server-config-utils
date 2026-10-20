// Read resourceDatabase.rdb — the resource GUID table: GUID -> path, and back.
//
//   node tools/rdb.mjs get    <rdb> <guid> [--json]
//   node tools/rdb.mjs guid   <rdb> <path> [--json]
//   node tools/rdb.mjs list   <rdb> [regex] [--limit N|0] [--json]
//   node tools/rdb.mjs info   <rdb> [--json]
//   node tools/rdb.mjs verify <rdb> [--json]
//   node tools/rdb.mjs merge  <rdb>... [--json]
//   node tools/rdb.mjs verify-merge <rdb>... [--json]
//
// Also usable as a library:
//   import { readRdb, scanRdb, reverseRdb, verifyRdb, verifyMerge, mergeRdb, openRdbFiles } from "./rdb.mjs";
//   const guids = readRdb("<install>/addons/data/resourceDatabase.rdb");
//   guids.get("1EA95DAE3230BEB0")          // -> "worlds/Cain/Cain.ent"
//   const { merged, check } = openRdbFiles([data, mod]);
//   check.ok                                // one GUID -> one path, case-insensitively?
//   merged.resolve("1EA95DAE3230BEB0")      // -> { path, rdbs: [0, 1] }
//
// ---------------------------------------------------------------------------
// WHY THIS FILE EXISTS
//
// A resource reference is a GUID plus a path — `{2B4183DF23E88249}Missions/CAH_Morton.conf`.
// The GUID is stored in Workbench `<file>.meta` sidecars, which are NOT shipped inside the .pak
// archives. The one place the shipped game carries the mapping in bulk is
//
//     <install>/addons/data/resourceDatabase.rdb
//
// so this file is the only way to turn a GUID read out of a world, a `.conf` or another `.rdb`
// back into a path — and the only way to answer the reverse question, which is what a scenario
// GUID in `server.json` actually is.
//
// ---------------------------------------------------------------------------
// THE CONTAINER (measured on 228 copies: the client's and the dedicated server's data and core
// databases and 224 workshop addons')
//
//   "FORM" | u32BE size - 8 | "RDBC" | u32LE version | u32LE size
//   u32     flags                0 in every database checked
//   u32     nameCount            version 6 and 7 only
//   names   nameCount × (u32 length incl. NUL, UTF-8 bytes, 0x00)
//   u32     recordCount          the root included: parsed records + 1
//   record  the root: an empty path and kind 5; its GUID is zero except in version 5
//   record  recordCount - 1 times, back to back, to the last byte of the file
//
// Every copy checked tiles to its exact last byte under that reading, and the parsed record count
// equals `recordCount - 1`; `scanRdb` refuses a file where either is untrue. That is what makes
// the read a parse rather than a carve: a 2 MB prefix of the database is refused by the header
// instead of yielding 19 837 "valid" records and "not found" for everything after it.
//
// Three versions occur. 7 is the installed build's; 6 is current Workshop content; 5 is old
// Workshop content (one of 228 copies). The differences a reader has to know:
//
//   version 5     no name table — flags are followed directly by the record count; the root's
//                 GUID is not zero; records carry 4 or 12 bytes of metadata
//   version 6     names table; records carry 8 or 16 bytes of metadata
//   version 7     names table; the root has no metadata; records carry 8 bytes (files and
//                 groups) or none (directories and scripts)
//
// The name table names the build: the game's data database lists `spruce`, its core database
// `license`, workshop databases none. The version is reported, not gated — the structure is what
// is validated.
//
// ---------------------------------------------------------------------------
// A RECORD
//
//   u32LE  pathLen + 1           the path and its NUL terminator
//   bytes  path                  printable ASCII, `/` separated; 244 paths contain a space and
//                                a dozen contain `@ ! # ( ) +`, so the whole printable range is
//                                accepted
//   u8     0x00
//   u32LE  kind                  low 4 bits: 4 script, 5 directory, 6 file, 7 group;
//                                higher bits are flags (0x10 and 0x10000 observed)
//   u16LE  flags                 0 in every record checked
//   bytes  GUID                  8 bytes, little-endian; zero for a script record
//   bytes  metadata?             4, 8, 12 or 16 bytes — see below
//
// The `kind` is a base type plus flag bits, and the flags are meaningful: on the dedicated
// server's database, every kind-21/22/23 record — 35 461 of them — names a resource whose file is
// **not in any server pak**, while the client's copy has the same paths as plain 5/6/7 records.
// So 0x10 marks a record the build knows about but does not ship (the client's audio and textures,
// on the server). 0x10000 appears on exactly 9 Cain vegetation prefabs. `flags` is reported, not
// interpreted beyond that.
//
// The metadata exists exactly when a record is followed by bytes that are not themselves a record;
// the parser decides that from the data (a record's length field is small and its path printable, a
// timestamp is neither) and then requires the chain to continue, so the rule is checked rather than
// assumed. It is a whole number of 4-byte words:
//
//   8 bytes   `[mtime, type]` — version 7's files and groups, version 6's directories
//   16 bytes  two such pairs — version 6's files (the second pair is `[mtime, type]` as well)
//   4 bytes   one word, 0 in every version-5 copy checked — version 5's directories and root
//   12 bytes  three words — version 5's files (the middle one is the mtime; the other two are not
//             interpreted)
//
// `mtime` is the source file's time: identical in the client's and the server's copies for all
// 98 751 shared records that carry it, and equal to the matching pak entry's timestamp for two
// thirds of them (the rest were packed later than they were written). `type` is a 16-bit value
// (never above 0xFFFF), identical in both copies for the same path, 3 471 distinct values across
// the database, shared by similar resources — the resource's type id. The file does not map ids to
// names, so it is exposed as `type` and not interpreted further. Version 5's extra words are kept
// in `meta.words` and not given names.
//
// A script record (kind 4) carries no metadata and a zero GUID: scripts are source, not resources,
// so they are in `entries` and not in the GUID map.
//
// ---------------------------------------------------------------------------
// WHAT IS CHECKED, AND WHAT THE 8 PUBLISHED GUIDs ARE
//
// `scanRdb` validates the container prologue, the name table, the root record, every record, the
// record count from the header, and that the records end at the file's last byte. That is the
// format check and it applies to any database, vanilla or a mod's.
//
// The 8 GUIDs the BI wiki publishes for the vanilla scenarios are a **fixture**: the only
// external evidence for where in a record the GUID sits, and the only check that needs nothing
// but the file. They are 8 records of ~116 000, so `verify` reports them separately from the
// structural verdict: `ok` is the structure, `vanilla` is whether the 8 were present and matched.
// A contradiction (a published path with another GUID) is an error; absence is not.
//
// One GUID naming one path is a property of the installed databases, not of every database: 14 of
// the 228 copies checked reuse a GUID. That is the file's own ambiguity, so `verify` reports it
// (`unique: false`, `duplicateGuids`, `duplicatePaths`) and the map keeps the first record,
// deterministically, rather than refusing the file.
//
// ---------------------------------------------------------------------------
// MORE THAN ONE DATABASE
//
// A build ships two databases: `addons/data` names the game's resources, `addons/core` the
// engine's (configs, UI imagesets, scripts), and every installed addon brings its own. A world can
// reference resources from several of them, so `--rdb` is repeatable and the databases are merged
// into **one dictionary**: a GUID is the resource's identity, and a database is only where its path
// is written down.
//
// A MERGE IS A BIJECTION, CASE-INSENSITIVELY
//
// The dictionary is only well defined if it satisfies both of these, and a merge that does not is
// refused:
//
//   one GUID -> one path   An override re-declares a resource with the same GUID, so every record
//                          that carries that GUID, in every database, must use the same path. A
//                          different path — `configs/...` in one database and `Configs/System/...`
//                          in another — is a merge error (`sameGuidDifferentPaths`).
//   one path -> one GUID   Two different GUIDs must not share a path (`samePathDifferentGuids`).
//
// Case is not significant on either side: `Prefabs/X.et` and `prefabs/x.et` are the same path, and
// the first spelling is the one the dictionary reports. `verify-merge` lists every offender, and
// the callers (`merge`, `ebin --rdb`) refuse a merge that fails it rather than answering from one
// arbitrary path.
//
// The **order** of the databases is still the override order: when several of them name one GUID,
// `rdbs` lists them in command-line order, and the first database's fields win. That order has to
// follow the engine's mount order, which follows mod dependencies: a dependency is mounted before
// the addon that depends on it, so the dependent — the one that overrides — is listed first and the
// base game last. (`server.json`'s `mods` array is order-independent; the engine sorts by
// dependency. The tool cannot see those dependencies, so the caller supplies the order.)
//
// A consequence worth knowing: the vanilla `data`+`core` pair does **not** merge. They share 151
// GUIDs, and 149 of them name different paths (core's `configs/...` against data's
// `Configs/System/...`), so `verify-merge` reports 149 `sameGuidDifferentPaths` and the merge is
// refused. `data` alone names every resource the shipped worlds reference (the corpus resolves
// through core 0 times), and a mod that overrides a resource correctly repeats the path, so the
// useful pairs are `mod + data` and single databases.
//
// The text form is `<GUID> -> <path> rdb <indices>` with the indices from 1, or
// `<GUID> -> <path>` when only one database was given; JSON is
// `{ "<GUID>": { path, rdbs: [0-based indices] } }`.
//
// The parsing does not rest on those 8 pairs alone. On 1.8.0.13, two checks that use no hardcoded
// value agree with the mapping: every `{GUID}path` pair written in the game's own text resources
// (132 843 references in data007.pak, of which 132 786 resolve — 132 781 with the database's exact
// spelling and 5 more only when case is folded, which is why `findResource` folds it; the other 57
// are 42 engine resources that only `core`'s database names, 10 references to a path renamed since
// they were written, and 5 GUIDs no database on this machine carries), and the client's and
// server's copies agree on the GUID of all 116 375 records they share.
// `tests/rdb-tests.mjs` repeats the reference check when the game is installed, and fails if a pair
// that differs only in case stops resolving.
// ---------------------------------------------------------------------------

import { readFileSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";

export const MAGIC_FORM = "FORM";
export const MAGIC_RDBC = "RDBC";
/** The container prologue ends here; the header fields begin at this offset. */
const HEADER_START = 20;
/** The only version observed (client, server, workshop addons), reported but not gated. */
/** The installed build's version; 5 and 6 are the older formats (see the header). */
export const RDB_VERSION = 7;
const MAX_PATH = 4096;

/** Base kinds: the low four bits of the `kind` word. Higher bits are flags. */
export const KIND = Object.freeze({ SCRIPT: 4, DIRECTORY: 5, FILE: 6, GROUP: 7 });
const KIND_NAMES = new Map([[4, "script"], [5, "directory"], [6, "file"], [7, "group"]]);

const PRINTABLE = /^[\x20-\x7e]*$/;
const GUID_SHAPE = /^[0-9A-F]{16}$/;

/**
 * An error this reader raises deliberately, with a code a program can branch on instead of reading
 * English: `USAGE` (the command line was wrong), `PARSE` (the bytes are not a resource database),
 * `INPUT` (a database that parses but cannot be trusted to resolve through) or `ERROR`. `--json`
 * prints it as `{ ok: false, error: { code, message } }`, which is the shape `tools/etconf.mjs`
 * uses, so one parser handles both. Filesystem failures keep Node's own `code` and are reported as
 * `IO`.
 */
export class RdbError extends Error {
  constructor(message, code = "ERROR") {
    super(message);
    this.name = "RdbError";
    this.code = code;
  }
}

/**
 * The 8 GUIDs published on the BI wiki for the vanilla scenarios — a **fixture**, not the format
 * check. They are external evidence for the GUID's position inside a record (a shifted reader
 * cannot match them), and `verify` reports them separately from `ok`; a workshop database
 * contains none of them and is still a valid database.
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
 * Print four bytes as text when they are printable, as hex when they are not.
 *
 * The caller hands over a `latin1`-decoded **string**, whose characters are not numbers:
 * `"{".toString(16)` is `"{"`, so iterating the string and padding it produced `0{` for the byte
 * `0x7b` — a diagnostic that named neither the text nor the byte. The bytes are read back out of
 * the string before they are formatted.
 */
function showFour(text) {
  if (/^[\x20-\x7e]{4}$/.test(text)) return `"${text}"`;
  return [...Buffer.from(text, "latin1")].map((b) => b.toString(16).padStart(2, "0")).join(" ");
}

/**
 * Read one record at `at`, or return null when the bytes there are not a record.
 *
 * A record is `<u32 pathLen + 1><path><0x00><u32 kind><u16 flags><GUID 8>`. The check is
 * deliberately strict — the length must stay inside the file, the path must be printable and the
 * NUL must be where the length says — so that "is there a record here?" is a question the bytes
 * answer, and a record's optional metadata can be told apart from the next record.
 */
function recordAt(buf, at) {
  if (at < 0 || at + 20 > buf.length) return null;
  const len = buf.readUInt32LE(at);
  if (len < 1 || len > MAX_PATH) return null;
  const pathEnd = at + 3 + len;
  if (pathEnd >= buf.length) return null;
  if (buf[pathEnd] !== 0) return null;
  const pathBytes = buf.subarray(at + 4, pathEnd);
  if (!PRINTABLE.test(pathBytes.toString("latin1"))) return null;
  return {
    at,
    path: pathBytes.toString("latin1"),
    kind: buf.readUInt32LE(pathEnd + 1),
    flags: buf.readUInt16LE(pathEnd + 5),
    guid: Buffer.from(buf.subarray(pathEnd + 7, pathEnd + 15)).reverse().toString("hex").toUpperCase(),
    end: pathEnd + 15,
  };
}

/**
 * Read the container prologue and the header. Throws when the file is not an RDBC container, a
 * header field runs past its end, or the version is below 5. Versions 5, 6 and 7 are all read;
 * they differ in whether the header has a name table, and the version is reported, because the
 * structure is what the rest of the reader validates.
 */
export function readHeader(buf) {
  if (buf.length < HEADER_START) {
    throw new RdbError(`truncated resource database: ${buf.length} byte(s), the prologue is ${HEADER_START}`, "PARSE");
  }
  const magic = buf.toString("latin1", 0, 4);
  if (magic !== MAGIC_FORM) {
    throw new RdbError(`not a resource database: the prologue starts with ${showFour(magic)}, not "FORM"`, "PARSE");
  }
  const tag = buf.toString("latin1", 8, 12);
  if (tag !== MAGIC_RDBC) {
    throw new RdbError(`not a resource database: bytes 8..11 are ${showFour(tag)}, not "RDBC"`, "PARSE");
  }
  const formSize = buf.readUInt32BE(4);
  if (formSize !== buf.length - 8) {
    throw new RdbError(`the FORM length is ${formSize}, but the file has ${buf.length - 8} byte(s) after the ` +
      "8-byte prologue — truncated or padded", "PARSE");
  }
  const version = buf.readUInt32LE(12);
  const size = buf.readUInt32LE(16);
  if (size !== buf.length) {
    throw new RdbError(`the header says the file is ${size} byte(s), but it is ${buf.length} — truncated or padded`, "PARSE");
  }
  if (version < 5) {
    throw new RdbError(`unsupported resource database version ${version}: this reader understands versions 5, 6 and 7`, "PARSE");
  }

  let p = HEADER_START;
  const need = (n, what) => {
    if (p + n > buf.length) throw new RdbError(`the header is truncated: ${what} at offset ${p} runs past the file`, "PARSE");
  };
  need(8, "the flags and the name count");
  const flags = buf.readUInt32LE(p); p += 4;
  // Version 5 has no name table: the field after the flags is the record count.
  if (version <= 5) {
    const records = buf.readUInt32LE(p); p += 4;
    return { version, size, formSize, flags, names: [], records, body: p };
  }
  const nameCount = buf.readUInt32LE(p); p += 4;
  if (nameCount > (buf.length - p) / 5) {
    throw new RdbError(`the header claims ${nameCount} name(s), more than the file can hold`, "PARSE");
  }
  const names = [];
  for (let i = 0; i < nameCount; i++) {
    need(4, `name ${i}'s length`);
    const len = buf.readUInt32LE(p); p += 4;
    if (len < 1) throw new RdbError(`name ${i} has length ${len}; the length counts the NUL, so it is at least 1`, "PARSE");
    need(len, `name ${i} (${len} bytes)`);
    const bytes = buf.subarray(p, p + len);
    if (bytes[len - 1] !== 0) throw new RdbError(`name ${i} is not NUL-terminated at offset ${p + len - 1}`, "PARSE");
    const text = bytes.subarray(0, len - 1).toString("utf8");
    if (!PRINTABLE.test(text)) throw new RdbError(`name ${i} is not printable: ${JSON.stringify(text)}`, "PARSE");
    names.push(text);
    p += len;
  }
  need(4, "the record count");
  const records = buf.readUInt32LE(p); p += 4;
  return { version, size, formSize, flags, names, records, body: p };
}

/**
 * Parse a resource database. `input` is a path, or the bytes themselves (a `Buffer`/`Uint8Array`),
 * which keeps the reader usable in a test that builds a database instead of finding one; `name`
 * labels a byte input in errors and in `file`, and defaults to `"<buffer>"`.
 *
 * Returns:
 *   { file, bytes, header, root, entries, map, kinds, metadata, extensions }
 *
 * `entries` is every record except the root, in file order, each `{ path, kind, flags, guid, meta }`
 * where `meta` is `{ mtime, type }` or null. `map` is GUID -> path for the entries that have a
 * GUID (scripts do not), first record wins. `kinds` counts the raw kind words, `metadata` counts
 * the entries with metadata, and `extensions` counts paths by extension.
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
    // Every one of them is a PARSE: `readHeader` only ever refuses bytes.
    throw new RdbError(`${file}: ${err.message}`, "PARSE");
  }

  const root = recordAt(buf, header.body);
  if (root === null) throw new RdbError(`${file}: no root record at ${header.body} (the header ends there)`, "PARSE");
  if (root.path !== "") throw new RdbError(`${file}: the root record has path ${JSON.stringify(root.path)}, not ""`, "PARSE");

  /**
   * Where the next record starts, and the record's metadata when it has one.
   *
   * The metadata is 4-byte words: none, one (version 5's directories, always 0 in the copy
   * checked), two (version 7's files and groups — `[mtime, type]`), three (version 5's files) or
   * four (version 6's files, two `[mtime, type]` pairs). Which length applies is decided by the
   * bytes — a timestamp is not a small length followed by a printable path — so exactly one of
   * `end`, `end + 4`, `end + 8`, `end + 12`, `end + 16` is a record or the end of the file. The
   * chosen length is then validated by the record that follows; a wrong guess cannot pass
   * silently. Words beyond the `[mtime, type]` pair that is understood are exposed as they are.
   */
  const step = (e, at) => {
    for (const size of [0, 4, 8, 12, 16]) {
      const next = e.end + size;
      if (next > buf.length) continue;
      if (next === buf.length || recordAt(buf, next) !== null) {
        if (!size) return { meta: null, next };
        const words = [];
        for (let o = e.end; o + 4 <= next; o += 4) words.push(buf.readUInt32LE(o));
        const meta = { words };
        if (size === 8) { meta.mtime = words[0]; meta.type = words[1]; }
        if (size === 16) {
          meta.mtime = words[0]; meta.type = words[1];
          meta.extra = { mtime: words[2], type: words[3] };
        }
        return { meta, next };
      }
    }
    throw new RdbError(`${file}: record ${JSON.stringify(e.path)} at ${at} is not followed by a record ` +
      "at +0, +4, +8, +12 or +16 bytes, nor by the end of the file", "PARSE");
  };

  const rootStep = step(root, root.at);
  root.meta = rootStep.meta;

  const entries = [];
  const map = new Map();
  const kinds = new Map();
  const extensions = new Map();
  let metadata = 0;
  let at = rootStep.next;
  while (at < buf.length) {
    const e = recordAt(buf, at);
    if (e === null) {
      throw new RdbError(`${file}: no record at offset ${at} (byte 0x${buf[at].toString(16)}), ` +
        `${buf.length - at} byte(s) before the end`, "PARSE");
    }
    const { meta, next } = step(e, at);
    if (meta) metadata++;
    const base = e.kind & 0x0f;
    const entry = { path: e.path, kind: e.kind, base, flags: e.flags, guid: e.guid, meta };
    entries.push(entry);
    kinds.set(e.kind, (kinds.get(e.kind) ?? 0) + 1);
    const dot = e.path.lastIndexOf(".");
    const ext = dot > e.path.lastIndexOf("/") ? e.path.slice(dot).toLowerCase() : "(none)";
    extensions.set(ext, (extensions.get(ext) ?? 0) + 1);
    if (e.guid !== "0000000000000000") {
      if (GUID_SHAPE.test(e.guid) && !map.has(e.guid)) map.set(e.guid, e.path);
    }
    at = next;
  }
  if (at !== buf.length) throw new RdbError(`${file}: the records do not reach the end of the file (${at} of ${buf.length})`, "PARSE");
  if (entries.length !== header.records - 1) {
    throw new RdbError(`${file}: the header says ${header.records} record(s) including the root, ` +
      `but ${entries.length + 1} were parsed`, "PARSE");
  }
  return { file, bytes: buf.length, header, root, entries, map, kinds, metadata, extensions };
}

/**
 * Build a GUID -> path map, which is all most callers need. `scanRdb` is the same read when the
 * record classes, the header or the metadata are the question.
 */
export function readRdb(input, options = {}) {
  return scanRdb(input, options).map;
}

/**
 * The other direction: path -> GUID. A `.conf` read out of a pak names its world by path, and the
 * GUID a `server.json` needs is this lookup. Where two GUIDs claim one path the first record wins,
 * exactly as `scanRdb` keeps the first GUID; `verify` reports whether that happened at all.
 *
 * **This map is exact-case.** The game's own references are not: five `{GUID}path` pairs written in
 * its text resources spell the path in another case than the database does, and the merge treats a
 * case difference as the same resource. `findResource` is the lookup a caller wants; this one is
 * the raw map, which `verify` needs because the 8 published paths are spelled exactly.
 */
export function reverseRdb(map) {
  const out = new Map();
  for (const [guid, path] of map) if (!out.has(path)) out.set(path, guid);
  return out;
}

/**
 * Path -> GUID, **case-insensitively**: `Missions/cah_morton.conf` finds the record stored as
 * `Missions/CAH_Morton.conf`, because a path is typed from a pak listing, a log line or a reference
 * read out of another resource, and none of those guarantee the spelling the database holds. Paths
 * are compared with `\` folded to `/` first, so a Windows path works too.
 *
 * `exact` wins over a case difference, so two records that differ only in case still resolve to
 * themselves; where two records have one path, the first in GUID order wins, as everywhere else.
 * The answer carries the **database's** spelling, which is the one to paste into a resource
 * reference.
 */
export function findResource(map, path) {
  const wanted = String(path).replace(/\\/g, "/");
  const byPath = reverseRdb(map);
  const exact = byPath.get(wanted);
  if (exact !== undefined) return { guid: exact, path: wanted };
  const folded = pathIndex(map).get(wanted.toLowerCase());
  return folded ?? null;
}

/**
 * The same lookup pre-built: lowercase path -> `{ guid, path }`, first spelling wins. `findResource`
 * builds one per call, which is right for one query; a caller resolving many references builds it
 * once.
 */
export function pathIndex(map) {
  const index = new Map();
  for (const [guid, path] of map) {
    const key = path.toLowerCase();
    if (!index.has(key)) index.set(key, { guid, path });
  }
  return index;
}


/** The descriptors every merged answer and every `--json` envelope starts with (0-based order). */
function describeDatabases(scanned) {
  return scanned.map((db) => ({
    file: db.file,
    bytes: db.bytes,
    version: db.header.version,
    records: db.header.records,
    guids: db.map.size,
  }));
}

/**
 * Check whether the given databases merge into one GUID <-> path dictionary.
 *
 * A valid merge is a **bijection, case-insensitively**, and both directions are checked:
 *
 *   - **one GUID names one path.** An override re-declares a resource with the same GUID, so every
 *     record that carries that GUID — in every database — must use the same path. A different path
 *     is `sameGuidDifferentPaths`.
 *   - **one path names one GUID.** Two different GUIDs must not share a path; that is
 *     `samePathDifferentGuids`.
 *
 * A case difference (`Prefabs/X.et` against `prefabs/x.et`) is not a violation: the game's
 * references are case-insensitive, and the first spelling is the one the merge reports. Both lists
 * hold every distinct offender rather than every record, each with the databases and the spellings
 * that disagree. `rdb` indices are **0-based** — the position in `rdbs`, which is what JSON uses;
 * the text form prints them from 1.
 */
export function verifyMerge(scanned) {
  const byGuid = new Map(); // guid -> { guid, paths: Map<lower, { path, rdb }> }
  const byPath = new Map(); // lower -> { path, guids: Map<guid, { guid, rdb }> }
  scanned.forEach((db, rdb) => {
    for (const e of db.entries) {
      if (!GUID_SHAPE.test(e.guid) || e.guid === "0000000000000000") continue;
      const lower = e.path.toLowerCase();
      let g = byGuid.get(e.guid);
      if (!g) { g = { guid: e.guid, paths: new Map() }; byGuid.set(e.guid, g); }
      if (!g.paths.has(lower)) g.paths.set(lower, { rdb, path: e.path });
      let p = byPath.get(lower);
      if (!p) { p = { path: e.path, guids: new Map() }; byPath.set(lower, p); }
      if (!p.guids.has(e.guid)) p.guids.set(e.guid, { rdb, guid: e.guid });
    }
  });
  const sameGuidDifferentPaths = [...byGuid.values()]
    .filter((g) => g.paths.size > 1)
    .map((g) => ({
      guid: g.guid,
      records: [...g.paths.values()].map((x) => ({ rdb: x.rdb, path: x.path })),
    }));
  const samePathDifferentGuids = [...byPath.values()]
    .filter((p) => p.guids.size > 1)
    .map((p) => ({
      path: p.path,
      records: [...p.guids.values()].map((x) => ({ rdb: x.rdb, guid: x.guid })),
    }));
  return {
    ok: sameGuidDifferentPaths.length === 0 && samePathDifferentGuids.length === 0,
    rdbs: describeDatabases(scanned),
    guids: byGuid.size,
    paths: byPath.size,
    sameGuidDifferentPaths,
    samePathDifferentGuids,
  };
}

/**
 * One GUID -> path dictionary built from a **valid** merge, with the databases that name each
 * resource, in the order they were given.
 *
 * `resolve` is the only lookup a caller needs: it returns `{ path, rdbs }` — `rdbs` is the list of
 * 0-based database indices, first one first — or `null` when no database names the GUID. A single
 * database always yields one index, so a caller that was given one can drop the suffix. `databases`
 * describes the files that were merged, in the same order, and `resources()` is the
 * `{ "<GUID>": { path, rdbs } }` dictionary.
 */
export class MergedRdb {
  constructor(databases, map) {
    this.databases = databases;
    this.map = map;
  }
  /** How many databases were merged. */
  get count() { return this.databases.length; }
  /** How many GUIDs the dictionary names. */
  get size() { return this.map.size; }
  /** True when more than one database was given, which is when the text form prints the indices. */
  get multi() { return this.databases.length > 1; }
  resolve(guid) {
    const found = this.map.get(guid);
    return found ? { path: found.path, rdbs: [...found.rdbs] } : null;
  }
  /** The path alone, or `null`: the same answer as `readRdb` for a single database. */
  path(guid) { return this.map.get(guid)?.path ?? null; }
  /** The dictionary in the JSON shape, 0-based: `{ "<GUID>": { path, rdbs } }`. */
  resources({ sharedOnly = false } = {}) {
    const out = {};
    for (const [guid, found] of this.map) {
      if (sharedOnly && found.rdbs.length < 2) continue;
      out[guid] = { path: found.path, rdbs: [...found.rdbs] };
    }
    return out;
  }
  /** `{ rdbs, resources }`, for `merge --json`. */
  json(options) {
    return { rdbs: this.databases, resources: this.resources(options) };
  }
}

/**
 * Build the dictionary from scanned databases. **Validate first** with `verifyMerge`: this keeps
 * the first spelling of a GUID and the databases that name it, so an invalid merge would silently
 * answer with the first path. `openRdbFiles` is the checked path.
 */
export function mergeRdb(scanned) {
  if (!scanned.length) throw new RdbError("mergeRdb needs at least one database", "USAGE");
  const map = new Map();
  scanned.forEach((db, rdb) => {
    for (const [guid, path] of db.map) {
      const found = map.get(guid);
      if (!found) { map.set(guid, { path, rdbs: [rdb] }); continue; }
      if (!found.rdbs.includes(rdb)) found.rdbs.push(rdb);
    }
  });
  return new MergedRdb(describeDatabases(scanned), map);
}

/**
 * The merge problems as a sentence, for a caller that refuses the merge — every offender up to
 * `limit`, with the databases named from 1 (the text convention).
 */
export function describeMergeProblems(check, limit = 3) {
  const parts = [];
  if (check.sameGuidDifferentPaths.length) {
    const sample = check.sameGuidDifferentPaths.slice(0, limit).map((p) =>
      `{${p.guid}}: ` + p.records.map((r) => `RDB #${r.rdb + 1} ${JSON.stringify(r.path)}`).join(" | "));
    const more = check.sameGuidDifferentPaths.length > limit
      ? ` (and ${check.sameGuidDifferentPaths.length - limit} more)` : "";
    parts.push(`${check.sameGuidDifferentPaths.length} GUID(s) name more than one path — every ` +
      `record of a GUID must use the same path: ${sample.join("; ")}${more}`);
  }
  if (check.samePathDifferentGuids.length) {
    const sample = check.samePathDifferentGuids.slice(0, limit).map((p) =>
      `${JSON.stringify(p.path)}: ` + p.records.map((r) => `RDB #${r.rdb + 1} {${r.guid}}`).join(" | "));
    const more = check.samePathDifferentGuids.length > limit
      ? ` (and ${check.samePathDifferentGuids.length - limit} more)` : "";
    parts.push(`${check.samePathDifferentGuids.length} path(s) are named by more than one GUID: ` +
      `${sample.join("; ")}${more}`);
  }
  return parts.join("; ");
}

/**
 * Scan, verify and merge databases in one call — the whole "resolve through several addons" path.
 *
 * Every database is checked exactly as a single `--rdb` is: `scanRdb` parses the container, then
 * `verifyRdb` refuses an empty database or a published path carrying another GUID. Those are
 * structural refusals and throw. The merge itself is checked too, but its violations are returned
 * (`check`) rather than thrown, so `verify-merge` can print them and `merge`/`--rdb` can decide to
 * refuse — a merge that does not satisfy the one-GUID-one-path rule yields `merged: null`.
 *
 * Passing the same file twice is refused: it is a command-line mistake, and silently deduplicating
 * it would hide which index the paths came from.
 */
export function openRdbFiles(paths) {
  const seen = new Map();
  const scanned = paths.map((path) => {
    const key = resolvePath(path).toLowerCase();
    if (seen.has(key)) {
      throw new RdbError(`${path}: the same database was passed twice (already read as ${seen.get(key)}) — ` +
        "one copy is enough, and a second index would claim paths it does not own", "USAGE");
    }
    seen.set(key, path);
    const db = scanRdb(path);
    const check = verifyRdb(db);
    if (!check.ok) {
      const problems = [];
      if (check.contradicted.length) {
        const sample = check.contradicted.slice(0, 3)
          .map((f) => `${f.path} is {${f.found}}, the wiki publishes {${f.expected}}`);
        problems.push(`the published GUIDs contradict it: ${sample.join("; ")}`);
      }
      if (!check.records) problems.push("it contains no records");
      throw new RdbError(`${path}: refusing to resolve through this database — ${problems.join("; ")}. ` +
        "No path it yields is confirmed.", "INPUT");
    }
    return db;
  });
  const check = verifyMerge(scanned);
  return { merged: check.ok ? mergeRdb(scanned) : null, check };
}

/**
 * Check a scanned database: the container and the records are already validated by `scanRdb`, so
 * this checks the mapping and compares the database with the **fixture** of 8 published vanilla
 * GUIDs.
 *
 * The answers are deliberately separate:
 *   - `ok` — the structural check, and the one `ebin --rdb` requires: the file parsed, it has
 *     records, and no published pair contradicts it. True for a workshop database.
 *   - `vanilla` — whether all 8 published pairs were present and reproduced.
 *   - `unique` — whether one GUID names one path and one path one GUID. The installed databases
 *     are one-to-one; some workshop ones reuse a GUID, which is the database's own ambiguity, so
 *     it is reported (`duplicateGuids`, `duplicatePaths`) rather than called a parse failure. The
 *     map keeps the first record, deterministically.
 *
 * `contradicted` are the pairs whose path is present with a *different* GUID: that is the layout
 * disagreeing with itself, and it is an error. `missing` are the pairs absent altogether.
 */
export function verifyRdb(db, { known = PUBLISHED_GUIDS } = {}) {
  const byPath = reverseRdb(db.map);
  const checks = Object.entries(known).map(([path, expected]) => {
    const found = byPath.get(path) ?? null;
    return { path, expected, found, present: found !== null, ok: found === expected };
  });
  const contradicted = checks.filter((c) => c.present && !c.ok);
  const missing = checks.filter((c) => !c.present);
  const withGuid = db.entries.filter((e) => e.guid !== "0000000000000000").length;
  const uniqueGuids = db.map.size;
  const uniquePaths = byPath.size;
  const duplicateGuids = withGuid - uniqueGuids;
  const duplicatePaths = withGuid - uniquePaths;
  const unique = duplicateGuids === 0 && duplicatePaths === 0;
  return {
    file: db.file,
    bytes: db.bytes,
    header: db.header,
    records: db.entries.length,
    withGuid,
    withoutGuid: db.entries.length - withGuid,
    uniqueGuids,
    uniquePaths,
    unique,
    duplicateGuids,
    duplicatePaths,
    checks,
    contradicted,
    missing,
    vanilla: missing.length === 0 && contradicted.length === 0,
    ok: db.entries.length > 0 && contradicted.length === 0,
  };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Read resourceDatabase.rdb — the resource GUID table (GUID <-> path)

  node tools/rdb.mjs get          <rdb> <guid> [--json]
  node tools/rdb.mjs guid         <rdb> <path> [--json]
  node tools/rdb.mjs list         <rdb> [regex] [--limit N|0] [--json]
  node tools/rdb.mjs info         <rdb> [--json]
  node tools/rdb.mjs verify       <rdb> [--json]
  node tools/rdb.mjs merge        <rdb>... [--limit N|0] [--json]
  node tools/rdb.mjs verify-merge <rdb>... [--json]

The database is <install>/addons/data/resourceDatabase.rdb (~11 MB): a FORM/RDBC container with a
header (flags, names, record count), a root record, and then records for files, directories, groups
and scripts, each with a path, a kind and — except for scripts — a GUID. It is the only shipped
place that maps a resource GUID to its path. \`get\` exits 1 when the GUID names nothing; \`verify\`
checks the structure, the one-to-one mapping, and separately the 8 GUIDs the BI wiki publishes for
the vanilla scenarios (a workshop database legitimately has none of them).

\`merge\` reads several databases as one dictionary: one GUID -> one path, case-insensitively. A
GUID may be declared by several databases (an override), but every one of them must use the same
path, and no two GUIDs may share a path — otherwise the merge is refused and \`verify-merge\` lists
the offenders. The order is the override order: the first database's fields win, and every text row
ends with \`rdb <indices from 1>\`; JSON is \`{ "<GUID>": { path, rdbs: [0-based indices] } }\`
indexing the leading \`rdbs\` array.

Arguments
  <guid>          with or without braces; case does not matter
  <path>          resource path, forward slashes; backslashes are converted
  [regex]         case-insensitive match on the path
  <rdb>...        \`merge\`/\`verify-merge\` only: one or more databases, **in override order** (the
                  one that wins first; addons before the base game, dependents before their
                  dependencies)

Options
  --limit N       maximum rows to print (default 100; 0 = every one) — \`list\` and \`merge\`
  --all           same as --limit 0 — \`list\` and \`merge\`
  --json          machine-readable output (indices from 0, into the \`rdbs\` array)

An option a command does not take is refused by name rather than ignored: \`verify --limit 5\` would
otherwise read as a honoured request and print every row anyway.

Every failure exits 1. Under \`--json\` a failure is one object on stdout, \`{ ok: false, error:
{ code, message } }\`, where \`code\` is \`USAGE\` (the command line), \`PARSE\` (the bytes are not a
resource database), \`INPUT\` (a database that parses but cannot be trusted to resolve through),
\`IO\` (the file could not be read) or \`ERROR\` — so a program can tell "I called it wrong" from
"the database is broken" without reading English. A GUID or a path that simply is not in the
database is not a failure of that kind: \`get\`/\`guid\` also exit 1, and their \`--json\` answer is
\`{ path: null }\` / \`{ guid: null }\`.
`;

/** A bad command line: reported with the usage, and the exit status is 1. */
function usageError(message) {
  return new RdbError(message, "USAGE");
}

/**
 * The options each command takes, besides \`--json\`/\`--help\`. \`--limit\` and \`--all\` bound rows, and
 * only \`list\` and \`merge\` print rows; the other five answer with one record or one verdict. A
 * command that accepted a cap it does not apply would change nothing and say nothing, which is the
 * one failure a caller cannot detect — the same rule \`pak\`, \`loc\`, \`etconf\`, \`ebin\`, \`cscript\` and
 * \`layer\` follow.
 */
const COMMAND_OPTIONS = Object.freeze({
  get: Object.freeze([]),
  guid: Object.freeze([]),
  list: Object.freeze(["limit", "all"]),
  info: Object.freeze([]),
  verify: Object.freeze([]),
  merge: Object.freeze(["limit", "all"]),
  "verify-merge": Object.freeze([]),
});
const GLOBAL_OPTIONS = Object.freeze(["json", "help"]);

function parseArgs(argv) {
  const flags = { _: [], seen: new Set() };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json") { flags.json = true; flags.seen.add("json"); }
    else if (a === "--all") { flags.all = true; flags.seen.add("all"); }
    else if (a === "--limit") {
      const raw = argv[++i];
      if (raw === undefined || raw.startsWith("--")) throw usageError("--limit needs a value");
      if (!/^\d+$/.test(raw)) throw usageError(`--limit needs a non-negative whole number, not "${raw}"`);
      const n = Number(raw);
      if (!Number.isSafeInteger(n)) throw usageError(`--limit is too large: ${raw}`);
      flags.limit = n;
      flags.seen.add("limit");
    } else if (a === "-h" || a === "--help") { flags.help = true; flags.seen.add("help"); }
    // An option this tool does not know would otherwise change the answer silently.
    else if (a.startsWith("-") && a !== "-") throw usageError(`unknown option "${a}"`);
    else flags._.push(a);
  }
  return flags;
}

/** Refuse an option the command does not take, naming the command the way the user typed it. */
function checkCommandOptions(command, flags) {
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) return; // an unknown command is named by the switch
  const allowed = new Set([...GLOBAL_OPTIONS, ...COMMAND_OPTIONS[command]]);
  for (const option of flags.seen) {
    if (!allowed.has(option)) throw usageError(`${command} does not take --${option}`);
  }
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

function kindName(kind) {
  return KIND_NAMES.get(kind & 0x0f) ?? `kind ${kind & 0x0f}`;
}

function kindLabel(kind) {
  const base = kindName(kind);
  const flags = kind & ~0x0f;
  return flags ? `${base}+0x${flags.toString(16)}` : base;
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
  // Case-insensitive, and backslashes folded: the path is usually typed from somewhere that did not
  // keep the database's spelling, and a false "no resource at …" is indistinguishable from a real
  // miss. The answer prints the database's spelling, which is the one a reference has to use.
  const found = findResource(db.map, raw);
  const guid = found?.guid ?? null;
  const path = found?.path ?? raw.replace(/\\/g, "/");
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
  for (const e of db.entries) {
    if (re && !re.test(e.path)) continue;
    total++;
    if (rows.length < limit) rows.push(e);
  }
  const json = (e) => ({
    guid: e.guid === "0000000000000000" ? null : e.guid,
    path: e.path,
    kind: e.kind,
    type: kindLabel(e.kind),
    meta: e.meta,
  });
  if (flags.json) {
    // An envelope, not a bare array: the default stops at 100 rows, and without `total` a caller
    // cannot tell a complete database from a truncated list.
    console.log(JSON.stringify({
      file: db.file,
      total,
      returned: rows.length,
      truncated: rows.length < total,
      filter: pattern ?? null,
      entries: rows.map(json),
    }, null, 2));
    return;
  }
  for (const e of rows) {
    const guid = e.guid === "0000000000000000" ? "----------------" : e.guid;
    console.log(`{${guid}}  ${kindLabel(e.kind)}  ${e.path}`);
  }
  if (rows.length < total) console.log(`... ${total - rows.length} more (--limit 0 for all)`);
}

function kindHistogram(db) {
  return [...db.kinds].sort((a, b) => b[1] - a[1]).map(([kind, count]) => ({ kind, type: kindLabel(kind), count }));
}

function cmdInfo(db, flags) {
  const extensions = [...db.extensions].sort((a, b) => b[1] - a[1]);
  const metaWidths = new Map();
  for (const e of db.entries) {
    if (!e.meta) continue;
    const bytes = e.meta.words.length * 4;
    metaWidths.set(bytes, (metaWidths.get(bytes) ?? 0) + 1);
  }
  const info = {
    file: db.file,
    bytes: db.bytes,
    header: db.header,
    root: db.root,
    records: db.entries.length,
    withGuid: db.entries.filter((e) => e.guid !== "0000000000000000").length,
    kinds: kindHistogram(db),
    metadata: { records: db.metadata, widths: Object.fromEntries([...metaWidths].sort((a, b) => a[0] - b[0])) },
    extensions: Object.fromEntries(extensions),
  };
  if (flags.json) { console.log(JSON.stringify(info, null, 2)); return; }
  console.log(`${db.file}`);
  console.log(`  container     FORM/RDBC version ${db.header.version}, ${db.bytes} bytes ` +
    "(header sizes and file length agree)");
  console.log(`  header        flags ${db.header.flags}, names ${JSON.stringify(db.header.names)}, ` +
    `${db.header.records} record(s) including the root`);
  console.log(`  records       ${info.records} (${info.withGuid} with a GUID, ` +
    `${info.records - info.withGuid} without); the header's count matches`);
  console.log(`  kinds         ${info.kinds.map((k) => `${k.type} ${k.count}`).join(", ")}`);
  const widths = [...metaWidths].sort((a, b) => a[0] - b[0]).map(([bytes, n]) => `${bytes} B ${n}`).join(", ");
  console.log(`  metadata      ${info.metadata.records} record(s)${widths ? ` (${widths})` : ""}`);
  const shown = extensions.slice(0, 6).map(([ext, n]) => `${ext} ${n}`).join(", ");
  console.log(`  extensions    ${extensions.length} kind(s): ${shown}${extensions.length > 6 ? ", ..." : ""}`);
}

function cmdVerify(db, flags) {
  const result = verifyRdb(db);
  // Three separate answers: the structure (`ok`) applies to any database; the published GUIDs are
  // a fixture that only a vanilla database carries; duplicate GUIDs are the database's own
  // ambiguity, reported and not a parse failure. A contradiction is an error.
  const problems = [];
  if (result.contradicted.length) {
    problems.push(`the published GUIDs contradict this database: ` +
      result.contradicted.map((f) => `${f.path} is {${f.found}}, the wiki publishes {${f.expected}}`).join("; "));
  }
  if (!result.records) problems.push("it contains no records");
  const notes = [];
  if (!result.unique) {
    notes.push(`${result.duplicateGuids} record(s) repeat a GUID and ${result.duplicatePaths} repeat a path; ` +
      "the map keeps the first of each, deterministically");
  }
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
      withGuid: result.withGuid,
      withoutGuid: result.withoutGuid,
      uniqueGuids: result.uniqueGuids,
      uniquePaths: result.uniquePaths,
      unique: result.unique,
      duplicateGuids: result.duplicateGuids,
      duplicatePaths: result.duplicatePaths,
      kinds: kindHistogram(db),
      metadata: db.metadata,
      published,
      checks: result.checks,
      contradicted: result.contradicted.map((f) => f.path),
      missing: result.missing.map((f) => f.path),
      problems,
      notes,
    }, null, 2));
  } else {
    console.log(`${db.file}`);
    console.log(`  container    FORM/RDBC version ${db.header.version}, ${db.bytes} bytes (sizes agree)`);
    console.log(`  header       flags ${db.header.flags}, names ${JSON.stringify(db.header.names)}, ` +
      `${db.header.records} record(s) including the root (matches)`);
    console.log(`  records      ${result.records}: ${result.withGuid} with a GUID, ${result.withoutGuid} without`);
    console.log(`  mapping      ${result.uniqueGuids} unique GUID(s), ${result.uniquePaths} unique path(s)` +
      (result.unique ? "" : "  (not one-to-one)"));
    console.log(`  published    ${published}`);
    for (const n of notes) console.log(`  note         ${n}`);
    if (problems.length) for (const l of problems) console.log(`  FAIL  ${l}`);
    else console.log("  ok");
  }
  if (!result.ok) process.exitCode = 1;
}

/**
 * The merge check: what each database holds, and whether the set satisfies the one-GUID-one-path
 * rule in both directions. This is the diagnostic behind a refused `merge`/`--rdb`.
 *
 * The text form prints every offender with the databases from 1; `--json` is the `verifyMerge`
 * result, whose `rdb` indices are 0-based (the position in `rdbs`, the same array a per-GUID
 * `rdbs` indexes into). Exit 1 when the set does not merge.
 */
function cmdVerifyMerge(flags) {
  const paths = flags._.slice(1);
  if (paths.length < 1) throw usageError("verify-merge needs at least one <rdb>: node tools/rdb.mjs verify-merge a.rdb [b.rdb ...]");
  const { check } = openRdbFiles(paths);
  if (flags.json) {
    console.log(JSON.stringify(check, null, 2));
    if (!check.ok) process.exitCode = 1;
    return;
  }
  console.log(`merge check: ${check.rdbs.length} database(s)`);
  check.rdbs.forEach((d, i) => {
    console.log(`  RDB #${i + 1}  ${d.file}  (version ${d.version}, ${d.records} record(s), ${d.guids} GUID(s))`);
  });
  console.log(`  ${check.guids} GUID(s), ${check.paths} path(s): ${check.ok ? "one-to-one" : "NOT one-to-one"} ` +
    "(case-insensitive)");
  for (const p of check.sameGuidDifferentPaths) {
    console.log(`  FAIL  {${p.guid}} names ${p.records.length} path(s)`);
    for (const r of p.records) console.log(`          RDB #${r.rdb + 1}  ${r.path}`);
  }
  for (const p of check.samePathDifferentGuids) {
    console.log(`  FAIL  ${JSON.stringify(p.path)} is named by ${p.records.length} GUID(s)`);
    for (const r of p.records) console.log(`          RDB #${r.rdb + 1}  {${r.guid}}`);
  }
  if (check.ok) console.log("  ok");
  else process.exitCode = 1;
}

/**
 * The merged dictionary: the databases, then every GUID that more than one of them names, as
 * `<GUID> -> <path> rdb <indices from 1>` — the order being the override order, the first index
 * winning. A single database has nothing to merge, so it is reported and the dictionary is left to
 * `--json`.
 *
 * `--json` is `{ rdbs, resources: { "<GUID>": { path, rdbs } } }` with 0-based indices into
 * `rdbs`; a set that does not merge answers with the `verify-merge` report instead and exits 1.
 * `--limit`/`--all` control the text rows (default 100); JSON is complete.
 */
function cmdMerge(flags) {
  const paths = flags._.slice(1);
  if (paths.length < 1) throw usageError("merge needs at least one <rdb>: node tools/rdb.mjs merge a.rdb [b.rdb ...]");
  const { merged, check } = openRdbFiles(paths);
  if (!check.ok) {
    if (flags.json) {
      console.log(JSON.stringify({ ...check, resources: null }, null, 2));
    } else {
      console.log(`resource databases: ${check.rdbs.length}`);
      check.rdbs.forEach((d, i) => {
        console.log(`  RDB #${i + 1}  ${d.file}  (version ${d.version}, ${d.records} record(s), ${d.guids} GUID(s))`);
      });
      console.log(`  FAIL  the databases do not merge: ${describeMergeProblems(check, 10)}`);
      console.log("  Run `node tools/rdb.mjs verify-merge <rdb>...` for the full list.");
    }
    process.exitCode = 1;
    return;
  }
  if (flags.json) { console.log(JSON.stringify(merged.json(), null, 2)); return; }
  console.log(`resource databases: ${merged.count}`);
  merged.databases.forEach((d, i) => {
    console.log(`  RDB #${i + 1}  ${d.file}  (version ${d.version}, ${d.records} record(s), ${d.guids} GUID(s))`);
  });
  console.log(`  ${merged.size} GUID(s), ${check.paths} path(s): one-to-one (case-insensitive)`);
  const shared = Object.entries(merged.resources({ sharedOnly: true }));
  if (!merged.multi) {
    console.log("  one database: there is nothing to merge; use --json for its dictionary");
    return;
  }
  if (!shared.length) { console.log("  no GUID is named by more than one database"); return; }
  const limit = rowLimit(flags, 100);
  for (const [guid, r] of shared.slice(0, limit)) {
    console.log(`  {${guid}} -> ${r.path}  rdb ${r.rdbs.map((i) => i + 1).join(" ")}`);
  }
  if (shared.length > limit) console.log(`  ... ${shared.length - limit} more (--limit 0 for all)`);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  // `--help` is a request, not a failure; no arguments at all is a mistake.
  if (flags.help) { process.stdout.write(USAGE); return; }
  if (flags._.length === 0) {
    throw usageError("no command: name one of get, guid, list, info, verify, merge, verify-merge");
  }
  const [command, rdbPath] = flags._;
  checkCommandOptions(command, flags);
  if (command === "merge") { cmdMerge(flags); return; }
  if (command === "verify-merge") { cmdVerifyMerge(flags); return; }
  if (rdbPath === undefined) {
    throw usageError(`${command} needs a <rdb>: the database is <install>/addons/data/resourceDatabase.rdb`);
  }
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

/** Node's own codes that mean one thing here: the input could not be read. */
const IO_CODES = new Set(["ENOENT", "EISDIR", "ENOTDIR", "EACCES", "EPERM", "EBUSY", "ENOSPC", "EMFILE", "ENFILE"]);

/** The failure as a code a program can branch on, instead of a sentence it has to read. */
function errorCode(err) {
  if (err instanceof RdbError) return err.code;
  if (typeof err.code === "string") return IO_CODES.has(err.code) ? "IO" : err.code;
  return "ERROR";
}

/**
 * Report a failure the way the caller asked for it: one JSON object on stdout under `--json` —
 * `{ ok: false, error: { code, message } }`, the shape `tools/etconf.mjs` prints, so one parser
 * handles both tools — and the sentence on stderr otherwise, followed by the usage when the command
 * line was the mistake. The exit status is 1 either way; a `--json` caller branches on `code`.
 *
 * `--json` is read from the raw argv, because the command line may be exactly what failed to parse.
 */
function reportError(err, { json = false } = {}) {
  const code = errorCode(err);
  if (json) {
    console.log(JSON.stringify({ ok: false, error: { code, message: err.message } }, null, 2));
  } else {
    process.stderr.write(`error: ${err.message}\n`);
    if (code === "USAGE") process.stderr.write(`\n${USAGE}`);
  }
  process.exitCode = 1;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  const argv = process.argv.slice(2);
  try {
    main();
  } catch (err) {
    reportError(err, { json: argv.includes("--json") });
  }
}