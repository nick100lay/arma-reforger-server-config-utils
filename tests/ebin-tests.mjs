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
//   * tag 0x02 as an eight-byte value that is kept as hex rather than read as a number.
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
  "SCR_DebriefingScreen", "m_aZones"];
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
  check("0x02: eight bytes, kept as raw hex so nothing reads it as a number",
    t && t.value === "0304000000000800" && t.raw === true && e.exact,
    JSON.stringify(t && { value: t.value, raw: t.raw }));
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

// --- an opaque block is reported, not interpreted -------------------------

{
  // The shape of a real BSP blob: two empty bytes then text that is not a token stream.
  const blob = Buffer.concat([tEmpty(), tEmpty(), Buffer.from("164 1 23 1 64 0 0 2 33 2 0 3 18 0", "latin1")]);
  const path = join(tmp, "opaque.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [blk(tName(12), blk(blob), tName(6), tVec3(1, 2, 3))],
  }));
  const e = readEbin(path);
  const outer = e.tokens[0];
  const inner = outer.children[1];
  check("opaque: a block whose content is not a token stream is marked, not guessed at",
    inner.kind === "block" && inner.opaque === true && inner.children === undefined,
    JSON.stringify({ opaque: inner.opaque, children: inner.children?.length }));
  check("opaque: its bytes are counted as undecoded, so coverage cannot be overstated",
    e.opaqueBlocks === 1 && e.gapBytes === blob.length && e.exact === false,
    JSON.stringify({ opaqueBlocks: e.opaqueBlocks, gapBytes: e.gapBytes, exact: e.exact }));
  check("opaque: the records after it are still decoded",
    outer.children.at(-1).kind === "vec3" && outer.children.at(-1).value[0] === 1);
}

// --- an unknown tag is a reported gap, not a wrong token ------------------

