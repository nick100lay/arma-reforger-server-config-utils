// Read an Enfusion binary resource (EBIN) — the format Arma Reforger worlds use.
//
//   node tools/ebin.mjs info      <file> [--json]
//   node tools/ebin.mjs names     <file>
//   node tools/ebin.mjs guids     <file> [--rdb <resourceDatabase.rdb>]
//   node tools/ebin.mjs resources <file>... --rdb <resourceDatabase.rdb> [--json]
//   node tools/ebin.mjs worlds    <file>... --rdb <resourceDatabase.rdb> [--json]
//   node tools/ebin.mjs tokens    <file> [--from N] [--limit N|0] [--json]
//   node tools/ebin.mjs entities  <file> [--filter RE] [--limit N|0] [--rdb <rdb>] [--json]
//   node tools/ebin.mjs find      <file> <needle>
//   node tools/ebin.mjs verify    <file>... [--json]
//
// Also usable as a library: `import { readEbin, entities } from "./ebin.mjs"`.
//
// ---------------------------------------------------------------------------
// WHAT A WORLD FILE ACTUALLY CONTAINS — read this before trusting any field
//
// A `.ent` file is NOT a list of finished entities. It is a list of *overrides*: for each
// entity it stores the class, the instance id, **which prefab it was made from**, and only
// the properties whose value differs from that prefab. Everything else — every component the
// entity has, every default — lives in the `.et` prefab and is not in this file at all.
//
// That is why `--rdb` matters so much: the GUID of the prefab is stored, and only
// `resourceDatabase.rdb` can turn it into a path. Measured across all 103 vanilla worlds,
// **21 016 of 21 016** `:` references resolve to a resource path (20 338 `.et`, 653 `.conf`,
// 25 `.ct`) and **zero** of them stay unknown, so the prefab path printed here is the real one.
//
//   > GenericEntity "CP_Kamensk" : "{...}.../MilitaryBase.et" { m_sBaseName "..." }
//
// reads as: an instance of that prefab, called CP_Kamensk, which overrides `m_sBaseName`.
//
// ---------------------------------------------------------------------------
// THE CONTAINER (decoded byte-exactly, see `verify`)
//
//   "EBIN" | u32 version (1) | u16 nameCount | u16 guidCount
//          | nameCount x (u16 length + UTF-8 name)
//          | guidCount x 8 bytes, little-endian resource GUIDs
//          | the value stream
//
// The value stream is `<u8 tag> <payload>`. Every tag below is established the same way:
// it makes whole files parse to their exact last byte, and the value it yields agrees with
// the text form of the same data (a prefab's own `.et`, which is plain text):
//
//   0x00  empty        1 byte       padding between fields; carries nothing
//   0x01  i32          4 bytes      m_iRandomPercent 100
//   0x02  u64          8 bytes      an eight-byte value whose meaning is NOT established, so it
//                                   is kept as raw hex rather than read as a number. Its width is
//                                   established the hard way: at 9 bytes the three terrain worlds
//                                   go from 15% to 96% decoded, and 1.18 million blocks that
//                                   failed at this tag start tiling exactly
//   0x05  guid ref     u16 index    **the GUID table index**: a prefab (`:`), the base world
//                                   (`Parent`), or a resource-valued property (m_sObjectToSpawn)
//   0x06  f32          4 bytes      m_fAreaRadius 75
//   0x08  vec3         12 bytes     coords, angles
//   0x09  vec4         16 bytes
//   0x0b  u8           1 byte       m_bShowDebugShapesDuringRuntime 1
//   0x0c  string       u16 len
//   0x0d  name         u16 index    class name, member name, or the punctuation `:` / `components`
//   0x0e  block        u16 len      a length-delimited scope: `blockEnd = at + 1 + length`,
//                                   so the content is `length - 2` bytes after the field.
//                                   The content is either more tokens (an object) or opaque
//                                   data (BSP trees, navmesh, generated geometry); see below
//   0x43  id string    u16 len      the entity's instance name ("CP_Kamensk")
//   0x44  guid inline  8 bytes      a GUID carried in the stream, not in the table
//   0x45  guid ref     u16 index    a GUID table index used for component instance GUIDs
//   0x8X  array        u32 count    `count` untagged elements of the type whose tag is `0xX`:
//                                   0x81 i32, 0x85 guid ref, 0x86 f32, 0x88 vec3, 0x8c string,
//                                   0x8d name. Checked by tiling: the elements consume the
//                                   array's bytes exactly, for every instance measured
//
// Two things are deliberately NOT invented. Tags 0x02, 0x03, 0x04, 0x07 and 0x0a appear only
// inside blocks whose content is opaque data, never in a scope that otherwise decodes, so no
// width for them is established and they stay unknown — which surfaces as a reported gap
// rather than a plausible-looking wrong number.
//
// An **opaque block** is the honest answer to "this block's bytes are not a token stream".
// The reader tries the content as tokens; if that does not tile the block exactly, the block
// is reported as opaque (`opaque: true`, no children) and its bytes are counted as undecoded.
// Interpreting half a BSP blob would produce invented entities, and a tool that invents
// entities is worse than one that says "this part is not understood".
//
// ---------------------------------------------------------------------------
// RECORDS, COMPONENTS, HIERARCHY
//
// Checked against the text form of the same graph, which the engine writes to a `.layer`
// sidecar or a prefab `.et`:
//
//     GenericEntity "Area_A" : "{...}Area.et" {        <- class, id, prefab
//      components {                                     <- the component list
//       SCR_ScenarioFrameworkArea "{...}" {             <- component class + its GUID
//        m_fAreaRadius 75
//       }
//      }
//      coords 81.09 4.70 64.02                          <- the entity's own transform
//     }
//
// In the binary that is, unambiguously:
//
//   * a **record** is `[name class] [0x43 id] [name ":"] [0x05 prefab] [0x0e block]`.
//     The `:`+GUID+block triple is present in every record measured (21 016 of them), and
//     nothing else in the format looks like it — this is the anchor the reader uses, not a
//     guess about capitalisation or field prefixes.
//   * the record's **own members** are the `name value` pairs directly in its block — the
//     ones before and after the `components` section alike. A nested record lives inside its
//     own block, so it can never leak members onto its parent.
//   * a **component** is `[name class] [0x45 or 0x44 GUID] [0x0e block]` inside the
//     `components` block. Component GUIDs are stable across prefab inheritance: the GUID of
//     `SCR_ScenarioFrameworkArea` in `Area.et` and in every world that uses it is identical,
//     which is what makes a world's override readable as "this component of the prefab".
//   * **nesting is real**: an entity's block contains its children's blocks, so the scene
//     graph — an area containing a task containing a slot — is recovered as `depth`.
//   * `$grp <class> [":" <prefab>] <block>` is a **group**: one header and N member blocks
//     with only transforms and overrides. That is where a terrain world hides its 1.3 million
//     trees, so a group is reported as one record carrying `instances: N`, never expanded.
//
// `refs` (tags 0x44/0x45) are component instance GUIDs, not resources: resolved against
// resourceDatabase.rdb they come back empty, which is correct — the GUID *table* is the only
// place resources are named, and `0x05` is how the stream points into it.
// ---------------------------------------------------------------------------

