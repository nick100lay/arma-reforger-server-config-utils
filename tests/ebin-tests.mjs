// Test suite for tools/ebin.mjs (the Enfusion binary resource reader).
//
//   node tests/ebin-tests.mjs
//
// The fixtures are written here byte by byte, so the suite pins the container layout, the tag
// table and the record grammar themselves rather than a captured resource: game resources are
// ~2 GB of archives and cannot be committed.
//
// What is pinned, and why each one is worth a test:
//   * the three tables (names, GUIDs, and the value stream that must tile exactly);
//   * `0x05` as a GUID *table index* — the single fact that makes a world readable, because it
//     is how a record names its prefab. 68 576 of these tokens across the 103 vanilla worlds
//     resolve inside the table and none falls outside it;
//   * `0x0e` as a length-delimited block whose content tiles exactly (`end = at + 1 + length`),
//     and a block whose content does *not* tile becoming `opaque` instead of being invented;
//   * the record grammar `<class> <id> ":" <guidRef> <block>`, which is how entities, prefabs
//     and nesting are recovered;
//   * a component being a class name *with* a GUID, so a sub-object without one is not a
//     component;
//   * tag 0x02 as an eight-byte value that is kept as hex rather than read as a number;
//   * the interface itself: `readEbin` from bytes, CLI options that are refused rather than
//     swallowed, `--json` on every command that prints a table, and — in a fixed-seed fuzz block —
//     that a mutated or hostile file always fails as a described `Error`, never as an engine
//     `RangeError` or a hang.
//
// The CLI is exercised as a real child process with stdio ignored and results written to
// files, so it keeps working in sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEbin, entities, readHeader, TAGS, scenes } from "../tools/ebin.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "ebin.mjs");
const tmp = join(root, "tests", ".tmp-ebin");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else { failures++; console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`); }
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const f32 = (n) => { const b = Buffer.alloc(4); b.writeFloatLE(n); return b; };
const i32 = (n) => { const b = Buffer.alloc(4); b.writeInt32LE(n); return b; };
const u64bytes = (hex) => Buffer.from(hex, "hex").reverse();
const guidBytes = (hex) => Buffer.from(hex, "hex").reverse();

/** Build an EBIN resource: "EBIN" | u32 version | u16 names | u16 guids | names | guids | tokens. */
function buildEbin({ names, guids, tokens, version = 1 }) {
  const parts = [Buffer.from("EBIN", "latin1"), u32(version), u16(names.length), u16(guids.length)];
  for (const n of names) { const b = Buffer.from(n, "utf8"); parts.push(u16(b.length), b); }
  for (const g of guids) parts.push(guidBytes(g));
  parts.push(...tokens);
  return Buffer.concat(parts);
}

// --- token writers ---------------------------------------------------------

const tName = (i) => Buffer.concat([Buffer.from([0x0d]), u16(i)]);
const tNameOf = (names, s) => tName(names.indexOf(s));
const tId = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([Buffer.from([0x43]), u16(b.length), b]); };
const tStr = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([Buffer.from([0x0c]), u16(b.length), b]); };
const tVec3 = (x, y, z) => Buffer.concat([Buffer.from([0x08]), f32(x), f32(y), f32(z)]);
const tVec2 = (x, y) => Buffer.concat([Buffer.from([0x07]), f32(x), f32(y)]);
const tVec4 = (a, b, c, d) => Buffer.concat([Buffer.from([0x09]), f32(a), f32(b), f32(c), f32(d)]);
const tF32 = (v) => Buffer.concat([Buffer.from([0x06]), f32(v)]);
const tI32 = (v) => Buffer.concat([Buffer.from([0x01]), i32(v)]);
const tU8 = (v) => Buffer.from([0x0b, v]);
const tEmpty = () => Buffer.from([0x00]);
const tGuidRef = (i) => Buffer.concat([Buffer.from([0x45]), u16(i)]); // 0x45: a component instance GUID
/** 0x05: a resource reference — the same table, but the tag a prefab or resource-valued member uses. */
const tResourceRef = (i) => Buffer.concat([Buffer.from([0x05]), u16(i)]);
const tGuidInline = (hex) => Buffer.concat([Buffer.from([0x44]), guidBytes(hex)]);
/** 0x02 as it appears in a world: the eight payload bytes in stream order, kept as raw hex. */
const tU64 = (hex) => Buffer.concat([Buffer.from([0x02]), Buffer.from(hex, "hex")]);
const tColon = (names) => tNameOf(names, ":");

/** An array token: tag 0x80|elem, u32 count, then the untagged elements. */
const tArrayI32 = (vals) => Buffer.concat([Buffer.from([0x81]), u32(vals.length), ...vals.map(i32)]);
const tArrayVec3 = (vals) => Buffer.concat([Buffer.from([0x88]), u32(vals.length), ...vals.flatMap(([x, y, z]) => [f32(x), f32(y), f32(z)])]);
const tArrayVec2 = (vals) => Buffer.concat([Buffer.from([0x87]), u32(vals.length), ...vals.flatMap(([x, y]) => [f32(x), f32(y)])]);
const tArrayStr = (vals) => {
  const body = vals.flatMap((s) => { const b = Buffer.from(s, "utf8"); return [u16(b.length), b]; });
  return Buffer.concat([Buffer.from([0x8c]), u32(vals.length), ...body]);
};

/**
 * A length-delimited block: tag 0x0e, u16 length, content — where the stored length counts the
 * two length bytes as well, so `blockEnd = at + 1 + length`. Every fixture builds its blocks
 * through this helper, which is what makes the layout itself the thing under test.
 */
const blk = (...parts) => {
  const content = Buffer.concat(parts);
  return Buffer.concat([Buffer.from([0x0e]), u16(content.length + 2), content]);
};

/** Five `empty` padding bytes, the run an object's block starts with in every world measured. */
const pad = (n = 5) => Buffer.concat(Array.from({ length: n }, tEmpty));

const NAMES = ["SubScene", "Parent", "GenericEntity", ":", "components", "RigidBody", "coords", "angles", "m_fHealth",
  "m_sBaseName", "m_sBaseNameUpper", "m_sObjectToSpawn", "BSP", "EventHandlers", "BaseEventHandler", "m_Labels",
  "SCR_DebriefingScreen", "m_aZones",
  // the shapes a member's value can take: an array, an array of objects, a nested object, an
  // empty value, and the `+` append operator (the only other punctuation the name table holds)
  "m_aWheels", "m_aActions", "m_Getter", "m_aLayerName", "SCR_ActionKill", "SCR_GetEntity", "+", "m_sStruct",
  "m_iInner"];
const GUIDS = [
  "1EA95DAE3230BEB0", // 0: the base world, referenced by `Parent`
  "622086ACB9D1E3B2", // 1: the entity's prefab
  "AABBCCDDEEFF0011", // 2: a component GUID
  "0011223344556677", // 3: a resource-valued member
];

const tokens = [
  tName(0), blk(pad(), tName(1), tResourceRef(0)),                                       // SubScene { Parent }
  tName(2), tId("CP_Kamensk"), tColon(NAMES), tResourceRef(1),                            // GenericEntity "CP_Kamensk" : <prefab>
  blk(
    pad(),
    tName(9), tStr("#AR-Campaign_MapLocation_Cain_Kamensk"),
    tName(10), tStr("#AR-Campaign_MapLocation_Cain_Kamensk-UC"),
    tName(11), tResourceRef(3),                                                          // a resource-valued member
    tName(6), tVec3(11866.5, 8.292, 10679.665),
    tName(7), tVec3(0, -15.205, 0),
    tName(4), blk(                                                                   // components {
      tEmpty(), tEmpty(),
      tName(5), tGuidRef(2), blk(pad(), tName(8), tF32(75.5)),                       //  RigidBody "<guid>" { m_fHealth }
      tName(13), tGuidInline("1234567890ABCDEF"), blk(pad(), tName(14), tF32(1)),    //  EventHandlers "<guid>" — no class name
    ),
  ),
];
const good = buildEbin({ names: NAMES, guids: GUIDS, tokens });

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const goodPath = join(tmp, "good.ebin");
writeFileSync(goodPath, good);

// --- the container --------------------------------------------------------

{
  const e = readEbin(goodPath);
  check("container: version, names and guids", e.header.version === 1 && e.header.names.length === NAMES.length && e.header.guids.length === GUIDS.length);
  check("container: names decoded in order", e.header.names[6] === "coords" && e.header.guids[0] === GUIDS[0]);
  check("stream: no gaps in a well-formed resource", e.exact && e.gapBytes === 0, JSON.stringify(e.gaps));
  check("stream: the whole value stream is decoded", e.decodedBytes === e.bodySize && e.opaqueBlocks === 0,
    JSON.stringify({ decoded: e.decodedBytes, body: e.bodySize, opaque: e.opaqueBlocks }));
}

// --- readEbin accepts the bytes themselves, not only a path -----------------
//
// A `.pak` entry is a Buffer (`pak.mjs` returns one), so a library user should not have to write a
// world to disk before reading it. The label for a byte input is `<buffer>` unless `name` says
// otherwise, and it is what an error names.

{
  const fromBuffer = readEbin(good);
  check("library: readEbin accepts a Buffer, labelled <buffer>",
    fromBuffer.file === "<buffer>" && fromBuffer.exact && fromBuffer.header.names.length === NAMES.length,
    JSON.stringify({ file: fromBuffer.file, exact: fromBuffer.exact }));
  check("library: entities() works on a buffer read", entities(fromBuffer).length === 1);
  const named = readEbin(new Uint8Array(good), { name: "worlds/Cain/Cain.ent" });
  check("library: a Uint8Array works too, and `name` labels it",
    named.file === "worlds/Cain/Cain.ent" && named.exact, JSON.stringify(named.file));
  check("library: a path still comes back in `file`", readEbin(goodPath).file === goodPath);
  let threw = null;
  try { readEbin(Buffer.from("NOPE not an ebin")); } catch (err) { threw = err; }
  check("library: a buffer that is not EBIN is refused with its label",
    threw !== null && threw.message.startsWith("<buffer>: ") && /EBIN/.test(threw.message),
    threw ? threw.message : "no error");
}

// --- tokens ---------------------------------------------------------------

{
  const e = readEbin(goodPath);
  const flat = e.tokens;
  const all = (function flatten(list, out = []) { for (const t of list) { out.push(t); if (t.children) flatten(t.children, out); } return out; })(flat);
  const near = (a, b) => Math.abs(a - b) < 1e-3;

  check("block: 0x0e is a length-delimited scope, and its content tiles it exactly",
    e.tokens[0].kind === "name" && e.tokens[1].kind === "block"
    && e.tokens[1].end === e.tokens[1].at + 1 + e.tokens[1].len
    && e.tokens[1].children.length === 7
    && e.tokens[1].children.at(-2).value === "Parent",
    JSON.stringify({ len: e.tokens[1].len, children: e.tokens[1].children.length }));

  const vec3s = all.filter((t) => t.kind === "vec3");
  check("vector: coords and angles decoded as three floats each",
    vec3s.length === 2 && near(vec3s[0].value[0], 11866.5) && near(vec3s[0].value[2], 10679.665)
    && near(vec3s[1].value[1], -15.205), JSON.stringify(vec3s.map((t) => t.value)));

  const vec4 = buildEbin({ names: NAMES, guids: GUIDS, tokens: [blk(tVec4(1, 0, 0, 1))] });
  writeFileSync(join(tmp, "vec4.ebin"), vec4);
  check("vector: vec4 decoded", readEbin(join(tmp, "vec4.ebin")).tokens[0].children[0].value.join() === "1,0,0,1");

  check("scalars: i32, f32, u8",
    all.some((t) => t.kind === "i32") === false // no i32 in this fixture
    && all.some((t) => t.kind === "f32" && t.value === 75.5)
    && all.some((t) => t.kind === "u8") === false,
    JSON.stringify(all.filter((t) => ["i32", "f32", "u8"].includes(t.kind)).map((t) => [t.kind, t.value])));

  check("strings: an id (0x43) and a value string (0x0c) are told apart by tag",
    all.find((t) => t.tag === 0x43).value === "CP_Kamensk"
    && all.some((t) => t.tag === 0x0c && t.value.startsWith("#AR-Campaign")));

  check("guids: a table reference resolves to the table entry, an inline GUID is read from the stream",
    all.find((t) => t.kind === "guidRef" && t.tag === 0x05 && t.index === 1).value === GUIDS[1]
    && all.find((t) => t.kind === "guidRef" && t.tag === 0x45 && t.index === 2).component === true
    && all.find((t) => t.kind === "guid").value === "1234567890ABCDEF");

  check("names resolve through the name table", all.some((t) => t.kind === "name" && t.value === "m_fHealth"));
}

// --- 0x02 is an eight-byte value, kept as hex ------------------------------

{
  const path = join(tmp, "u64.ebin");
  writeFileSync(path, buildEbin({ names: NAMES, guids: GUIDS, tokens: [blk(tName(16), tU64("0304000000000800"), tName(6), tVec3(1, 2, 3))] }));
  const e = readEbin(path);
  const t = e.tokens[0].children.find((x) => x.tag === 0x02);
  check("0x02: eight bytes, kept as raw hex *and* as the two words the text form prints",
    t && t.value === "0304000000000800" && t.raw === true
    && t.words?.[0] === 0x403 && t.words?.[1] === 0x80000 && e.exact,
    JSON.stringify(t && { value: t.value, words: t.words }));
}

// --- arrays ---------------------------------------------------------------

{
  const path = join(tmp, "arrays.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [blk(
      tName(17), tArrayI32([1, -2, 3]),
      tName(6), tArrayVec3([[1, 2, 3], [4, 5, 6]]),
      tName(16), tArrayStr(["Terrain", "Water"]),
      tName(6), tVec3(9, 9, 9),
    )],
  }));
  const e = readEbin(path);
  const arr = e.tokens[0].children.filter((t) => t.kind === "array");
  check("arrays: 0x8X is a u32 count plus untagged elements of type 0xX, and it consumes them exactly",
    e.exact && arr.length === 3
    && arr[0].elemKind === "i32" && arr[0].count === 3
    && arr[1].elemKind === "vec3" && arr[1].count === 2
    && arr[2].elemKind === "string" && arr[2].count === 2,
    JSON.stringify(arr.map((a) => [a.count, a.elemKind])));
  check("arrays: the token after an array is still read correctly",
    e.tokens[0].children.at(-1).kind === "vec3" && e.tokens[0].children.at(-1).value[0] === 9);
}

// --- a block of text is a payload, not undecoded data ---------------------
//
// `BSP`, the world's visibility tree, is written as ASCII decimal integers: `<u32 nodeCount>` then
// `nodeCount` records of four integers. Measured on all 19 in the shipped worlds, `count * 4 + 1`
// is exactly the number of integers, so the payload is summarised instead of dumped.

{
  const body = "3 1 2 3 4 5 6 7 8 9 10 11 12";
  const path = join(tmp, "bsp.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [blk(tName(12), blk(tEmpty(), tEmpty(), Buffer.from(body, "latin1")), tName(6), tVec3(1, 2, 3))],
  }));
  const e = readEbin(path);
  const inner = e.tokens[0].children[1];
  check("text payload: a block of ASCII integers is decoded as text, with its record count",
    e.exact && inner.kind === "block" && inner.text?.kind === "ints"
    && inner.text.ints === 13 && inner.text.records === 3 && inner.text.leadingNuls === 2,
    JSON.stringify(inner.text));
  check("text payload: it is not counted as an undecoded gap",
    e.opaqueBlocks === 0 && e.gapBytes === 0, JSON.stringify({ o: e.opaqueBlocks, g: e.gapBytes }));
  check("text payload: the members after it are still decoded",
    e.tokens[0].children.at(-1).kind === "vec3");
}

// --- a block whose content is not tokens stays opaque ---------------------

{
  // Not tokens, not ASCII, and not a list behind a header: genuinely unread data.
  const blob = Buffer.from([0x99, 0x88, 0x77, 0x66, 0xde, 0xad, 0xbe, 0xef, 0xf0, 0x0d]);
  const path = join(tmp, "opaque.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [blk(tName(12), blk(blob), tName(6), tVec3(1, 2, 3))],
  }));
  const e = readEbin(path);
  const outer = e.tokens[0];
  const inner = outer.children[1];
  check("opaque: a block whose content is neither tokens nor text is marked, not guessed at",
    inner.kind === "block" && inner.opaque === true && inner.children === undefined,
    JSON.stringify({ opaque: inner.opaque, children: inner.children?.length }));
  check("opaque: its bytes are counted as undecoded, so coverage cannot be overstated",
    e.opaqueBlocks === 1 && e.gapBytes === blob.length && e.exact === false,
    JSON.stringify({ opaqueBlocks: e.opaqueBlocks, gapBytes: e.gapBytes, exact: e.exact }));
  check("opaque: the records after it are still decoded",
    outer.children.at(-1).kind === "vec3" && outer.children.at(-1).value[0] === 1);
}

// --- a list of instances behind two bytes --------------------------------
//
// A group whose members are not plain records is written as two bytes the format does not explain,
// then ordinary `0x0e` sub-blocks. The header is reported, never interpreted; the members are read.

{
  const path = join(tmp, "header-list.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [blk(tName(12), blk(
      Buffer.from([4, 0]),
      blk(pad(), tNameOf(NAMES, "m_iInner"), tI32(7)),
      blk(pad(), tNameOf(NAMES, "m_iInner"), tI32(8)),
    ))],
  }));
  const e = readEbin(path);
  const inner = e.tokens[0].children[1];
  check("header list: two bytes, then the members tile exactly — read, with the header kept as data",
    e.exact && inner.headerBytes === 2 && inner.header.join() === "4,0"
    && inner.children.length === 2 && inner.children.every((c) => c.kind === "block"),
    JSON.stringify({ headerBytes: inner.headerBytes, header: inner.header, children: inner.children?.length }));
  check("header list: the members keep their own content",
    inner.children[1].children.some((x) => x.kind === "i32" && x.value === 8));
}

// --- a stored length that is short of its content --------------------------
//
// The u16 after `0x0e` is a lower bound, not a delimiter. Three shapes are measured over the 103
// shipped worlds and pinned here: the recorded end inside a value's payload, the recorded end on a
// token boundary whose token cannot continue the enclosing list, and a block over 64 KiB, where the
// u16 is exactly the true length modulo 65536.

{
  // 4 bytes short: the recorded end falls inside the last value's payload, just after its tag.
  const child = blk(pad(), tNameOf(NAMES, "m_iInner"), tI32(5));
  const parent = buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [Buffer.concat([Buffer.from([0x0e]), u16(child.length + 2 - 4), child])],
  });
  const path = join(tmp, "short-parent.ebin");
  writeFileSync(path, parent);
  const e = readEbin(path);
  const t = e.tokens[0];
  check("short length: a child that tiles is trusted over the parent's short length",
    t.kind === "block" && t.widened === 4 && t.children?.length === 1
    && t.children[0].children?.some((x) => x.kind === "i32" && x.value === 5) && e.exact,
    JSON.stringify({ widened: t.widened, children: t.children?.length, exact: e.exact }));
  check("short length: the recorded end is inside a value, and the child's own length is exact",
    t.lengthShort?.endsIn === "value" && t.lengthShort.token === "i32"
    && t.lengthShort.offset === 1 && t.lengthShort.forcedByExactChild === true,
    JSON.stringify(t.lengthShort));
  check("short length: the file summary counts it",
    e.lengths.short === 1 && e.lengths.midValue === 1 && e.lengths.boundary === 0
    && e.lengths.forcedByExactChild === 1 && e.lengths.blocksWithShortLength.length === 1,
    JSON.stringify({ ...e.lengths, blocksWithShortLength: undefined }));
}

{
  // 8 bytes short: the recorded end falls exactly on the field name, not inside a value. That is a
  // token boundary, but the token cannot continue the record list it would be left in — which is
  // why the child still wins rather than the parent's number.
  const child = blk(pad(), tNameOf(NAMES, "m_iInner"), tI32(5));
  const parent = buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [Buffer.concat([Buffer.from([0x0e]), u16(child.length + 2 - 8), child])],
  });
  const path = join(tmp, "short-parent-boundary.ebin");
  writeFileSync(path, parent);
  const e = readEbin(path);
  const t = e.tokens[0];
  check("short length: a recorded end on a token boundary is reported with the token it lands before",
    t.lengthShort?.endsIn === "boundary" && t.lengthShort.token === "name:m_iInner"
    && t.lengthShort.offset === 0 && t.lengthShort.forcedByExactChild === true && e.exact,
    JSON.stringify(t.lengthShort));
}

{
  // A block of more than 64 KiB cannot be expressed in u16 at all: the stored value is exactly the
  // true length modulo 65536, and only the token stream says where the block ends. The shape is the
  // corpus's: a group body whose two-byte header is followed by member blocks, enough of them that
  // the body outgrows a u16 (the last member's own length stays exact, so the extension is its doing).
  const members = Buffer.concat(Array.from({ length: 800 }, (_, i) =>
    Buffer.concat([tId(`m${i}`), blk(pad(80), tNameOf(NAMES, "m_iInner"), tI32(i))])));
  const body = Buffer.concat([Buffer.from([3, 0]), members]);
  const trueLen = body.length + 2;
  const wrapped = buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [Buffer.concat([Buffer.from([0x0e]), u16(trueLen % 65536), body])],
  });
  const path = join(tmp, "short-parent-wrap.ebin");
  writeFileSync(path, wrapped);
  const e = readEbin(path);
  const t = e.tokens[0];
  check("short length: a >64 KiB block's u16 is a wrap of the true length, and the reader says so",
    trueLen > 0xffff && t.kind === "block" && t.len === trueLen % 65536
    && t.widened === 65536 && t.lengthShort?.truncated16 === true
    && t.lengthShort.forcedByExactChild === true
    && e.exact && e.lengths.truncated16 === 1
    && t.children?.filter((c) => c.kind === "block").length === 800,
    JSON.stringify({ trueLen, stored: t.len, widened: t.widened, short: t.lengthShort, exact: e.exact, kids: t.children?.length }));
}

// --- an unknown tag is a reported gap, not a wrong token ------------------

{
  const withGap = buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [...tokens, Buffer.from([0x99, 0x01, 0x02, 0x03]), tName(0), tId("AfterTheGap")],
  });
  const path = join(tmp, "gap.ebin");
  writeFileSync(path, withGap);
  const e = readEbin(path, { strict: false });
  check("unknown tag: recorded as a gap with its byte range",
    e.gaps.length === 1 && e.gaps[0].bytes === 4 && e.gaps[0].reason.includes("0x99"),
    JSON.stringify(e.gaps));
  check("unknown tag: with --lenient the stream resynchronises on the next record and decodes past it",
    e.tokens.some((t) => t.kind === "id" && t.value === "AfterTheGap") && !e.exact);
  let threw = null;
  try { readEbin(path); } catch (err) { threw = err; }
  check("unknown tag: strict is the default and refuses instead of guessing",
    threw !== null && /0x99/.test(threw.message), threw ? threw.message : "no error");
  threw = null;
  try { readEbin(path, { strict: true }); } catch (err) { threw = err; }
  check("unknown tag: --strict still refuses (it is the default, kept as an accepted flag)",
    threw !== null && /0x99/.test(threw.message), threw ? threw.message : "no error");
  check("unknown tag: strict does not throw for an opaque block (that is data, not a defect)",
    (() => { try { readEbin(join(tmp, "opaque.ebin"), { strict: true }); return true; } catch { return false; } })());
}

// --- records: class, id, prefab, members, components, nesting -------------

{
  const e = readEbin(goodPath);
  const list = entities(e);
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  const record = list.find((x) => x.className === "GenericEntity");

  check("records: a `:`+GUID+block triple is one record, and SubScene (no id, no prefab) is not",
    list.length === 1 && list[0].kind === "entity", JSON.stringify(list.map((x) => [x.kind, x.className])));
  check("records: the class and the instance id belong to the record",
    record?.id === "CP_Kamensk" && record.depth === 0);
  check("records: the prefab is a GUID table reference — the fact the whole format turns on",
    record.prefab?.guid === GUIDS[1] && record.prefab?.index === 1, JSON.stringify(record.prefab));
  check("records: own members carry their values",
    record.fields.some((f) => f.name === "m_sBaseName" && f.value.startsWith("#AR-Campaign"))
    && record.fields.some((f) => f.name === "coords" && f.value[0] === 11866.5));
  check("records: a resource-valued member keeps its GUID reference",
    record.fields.some((f) => f.name === "m_sObjectToSpawn" && f.guid === GUIDS[3]),
    JSON.stringify(record.fields.filter((f) => f.kind === "guidRef")));
  check("records: the entity's own position and rotation, from its own coords/angles",
    near(record.position[0], 11866.5) && near(record.position[2], 10679.665) && near(record.angle[1], -15.205),
    JSON.stringify([record.position, record.angle]));
  check("records: a component is a class name with a GUID, and its members stay inside it",
    record.components.length === 2
    && record.components[0].className === "RigidBody" && record.components[0].guid === GUIDS[2]
    && record.components[0].fields.some((f) => f.name === "m_fHealth" && f.value === 75.5)
    && !record.fields.some((f) => f.name === "m_fHealth"),
    JSON.stringify(record.components.map((c) => [c.className, c.fields.map((f) => f.name)])));
  check("records: a component GUID carried inline in the stream is still a component",
    record.components[1].className === "EventHandlers" && record.components[1].inline === true,
    JSON.stringify(record.components[1]));
}

// --- nesting: the child list inside a body --------------------------------

// A child list is a block of its own inside the parent's body: the body holds the parent's own
// members (`coords`, `components`, …), the child list holds `<class> [id] [":" <prefab>] <block>`
// entries. That is the shape measured in the worlds (`Arland.ent`: a group member's body ends with a
// block holding its own children) and the shape a prefab uses for its children.

{
  const path = join(tmp, "nested.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [
      // an area containing a task containing a slot, each with its own transform
      tName(2), tId("Area_A"), tColon(NAMES), tResourceRef(1),
      blk(pad(), tName(6), tVec3(1, 1, 1),
        blk(pad(2),
          tName(2), tId("Task_B"), tColon(NAMES), tResourceRef(1),
          blk(pad(), tName(6), tVec3(2, 2, 2),
            blk(pad(2),
              tName(2), tId("Slot_C"), tColon(NAMES), tResourceRef(1),
              blk(pad(), tName(6), tVec3(3, 3, 3))))))
    ],
  }));
  const list = entities(readEbin(path));
  const ids = list.map((x) => x.id);
  check("nesting: a child list inside a body holds the children, at depth+1",
    list.length === 3 && ids.join() === "Area_A,Task_B,Slot_C" && list.map((x) => x.depth).join() === "0,1,2",
    JSON.stringify(list.map((x) => [x.id, x.depth])));
  check("nesting: each level keeps its own transform and does not inherit its parent's",
    list[0].position[0] === 1 && list[1].position[0] === 2 && list[2].position[0] === 3,
    JSON.stringify(list.map((x) => x.position)));
  check("nesting: every node names its parent by index, and the root's is null",
    list[0].parent === null && list[1].parent === 0 && list[2].parent === 1,
    JSON.stringify(list.map((x) => x.parent)));
}

// A member's *block* is not a child list, however much it looks like one: `Data { … }` is a member
// of a `ShapePoint` whose value is a struct, while `RoadEntity { … }` is a road child. The token in
// front tells them apart — a value, or the list's boundary. Eden.ent has 285 of the first kind and
// Arland.ent 434 of the second.

{
  const names = [...NAMES, "ShapePoint", "Position", "Data", "RoadEntity"];
  const path = join(tmp, "member-vs-child.ebin");
  writeFileSync(path, buildEbin({
    names, guids: GUIDS,
    tokens: [
      tName(2), tId("Holder"), tColon(names), tResourceRef(1),
      blk(pad(),
        // a member whose value is an object, then a member whose value is a struct: neither is a child
        tNameOf(names, "Position"), tVec3(1, 2, 3),
        tNameOf(names, "Data"), blk(pad(2), tNameOf(names, "Position"), tVec3(4, 5, 6)),
        // …and a child, at the boundary of a list of its own
        blk(pad(2), tNameOf(names, "RoadEntity"), blk(pad(), tName(6), tVec3(7, 8, 9)))),
    ],
  }));
  const list = entities(readEbin(path));
  check("records: a member's struct value is not an entity, a child at the list boundary is",
    list.length === 2 && list[0].className === "GenericEntity" && list[1].className === "RoadEntity"
    && list[1].depth === 1 && list[1].parent === 0 && list[1].position[0] === 7,
    JSON.stringify(list.map((x) => [x.className, x.depth, x.parent])));
}

// --- groups: members outside the body, and children of a member -----------

{
  const NAMES2 = [...NAMES, "$grp", "$grpRoad"];
  const groupPath = join(tmp, "group2.ebin");
  // two members inside the body, two more as sibling blocks after it: that is how a member list that
  // does not fit the writer's block length is stored (253 such groups in the 103-world corpus)
  writeFileSync(groupPath, buildEbin({
    names: NAMES2, guids: GUIDS,
    tokens: [
      tNameOf(NAMES2, "$grp"), tName(2), tColon(NAMES2), tResourceRef(1),
      blk(pad(2),
        blk(pad(), tName(9), tStr("Pier_Michurino"), tName(6), tVec3(10, 0, 10)),
        blk(pad(), tName(9), tStr("SosnovyMys"), tName(6), tVec3(20, 0, 20)),
      ),
      blk(pad(), tName(9), tStr("Third"), tName(6), tVec3(30, 0, 30)),
      blk(pad(), tName(9), tStr("Fourth"), tName(6), tVec3(40, 0, 40)),
    ],
  }));
  const summary = entities(readEbin(groupPath), { instances: 0 });
  check("groups: $grp <class> : <prefab> <block> is one node carrying its instance count",
    summary.length === 1 && summary[0].kind === "group" && summary[0].className === "GenericEntity"
    && summary[0].prefab?.guid === GUIDS[1] && summary[0].instances === 4 && summary[0].expanded === false,
    JSON.stringify(summary.map((x) => [x.kind, x.className, x.instances, x.expanded])));
  check("groups: an unexpanded group still reports its first member's transform",
    summary[0].position?.[0] === 10, JSON.stringify(summary[0].position));
  check("groups: a group header has no transform of its own, so its scale is the neutral 1",
    summary[0].scale === 1, JSON.stringify(summary[0].scale));
  const groupLog = openSync(join(tmp, "group.txt"), "w");
  try { spawnSync(process.execPath, [tool, "entities", groupPath, "--instances", "0"], { stdio: ["ignore", groupLog, groupLog] }); } finally { closeSync(groupLog); }
  const groupText = readFileSync(join(tmp, "group.txt"), "utf8");
  check("groups: the CLI prints no 'scale undefined' for a group",
    !/undefined/.test(groupText), groupText.split("\n").find((l) => l.includes("undefined")) ?? groupText);

  const expanded = entities(readEbin(groupPath), { instances: 10 });
  check("groups: the members that follow the body are members, not stray blocks",
    expanded.length === 5 && expanded[0].instances === 4
    && expanded.slice(1).every((x) => x.kind === "instance" && x.className === "GenericEntity" && x.depth === 1 && x.parent === 0)
    && expanded[4].position[0] === 40,
    JSON.stringify(expanded.map((x) => [x.kind, x.depth, x.position?.[0] ?? null])));

  // a member with children of its own: its body ends with a child list
  const nestedPath = join(tmp, "group-nested.ebin");
  writeFileSync(nestedPath, buildEbin({
    names: NAMES2, guids: GUIDS,
    tokens: [
      tNameOf(NAMES2, "$grp"), tName(1), tColon(NAMES2), tResourceRef(1),
      blk(pad(2),
        blk(pad(), tName(6), tVec3(5, 0, 5),
          blk(pad(2), tName(2), tColon(NAMES2), tResourceRef(3), blk(pad(), tName(6), tVec3(6, 0, 6))))),
    ],
  }));
  // A group written without `$grp`: the class and prefab are stated once and the members follow as
  // `id … block` — what `Ugoldar_Randomization_Arena` holds in MP/Coop_CombatOps_Cain.ent, where the
  // World Editor shows those layers as the arena's own children and no entity in between.
  const barePath = join(tmp, "group-bare.ebin");
  writeFileSync(barePath, buildEbin({
    names: NAMES2, guids: GUIDS,
    tokens: [
      blk(
        pad(2),
        tName(2), tColon(NAMES2), tResourceRef(1),                                   // GenericEntity : <prefab>
        blk(pad(2),
          tId("Layer_A"), blk(pad(), tName(6), tVec3(1, 0, 1)),
          tId("Layer_B"), blk(pad(), tName(6), tVec3(2, 0, 2)))),
    ],
  }));
  const bare = entities(readEbin(barePath));
  check("groups: a member list with no `$grp` is a group, not an entity with children",
    bare.length === 3 && bare[0].kind === "group" && bare[0].className === "GenericEntity"
    && bare[0].prefab?.guid === GUIDS[1] && bare[0].instances === 2
    && bare[1].kind === "instance" && bare[1].id === "Layer_A" && bare[1].parent === 0
    && bare[2].id === "Layer_B" && bare[2].position[0] === 2,
    JSON.stringify(bare.map((x) => [x.kind, x.id ?? null, x.parent])));
}

// --- components: sub-components, and a group of them ----------------------

// The shape below is copied from a Workbench project's own text layer — a hand-made entity with no
// prefab and a component built out of components (`worlds/arland_test_Layers/default.layer`):
//
//     SCR_BaseGameMode SCR_BaseGameMode1 {
//      components {
//       SCR_RespawnSystemComponent "{6AA37B0DFEF7C77E}" {
//        components {
//         SCR_FreeSpawnHandlerComponent "{6AA37B0DC66AC72F}" {
//          m_bDestroyPreviousControlledEntity 1
//         }
//        }
//        m_bEnablePauseMenuRespawn 0
//       }
//      }
//      coords 2051.145 43.536 2060.131
//     }
//
// So a sub-component list is a `components` member of the component, exactly as it is on an entity —
// not a bare class-and-GUID in the component's block. 57 components in the shipped worlds carry one.

{
  const names = [...NAMES, "SCR_BaseGameMode", "SCR_RespawnSystemComponent", "SCR_FreeSpawnHandlerComponent",
    "m_bEnablePauseMenuRespawn", "m_bDestroyPreviousControlledEntity", "LinkType", "NavmeshDoorLink"];
  const path = join(tmp, "subcomponents.ebin");
  writeFileSync(path, buildEbin({
    names, guids: GUIDS,
    tokens: [
      tNameOf(names, "SCR_BaseGameMode"), tId("SCR_BaseGameMode1"),
      blk(                                                                    // the entity's body (no prefab)
        tName(4), blk(                                                        //   components {
          tNameOf(names, "SCR_RespawnSystemComponent"), tGuidRef(2), blk(     //     SCR_RespawnSystemComponent {
            tName(4), blk(                                                    //       components {
              tNameOf(names, "SCR_FreeSpawnHandlerComponent"), tGuidRef(3),
              blk(tNameOf(names, "m_bDestroyPreviousControlledEntity"), tU8(1)),
            ),
            tNameOf(names, "m_bEnablePauseMenuRespawn"), tU8(0),              //       its own field, after the list
            // a member whose value is an object: not a sub-component
            tNameOf(names, "LinkType"), tNameOf(names, "NavmeshDoorLink"), tGuidRef(3),
            blk(tNameOf(names, "m_bEnablePauseMenuRespawn"), tU8(1)),
          ),
        ),
        tName(6), tVec3(2051.145, 43.536, 2060.131),                          //   coords
      ),
    ],
  }));
  const list = entities(readEbin(path));
  const rec = list[0];
  const c0 = rec.components[0];
  check("components: an entity with no prefab and an id is read, with its transform",
    list.length === 1 && rec.className === "SCR_BaseGameMode" && rec.id === "SCR_BaseGameMode1"
    && rec.prefab === null && Math.abs(rec.position[0] - 2051.145) < 1e-3,
    JSON.stringify({ n: list.length, cls: rec?.className, id: rec?.id, prefab: rec?.prefab, pos: rec?.position }));
  check("components: a `components` member of a component is a sub-component list, one level down",
    rec.components.length === 1 && c0.className === "SCR_RespawnSystemComponent"
    && c0.subComponents.length === 1
    && c0.subComponents[0].className === "SCR_FreeSpawnHandlerComponent"
    && c0.subComponents[0].guid === GUIDS[3]
    && c0.subComponents[0].fields.some((f) => f.name === "m_bDestroyPreviousControlledEntity" && f.value === 1),
    JSON.stringify(c0));
  check("components: the parent keeps the fields written after its sub-component list",
    c0.fields.some((f) => f.name === "m_bEnablePauseMenuRespawn" && f.value === 0)
    && !c0.fields.some((f) => f.name === "components"),
    JSON.stringify(c0.fields.map((f) => [f.name, f.value])));
  check("components: a member whose value is an object stays a member, not a sub-component",
    c0.fields.some((f) => f.name === "LinkType" && f.guid === GUIDS[3]) && c0.subComponents.length === 1,
    JSON.stringify(c0.fields.map((f) => [f.name, f.guid ?? null])));
}

// --- the transform is coords, angles *and* scale; Flags is named from the enum ---

// The World Editor's Transformation panel shows three rows — Coords, Angles, Scale — and they are
// three ordinary members of the entity's block. A member that stores none of them is at scale 1.
// `Flags` is `EntityFlags`, whose bit order is in the installed build's own generated script
// (`scripts/Core/generated/Entities/EntityFlags.c`): VISIBLE, TRACEABLE, NO_LINK, FEATURE, …

{
  const names = [...NAMES, "scale", "Flags"];
  const path = join(tmp, "transform.ebin");
  const scaled = [ // one entity with all three, one with only coords
    tName(2), tId("Scaled"), tColon(names), tResourceRef(1),
    blk(
      pad(),
      tName(6), tVec3(1, 2, 3),
      tName(7), tVec3(0, 90, 0),
      tNameOf(names, "scale"), tF32(2.2),
      tNameOf(names, "Flags"), tU64("0304080007000000"),   // 0x80403 0x7: bytes in stream order
    ),
    tName(2), tId("Plain"), tColon(names), tResourceRef(1),
    blk(pad(), tName(6), tVec3(4, 5, 6)),
  ];
  writeFileSync(path, buildEbin({ names, guids: GUIDS, tokens: scaled }));
  const [a, b] = entities(readEbin(path));
  check("transform: scale is read off the entity and defaults to 1",
    Math.abs(a.scale - 2.2) < 1e-3 && b.scale === 1 && Math.abs(a.position[1] - 2) < 1e-3,
    JSON.stringify([a.scale, b.scale, a.position]));
  check("transform: scale stays in the entity's own fields as well",
    a.fields.some((f) => f.name === "scale" && Math.abs(f.value - 2.2) < 1e-3),
    JSON.stringify(a.fields.map((f) => [f.name, f.value])));

  const fd = openSync(join(tmp, "transform.txt"), "w");
  try { spawnSync(process.execPath, [tool, "entities", path], { stdio: ["ignore", fd, fd] }); } finally { closeSync(fd); }
  const text = readFileSync(join(tmp, "transform.txt"), "utf8");
  check("transform: the CLI prints coords, angles and scale on one line, as the editor shows them",
    /position 1, 2, 3\s+angle 0, 90, 0\s+scale 2\.2/.test(text), text.split("\n").find((l) => l.includes("position")) ?? text);
  check("transform: a member that stores no scale prints none, because 1 is the default",
    (text.match(/scale /g) ?? []).length === 1, JSON.stringify(text.match(/scale [^\n]*/g)));
  check("flags: the measured bits are named, off-boxes included, and everything else stays hex",
    /Flags = 0x80403 0x7\s+\(Static, RelativeY, \+0x3, Visible off, Traceable off, second \+0x4\)/.test(text),
    text.split("\n").find((l) => l.includes("Flags")) ?? text);
}

{
  const bad = join(tmp, "not-ebin.bin");
  writeFileSync(bad, Buffer.from("NOPEnot an ebin file at all"));
  let threw = null;
  try { readEbin(bad); } catch (err) { threw = err; }
  check("bad magic is reported", threw !== null && /EBIN/.test(threw.message), threw ? threw.message : "no error");

  const truncated = join(tmp, "truncated.ebin");
  writeFileSync(truncated, good.subarray(0, 20));
  threw = null;
  try { readEbin(truncated); } catch (err) { threw = err; }
  check("a truncated name table is reported", threw !== null && /truncated/.test(threw.message), threw ? threw.message : "no error");

  // The magic is there and the fixed part of the header is not: saying "missing the EBIN magic" would
  // send the reader looking for the wrong problem.
  const stub = join(tmp, "stub-header.ebin");
  writeFileSync(stub, good.subarray(0, 8));
  threw = null;
  try { readEbin(stub); } catch (err) { threw = err; }
  check("a cut header is reported as a cut header", threw !== null && /truncated EBIN header: 8 byte/.test(threw.message),
    threw ? threw.message : "no error");

  const badIndex = buildEbin({ names: NAMES, guids: GUIDS, tokens: [tName(99)] });
  const p3 = join(tmp, "bad-index.ebin");
  writeFileSync(p3, badIndex);
  const e3 = readEbin(p3, { strict: false });
  check("a name index outside the table is a gap, not a value",
    e3.tokens.length === 0 && e3.gaps.length === 1, JSON.stringify(e3.tokens));

  const badGuid = buildEbin({ names: NAMES, guids: GUIDS, tokens: [tGuidRef(9)] });
  const p4 = join(tmp, "bad-guid.ebin");
  writeFileSync(p4, badGuid);
  const e4 = readEbin(p4, { strict: false });
  check("a GUID index outside the table is a gap", e4.gaps.length === 1 && e4.gaps[0].reason.includes("GUID"));

  const shortBlock = buildEbin({ names: NAMES, guids: GUIDS, tokens: [Buffer.from([0x0e, 0xff, 0x00, 0x00])] });
  const p5 = join(tmp, "short-block.ebin");
  writeFileSync(p5, shortBlock);
  const e5 = readEbin(p5, { strict: false });
  check("a block claiming more bytes than its scope holds is a gap, not a truncated object",
    e5.tokens.length === 0 && e5.gaps.length === 1, JSON.stringify(e5.gaps));

  // A block whose content ends in a truncated value, where the two bytes of that value read as a u16
  // point past the end of the file. Re-parsing "widened to the child's end" used to read past the
  // buffer, so the diagnosis was a Node RangeError rather than the byte that failed.
  const wideContent = Buffer.concat([pad(2), tNameOf(NAMES, "m_iInner"), Buffer.from([0x01, 0x00, 0xff])]);
  const widened = buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [Buffer.concat([Buffer.from([0x0e]), u16(wideContent.length + 2), wideContent])],
  });
  const p6 = join(tmp, "widened-past-eof.ebin");
  writeFileSync(p6, widened);
  threw = null;
  let widenedStrict = null;
  try { widenedStrict = readEbin(p6); } catch (err) { threw = err; }
  check("a widening end beyond the file is never read: the block stays a reported opaque payload",
    threw === null && widenedStrict !== null && widenedStrict.exact === false
    && widenedStrict.opaqueBlocks === 1 && widenedStrict.gapBytes > 0,
    threw ? `[${threw.constructor.name}] ${threw.message}`
      : JSON.stringify({ exact: widenedStrict?.exact, opaque: widenedStrict?.opaqueBlocks, gaps: widenedStrict?.gaps }));
  const widenedLenient = readEbin(p6, { strict: false });
  check("the same file in --lenient mode reports the same gap instead of a crash",
    widenedLenient.gaps.length === 1 && widenedLenient.opaqueBlocks === 1,
    JSON.stringify(widenedLenient.gaps));

  // Each level wraps the previous one in an `0x0e` block, so 600 levels is a 2.4 KB file. Following
  // it recursively is what a stack overflow is made of — the deepest shipped world is 8 levels — so
  // the reader stops with a message naming the cap instead of a RangeError from the engine.
  const nestedFile = (depth) => {
    let inner = blk(pad(1));
    for (let i = 1; i < depth; i++) inner = blk(pad(1), inner);
    return buildEbin({ names: NAMES, guids: GUIDS, tokens: [inner] });
  };
  const deepPath = join(tmp, "deep-600.ebin");
  writeFileSync(deepPath, nestedFile(600));
  threw = null;
  let deepStrict = null;
  try { deepStrict = readEbin(deepPath); } catch (err) { threw = err; }
  check("nesting: 600 levels do not overflow the stack, and the cap says so in the gap",
    threw === null && deepStrict !== null && deepStrict.opaqueBlocks === 1 && deepStrict.exact === false
    && /nesting is deeper than 512/.test(deepStrict.gaps[0]?.reason ?? ""),
    threw ? `[${threw.constructor.name}] ${threw.message}`
      : JSON.stringify({ opaque: deepStrict?.opaqueBlocks, reason: deepStrict?.gaps[0]?.reason }));
  const deepLenient = readEbin(deepPath, { strict: false });
  check("nesting: --lenient stops at the cap and reports an opaque block",
    deepLenient.opaqueBlocks >= 1 && deepLenient.gaps.length >= 1,
    JSON.stringify({ opaque: deepLenient.opaqueBlocks, gaps: deepLenient.gaps.length }));

  const shallowPath = join(tmp, "deep-100.ebin");
  writeFileSync(shallowPath, nestedFile(100));
  const shallow = readEbin(shallowPath);
  check("nesting: 100 levels still decode exactly, so the cap is not in the way",
    shallow.exact && shallow.tokenCount === 200,
    JSON.stringify({ exact: shallow.exact, tokens: shallow.tokenCount }));

  // The length after `0x0e` counts its own two bytes, so 0 and 1 describe a block smaller than the
  // field that describes it. Accepting one made the reader invent two bytes of "content" and call
  // the file exact; it is a corrupt header, and exactly 2 is the empty block.
  for (const len of [0, 1]) {
    const p = join(tmp, `block-len-${len}.ebin`);
    writeFileSync(p, buildEbin({ names: NAMES, guids: GUIDS, tokens: [Buffer.from([0x0e, len, 0x00])] }));
    threw = null;
    try { readEbin(p); } catch (err) { threw = err; }
    check(`block length ${len} is refused instead of being widened into an exact file`,
      threw !== null && threw.constructor === Error && /2-byte length field/.test(threw.message),
      threw ? threw.message : "no error");
    const e = readEbin(p, { strict: false });
    check(`block length ${len} is a gap with --lenient`, e.gaps.length === 1 && !e.exact,
      JSON.stringify(e.gaps));
  }

  // A version this reader does not know is not version 1 with different bytes: all 103 shipped
  // worlds are version 1, so anything else is refused before a number is produced.
  const v2 = join(tmp, "version-2.ebin");
  writeFileSync(v2, buildEbin({ names: NAMES, guids: GUIDS, version: 2, tokens: [tName(0)] }));
  threw = null;
  try { readEbin(v2); } catch (err) { threw = err; }
  check("an unsupported EBIN version is refused, and the message names the file and the version",
    threw !== null && threw.constructor === Error && /version 2/.test(threw.message)
    && threw.message.includes("version-2.ebin"),
    threw ? threw.message : "no error");

  // An array element is untagged, so it cannot report its own failure: an index outside the table
  // used to become a silent `null` in a list that still tiled.
  const badRefArray = Buffer.concat([Buffer.from([0x85]), u32(2), u16(0), u16(9)]);
  const pRefs = join(tmp, "array-ref-out-of-range.ebin");
  writeFileSync(pRefs, buildEbin({ names: NAMES, guids: GUIDS, tokens: [blk(tNameOf(NAMES, "m_aZones"), badRefArray)] }));
  const refs = readEbin(pRefs);
  check("an array element whose GUID index is outside the table is reported, not turned into null",
    refs.exact === false && refs.opaqueBlocks === 1
    && refs.gaps[0].reason.includes("array element 1")
    && refs.gaps[0].reason.includes("GUID table of"),
    JSON.stringify(refs.gaps));
  check("the same array keeps the same reason with --lenient",
    readEbin(pRefs, { strict: false }).gaps[0].reason.includes("array element 1"));

  const badNameArray = Buffer.concat([Buffer.from([0x8d]), u32(1), u16(99)]);
  const pNames = join(tmp, "array-name-out-of-range.ebin");
  writeFileSync(pNames, buildEbin({ names: NAMES, guids: GUIDS, tokens: [blk(tNameOf(NAMES, "m_aZones"), badNameArray)] }));
  const nameRefs = readEbin(pNames);
  check("an array element whose name index is outside the table is reported, naming the table",
    nameRefs.opaqueBlocks === 1 && nameRefs.gaps[0].reason.includes("name table of")
    && nameRefs.gaps[0].reason.includes("index 99"),
    JSON.stringify(nameRefs.gaps));

  // A reader handed bytes it did not write must fail with a diagnosis, never with an engine
  // RangeError or a hang. 2 000 mutations of the fixtures above, fixed seed so the case set is the
  // same on every run (the 32 000-case version of this found the array hang and the past-the-end
  // read; `readEbin` takes a Buffer, so nothing touches the disk).
  let state = 0x9e3779b9;
  const next = () => {
    state ^= state << 13; state >>>= 0;
    state ^= state >> 17;
    state ^= state << 5; state >>>= 0;
    return state;
  };
  const fuzzSeeds = [
    good,
    readFileSync(join(tmp, "group2.ebin")),
    readFileSync(join(tmp, "nested.ebin")),
    readFileSync(join(tmp, "arrays.ebin")),
    readFileSync(join(tmp, "header-list.ebin")),
  ];
  let crashes = 0;
  let slowest = 0;
  for (let i = 0; i < 2000; i++) {
    const src = fuzzSeeds[next() % fuzzSeeds.length];
    const buf = Buffer.from(src);
    const edits = 1 + (next() % 6);
    for (let e = 0; e < edits; e++) buf[next() % buf.length] = next() & 0xff;
    const started = Date.now();
    try {
      readEbin(buf, { strict: i % 3 !== 0 });
    } catch (err) {
      if (err.constructor !== Error) {
        crashes++;
        if (crashes <= 3) console.log(`        ${err.constructor.name}: ${err.message}`);
      }
    }
    slowest = Math.max(slowest, Date.now() - started);
  }
  check("fuzz: 2 000 mutated buffers fail as described Errors, never as RangeError/TypeError",
    crashes === 0, `${crashes} crash(es)`);
  check("fuzz: no mutated buffer takes a pathological time", slowest < 2000, `${slowest} ms`);
}

// --- a member's value: arrays, objects, nested objects, append ------------
//
// A world writes almost every non-scalar value as a block, and what is inside it is readable:
// an array (`m_aIncludedEditableEntityLabels { <array> }`), an array of objects
// (`m_aActivationActions { <Class> <GUID> {…} … }`), a nested object
// (`m_Getter <Class> <GUID> {…}`), or nothing. Printing `<block, N bytes>` for those hides data
// that parses, so each shape is pinned here.

{
  const path = join(tmp, "values.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [
      tName(2), tId("Values"), tColon(NAMES), tResourceRef(1),
      blk(pad(),
        // an array wrapped in a block, the plain case
        tNameOf(NAMES, "m_aWheels"), blk(tEmpty(), tEmpty(), tArrayI32([4, 5])),
        // the append operator: `m_aWheels + { 4 5 }` in the text form
        tNameOf(NAMES, "m_aZones"), tNameOf(NAMES, "+"), blk(tEmpty(), tEmpty(), tArrayI32([7])),
        // an array of objects
        tNameOf(NAMES, "m_aActions"),
        blk(pad(2),
          tNameOf(NAMES, "SCR_ActionKill"), tGuidInline("1111222233334444"),
          blk(pad(), tNameOf(NAMES, "m_fHealth"), tF32(50))),
        // a nested object as a member value
        tNameOf(NAMES, "m_Getter"), tNameOf(NAMES, "SCR_GetEntity"), tGuidInline("5555666677778888"),
        blk(pad(), tNameOf(NAMES, "m_sBaseName"), tStr("SlotAI8")),
        // an empty value
        tNameOf(NAMES, "m_aLayerName"), blk(tEmpty(), tEmpty()),
        // a plain struct: several members, no class name and no GUID
        tNameOf(NAMES, "m_sStruct"), blk(pad(), tNameOf(NAMES, "m_iInner"), tI32(3)),
      ),
    ],
  }));
  const rec = entities(readEbin(path))[0];
  const f = (name) => rec.fields.find((x) => x.name === name);

  check("value: an array inside a block is unwrapped and its elements are decoded",
    f("m_aWheels").kind === "array" && f("m_aWheels").count === 2
    && f("m_aWheels").value.join() === "4,5" && f("m_aWheels").elemKind === "i32",
    JSON.stringify(f("m_aWheels")));
  check("value: `+` is the append operator, not a field called +",
    f("m_aZones").append === true && f("m_aZones").value.join() === "7"
    && !rec.fields.some((x) => x.name === "+"),
    JSON.stringify(rec.fields.map((x) => [x.name, x.append])));
  check("value: a block of ClassName+GUID+block is an array of objects, with their members read",
    Array.isArray(f("m_aActions").objects) && f("m_aActions").objects.length === 1
    && f("m_aActions").objects[0].className === "SCR_ActionKill"
    && f("m_aActions").objects[0].guid === "1111222233334444"
    && f("m_aActions").objects[0].fields.some((x) => x.name === "m_fHealth" && x.value === 50),
    JSON.stringify(f("m_aActions").objects));
  check("value: a member whose value is a nested object keeps the class, the GUID and the body",
    f("m_Getter").kind === "name" && f("m_Getter").value === "SCR_GetEntity"
    && f("m_Getter").guid === "5555666677778888"
    && f("m_Getter").fields.some((x) => x.name === "m_sBaseName" && x.value === "SlotAI8"),
    JSON.stringify(f("m_Getter")));
  check("value: an empty block says so instead of reporting a size",
    f("m_aLayerName").kind === "block" && f("m_aLayerName").empty === true
    && f("m_aLayerName").blockBytes === 2, JSON.stringify(f("m_aLayerName")));
  check("value: a plain struct is read as members, not as a size",
    f("m_sStruct").fields?.some((x) => x.name === "m_iInner" && x.value === 3),
    JSON.stringify(f("m_sStruct")));
}

// --- an array of zero-width elements does not consume bytes ---------------
//
// `0x80` is an array of `empty`, so each element is a tag-less `empty` and therefore 0 bytes:
// `0x80 <u32 count>` with nothing after it. Counting one byte per element shifts everything
// after the array — it silently cost 16 108 tokens in one showcase world when it was wrong.
{
  const path = join(tmp, "empty-array.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [blk(tNameOf(NAMES, "m_aZones"), Buffer.concat([Buffer.from([0x80]), u32(3)]), tNameOf(NAMES, "m_iInner"), tI32(9))],
  }));
  const e = readEbin(path);
  const inner = e.tokens[0].children;
  const arr = inner.find((t) => t.kind === "array");
  check("array: an `empty` element is zero bytes, so the array ends at its count field",
    e.exact && arr.count === 3 && arr.end === arr.at + 5
    && inner.some((t) => t.kind === "name" && t.value === "m_iInner")
    && inner.some((t) => t.kind === "i32" && t.value === 9),
    JSON.stringify(inner.map((t) => [t.kind, t.at, t.end])));

  // A zero-width element means the count is not a byte count: `0x80 <u32 count>` with 2^32-1 costs
  // five bytes, so the elements must not be iterated one by one — a reader that does hangs on a
  // five-byte array. The CLI is run with a timeout so a regression fails instead of stalling CI.
  const huge = join(tmp, "empty-array-huge.ebin");
  writeFileSync(huge, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [blk(tNameOf(NAMES, "m_aZones"), Buffer.concat([Buffer.from([0x80]), u32(0xffffffff)]), tNameOf(NAMES, "m_iInner"), tI32(9))],
  }));
  const eh = readEbin(huge);
  const arrH = eh.tokens[0].children.find((t) => t.kind === "array");
  check("array: a 2^32-1 count of zero-width elements is not iterated over",
    eh.exact && arrH.count === 0xffffffff && arrH.end === arrH.at + 5
    && arrH.values.length === 256 && arrH.valuesTruncated === true,
    JSON.stringify({ count: arrH.count, end: arrH.end, at: arrH.at, values: arrH.values.length }));
  const timed = spawnSync(process.execPath, [tool, "info", huge], { stdio: "ignore", timeout: 10000 });
  check("array: the CLI returns instead of hanging on it",
    timed.status === 0 && timed.signal === null, `status ${timed.status}, signal ${timed.signal}`);
}

// --- 0x07 is a vector of two floats ---------------------------------------
//
// Found by the last undecoded blocks: `07 00 00 34 c2 00 00 34 42` in a Tutorial world is
// (-45, 45), and reading it closes three files that had nothing else wrong with them.

{
  const path = join(tmp, "vec2.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [blk(
      tNameOf(NAMES, "m_iInner"), tVec2(-45, 45),
      tNameOf(NAMES, "m_aZones"), tArrayVec2([[1, 2], [3, 4]]),
    )],
  }));
  const e = readEbin(path);
  const v = e.tokens[0].children.find((x) => x.kind === "vec2");
  const a = e.tokens[0].children.find((x) => x.kind === "array");
  check("0x07: a vector of two floats, and 0x87 is an array of them",
    e.exact && v?.value?.[0] === -45 && v.value[1] === 45
    && a?.elemKind === "vec2" && a.count === 2 && a.values[1].join() === "3,4",
    JSON.stringify({ v: v?.value, a: a && { kind: a.elemKind, count: a.count, values: a.values } }));
}

// --- the tag table itself -------------------------------------------------

{
  check("tag table: every declared tag has a reader",
    Object.values(TAGS).every((t) => t.width !== undefined || ["string", "id", "block", "array"].includes(t.kind)));
  check("tag table: the array family is declared for each scalar type",
    [0x81, 0x85, 0x86, 0x88, 0x8c, 0x8d].every((t) => TAGS[t]?.kind === "array"));
  check("header reader is exported for library users", typeof readHeader === "function");
}

// --- the CLI --------------------------------------------------------------

function run(args) {
  return spawnSync(process.execPath, [tool, ...args], { stdio: "ignore" });
}

{
  check("info exits 0", run(["info", goodPath]).status === 0);
  check("names exits 0", run(["names", goodPath]).status === 0);
  check("guids exits 0", run(["guids", goodPath]).status === 0);
  check("tokens exits 0", run(["tokens", goodPath]).status === 0);
  check("entities exits 0", run(["entities", goodPath]).status === 0);
  check("find exits 0", run(["find", goodPath, "Kamensk"]).status === 0);
  check("verify exits 0 on a well-formed resource", run(["verify", goodPath]).status === 0);
  check("verify --lenient reports a resource with gaps and exits 0", run(["verify", join(tmp, "gap.ebin"), "--lenient"]).status === 0);
  check("verify exits 1 on a resource with gaps: strict is the default", run(["verify", join(tmp, "gap.ebin")]).status === 1);
  check("verify --strict still exits 1 on a resource with gaps", run(["verify", join(tmp, "gap.ebin"), "--strict"]).status === 1);
  check("info exits 1 on a resource with gaps (strict is the default)", run(["info", join(tmp, "gap.ebin")]).status === 1);
  check("info --lenient reports the same file and exits 0", run(["info", join(tmp, "gap.ebin"), "--lenient"]).status === 0);
  check("verify exits 0 on a resource with an opaque block (data is not a defect)", run(["verify", join(tmp, "opaque.ebin")]).status === 0);
  check("verify exits 1 on a file that is not an EBIN resource", run(["verify", join(root, "package.json")]).status === 1);
  check("an unknown command exits 1", run(["frobnicate", goodPath]).status === 1);
  check("a missing file exits 1", run(["info", join(tmp, "nope.ebin")]).status === 1);
  check("--help is a request, not a failure: exit 0", run(["--help"]).status === 0);
  check("no arguments at all is a failure: exit 1, usage on stderr", run([]).status === 1);
}

// An option the tool does not know, a missing value, or a value that is not a count used to be
// swallowed: `--filte X` silently read as no filter, `--limit abc` silently as every row, and
// `--from abc` silently as none. Each now fails with the option named, because a wrong answer that
// looks like a right one is worse than an error.
{
  function runErr(args) {
    const errPath = join(tmp, "cli.err");
    const fd = openSync(errPath, "w");
    let status;
    try {
      status = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", "ignore", fd] }).status;
    } finally { closeSync(fd); }
    return { status, err: readFileSync(errPath, "utf8") };
  }

  const bad = [
    [["entities", goodPath, "--filte", "A"], /unknown option "--filte"/],
    [["entities", goodPath, "--filter"], /--filter needs a value/],
    [["entities", goodPath, "--filter", "--json"], /--filter needs a value/],
    [["entities", goodPath, "--limit", "abc"], /--limit needs a non-negative whole number, not "abc"/],
    [["entities", goodPath, "--limit", "-1"], /--limit needs a non-negative whole number, not "-1"/],
    [["entities", goodPath, "--instances", "1.5"], /--instances needs a non-negative whole number/],
    [["tokens", goodPath, "--from", "abc"], /--from needs a non-negative whole number/],
    [["tokens", goodPath, "--limit"], /--limit needs a value/],
    [["find", goodPath], /find needs a <needle>/],
    [["worlds", goodPath, "--rdb"], /--rdb needs a value/],
    [["verify", goodPath, "--nope"], /unknown option "--nope"/],
  ];
  for (const [args, re] of bad) {
    const r = runErr(args);
    check(`argv: ${args.slice(2).join(" ") || args[0]} is refused with the option named`,
      r.status === 1 && re.test(r.err), `status ${r.status}: ${JSON.stringify(r.err.split("\n")[0])}`);
  }

  // The boundaries that are allowed stay allowed: `--limit 0` and `--from 0` mean "everything" and
  // "from the start", and `--from` past the end is an empty answer, not an error.
  check("argv: --limit 0 still means every row", spawnSync(process.execPath, [tool, "tokens", goodPath, "--limit", "0"], { stdio: "ignore" }).status === 0);
  check("argv: --from 0 is accepted", spawnSync(process.execPath, [tool, "tokens", goodPath, "--from", "0"], { stdio: "ignore" }).status === 0);
  check("argv: --from past the end is accepted and reports nothing",
    spawnSync(process.execPath, [tool, "tokens", goodPath, "--from", "99999"], { stdio: "ignore" }).status === 0);
  check("argv: a lone - is a file name, not an option",
    spawnSync(process.execPath, [tool, "info", "-"], { stdio: "ignore" }).status === 1); // no file called "-"
}

// `entities --json` and `tokens --json` print an envelope rather than a bare array, because both
// default to --limit 200: without `total` a caller cannot tell a complete resource from a
// truncated one. A bare array used to be exactly that ambiguity.
{
  /** Run the CLI with stdout+stderr in a file (sandboxes forbid piped stdio) and parse stdout. */
  function runJson(args, logName) {
    const logPath = join(tmp, logName);
    const fd = openSync(logPath, "w");
    let proc;
    try {
      proc = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", fd, fd] });
    } finally {
      closeSync(fd);
    }
    const text = readFileSync(logPath, "utf8");
    let json = null;
    try { json = JSON.parse(text); } catch { /* left null, reported below */ }
    return { proc, json, text };
  }

  const e2 = runJson(["entities", goodPath, "--json"], "entities.json");
  check("entities --json prints parseable JSON, not a bare array", e2.json !== null && !Array.isArray(e2.json),
    e2.json === null ? "stdout did not parse" : "top level is an array");
  check("entities --json carries the counts that make truncation visible",
    e2.json?.total === 1 && e2.json?.returned === 1 && e2.json?.truncated === false && e2.json?.entities?.length === 1,
    JSON.stringify(e2.json && { total: e2.json.total, returned: e2.json.returned, truncated: e2.json.truncated }));
  check("entities --json reports decode coverage next to the entities",
    e2.json?.coverage?.exact === true && e2.json?.coverage?.undecodedBytes === 0,
    JSON.stringify(e2.json?.coverage));

  const o1 = runJson(["entities", join(tmp, "opaque.ebin"), "--json"], "entities-opaque.json");
  check("entities --json reports the opaque bytes it could not read",
    o1.json?.coverage?.opaqueBlocks === 1 && o1.json?.coverage?.opaqueBytes > 0 && o1.json?.coverage?.exact === false,
    JSON.stringify(o1.json?.coverage));

  const eAll = runJson(["entities", goodPath, "--json", "--all"], "entities-all.json");
  check("entities --all is the same as --limit 0", eAll.json?.returned === 1 && eAll.json?.truncated === false);

  const t2 = runJson(["tokens", goodPath, "--json", "--limit", "3"], "tokens.json");
  check("tokens --json carries the same envelope, with `from`",
    t2.json !== null && !Array.isArray(t2.json) && t2.json.from === 0
    && t2.json.returned === 3 && t2.json.truncated === true && t2.json.tokens.length === 3
    && t2.json.total > 3,
    JSON.stringify(t2.json && { total: t2.json.total, returned: t2.json.returned }));

  // Every command that prints a table or a hit list answers `--json` with JSON. `--json` used to be
  // accepted and ignored by `names`, `guids` and `find`, which is the worst of both worlds.
  const n2 = runJson(["names", goodPath, "--json"], "names.json");
  check("names --json is JSON, in table order",
    n2.json?.total === NAMES.length && Array.isArray(n2.json?.names) && n2.json.names[6] === "coords",
    JSON.stringify(n2.json).slice(0, 160));
  const g2 = runJson(["guids", goodPath, "--json"], "guids.json");
  check("guids --json carries the table, and no path it did not look up",
    g2.json?.total === GUIDS.length && g2.json?.guids?.[0]?.guid === GUIDS[0]
    && g2.json?.guids?.[0]?.index === 0 && !("path" in g2.json.guids[0]) && g2.json.resolved === undefined,
    JSON.stringify(g2.json?.guids?.[0]));
  const f2 = runJson(["find", goodPath, "Kamensk", "--json"], "find.json");
  check("find --json is JSON, with the same hits the text form prints",
    f2.json?.total >= 2 && f2.json?.hits?.length === f2.json.total
    && f2.json.hits.some((h) => h.value === "CP_Kamensk")
    && f2.json.hits.every((h) => Number.isInteger(h.at) && Number.isInteger(h.depth) && typeof h.kind === "string"),
    JSON.stringify(f2.json).slice(0, 200));

  // A file list is always an array, whether it holds one file or ten: `lengths` used to unwrap a
  // single file, so a caller had to test the shape before reading it.
  const l1 = runJson(["lengths", goodPath, "--json"], "lengths-1.json");
  check("lengths --json is an array for one file too",
    Array.isArray(l1.json) && l1.json.length === 1 && l1.json[0].file === goodPath && l1.json[0].blocks > 0,
    JSON.stringify(l1.json).slice(0, 160));
  const l2 = runJson(["lengths", goodPath, goodPath, "--json"], "lengths-2.json");
  check("lengths --json with several files has the same shape", Array.isArray(l2.json) && l2.json.length === 2);
  const v1 = runJson(["verify", goodPath, "--json"], "verify.json");
  check("verify --json is an array too, as the skill describes", Array.isArray(v1.json) && v1.json[0].exact === true);

  // `worlds` answers "what else is this based on". The base scene is named in the GUID table and
  // referenced by the `Parent` member, so `used` is true for it — that is the fix this model bought.
  const noRdb = spawnSync(process.execPath, [tool, "worlds", goodPath], { stdio: "ignore" });
  check("worlds without --rdb refuses rather than guessing", noRdb.status === 1);

  const chain = scenes(readEbin(goodPath), new Map([[GUIDS[0], "worlds/Cain/Cain.ent"], [GUIDS[1], "Prefabs/X.et"]]));
  check("worlds: only .ent table entries are the sub-scene chain, and `used` comes from the Parent reference",
    chain.length === 1 && chain[0].guid === GUIDS[0] && chain[0].index === 0
    && chain[0].used === true && chain[0].path === "worlds/Cain/Cain.ent",
    JSON.stringify(chain));

  // --- an rdb, built here, so the annotation is tested rather than trusted --------------------
  // `readRdb` (tools/rdb.mjs) reads `[u32LE pathLen + 1][path][0x00][6 bytes][8-byte GUID
  // little-endian]`. GUIDS[1] is the entity's prefab and GUIDS[3] is a resource-valued member, so
  // both must gain a path. The u32 counts the path and its NUL, and it is what tells a record
  // apart from another table's bytes; `tools/rdb-tests.mjs` pins the layout itself.
  {
    const { readRdb, PUBLISHED_GUIDS } = await import("../tools/rdb.mjs");
    const record = (path, guid) => {
      const bytes = Buffer.from(path, "latin1");
      return Buffer.concat([u32(bytes.length + 1), bytes, Buffer.alloc(7), guidBytes(guid)]);
    };
    const writeRdb = (name, pathsAndGuids) => {
      const file = join(tmp, name);
      writeFileSync(file, Buffer.concat(pathsAndGuids.map(([path, guid]) => record(path, guid))));
      return file;
    };
    // Vanilla-shaped on purpose: `--rdb` verifies the 8 published GUIDs before it prints a path,
    // so a fixture without them is refused — which is the point of the next block.
    const rdbPath = writeRdb("synthetic.rdb", [
      ...Object.entries(PUBLISHED_GUIDS),
      ["Prefabs/Test/Thing.et", GUIDS[1]],
      ["Prefabs/Test/Spawn.et", GUIDS[3]],
    ]);
    check("rdb: a synthetic database round-trips", readRdb(rdbPath).get(GUIDS[1]) === "Prefabs/Test/Thing.et");

    const annotated = runJson(["entities", goodPath, "--json", "--rdb", rdbPath], "entities-rdb.json");
    const rec = annotated.json?.entities?.[0];
    check("entities --rdb resolves the prefab to the path only the resource database knows",
      rec?.prefab?.guid === GUIDS[1] && rec?.prefab?.path === "Prefabs/Test/Thing.et",
      JSON.stringify(rec?.prefab));
    check("entities --rdb annotates a resource-valued member with its path",
      rec?.fields?.find((f) => f.name === "m_sObjectToSpawn")?.path === "Prefabs/Test/Spawn.et",
      JSON.stringify(rec?.fields?.filter((f) => f.guid)));

    const g3 = runJson(["guids", goodPath, "--json", "--rdb", rdbPath], "guids-rdb.json");
    check("guids --json --rdb resolves what it can and says null for what it cannot",
      g3.json?.resolved === 2
      && g3.json.guids.find((g) => g.guid === GUIDS[1])?.path === "Prefabs/Test/Thing.et"
      && g3.json.guids.find((g) => g.guid === GUIDS[2])?.path === null,
      JSON.stringify(g3.json?.guids));

    // `resources` lists what actually resolves; the same fixture proves both halves.
    const res = runJson(["resources", goodPath, "--rdb", rdbPath, "--json"], "resources.json");
    check("resources: keeps what resolves, counts what names nothing",
      res.json?.[0]?.resources?.length === 2
      && res.json[0].resources.some((r) => r.path === "Prefabs/Test/Thing.et" && r.used === true)
      && res.json[0].localIds === 2 && res.json[0].tableEntries === GUIDS.length,
      JSON.stringify(res.json?.[0]));

    const noRdbResources = spawnSync(process.execPath, [tool, "resources", goodPath], { stdio: "ignore" });
    check("resources without --rdb refuses rather than guessing", noRdbResources.status === 1);

    // A member whose value is an array of resource references is the one shape that carries many
    // resources at once. It is annotated in place (text and JSON), and `--filter` looks inside it.
    const arrPath = join(tmp, "array-refs.ebin");
    writeFileSync(arrPath, buildEbin({
      names: NAMES, guids: GUIDS,
      tokens: [
        tName(2), tId("Refs"), tColon(NAMES), tResourceRef(1),
        blk(pad(),
          tNameOf(NAMES, "m_aZones"), blk(pad(), Buffer.concat([Buffer.from([0x85]), u32(2), u16(1), u16(3)])),
          tNameOf(NAMES, "m_sBaseName"), tStr("SlotAI8")),
      ],
    }));
    const arrJson = runJson(["entities", arrPath, "--rdb", rdbPath, "--json"], "entities-array-rdb.json");
    const arrField = arrJson.json?.entities?.[0]?.fields?.find((f) => f.name === "m_aZones");
    check("entities --rdb resolves an array of resource references, one path per value",
      JSON.stringify(arrField?.paths) === JSON.stringify(["Prefabs/Test/Thing.et", "Prefabs/Test/Spawn.et"])
      && arrField?.value?.length === 2,
      JSON.stringify(arrField));
    const arrText = runJson(["entities", arrPath, "--rdb", rdbPath], "entities-array.txt");
    const arrLine = arrText.text.split("\n").find((l) => l.includes("m_aZones")) ?? "";
    check("entities --rdb prints the resolved path inside the array too",
      arrLine.includes("Prefabs/Test/Thing.et") && arrLine.includes("Prefabs/Test/Spawn.et"), arrLine);

    const noRdbArr = runJson(["entities", arrPath, "--json"], "entities-array-nordb.json");
    const noRdbField = noRdbArr.json?.entities?.[0]?.fields?.find((f) => f.name === "m_aZones");
    check("without --rdb the array keeps its GUIDs and gains no paths",
      noRdbField?.value?.length === 2 && noRdbField.paths === undefined, JSON.stringify(noRdbField));

    const byString = runJson(["entities", arrPath, "--filter", "SlotAI8", "--json"], "entities-filter-string.json");
    check("--filter finds a value inside an array of strings", byString.json?.total === 1,
      JSON.stringify({ total: byString.json?.total }));
    const byPath = runJson(["entities", arrPath, "--filter", "Test/Spawn\\.et", "--json", "--rdb", rdbPath], "entities-filter-path.json");
    check("--filter finds a resource resolved inside an array", byPath.json?.total === 1,
      JSON.stringify({ total: byPath.json?.total }));

    // --- `--rdb` verifies the database before resolving anything ------------------------------
    // Same guard as `node tools/rdb.mjs verify`: the 8 published GUIDs are what proves the record
    // layout, so a database that does not reproduce them is refused rather than read. `--no-verify`
    // is the deliberate exception for a database that is known not to be the vanilla one.
    const plain = writeRdb("plain.rdb", [
      ["Prefabs/Test/Thing.et", GUIDS[1]],
      ["Prefabs/Test/Spawn.et", GUIDS[3]],
    ]);
    const wrongLayout = writeRdb("wrong-layout.rdb", [
      ...Object.entries(PUBLISHED_GUIDS).filter(([path]) => path !== "Missions/23_Campaign.conf"),
      ["Missions/23_Campaign.conf", "0000000000000001"],
      ["Prefabs/Test/Thing.et", GUIDS[1]],
      ["Prefabs/Test/Spawn.et", GUIDS[3]],
    ]);
    function runStderr(args, name) {
      const errPath = join(tmp, name);
      const fd = openSync(errPath, "w");
      let proc;
      try {
        proc = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", "ignore", fd] });
      } finally { closeSync(fd); }
      return { status: proc.status, stderr: readFileSync(errPath, "utf8") };
    }

    const refused = runStderr(["entities", goodPath, "--rdb", plain], "rdb-plain.err");
    check("--rdb refuses a database without the published GUIDs, before printing a path",
      refused.status === 1 && /carries none of the 8 published vanilla GUIDs/.test(refused.stderr)
      && /--no-verify/.test(refused.stderr),
      JSON.stringify(refused.stderr.slice(0, 240)));
    check("--no-verify reads that database anyway, and annotates from it",
      runJson(["entities", goodPath, "--rdb", plain, "--no-verify", "--json"], "rdb-plain-nv.json")
        .json?.entities?.[0]?.prefab?.path === "Prefabs/Test/Thing.et");

    const mismatch = runStderr(["entities", goodPath, "--rdb", wrongLayout], "rdb-wrong.err");
    check("--rdb names the published path whose GUID changed when the layout contradicts itself",
      mismatch.status === 1 && /record layout does not match/.test(mismatch.stderr)
      && /Missions\/23_Campaign\.conf/.test(mismatch.stderr)
      && /0000000000000001/.test(mismatch.stderr),
      JSON.stringify(mismatch.stderr.slice(0, 240)));
    check("a database that verifies needs no flag",
      run(["guids", goodPath, "--rdb", rdbPath]).status === 0);
  }
}

// --- the rdb lookup, when a resourceDatabase.rdb is around -----------------

{
  const rdb = "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger/addons/data/resourceDatabase.rdb";
  if (existsSync(rdb)) {
    const { readRdb } = await import("../tools/rdb.mjs");
    const map = readRdb(rdb);
    check("rdb: the known world GUID resolves to its path",
      map.get("9DF143A76F5C6460") === "worlds/MP/CTI_Campaign_Eden.ent",
      map.get("9DF143A76F5C6460") ?? "not found");
  } else {
    console.log("SKIP  rdb lookup (no installed resourceDatabase.rdb)");
  }
}

rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} EBIN TEST(S) FAILED`); process.exit(1); }
console.log("\nALL EBIN TESTS PASSED");
