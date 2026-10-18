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
//   node tools/ebin.mjs lengths   <file>... [--lenient] [--json]
//   node tools/ebin.mjs verify    <file>... [--lenient] [--json]
//
// Also usable as a library: `import { readEbin, entities } from "./ebin.mjs"`. `readEbin` takes a
// path, or the bytes themselves (a `.pak` entry, a buffer someone else read), so a caller does not
// have to spill a world to disk to parse it.
//
// ---------------------------------------------------------------------------
// WHAT A WORLD FILE ACTUALLY CONTAINS — read this before trusting any field
//
// A `.ent` file is NOT a list of finished entities. It is a list of *overrides*: for each
// entity it stores the class, the instance id, **which prefab it was made from**, and only
// the properties whose value differs from that prefab. Everything else — every component the
// entity has, every default — lives in the `.et` prefab and is not in this file at all (and a
// default the prefab itself omits comes from the class's attribute declaration or the engine).
//
// That is why `--rdb` matters so much: the GUID of the prefab is stored, and only
// `resourceDatabase.rdb` can turn it into a path. Measured across all 103 worlds shipped in
// 1.8.0.13's `addons/data` and `addons/core`: **9 560 of 9 560** entity records that name a
// prefab resolve to a path, and every one of the 20 252 `:`+GUID+block constructs resolves
// (19 580 `.et`, 647 `.conf`, 25 `.ct`) — so the prefab path printed here is the real one.
//
//   > GenericEntity "CP_Kamensk" : "{...}ConflictControlPoint.et" { m_sBaseName "..." }
//
// reads as: an instance of that prefab, called CP_Kamensk, which overrides `m_sBaseName`. The rest
// of what CP_Kamensk *is* — 22 components, in Workbench — is in the prefab and not in this file.
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
//   0x02  u64          8 bytes      **two 32-bit words**, not one number. Every field that carries
//                                   this tag is a bit mask — `Flags` (2 107 724 of the 2 107 782
//                                   occurrences), `LightType`, `Rendering`, `TerrainDetectionMask`,
//                                   `Collision detection layers` — and the text form of the same
//                                   object prints it as a pair: `Flags 0x100003 0`,
//                                   `LightType 0x40 0`, `Rendering 0x1d 0x20`. Verified against a
//                                   prefab and the world that instantiates it: `Flags 0x100003 0`
//                                   is exactly `03 00 10 00 00 00 00 00`. Both words are decoded,
//                                   little-endian, in the order the text form prints them
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
//                                   The content is more tokens (an object), a text payload, or
//                                   data that is neither; see below
//   0x43  id string    u16 len      the entity's instance name ("CP_Kamensk")
//   0x44  guid inline  8 bytes      a GUID carried in the stream, not in the table
//   0x45  guid ref     u16 index    a GUID table index used for component instance GUIDs
//   0x8X  array        u32 count    `count` untagged elements of the type whose tag is `0xX`:
//                                   0x81 i32, 0x85 guid ref, 0x86 f32, 0x88 vec3, 0x8c string,
//                                   0x8d name. Checked by tiling: the elements consume the
//                                   array's bytes exactly, for every instance measured
//
// Tags 0x03, 0x04, 0x07 and 0x0a are still unidentified: after everything above they appear only
// inside payloads that do not parse at all, never in a scope that otherwise decodes.
//
// A block that does not parse as tokens is not automatically "opaque". Two shapes are established
// by tiling and are read instead:
//
//   - **text**: printable ASCII. That is `BSP`, the world's visibility tree, and its first number
//     is the node count — `<u32 nodeCount>` then `nodeCount` records of four integers, holding for
//     all 19 in the shipped worlds. Reported as a summary (`<text: 4545 integers, 1136 records of
//     4>`), never as undecoded.
//   - **a list behind two bytes**: the content after two bytes tiles exactly as sub-blocks (115 of
//     the 143 such payloads; no other offset in 1..3 works). The first byte is a value of the
//     **prefab in that world**, and that is measured rather than assumed: it is constant for all 108
//     (world, prefab) pairs and different in another world for all 14 prefabs that appear in more
//     than one (`b_juniperus_communis_0.et` is 4 in Arland, 13 in Cain), and it groups prefabs
//     inside a world (Arland: 10 prefabs, 5 values; Cain: 46 and 22; Eden: 47 and 19). A group of
//     records starts `00 00`, so the value is 0 there. That is the shape of an index into a
//     per-world table several prefabs share — most likely the terrain's material bucket, not proven
//     — so it is kept as `headerBytes: 2` / `header: [N, 0]` and never interpreted. It is not the
//     unit count (2/117), the member count, the number of distinct shapes (3/117), the first unit's
//     length (4/117), a cell index (≤13/117 for 85 combinations) or a GUID-table index.
//
// THE STORED LENGTH IS NOT A DELIMITER — measured, not preferred
//
// A block is `0x0e` + a u16. Across the 103 shipped worlds **256 of those u16s are short of their
// block's content** (11 files) — and the field cannot be the end of the block:
//
//   - A block larger than 64 KiB cannot be expressed in a u16 at all. Twelve blocks are that big;
//     seven of them store *exactly* `trueLength mod 65536` — the field wraps, and only the tokens
//     can say where the block ends.
//   - 189 of the 256 recorded ends fall **inside a value** (`vec3`, `u64`, `f32`, `string`, `guid`, or
//     a block's own header), a place no block can end.
//   - The other 67 fall exactly on a token boundary, and the token there cannot continue the
//     enclosing record list: 53 are a field name (`coords` 14, `angles` 15, `scale` 16, `Flags` 7,
//     `Position` 1), 10 are padding before one of those, 3 are a bare value and 1 is a bare block.
//   - **248 are the last child block's own doing**: its stored length is *exactly* its content and
//     reaches past the parent's end. The other 8 are enclosing blocks whose last child is itself one
//     of the 256, so the shortfall is inherited along the chain.
//
// The child's number is corroborated by its bytes; the parent's is contradicted by them. So the
// reader parses tokens and lets a block's extent be its tokens' extent — the stored length is a
// lower bound, never a delimiter. There is no choice to make: the alternative reading would end a
// block in the middle of a payload, or end a record list at a field name. `node tools/ebin.mjs
// lengths <worlds>` prints every case with the token its stored end falls in, and `info`/`verify`
// report the counts.
//
// Everything decodes: **103 of 103 worlds shipped with 1.8.0.13 tile to their exact last byte**
// (168 530 192 value-stream bytes). A payload that does not tile is still reported as `opaque` with its
// bytes counted rather than guessed at — that is the rule, not a leftover; it simply does not fire on
// this corpus any more.
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
//      coords 81.09 4.70 64.02                          <- the transform: coords, angles, scale
//      angles 0 173.65 0                                <-   each written only when not the default
//      scale 2.2
//      {                                                <- a child list of its own
//       $grp Building : "{...}win_brown.et" {           <- its children, grouped by class+prefab
//        { … } { … }
//       }
//       GenericEntity : "{...}Drain.et" { … }           <- a child that appears once
//      }
//     }
//
// The transform is three ordinary members — `coords`, `angles`, `scale` — and a value equal to the
// default is not written at all: `angles 0 0 0` and `scale 1` never appear, so an entity without a
// `scale` is at 1. 2 637 808 `scale` members exist across the shipped worlds; 816 of `Arland.ent`'s
// 2 271 nodes are not at scale 1. (The default is not always the prefab's: it can be the member's
// attribute declared in the class, or the engine's default for it — see the game-data skill.)
//
// `Flags` is `EntityFlags`, and the bit names come from the installed build's own generated script
// `scripts/Core/generated/Entities/EntityFlags.c`: VISIBLE, TRACEABLE, NO_LINK, FEATURE, SET_RENDERED,
// STREAMABLE, ACTIVE, STATIC, USER1..USER5, NO_TREE, RELATIVE_Y, EDITOR_ONLY, DISABLED, PROXY,
// UPDATE_LINK. Only the low word of the `0x02` pair follows that enum; the high word is a second mask
// it does not describe (every vegetation instance in the shipped worlds is `Flags 0 0x80000`).
//
// In the binary that is, unambiguously:
//
//   * an **entity** is `[name class] [0x43 id] [name ":"] [0x05 prefab] [0x0e block]`. The
//     `:`+GUID+block triple is present in every one of the 20 252 constructs measured, and nothing
//     else in the format looks like it — this is the anchor the reader uses, not a guess about
//     capitalisation or field prefixes. The id is optional: a child that keeps its prefab's name
//     stores none, and that is most of a world's entities. Without a prefab the entry is
//     `[name class] [id] [block]` — the world entity and the sun carry an id, a road child of a
//     road generator carries neither (`RoadEntity { … }`, 434 in `Arland.ent`).
//   * entities of one class and prefab are written **consecutively**, and only the first names
//     them: `[id] [block]` entries after it inherit both. `MP/Coop_CombatOps_Cain.ent` has 205 of
//     them; a group is the same compaction at scale.
//   * the entity's **own members** are the `name value` pairs directly in its block — the ones
//     before and after the `components` section alike. A child list lives inside its own block, so
//     it can never leak members onto its parent.
//   * a **component** is `[name class] [0x45 or 0x44 GUID] [0x0e block]` inside the `components`
//     block. The GUID belongs to the component *slot*, not to the class: the 246 occurrences of
//     `SCR_ScenarioFrameworkArea` across the shipped worlds all carry `59E8CDC50969206E`, which is
//     the GUID it has in `Area.et` — that is what makes a world's override readable as "this
//     component of the prefab". Do not generalise it: 60 of the 216 component classes appear with
//     more than one GUID, because a class a prefab creates per instance (`MeshObject`, 25
//     distinct) gets a fresh one each time.
//   * a component can carry **sub-components** of its own: its block holds a `components { … }` list,
//     exactly as an entity does, and that list can nest further — the same keyword one level down.
//     That is the shape Workbench writes when a component is built out of components, and it was
//     read out of a project's own text layer (`worlds/arland_test_Layers/default.layer`):
//
//         SCR_RespawnSystemComponent "{6AA37B0DFEF7C77E}" {
//          components {
//           SCR_FreeSpawnHandlerComponent "{6AA37B0DC66AC72F}" { … }
//          }
//          m_bEnablePauseMenuRespawn 0                   <- the parent's own field, after the list
//         }
//
//     57 components in the shipped worlds carry one, 140 sub-components in total. A class-and-GUID
//     *without* that wrapper is a member's object value (`LinkType NavmeshDoorLink { … }`), not a
//     component.
//   * the graph is a **tree of child lists**, and the file is one of them: the top is the world's
//     own children, an entity's children sit in a child list inside its body, theirs in a child
//     list inside theirs. `Arland.ent` is 4 levels deep, `MP/Coop_CombatOps_Cain.ent` 8.
//   * `$grp <class> [":" <prefab>] <block>` is a **group**: one header and N member blocks with only
//     transforms and overrides. That is where a terrain world keeps its vegetation and road
//     instances — 1 542 groups and 1 419 984 members in `Cain.ent` alone — so a group is reported as
//     one node carrying `instances: N`, never expanded beyond `--instances`.
//     **The member list is not bounded by that block.** When it does not fit, the rest of the
//     members follow *outside* it as sibling blocks — `[id] [block]` pairs, no second header — and
//     a group is therefore the body's blocks plus every block that follows. That is measured, not
//     assumed: `Arland.ent` holds 63 644 members inside bodies and 108 078 outside, and with them
//     the world has 173 206 entity-and-member nodes against the **173 226 the World Editor reports
//     for the same file** (20 off, 0.01 %); without them it is 64 822, a third of the world. 253
//     groups in the 103-file corpus overflow this way.
//
// A **member's value** is a block more often than not, and what is inside it is readable, so it is
// read rather than summarised: padding plus one value is an array (that is how every array is
// written); `ClassName` + GUID + block repeating is an array of objects (`m_aActivationActions`);
// `name value` pairs are a struct; `ClassName` + GUID + block after a member name is a nested
// object (`m_Getter`). Only a block that did not tile is left as a size and marked `opaque`.
// A member written `name + value` is the **append operator** — the text form writes
// `m_aWheels + { 4 5 6 7 }`, meaning "append to the array the prefab already has" — and it is
// reported as `+=` so a reader cannot mistake it for a replacement.
//
// A member's *block* is never a child list, however much it looks like one: `Data { … }` is a member
// of a `ShapePoint` whose value is a struct (285 in `Eden.ent`), while `RoadEntity { … }` is a child.
// Both are a name followed by a block; only the token in front says which — a value, or the list's
// boundary (padding, or the previous entry's block). Reading those as children otherwise invented
// 339 nodes in `Eden.ent`.
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
  0x07: { kind: "vec2", width: 9 },
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
  // Every shipped resource is version 1 (all 103 worlds of 1.8.0.13). A different number is a format
  // this reader was not written for, and parsing it as version 1 would produce numbers, not data.
  if (version !== 1) {
    throw new Error(`unsupported EBIN version ${version}: this reader understands version 1`);
  }
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