import { openSync, readSync, closeSync, fstatSync, readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

export const MAGIC = "EBIN";

/**
 * tag -> { kind, width } ; width includes the tag byte. `width` is absent for the
 * variable-length kinds (string, block, array). `array` entries carry `elem`.
 */
export const TAGS = {
  0x00: { kind: "empty", width: 1 },
  0x01: { kind: "i32", width: 5 },
  0x02: { kind: "u64", width: 9 },
  0x05: { kind: "guidRef", width: 3 },
  0x06: { kind: "f32", width: 5 },
  0x08: { kind: "vec3", width: 13 },
  0x09: { kind: "vec4", width: 17 },
  0x0b: { kind: "u8", width: 2 },
  0x0c: { kind: "string" },
  0x0d: { kind: "name", width: 3 },
  0x0e: { kind: "block" },
  0x43: { kind: "id", width: undefined, variable: true },
  0x44: { kind: "guid", width: 9, inline: true },
  0x45: { kind: "guidRef", width: 3, component: true },
};
for (let t = 0; t < 0x10; t++) {
  const base = TAGS[t];
  if (!base) continue;
  TAGS[0x80 | t] = { kind: "array", elem: t, elemKind: base.kind };
}

/** Tag 0x43 and 0x0c are both length-prefixed strings; 0x43 marks an entity id. */
const STRING_TAGS = new Set([0x0c, 0x43]);

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
  return { version, names, guids, nameCount, guidCount, namesEnd, body: p, size: buf.length };
}

// ---------------------------------------------------------------------------
// the token reader
// ---------------------------------------------------------------------------

/**
 * Read one token at `p`, which must lie inside `end` (the enclosing scope's end offset).
 * Returns `{ token }` or `{ error }`. A token never spans a scope boundary.
 */
function readToken(buf, header, p, end, tags) {
  const tag = buf[p];
  const spec = tags[tag];
  if (!spec) return { error: `undecoded tag 0x${tag.toString(16)}` };
  const at = p;

  if (spec.kind === "block") {
    if (p + 3 > end) return { error: "block header runs past the end of its scope" };
    const len = buf.readUInt16LE(p + 1);
    const blockEnd = p + 1 + len;
    if (blockEnd > end) return { error: `block claims ${len} bytes, more than its scope has left (${end - p - 1})` };
    return { token: { at, end: blockEnd, tag, kind: "block", len } };
  }
  if (spec.kind === "array") {
    if (p + 5 > end) return { error: "array header runs past the end of its scope" };
    const count = buf.readUInt32LE(p + 1);
    const elem = tags[spec.elem];
    let q = p + 5;
    if (elem.width !== undefined) {
      q = p + 5 + count * (elem.width - 1);
      if (q > end) return { error: `array of ${count} x 0x${spec.elem.toString(16)} runs past the end of its scope` };
    } else if (spec.elem === 0x0c) {
      for (let i = 0; i < count; i++) {
        if (q + 2 > end) return { error: `array of ${count} strings is truncated at element ${i}` };
        q += 2 + buf.readUInt16LE(q);
        if (q > end) return { error: `array of ${count} strings runs past the end of its scope` };
      }
    } else {
      return { error: `array of an element type this reader cannot size (0x${spec.elem.toString(16)})` };
    }
    return { token: { at, end: q, tag, kind: "array", count, elemKind: spec.elemKind, elem: spec.elem } };
  }
  if (STRING_TAGS.has(tag)) {
    if (p + 3 > end) return { error: "string header runs past the end of its scope" };
    const len = buf.readUInt16LE(p + 1);
    if (p + 3 + len > end) return { error: `string claims ${len} bytes, more than its scope has left` };
    return { token: { at, end: p + 3 + len, tag, kind: tag === 0x43 ? "id" : "string", value: buf.toString("utf8", p + 3, p + 3 + len) } };
  }

  const next = p + spec.width;
  if (next > end) return { error: `${spec.kind} runs past the end of its scope` };
  const b = buf;
  switch (spec.kind) {
    case "empty": return { token: { at, end: next, tag, kind: "empty" } };
    case "i32": return { token: { at, end: next, tag, kind: "i32", value: b.readInt32LE(p + 1) } };
    case "u8": return { token: { at, end: next, tag, kind: "u8", value: b[p + 1] } };
    case "u64":
      // Eight bytes whose interpretation is not established: keep the raw value, so nothing
      // downstream can mistake it for a number that was understood.
      return { token: { at, end: next, tag, kind: "u64", value: b.subarray(p + 1, next).toString("hex").toUpperCase(), raw: true } };
    case "f32": return { token: { at, end: next, tag, kind: "f32", value: b.readFloatLE(p + 1) } };
    case "vec3": return { token: { at, end: next, tag, kind: "vec3", value: [b.readFloatLE(p + 1), b.readFloatLE(p + 5), b.readFloatLE(p + 9)] } };
    case "vec4": return { token: { at, end: next, tag, kind: "vec4", value: [b.readFloatLE(p + 1), b.readFloatLE(p + 5), b.readFloatLE(p + 9), b.readFloatLE(p + 13)] } };
    case "guid": return { token: { at, end: next, tag, kind: "guid", value: Buffer.from(b.subarray(p + 1, p + 9)).reverse().toString("hex").toUpperCase(), inline: true } };
    case "guidRef": {
      const idx = b.readUInt16LE(p + 1);
      if (idx >= header.guidCount) return { error: `GUID reference ${idx} is outside the table of ${header.guidCount}` };
      return { token: { at, end: next, tag, kind: "guidRef", index: idx, value: header.guids[idx], component: tag === 0x45 } };
    }
    case "name": {
      const idx = b.readUInt16LE(p + 1);
      if (idx >= header.nameCount) return { error: `name reference ${idx} is outside the table of ${header.nameCount}` };
      return { token: { at, end: next, tag, kind: "name", index: idx, value: header.names[idx] } };
    }
    default:
      // A width the table knows but this reader has no interpretation for: keep the bytes
      // rather than invent a number. Only reachable when a caller passes its own table.
      return { token: { at, end: next, tag, kind: spec.kind, value: b.subarray(p + 1, next).toString("hex"), raw: true } };
  }
}

