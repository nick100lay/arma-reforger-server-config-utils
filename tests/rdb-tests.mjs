// Test suite for tools/rdb.mjs — the reader for resourceDatabase.rdb.
//
//   node tests/rdb-tests.mjs
//
// The fixtures are built here byte by byte, so the suite pins the container, the header, the root
// record and the record layout themselves rather than a captured database: the real file is
// ~11 MB and is not part of this repository.
//
// What is pinned, and why each one is worth a test:
//   * the container prologue `FORM | u32BE size-8 | RDBC | u32LE version | u32LE size`;
//   * the header: flags, a name table, and a record count that includes the root — the count is
//     what turns "a chain of records that happens to reach EOF" into a checked parse;
//   * the root record (empty path, kind 5, zero GUID) and the records after it, back to back;
//   * the record `[u32LE pathLen + 1][path][0x00][u32 kind][u16 flags][GUID 8]` plus its optional
//     8-byte `[mtime, type]` metadata, which is present exactly when the bytes after a record are
//     not another record;
//   * the four base kinds (4 script, 5 directory, 6 file, 7 group) and the flag bits measured on
//     the installed copies (0x10 = not shipped in this build, 0x10000 on vegetation prefabs);
//   * the printable path range: spaces, `@ ! # ( ) +` are all real characters in the database;
//   * the two answers `verify` gives separately: `ok` is the structural check and holds for a
//     workshop database with none of the vanilla resources; `vanilla` is the 8 published pairs;
//   * the CLI as a real child process with its own stdout/stderr files, so it keeps working in
//     sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readRdb, scanRdb, reverseRdb, verifyRdb, readHeader, PUBLISHED_GUIDS, RDB_VERSION, KIND,
  combineRdb, openRdbFiles, resourceName, describeConflicts,
} from "../tools/rdb.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "rdb.mjs");
const tmp = join(root, "tests", ".tmp-rdb");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else { failures++; console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`); }
}

const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const guidBytes = (hex) => Buffer.from(hex, "hex").reverse();

mkdirSync(tmp, { recursive: true });

/**
 * One record: `u32 pathLen+1 | path | 0 | u32 kind | u16 flags | GUID 8` and, when `meta` is
 * given, `u32 mtime | u32 type`. A real mtime is ~1.7e9, which is what makes the parser able to
 * tell metadata from the next record; the fixtures use one.
 */
function entry({ path = "", kind = KIND.FILE, flags = 0, guid = "0000000000000000", meta = null }) {
  const bytes = Buffer.from(path, "latin1");
  const parts = [u32(bytes.length + 1), bytes, Buffer.from([0]), u32(kind), u16(flags), guidBytes(guid)];
  if (meta) for (const word of meta) parts.push(u32(word));
  return Buffer.concat(parts);
}

/** A database: prologue, header (flags, names, count), the root, then the entries. */
function database({ names = [], entries, version = RDB_VERSION, flags = 0, count = null, rootMeta = null, rootGuid = "0000000000000000" }) {
  // Version 5 has no name table: the field after the flags is the record count.
  const nameFields = version <= 5 ? [] : [
    u32(names.length),
    ...names.map((name) => {
      const bytes = Buffer.from(name, "utf8");
      return Buffer.concat([u32(bytes.length + 1), bytes, Buffer.from([0])]);
    }),
  ];
  const header = Buffer.concat([u32(flags), ...nameFields, u32(count ?? entries.length + 1)]);
  const body = Buffer.concat([entry({ path: "", kind: KIND.DIRECTORY, guid: rootGuid, meta: rootMeta }), ...entries]);
  const size = 20 + header.length + body.length;
  const prologue = Buffer.alloc(20);
  prologue.write("FORM", 0, "latin1");
  prologue.writeUInt32BE(size - 8, 4);
  prologue.write("RDBC", 8, "latin1");
  prologue.writeUInt32LE(version, 12);
  prologue.writeUInt32LE(size, 16);
  return Buffer.concat([prologue, header, body]);
}

const MTIME = 1777368604;

// --- a good database: the 8 published GUIDs plus every kind and path shape -------------------

const published = Object.entries(PUBLISHED_GUIDS).map(([path, guid]) => entry({ path, guid, meta: [MTIME, 343] }));
const good = database({
  names: ["test"],
  entries: [
    ...published,
    entry({ path: "anims/anm/editor_poses/poses/4_ medic.anm", guid: "7D1B1D6C659D34C3", meta: [MTIME, 12] }),
    entry({ path: "UI/Imagesets/buttons/pc_buttons@2x.edds", guid: "1111111111111111", meta: [MTIME, 1] }),
    entry({ path: "UI/layouts/HUD/VehicleInfo/VehicleHUD_Air_AGL+ASL.layout", guid: "2222222222222222", meta: [MTIME, 2] }),
    entry({ path: "Prefabs/A/Name_with!#().et", guid: "3333333333333333", meta: [MTIME, 3] }),
    entry({ path: "Assets/Helpers", kind: KIND.DIRECTORY, guid: "4444444444444444" }),
    entry({ path: "Assets/Helpers/Workspace", kind: KIND.GROUP, guid: "5555555555555555", meta: [MTIME, 5] }),
    entry({ path: "Scripts/Game/Thing.c", kind: KIND.SCRIPT }),
  ],
});
const goodPath = join(tmp, "good.rdb");
writeFileSync(goodPath, good);

// --- the container and the header ------------------------------------------------------------

{
  const db = scanRdb(goodPath);
  check("header: version, FORM length and size are read and agree",
    db.header.version === RDB_VERSION && db.header.formSize === good.length - 8
    && db.header.size === good.length && db.header.flags === 0 && db.header.names[0] === "test",
    JSON.stringify(db.header));
  check("header: the record count includes the root, and matches what was parsed",
    db.header.records === db.entries.length + 1, JSON.stringify({ header: db.header.records, parsed: db.entries.length }));
  check("header: the root is an empty path with a zero GUID",
    db.root.path === "" && db.root.guid === "0000000000000000" && (db.root.kind & 0x0f) === KIND.DIRECTORY);
  check("header: readHeader is exported and reads the prologue", readHeader(good).records === 16);

  const cases = [
    ["a file too short for a prologue", Buffer.from("FORM"), /truncated resource database/],
    ["a file that is not a FORM container", Buffer.from('{"name":"not a database","version":7}\n'), /not a resource database.*"FORM"/],
    ["a FORM file whose tag is not RDBC", (() => { const b = Buffer.from(good); b.write("PAC1", 8, "latin1"); return b; })(), /bytes 8\.\.11.*"RDBC"/],
    ["a truncated database", good.subarray(0, good.length - 20), /FORM length|header says the file/],
    ["a padded database", Buffer.concat([good, Buffer.alloc(8)]), /FORM length|header says the file/],
    ["a header count larger than the records", database({ names: [], entries: [entry({ path: "a.et", guid: "AAAAAAAAAAAAAAAA" })], count: 9 }), /header says \d+ record/],
    ["a header count smaller than the records", database({ names: [], entries: [entry({ path: "a.et", guid: "AAAAAAAAAAAAAAAA" })], count: 1 }), /header says \d+ record/],
    ["a record whose length field does not point at its own NUL", (() => {
      const last = entry({ path: "Scripts/Game/Thing.c", kind: KIND.SCRIPT }).length;
      const b = Buffer.from(good);
      b.writeUInt32LE(999999, b.length - last);
      return b;
    })(), /no record at offset|is not followed by a record/],
    ["a name that is not NUL-terminated", (() => {
      const b = database({ names: ["test"], entries: [entry({ path: "a.et", guid: "AAAAAAAAAAAAAAAA" })] });
      // prologue(20) + flags(4) + count(4) + len(4) + "test\0": replace the NUL at 35
      b[36] = 0x41;
      return b;
    })(), /not NUL-terminated/],
  ];
  for (const [what, bytes, re] of cases) {
    let err = null;
    try { scanRdb(bytes, { name: "fixture" }); } catch (e) { err = e.message; }
    check(`container: ${what} is refused`, err !== null && re.test(err), err ?? "no error");
  }
}

// --- records, kinds, metadata, GUIDs --------------------------------------------------------

{
  const db = scanRdb(goodPath);
  const byPath = new Map(db.entries.map((e) => [e.path, e]));
  check("records: every entry is read, in file order",
    db.entries.length === 15 && db.entries[0].path === "Missions/23_Campaign.conf" && db.entries.at(-1).path === "Scripts/Game/Thing.c",
    `${db.entries.length} entries`);
  check("records: a path at the very end of the file is read to its last byte",
    db.entries.at(-1).path === "Scripts/Game/Thing.c");

  check("paths: spaces and @ ! # ( ) + are accepted, because the database contains them",
    byPath.has("anims/anm/editor_poses/poses/4_ medic.anm") && byPath.has("UI/Imagesets/buttons/pc_buttons@2x.edds")
    && byPath.has("Prefabs/A/Name_with!#().et") && byPath.has("UI/layouts/HUD/VehicleInfo/VehicleHUD_Air_AGL+ASL.layout"));

  check("kinds: the low four bits are the base type, the rest is flags",
    byPath.get("Assets/Helpers").kind === KIND.DIRECTORY
    && byPath.get("Assets/Helpers/Workspace").kind === KIND.GROUP
    && byPath.get("Scripts/Game/Thing.c").kind === KIND.SCRIPT
    && byPath.get("Missions/23_Campaign.conf").kind === KIND.FILE,
    JSON.stringify([...byPath.values()].map((e) => [e.path, e.kind])));
  check("kinds: a 0x10 or 0x10000 flag keeps the base type", (0x16 & 0x0f) === KIND.FILE && (0x10006 & 0x0f) === KIND.FILE);

  check("metadata: present on files and groups, absent on directories and scripts",
    byPath.get("Missions/23_Campaign.conf").meta?.mtime === MTIME
    && byPath.get("Assets/Helpers/Workspace").meta?.type === 5
    && byPath.get("Assets/Helpers").meta === null
    && byPath.get("Scripts/Game/Thing.c").meta === null,
    JSON.stringify([...byPath.values()].map((e) => [e.path, e.meta])));
  check("metadata: the second word is exposed as the resource type", byPath.get("Missions/23_Campaign.conf").meta.type === 343);

  check("scripts: a zero GUID keeps the record but not a map entry",
    !db.map.has("0000000000000000") && db.entries.filter((e) => e.guid === "0000000000000000").length === 1);
  check("map: files, directories and groups all have a GUID entry",
    db.map.get("4444444444444444") === "Assets/Helpers" && db.map.get("5555555555555555") === "Assets/Helpers/Workspace");
  check("map: one-to-one, so nothing was dropped", db.map.size === reverseRdb(db.map).size && db.map.size === 14,
    `${db.map.size}`);
}

// --- the published GUIDs are a fixture, and verify keeps the two answers apart ----------------

{
  const db = scanRdb(goodPath);
  const result = verifyRdb(db);
  check("verify: a vanilla database is structurally ok and vanilla",
    result.ok === true && result.vanilla === true && result.contradicted.length === 0 && result.missing.length === 0,
    JSON.stringify({ ok: result.ok, vanilla: result.vanilla }));
  check("verify: every published pair is reported, matched", result.checks.every((c) => c.present && c.ok && c.found === c.expected));
  check("verify: the counts separate records with and without a GUID",
    result.records === 15 && result.withGuid === 14 && result.withoutGuid === 1,
    JSON.stringify({ r: result.records, g: result.withGuid, n: result.withoutGuid }));

  const mod = scanRdb(database({ entries: [entry({ path: "Prefabs/Mod/OnlyThing.et", guid: "ABCDEF0123456789", meta: [MTIME, 1] })] }), { name: "mod" });
  const modResult = verifyRdb(mod);
  check("verify: a workshop-shaped database is ok but not vanilla — absence is not a broken file",
    modResult.ok === true && modResult.vanilla === false && modResult.missing.length === 8,
    JSON.stringify({ ok: modResult.ok, vanilla: modResult.vanilla, missing: modResult.missing.length }));

  const wrong = verifyRdb(db, { known: { ...PUBLISHED_GUIDS, "Missions/23_Campaign.conf": "0000000000000001" } });
  check("verify: a published path with another GUID is a contradiction naming both values",
    wrong.ok === false && wrong.vanilla === false && wrong.contradicted.length === 1
    && wrong.contradicted[0].expected === "0000000000000001"
    && wrong.contradicted[0].found === "ECC61978EDCC2B5A",
    JSON.stringify(wrong.contradicted));
}

// --- duplicates are reported, not refused: the database is allowed to contain them -------------

{
  const dupes = scanRdb(database({
    entries: [
      entry({ path: "worlds/One.ent", guid: "AAAAAAAAAAAAAAAA", meta: [MTIME, 1] }),
      entry({ path: "worlds/Two.ent", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 1] }),
      entry({ path: "worlds/One.ent", guid: "CCCCCCCCCCCCCCCC", meta: [MTIME, 1] }),
      entry({ path: "worlds/Three.ent", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 1] }),
    ],
  }), { name: "dupes" });
  const result = verifyRdb(dupes, { known: { "worlds/One.ent": "AAAAAAAAAAAAAAAA" } });
  check("verify: duplicate GUIDs are reported, not called a parse failure — the database has them",
    result.ok === true && result.unique === false && result.duplicateGuids === 1 && result.duplicatePaths === 2,
    JSON.stringify({ ok: result.ok, unique: result.unique, dg: result.duplicateGuids, dp: result.duplicatePaths }));
  check("verify: the counts still add up: 4 records with a GUID, 3 unique GUIDs, 2 unique paths",
    result.records === 4 && result.withGuid === 4 && result.uniqueGuids === 3 && result.uniquePaths === 2,
    JSON.stringify({ r: result.records, g: result.uniqueGuids, p: result.uniquePaths }));
}

// --- the older formats: version 5 and 6 -----------------------------------------------------

{
  const v6 = scanRdb(database({
    version: 6,
    rootMeta: [MTIME, 0],
    entries: [
      entry({ path: "Assets", kind: KIND.DIRECTORY, guid: "AAAAAAAAAAAAAAAA", meta: [MTIME, 0] }),
      entry({ path: "Prefabs/X.et", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 343, MTIME - 10, 361] }),
    ],
  }), { name: "v6" });
  check("version 6: parsed to the end; root and directory carry one pair, a file two",
    v6.header.version === 6 && v6.header.names.length === 0 && v6.entries.length === 2
    && v6.root.meta?.words.length === 2 && v6.root.meta.mtime === MTIME
    && v6.entries[0].meta?.words.length === 2
    && v6.entries[1].meta?.words.length === 4 && v6.entries[1].meta.extra?.type === 361,
    JSON.stringify({ h: v6.header, root: v6.root.meta, e: v6.entries.map((e) => e.meta) }));

  const v5 = scanRdb(database({
    version: 5,
    names: [],
    rootGuid: "CCCCCCCCCCCCCCCC",
    rootMeta: [0],
    entries: [
      entry({ path: "Assets", kind: KIND.DIRECTORY, guid: "AAAAAAAAAAAAAAAA", meta: [0] }),
      entry({ path: "Prefabs/Y.et", guid: "BBBBBBBBBBBBBBBB", meta: [15, MTIME, 337] }),
    ],
  }), { name: "v5" });
  check("version 5: no name table, one-word metadata, three words on a file",
    v5.header.version === 5 && v5.header.names.length === 0 && v5.entries.length === 2
    && v5.root.meta?.words.length === 1 && v5.root.meta.words[0] === 0
    && v5.entries[0].meta?.words.length === 1
    && v5.entries[1].meta?.words.length === 3 && v5.entries[1].meta.mtime === undefined,
    JSON.stringify({ h: v5.header, e: v5.entries.map((e) => e.meta) }));

  let err = null;
  try { scanRdb(database({ version: 4, entries: [entry({ path: "a.et", guid: "AAAAAAAAAAAAAAAA" })] }), { name: "v4" }); } catch (e) { err = e.message; }
  check("version 4 is refused by name, not guessed at", /unsupported resource database version 4/.test(err ?? ""), err);
}

// --- the CLI ---------------------------------------------------------------------------------

/** Run the tool, keeping stdout and stderr apart (sandboxes forbid piped stdio). */
function run(args, name = "run") {
  const out = join(tmp, `${name}.out`);
  const err = join(tmp, `${name}.err`);
  const fo = openSync(out, "w");
  const fe = openSync(err, "w");
  let proc;
  try {
    proc = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", fo, fe] });
  } finally {
    closeSync(fo);
    closeSync(fe);
  }
  const stdout = readFileSync(out, "utf8");
  const stderr = readFileSync(err, "utf8");
  let json = null;
  try { json = JSON.parse(stdout); } catch { /* left null, reported where it matters */ }
  return { status: proc.status, stdout, stderr, json };
}

{
  const info = run(["info", goodPath, "--json"], "info.json");
  check("info --json describes the container, the header and the records",
    info.json?.records === 15 && info.json?.bytes === good.length
    && info.json?.header?.version === RDB_VERSION && info.json?.header?.names?.[0] === "test"
    && info.json?.header?.records === 16 && info.json?.metadata?.records === 13
    && info.json?.withGuid === 14,
    JSON.stringify(info.json).slice(0, 220));

  const text = run(["info", goodPath], "info.txt");
  check("info prints the container, the header names and the record count",
    text.status === 0 && /container\s+FORM\/RDBC version 7/.test(text.stdout)
    && /names \["test"\]/.test(text.stdout) && /records\s+15 /.test(text.stdout),
    text.stdout.slice(0, 260));

  const get = run(["get", goodPath, "ECC61978EDCC2B5A"], "get.txt");
  check("get prints the GUID and the path", get.status === 0
    && get.stdout.trim() === "{ECC61978EDCC2B5A}  Missions/23_Campaign.conf", JSON.stringify(get.stdout));
  check("get takes a GUID in braces and in any case",
    run(["get", goodPath, "{ecc61978edcc2b5a}"], "get-braces.txt").stdout.trim() === "{ECC61978EDCC2B5A}  Missions/23_Campaign.conf");
  check("get resolves a directory GUID, which the database names like any other",
    run(["get", goodPath, "4444444444444444"], "get-dir.txt").stdout.trim() === "{4444444444444444}  Assets/Helpers");
  const scriptGuidMiss = run(["get", goodPath, "9999999999999999"], "get-miss.txt");
  check("get exits 1 for a GUID that names nothing",
    scriptGuidMiss.status === 1 && scriptGuidMiss.stdout === "" && /no resource with the GUID/.test(scriptGuidMiss.stderr));

  const byPath = run(["guid", goodPath, "Assets/Helpers"], "guid.txt");
  check("guid prints the GUID in front of the path",
    byPath.status === 0 && byPath.stdout.trim() === "{4444444444444444}Assets/Helpers", JSON.stringify(byPath.stdout));
  check("guid converts backslashes",
    run(["guid", goodPath, "Assets\\Helpers"], "guid-win.txt").stdout.trim() === "{4444444444444444}Assets/Helpers");
  check("guid exits 1 for a script path: a script has no GUID",
    run(["guid", goodPath, "Scripts/Game/Thing.c"], "guid-script.txt").status === 1);
  check("guid exits 1 for a path the database does not name",
    run(["guid", goodPath, "worlds/Nowhere.ent"], "guid-miss.txt").status === 1);

  const list = run(["list", goodPath], "list.txt");
  check("list prints every record with its kind",
    list.status === 0 && list.stdout.trim().split("\n").length === 15
    && /^\{ECC61978EDCC2B5A\}  file  Missions\/23_Campaign\.conf$/.test(list.stdout.split("\n")[0])
    && list.stdout.includes("{----------------}  script  Scripts/Game/Thing.c"),
    list.stdout.split("\n").slice(0, 2).join(" | "));

  const limited = run(["list", goodPath, "--limit", "2"], "list-2.txt");
  check("list --limit stops at N and says how many are left",
    limited.stdout.trim().split("\n").length === 3 && /13 more/.test(limited.stdout), limited.stdout);

  const filtered = run(["list", goodPath, "^Missions/23"], "list-re.txt");
  check("list takes a case-insensitive regex", filtered.status === 0
    && filtered.stdout.trim() === "{ECC61978EDCC2B5A}  file  Missions/23_Campaign.conf");

  const listJson = run(["list", goodPath, "--limit", "2", "--json"], "list.json");
  check("list --json is an envelope that makes truncation visible",
    listJson.json?.total === 15 && listJson.json?.returned === 2 && listJson.json?.truncated === true
    && listJson.json?.entries?.length === 2 && listJson.json?.filter === null
    && listJson.json.entries[0].kind === KIND.FILE && listJson.json.entries[0].type === "file",
    JSON.stringify(listJson.json).slice(0, 220));
  check("list --all is the same as --limit 0", run(["list", goodPath, "--all", "--json"], "list-all.json").json?.returned === 15);

  const verify = run(["verify", goodPath], "verify.txt");
  check("verify exits 0 when the structure, the mapping and the published GUIDs hold",
    verify.status === 0 && /8\/8 reproduced \(the vanilla database\)/.test(verify.stdout) && /ok/.test(verify.stdout),
    verify.stdout);
  const verifyJson = run(["verify", goodPath, "--json"], "verify.json");
  check("verify --json carries both answers and the checks",
    verifyJson.json?.ok === true && verifyJson.json?.vanilla === true
    && verifyJson.json?.checks?.length === 8 && verifyJson.json?.contradicted?.length === 0
    && verifyJson.json?.withGuid === 14 && verifyJson.json?.withoutGuid === 1,
    JSON.stringify(verifyJson.json).slice(0, 220));

  const modFile = join(tmp, "mod.rdb");
  writeFileSync(modFile, database({ entries: [entry({ path: "Prefabs/Mod/OnlyThing.et", guid: "ABCDEF0123456789", meta: [MTIME, 1] })] }));
  const modVerify = run(["verify", modFile], "verify-mod.txt");
  check("verify: a database with none of the vanilla resources is ok, and says it is not vanilla",
    modVerify.status === 0 && /not the vanilla database/.test(modVerify.stdout) && /ok/.test(modVerify.stdout),
    modVerify.stdout);

  const contradicted = join(tmp, "contradicted.rdb");
  writeFileSync(contradicted, database({
    entries: [
      ...Object.entries(PUBLISHED_GUIDS).filter(([path]) => path !== "Missions/23_Campaign.conf").map(([path, guid]) => entry({ path, guid, meta: [MTIME, 1] })),
      entry({ path: "Missions/23_Campaign.conf", guid: "0000000000000001", meta: [MTIME, 1] }),
    ],
  }));
  const contradiction = run(["verify", contradicted], "verify-contradicted.txt");
  check("verify: a published path with a different GUID refuses the database",
    contradiction.status === 1 && /contradict/.test(contradiction.stdout), contradiction.stdout);

  const truncatedPath = join(tmp, "truncated.rdb");
  writeFileSync(truncatedPath, good.subarray(0, good.length - 20));
  check("the CLI refuses a truncated database by its header",
    /FORM length|header says/.test(run(["info", truncatedPath], "truncated.txt").stderr));
  check("the CLI refuses a file that is not a resource database",
    run(["info", join(root, "package.json")], "notadb.txt").status === 1);
}

// --- mistakes are refused, not swallowed -----------------------------------------------------

{
  const bad = [
    [["get", goodPath], /get needs a <guid>/],
    [["guid", goodPath], /guid needs a <path>/],
    [["get", goodPath, "not-a-guid"], /is not a resource GUID/],
    [["get", goodPath, "12345"], /is not a resource GUID/],
    [["get", goodPath, "0000000000000000"], /is not a resource GUID/],
    [["list", goodPath, "["], /is not a valid regular expression/],
    [["list", goodPath, "--limit"], /--limit needs a value/],
    [["list", goodPath, "--limit", "abc"], /--limit needs a non-negative whole number, not "abc"/],
    [["list", goodPath, "--limit", "-1"], /--limit needs a non-negative whole number, not "-1"/],
    [["list", goodPath, "--nope"], /unknown option "--nope"/],
    [["frobnicate", goodPath], /unknown command "frobnicate"/],
  ];
  for (const [args, re] of bad) {
    const r = run(args, `bad-${args[0]}-${args.length}`);
    check(`argv: ${args.slice(1).join(" ")} is refused with the cause named`,
      r.status === 1 && re.test(r.stderr), `status ${r.status}: ${JSON.stringify(r.stderr.split("\n")[0])}`);
  }
  check("a missing file exits 1 with the path in the message", run(["info", join(tmp, "nope.rdb")], "missing").status === 1);
  check("--help is a request, not a failure: exit 0", run(["--help"], "help").status === 0);
  const none = run([], "none");
  check("no arguments at all is a failure: exit 1, usage on stderr",
    none.status === 1 && /Read resourceDatabase\.rdb/.test(none.stderr));
}

// --- more than one database: one dictionary, its provenance, aliases and conflicts ------------
// A build ships two databases (data and core) and every addon brings its own, so a GUID can be
// named by several of them. The combined dictionary keeps the database every path came from; the
// two ways two databases can carry one GUID are decided by the file name (see `tools/rdb.mjs`).

{
  const one = join(tmp, "one.rdb");
  writeFileSync(one, database({
    names: ["one"],
    entries: [
      entry({ path: "Prefabs/X/Thing.et", guid: "AAAAAAAAAAAAAAAA", meta: [MTIME, 1] }),
      entry({ path: "Configs/System/ResourceTypes/Sound.conf", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 2] }),
      entry({ path: "worlds/Cain/Cain.ent", guid: "CCCCCCCCCCCCCCCC", meta: [MTIME, 3] }),
    ],
  }));
  const two = join(tmp, "two.rdb");
  writeFileSync(two, database({
    names: ["two"],
    entries: [
      // Same GUID, same file name, different mount path: the vanilla data/core shape.
      entry({ path: "configs/ResourceTypes/Sound.conf", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 4] }),
      entry({ path: "Prefabs/Y/Other.et", guid: "DDDDDDDDDDDDDDDD", meta: [MTIME, 5] }),
    ],
  }));
  const clash = join(tmp, "clash.rdb");
  writeFileSync(clash, database({
    names: ["clash"],
    entries: [entry({ path: "Prefabs/Y/Gadget.et", guid: "AAAAAAAAAAAAAAAA", meta: [MTIME, 6] })],
  }));

  check("combineRdb: one dictionary across the databases, and each path keeps its database",
    (() => {
      const set = combineRdb([scanRdb(one), scanRdb(two)]);
      const a = set.resolve("AAAAAAAAAAAAAAAA");
      const b = set.resolve("BBBBBBBBBBBBBBBB");
      const d = set.resolve("DDDDDDDDDDDDDDDD");
      return set.size === 4 && set.count === 2 && set.multi === true
        && a.path === "Prefabs/X/Thing.et" && a.rdb === 1 && a.label === "RDB #1" && a.file === one
        && b.path === "Configs/System/ResourceTypes/Sound.conf" && b.rdb === 1
        && d.path === "Prefabs/Y/Other.et" && d.rdb === 2
        && set.resolve("EEEEEEEEEEEEEEEE") === null && set.path("EEEEEEEEEEEEEEEE") === null;
    })());

  check("combineRdb: the same file name at a different mount path is an alias, not a conflict",
    (() => {
      const set = combineRdb([scanRdb(one), scanRdb(two)]);
      return set.aliases.length === 1 && set.conflicts.length === 0
        && set.aliases[0].guid === "BBBBBBBBBBBBBBBB"
        && set.aliases[0].kept.rdb === 1 && set.aliases[0].alias.rdb === 2
        && set.aliases[0].alias.path === "configs/ResourceTypes/Sound.conf"
        && set.json().aliasedGuids === 1 && set.json().databases.length === 2;
    })());
  check("resourceName is the comparison the alias rule is made of",
    resourceName("Configs/System/X/Sound.CONF") === "sound.conf"
    && resourceName("Prefabs\\A\\Thing.et") === "thing.et" && resourceName("ui/imagesets/a.edds") === "a.edds");

  // Workbench's override: an addon re-declares the same GUID and the same path, and its fields are
  // applied over the base resource's. The order is the answer, so both records are kept as layers.
  const same = join(tmp, "same.rdb");
  writeFileSync(same, database({
    names: ["same"],
    entries: [
      entry({ path: "Prefabs/X/Thing.et", guid: "AAAAAAAAAAAAAAAA", meta: [MTIME, 7] }),
      entry({ path: "Prefabs/Y/Other.et", guid: "DDDDDDDDDDDDDDDD", meta: [MTIME, 8] }),
    ],
  }));
  check("combineRdb: one GUID, one path in two databases is an override layer, not a duplicate",
    (() => {
      const set = combineRdb([scanRdb(same), scanRdb(one)]);
      const a = set.resolve("AAAAAAAAAAAAAAAA");
      return a.path === "Prefabs/X/Thing.et" && a.rdb === 1
        && a.layers.length === 2 && a.layers[0].rdb === 1 && a.layers[1].rdb === 2
        && a.relation === "override"
        && set.shared.length === 1
        && set.aliases.length === 0 && set.conflicts.length === 0
        && set.json().overriddenGuids === 1;
    })());
  check("combineRdb: the override chain keeps the command-line order in JSON",
    (() => {
      const set = combineRdb([scanRdb(same), scanRdb(one)]);
      const layer = set.json().layers.find((l) => l.guid === "AAAAAAAAAAAAAAAA");
      return layer.relation === "override" && layer.layers[0].rdb === 1 && layer.layers[1].rdb === 2
        && layer.layers[0].path === "Prefabs/X/Thing.et";
    })());

  check("combineRdb: a different file name for one GUID is a conflict, with both paths named",
    (() => {
      const set = combineRdb([scanRdb(one), scanRdb(clash)]);
      return set.conflicts.length === 1 && set.conflicts[0].guid === "AAAAAAAAAAAAAAAA"
        && set.conflicts[0].names.length === 2
        && describeConflicts(set.conflicts).includes("Prefabs/X/Thing.et")
        && describeConflicts(set.conflicts).includes("Prefabs/Y/Gadget.et")
        && /RDB #1/.test(describeConflicts(set.conflicts)) && /RDB #2/.test(describeConflicts(set.conflicts));
    })());

  check("openRdbFiles: refuses a conflict before handing out a dictionary",
    (() => {
      try { openRdbFiles([one, clash]); return false; } catch (err) { return /resource GUID conflict/.test(err.message); }
    })());
  check("openRdbFiles: --allow-conflicts keeps the first path and exposes the conflict",
    (() => {
      const { combined } = openRdbFiles([one, clash], { allowConflicts: true });
      return combined.conflicts.length === 1
        && combined.resolve("AAAAAAAAAAAAAAAA").path === "Prefabs/X/Thing.et"
        && combined.json().conflictingGuids === 1;
    })());
  check("openRdbFiles: the same database twice is a mistake, not two indices",
    (() => {
      try { openRdbFiles([one, one]); return false; } catch (err) { return /passed twice/.test(err.message); }
    })());
  check("openRdbFiles: a clean pair combines, with no note",
    (() => {
      const { combined, notes } = openRdbFiles([one, two]);
      return combined.size === 4 && notes.length === 0;
    })());

  function runMerge(args, name) {
    const outPath = join(tmp, `${name}.out`);
    const errPath = join(tmp, `${name}.err`);
    const outFd = openSync(outPath, "w");
    const errFd = openSync(errPath, "w");
    let proc;
    try {
      proc = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", outFd, errFd] });
    } finally { closeSync(outFd); closeSync(errFd); }
    return { status: proc.status, stdout: readFileSync(outPath, "utf8"), stderr: readFileSync(errPath, "utf8") };
  }

  const merged = runMerge(["merge", one, two, "--json"], "merge-json");
  let mergedJson = null;
  try { mergedJson = JSON.parse(merged.stdout); } catch { /* reported below */ }
  check("merge --json lists the databases, the combined size and the alias",
    merged.status === 0 && mergedJson?.databases?.length === 2
    && mergedJson.databases[0].index === 1 && mergedJson.databases[0].file === one
    && mergedJson.guids === 4 && mergedJson.aliasedGuids === 1 && mergedJson.aliases?.length === 1,
    JSON.stringify(mergedJson));
  const mergedText = runMerge(["merge", one, two], "merge-text");
  check("merge prints the preamble and the alias, and exits 0",
    mergedText.status === 0 && mergedText.stdout.includes(`RDB #1  ${one}`)
    && mergedText.stdout.includes(`RDB #2  ${two}`)
    && mergedText.stdout.includes("alias") && mergedText.stdout.includes("conflict  none"),
    mergedText.stdout.slice(0, 400));
  const overMerge = runMerge(["merge", same, one], "merge-override");
  check("merge prints a same-path override as the ordered layer chain",
    overMerge.status === 0
    && /override  \{AAAAAAAAAAAAAAAA\}  RDB #1 "Prefabs\/X\/Thing\.et"  ->  RDB #2 "Prefabs\/X\/Thing\.et"/.test(overMerge.stdout)
    && /first database's fields override the later ones/.test(overMerge.stdout),
    overMerge.stdout.slice(0, 520));
  const clashRun = runMerge(["merge", one, clash], "merge-clash");
  check("merge refuses a conflict with exit 1 and the GUID",
    clashRun.status === 1 && /resource GUID conflict/.test(clashRun.stderr)
    && clashRun.stderr.includes("AAAAAAAAAAAAAAAA"),
    JSON.stringify(clashRun.stderr.slice(0, 240)));
  const allowedRun = runMerge(["merge", one, clash, "--allow-conflicts"], "merge-allowed");
  check("merge --allow-conflicts keeps the first path, lists the conflict and exits 0",
    allowedRun.status === 0 && /CONFLICT  \{AAAAAAAAAAAAAAAA\}/.test(allowedRun.stdout)
    && /Prefabs\/X\/Thing\.et/.test(allowedRun.stdout) && /Prefabs\/Y\/Gadget\.et/.test(allowedRun.stdout),
    allowedRun.stdout.slice(0, 520));
  check("merge with no database is a usage error", runMerge(["merge"], "merge-none").status === 1);
}

