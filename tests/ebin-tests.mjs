// Test suite for tools/ebin.mjs (the Enfusion binary resource reader).
//
//   node tests/ebin-tests.mjs
//
// The fixture is written here byte by byte, so the suite pins the container layout and the
// token tag table themselves rather than a captured resource: game resources are ~2 GB of
// archives and cannot be committed. Every value below is checked against the reader, and the
// deliberately unknown tag is checked to produce a reported gap rather than a wrong token.
//
// The CLI is exercised as a real child process with stdio ignored and results written to
// files, so it keeps working in sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readEbin, entities, readHeader, TAGS } from "../tools/ebin.mjs";

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
const tId = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([Buffer.from([0x43]), u16(b.length), b]); };
const tStr = (s) => { const b = Buffer.from(s, "utf8"); return Buffer.concat([Buffer.from([0x0c]), u16(b.length), b]); };
const tVec3 = (x, y, z) => Buffer.concat([Buffer.from([0x08]), f32(x), f32(y), f32(z)]);
const tVec4 = (a, b, c, d) => Buffer.concat([Buffer.from([0x09]), f32(a), f32(b), f32(c), f32(d)]);
const tF32 = (v) => Buffer.concat([Buffer.from([0x06]), f32(v)]);
const tI32 = (v) => Buffer.concat([Buffer.from([0x01]), i32(v)]);
const tU16 = (v) => Buffer.concat([Buffer.from([0x05]), u16(v)]);
const tU8 = (v) => Buffer.concat([Buffer.from([0x0b, v])]);
const tEmpty = () => Buffer.from([0x00]);
const tGuidRef = (i) => Buffer.concat([Buffer.from([0x45]), u16(i)]);
const tGuidInline = (hex) => Buffer.concat([Buffer.from([0x44]), guidBytes(hex)]);
const tInt = (v) => Buffer.concat([Buffer.from([0x0e]), u16(v)]);

const NAMES = ["SubScene", "Parent", "GenericEntity", ":", "components", "RigidBody", "coords", "angles", "m_fHealth",
  "m_sBaseName", "m_sBaseNameUpper"];
const GUIDS = ["1EA95DAE3230BEB0", "622086ACB9D1E3B2"];

const tokens = [
  tName(0), tInt(13), tEmpty(), tEmpty(), tEmpty(),
  tName(1), tU16(0),
  tName(2), tId("CP_Kamensk"),
  tName(3), tU16(1), tInt(23),
  // a nested object's vectors come first, then the entity's own name block and transform
  tName(6), tVec3(1, 2, 3),
  tName(9), tStr("#AR-Campaign_MapLocation_Cain_Kamensk"),
  tName(10), tStr("#AR-Campaign_MapLocation_Cain_Kamensk-UC"),
  tName(6), tVec3(11866.5, 8.292, 10679.665),
  tName(7), tVec3(0, -15.205, 0),
  tName(4), tName(5), tGuidRef(1),
  tGuidInline("AABBCCDDEEFF0011"),
  tName(8), tF32(75.5),
  tVec4(1, 0, 0, 1),
  tU8(7), tI32(-42), tStr("Terrain"),
];
const good = buildEbin({ names: NAMES, guids: GUIDS, tokens });

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
const goodPath = join(tmp, "good.ebin");
writeFileSync(goodPath, good);

// --- the library -----------------------------------------------------------

{
  const e = readEbin(goodPath);
  check("container: version, names and guids", e.header.version === 1 && e.header.names.length === NAMES.length && e.header.guids.length === 2);
  check("container: names decoded in order", e.header.names[6] === "coords" && e.header.guids[0] === GUIDS[0]);
  check("stream: no gaps in a well-formed resource", e.exact && e.gapBytes === 0, JSON.stringify(e.gaps));
  check("stream: every token decoded", e.tokenCount === tokens.length, `${e.tokenCount} vs ${tokens.length}`);

  const byKind = (k) => e.tokens.filter((t) => t.kind === k);
  const near = (a, b) => Math.abs(a - b) < 1e-3;
  const vec3s = byKind("vec3");
  check("vector: coords decoded as three floats, nested and own",
    vec3s.length === 3
    && vec3s[0].value.join() === "1,2,3"
    && near(vec3s[1].value[0], 11866.5) && near(vec3s[1].value[2], 10679.665)
    && near(vec3s[2].value[1], -15.205),
    JSON.stringify(vec3s.map((t) => t.value)));
  check("vector: vec4 decoded", byKind("vec4")[0].value.join() === "1,0,0,1");
  check("scalars: i32, f32, u16, u8 and the int tag",
    byKind("i32")[0].value === -42 && byKind("f32")[0].value === 75.5 && byKind("u16")[0].value === 0
    && byKind("u8")[0].value === 7 && byKind("int")[0].value === 13);
  check("strings: id and value strings told apart by tag",
    e.tokens.find((t) => t.tag === 0x43).value === "CP_Kamensk"
    && e.tokens.some((t) => t.tag === 0x0c && t.value === "Terrain")
    && e.tokens.some((t) => t.tag === 0x0c && t.value.startsWith("#AR-Campaign")));
  check("guids: table reference resolves, inline guid is read", byKind("guid").length === 2
    && byKind("guid")[0].value === GUIDS[1] && byKind("guid")[1].value === "AABBCCDDEEFF0011");
  check("name tags resolve through the table", byKind("name").find((t) => t.value === "m_fHealth") !== undefined);

  const list = entities(e);
  const record = list.find((x) => x.className === "GenericEntity");
  check("entities: records are grouped by class, the id belongs to the entity",
    list.map((x) => x.className).join() === "SubScene,GenericEntity" && record?.id === "CP_Kamensk",
    JSON.stringify(list.map((x) => x.className)));
  check("entities: fields carry their values",
    record.fields.some((f) => f.name === "coords" && f.value[0] === 11866.5)
    && record.fields.some((f) => f.name === "m_fHealth" && f.value === 75.5));
  check("entities: component class and guid reference are collected",
    record.componentClasses.length === 1 && record.componentClasses[0] === "RigidBody"
    && record.refs.includes(GUIDS[1]), JSON.stringify(record.componentClasses));
  check("entities: the entity's own position, not the nested object's",
    near(record.position[0], 11866.5) && near(record.position[2], 10679.665)
    && near(record.angle[1], -15.205), JSON.stringify([record.position, record.angle]));
  check("entities: the nested object's vector is still in the field list",
    record.fields.filter((f) => f.name === "coords").length === 2);
}

// --- an unknown tag is a reported gap, not a wrong token -------------------

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
  check("unknown tag: the stream resynchronises and decodes past it",
    e.tokens.some((t) => t.kind === "string" && t.value === "AfterTheGap") && !e.exact);
  let threw = null;
  try { readEbin(path, { strict: true }); } catch (err) { threw = err; }
  check("unknown tag: --strict refuses instead of guessing",
    threw !== null && /0x99/.test(threw.message), threw ? threw.message : "no error");
}

// --- malformed input -------------------------------------------------------

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
}

// --- the tag table itself --------------------------------------------------

{
  check("tag table: every declared tag has a reader",
    Object.values(TAGS).every((t) => t.width !== undefined || t.kind === "string"));
  check("header reader is exported for library users", typeof readHeader === "function");
}

// --- the CLI ---------------------------------------------------------------

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
  check("verify exits 1 on a file that is not an EBIN resource", run(["verify", join(root, "package.json")]).status === 1);
  check("an unknown command exits 1", run(["frobnicate", goodPath]).status === 1);
  check("a missing file exits 1", run(["info", join(tmp, "nope.ebin")]).status === 1);
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