/** Is `p` a plausible place to resume reading? Used only to skip genuinely opaque bytes. */
function resyncAt(buf, header, p, end) {
  const tag = buf[p];
  if (tag === 0x0d && p + 3 <= end && buf.readUInt16LE(p + 1) < header.nameCount) {
    const name = header.names[buf.readUInt16LE(p + 1)];
    // A record starts with a class name; resuming on a field name would invent records.
    if (/^[A-Z]/.test(name) || name === "$grp" || name === "SubScene") return "name";
  }
  if (tag === 0x45 && p + 3 <= end && buf.readUInt16LE(p + 1) < header.guidCount) return "guidRef";
  if (tag === 0x0e && p + 3 <= end) {
    const blockEnd = p + 1 + buf.readUInt16LE(p + 1);
    if (blockEnd <= end) return "block";
  }
  return null;
}

/**
 * Decode one scope: the tokens between `from` and `end`, which must be consumed exactly.
 * Blocks recurse as scopes of their own; a block whose content does not tile exactly becomes
 * an **opaque leaf** (children dropped, bytes counted as undecoded) while this scope carries
 * on after it — one unreadable payload must not cost the rest of the file.
 *
 * Returns `{ failAt, error }` when this scope's *own* tokens cannot be decoded at that offset;
 * the container reader then resynchronises on the next anchor. A failure inside a child block
 * never propagates.
 */
function readScope(buf, header, from, end, tags, tokens, gaps) {
  let p = from;
  while (p < end) {
    const r = readToken(buf, header, p, end, tags);
    if (r.error) return { failAt: p, error: r.error };
    const token = r.token;
    if (token.kind === "block") {
      const inner = [];
      const res = readScope(buf, header, token.at + 3, token.end, tags, inner, gaps);
      if (res.failAt === undefined) {
        token.children = inner;
      } else {
        token.opaque = true;
        token.opaqueBytes = token.end - token.at - 3;
        token.reason = res.error;
        gaps.push({ from: token.at + 3, to: token.end, bytes: token.opaqueBytes, reason: `opaque block: ${res.error}`, opaque: true });
      }
    }
    tokens.push(token);
    p = token.end;
  }
  return {};
}

/**
 * Decode a whole resource. Returns:
 *   { file, header, tokens, gaps, tokenCount, bodySize, gapBytes, decodedBytes, exact,
 *     opaqueBlocks, opaqueBytes }
 * With `strict`, an undecodable byte throws instead of the scope being abandoned.
 */
export function readEbin(path, { strict = false, tags = TAGS } = {}) {
  const buf = readFileSync(path);
  const header = readHeader(buf);
  const tokens = [];
  const gaps = [];
  if (strict) {
    // No resynchronisation at all: the file must tile exactly or it is an error. Opaque blocks
    // are still reported as such — that is a property of the data, not of this reader.
    const res = readScope(buf, header, header.body, buf.length, tags, tokens, gaps);
    if (res.failAt !== undefined) {
      throw new Error(`${path}: ${res.error} at offset ${res.failAt} (byte 0x${buf[res.failAt].toString(16)})`);
    }
  } else {
    let p = header.body;
    while (p < buf.length) {
      const res = readScope(buf, header, p, buf.length, tags, tokens, gaps);
      if (res.failAt === undefined) break;
      // This scope cannot be decoded from here: skip to the next place a record can start.
      let q = res.failAt + 1;
      while (q < buf.length && resyncAt(buf, header, q, buf.length) === null) q++;
      gaps.push({ from: res.failAt, to: q, bytes: q - res.failAt, reason: res.error });
      p = q;
    }
  }
  const bodySize = buf.length - header.body;
  const gapBytes = gaps.reduce((s, g) => s + g.bytes, 0);
  return {
    file: path,
    header,
    tokens,
    gaps,
    tokenCount: countTokens(tokens),
    bodySize,
    gapBytes,
    decodedBytes: bodySize - gapBytes,
    exact: gaps.length === 0,
    opaqueBlocks: countOpaque(tokens),
    opaqueBytes: gaps.filter((g) => g.opaque).reduce((s, g) => s + g.bytes, 0),
  };
}