{
  const withGap = buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [...tokens, Buffer.from([0x99, 0x01, 0x02, 0x03]), tName(0), tId("AfterTheGap")],
  });
  const path = join(tmp, "gap.ebin");
  writeFileSync(path, withGap);
  const e = readEbin(path);
  check("unknown tag: recorded as a gap with its byte range",
    e.gaps.length === 1 && e.gaps[0].bytes === 4 && e.gaps[0].reason.includes("0x99"),
    JSON.stringify(e.gaps));
  check("unknown tag: the stream resynchronises on the next record and decodes past it",
    e.tokens.some((t) => t.kind === "id" && t.value === "AfterTheGap") && !e.exact);
  let threw = null;
  try { readEbin(path, { strict: true }); } catch (err) { threw = err; }
  check("unknown tag: --strict refuses instead of guessing",
    threw !== null && /0x99/.test(threw.message), threw ? threw.message : "no error");
  check("unknown tag: --strict does not throw for an opaque block (that is data, not a defect)",
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

// --- nesting is the block nesting -----------------------------------------

{
  const path = join(tmp, "nested.ebin");
  writeFileSync(path, buildEbin({
    names: NAMES, guids: GUIDS,
    tokens: [
      // an area containing a task containing a slot
      tName(2), tId("Area_A"), tColon(NAMES), tResourceRef(1),
      blk(pad(), tName(6), tVec3(1, 1, 1),
        blk(pad(), tName(2), tId("Task_B"), tColon(NAMES), tResourceRef(1),
          blk(pad(), tName(2), tId("Slot_C"), tColon(NAMES), tResourceRef(1),
            blk(pad(), tName(6), tVec3(3, 3, 3))))),
    ],
  }));
  const list = entities(readEbin(path));
  const ids = list.map((x) => x.id);
  check("nesting: an entity's children are the records inside its block, at depth+1",
    list.length === 3 && ids.join() === "Area_A,Task_B,Slot_C" && list.map((x) => x.depth).join() === "0,1,2",
    JSON.stringify(list.map((x) => [x.id, x.depth])));
  check("nesting: each level keeps its own transform and does not inherit its parent's",
    list[0].position[0] === 1 && list[1].position === null && list[2].position[0] === 3,
    JSON.stringify(list.map((x) => x.position)));
}

// --- groups ---------------------------------------------------------------

{
  const NAMES2 = [...NAMES, "$grp"];
  const groupPath = join(tmp, "group2.ebin");
  writeFileSync(groupPath, buildEbin({
    names: NAMES2, guids: GUIDS,
    tokens: [
      tNameOf(NAMES2, "$grp"), tName(2), tColon(NAMES2), tResourceRef(1),
      blk(pad(2),
        blk(pad(), tName(9), tStr("Pier_Michurino"), tName(6), tVec3(10, 0, 10)),
        blk(pad(), tName(9), tStr("SosnovyMys"), tName(6), tVec3(20, 0, 20)),
        blk(pad(), tName(9), tStr("Third"), tName(6), tVec3(30, 0, 30)),
      ),
    ],
  }));
  const summary = entities(readEbin(groupPath), { instances: 0 });
  check("groups: $grp <class> : <prefab> <block> is one record carrying its instance count",
    summary.length === 1 && summary[0].kind === "group" && summary[0].className === "GenericEntity"
    && summary[0].prefab?.guid === GUIDS[1] && summary[0].instances === 3 && summary[0].expanded === false,
    JSON.stringify(summary.map((x) => [x.kind, x.className, x.instances, x.expanded])));
  check("groups: an unexpanded group still reports its first member's transform",
    summary[0].position?.[0] === 10, JSON.stringify(summary[0].position));

  const expanded = entities(readEbin(groupPath), { instances: 10 });
  check("groups: --instances expands the members into records that inherit the class and prefab",
    expanded.length === 4 && expanded[0].expanded === true
    && expanded.slice(1).every((x) => x.kind === "instance" && x.className === "GenericEntity" && x.depth === 1)
    && expanded[1].fields.some((f) => f.name === "m_sBaseName" && f.value === "Pier_Michurino")
    && expanded[3].position[0] === 30,
    JSON.stringify(expanded.map((x) => [x.kind, x.depth])));
}

// --- malformed input ------------------------------------------------------

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

  const badIndex = buildEbin({ names: NAMES, guids: GUIDS, tokens: [tName(99)] });
  const p3 = join(tmp, "bad-index.ebin");
  writeFileSync(p3, badIndex);
  const e3 = readEbin(p3);
  check("a name index outside the table is a gap, not a value",
    e3.tokens.length === 0 && e3.gaps.length === 1, JSON.stringify(e3.tokens));

  const badGuid = buildEbin({ names: NAMES, guids: GUIDS, tokens: [tGuidRef(9)] });
  const p4 = join(tmp, "bad-guid.ebin");
  writeFileSync(p4, badGuid);
  const e4 = readEbin(p4);
  check("a GUID index outside the table is a gap", e4.gaps.length === 1 && e4.gaps[0].reason.includes("GUID"));

  const shortBlock = buildEbin({ names: NAMES, guids: GUIDS, tokens: [Buffer.from([0x0e, 0xff, 0x00, 0x00])] });
  const p5 = join(tmp, "short-block.ebin");
  writeFileSync(p5, shortBlock);
  const e5 = readEbin(p5);
  check("a block claiming more bytes than its scope holds is a gap, not a truncated object",
    e5.tokens.length === 0 && e5.gaps.length === 1, JSON.stringify(e5.gaps));
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
  check("verify exits 0 on a resource with gaps (gaps are reported, not fatal)", run(["verify", join(tmp, "gap.ebin")]).status === 0);
  check("verify --strict exits 1 on a resource with gaps", run(["verify", join(tmp, "gap.ebin"), "--strict"]).status === 1);
  check("verify exits 0 on a resource with an opaque block (data is not a defect)", run(["verify", join(tmp, "opaque.ebin")]).status === 0);
  check("verify exits 1 on a file that is not an EBIN resource", run(["verify", join(root, "package.json")]).status === 1);
  check("an unknown command exits 1", run(["frobnicate", goodPath]).status === 1);
  check("a missing file exits 1", run(["info", join(tmp, "nope.ebin")]).status === 1);
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
  // `readRdb` reads `<path> 0x00 <6 bytes> <8-byte GUID little-endian>`. GUIDS[1] is the entity's
  // prefab and GUIDS[3] is a resource-valued member, so both must gain a path. Each record is
  // preceded by a non-printable byte, as a real database's records are: the scanner walks back
  // over printable bytes to find the path, so two records back to back would run together.
  {
    const record = (path, guid) => Buffer.concat([Buffer.from(path, "latin1"), Buffer.alloc(7), guidBytes(guid)]);
    const rdbPath = join(tmp, "synthetic.rdb");
    writeFileSync(rdbPath, Buffer.concat([
      Buffer.from([0x00]), record("Prefabs/Test/Thing.et", GUIDS[1]),
      Buffer.from([0x00]), record("Prefabs/Test/Spawn.et", GUIDS[3]),
      Buffer.alloc(64),
    ]));
    const { readRdb } = await import("../tools/ebin.mjs");
    check("rdb: a synthetic database round-trips", readRdb(rdbPath).get(GUIDS[1]) === "Prefabs/Test/Thing.et");

    const annotated = runJson(["entities", goodPath, "--json", "--rdb", rdbPath], "entities-rdb.json");
    const rec = annotated.json?.entities?.[0];
    check("entities --rdb resolves the prefab to the path only the resource database knows",
      rec?.prefab?.guid === GUIDS[1] && rec?.prefab?.path === "Prefabs/Test/Thing.et",
      JSON.stringify(rec?.prefab));
    check("entities --rdb annotates a resource-valued member with its path",
      rec?.fields?.find((f) => f.name === "m_sObjectToSpawn")?.path === "Prefabs/Test/Spawn.et",
      JSON.stringify(rec?.fields?.filter((f) => f.guid)));

    // `resources` lists what actually resolves; the same fixture proves both halves.
    const res = runJson(["resources", goodPath, "--rdb", rdbPath, "--json"], "resources.json");
    check("resources: keeps what resolves, counts what names nothing",
      res.json?.[0]?.resources?.length === 2
      && res.json[0].resources.some((r) => r.path === "Prefabs/Test/Thing.et" && r.used === true)
      && res.json[0].localIds === 2 && res.json[0].tableEntries === GUIDS.length,
      JSON.stringify(res.json?.[0]));

    const noRdbResources = spawnSync(process.execPath, [tool, "resources", goodPath], { stdio: "ignore" });
    check("resources without --rdb refuses rather than guessing", noRdbResources.status === 1);
  }
}

// --- the rdb lookup, when a resourceDatabase.rdb is around -----------------

{
  const rdb = "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger/addons/data/resourceDatabase.rdb";
  if (existsSync(rdb)) {
    const { readRdb } = await import("../tools/ebin.mjs");
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
