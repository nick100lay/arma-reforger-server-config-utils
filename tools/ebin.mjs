// Read an Enfusion binary resource (EBIN) — the format Arma Reforger worlds use.
//
//   node tools/ebin.mjs info     <file> [--json]
//   node tools/ebin.mjs names    <file>
//   node tools/ebin.mjs guids    <file> [--rdb <resourceDatabase.rdb>]
//   node tools/ebin.mjs tokens   <file> [--from N] [--limit N|0] [--json]
//   node tools/ebin.mjs entities <file> [--filter RE] [--limit N|0] [--json]
//   node tools/ebin.mjs find     <file> <needle>
//   node tools/ebin.mjs verify   <file>... [--json]
//
// Also usable as a library: `import { readEbin } from "./ebin.mjs"`.
//
// `entities` and `tokens` default to --limit 200, so they truncate a large world silently
// unless the JSON carries the counts: an envelope with `total`/`returned`/`truncated`, rather
// than a bare array the reader cannot tell from a complete one. `--limit 0` prints everything.
//
// ---------------------------------------------------------------------------
// WHAT IS VERIFIED, AND HOW
//
// The container is fully decoded and checked byte-exactly on 111 EBIN resources
// extracted from the installed archives (worlds of every size, 189 B to 186 KB):
//
//   "EBIN" | u32 version (1) | u16 nameCount | u16 guidCount
//          | nameCount x (u16 length + UTF-8 name)
//          | guidCount x 8 bytes, little-endian resource GUIDs
//          | the value stream
//
// The value stream is a flat sequence of `<u8 tag> <payload>`. These tags are
// established (each one either parses a whole file to the exact end together with
// the others, or was read off a field whose declared type in the text form of the
// same object is known — `coords`/`angles` are vectors, `m_iRandomPercent` is an
// int, `m_fAreaRadius` is a float):
//
//   0x00 empty        1 byte      the trailing runs of 0x00 between fields
//   0x01 i32          5 bytes
//   0x05 u16          3 bytes
//   0x06 f32          5 bytes
//   0x08 vec3        13 bytes      coords, angles
//   0x09 vec4        17 bytes
//   0x0b u8           2 bytes
//   0x0c string       u16 length + bytes
//   0x0d name         u16 index into the name table (class or field name)
//   0x0e u16          3 bytes      (see the caveat below)
//   0x43 string       u16 length + bytes — the entity ID and other id-like strings
//   0x44 guid         8 bytes inline, not in the GUID table
//   0x45 guid ref     u16 index into the GUID table
//
// 62 of the 111 files decode exactly to the end with that table alone; the rest
// contain tags that are not yet identified (0x81, 0x85, 0x86, 0x8c look like
// arrays — a u32 count followed by raw i32/f32/string members — but the family is
// not confirmed). For those the parser RESYNCHRONISES: it skips to the next token
// it can validate on its own (a name reference with an in-range index, a GUID
// reference with an in-range index, or a printable length-prefixed string) and
// records the skipped span as an undecoded gap. `verify` prints the exact/gap
// figures per file and `info` prints the coverage, so nothing decoded here is
// presented as more than it is. `--strict` refuses to resynchronise, which is how
// the gap statistics above were produced.
//
// Caveat on 0x0e: every other numeric tag has a payload width that is confirmed by
// fields of a known type, but 0x0e is only confirmed as *some* integer — reading it
// as u32 instead of u16 parses the same files (the bytes after it are usually
// zero), so its width is ambiguous and the value it carries is not interpreted.
// Treat the numbers it shows as opaque.
// ---------------------------------------------------------------------------