function countOpaque(list) {
  let n = 0;
  for (const t of list) { if (t.kind === "block" && t.opaque) n++; if (t.children) n += countOpaque(t.children); }
  return n;
}

function countTokens(list) {
  let n = 0;
  for (const t of list) { n++; if (t.children) n += countTokens(t.children); }
  return n;
}

/** Flatten the tree into reading order, useful for `tokens` and for tests. */
export function flatten(tokens, depth = 0, out = []) {
  for (const t of tokens) {
    out.push({ ...t, depth });
    if (t.children) flatten(t.children, depth + 1, out);
  }
  return out;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/** A member's value as a plain JS value, keeping `guidRef` provenance. */
function fieldOf(t) {
  const base = { name: t.name, kind: t.token.kind, tag: t.token.tag };
  const v = t.token;
  if (v.kind === "guidRef") return { ...base, value: v.value, guid: v.value, index: v.index, component: v.component === true };
  if (v.kind === "guid") return { ...base, value: v.value, guid: v.value, inline: true };
  if (v.kind === "block") return { ...base, value: null, blockBytes: v.end - v.at - 3, opaque: v.opaque === true };
  if (v.kind === "array") return { ...base, value: v.count, count: v.count, elemKind: v.elemKind };
  return { ...base, value: v.value };
}

/** `name value` pairs directly in `tokens` (one scope), skipping blocks and punctuation. */
function membersOf(tokens) {
  const out = [];
  for (let i = 0; i + 1 < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "name") continue;
    if (t.value === ":" || t.value === "components") continue;
    const v = tokens[i + 1];
    out.push(fieldOf({ name: t.value, token: v }));
  }
  return out;
}

/** The components declared in a `components { ... }` scope. */
function componentsOf(tokens) {
  const out = [];
  for (let i = 0; i + 2 < tokens.length; i++) {
    const cls = tokens[i];
    if (cls.kind !== "name") continue;
    const guid = tokens[i + 1];
    if (guid.kind !== "guidRef" && guid.kind !== "guid") continue;
    const body = tokens[i + 2];
    if (body.kind !== "block") continue;
    out.push({
      className: cls.value,
      guid: guid.value,
      inline: guid.kind === "guid",
      at: cls.at,
      opaque: body.opaque === true,
      fields: body.children ? membersOf(body.children) : [],
    });
    i += 2;
  }
  return out;
}

/**
 * True when `tokens[i]` starts a record.
 *
 * Two forms are accepted, both anchored on something only a record has:
 *   <class> [id] ":" <guidRef> <block>   — a prefab instance; the `:`+GUID+block triple is
 *                                          present in all 21 016 records measured
 *   <class> <id> <block>                 — an entity that stores no prefab at all (the world
 *                                          entity, the sun, a post-process effect). Anchored
 *                                          on the id string, which tag 0x43 is reserved for,
 *                                          so a member such as `BSP <block>` cannot match
 */
function recordAt(tokens, i) {
  // form 1: <class> [id] ":" <guidRef> <block>
  const colon = tokens[i];
  if (colon && colon.kind === "name" && colon.value === ":") {
    const ref = tokens[i + 1];
    if (ref && ref.kind === "guidRef") {
      const body = tokens[i + 2];
      if (body && body.kind === "block") {
        let j = i - 1;
        let id = null;
        if (tokens[j] && tokens[j].kind === "id") { id = tokens[j].value; j--; }
        const cls = tokens[j];
        if (cls && cls.kind === "name" && cls.value !== ":") {
          return { cls: cls.value, id, guid: ref.value, index: ref.index, body, at: cls.at };
        }
      }
    }
  }
  // form 2: <class> <id> <block>
  const cls = tokens[i];
  if (cls && cls.kind === "name" && (/^[A-Z]/.test(cls.value))) {
    const id = tokens[i + 1];
    if (id && id.kind === "id") {
      const body = tokens[i + 2];
      if (body && body.kind === "block") {
        return { cls: cls.value, id: id.value, guid: null, index: null, body, at: cls.at };
      }
    }
  }
  return null;
}

/**
 * Pull the records out of a decoded resource: entities (with their components and their own
 * overridden members) and groups, in document order.
 *
 * `depth` is the number of enclosing **records**, not the number of enclosing blocks: the writer
 * wraps some children in an extra anonymous block, and a reader asking "how deep is this in the
 * scene graph" wants the area → task → slot answer, not the container count.
 *
 * `prefab` is a GUID; add a path with `--rdb` (see the CLI) — the file itself only stores the
 * GUID, and only the resource database can name the prefab.
 *
 * `instances` bounds how many members of a group are expanded into records. A terrain world
 * hides a million trees in a few hundred groups, and materialising them is neither useful nor
 * affordable; a group is always reported, with `instances` (its member count) and
 * `expanded` saying whether the members are in the list. `instances: 0` never expands.
 */
export function entities(ebin, { instances = 2000 } = {}) {
  const out = [];
  walk(ebin.tokens, 0, out, { instances });
  return out;
}

