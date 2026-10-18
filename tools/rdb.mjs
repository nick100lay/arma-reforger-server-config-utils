// Read resourceDatabase.rdb — the resource GUID table: GUID -> path, and back.
//
//   node tools/rdb.mjs get    <rdb> <guid> [--json]
//   node tools/rdb.mjs guid   <rdb> <path> [--json]
//   node tools/rdb.mjs list   <rdb> [regex] [--limit N|0] [--json]
//   node tools/rdb.mjs info   <rdb> [--json]
//   node tools/rdb.mjs verify <rdb> [--json]
//   node tools/rdb.mjs merge  <rdb>... [--json]
//
// Also usable as a library:
//   import { readRdb, scanRdb, reverseRdb, verifyRdb, combineRdb, openRdbFiles } from "./rdb.mjs";
//   const guids = readRdb("<install>/addons/data/resourceDatabase.rdb");
//   guids.get("1EA95DAE3230BEB0")          // -> "worlds/Cain/Cain.ent"
//   const { combined } = openRdbFiles([data, core]);
//   combined.resolve("1EA95DAE3230BEB0")   // -> { path, rdb: 1, file, label }
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
// reference resources from several of them, so `--rdb` is repeatable and the databases are
// combined into **one dictionary**: a GUID is the resource's identity, and a database is only
// where its path is written down.
//
// Every combined lookup keeps the **database the path came from** — the first database on the
// command line wins — so a caller can print `RDB #2` beside the path instead of a path whose
// provenance is a guess.
//
// Two databases carrying one GUID is not automatically a defect. The vanilla pair shares 151
// GUIDs, and both spellings name one resource: `configs/ResourceTypes/.../Sound.conf` in core and
// `Configs/System/ResourceTypes/.../Sound.conf` in data — the same file reached through a
// different mount path. The rule is therefore the **file name**:
//
//   alias      same GUID, same file name (case-insensitively) — one resource under two mount
//              paths. Reported (`aliases`) and resolved to the first database; never an error.
//   conflict   same GUID, different file names — two resources claiming one identity. Refused:
//              no answer can be given without choosing arbitrarily.
//
// An alias and a same-name collision between two genuinely different resources cannot be told
// apart from the file itself, which is why aliases are reported rather than silently collapsed.
//
// The parsing does not rest on those 8 pairs alone. On 1.8.0.13, two checks that use no hardcoded
// value agree with the mapping: every `{GUID}path` pair written in the game's own text resources
// (132 843 references in data007.pak, of which 132 781 resolve exactly; the rest are three stale
// references in the game's data, twelve case or rename differences, and references to resources of
// addons that are not installed), and the client's and server's copies agree on the GUID of all
// 116 375 records they share. `tests/rdb-tests.mjs` repeats the reference check when the game is
// installed.
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