// --- the installed databases, and the game's own references -----------------------------------
// The client and the dedicated server ship *different* copies — 116 389 records against 116 541 on
// 1.8.0.13, with a third of the server's records flagged 0x10 — so both are read when both are
// present. When the client's archives are there, the strongest check we have is repeated: every
// `{GUID}path` pair written in the game's own text resources must agree with the database.

{
  const installs = [
    ["client", "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger/addons/data/resourceDatabase.rdb"],
    ["server", "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger Server/addons/data/resourceDatabase.rdb"],
  ];
  let seen = 0;
  for (const [label, installed] of installs) {
    if (!existsSync(installed)) continue;
    seen++;
    const db = scanRdb(installed);
    check(`installed (${label}): the header is version 7, names its build and counts its records`,
      db.header.version === RDB_VERSION && db.header.names.length >= 1
      && db.header.records === db.entries.length + 1 && db.header.size === db.bytes,
      JSON.stringify({ header: db.header, records: db.entries.length }));
    check(`installed (${label}): the map is large and one-to-one`,
      db.map.size > 100000 && db.map.size === reverseRdb(db.map).size,
      `${db.entries.length} records, ${db.map.size} GUIDs`);
    check(`installed (${label}): the known world GUID resolves to its path`,
      db.map.get("9DF143A76F5C6460") === "worlds/MP/CTI_Campaign_Eden.ent",
      db.map.get("9DF143A76F5C6460") ?? "not found");
    check(`installed (${label}): a path with a space and a path with @ both resolve`,
      db.map.get("7D1B1D6C659D34C3") === "anims/anm/editor_poses/poses/4_ medic.anm",
      db.map.get("7D1B1D6C659D34C3") ?? "not found");
    check(`installed (${label}): every record has a kind the four base types explain`,
      db.entries.every((e) => (e.kind & 0x0f) >= 4 && (e.kind & 0x0f) <= 7 && (e.kind & ~0x00010fff) === 0),
      JSON.stringify([...db.kinds]));
    check(`installed (${label}): scripts are the records without a GUID`,
      db.entries.every((e) => (e.guid === "0000000000000000") === ((e.kind & 0x0f) === KIND.SCRIPT)));
    const result = verifyRdb(db);
    check(`installed (${label}): verify is ok, vanilla and one-to-one`,
      result.ok === true && result.vanilla === true && result.unique === true,
      JSON.stringify({ ok: result.ok, vanilla: result.vanilla }));
  }
  if (!seen) console.log("SKIP  installed database (no installed resourceDatabase.rdb)");

  // The game's own references, checked against the map. This is the evidence the parsing does not
  // rest on the 8 published GUIDs: ~130 000 independent (GUID, path) pairs written by the game.
  const paks = "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger/addons/data/data007.pak";
  const rdb = "C:/Program Files (x86)/Steam/steamapps/common/Arma Reforger/addons/data/resourceDatabase.rdb";
  if (existsSync(paks) && existsSync(rdb)) {
    const { openPak, normalisePath } = await import("../tools/pak.mjs");
    const db = scanRdb(rdb);
    const byPath = reverseRdb(db.map);
    const pak = openPak(paks);
    const TEXT = /\.(et|conf|imageset|emat|acp|sig|layout|gproj|ent)$/i;
    const RE = /"\{([0-9A-Fa-f]{16})\}([^"]+)"/g;
    let refs = 0, exact = 0;
    const contradicting = [];
    for (const e of pak.entries) {
      const p = normalisePath(e.path);
      if (!TEXT.test(p)) continue;
      let text;
      try { text = pak.read(e).toString("utf8"); } catch { continue; }
      for (const m of text.matchAll(RE)) {
        refs++;
        const guid = m[1].toUpperCase();
        const ref = normalisePath(m[2].replace(/^\.?\//, ""));
        if (db.map.get(guid) === ref || byPath.get(ref) === guid) { exact++; continue; }
        contradicting.push(`${p}: {${guid}} ${ref}`);
      }
    }
    pak.close();
    check("references: every {GUID}path in the game's text resources agrees with the database",
      refs > 100000 && exact > refs - 120 && contradicting.length < 120,
      `${exact}/${refs} exact, ${contradicting.length} contradicting; e.g. ${contradicting.slice(0, 3).join(" | ")}`);
  } else {
    console.log("SKIP  reference check (no installed client archives)");
  }
}

rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} RDB TEST(S) FAILED`); process.exit(1); }
console.log("\nALL RDB TESTS PASSED");