function walk(tokens, depth, out, opts) {
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    // a group: "$grp" <class> [":" <prefab>] <block>; each member block is one instance of it
    if (t.kind === "name" && t.value === "$grp") {
      let j = i + 1;
      const className = tokens[j] && tokens[j].kind === "name" ? tokens[j].value : null;
      if (className !== null) j++;
      let prefab = null;
      if (tokens[j] && tokens[j].kind === "name" && tokens[j].value === ":" && tokens[j + 1] && tokens[j + 1].kind === "guidRef") {
        prefab = { guid: tokens[j + 1].value, index: tokens[j + 1].index };
        j += 2;
      }
      const body = tokens[j];
      if (body && body.kind === "block") {
        // A member is a block; an `id` in the group's content belongs to the member block that
        // follows it, which is how `$grp GenericEntity : <prefab>` keeps `CP_Kamensk` attached to
        // the first of its instances (the others carry no id at all).
        const members = [];
        let pendingId = null;
        for (const c of body.opaque || !body.children ? [] : body.children) {
          if (c.kind === "id") { pendingId = c.value; continue; }
          if (c.kind !== "block") continue;
          members.push({ block: c, id: pendingId });
          pendingId = null;
        }
        const group = {
          kind: "group",
          className,
          id: null,
          at: t.at,
          depth,
          prefab,
          fields: body.children ? membersOf(body.children) : [],
          components: [],
          instances: body.opaque ? null : members.length,
          expanded: false,
          position: null,
          angle: null,
          opaque: body.opaque === true,
        };
        out.push(group);
        // Expand the members that are cheap to expand, and always look for real records nested
        // inside them: a base group holds 5 harbours, each of which holds its own entities.
        const expand = opts.instances > 0 && members.length <= opts.instances;
        for (const { block: m, id } of members) {
          if (!m.children) continue;
          const own = membersOf(m.children);
          const coords = own.find((f) => f.name === "coords" && Array.isArray(f.value));
          const angles = own.find((f) => f.name === "angles" && Array.isArray(f.value));
          if (expand) {
            const compIdx = m.children.findIndex((c) => c.kind === "name" && c.value === "components");
            const compBody = compIdx >= 0 ? m.children[compIdx + 1] : null;
            out.push({
              kind: "instance",
              className: group.className,
              id,
              at: m.at,
              depth: depth + 1,
              prefab: group.prefab,
              fields: own,
              components: compBody && compBody.kind === "block" && compBody.children ? componentsOf(compBody.children) : [],
              position: coords ? coords.value : null,
              angle: angles ? angles.value : null,
              opaque: false,
            });
          }
          walk(m.children, expand ? depth + 2 : depth + 1, out, opts);
        }
        group.expanded = expand && members.length > 0;
        if (!expand && members.length) group.position = firstMemberPosition(members.map((m) => m.block));
        i = j; // the header and the block are consumed: do not read the header again as a record
        continue;
      }
    }

    const rec = recordAt(tokens, i);
    if (rec) {
      const body = rec.body;
      const children = body.children ?? [];
      const compIdx = children.findIndex((c) => c.kind === "name" && c.value === "components");
      const compBody = compIdx >= 0 ? children[compIdx + 1] : null;
      const components = compBody && compBody.kind === "block" && compBody.children ? componentsOf(compBody.children) : [];
      // The entity's own members: the `name value` pairs directly in its block. A nested record
      // and every component's members sit inside their own blocks, so they cannot leak here —
      // which is what keeps `membersOf` safe without per-token bookkeeping (the leading run of
      // `empty` padding is not a name, so it never desynchronises the pairs).
      const fields = membersOf(children);
      const coords = fields.find((f) => f.name === "coords" && Array.isArray(f.value));
      const angles = fields.find((f) => f.name === "angles" && Array.isArray(f.value));
      out.push({
        kind: "entity",
        className: rec.cls,
        id: rec.id,
        at: rec.at,
        depth,
        prefab: rec.guid ? { guid: rec.guid, index: rec.index } : null,
        fields,
        components,
        position: coords ? coords.value : null,
        angle: angles ? angles.value : null,
        opaque: body.opaque === true,
      });
      walk(children, depth + 1, out, opts);
      i += 2; // the record body was walked as a scope of its own: do not descend into it twice
      continue;
    }
    if (t.kind === "block" && t.children) walk(t.children, depth, out, opts);
  }
}

/** The transform of a group's first member, for a group whose members are not expanded. */
function firstMemberPosition(members) {
  for (const m of members) {
    if (!m.children) continue;
    const own = membersOf(m.children);
    const c = own.find((f) => f.name === "coords" && Array.isArray(f.value));
    if (c) return c.value;
  }
  return null;
}

/**
 * The sub-scene chain: the `.ent` resources a world's GUID table names, in table order.
 *
 * A sub-scene lists the base scene it layers over in that table. Across the four
 * `CTI_Campaign_*` worlds checked, entry 0 is that map's terrain world — `CTI_Campaign_Cain`
 * names `worlds/Cain/Cain.ent`, `CTI_Campaign_Arland` `worlds/Arland/Arland.ent`,
 * `CTI_Campaign_Montignac` `worlds/Eden/Eden.ent` — and the reference to it is the `Parent`
 * member, which is why `used` is now normally true for entry 0. Returns
 * `[{ guid, index, used, path }]`.
 */
export function scenes(ebin, rdb) {
  if (!rdb) return [];
  const used = new Set();
  const mark = (list) => { for (const t of list) { if (t.kind === "guidRef") used.add(t.index); if (t.children) mark(t.children); } };
  mark(ebin.tokens);
  return ebin.header.guids
    .map((guid, index) => ({ guid, index, used: used.has(index), path: rdb.get(guid) ?? null }))
    .filter((s) => s.path !== null && s.path.toLowerCase().endsWith(".ent"));
}

// ---------------------------------------------------------------------------
// resourceDatabase.rdb — GUID -> path
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

  node tools/ebin.mjs info      <file> [--json]
  node tools/ebin.mjs names     <file>
  node tools/ebin.mjs guids     <file> [--rdb <resourceDatabase.rdb>]
  node tools/ebin.mjs resources <file> ... --rdb <resourceDatabase.rdb> [--json]
  node tools/ebin.mjs worlds    <file> ... --rdb <resourceDatabase.rdb> [--json]
  node tools/ebin.mjs tokens    <file> [--from N] [--limit N|0] [--json]
  node tools/ebin.mjs entities  <file> [--filter RE] [--limit N|0] [--rdb <rdb>] [--json]
  node tools/ebin.mjs find      <file> <needle>
  node tools/ebin.mjs verify    <file> ... [--json]