import { openSync, readSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const MAGIC = "EBIN";

/** tag -> { kind, width } ; width includes the tag byte. */
export const TAGS = {
  0x00: { kind: "empty", width: 1 },
  0x01: { kind: "i32", width: 5 },
  0x05: { kind: "u16", width: 3 },
  0x06: { kind: "f32", width: 5 },
  0x08: { kind: "vec3", width: 13 },
  0x09: { kind: "vec4", width: 17 },
  0x0b: { kind: "u8", width: 2 },
  0x0c: { kind: "string" },
  0x0d: { kind: "name", width: 3 },
  0x0e: { kind: "int", width: 3, uncertain: true },
  0x43: { kind: "string" },
  0x44: { kind: "guidInline", width: 9 },
  0x45: { kind: "guidRef", width: 3 },
};

/** Names that introduce structure rather than an entity, so `entities` skips them. */
const STRUCTURAL = new Set([":", "Parent", "components", "coords", "angles", "ID", "Factions"]);

export function readHeader(buf) {
  if (buf.length < 12 || buf.toString("latin1", 0, 4) !== MAGIC) {
    throw new Error("not an EBIN resource: missing the EBIN magic");
  }
  const version = buf.readUInt32LE(4);
  const nameCount = buf.readUInt16LE(8);
  const guidCount = buf.readUInt16LE(10);
  let p = 12;
  const names = [];
  for (let i = 0; i < nameCount; i++) {
    if (p + 2 > buf.length) throw new Error(`name table truncated at index ${i} (offset ${p})`);
    const len = buf.readUInt16LE(p);
    if (p + 2 + len > buf.length) throw new Error(`the name table is truncated: name ${i} claims ${len} bytes at ${p + 2}, past the end of the file`);
    names.push(buf.toString("utf8", p + 2, p + 2 + len));
    p += 2 + len;
  }
  const namesEnd = p;
  const guids = [];
  for (let i = 0; i < guidCount; i++) {
    if (p + 8 > buf.length) throw new Error(`the GUID table is truncated at index ${i} (offset ${p})`);
    guids.push(Buffer.from(buf.subarray(p, p + 8)).reverse().toString("hex").toUpperCase());
    p += 8;
  }
  if (p >= buf.length) throw new Error(`no value stream: the tables end at ${p}, the file is ${buf.length} bytes`);
  return { version, names, guids, nameCount, guidCount, namesEnd, body: p };
}

/** Decode one token. Returns { next, token } or { error, at }. */
function step(buf, header, p, tags) {
  const tag = buf[p];
  const spec = tags[tag];
  if (!spec) return { error: `undecoded tag 0x${tag.toString(16)}`, at: p };
  const at = p;
  if (spec.kind === "string") {
    const len = buf.readUInt16LE(p + 1);
    if (p + 3 + len > buf.length) return { error: "string runs past the end of the file", at };
    return { next: p + 3 + len, token: { at, end: p + 3 + len, tag, kind: "string", value: buf.toString("utf8", p + 3, p + 3 + len) } };
  }
  const next = p + spec.width;
  if (next > buf.length) return { error: `${spec.kind} runs past the end of the file`, at };
  const b = buf;
  const tok = (kind, value, extra = {}) => ({ next, token: { at, end: next, tag, kind, value, ...extra } });
  switch (spec.kind) {
    case "empty": return tok("empty", null);
    case "i32": return tok("i32", b.readInt32LE(p + 1));
    case "u16": return tok("u16", b.readUInt16LE(p + 1));
    case "u8": return tok("u8", b[p + 1]);
    case "f32": return tok("f32", b.readFloatLE(p + 1));
    case "int": return tok("int", b.readUInt16LE(p + 1), { uncertain: true });
    case "vec3": return tok("vec3", [b.readFloatLE(p + 1), b.readFloatLE(p + 5), b.readFloatLE(p + 9)]);
    case "vec4": return tok("vec4", [b.readFloatLE(p + 1), b.readFloatLE(p + 5), b.readFloatLE(p + 9), b.readFloatLE(p + 13)]);
    case "guidInline":
      return tok("guid", Buffer.from(b.subarray(p + 1, p + 9)).reverse().toString("hex").toUpperCase(), { inline: true });
    case "guidRef": {
      const idx = b.readUInt16LE(p + 1);
      if (idx >= header.guidCount) return { error: `GUID reference ${idx} is outside the table of ${header.guidCount}`, at };
      return tok("guid", header.guids[idx], { index: idx });
    }
    case "name": {
      const idx = b.readUInt16LE(p + 1);
      if (idx >= header.nameCount) return { error: `name reference ${idx} is outside the table of ${header.nameCount}`, at };
      return tok("name", header.names[idx], { index: idx });
    }
    default:
      return { error: `tag 0x${tag.toString(16)} has no reader`, at };
  }
}

/** A position that validates on its own, used to resynchronise after a gap. */
function resync(buf, header, p) {
  if (p >= buf.length) return null;
  const tag = buf[p];
  if (tag === 0x0d && p + 3 <= buf.length && buf.readUInt16LE(p + 1) < header.nameCount) return 3;
  if (tag === 0x45 && p + 3 <= buf.length && buf.readUInt16LE(p + 1) < header.guidCount) return 3;
  if (tag === 0x0c || tag === 0x43) {
    const len = buf.readUInt16LE(p + 1);
    if (len > 0 && len < 300 && p + 3 + len <= buf.length && /^[\x20-\x7e]+$/.test(buf.toString("latin1", p + 3, p + 3 + len))) {
      return 3 + len;
    }
  }
  return null;
}

/**
 * Decode a whole resource. Returns { file, header, tokens, gaps, decoded, bodySize, exact }.
 * With `strict`, an undecoded tag throws instead of being skipped.
 */
export function readEbin(path, { strict = false, tags = TAGS } = {}) {
  const buf = readFileSync(path);
  const header = readHeader(buf);
  const tokens = [];
  const gaps = [];
  let p = header.body;
  while (p < buf.length) {
    const r = step(buf, header, p, tags);
    if (!r.error) {
      tokens.push(r.token);
      p = r.next;
      continue;
    }
    if (strict) throw new Error(`${path}: ${r.error} at offset ${r.at} (byte 0x${buf[r.at].toString(16)})`);
    let q = p + 1;
    while (q < buf.length && resync(buf, header, q) === null) q++;
    gaps.push({ from: p, to: q, bytes: q - p, reason: r.error });
    p = q;
  }
  const decoded = tokens.reduce((sum, t) => sum + (t.at >= 0 ? 1 : 0), 0);
  const bodySize = buf.length - header.body;
  const gapBytes = gaps.reduce((s, g) => s + g.bytes, 0);
  return {
    file: path,
    header,
    tokens,
    gaps,
    tokenCount: tokens.length,
    bodySize,
    gapBytes,
    decodedBytes: bodySize - gapBytes,
    exact: gaps.length === 0,
  };
}

/**
 * Group the token stream into entity records. A record starts at a name token that looks
 * like a class (`GenericEntity`, `SCR_*`, `Chimera*`); the string that immediately follows
 * it is the entity's ID; every `name` token inside the record that is immediately followed
 * by a value token becomes a field. This is a reading of the stream's shape, not a schema:
 * the format carries no field count, so a record ends where the next class name begins.
 */
export function entities(ebin) {
  const tokens = ebin.tokens;
  const isClass = (name) => name && !STRUCTURAL.has(name) && !/^m_/.test(name) && /^[A-Z]/.test(name);
  const looksLikeComponent = (name) => /(Component|Object|Hierarchy|Body|Transceiver|Sound)$/.test(name);

  // A component instance is a class name followed directly by a GUID reference; it belongs to
  // the entity above it rather than starting a new one. Everything else that looks like a class
  // starts a record, and the record runs to the next such name.
  const starts = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "name" || !isClass(t.value)) continue;
    const next = tokens[i + 1];
    if (starts.length && looksLikeComponent(t.value) && next && next.kind === "guid" && next.at === t.end) continue;
    starts.push(i);
  }

  const out = [];
  for (let s = 0; s < starts.length; s++) {
    const from = starts[s];
    const to = s + 1 < starts.length ? starts[s + 1] : tokens.length;
    const record = { className: tokens[from].value, at: tokens[from].at, id: null, ids: [], fields: [], componentClasses: [], refs: [] };
    for (let i = from + 1; i < to; i++) {
      const t = tokens[i];
      if (t.tag === 0x43 && t.kind === "string") { record.ids.push(t.value); if (record.id === null) record.id = t.value; continue; }
      if (t.kind === "guid") { record.refs.push(t.value); continue; }
      if (t.kind === "name" && isClass(t.value)) {
        if (looksLikeComponent(t.value) && !record.componentClasses.includes(t.value)) record.componentClasses.push(t.value);
        continue;
      }
      if (t.kind !== "name") continue;
      const value = tokens[i + 1];
      if (!value || value.at !== t.end || value.kind === "name" || t.value === "components") continue;
      record.fields.push({ name: t.value, kind: value.kind, value: value.value, at: t.at });
    }
    out.push(record);
  }

  // A record also contains the vectors of the nested objects inside it. The entity's *own*
  // position is the `coords` that follows its name fields (`m_sBaseName`/`m_sBaseNameUpper`,
  // where a base's transform sits), and the first `coords` after the record starts when it has
  // no such fields. Checked against the seven control points of CTI_Campaign_Cain and the five
  // source bases nested in Base_MilitaryHQ, which is the case this distinction exists for.
  for (const record of out) {
    const nameField = [...record.fields].reverse().find((f) => /^m_sBaseName/.test(f.name));
    const from = nameField ? nameField.at : record.at;
    const own = record.fields.find((f) => f.name === "coords" && f.at > from) ?? null;
    record.position = own ? own.value : null;
    record.angle = own
      ? (record.fields.find((f) => f.name === "angles" && f.at > own.at)?.value ?? null)
      : null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// resourceDatabase.rdb — GUID -> path, for `guids --rdb`
// ---------------------------------------------------------------------------

/** Build a GUID -> path map from a resourceDatabase.rdb (11 MB scan, ~1 s). */
export function readRdb(path) {
  const buf = readFileSync(path);
  const map = new Map();
  for (let i = 0; i < buf.length - 24; i++) {
    if (buf[i] !== 0) continue;
    // a record looks like: <path bytes><0x00><6 bytes><8-byte GUID, little-endian>
    let start = i;
    while (start > 0 && buf[start - 1] >= 0x20 && buf[start - 1] < 0x7f) start--;
    const len = i - start;
    if (len < 4 || len > 250) continue;
    const path = buf.toString("latin1", start, i);
    if (!/^[A-Za-z0-9_\-/.]+$/.test(path) || path.includes("//") || !path.includes(".")) continue;
    const guid = Buffer.from(buf.subarray(i + 7, i + 15)).reverse().toString("hex").toUpperCase();
    if (guid === "0000000000000000") continue;
    if (!map.has(guid)) map.set(guid, path);
  }
  return map;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Read an EBIN resource (Arma Reforger worlds and other binary resources)

  node tools/ebin.mjs info     <file> [--json]
  node tools/ebin.mjs names    <file>
  node tools/ebin.mjs guids    <file> [--rdb <resourceDatabase.rdb>]
  node tools/ebin.mjs tokens   <file> [--from N] [--limit N|0] [--json]
  node tools/ebin.mjs entities <file> [--filter RE] [--limit N|0] [--json]
  node tools/ebin.mjs find     <file> <needle>
  node tools/ebin.mjs verify   <file> ... [--json]

Options
  --strict        stop at the first undecoded tag instead of resynchronising
  --from N        first token index to print (tokens)
  --limit N       maximum tokens/entities to print (default 200; 0 = every one)
  --all           same as --limit 0
  --filter RE     only entities whose class, ID or a field matches RE
  --rdb <file>    resolve GUIDs through resourceDatabase.rdb
  --json          machine-readable output; entities and tokens are wrapped in an
                  envelope carrying the file, the total count and whether it was cut
`;

function parseArgs(argv) {
  const flags = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") flags.strict = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--from") flags.from = parseInt(argv[++i], 10);
    else if (a === "--limit") flags.limit = parseInt(argv[++i], 10);
    else if (a === "--filter") flags.filter = argv[++i];
    else if (a === "--rdb") flags.rdb = argv[++i];
    else if (a === "-h" || a === "--help") flags.help = true;
    else flags._.push(a);
  }
  return flags;
}

const num = (v) => (Number.isInteger(v) ? String(v) : v.toFixed(4).replace(/0+$/, "").replace(/\.$/, ""));
const fmtValue = (t) => {
  if (t.kind === "vec3" || t.kind === "vec4") return t.value.map(num).join(" ");
  if (t.kind === "guid") return `{${t.value}}${t.inline ? " (inline)" : ""}`;
  if (t.kind === "string") return JSON.stringify(t.value);
  if (t.kind === "empty") return "";
  return String(t.value);
};

function cmdInfo(ebin, flags) {
  const { header } = ebin;
  const info = {
    file: ebin.file,
    version: header.version,
    names: header.names.length,
    guids: header.guids.length,
    namesEnd: header.namesEnd,
    bodyOffset: header.body,
    bodyBytes: ebin.bodySize,
    tokens: ebin.tokenCount,
    decodedBytes: ebin.decodedBytes,
    undecodedBytes: ebin.gapBytes,
    undecodedRegions: ebin.gaps.length,
    exact: ebin.exact,
  };
  if (flags.json) { console.log(JSON.stringify(info, null, 2)); return; }
  console.log(`${ebin.file}`);
  console.log(`  version        ${header.version}`);
  console.log(`  name table     ${header.names.length} names (offsets 12..${header.namesEnd})`);
  console.log(`  guid table     ${header.guids.length} GUIDs`);
  console.log(`  value stream   starts at ${header.body}, ${ebin.bodySize} bytes`);
  console.log(`  tokens         ${ebin.tokenCount}`);
  console.log(`  decoded        ${((100 * ebin.decodedBytes) / ebin.bodySize).toFixed(1)}% of the stream` +
    (ebin.exact ? " (no gaps)" : `, ${ebin.gaps.length} undecoded region(s), ${ebin.gapBytes} bytes`));
}

function cmdNames(ebin) {
  ebin.header.names.forEach((n, i) => console.log(`${String(i).padStart(4)}  ${n}`));
}

function cmdGuids(ebin, flags) {
  let rdb = null;
  if (flags.rdb) rdb = readRdb(flags.rdb);
  ebin.header.guids.forEach((g, i) => {
    const path = rdb?.get(g);
    console.log(`${String(i).padStart(4)}  {${g}}${path ? `  ${path}` : ""}`);
  });
  for (const t of ebin.tokens) {
    if (t.kind === "guid" && t.inline) {
      const path = rdb?.get(t.value);
      console.log(`  inline  {${t.value}}${path ? `  ${path}` : ""}`);
    }
  }
}

/**
 * How many records to print. `--limit 0` and `--all` mean "every one"; a bare run still stops at
 * 200 so a 190 KB world does not have to be scrolled, but the JSON now says that it did.
 */
function rowLimit(flags, fallback = 200) {
  if (flags.all) return Infinity;
  const n = flags.limit ?? fallback;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function cmdTokens(ebin, flags) {
  const from = flags.from ?? 0;
  const limit = rowLimit(flags);
  const slice = ebin.tokens.slice(from, from + limit);
  if (flags.json) {
    // An envelope, not a bare array: `--json` defaults to 200 rows, and a caller that cannot see
    // `total` has no way to tell a complete resource from a truncated one.
    console.log(JSON.stringify({
      file: ebin.file,
      total: ebin.tokenCount,
      from,
      returned: slice.length,
      truncated: slice.length < ebin.tokenCount - from,
      tokens: slice.map((t) => ({ at: t.at, kind: t.kind, name: t.kind === "name" ? t.value : undefined, value: t.value })),
    }, null, 2));
    return;
  }
  let previous = null;
  for (const t of slice) {
    if (previous !== null && t.at > previous) {
      console.log(`${String(previous).padStart(7)}  -- undecoded ${t.at - previous} byte(s) --`);
    }
    const label = t.kind === "name" ? "name " : t.kind.padEnd(5);
    console.log(`${String(t.at).padStart(7)}  0x${t.tag.toString(16).padStart(2, "0")}  ${label} ${fmtValue(t)}`);
    previous = t.end;
  }
  if (ebin.tokenCount > from + limit) console.log(`... ${ebin.tokenCount - from - limit} more token(s)`);
}

function cmdEntities(ebin, flags) {
  const re = flags.filter ? new RegExp(flags.filter, "i") : null;
  const limit = rowLimit(flags);
  let list = entities(ebin);
  if (re) {
    list = list.filter((e) => re.test(e.className) || (e.id && re.test(e.id))
      || e.fields.some((f) => re.test(f.name)) || e.componentClasses.some((c) => re.test(c)));
  }
  const rows = list.slice(0, limit);
  if (flags.json) {
    // The same envelope as `tokens`, and for the same reason: without `total` a 549-entity world
    // and its first 200 entities are the same JSON. `coverage` rides along because the skill's
    // rule is to report the decode coverage next to anything read out of a file with gaps.
    console.log(JSON.stringify({
      file: ebin.file,
      total: list.length,
      returned: rows.length,
      truncated: rows.length < list.length,
      filter: flags.filter ?? null,
      coverage: {
        tokens: ebin.tokenCount,
        bodyBytes: ebin.bodySize,
        decodedBytes: ebin.decodedBytes,
        undecodedBytes: ebin.gapBytes,
        gaps: ebin.gaps.length,
        exact: ebin.exact,
      },
      entities: rows,
    }, null, 2));
    return;
  }
  console.log(`${ebin.file}: ${list.length} entit${list.length === 1 ? "y" : "ies"}${re ? ` matching /${flags.filter}/i` : ""}`);
  for (const e of rows) {
    const id = e.id ? ` "${e.id}"` : "";
    console.log(`\n${e.className}${id}   @${e.at}`);
    if (e.position) console.log(`    position = ${e.position.map(num).join(", ")}${e.angle ? `   angle = ${e.angle.map(num).join(", ")}` : ""}`);
    for (const f of e.fields) {
      console.log(`    ${f.name} = ${f.kind === "vec3" || f.kind === "vec4" ? f.value.map(num).join(", ") : JSON.stringify(f.value)}`);
    }
    if (e.ids.length > 1) console.log(`    nested ids: ${e.ids.slice(1).join(", ")}`);
    if (e.componentClasses.length) console.log(`    components: ${[...new Set(e.componentClasses)].join(", ")}`);
    if (e.refs.length) console.log(`    refs: ${e.refs.map((g) => `{${g}}`).join(" ")}`);
  }
  if (rows.length < list.length) console.log(`... ${list.length - rows.length} more entit${list.length - rows.length === 1 ? "y" : "ies"} (--limit 0 for all)`);
}

function cmdFind(ebin, needle) {
  const lower = needle.toLowerCase();
  let hits = 0;
  for (const t of ebin.tokens) {
    const text = t.kind === "name" || t.kind === "string" ? String(t.value) : null;
    if (text && text.toLowerCase().includes(lower)) {
      console.log(`@${String(t.at).padStart(7)}  ${t.kind === "name" ? "name " : "string"} ${JSON.stringify(t.value)}`);
      hits++;
    }
  }
  console.log(`# ${hits} hit(s)`);
}

function cmdVerify(files, flags) {
  const rows = [];
  for (const file of files) {
    try {
      const e = readEbin(file, { strict: flags.strict });
      rows.push({ file, tokens: e.tokenCount, bodyBytes: e.bodySize, gapBytes: e.gapBytes, gaps: e.gaps.length, exact: e.exact });
    } catch (err) {
      rows.push({ file, error: err.message });
    }
  }
  if (rows.some((r) => r.error)) process.exitCode = 1;
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) {
    if (r.error) { console.log(`FAIL  ${basename(r.file)}: ${r.error}`); continue; }
    const pct = ((100 * (r.bodyBytes - r.gapBytes)) / r.bodyBytes).toFixed(1);
    console.log(`${r.exact ? "EXACT" : "GAPS "} ${basename(r.file).padEnd(30)} tokens ${String(r.tokens).padStart(6)}  decoded ${pct}%` +
      (r.exact ? "" : `  (${r.gaps} region(s), ${r.gapBytes} bytes)`));
  }
  const files2 = rows.filter((r) => !r.error);
  const exact = files2.filter((r) => r.exact).length;
  const bytes = files2.reduce((s, r) => s + r.bodyBytes, 0);
  const gap = files2.reduce((s, r) => s + r.gapBytes, 0);
  console.log(`\n${exact}/${files2.length} files decode exactly; ${(100 * (bytes - gap) / bytes).toFixed(2)}% of ${bytes} stream bytes decoded`);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags._.length === 0) { process.stdout.write(USAGE); process.exit(flags._.length ? 0 : 1); }
  const [command, file, needle] = flags._;
  if (!file) { process.stderr.write(USAGE); process.exit(1); }
  if (command === "verify") { cmdVerify(flags._.slice(1), flags); return; }
  const ebin = readEbin(file, { strict: flags.strict });
  switch (command) {
    case "info": cmdInfo(ebin, flags); break;
    case "names": cmdNames(ebin); break;
    case "guids": cmdGuids(ebin, flags); break;
    case "tokens": cmdTokens(ebin, flags); break;
    case "entities": cmdEntities(ebin, flags); break;
    case "find": cmdFind(ebin, needle); break;
    default:
      process.stderr.write(`unknown command "${command}"\n\n${USAGE}`);
      process.exitCode = 1;
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  try { main(); } catch (err) { process.stderr.write(`error: ${err.message}\n`); process.exitCode = 1; }
}