/** How many elements of an array are decoded into `values`. The `count` is always exact. */
const ARRAY_VALUE_CAP = 256;

/**
 * Read one array element, which is untagged: the array's tag already fixed its type.
 * Returns `{ value, width }`, where `width` is the element's size in bytes.
 */
function readArrayElement(buf, header, elemTag, p) {
  const spec = TAGS[elemTag];
  const b = buf;
  switch (spec.kind) {
    // An array element carries no tag, so its width is the scalar's width minus the tag byte —
    // which is 0 for an `empty` element, and tiling breaks if that byte is counted.
    case "empty": return { value: null, width: 0 };
    case "i32": return { value: b.readInt32LE(p), width: 4 };
    case "f32": return { value: b.readFloatLE(p), width: 4 };
    case "u8": return { value: b[p], width: 1 };
    case "u64": return { value: b.subarray(p, p + 8).toString("hex").toUpperCase(), width: 8 };
    case "vec2": return { value: [b.readFloatLE(p), b.readFloatLE(p + 4)], width: 8 };
    case "vec3": return { value: [b.readFloatLE(p), b.readFloatLE(p + 4), b.readFloatLE(p + 8)], width: 12 };
    case "vec4": return { value: [b.readFloatLE(p), b.readFloatLE(p + 4), b.readFloatLE(p + 8), b.readFloatLE(p + 12)], width: 16 };
    case "guid": return { value: Buffer.from(b.subarray(p, p + 8)).reverse().toString("hex").toUpperCase(), width: 8 };
    case "guidRef": {
      const idx = b.readUInt16LE(p);
      return { value: idx < header.guidCount ? header.guids[idx] : null, index: idx, width: 2 };
    }
    case "name": {
      const idx = b.readUInt16LE(p);
      return { value: idx < header.nameCount ? header.names[idx] : null, index: idx, width: 2 };
    }
    case "string": {
      const len = b.readUInt16LE(p);
      return { value: b.toString("utf8", p + 2, p + 2 + len), width: 2 + len };
    }
    default: return null;
  }
}

/**
 * Read one token at `p`. Returns `{ token }` or `{ error }`.
 *
 * A block's declared end is NOT checked against `end` here: the writer sometimes records a parent's
 * length a few bytes short of its own last child, and `readScope` decides what to do about that —
 * it can only decide by parsing the child, which needs the child's own declared end.
 */