A world file stores overrides, not entities: each record names the prefab it was made from and
the properties it changes. --rdb turns those GUIDs into prefab paths, which is what makes the
output readable — the file itself carries only the GUID.

Options
  --strict        stop at the first undecodable byte instead of resynchronising
  --from N        first token index to print (tokens)
  --limit N       maximum tokens/entities to print (default 200; 0 = every one)
  --all           same as --limit 0
  --filter RE     entities whose class, id, prefab, a member or a component matches RE
  --rdb <file>    resolve GUIDs through resourceDatabase.rdb: prefab and resource references
                  (entities), the resource names in the table (resources), the base scene
  --json          machine-readable output; entities, tokens, resources and worlds are
                  wrapped in an envelope carrying the file and any truncation
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
    else if (a === "--instances") flags.instances = parseInt(argv[++i], 10);
    else if (a === "-h" || a === "--help") flags.help = true;
    else flags._.push(a);
  }
  return flags;
}

const num = (v) => (Number.isInteger(v) ? String(v) : Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v));
const vec = (v) => v.map(num).join(", ");

function fmtValue(f, rdb) {
  if (f.kind === "vec3" || f.kind === "vec4") return vec(f.value);
  if (f.kind === "guidRef" || f.kind === "guid") {
    const path = rdb?.get(f.value);
    return `{${f.value}}${path ? ` ${path}` : ""}`;
  }
  if (f.kind === "string" || f.kind === "id") return JSON.stringify(f.value);
  if (f.kind === "block") return `<block, ${f.blockBytes} bytes${f.opaque ? ", opaque" : ""}>`;
  if (f.kind === "array") return `<array of ${f.count} x ${f.elemKind}>`;
  if (f.kind === "u8") return f.value === 1 ? "true" : f.value === 0 ? "false" : String(f.value);
  if (f.kind === "f32") return num(f.value);
  if (f.kind === "u64") return "0x" + f.value;
  if (f.kind === "empty") return "";
  return String(f.value);
}

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
    opaqueBlocks: ebin.opaqueBlocks,
    opaqueBytes: ebin.opaqueBytes,
    undecodedRegions: ebin.gaps.length,
    exact: ebin.exact,
  };
  if (flags.json) { console.log(JSON.stringify(info, null, 2)); return; }
  console.log(`${ebin.file}`);
  console.log(`  version        ${header.version}`);
  console.log(`  name table     ${header.names.length} names (offsets 12..${header.namesEnd})`);
  console.log(`  guid table     ${header.guids.length} GUIDs (resources and component instances)`);
  console.log(`  value stream   starts at ${header.body}, ${ebin.bodySize} bytes`);
  console.log(`  tokens         ${ebin.tokenCount}`);
  console.log(`  decoded        ${((100 * ebin.decodedBytes) / ebin.bodySize).toFixed(1)}% of the stream` +
    (ebin.exact ? " (no gaps)" : `, ${ebin.gaps.length} undecoded region(s), ${ebin.gapBytes} bytes`));
  if (ebin.opaqueBlocks) {
    console.log(`  opaque         ${ebin.opaqueBlocks} block(s), ${ebin.opaqueBytes} bytes — data, not records` +
      " (BSP, navmesh, generated geometry)");
  }
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
  if (flags.rdb) {
    const named = ebin.header.guids.filter((g) => rdb.has(g)).length;
    console.log(`\n${named} of ${ebin.header.guids.length} entries name a resource; the rest are component instance GUIDs.`);
  }
}

/**
 * How many records to print. `--limit 0` and `--all` mean "every one"; a bare run still stops at
 * 200 so a large world does not have to be scrolled, but the JSON says so.
 */
function rowLimit(flags, fallback = 200) {
  if (flags.all) return Infinity;
  const n = flags.limit ?? fallback;
  return Number.isFinite(n) && n > 0 ? n : Infinity;
}

function cmdTokens(ebin, flags) {
  const from = flags.from ?? 0;
  const limit = rowLimit(flags);
  const flat = flatten(ebin.tokens);
  const slice = flat.slice(from, from + limit);
  if (flags.json) {
    // An envelope, not a bare array: `--json` defaults to 200 rows, and a caller that cannot see
    // `total` has no way to tell a complete resource from a truncated one.
    console.log(JSON.stringify({
      file: ebin.file,
      total: flat.length,
      from,
      returned: slice.length,
      truncated: slice.length < flat.length - from,
      tokens: slice.map((t) => ({
        at: t.at, depth: t.depth, kind: t.kind,
        name: t.kind === "name" ? t.value : undefined,
        value: t.kind === "block" ? `${t.end - t.at - 3} bytes` : t.value,
        opaque: t.opaque === true ? true : undefined,
      })),
    }, null, 2));
    return;
  }
  for (const t of slice) {
    const pad = "  ".repeat(t.depth);
    let show = t.value;
    if (t.kind === "block") show = `<${t.end - t.at - 3} bytes${t.opaque ? ", opaque" : ""}>`;
    else if (t.kind === "guidRef") show = `{${t.value}}${t.component ? " (component)" : ""}`;
    else if (t.kind === "guid") show = `{${t.value}} (inline)`;
    else if (t.kind === "vec3" || t.kind === "vec4") show = `(${vec(t.value)})`;
    else if (t.kind === "string" || t.kind === "id") show = JSON.stringify(t.value);
    else if (t.kind === "array") show = `[${t.count} x ${t.elemKind}]`;
    else if (t.kind === "empty") show = "";
    console.log(`${String(t.at).padStart(9)}  ${pad}${t.kind === "name" ? "" : `${t.kind} `}${show}`);
  }
  if (slice.length < flat.length - from) console.log(`... ${flat.length - from - slice.length} more token(s)`);
}