/** Print four bytes as text when they are printable, as hex when they are not. */
function showFour(bytes) {
  return /^[\x20-\x7e]{4}$/.test(bytes) ? `"${bytes}"` : [...bytes].map((b) => b.toString(16).padStart(2, "0")).join(" ");
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
    throw new Error(`truncated resource database: ${buf.length} byte(s), the prologue is ${HEADER_START}`);
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
  if (version < 5) {
    throw new Error(`unsupported resource database version ${version}: this reader understands versions 5, 6 and 7`);
  }

  let p = HEADER_START;
  const need = (n, what) => {
    if (p + n > buf.length) throw new Error(`the header is truncated: ${what} at offset ${p} runs past the file`);
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
    throw new Error(`the header claims ${nameCount} name(s), more than the file can hold`);
  }
  const names = [];
  for (let i = 0; i < nameCount; i++) {
    need(4, `name ${i}'s length`);
    const len = buf.readUInt32LE(p); p += 4;
    if (len < 1) throw new Error(`name ${i} has length ${len}; the length counts the NUL, so it is at least 1`);
    need(len, `name ${i} (${len} bytes)`);
    const bytes = buf.subarray(p, p + len);
    if (bytes[len - 1] !== 0) throw new Error(`name ${i} is not NUL-terminated at offset ${p + len - 1}`);
    const text = bytes.subarray(0, len - 1).toString("utf8");
    if (!PRINTABLE.test(text)) throw new Error(`name ${i} is not printable: ${JSON.stringify(text)}`);
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
    throw new Error(`${file}: ${err.message}`);
  }

  const root = recordAt(buf, header.body);
  if (root === null) throw new Error(`${file}: no root record at ${header.body} (the header ends there)`);
  if (root.path !== "") throw new Error(`${file}: the root record has path ${JSON.stringify(root.path)}, not ""`);

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
    throw new Error(`${file}: record ${JSON.stringify(e.path)} at ${at} is not followed by a record ` +
      "at +0, +4, +8, +12 or +16 bytes, nor by the end of the file");
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
      throw new Error(`${file}: no record at offset ${at} (byte 0x${buf[at].toString(16)}), ` +
        `${buf.length - at} byte(s) before the end`);
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
  if (at !== buf.length) throw new Error(`${file}: the records do not reach the end of the file (${at} of ${buf.length})`);
  if (entries.length !== header.records - 1) {
    throw new Error(`${file}: the header says ${header.records} record(s) including the root, ` +
      `but ${entries.length + 1} were parsed`);
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
 */
export function reverseRdb(map) {
  const out = new Map();
  for (const [guid, path] of map) if (!out.has(path)) out.set(path, guid);
  return out;
}

/**
 * The name a path ends in, case-folded: `Configs/System/X/Sound.conf` -> `sound.conf`.
 *
 * That is the identity two databases are compared by when they carry one GUID (see the header).
 * It is deliberately weaker than the path: the same resource is reachable under different mount
 * prefixes in different addons, and the file name is the part that survives that.
 */
export function resourceName(path) {
  const normalised = path.replace(/\\/g, "/").toLowerCase();
  const slash = normalised.lastIndexOf("/");
  return normalised.slice(slash + 1);
}

/**
 * One GUID -> path dictionary built from one or more scanned databases, with the database every
 * path came from.
 *
 * `resolve` is the only lookup a caller needs: it returns `{ path, rdb, file, label }` — `rdb` is
 * the 1-based index of the database in command-line order, `label` is the text form `RDB #2` — or
 * `null` when no database carries the GUID. `databases` describes every file that was combined,
 * and `aliases` / `conflicts` are the two answers to "two databases carry one GUID" (see the
 * header): an alias is the same file name under a different mount path, a conflict is a different
 * file name. `openRdbFiles` refuses a conflict unless the caller allows it, and when allowed the
 * first database's path is the one `resolve` returns.
 */
export class CombinedRdb {
  constructor(databases, map, aliases, conflicts) {
    this.databases = databases;
    this.map = map;
    this.aliases = aliases;
    this.conflicts = conflicts;
  }
  /** How many databases were combined. */
  get count() { return this.databases.length; }
  /** How many GUIDs the combined dictionary names. */
  get size() { return this.map.size; }
  /** True when more than one database was given, which is when a path needs its index printed. */
  get multi() { return this.databases.length > 1; }
  label(index) { return `RDB #${index}`; }
  resolve(guid) {
    const found = this.map.get(guid);
    if (!found) return null;
    return {
      path: found.path,
      rdb: found.rdb,
      file: this.databases[found.rdb - 1].file,
      label: this.label(found.rdb),
    };
  }
  /** The path alone, or `null`: the same answer as `readRdb` for a single database. */
  path(guid) { return this.map.get(guid)?.path ?? null; }
  /** What the combination read and what it found, for a `--json` envelope. */
  json() {
    return {
      databases: this.databases,
      guids: this.map.size,
      aliasedGuids: this.aliases.length,
      conflictingGuids: this.conflicts.length,
      ...(this.conflicts.length ? { conflicts: this.conflicts } : {}),
    };
  }
}

/**
 * Combine scanned databases into one dictionary, preserving which database each path came from.
 *
 * The first database on the command line wins a GUID: `resolve` reports that database's path and
 * index, and the later ones are recorded in `aliases` (same file name — one resource under two
 * mount paths) or `conflicts` (different file names — refused by the callers). One GUID with two
 * *spellings* inside one database is the file's own ambiguity and is already reported by
 * `verifyRdb`; this function sees only the first spelling, exactly as `readRdb` does.
 */
export function combineRdb(scanned) {
  if (!scanned.length) throw new Error("combineRdb needs at least one database");
  const databases = scanned.map((db, i) => ({
    index: i + 1,
    label: `RDB #${i + 1}`,
    file: db.file,
    bytes: db.bytes,
    version: db.header.version,
    records: db.header.records,
    guids: db.map.size,
  }));
  const map = new Map();
  const aliases = [];
  const conflicts = [];
  scanned.forEach((db, i) => {
    const index = i + 1;
    for (const [guid, path] of db.map) {
      const first = map.get(guid);
      if (!first) { map.set(guid, { path, rdb: index }); continue; }
      if (first.path === path) continue;
      const kept = { rdb: first.rdb, path: first.path };
      const other = { rdb: index, path };
      if (resourceName(first.path) === resourceName(path)) aliases.push({ guid, kept, alias: other });
      else conflicts.push({ guid, names: [kept, other] });
    }
  });
  return new CombinedRdb(databases, map, aliases, conflicts);
}

/** The refusal for a conflict, as text: the GUID, both paths and both databases, then a remedy. */
export function describeConflicts(conflicts, limit = 3) {
  const lines = conflicts.slice(0, limit).map(({ guid, names }) => {
    const [a, b] = names;
    return `{${guid}} is ${JSON.stringify(a.path)} in RDB #${a.rdb} and ${JSON.stringify(b.path)} in ` +
      `RDB #${b.rdb}; the file names differ, so they are not one resource under two mount paths`;
  });
  const more = conflicts.length > limit ? ` (and ${conflicts.length - limit} more)` : "";
  return `resource GUID conflict: ${lines.join("; ")}${more}. A combined dictionary cannot choose ` +
    "one path without inventing the answer. A mod that re-declares a vanilla GUID under a renamed " +
    "path (a deliberate override) looks exactly like this, so pass only the databases you mean to " +
    "search, or --allow-conflicts to keep the first database's path and report the rest.";
}

/**
 * Scan, verify and combine databases in one call — the whole "resolve through several addons"
 * path, with each refusal in one place.
 *
 * Every database is checked exactly as a single `--rdb` is: `scanRdb` parses the container, then
 * `verifyRdb` refuses an empty database or a published path carrying another GUID. A database
 * that reuses a GUID is read, and the note that says so is returned in `notes` rather than
 * printed, so a `--json` caller keeps stdout parseable. Two databases carrying one GUID with
 * different file names is refused here, before any path is handed out — unless the caller passes
 * `allowConflicts`, which keeps the first database's path and leaves the list on `combined.conflicts`
 * for the caller to report. That is how a mod that overrides a vanilla resource by GUID (and
 * renames the file) is still searchable.
 *
 * Passing the same file twice is refused: it is a command-line mistake, and silently deduplicating
 * it would hide which index the paths came from.
 */
export function openRdbFiles(paths, { allowConflicts = false } = {}) {
  const seen = new Map();
  const notes = [];
  const scanned = paths.map((path) => {
    const key = resolvePath(path).toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${path}: the same database was passed twice (already read as ${seen.get(key)}) — ` +
        "one copy is enough, and a second index would claim paths it does not own");
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
      throw new Error(`${path}: refusing to resolve through this database — ${problems.join("; ")}. ` +
        "No path it yields is confirmed.");
    }
    if (!check.unique) {
      notes.push(`${path}: note: ${check.withGuid} record(s) map onto ${check.uniqueGuids} GUID(s) ` +
        `and ${check.uniquePaths} path(s); the map keeps the first of each, so a path it yields may ` +
        "belong to the later record");
    }
    return db;
  });
  const combined = combineRdb(scanned);
  if (combined.conflicts.length && !allowConflicts) throw new Error(describeConflicts(combined.conflicts));
  return { combined, notes };
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

  node tools/rdb.mjs get    <rdb> <guid> [--json]
  node tools/rdb.mjs guid   <rdb> <path> [--json]
  node tools/rdb.mjs list   <rdb> [regex] [--limit N|0] [--json]
  node tools/rdb.mjs info   <rdb> [--json]
  node tools/rdb.mjs verify <rdb> [--json]
  node tools/rdb.mjs merge  <rdb>... [--json]

The database is <install>/addons/data/resourceDatabase.rdb (~11 MB): a FORM/RDBC container with a
header (flags, names, record count), a root record, and then records for files, directories, groups
and scripts, each with a path, a kind and — except for scripts — a GUID. It is the only shipped
place that maps a resource GUID to its path. \`get\` exits 1 when the GUID names nothing; \`verify\`
checks the structure, the one-to-one mapping, and separately the 8 GUIDs the BI wiki publishes for
the vanilla scenarios (a workshop database legitimately has none of them).

\`merge\` reads several databases as one dictionary — a world can reference resources from data,
core and any installed addon at once. Every GUID keeps the database its path came from, printed as
RDB #1, RDB #2 in command-line order. One GUID under two file names is a conflict and exits 1;
one GUID under the same file name at a different mount path is an alias and is reported.

Arguments
  <guid>          with or without braces; case does not matter
  <path>          resource path, forward slashes; backslashes are converted
  [regex]         case-insensitive match on the path
  <rdb>...        \`merge\` only: two or more databases, in priority order

Options
  --limit N       maximum rows to print (default 100; 0 = every one)
  --all           same as --limit 0
  --allow-conflicts  \`merge\` only: keep the first database's path for a GUID conflict instead of
                  exiting 1, and list the conflicts (a mod may override a vanilla GUID this way)
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
    else if (a === "--allow-conflicts") flags.allowConflicts = true;
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
 * Several databases as one dictionary: what each file holds, which GUIDs more than one of them
 * carries, and — the answer the command exists for — whether any of those is a conflict.
 *
 * The text form is a preamble a reader can check (`RDB #1`, `RDB #2` with the file and its counts)
 * followed by the aliases; `--json` is the same object `CombinedRdb.json()` describes. A conflict
 * exits 1 with the GUIDs and both paths named, because no path can be chosen without inventing it.
 */
function cmdMerge(flags) {
  const paths = flags._.slice(1);
  if (paths.length < 1) throw usageError("merge needs at least one <rdb>: node tools/rdb.mjs merge a.rdb [b.rdb ...]");
  const { combined, notes } = openRdbFiles(paths, { allowConflicts: flags.allowConflicts === true });
  for (const note of notes) process.stderr.write(`${note}\n`);
  if (flags.json) {
    console.log(JSON.stringify({ ...combined.json(), aliases: combined.aliases }, null, 2));
  } else {
    console.log(`resource databases: ${combined.count}`);
    for (const d of combined.databases) {
      console.log(`  ${d.label}  ${d.file}  (version ${d.version}, ${d.records} record(s), ${d.guids} GUID(s))`);
    }
    console.log(`combined  ${combined.size} GUID(s)` +
      (combined.aliases.length ? `; ${combined.aliases.length} carried by more than one database` : ""));
    const shown = combined.aliases.slice(0, 5);
    for (const a of shown) {
      console.log(`  alias     {${a.guid}}  RDB #${a.kept.rdb} ${a.kept.path} | RDB #${a.alias.rdb} ${a.alias.path}`);
    }
    if (combined.aliases.length > shown.length) console.log(`  ... ${combined.aliases.length - shown.length} more alias(es)`);
    if (combined.aliases.length) {
      console.log("  the same file name at a different mount path: one resource, and the first database wins");
    }
    if (combined.conflicts.length) {
      for (const c of combined.conflicts.slice(0, 5)) {
        const [a, b] = c.names;
        console.log(`  CONFLICT  {${c.guid}}  RDB #${a.rdb} ${a.path} | RDB #${b.rdb} ${b.path}`);
      }
      if (combined.conflicts.length > 5) console.log(`  ... ${combined.conflicts.length - 5} more conflict(s)`);
      console.log("  a different file name for one GUID: no path can be chosen, but the first database's path is kept");
    } else {
      console.log("  conflict  none");
    }
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  // `--help` is a request, not a failure; no arguments at all is a mistake.
  if (flags.help) { process.stdout.write(USAGE); return; }
  if (flags._.length === 0) { process.stderr.write(USAGE); process.exitCode = 1; return; }
  const [command, rdbPath] = flags._;
  if (command === "merge") { cmdMerge(flags); return; }
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