function readToken(buf, header, p, end, tags) {
  const tag = buf[p];
  const spec = tags[tag];
  if (!spec) return { error: `undecoded tag 0x${tag.toString(16)}` };
  const at = p;

  if (spec.kind === "block") {
    if (p + 3 > end) return { error: "block header runs past the end of its scope" };
    const len = buf.readUInt16LE(p + 1);
    // The length counts its own two bytes, so 0 and 1 describe a block smaller than the field that
    // describes it. Accepting one made the reader invent two bytes of "content" and report the file
    // exact; it is a corrupt header, not an empty block (which is exactly 2).
    if (len < 2) return { error: `block declares ${len} byte(s), less than its own 2-byte length field` };
    const blockEnd = p + 1 + len;
    if (blockEnd > buf.length) return { error: `block claims ${len} bytes, more than the file has left (${buf.length - p - 1})` };
    return { token: { at, end: blockEnd, tag, kind: "block", len } };
  }
  if (spec.kind === "array") {
    if (p + 5 > end) return { error: "array header runs past the end of its scope" };
    const count = buf.readUInt32LE(p + 1);
    const elem = tags[spec.elem];
    let q = p + 5;
    const values = [];
    if (elem.width !== undefined) {
      if (q + count * (elem.width - 1) > end) return { error: `array of ${count} x 0x${spec.elem.toString(16)} runs past the end of its scope` };
      // An `empty` element occupies no bytes at all, so a `count` of 2^32-1 is a five-byte array,
      // not 4 294 967 295 iterations: looping over it would hang the reader on a five-byte file.
      // Every element is the same `null`, and `valuesTruncated` says the rest were not materialised.
      if (elem.width === 1) {
        const shown = Array.from({ length: Math.min(count, ARRAY_VALUE_CAP) }, () => null);
        return { token: { at, end: q, tag, kind: "array", count, elemKind: spec.elemKind, elem: spec.elem, values: shown, valuesTruncated: count > ARRAY_VALUE_CAP } };
      }
      for (let i = 0; i < count; i++) {
        const r = readArrayElement(buf, header, spec.elem, q);
        if (!r) return { error: `array element type 0x${spec.elem.toString(16)} has no reader` };
        // An element is untagged, so it cannot report the failure itself; a table index past the end
        // would otherwise become a silent `null` in a list that still tiles.
        if (r.index !== undefined && r.value === null) {
          const table = spec.elem === 0x0d
            ? `name table of ${header.nameCount}`
            : `GUID table of ${header.guidCount}`;
          return { error: `array element ${i} references index ${r.index}, outside the ${table}` };
        }
        if (i < ARRAY_VALUE_CAP) values.push(r.value);
        q += r.width;
      }
    } else if (spec.elem === 0x0c) {
      for (let i = 0; i < count; i++) {
        if (q + 2 > end) return { error: `array of ${count} strings is truncated at element ${i}` };
        const r = readArrayElement(buf, header, 0x0c, q);
        if (i < ARRAY_VALUE_CAP) values.push(r.value);
        q += r.width;
        if (q > end) return { error: `array of ${count} strings runs past the end of its scope` };
      }
    } else {
      return { error: `array of an element type this reader cannot size (0x${spec.elem.toString(16)})` };
    }
    return {
      token: {
        at, end: q, tag, kind: "array", count, elemKind: spec.elemKind, elem: spec.elem, values,
        valuesTruncated: count > ARRAY_VALUE_CAP,
      },
    };
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
    case "u64": {
      // Eight bytes. NOT one number: every field that carries this tag is a bit mask, and the text
      // form of the same object prints it as **two 32-bit words** — `Flags 0x100003 0`,
      // `LightType 0x40 0`, `Rendering 0x1d 0x20`. Verified against a prefab and the world that
      // instantiates it: `Flags 0x100003 0` is exactly `03 00 10 00 00 00 00 00`. So both words are
      // decoded, little-endian, in the order the text form prints them; `value` keeps the raw hex.
      const w0 = b.readUInt32LE(p + 1);
      const w1 = b.readUInt32LE(p + 5);
      return {
        token: {
          at, end: next, tag, kind: "u64", raw: true,
          value: b.subarray(p + 1, next).toString("hex").toUpperCase(),
          words: [w0, w1],
        },
      };
    }
    case "f32": return { token: { at, end: next, tag, kind: "f32", value: b.readFloatLE(p + 1) } };
    case "vec2": return { token: { at, end: next, tag, kind: "vec2", value: [b.readFloatLE(p + 1), b.readFloatLE(p + 5)] } };
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
 *
 * **A parent whose length is short of its own last child.** A stored length is a lower bound (see
 * the file header): in 248 blocks the recorded end falls inside the last child, and that child's own
 * length is exact in every one. So a child that reaches past `end` is not an error to give up on —
 * it is parsed on its own declared end, and the scope takes the child's extent. Only a child that
 * does not tile is left as the failure it looks like.
 *
 * **Payloads that are not tokens.** Two are established, and both are read rather than written off
 * as opaque:
 *
 *   - a block of printable ASCII decimal integers. That is `BSP`, the world's visibility tree, and
 *     it is not opaque at all — it is *text*, and its first number is the node count (measured on
 *     all 19 in the shipped worlds: `count * 4 + 1` is exactly the number of integers).
 *   - a block whose content fails to parse but whose content *after two bytes* tiles exactly as
 *     sub-blocks. That is how a group of instances is written when the members are not plain
 *     records. The two bytes are not understood — they are not the member count and not the unit
 *     count — so they are reported as `headerBytes: 2` and never interpreted.
 */
/**
 * How deep a block may nest before the reader says so instead of running out of stack.
 *
 * Every level is a recursive `readScope` call, so a file of a few thousand nested `0x0e` headers
 * overflows the JavaScript stack (a RangeError from the engine, with no byte to point at). No
 * shipped world nests deeper than 8 (`MP/Coop_CombatOps_Cain.ent`), component sub-components and
 * nested values add only a few levels, so 512 is far past any real file; a hand-made or hostile
 * one gets `block nesting is deeper than 512 levels` and, with `--lenient`, an opaque block.
 */
const MAX_NESTING = 512;

function readScope(buf, header, from, end, tags, tokens, gaps, depth = 0) {
  if (depth > MAX_NESTING) {
    return { failAt: from, error: `block nesting is deeper than ${MAX_NESTING} levels` };
  }
  const attempt = (limit) => {
    const inner = [];
    const innerGaps = [];
    const res = readScopeInner(buf, header, from, limit, tags, inner, innerGaps, depth);
    return { res, inner, innerGaps };
  };

  const first = attempt(end);
  if (first.res.failAt === undefined) {
    for (const t of first.inner) tokens.push(t);
    for (const g of first.innerGaps) gaps.push(g);
    return { end: first.res.end };
  }

  // **A scope whose recorded length stops in the middle of its last child's header.** Two of the
  // shipped worlds stopped decoding at exactly this: the scope's own bytes run out two bytes into the
  // next block's header (`0e` + one length byte), and the block that continues there is the last child
  // of the scope, written without its tail in the parent's length — the "short length" quirk one level
  // further than the child-tiling rule reaches. The child's own length says where it ends, so the
  // scope is re-parsed widened to it: 28 368 and 64 244 bytes in `Eden.ent`, which took coverage from
  // 99.95 % to 100 %.
  const p = first.res.failAt;
  if (p >= from && p < end && p + 3 <= buf.length) {
    const declared = p + 1 + buf.readUInt16LE(p + 1);
    // `declared` is a byte in the stream, not necessarily a block length: it is only trusted when it
    // is a real place in this file. Without the upper bound, a widened attempt could read past the
    // end of the buffer and abort with a RangeError instead of naming the byte that failed.
    if (declared > end && declared <= buf.length) {
      const second = attempt(declared);
      if (second.res.failAt === undefined && second.res.end === declared) {
        for (const t of second.inner) tokens.push(t);
        for (const g of second.innerGaps) gaps.push(g);
        return { end: declared };
      }
    }
  }
  // The tokens before the failure are real and stay: the caller resynchronises after `failAt` and
  // appends what follows, so dropping them here would lose a file's whole prefix while its coverage
  // still counted as decoded.
  for (const t of first.inner) tokens.push(t);
  for (const g of first.innerGaps) gaps.push(g);
  return first.res;
}

function readScopeInner(buf, header, from, end, tags, tokens, gaps, depth = 0) {
  let limit = end;
  let p = from;
  while (p < limit) {
    const r = readToken(buf, header, p, limit, tags);
    if (r.error) return { failAt: p, error: r.error };
    const token = r.token;
    if (token.kind === "block") {
      const inner = [];
      const res = readScope(buf, header, token.at + 3, token.end, tags, inner, gaps, depth + 1);
      if (res.failAt === undefined) {
        token.children = inner;
        // The child is self-consistent and reaches past its own declared end, or past this scope:
        // the recorded length is short, and the bytes say where the block really ends.
        if (res.end !== token.end) { token.widened = res.end - token.end; token.end = res.end; }
        if (token.end > limit) limit = token.end;
      } else if (token.end > limit) {
        // It reaches past the scope AND does not tile: that is not a short length, it is the end.
        return { failAt: p, error: `block claims ${token.len} bytes, more than its scope has left (${limit - p - 1})` };
      } else if (readTextPayload(buf, token)) {
        // `BSP` and anything else written as ASCII: decoded as text, not as undecoded data.
      } else if (readListBehindHeader(buf, header, token, tags, gaps, depth)) {
        // A list behind two bytes: the members are recovered, and that parse can tile **further**
        // than this block's recorded end, exactly like a plain child — the length in front of the
        // list is short by the same writer quirk. Losing that extension is what left the last 34
        // bytes of `MP/Coop_CombatOps_Cain.ent` undecoded and two of its layers at the root.
        if (token.end > limit) limit = token.end;
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
  // `p`, not `limit`: the scope's extent is the extent of the tokens it contains. A last token that
  // runs past the recorded end (a value whose payload straddles it) moves the end with it, exactly
  // as a last child block does; returning the recorded end would rewind the caller into that token.
  return { end: p };
}

/**
 * A block whose content is printable ASCII is a **text payload**, not undecoded data. If it is all
 * decimal integers it is summarised: how many, and — when `first * 4 + 1 === count`, which holds for
 * every `BSP` block measured — how many four-integer records that is. The full text is not kept, so
 * a 64 KB payload does not end up in `--json`.
 */
function readTextPayload(buf, token) {
  const from = token.at + 3, to = token.end;
  if (to <= from) return false;
  let i = from, j = to;
  while (i < j && buf[i] === 0) i++;
  while (j > i && buf[j - 1] === 0) j--;
  if (j <= i) return false;
  for (let k = i; k < j; k++) if (buf[k] < 0x20 || buf[k] >= 0x7f) return false;
  const text = buf.toString("latin1", i, j).trim();
  const parts = text.split(/\s+/);
  const ints = parts.map(Number);
  const allInts = ints.every((n) => Number.isFinite(n));
  token.text = {
    kind: allInts ? "ints" : "ascii",
    bytes: to - from,
    leadingNuls: i - from,
    chars: text.length,
    ints: allInts ? ints.length : undefined,
    // `BSP` is `<u32 nodeCount>` followed by `nodeCount` records of four integers.
    records: allInts && ints[0] * 4 + 1 === ints.length ? ints[0] : undefined,
    head: allInts ? ints.slice(0, 4) : undefined,
  };
  return true;
}

/**
 * A block whose content does not parse as tokens, but whose content after two bytes tiles exactly as
 * sub-blocks, is a **list behind a two-byte header**. The first byte is a value of the prefab in that
 * world — constant per (world, prefab), different across worlds, shared by prefabs that share a
 * bucket, 0 for a group of records (see the header of this file) — and it is reported, never
 * interpreted; the members are recovered as ordinary blocks.
 */
function readListBehindHeader(buf, header, token, tags, gaps, depth = 0) {
  const body = token.at + 3;
  if (token.end - body < 4) return false;
  if (buf[body + 1] !== 0) return false; // every one measured has a zero second byte

  // The list can continue **past the block's recorded end**: the length in front of a member list is
  // short exactly like a plain child's, and the members that follow are named ones — `[id] [block]`
  // pairs. That is `Ugoldar_Randomization_Arena`'s child list in `MP/Coop_CombatOps_Cain.ent`: its
  // recorded end falls after `Ugoldar_Bases_Randomized`, while `Ugoldar_Patrols_Randomized` and the
  // layers after it are still members of the same list, which is how the World Editor shows them.
  let best = null;
  let end = token.end;
  for (let step = 0; step < 1000; step++) {
    const inner = [];
    const innerGaps = [];
    const res = readScope(buf, header, body + 2, end, tags, inner, innerGaps, depth + 1);
    if (res.failAt !== undefined) break; // nothing beyond this point is part of the list
    best = { inner, innerGaps, end: res.end };
    // If the recorded end fell inside the id of a member, the parse stops on that id and the member's
    // own block is the bytes next; step over it before looking for the next named member.
    let after = res.end;
    const last = inner[inner.length - 1];
    if (last && last.kind === "id" && after + 3 <= buf.length && buf[after] === 0x0e) {
      const blockEnd = after + 1 + buf.readUInt16LE(after + 1);
      if (blockEnd <= buf.length) after = blockEnd;
    }
    if (after > res.end) { end = after; continue; }
    const next = nextNamedMemberEnd(buf, after);
    if (next === -1) break;
    end = next;
  }
  if (!best) return false;

  token.headerBytes = 2;
  token.header = [...buf.subarray(body, body + 2)];
  token.children = best.inner;
  if (best.end !== token.end) { token.widened = best.end - token.end; token.end = best.end; }
  for (const g of best.innerGaps) gaps.push(g);
  return true;
}

/**
 * The end of the `[id] [block]` member that starts at `at`, or -1 when the bytes there are not one.
 * Only a *named* member continues a list: an anonymous block after it could belong to the enclosing
 * scope just as well, so the reader does not guess.
 */
function nextNamedMemberEnd(buf, at) {
  if (at + 3 > buf.length || buf[at] !== 0x43) return -1;
  const idEnd = at + 3 + buf.readUInt16LE(at + 1);
  if (idEnd + 3 > buf.length || buf[idEnd] !== 0x0e) return -1;
  const blockEnd = idEnd + 1 + buf.readUInt16LE(idEnd + 1);
  return blockEnd <= buf.length ? blockEnd : -1;
}

/**
 * Decode a whole resource. Returns:
 *   { file, header, tokens, gaps, tokenCount, bodySize, gapBytes, decodedBytes, exact,
 *     opaqueBlocks, opaqueBytes, lengths }
 *
 * `input` is a path, or the bytes themselves (a `Buffer`/`Uint8Array`, which is what an entry read
 * out of a `.pak` is) — a library user should not have to spill a world to disk to read it. `name`
 * labels a byte input in errors and in `file`; it defaults to `"<buffer>"`.
 *
 * Strict is the default: an undecodable byte throws instead of the scope being abandoned, so a
 * damaged file is named at the byte rather than reported as 99 % decoded. `strict: false` restores
 * the resynchronising pass and its gap list; the CLI exposes it as `--lenient`.
 */
export function readEbin(input, { strict = true, tags = TAGS, name = null } = {}) {
  const fromBytes = Buffer.isBuffer(input) || input instanceof Uint8Array;
  const buf = fromBytes ? Buffer.from(input) : readFileSync(input);
  const file = fromBytes ? name ?? "<buffer>" : input;
  let header;
  try {
    header = readHeader(buf);
  } catch (err) {
    // The container's own errors do not know where they came from; a caller reading a hundred files
    // does. Strict mode already prefixes the path, so the two failure classes read alike.
    throw new Error(`${file}: ${err.message}`);
  }
  const tokens = [];
  const gaps = [];
  if (strict) {
    // No resynchronisation at all: the file must tile exactly or it is an error. Opaque blocks
    // are still reported as such — that is a property of the data, not of this reader.
    const res = readScope(buf, header, header.body, buf.length, tags, tokens, gaps);
    if (res.failAt !== undefined) {
      const byte = res.failAt < buf.length ? ` (byte 0x${buf[res.failAt].toString(16)})` : "";
      throw new Error(`${file}: ${res.error} at offset ${res.failAt}${byte}`);
    }
  } else {
    let p = header.body;
    while (p < buf.length) {
      const res = readScope(buf, header, p, buf.length, tags, tokens, gaps);
      if (res.failAt === undefined) break;
      // The failure can be *inside* a block that was already read whole — a block whose recorded
      // length is short, so the reader widened it past its parent's end. Then the bytes are decoded,
      // the parse is simply standing past that block's parent: continue after the widest such block
      // instead of resynchronising, or the region ends up in the tree twice.
      const covering = widestTokenAt(tokens, res.failAt);
      if (covering !== null) { p = covering; continue; }
      // This scope cannot be decoded from here: skip to the next place a record can start.
      let q = res.failAt + 1;
      while (q < buf.length && resyncAt(buf, header, q, buf.length) === null) q++;
      // Tokens that *straddle* the failure reach into the bytes the resync is about to re-read: keep
      // them and the same region ends up in the tree twice, once truncated and once whole.
      while (tokens.length && tokens[tokens.length - 1].end > res.failAt) tokens.pop();
      gaps.push({ from: res.failAt, to: q, bytes: q - res.failAt, reason: res.error });
      p = q;
    }
  }
  const bodySize = buf.length - header.body;
  const gapBytes = gaps.reduce((s, g) => s + g.bytes, 0);
  const summary = summarize(tokens);
  return {
    file,
    header,
    tokens,
    gaps,
    tokenCount: summary.tokenCount,
    bodySize,
    gapBytes,
    decodedBytes: bodySize - gapBytes,
    exact: gaps.length === 0,
    opaqueBlocks: summary.opaqueBlocks,
    opaqueBytes: gaps.filter((g) => g.opaque).reduce((s, g) => s + g.bytes, 0),
    lengths: summary.lengths,
  };
}

/**
 * Every block whose stored length is *short of its content*, measured rather than assumed.
 *
 * The `0x0e` length is a u16 and it is not a delimiter. Over the 103 shipped worlds:
 *
 *   - a block of more than 64 KiB cannot be expressed at all; twelve are that big, and seven of them
 *     store exactly `trueLength mod 65536` — the field wraps;
 *   - 189 of the 256 short ends fall *inside* a value (a fixed-size payload, which no block can end
 *     in the middle of), and 67 fall on a token boundary whose token cannot continue the enclosing
 *     record list (`coords`, `angles`, `scale`, `Flags`, `Position`, padding before one of those, a
 *     bare value, or a bare block);
 *   - in 248 of them the last child block — the one that reaches past the stored end — has a stored
 *     length that is exactly its own content; the other 8 are enclosing blocks whose last child is
 *     itself short. The child's number is corroborated by its bytes, the parent's is not: the token
 *     stream is the delimiter, and the stored length is a lower bound.
 *
 * That is the whole of the "the reader has to choose" story. It is a measurement, not a rule of
 * thumb, and `node tools/ebin.mjs lengths <file>...` prints it.
 */
function summarize(tokens) {
  let tokenCount = 0;
  let blockCount = 0;
  let opaqueBlocks = 0;
  const short = [];
  const walk = (list) => {
    let enclosingKinds = null;
    for (const t of list) {
      tokenCount++;
      if (t.kind === "block") blockCount++;
      if (t.kind === "block" && t.opaque) opaqueBlocks++;
      if (t.kind === "block" && t.widened) {
        if (enclosingKinds === null) {
          const kinds = new Set();
          for (const c of list) kinds.add(c.kind);
          enclosingKinds = [...kinds].join(",");
        }
        short.push(describeShortLength(t, enclosingKinds));
      }
      if (t.children) walk(t.children);
    }
  };
  walk(tokens);
  const count = (fn) => short.filter(fn).length;
  return {
    tokenCount,
    opaqueBlocks,
    lengths: {
      blocks: blockCount,
      short: short.length,
      midValue: count((s) => s.endsIn === "value"),
      boundary: count((s) => s.endsIn === "boundary"),
      boundaryBeforeName: count((s) => s.endsIn === "boundary" && s.token.startsWith("name:")),
      truncated16: count((s) => s.truncated16),
      forcedByExactChild: count((s) => s.forcedByExactChild),
      blocksWithShortLength: short,
    },
  };
}

/** A token's name for a report: `name:angles`, `id:CP_Kamensk`, or the kind (`vec3`, `empty`). */
function tokenLabel(t) {
  if (t.kind === "name") return `name:${t.value}`;
  if (t.kind === "id") return `id:${t.value}`;
  if (t.kind === "string") return "string";
  return t.kind;
}

/**
 * Where does a block's stored end fall, and is that even a place a token can end? The answer is
 * attached to the block as `lengthShort` and collected into `readEbin().lengths`.
 */
function describeShortLength(token, enclosingKinds) {
  const declaredEnd = token.end - token.widened;
  let containing = null;
  let boundary = null;
  const find = (list) => {
    for (const t of list) {
      if (t.at === declaredEnd) { boundary = t; return; }
      if (t.at < declaredEnd && declaredEnd < t.end) {
        containing = t;
        if (t.children) find(t.children);
        return;
      }
    }
  };
  find(token.children || []);
  const hit = boundary || containing;
  const contentBytes = token.end - token.at - 3;
  const trueLen = contentBytes + 2;
  const last = (token.children || []).filter((c) => c.end === token.end).pop();
  token.lengthShort = {
    by: token.widened,
    declaredEnd,
    endsIn: boundary ? "boundary" : containing ? "value" : "unknown",
    token: hit ? tokenLabel(hit) : null,
    offset: hit ? declaredEnd - hit.at : null,
    truncated16: trueLen > 0xffff && token.len === trueLen % 0x10000,
    // A leaf has no stored length to contradict; a block child is the case that matters, and its
    // own u16 must be exact for the extension to be its doing rather than another inherited one.
    forcedByExactChild: !last || last.kind !== "block" ? true : last.end === last.at + 1 + last.len,
    enclosing: enclosingKinds,
  };
  return token.lengthShort;
}

/**
 * The end of the widest token that covers `p`, or null. Used when a scope fails at an offset that a
 * block already in the tree has read whole: the parse then continues after that block rather than
 * resynchronising inside it.
 */
function widestTokenAt(tokens, p) {
  let best = null;
  const walk = (arr) => {
    for (const t of arr) {
      if (t.at <= p && t.end > p) {
        if (best === null || t.end > best) best = t.end;
        if (t.children) walk(t.children);
      }
    }
  };
  walk(tokens);
  return best;
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

/**
 * Walk the tree in reading order, yielding `{ token, depth }` without copying the token. Lazy on
 * purpose: a terrain world has ~20 million tokens, and materialising a decorated copy of each one
 * costs more memory than the file itself.
 */
export function* walkTokens(tokens, depth = 0) {
  for (const t of tokens) {
    yield { token: t, depth };
    if (t.children) yield* walkTokens(t.children, depth + 1);
  }
}

/** Flatten the tree into reading order as an array. For callers that really want a list. */
export function flatten(tokens) {
  const out = [];
  for (const { token, depth } of walkTokens(tokens)) out.push({ ...token, depth });
  return out;
}

// ---------------------------------------------------------------------------
// records
// ---------------------------------------------------------------------------

/**
 * How deep a nested value is followed before it is left as a size. Real worlds nest five or six
 * levels (`m_aActivationActions` → an action → its `m_Getter` → that getter's fields); past this
 * the value is a size and not a structure, which keeps a cyclic-looking file from running away.
 */
const MAX_VALUE_DEPTH = 6;

/** The two names in the name table that are punctuation: a record separator and the append operator. */
const NAME_COLON = ":";
const NAME_APPEND = "+";

/**
 * A member's value as a plain JS value, keeping `guidRef` provenance, and — the important part for
 * anyone reading the output — the *contents* of a block that parsed.
 *
 * A block used as a value has three shapes, and all three are read rather than dumped as a size:
 *
 *   name { <padding> <one value> }        → unwrap it; that is how every array is written
 *                                           (`m_aIncludedEditableEntityLabels { <array> }`)
 *   name { <ClassName> <GUID> <block> … } → `objects`: an array of objects, which is what
 *                                           `m_aActivationActions`, `m_aPlugins` and every action
 *                                           list in a world are
 *   name { <member> <value> … }           → `fields`: a plain structure (an inline struct)
 *
 * Only a block that did not tile (BSP, navmesh) stays a size, and it says `opaque`.
 */
function fieldOf(t, depth = 0) {
  const base = { name: t.name, kind: t.token.kind, tag: t.token.tag };
  const v = t.token;
  if (v.kind === "block") {
    const size = v.end - v.at - 3;
    // A text payload (`BSP`) has no children at all: it is characters, and its summary is the value.
    if (v.text) return { ...base, value: null, blockBytes: size, opaque: false, text: v.text };
    if (v.headerBytes) return { ...base, value: null, blockBytes: size, opaque: false, headerBytes: v.headerBytes, fields: membersOf(v.children ?? [], depth + 1), listCount: (v.children ?? []).filter((c) => c.kind === "block").length };
    if (v.opaque || !v.children || depth >= MAX_VALUE_DEPTH) {
      return { ...base, value: null, blockBytes: size, opaque: v.opaque === true };
    }
    const inner = v.children.filter((c) => c.kind !== "empty");
    if (inner.length === 0) return { ...base, value: null, blockBytes: size, opaque: false, empty: true };
    if (inner.length === 1) {
      const unwrapped = fieldOf({ name: t.name, token: inner[0] }, depth + 1);
      return { ...unwrapped, wrappedInBlock: size };
    }
    const objects = objectEntries(inner, depth + 1);
    if (objects) return { ...base, value: null, blockBytes: size, opaque: false, objects };
    return { ...base, value: null, blockBytes: size, opaque: false, fields: membersOf(inner, depth + 1) };
  }
  if (v.kind === "guidRef") return { ...base, value: v.value, guid: v.value, index: v.index, component: v.component === true };
  if (v.kind === "guid") return { ...base, value: v.value, guid: v.value, inline: true };
  if (v.kind === "u64") return { ...base, value: v.value, words: v.words, raw: true };
  if (v.kind === "array") {
    return {
      ...base, value: v.values, count: v.count, elemKind: v.elemKind,
      valuesTruncated: v.valuesTruncated === true,
    };
  }
  return { ...base, value: v.value };
}

/**
 * Read `tokens` as a list of `<ClassName> <GUID> <block>` entries, or return null when they are
 * not that shape. Requiring the GUID is what separates an object from a member: a member whose
 * value is a nested object starts `memberName ClassName GUID block`, so its first two names do not
 * match this shape and the caller falls back to members.
 */
function objectEntries(tokens, depth) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const cls = tokens[i];
    if (cls.kind !== "name") return null;
    const guid = tokens[i + 1];
    if (!guid || (guid.kind !== "guidRef" && guid.kind !== "guid")) return null;
    const body = tokens[i + 2];
    if (!body || body.kind !== "block") return null;
    out.push({
      className: cls.value,
      guid: guid.value,
      inline: guid.kind === "guid",
      at: cls.at,
      opaque: body.opaque === true,
      blockBytes: body.end - body.at - 3,
      fields: body.children ? membersOf(body.children, depth) : [],
    });
    i += 3;
  }
  return out.length ? out : null;
}

/**
 * `name value` pairs directly in `tokens` (one scope).
 *
 * Three things are skipped rather than reported as members, because each would otherwise appear as
 * a field with a nonsense name: the record separator `:`, the `components` keyword (its content is
 * a component list, not members), and a value that is itself a name — the class of a nested object
 * (`m_BaseLayout SCR_DebriefingScreenUnevenFourTiles {guid} {…}`), whose GUID and body are folded
 * into that member instead of becoming fields of their own.
 *
 * `name + value` is the append operator: the text form writes `m_aWheels + { 4 5 6 7 }`, meaning
 * "append to the array the prefab already has", and the binary stores the same `+` as a name token
 * between the member name and its value. Such a member is reported with `append: true`.
 */
function membersOf(tokens, depth = 0) {
  const out = [];
  for (let i = 0; i < tokens.length; i++) {
    const t = tokens[i];
    if (t.kind !== "name") continue;
    if (t.value === NAME_COLON || t.value === "components") continue;
    let j = i + 1;
    let append = false;
    if (tokens[j] && tokens[j].kind === "name" && tokens[j].value === NAME_APPEND) { append = true; j++; }
    const v = tokens[j];
    if (!v) continue;
    const field = fieldOf({ name: t.value, token: v }, depth);
    if (append) field.append = true;
    // A nested object: `ClassName` [":"] [GUID] [block]. The GUID is `0x45` (table) or `0x44`
    // (inline) — a nested object in a world uses the inline form, so both are folded in.
    if (v.kind === "name") {
      let k = j + 1;
      if (tokens[k] && tokens[k].kind === "name" && tokens[k].value === NAME_COLON) k++;
      if (tokens[k] && (tokens[k].kind === "guidRef" || tokens[k].kind === "guid")) {
        field.guid = tokens[k].value;
        field.guidInline = tokens[k].kind === "guid";
        k++;
      }
      if (tokens[k] && tokens[k].kind === "block") {
        const body = tokens[k];
        field.blockBytes = body.end - body.at - 3;
        if (body.children && depth < MAX_VALUE_DEPTH) field.fields = membersOf(body.children, depth + 1);
      }
      j = k;
    }
    out.push(field);
    i = j; // the value has been consumed: it must not be read again as a member name
  }
  return out;
}

/**
 * The components declared in a `components { ... }` scope: a list of `<ClassName> <GUID> <block>`,
 * which is exactly the shape `objectEntries` reads — a component and an object in an array differ
 * only in where they sit.
 *
 * Two things the list can also hold, both reported rather than flattened into fields:
 *
 *   - **a group of components**, `$grp <ClassName> [":" <prefab>] <block>` with one component per
 *     member — the same group construct that holds child entities, used one level down. No world in
 *     the measured corpus (103 files, 1.8.0.13) has one, so this is grammar, not observation.
 *   - **sub-components**: a component's block can itself carry a `components { … }` list, one level
 *     per parent, as many levels as the class nests. That is the shape written by Workbench when a
 *     component is built out of components — read out of a project's own text layer
 *     (`worlds/arland_test_Layers/default.layer`, a hand-made `SCR_BaseGameMode`):
 *
 *         SCR_RespawnSystemComponent "{6AA37B0DFEF7C77E}" {
 *          components {
 *           SCR_FreeSpawnHandlerComponent "{6AA37B0DC66AC72F}" { … }
 *          }
 *          m_bEnablePauseMenuRespawn 0
 *         }
 *
 *     57 components in the shipped worlds carry such a list, 140 sub-components in total
 *     (`BaseVehicleNodeComponent` → `ControllersManagerComponent`, `SCR_BaseHUDComponent`,
 *     `SCR_CarControllerComponent`; `DoorComponent` → `LadderComponent`).
 */
function componentsOf(tokens) {
  const out = [];
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t.kind !== "name") { i++; continue; }
    if (t.value === "$grp") {
      const g = groupAt(tokens, i);
      if (g) {
        out.push({
          kind: "group",
          className: g.className,
          prefab: g.prefab,
          at: t.at,
          instances: g.body.opaque ? null : g.members.length,
          components: g.members
            .filter((m) => m.block.children)
            .map((m) => componentEntry(g.className, null, m.block, m.id)),
        });
        i = g.next;
        continue;
      }
      i++;
      continue;
    }
    const guid = tokens[i + 1], body = tokens[i + 2];
    if (guid && (guid.kind === "guidRef" || guid.kind === "guid") && body && body.kind === "block") {
      out.push(componentEntry(t.value, guid, body, null));
      i += 3;
      continue;
    }
    i++;
  }
  return out;
}

/**
 * One component: its class, its GUID, its members, and its own sub-components.
 *
 * A member named `components` whose value is a block is the **sub-component list**, not a field —
 * the same keyword that introduces a component list on an entity. It is reported one level down, and
 * `componentsOf` recurses into it, so a component built out of components any number of levels deep
 * comes back as a tree. Nothing else in a component's block is read as a component: a class-and-GUID
 * *without* that block is a member's object value (`LinkType NavmeshDoorLink {…}`), which is exactly
 * what the text form writes.
 */
function componentEntry(className, guidToken, body, id) {
  const kids = body.children ?? [];
  const rest = [];
  let subComponents = [];
  for (let i = 0; i < kids.length; i++) {
    const t = kids[i];
    if (t.kind === "name" && t.value === "components" && kids[i + 1] && kids[i + 1].kind === "block") {
      subComponents = kids[i + 1].children ? componentsOf(kids[i + 1].children) : [];
      i++; // the list is consumed: it is not a field of this component
      continue;
    }
    rest.push(t);
  }
  return {
    className,
    guid: guidToken ? guidToken.value : null,
    inline: guidToken ? guidToken.kind === "guid" : false,
    id,
    at: body.at,
    opaque: body.opaque === true,
    blockBytes: body.end - body.at - 3,
    fields: membersOf(rest),
    subComponents,
  };
}

/**
 * True when `tokens[i]` begins a new entry in the list it sits in, rather than being the value of the
 * member in front of it. An entry follows padding (`empty`) or the previous entry's block; a member
 * follows a value. That distinction is what separates `Data <block>` — a member of a `ShapePoint`
 * whose value is a struct, 285 of them in `Eden.ent` — from `RoadEntity <block>`, a road child of a
 * road generator, 434 of them in `Arland.ent`: both are a name followed by a block, and only the
 * token in front says which is which.
 */
function atEntryBoundary(tokens, i) {
  const prev = tokens[i - 1];
  return prev === undefined || prev.kind === "empty" || prev.kind === "block";
}

/**
 * The entity starting at `tokens[i]`, or null. Three forms, all anchored on something only an entity
 * has, and all reported with `next` = the index just past its body:
 *
 *   <class> [id] ":" <guidRef> <block>   — a prefab instance; the `:`+GUID+block triple is present
 *                                          in all 20 252 constructs measured. The id is optional:
 *                                          an entity that keeps its prefab's name stores none, and
 *                                          that is the majority of a world's children.
 *   <class> [id] <block>                 — an entity that stores no prefab at all: the world entity
 *                                          and the sun carry an id (tag 0x43 is reserved for it), a
 *                                          road child of a road generator carries neither
 *                                          (`RoadEntity { … }`, 434 of them in `Arland.ent`).
 *
 * Refused when the name is a *member* rather than a class: when the token in front of it is a value
 * (`Data <block>`, `LinkType NavmeshDoorLink <GUID> {…}`) it is that member's value, and when a name
 * stands in front of it (`Data SplinePointData "SplinePointData" {…}`) it is a nested object's
 * class. Reading those as entities invented 27 records in `Eden.ent` whose id equalled their class.
 * `SubScene` is refused by name: it is the layer node a world layers over its base scene, not an
 * entity, and the World Editor does not count it as one.
 */
function entityAt(tokens, i) {
  const cls = tokens[i];
  if (!cls || cls.kind !== "name") return null;
  if (!/^[A-Z]/.test(String(cls.value))) return null;
  if (cls.value === "SubScene") return null;
  const prev = tokens[i - 1];
  if (prev && prev.kind === "name") return null;
  let j = i + 1;
  let id = null;
  if (tokens[j] && tokens[j].kind === "id") { id = tokens[j].value; j++; }
  if (tokens[j] && tokens[j].kind === "name" && tokens[j].value === ":" &&
      tokens[j + 1] && tokens[j + 1].kind === "guidRef" &&
      tokens[j + 2] && tokens[j + 2].kind === "block") {
    return {
      cls: cls.value, id, guid: tokens[j + 1].value, index: tokens[j + 1].index,
      body: tokens[j + 2], at: cls.at, next: j + 3,
    };
  }
  if (!tokens[j] || tokens[j].kind !== "block") return null;
  // no prefab: an id makes the entry unambiguous, without one the position in the list has to
  if (id === null && !atEntryBoundary(tokens, i)) return null;
  return { cls: cls.value, id, guid: null, index: null, body: tokens[j], at: cls.at, next: j + 1 };
}

/**
 * The group starting at `tokens[i]` (`$grp`), or null:
 * `$grp <class> [":" <prefab>] <block>`, one member per block in the body.
 *
 * **The member list is not always inside that block.** A group whose members do not fit the
 * writer's block length continues *outside* it: when the body's span stops short, the remaining
 * members follow as sibling blocks at the parent's own level, with no second `$grp` header. That is
 * the measured cause of the "parent length short of its last child" quirk, and it is why a group's
 * members are read as *the body's blocks plus every block that follows it* — 253 such groups in the
 * corpus, and in `Arland.ent` the difference between 63 644 instances and the 173 226 nodes the
 * World Editor reports for the same file. A block that is not a member cannot start here: a child
 * list entry begins with a class name, and a member does not.
 *
 * A member is a block; an `id` in the group's content belongs to the member block that follows it,
 * which is how `$grp GenericEntity : <prefab>` keeps `CP_Kamensk` attached to the first of its
 * instances (the others carry no id at all).
 */
/**
 * A body that is a **member list** rather than an entity: only padding, `id`s and blocks, and none of
 * those blocks is itself a child list. That is the difference between a group's body (members, each a
 * scene node) and an entity's body (members, components, a child list) — and it is what tells a group
 * header apart from an entity that keeps its prefab's name.
 */
function looksLikeMemberList(block) {
  const kids = block.children;
  if (!kids || !kids.length) return false;
  let blocks = 0, ids = 0;
  for (const c of kids) {
    if (c.kind === "empty") continue;
    if (c.kind === "id") { ids++; continue; }
    if (c.kind !== "block" || !c.children) return false;
    if (looksLikeChildList(c)) return false; // a child list belongs to an entity, not to a group
    blocks++;
  }
  return blocks >= 2 || (blocks === 1 && ids === 1);
}

/**
 * A group header written **without `$grp`**: `<class> [":" <prefab>} <block>` whose block is a member
 * list. Workbench writes a `$grp` for a group, but the engine also emits the same list with the class
 * and prefab stated once and no `$grp` at all — `GenericEntity : "{…}Layer.et" { id "Ugoldar_…" {…} … }`
 * inside `Ugoldar_Randomization_Arena` in `MP/Coop_CombatOps_Cain.ent`, where the World Editor shows
 * those members as the arena's own children and no entity in between.
 */
function bareGroupAt(tokens, i) {
  const cls = tokens[i];
  if (!cls || cls.kind !== "name" || !/^[A-Z]/.test(String(cls.value))) return null;
  const prev = tokens[i - 1];
  if (prev && prev.kind === "name") return null;
  let j = i + 1;
  if (tokens[j] && tokens[j].kind === "id") return null; // an id makes it an entity, not a header
  let prefab = null;
  if (tokens[j] && tokens[j].kind === "name" && tokens[j].value === ":" &&
      tokens[j + 1] && tokens[j + 1].kind === "guidRef") {
    prefab = { guid: tokens[j + 1].value, index: tokens[j + 1].index };
    j += 2;
  }
  const body = tokens[j];
  if (!body || body.kind !== "block" || !looksLikeMemberList(body)) return null;
  return groupFromHeader(tokens, i, cls.value, prefab, body, j);
}

function groupAt(tokens, i) {
  let j = i + 1;
  const cls = tokens[j];
  const className = cls && cls.kind === "name" && cls.value !== ":" ? cls.value : null;
  if (className !== null) j++;
  let prefab = null;
  if (tokens[j] && tokens[j].kind === "name" && tokens[j].value === ":" &&
      tokens[j + 1] && tokens[j + 1].kind === "guidRef") {
    prefab = { guid: tokens[j + 1].value, index: tokens[j + 1].index };
    j += 2;
  }
  const body = tokens[j];
  if (!body || body.kind !== "block") return null;
  return groupFromHeader(tokens, i, className, prefab, body, j);
}

function groupFromHeader(tokens, at, className, prefab, body, j) {
  const members = [];
  let pendingId = null;
  for (const c of body.opaque || !body.children ? [] : body.children) {
    if (c.kind === "id") { pendingId = c.value; continue; }
    if (c.kind !== "block") continue;
    members.push({ block: c, id: pendingId });
    pendingId = null;
  }
  // The continuation carries `id` tokens too: a member that keeps a name stores it in front of its
  // block, body or not (`BARSMilitaryBase`, `Airfield_Tasks`, … in `MP/Coop_CombatOps_Cain.ent`).
  let k = j + 1;
  let pendingOverflowId = null;
  while (k < tokens.length) {
    const c = tokens[k];
    if (c.kind === "id") { pendingOverflowId = c.value; k++; continue; }
    if (c.kind !== "block" || !c.children) break;
    members.push({ block: c, id: pendingOverflowId });
    pendingOverflowId = null;
    k++;
  }
  return { className, prefab, body, members, next: k, at };
}

/**
 * A block that holds a child list: `$grp …` or `<class> [id] [":" <prefab>] <block>` entries.
 *
 * The last form, with no prefab and no id, only counts at an entry boundary — `RoadEntity { … }` as a
 * child, but not `Data { … }` as a member's struct. See `atEntryBoundary`.
 */
function looksLikeChildList(block) {
  const kids = block.children ?? [];
  for (let i = 0; i < kids.length; i++) {
    const k = kids[i];
    if (k.kind !== "name") continue;
    if (k.value === "$grp") return true;
    const prev = kids[i - 1];
    if (prev && prev.kind === "name") continue; // a name in the value position is not a class
    if (!/^[A-Z]/.test(String(k.value))) continue;
    let j = i + 1;
    if (kids[j] && kids[j].kind === "id") j++;
    if (kids[j] && kids[j].kind === "name" && kids[j].value === ":") return true;
    if (kids[j] && kids[j].kind === "block" && atEntryBoundary(kids, i)) return true;
  }
  return false;
}

/**
 * The child-list blocks in `body`: the children an entity (or a group member) carries with it.
 *
 * A block that is the *value of a member* is not one of them — `components {…}`, `Materials {…}` and
 * every other named block is skipped by looking at the token in front, which is what keeps a
 * component list from being read as a list of child entities.
 */
function childListsIn(body) {
  const out = [];
  const kids = body?.children;
  if (!kids) return out;
  for (let i = 0; i < kids.length; i++) {
    const c = kids[i];
    if (c.kind !== "block" || c.opaque || !c.children) continue;
    const prev = kids[i - 1];
    if (prev && prev.kind === "name") continue;
    if (looksLikeChildList(c)) out.push(c);
  }
  return out;
}

/**
 * Pull the records out of a decoded resource as a **tree**, in document order: entities and the
 * groups that hold their children, the components of each, and the depth at which each sits.
 *
 * The document *is* a tree, not a flat list. Every scope the writer emits is a **child list**: the
 * world's own children at the top, then a child list inside the body of any entity that carries
 * children, then one inside the body of any of *its* children — so nesting is as deep as the scene
 * is. A group is not a scene node of its own: it belongs to the child list it sits in, and its
 * parent is the entity that owns that list (or the world, at the top). Each node reports `parent`,
 * the index of the enclosing node in this same array, and `depth`, its distance from the root.
 *
 * `prefab` is a GUID; add a path with `--rdb` (see the CLI) — the file itself only stores the
 * GUID, and only the resource database can name the prefab. A child that keeps its prefab's name
 * stores no `id`, so `id` is null for most of a world's entities: the name it is displayed under
 * belongs to the prefab, not to the world.
 *
 * `instances` bounds how many members of a group are expanded into instance nodes. A terrain world
 * keeps thousands of vegetation instances in groups — 8 915 of one pine in `Arland.ent` — and
 * materialising them all is neither useful nor affordable; a group is always reported, with
 * `instances` (its member count) and `expanded` saying whether the members are in the list.
 * `instances: 0` never expands. The members are still searched for children either way.
 */
export function entities(ebin, { instances = 2000 } = {}) {
  const out = [];
  walkList(ebin.tokens, 0, out, { instances }, null);
  return out;
}

/** One child list: `tokens` holds siblings of one parent, each `depth` from the root. */
function walkList(tokens, depth, out, opts, parent) {
  // Entities of the same class and prefab are written consecutively, and only the first carries
  // them: `GenericEntity "A" : {prefab} { … }` then `id "B" { … }`, `id "C" { … }`. That is the same
  // compaction a group performs, so a bare `[id] [block]` entry inherits what the run it sits in
  // started with — a full record, or a group header (`MP/Coop_CombatOps_Cain.ent` has 205 of them
  // after a record, `Arland.ent` 39 ids in a whole world).
  let run = null;
  let i = 0;
  while (i < tokens.length) {
    const t = tokens[i];

    if (t.kind === "name" && (t.value === "$grp" || bareGroupAt(tokens, i))) {
      const g = t.value === "$grp" ? groupAt(tokens, i) : bareGroupAt(tokens, i);
      if (!g) { i++; continue; }
      run = { className: g.className, prefab: g.prefab };
      const expand = opts.instances > 0 && g.members.length <= opts.instances;
      out.push({
        kind: "group",
        className: g.className,
        id: null,
        at: t.at,
        depth,
        parent,
        prefab: g.prefab,
        fields: g.body.children ? membersOf(g.body.children) : [],
        components: [],
        instances: g.body.opaque ? null : g.members.length,
        expanded: false,
        position: null,
        angle: null,
        scale: 1,
        opaque: g.body.opaque === true,
      });
      const groupIndex = out.length - 1;
      for (const m of g.members) {
        if (!m.block.children) continue;
        const own = membersOf(m.block.children);
        const transform = transformOf(own);
        let memberIndex = groupIndex;
        if (expand) {
          const compIdx = m.block.children.findIndex((c) => c.kind === "name" && c.value === "components");
          const compBody = compIdx >= 0 ? m.block.children[compIdx + 1] : null;
          out.push({
            kind: "instance",
            className: g.className,
            id: m.id,
            at: m.block.at,
            depth: depth + 1,
            parent: groupIndex,
            prefab: g.prefab,
            fields: own,
            components: compBody && compBody.kind === "block" && compBody.children ? componentsOf(compBody.children) : [],
            ...transform,
            opaque: false,
          });
          memberIndex = out.length - 1;
        }
        // a member's own children sit in its block: either as a child-list block of its own, or as
        // `$grp`/entries directly in the body, so the body's scope is walked as a child list
        if (m.block.children) walkList(m.block.children, expand ? depth + 2 : depth + 1, out, opts, memberIndex);
      }
      out[groupIndex].expanded = expand && g.members.length > 0;
      if (!expand && g.members.length) out[groupIndex].position = firstMemberPosition(g.members.map((m) => m.block));
      i = g.next; // the header and every member block are consumed
      continue;
    }

    const rec = entityAt(tokens, i);
    if (rec) {
      run = { className: rec.cls, prefab: rec.guid ? { guid: rec.guid, index: rec.index } : null };
      const selfIndex = emitEntity(out, {
        className: rec.cls, id: rec.id, at: rec.at, depth, parent,
        prefab: run.prefab, body: rec.body, kind: "entity",
      }, tokens);
      if (rec.body.children) walkList(rec.body.children, depth + 1, out, opts, selfIndex);
      i = rec.next;
      continue;
    }

    // a compact entry: `[id] [block]`, inheriting the class and prefab of the run it sits in
    if (t.kind === "id" && tokens[i + 1] && tokens[i + 1].kind === "block" && tokens[i + 1].children) {
      const body = tokens[i + 1];
      const selfIndex = emitEntity(out, {
        className: run?.className ?? null, id: t.value, at: t.at, depth, parent,
        prefab: run?.prefab ?? null, body, kind: "entity",
      }, tokens);
      walkList(body.children, depth + 1, out, opts, selfIndex);
      i += 2;
      continue;
    }

    // An unnamed block: a child list of the same parent when it holds entries, otherwise a
    // structure this reader does not model as nodes (padding, a trailing payload).
    if (t.kind === "block" && t.children) {
      const prev = tokens[i - 1];
      if (!(prev && prev.kind === "name") && looksLikeChildList(t)) walkList(t.children, depth, out, opts, parent);
    }
    i++;
  }
}

/** Emit one entity node from its body and return its index in `out`. */
function emitEntity(out, { className, id, at, depth, parent, prefab, body, kind }, tokens) {
  const children = body.children ?? [];
  const compIdx = children.findIndex((c) => c.kind === "name" && c.value === "components");
  const compBody = compIdx >= 0 ? children[compIdx + 1] : null;
  // The entity's own members: the `name value` pairs directly in its block. A child list and every
  // component's members sit inside their own blocks, so they cannot leak here — which is what keeps
  // `membersOf` safe without per-token bookkeeping (the leading run of `empty` padding is not a
  // name, so it never desynchronises the pairs).
  const fields = membersOf(children);
  out.push({
    kind,
    className,
    id,
    at,
    depth,
    parent,
    prefab,
    fields,
    components: compBody && compBody.kind === "block" && compBody.children ? componentsOf(compBody.children) : [],
    ...transformOf(fields),
    opaque: body.opaque === true,
  });
  return out.length - 1;
}

/**
 * The **transform** an entity or a member stores: `coords`, `angles` and `scale`.
 *
 * All three are ordinary members of the block, but they are the entity's placement rather than its
 * properties, so they are reported as `position`, `angle` and `scale` as well as kept in `fields`.
 * A member that stores nothing has a null position and angle and a scale of 1 — the defaults — and
 * that is the usual case: a world writes a transform only when it differs from the prefab's, which
 * is why most entities in a world carry `coords` and nothing else, and why the 2.6 million `scale`
 * members in the corpus are all vegetation variants rather than a property of every entity.
 */
function transformOf(fields) {
  const coords = fields.find((f) => f.name === "coords" && Array.isArray(f.value));
  const angles = fields.find((f) => f.name === "angles" && Array.isArray(f.value));
  const scale = fields.find((f) => f.name === "scale" && typeof f.value === "number");
  return {
    position: coords ? coords.value : null,
    angle: angles ? angles.value : null,
    scale: scale ? scale.value : 1,
  };
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
  node tools/ebin.mjs names     <file> [--json]
  node tools/ebin.mjs guids     <file> [--rdb <resourceDatabase.rdb>] [--json]
  node tools/ebin.mjs resources <file> ... --rdb <resourceDatabase.rdb> [--json]
  node tools/ebin.mjs worlds    <file> ... --rdb <resourceDatabase.rdb> [--json]
  node tools/ebin.mjs tokens    <file> [--from N] [--limit N|0] [--json]
  node tools/ebin.mjs entities  <file> [--filter RE] [--limit N|0] [--rdb <rdb>]
                                [--instances N|0] [--json]
  node tools/ebin.mjs find      <file> <needle> [--json]
  node tools/ebin.mjs lengths   <file> ... [--json]
  node tools/ebin.mjs verify    <file> ... [--json]

A world file stores overrides, not entities: each record names the prefab it was made from and
the properties it changes. --rdb turns those GUIDs into prefab paths, which is what makes the
output readable — the file itself carries only the GUID.

Options
  --lenient       resynchronise after an undecodable byte and report a gap (default: refuse)
  --strict        accepted for compatibility; strict is the default
  --from N        first token index to print (tokens)
  --limit N       maximum tokens/entities to print (default 200; 0 = every one)
  --all           same as --limit 0
  --filter RE     entities whose class, id, prefab, a member or a component matches RE
  --rdb <file>    resolve GUIDs through resourceDatabase.rdb: prefab and resource references
                  (entities), the resource names in the table (resources), the base scene
  --instances N   expand a group's members only when it has at most N (default 2000; 0 = never)
  --json          machine-readable output; entities, tokens, resources and worlds are
                  wrapped in an envelope carrying the file and any truncation
`;

/** A bad command line: reported with the usage, and the exit status is 1. */
function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

function parseArgs(argv) {
  const flags = { _: [] };
  const valueOf = (option, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw usageError(`${option} needs a value`);
    return v;
  };
  const countOf = (option, raw) => {
    if (!/^\d+$/.test(raw)) throw usageError(`${option} needs a non-negative whole number, not "${raw}"`);
    const n = Number(raw);
    if (!Number.isSafeInteger(n)) throw usageError(`${option} is too large: ${raw}`);
    return n;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--strict") flags.strict = true;
    else if (a === "--lenient") flags.lenient = true;
    else if (a === "--json") flags.json = true;
    else if (a === "--all") flags.all = true;
    else if (a === "--from" || a === "--limit" || a === "--instances") {
      const raw = valueOf(a, i);
      i++;
      flags[a.slice(2)] = countOf(a, raw);
    } else if (a === "--filter" || a === "--rdb") {
      flags[a.slice(2)] = valueOf(a, i);
      i++;
    } else if (a === "-h" || a === "--help") flags.help = true;
    // An option this tool does not know is a mistake that would otherwise change the answer
    // silently: `--filte X` reads as no filter at all, and the caller is shown every record.
    else if (a.startsWith("-") && a !== "-") throw usageError(`unknown option "${a}"`);
    else flags._.push(a);
  }
  return flags;
}

const num = (v) => (Number.isInteger(v) ? String(v) : Number.isFinite(v) ? String(Math.round(v * 1000) / 1000) : String(v));
const vec = (v) => v.map(num).join(", ");
const vecParen = (v) => `(${v.map(num).join(", ")})`;

/** One array element, by the element type the array's tag fixed. */
function fmtElem(f, v, rdb) {
  if (f.elemKind === "vec2" || f.elemKind === "vec3" || f.elemKind === "vec4") return Array.isArray(v) ? vecParen(v) : String(v);
  if (f.elemKind === "string" || f.elemKind === "id") return JSON.stringify(v);
  if (f.elemKind === "guidRef" || f.elemKind === "guid") {
    if (!v) return "{}";
    const path = rdb?.get(v);
    return `{${v}}${path ? ` ${path}` : ""}`;
  }
  if (f.elemKind === "u64") return `0x${v}`;
  if (typeof v === "number") return num(v);
  return String(v);
}

/** How deep a value is printed before it is summarised as a size, and how many objects are listed. */
const MAX_PRINT_DEPTH = 3;
const MAX_PRINT_OBJECTS = 8;

/** Print `name value` members, recursing into nested structures up to MAX_PRINT_DEPTH. */
function printFields(fields, indent, rdb, depth = 0) {
  for (const f of fields) {
    // `coords`, `angles` and `scale` are the transform: printed on one line by the caller.
    if (f.name === "coords" || f.name === "angles" || f.name === "scale") continue;
    const head = `${indent}${f.name} ${f.append ? "+=" : "="}`;
    if ((f.objects || f.fields) && depth >= MAX_PRINT_DEPTH) {
      console.log(`${head} <block, ${f.blockBytes} bytes, not expanded>`);
      continue;
    }
    if (f.objects) {
      console.log(head);
      for (const o of f.objects.slice(0, MAX_PRINT_OBJECTS)) {
        console.log(`${indent}  ${o.className} {${o.guid}}${o.opaque ? "  (opaque)" : ""}`);
        printFields(o.fields, `${indent}    `, rdb, depth + 1);
      }
      if (f.objects.length > MAX_PRINT_OBJECTS) console.log(`${indent}  … ${f.objects.length - MAX_PRINT_OBJECTS} more`);
      continue;
    }
    if (f.fields) {
      // A nested object carries its class name and GUID; a bare struct has neither.
      if (f.kind === "name") {
        const guid = f.guid ? ` {${f.guid}}` : "";
        console.log(`${head} ${f.value}${guid}`);
      } else if (f.headerBytes) {
        // A list behind bytes that are not understood: say so once, then read the members.
        console.log(`${head} <${f.listCount} entries behind ${f.headerBytes} unknown bytes>`);
      } else {
        console.log(`${head} {`);
      }
      printFields(f.fields, `${indent}  `, rdb, depth + 1);
      if (f.kind !== "name" && !f.headerBytes) console.log(`${indent}}`);
      continue;
    }
    console.log(`${head} ${fmtValue(f, rdb)}`);
  }
}

/** Does a member — or anything nested inside it — match the filter? */
function fieldMatches(f, re, rdb) {
  if (re.test(f.name) || (f.path && re.test(f.path)) || (typeof f.value === "string" && re.test(f.value))) return true;
  if (f.fields && f.fields.some((x) => fieldMatches(x, re, rdb))) return true;
  if (f.objects && f.objects.some((o) => re.test(o.className) || o.fields.some((x) => fieldMatches(x, re, rdb)))) return true;
  return false;
}

function fmtValue(f, rdb) {
  if (f.kind === "vec2" || f.kind === "vec3" || f.kind === "vec4") return vec(f.value);
  if (f.kind === "guidRef" || f.kind === "guid") {
    const path = rdb?.get(f.value);
    return `{${f.value}}${path ? ` ${path}` : ""}`;
  }
  if (f.kind === "string" || f.kind === "id") return JSON.stringify(f.value);
  if (f.kind === "block") {
    if (f.empty) return "{}";
    if (f.text) {
      const t = f.text;
      if (t.kind !== "ints") return `<text: ${t.chars} characters>`;
      const records = t.records !== undefined ? `, ${t.records} records of 4` : "";
      return `<text: ${t.ints} integers${records}>`;
    }
    return `<block, ${f.blockBytes} bytes${f.opaque ? ", opaque" : ""}>`;
  }
  if (f.kind === "array") {
    const shown = (f.value ?? []).map((v) => fmtElem(f, v));
    const more = f.count - shown.length;
    const body = shown.join(", ") + (more > 0 ? `${shown.length ? ", " : ""}… ${more} more` : "");
    return `[${body}]`;
  }
  if (f.kind === "u8") return f.value === 1 ? "true" : f.value === 0 ? "false" : String(f.value);
  if (f.kind === "f32") return num(f.value);
  if (f.kind === "u64") {
    // Two 32-bit words, in the order the text form of the same object prints them:
    // `Flags 0x100003 0`, `Rendering 0x1d 0x20`. That is the whole point — a reader can compare
    // what the world stores against the prefab they can read.
    if (!f.words) return "0x" + f.value;
    const words = `0x${f.words[0].toString(16)} 0x${f.words[1].toString(16)}`;
    if (f.name !== "Flags") return words;
    const parts = [...flagNames(f.words[0]), ...clearedFlagNames(f.words[1])];
    return parts.length ? `${words}   (${parts.join(", ")})` : words;
  }
  if (f.kind === "empty") return "";
  if (f.kind === "name") {
    // A nested object: its class name, plus the GUID and the size of its body when they are there.
    const guid = f.guid ? ` {${f.guid}}` : "";
    const body = f.blockBytes !== undefined ? ` <block, ${f.blockBytes} bytes>` : "";
    return `${f.value}${guid}${body}`;
  }
  return String(f.value);
}

/**
 * The measured bits of the entity's `Flags` pair, in the **first** word.
 *
 * Not read off a script: the generated `scripts/Core/generated/Entities/EntityFlags.c` lists the same
 * names in an order that does not match the stored numbering (it puts `STATIC` at bit 7, the file
 * writes `0x400`). These nine were measured one box at a time in the World Editor's General section,
 * one save per observation, on a hand-made entity in a project layer — every one of them sets exactly
 * one bit of the first word and nothing else:
 *
 *     Static 0x400   Feature 0x40   No Link 0x20   Streamable 0x100   On Filtered Navmesh 0x10000
 *     Relative Y 0x80000   Editor Only 0x100000   Disabled 0x200000   Proxy 0x400000
 */
const MEASURED_FLAGS = [
  [0x20, "NoLink"], [0x40, "Feature"], [0x100, "Streamable"], [0x400, "Static"],
  [0x10000, "OnFilteredNavmesh"], [0x80000, "RelativeY"], [0x100000, "EditorOnly"],
  [0x200000, "Disabled"], [0x400000, "Proxy"],
];

/**
 * The two boxes that are *cleared* rather than set, in the **second** word: a bit is 1 when the panel's
 * box is unticked, which is the opposite of the first word.
 *
 * Measured on the same entity, all four states: both boxes ticked is `0x4`, both cleared `0x7`,
 * `Traceable` alone `0x5`, `Visible` alone `0x6` — and a save made to test the prediction (untick
 * `Visible` only) came back `0x5`, which is what `Visible = 0x1` predicts. The `0x4` is constant in
 * every state and no box of the panel controls it, so it is left as hex.
 */
const MEASURED_CLEARED_FLAGS = [[0x1, "Visible"], [0x2, "Traceable"]];

/** The measured flag names set in the first word, plus whatever is left over as hex. */
function flagNames(word) {
  const out = [];
  let rest = word;
  for (const [bit, name] of MEASURED_FLAGS) {
    if (word & bit) { out.push(name); rest &= ~bit; }
  }
  if (rest) out.push(`+0x${rest.toString(16)}`);
  return out;
}

/** The measured boxes that the second word says are *off*, plus whatever is left over as hex. */
function clearedFlagNames(word) {
  const out = [];
  let rest = word;
  for (const [bit, name] of MEASURED_CLEARED_FLAGS) {
    if (word & bit) { out.push(`${name} off`); rest &= ~bit; }
  }
  if (rest) out.push(`second +0x${rest.toString(16)}`);
  return out;
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
    lengths: ebin.lengths,
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
  const L = ebin.lengths;
  if (!L.short) {
    console.log(`  short lengths  none — every one of ${L.blocks} block(s) ends where its stored u16 says`);
  } else {
    console.log(`  short lengths  ${L.short} of ${L.blocks} block(s): ${L.midValue} end inside a value, ` +
      `${L.boundary} at a token boundary` +
      (L.boundary ? ` (${L.boundaryBeforeName} before a field name)` : "") +
      `; ${L.truncated16} are a u16 wrap of a >64 KiB block` +
      `; ${L.forcedByExactChild} have a child whose own length is exact`);
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
  if (flags.limit === undefined) return fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

function cmdTokens(ebin, flags) {
  const from = flags.from ?? 0;
  const limit = rowLimit(flags);
  // Walked lazily, never flattened: a terrain world is ~20 million tokens and a decorated copy of
  // each one costs more than the file.
  const slice = [];
  let total = 0;
  for (const item of walkTokens(ebin.tokens)) {
    if (total >= from && slice.length < limit) slice.push(item);
    total++;
  }
  const describe = (t) => {
    let show = t.value;
    if (t.kind === "block") {
      show = `<${t.end - t.at - 3} bytes${t.opaque ? ", opaque" : ""}${t.headerBytes ? `, ${t.headerBytes}-byte header` : ""}${t.text ? `, text: ${t.text.kind === "ints" ? `${t.text.ints} integers` : `${t.text.chars} chars`}` : ""}>`;
    } else if (t.kind === "guidRef") show = `{${t.value}}${t.component ? " (component)" : ""}`;
    else if (t.kind === "guid") show = `{${t.value}} (inline)`;
    else if (t.kind === "vec2" || t.kind === "vec3" || t.kind === "vec4") show = `(${vec(t.value)})`;
    else if (t.kind === "string" || t.kind === "id") show = JSON.stringify(t.value);
    else if (t.kind === "array") show = `[${t.count} x ${t.elemKind}]`;
    else if (t.kind === "u64") show = `0x${(t.words?.[0] ?? 0).toString(16)} 0x${(t.words?.[1] ?? 0).toString(16)}`;
    else if (t.kind === "empty") show = "";
    return show;
  };
  if (flags.json) {
    // An envelope, not a bare array: `--json` defaults to 200 rows, and a caller that cannot see
    // `total` has no way to tell a complete resource from a truncated one.
    console.log(JSON.stringify({
      file: ebin.file,
      total,
      from,
      returned: slice.length,
      truncated: slice.length < total - from,
      tokens: slice.map(({ token: t, depth }) => ({
        at: t.at, depth, kind: t.kind,
        name: t.kind === "name" ? t.value : undefined,
        value: describe(t),
        opaque: t.opaque === true ? true : undefined,
        headerBytes: t.headerBytes,
        text: t.text,
      })),
    }, null, 2));
    return;
  }
  for (const { token: t, depth } of slice) {
    console.log(`${String(t.at).padStart(9)}  ${"  ".repeat(depth)}${t.kind === "name" ? "" : `${t.kind} `}${describe(t)}`);
  }
  if (slice.length < total - from) console.log(`... ${total - from - slice.length} more token(s)`);
}

/** Annotate a record's GUIDs with the resource paths the rdb knows. */
/**
 * Add the resolved path of every GUID a member carries, nested members included.
 *
 * Only tag `0x05` is annotated: that is the resource reference. `0x45` and `0x44` are component and
 * object instance GUIDs, which name nothing in the resource database by design, so a `path` on one
 * of them would be null noise rather than information.
 */
function annotateFields(fields, rdb) {
  return fields.map((f) => {
    let g = f.tag === 0x05 && f.guid ? { ...f, path: rdb.get(f.guid) ?? null } : f;
    if (g.fields) g = { ...g, fields: annotateFields(g.fields, rdb) };
    if (g.objects) g = { ...g, objects: g.objects.map((o) => ({ ...o, fields: annotateFields(o.fields, rdb) })) };
    return g;
  });
}

function annotate(e, rdb) {
  if (!rdb) return e;
  const prefabPath = e.prefab ? rdb.get(e.prefab.guid) ?? null : null;
  return {
    ...e,
    prefab: e.prefab ? { ...e.prefab, path: prefabPath } : null,
    fields: annotateFields(e.fields, rdb),
    components: e.components.map((c) => ({ ...c, fields: annotateFields(c.fields, rdb) })),
  };
}

function cmdEntities(ebin, flags) {
  const re = flags.filter ? new RegExp(flags.filter, "i") : null;
  const limit = rowLimit(flags);
  const rdb = flags.rdb ? readRdb(flags.rdb) : null;
  const instances = flags.instances === undefined ? 2000 : flags.instances;
  let list = entities(ebin, { instances }).map((e) => annotate(e, rdb));
  if (re) {
    // Match whatever a reader would search by: class, id, prefab path or GUID, a member's name,
    // string value or resolved resource, anything nested inside a member, and the same for every
    // component. The string value matters because it is where a placed base carries its name
    // (`m_sBaseName "#AR-Campaign_MapLocation_Cain_Kamensk"`), the usual thing to search for.
    list = list.filter((e) => re.test(e.className ?? "") || (e.id && re.test(e.id))
      || (e.prefab && (re.test(e.prefab.guid) || (e.prefab.path && re.test(e.prefab.path))))
      || e.fields.some((f) => fieldMatches(f, re, rdb))
      || e.components.some((c) => re.test(c.className) || c.fields.some((f) => fieldMatches(f, re, rdb))));
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
  const deepest = list.reduce((m, e) => Math.max(m, e.depth), 0);
  console.log(`${ebin.file}: ${list.length} node${list.length === 1 ? "" : "s"}` +
    ` (${entities2} entit${entities2 === 1 ? "y" : "ies"}, ${groups} group${groups === 1 ? "" : "s"}` +
    `${inst ? `, ${inst} expanded instance${inst === 1 ? "" : "s"}` : ""}` +
    `${deepest ? `, ${deepest + 1} levels deep` : ""})` +
    `${re ? ` matching /${flags.filter}/i` : ""}`);
  if (!rdb) console.log("  (no --rdb: a prefab is only stored as a GUID. Add\n" +
    "   --rdb \"<install>/addons/data/resourceDatabase.rdb\" to print its path.)");
  const printComponents = (components, indent) => {
    for (const c of components) {
      if (c.kind === "group") {
        const n = c.instances === null ? "opaque content" : `${c.instances} component${c.instances === 1 ? "" : "s"}`;
        const prefab = c.prefab ? ` : {${c.prefab.guid}}${c.prefab.path ? ` ${c.prefab.path}` : ""}` : "";
        console.log(`${indent}$grp ${c.className ?? "?"}${prefab}  ${n}`);
        printComponents(c.components, `${indent}  `);
        continue;
      }
      console.log(`${indent}component ${c.className}${c.guid ? ` {${c.guid}}` : ""}${c.id ? ` "${c.id}"` : ""}${c.opaque ? "  (opaque)" : ""}`);
      printFields(c.fields, `${indent}    `, rdb);
      if (c.subComponents.length) printComponents(c.subComponents, `${indent}  `);
    }
  };
  const printMembers = (e, indent) => {
    // the transform, as the World Editor's Transformation panel shows it: coords, angles, scale
    const transform = [];
    if (e.position) transform.push(`position ${vec(e.position)}`);
    if (e.angle) transform.push(`angle ${vec(e.angle)}`);
    if (e.scale !== undefined && e.scale !== 1) transform.push(`scale ${num(e.scale)}`);
    if (transform.length) console.log(`${indent}  ${transform.join("   ")}`);
    printFields(e.fields, `${indent}  `, rdb);
    printComponents(e.components, `${indent}  `);
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
  if (rows.length < list.length) console.log(`... ${list.length - rows.length} more node(s) (--limit 0 for all)`);
  if (ebin.gapBytes) {
    console.log(`\n${(100 * ebin.decodedBytes / ebin.bodySize).toFixed(1)}% of the value stream decoded` +
      `; ${ebin.opaqueBlocks} opaque block(s), ${ebin.gapBytes} byte(s) not understood (see \`info\`).`);
  }
}

function cmdFind(ebin, needle) {
  const lower = needle.toLowerCase();
  let hits = 0;
  for (const { token: t, depth } of walkTokens(ebin.tokens)) {
    const text = t.kind === "name" || t.kind === "string" || t.kind === "id" ? String(t.value) : null;
    if (text && text.toLowerCase().includes(lower)) {
      console.log(`@${String(t.at).padStart(9)}  ${"  ".repeat(depth)}${t.kind.padEnd(6)} ${JSON.stringify(t.value)}`);
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
      const e = readEbin(file, { strict: !flags.lenient });
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
      const e = readEbin(file, { strict: !flags.lenient });
      const used = new Set();
      for (const { token: t } of walkTokens(e.tokens)) if (t.kind === "guidRef") used.add(t.index);
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
      const e = readEbin(file, { strict: !flags.lenient });
      rows.push({
        file, tokens: e.tokenCount, bodyBytes: e.bodySize, gapBytes: e.gapBytes, gaps: e.gaps.length,
        opaqueBlocks: e.opaqueBlocks, exact: e.exact,
        shortLengths: e.lengths.short, midValue: e.lengths.midValue, boundary: e.lengths.boundary,
        truncated16: e.lengths.truncated16,
      });
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
      (r.shortLengths ? `  short lengths ${r.shortLengths}` : "") +
      (r.exact ? "" : `  (${r.gaps} region(s), ${r.opaqueBlocks} opaque block(s), ${r.gapBytes} bytes)`));
  }
  const ok = rows.filter((r) => !r.error);
  const exact = ok.filter((r) => r.exact).length;
  const bytes = ok.reduce((s, r) => s + r.bodyBytes, 0);
  const gap = ok.reduce((s, r) => s + r.gapBytes, 0);
  const short = ok.reduce((s, r) => s + (r.shortLengths || 0), 0);
  const mid = ok.reduce((s, r) => s + (r.midValue || 0), 0);
  const bound = ok.reduce((s, r) => s + (r.boundary || 0), 0);
  const trunc = ok.reduce((s, r) => s + (r.truncated16 || 0), 0);
  const filesWithShort = ok.filter((r) => r.shortLengths).length;
  console.log(`\n${exact}/${ok.length} files decode exactly; ${(100 * (bytes - gap) / bytes).toFixed(2)}% of ${bytes} stream bytes decoded`);
  console.log(`${short} short stored length(s) in ${filesWithShort} file(s): ${mid} end inside a value, ` +
    `${bound} at a token boundary, ${trunc} a u16 wrap of a >64 KiB block — the tokens are the delimiter`);
}

/**
 * Every block whose stored u16 is short of its content, and the token the stored end falls in.
 * This is the evidence behind the header's claim: not a judgement call, a byte-level measurement.
 */
function cmdLengths(files, flags) {
  const rows = [];
  for (const file of files) {
    try {
      const e = readEbin(file, { strict: !flags.lenient });
      rows.push({ file, ...e.lengths });
    } catch (err) {
      rows.push({ file, error: err.message });
    }
  }
  if (rows.some((r) => r.error)) process.exitCode = 1;
  if (flags.json) { console.log(JSON.stringify(rows.length === 1 ? rows[0] : rows, null, 2)); return; }
  for (const r of rows) {
    if (r.error) { console.log(`FAIL  ${r.file}: ${r.error}`); continue; }
    console.log(`${r.file}`);
    if (!r.short) { console.log(`  none — ${r.blocks} block(s), every stored length matches its content`); continue; }
    for (const b of r.blocksWithShortLength) {
      const where = b.endsIn === "value" ? `inside ${b.token} +${b.offset}` : `before ${b.token}`;
      console.log(`  @${String(b.declaredEnd).padStart(10)}  ${String(b.by).padStart(6)} short  ${where}` +
        (b.truncated16 ? "  (u16 wrap)" : "") + (b.forcedByExactChild ? "  (the child's own length is exact)" : "  (inherited)"));
    }
    console.log(`  ${r.short} of ${r.blocks} block(s) short: ${r.midValue} inside a value, ${r.boundary} at a boundary` +
      (r.boundary ? ` (${r.boundaryBeforeName} before a field name)` : "") +
      `; ${r.truncated16} u16 wrap(s); ${r.forcedByExactChild} forced by an exact child`);
  }
  if (rows.length > 1) {
    const ok = rows.filter((r) => !r.error);
    const sum = (k) => ok.reduce((s, r) => s + r[k], 0);
    console.log(`\n${sum("short")} short stored length(s) in ${ok.filter((r) => r.short).length} of ${ok.length} file(s): ` +
      `${sum("midValue")} end inside a value, ${sum("boundary")} at a token boundary, ${sum("truncated16")} u16 wrap(s), ` +
      `${sum("forcedByExactChild")} forced by a child whose own length is exact`);
  }
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  // `--help` is a request, not a failure; no arguments at all is a mistake.
  if (flags.help) { process.stdout.write(USAGE); return; }
  if (flags._.length === 0) { process.stderr.write(USAGE); process.exitCode = 1; return; }
  const [command, file, needle] = flags._;
  if (!file) { process.stderr.write(USAGE); process.exitCode = 1; return; }
  if (command === "verify") { cmdVerify(flags._.slice(1), flags); return; }
  if (command === "lengths") { cmdLengths(flags._.slice(1), flags); return; }
  if (command === "worlds") { cmdWorlds(flags._.slice(1), flags); return; }
  if (command === "resources") { cmdResources(flags._.slice(1), flags); return; }
  if (command === "find" && needle === undefined) {
    throw usageError("find needs a <needle>: node tools/ebin.mjs find <file> <needle>");
  }
  const ebin = readEbin(file, { strict: !flags.lenient });
  switch (command) {
    case "info": cmdInfo(ebin, flags); break;
    case "names": cmdNames(ebin, flags); break;
    case "guids": cmdGuids(ebin, flags); break;
    case "tokens": cmdTokens(ebin, flags); break;
    case "entities": cmdEntities(ebin, flags); break;
    case "find": cmdFind(ebin, needle, flags); break;
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