/** Annotate a record's GUIDs with the resource paths the rdb knows. */
function annotate(e, rdb) {
  if (!rdb) return e;
  const prefabPath = e.prefab ? rdb.get(e.prefab.guid) ?? null : null;
  const fields = e.fields.map((f) => (f.guid ? { ...f, path: rdb.get(f.guid) ?? null } : f));
  return {
    ...e,
    prefab: e.prefab ? { ...e.prefab, path: prefabPath } : null,
    fields,
    components: e.components.map((c) => ({
      ...c,
      fields: c.fields.map((f) => (f.guid ? { ...f, path: rdb.get(f.guid) ?? null } : f)),
    })),
  };
}

function cmdEntities(ebin, flags) {
  const re = flags.filter ? new RegExp(flags.filter, "i") : null;
  const limit = rowLimit(flags);
  const rdb = flags.rdb ? readRdb(flags.rdb) : null;
  const instances = flags.instances === undefined ? 2000 : flags.instances;
  let list = entities(ebin, { instances }).map((e) => annotate(e, rdb));
  if (re) {
    // Match whatever a reader would search by: class, id, prefab path or GUID, an own member's
    // name or string value or resolved resource, and the same for every component. The string
    // value matters because it is where a placed base carries its name
    // (`m_sBaseName "#AR-Campaign_MapLocation_Cain_Kamensk"`), which is the usual thing to search.
    const hit = (f) => re.test(f.name) || (f.path && re.test(f.path))
      || (typeof f.value === "string" && re.test(f.value));
    list = list.filter((e) => re.test(e.className ?? "") || (e.id && re.test(e.id))
      || (e.prefab && (re.test(e.prefab.guid) || (e.prefab.path && re.test(e.prefab.path))))
      || e.fields.some(hit)
      || e.components.some((c) => re.test(c.className) || c.fields.some(hit)));
  }
  const rows = list.slice(0, limit);
  if (flags.json) {
    // The same envelope as `tokens`, and for the same reason: without `total` a 2 339-record
    // world and its first 200 records are the same JSON. `coverage` rides along because
    // nothing read out of a file with opaque regions may be presented as complete.
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
        opaqueBlocks: ebin.opaqueBlocks,
        opaqueBytes: ebin.opaqueBytes,
        gaps: ebin.gaps.length,
        exact: ebin.exact,
      },
      entities: rows,
    }, null, 2));
    return;
  }
  const entities2 = list.filter((e) => e.kind === "entity").length;
  const groups = list.filter((e) => e.kind === "group").length;
  const inst = list.length - entities2 - groups;
  console.log(`${ebin.file}: ${list.length} record${list.length === 1 ? "" : "s"}` +
    ` (${entities2} entit${entities2 === 1 ? "y" : "ies"}, ${groups} group${groups === 1 ? "" : "s"}` +
    `${inst ? `, ${inst} expanded instance${inst === 1 ? "" : "s"}` : ""})` +
    `${re ? ` matching /${flags.filter}/i` : ""}`);
  if (!rdb) console.log("  (no --rdb: prefabs show as GUIDs — the file stores no path)");
  const printMembers = (e, indent) => {
    if (e.position) console.log(`${indent}  position ${vec(e.position)}${e.angle ? `   angle ${vec(e.angle)}` : ""}`);
    for (const f of e.fields) {
      if (f.name === "coords" || f.name === "angles") continue;
      console.log(`${indent}  ${f.name} = ${fmtValue(f, rdb)}`);
    }
    for (const c of e.components) {
      console.log(`${indent}  component ${c.className} {${c.guid}}${c.opaque ? "  (opaque)" : ""}`);
      for (const f of c.fields) console.log(`${indent}      ${f.name} = ${fmtValue(f, rdb)}`);
    }
  };
  for (const e of rows) {
    const indent = "  ".repeat(e.depth);
    if (e.kind === "group") {
      const count = e.instances === null ? "opaque content" : `${e.instances} instance${e.instances === 1 ? "" : "s"}`;
      const notExpanded = e.instances !== null && e.instances > 0 && !e.expanded ? " — members not expanded (see --instances)" : "";
      console.log(`\n${indent}$grp ${e.className ?? "?"}${e.prefab ? ` : {${e.prefab.guid}}${e.prefab.path ? ` ${e.prefab.path}` : ""}` : ""}` +
        `  ${count}${notExpanded}  @${e.at}`);
      printMembers(e, indent);
      continue;
    }
    if (e.kind === "instance") {
      console.log(`\n${indent}instance of ${e.className ?? "?"}${e.id ? ` "${e.id}"` : ""}  @${e.at}`);
      printMembers(e, indent);
      continue;
    }
    const id = e.id ? ` "${e.id}"` : "";
    console.log(`\n${indent}${e.className}${id}  @${e.at}`);
    if (e.prefab) {
      console.log(`${indent}  prefab   {${e.prefab.guid}}${e.prefab.path ? ` ${e.prefab.path}` : rdb ? "  <- not a resource" : ""}`);
    }
    printMembers(e, indent);
  }
  if (rows.length < list.length) console.log(`... ${list.length - rows.length} more record(s) (--limit 0 for all)`);
  if (ebin.gapBytes) {
    console.log(`\n${(100 * ebin.decodedBytes / ebin.bodySize).toFixed(1)}% of the value stream decoded` +
      `; ${ebin.opaqueBlocks} opaque block(s), ${ebin.gapBytes} byte(s) not understood (see \`info\`).`);
  }
}

function cmdFind(ebin, needle) {
  const lower = needle.toLowerCase();
  let hits = 0;
  for (const t of flatten(ebin.tokens)) {
    const text = t.kind === "name" || t.kind === "string" || t.kind === "id" ? String(t.value) : null;
    if (text && text.toLowerCase().includes(lower)) {
      console.log(`@${String(t.at).padStart(9)}  ${"  ".repeat(t.depth)}${t.kind.padEnd(6)} ${JSON.stringify(t.value)}`);
      hits++;
    }
  }
  console.log(`# ${hits} hit(s)`);
}

/**
 * The sub-scene chain of one or more worlds. A world file can hold only the layers added on top of
 * a base scene, so "what else is this based on" is not answerable from its entities — the base
 * scene is named in the GUID table and referenced by the `Parent` member.
 */
function cmdWorlds(files, flags) {
  if (!flags.rdb) {
    process.stderr.write("worlds needs --rdb <resourceDatabase.rdb>: only the resource database can say which GUIDs are world resources.\n");
    process.exitCode = 1;
    return;
  }
  const rdb = readRdb(flags.rdb);
  const rows = [];
  for (const file of files) {
    try {
      const e = readEbin(file, { strict: flags.strict });
      rows.push({ file, scenes: scenes(e, rdb) });
    } catch (err) {
      rows.push({ file, error: err.message });
    }
  }
  if (rows.some((r) => r.error)) process.exitCode = 1;
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) {
    if (r.error) { console.log(`FAIL  ${basename(r.file)}: ${r.error}`); continue; }
    console.log(`\n${r.file}`);
    if (!r.scenes.length) { console.log("  no .ent in the GUID table — this is a base scene"); continue; }
    for (const s of r.scenes) {
      console.log(`  [${s.index}] {${s.guid}}  ${s.path}${s.used ? "" : "   <- named but not referenced: the base scene"}`);
    }
  }
}

/**
 * The resources a world names, from its GUID table. `used` says whether a `0x05` reference
 * points at the entry — `Parent` and prefab references both do.
 */
function cmdResources(files, flags) {
  if (!flags.rdb) {
    process.stderr.write("resources needs --rdb <resourceDatabase.rdb>: only the resource database can say which GUIDs name a resource.\n");
    process.exitCode = 1;
    return;
  }
  const rdb = readRdb(flags.rdb);
  const rows = [];
  for (const file of files) {
    try {
      const e = readEbin(file, { strict: flags.strict });
      const used = new Set();
      for (const t of flatten(e.tokens)) if (t.kind === "guidRef") used.add(t.index);
      const found = [];
      let localIds = 0;
      e.header.guids.forEach((guid, index) => {
        const path = rdb.get(guid) ?? null;
        if (path) found.push({ guid, index, path, used: used.has(index) });
        else localIds++;
      });
      rows.push({ file, resources: found, tableEntries: e.header.guids.length, localIds });
    } catch (err) {
      rows.push({ file, error: err.message });
    }
  }
  if (rows.some((r) => r.error)) process.exitCode = 1;
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) {
    if (r.error) { console.log(`FAIL  ${basename(r.file)}: ${r.error}`); continue; }
    console.log(`\n${r.file}`);
    if (!r.resources.length) { console.log("  no resource names in the GUID table"); continue; }
    for (const s of r.resources) {
      console.log(`  [${String(s.index).padStart(4)}] {${s.guid}}${s.used ? " used  " : "       "} ${s.path}`);
    }
    const used = r.resources.filter((s) => s.used).length;
    console.log(`  ${r.resources.length} resource name(s) in a table of ${r.tableEntries}` +
      `, ${r.localIds} entr${r.localIds === 1 ? "y" : "ies"} naming nothing in the resource database` +
      (used ? `; ${used} of them referenced by a token` : "; none of them referenced by a token"));
  }
}

function cmdVerify(files, flags) {
  const rows = [];
  for (const file of files) {
    try {
      const e = readEbin(file, { strict: flags.strict });
      rows.push({ file, tokens: e.tokenCount, bodyBytes: e.bodySize, gapBytes: e.gapBytes, gaps: e.gaps.length, opaqueBlocks: e.opaqueBlocks, exact: e.exact });
    } catch (err) {
      rows.push({ file, error: err.message });
    }
  }
  if (rows.some((r) => r.error)) process.exitCode = 1;
  if (flags.json) { console.log(JSON.stringify(rows, null, 2)); return; }
  for (const r of rows) {
    if (r.error) { console.log(`FAIL  ${basename(r.file)}: ${r.error}`); continue; }
    const pct = ((100 * (r.bodyBytes - r.gapBytes)) / r.bodyBytes).toFixed(1);
    console.log(`${r.exact ? "EXACT" : "GAPS "} ${basename(r.file).padEnd(34)} tokens ${String(r.tokens).padStart(9)}  decoded ${pct}%` +
      (r.exact ? "" : `  (${r.gaps} region(s), ${r.opaqueBlocks} opaque block(s), ${r.gapBytes} bytes)`));
  }
  const ok = rows.filter((r) => !r.error);
  const exact = ok.filter((r) => r.exact).length;
  const bytes = ok.reduce((s, r) => s + r.bodyBytes, 0);
  const gap = ok.reduce((s, r) => s + r.gapBytes, 0);
  console.log(`\n${exact}/${ok.length} files decode exactly; ${(100 * (bytes - gap) / bytes).toFixed(2)}% of ${bytes} stream bytes decoded`);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags._.length === 0) { process.stdout.write(USAGE); process.exit(flags._.length ? 0 : 1); }
  const [command, file, needle] = flags._;
  if (!file) { process.stderr.write(USAGE); process.exit(1); }
  if (command === "verify") { cmdVerify(flags._.slice(1), flags); return; }
  if (command === "worlds") { cmdWorlds(flags._.slice(1), flags); return; }
  if (command === "resources") { cmdResources(flags._.slice(1), flags); return; }
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

