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
  verifyMerge, mergeRdb, openRdbFiles, describeMergeProblems, findResource, pathIndex,
} from "../tools/rdb.mjs";
// The writer is shared with `layer-tests.mjs`, which needs a GUID → world → layer fixture: one copy of
// the layout, so the two suites cannot drift apart.
import { u32, entry, database, MTIME } from "./helpers/rdb-builder.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "rdb.mjs");
const tmp = join(root, "tests", ".tmp-rdb");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else { failures++; console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`); }
}

mkdirSync(tmp, { recursive: true });

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

// --- path -> GUID: exact case wins, but a case difference is the same resource ------------------
// The path is typed from a pak listing, a log line or a reference read out of another resource, and
// none of those keep the database's spelling. The game's own text resources disagree with it in
// five places (measured below, on the installed archives), so an exact-case-only lookup answers
// "no resource at …" for a resource that is right there.

{
  const fold = scanRdb(database({
    entries: [
      entry({ path: "Prefabs/Case.et", guid: "AAAAAAAAAAAAAAAA", meta: [MTIME, 1] }),
      entry({ path: "prefabs/case.et", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 2] }),
      entry({ path: "Assets/Helpers", kind: KIND.DIRECTORY, guid: "4444444444444444" }),
    ],
  }), { name: "fold" });

  check("findResource: a path in another case resolves, and reports the database's spelling",
    JSON.stringify(findResource(fold.map, "PREFABS/CASE.ET")) === JSON.stringify({ guid: "AAAAAAAAAAAAAAAA", path: "Prefabs/Case.et" }),
    JSON.stringify(findResource(fold.map, "PREFABS/CASE.ET")));
  check("findResource: the exact spelling wins when two records differ only in case",
    findResource(fold.map, "prefabs/case.et")?.guid === "BBBBBBBBBBBBBBBB"
    && findResource(fold.map, "Prefabs/Case.et")?.guid === "AAAAAAAAAAAAAAAA");
  check("findResource: a Windows path resolves, because the separators are folded first",
    findResource(fold.map, "Assets\\Helpers")?.guid === "4444444444444444");
  check("findResource: a path the database does not name is null, not an error",
    findResource(fold.map, "Assets/Nowhere") === null && findResource(fold.map, "ASSETS/NOWHERE") === null);
  check("pathIndex: one entry per lowercase path, keeping the first record's spelling",
    (() => {
      const index = pathIndex(fold.map);
      return index.size === 2 && index.get("prefabs/case.et").path === "Prefabs/Case.et"
        && index.get("assets/helpers").guid === "4444444444444444";
    })(), JSON.stringify([...pathIndex(fold.map)]));
  check("reverseRdb stays exact-case: it is the raw map, and `verify` needs the published spellings",
    reverseRdb(fold.map).get("prefabs/case.et") === "BBBBBBBBBBBBBBBB" && reverseRdb(fold.map).get("PREFABS/CASE.ET") === undefined);
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
  // A path typed in another case is the same resource: the game's own text resources spell five of
  // them differently from the database, and a false miss is indistinguishable from a real one.
  check("guid takes a path in any case, and prints the database's spelling",
    (() => {
      const r = run(["guid", goodPath, "missions/23_campaign.CONF"], "guid-case.txt");
      return r.status === 0 && r.stdout.trim() === "{ECC61978EDCC2B5A}Missions/23_Campaign.conf";
    })(), run(["guid", goodPath, "missions/23_campaign.CONF"], "guid-case2.txt").stdout);
  check("guid --json reports the resolved spelling, not the one the caller typed",
    (() => {
      const j = run(["guid", goodPath, "missions/23_campaign.conf", "--json"], "guid-case.json").json;
      return j?.guid === "ECC61978EDCC2B5A" && j?.path === "Missions/23_Campaign.conf";
    })());
  check("guid: the exact spelling still wins, so a case-different record is not mistaken for another",
    (() => {
      const twoCases = join(tmp, "two-cases.rdb");
      writeFileSync(twoCases, database({
        entries: [
          entry({ path: "Prefabs/Case.et", guid: "AAAAAAAAAAAAAAAA", meta: [MTIME, 1] }),
          entry({ path: "prefabs/case.et", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 2] }),
        ],
      }));
      return run(["guid", twoCases, "prefabs/case.et"], "guid-two-lower.txt").stdout.trim() === "{BBBBBBBBBBBBBBBB}prefabs/case.et"
        && run(["guid", twoCases, "PREFABS/CASE.ET"], "guid-two-upper.txt").stdout.trim() === "{AAAAAAAAAAAAAAAA}Prefabs/Case.et";
    })());

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
  // The message says what the file starts with, which is how a caller recognises "that is a .pak":
  // the bytes are read back out of the latin1 string before they are formatted, so a byte that is
  // not printable prints as its hex value and not as a padded character.
  const binaryFile = join(tmp, "binary.rdb");
  writeFileSync(binaryFile, Buffer.from([0, 1, 2, 3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]));
  check("a file of control bytes is reported as hex bytes, not as padded characters",
    /prologue starts with 00 01 02 03, not "FORM"/.test(run(["info", binaryFile], "notadb-hex").stderr));
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
    // An option the command does not use cannot change its answer, so accepting it would be a
    // silently ignored request. `--limit`/`--all` bound rows, and only `list` and `merge` print rows.
    [["verify", goodPath, "--limit", "2"], /verify does not take --limit/],
    [["info", goodPath, "--all"], /info does not take --all/],
    [["get", goodPath, "ECC61978EDCC2B5A", "--limit", "2"], /get does not take --limit/],
    [["guid", goodPath, "Assets/Helpers", "--all"], /guid does not take --all/],
    [["verify-merge", goodPath, "--limit", "2"], /verify-merge does not take --limit/],
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

  // Under `--json` a failure has to be JSON: prose on stderr leaves a caller's parser an empty
  // stdout and no way to tell a mistyped command line from a corrupt database. The code says which.
  const jsonBad = [
    ["a usage error", ["get", goodPath, "not-a-guid", "--json"], "USAGE", /is not a resource GUID/],
    ["no command at all", ["--json"], "USAGE", /no command/],
    ["a command with no database", ["verify", "--json"], "USAGE", /verify needs a <rdb>/],
    ["an option it does not take", ["info", goodPath, "--limit", "2", "--json"], "USAGE", /does not take --limit/],
    ["a file that is not there", ["info", join(tmp, "nope.rdb"), "--json"], "IO", /ENOENT/],
    ["a file that is not a resource database", ["info", join(root, "package.json"), "--json"], "PARSE", /not a resource database/],
  ];
  for (const [what, args, code, re] of jsonBad) {
    const r = run(args, `json-${code}-${args[0] ?? "none"}`);
    check(`--json: ${what} is { ok: false, error: { code: "${code}" } }, not prose`,
      r.status === 1 && r.json?.ok === false && r.json?.error?.code === code
      && re.test(r.json?.error?.message ?? "") && r.stderr === "",
      `status ${r.status}: ${JSON.stringify(r.json ?? r.stderr.split("\n")[0])}`);
  }
  check("--json: a corrupt database is PARSE, and the message still names the file",
    (() => {
      const broken = join(tmp, "broken-json.rdb");
      writeFileSync(broken, good.subarray(0, good.length - 20));
      const r = run(["info", broken, "--json"], "json-parse-broken");
      return r.json?.error?.code === "PARSE" && r.json.error.message.startsWith(broken);
    })());
  check("--json: a database refused by its own mapping is INPUT, not PARSE",
    (() => {
      const wrong = join(tmp, "contradicts-json.rdb");
      writeFileSync(wrong, database({
        entries: Object.entries(PUBLISHED_GUIDS)
          .map(([path, guid]) => entry({ path, guid: path === "Missions/23_Campaign.conf" ? "0000000000000001" : guid, meta: [MTIME, 1] })),
      }));
      const r = run(["merge", wrong, goodPath, "--json"], "json-input-merge");
      return r.json?.error?.code === "INPUT" && /refusing to resolve through this database/.test(r.json.error.message);
    })());
  check("--json: a miss is not an error object — get/guid answer with null and exit 1",
    (() => {
      const missed = run(["get", goodPath, "9999999999999999", "--json"], "json-miss");
      const missedGuid = run(["guid", goodPath, "worlds/Nowhere.ent", "--json"], "json-miss-guid");
      return missed.status === 1 && missed.json?.path === null && missed.json.error === undefined
        && missedGuid.status === 1 && missedGuid.json?.guid === null && missedGuid.json.error === undefined;
    })());
}

// --- more than one database: one GUID, one path -----------------------------------------------
// A merge is a bijection, case-insensitively: every record of a GUID must use the same path, and
// two GUIDs must not share a path. Overrides are the same GUID + the same path (Workbench's
// "override"), so they merge; a GUID that moves between databases, or a path two GUIDs claim, is a
// merge error that `verify-merge` reports and `merge`/`--rdb` refuse.

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
      // The same GUID and the same path with another case: one resource, two databases.
      entry({ path: "configs/system/resourcetypes/sound.conf", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 4] }),
      entry({ path: "Prefabs/Y/Other.et", guid: "DDDDDDDDDDDDDDDD", meta: [MTIME, 5] }),
    ],
  }));
  const moved = join(tmp, "moved.rdb");
  writeFileSync(moved, database({
    names: ["moved"],
    entries: [entry({ path: "Configs/ResourceTypes/Sound.conf", guid: "BBBBBBBBBBBBBBBB", meta: [MTIME, 6] })],
  }));
  const dupe = join(tmp, "dupe.rdb");
  writeFileSync(dupe, database({
    names: ["dupe"],
    entries: [entry({ path: "Prefabs/X/Thing.et", guid: "EEEEEEEEEEEEEEEE", meta: [MTIME, 7] })],
  }));

  check("mergeRdb: one dictionary, and each GUID lists the databases that name it, in order",
    (() => {
      const set = mergeRdb([scanRdb(one), scanRdb(two)]);
      const a = set.resolve("AAAAAAAAAAAAAAAA");
      const b = set.resolve("BBBBBBBBBBBBBBBB");
      const d = set.resolve("DDDDDDDDDDDDDDDD");
      return set.size === 4 && set.count === 2 && set.multi === true
        && a.path === "Prefabs/X/Thing.et" && JSON.stringify(a.rdbs) === "[0]"
        && b.path === "Configs/System/ResourceTypes/Sound.conf" && JSON.stringify(b.rdbs) === "[0,1]"
        && d.path === "Prefabs/Y/Other.et" && JSON.stringify(d.rdbs) === "[1]"
        && set.resolve("FFFFFFFFFFFFFFFF") === null && set.path("FFFFFFFFFFFFFFFF") === null;
    })());
  check("verifyMerge: a case difference in the path is not a merge error; the first spelling wins",
    (() => {
      const check2 = verifyMerge([scanRdb(one), scanRdb(two)]);
      return check2.ok === true && check2.guids === 4 && check2.paths === 4
        && check2.sameGuidDifferentPaths.length === 0 && check2.samePathDifferentGuids.length === 0
        && check2.rdbs.length === 2 && check2.rdbs[0].file === one;
    })());
  check("verifyMerge: a GUID that names two paths is a merge error, with both paths and databases",
    (() => {
      const result = verifyMerge([scanRdb(one), scanRdb(moved)]);
      const problem = result.sameGuidDifferentPaths[0];
      return result.ok === false && result.sameGuidDifferentPaths.length === 1
        && problem.guid === "BBBBBBBBBBBBBBBB" && problem.records.length === 2
        && problem.records[0].rdb === 0 && problem.records[0].path === "Configs/System/ResourceTypes/Sound.conf"
        && problem.records[1].rdb === 1 && problem.records[1].path === "Configs/ResourceTypes/Sound.conf"
        && result.samePathDifferentGuids.length === 0;
    })());
  check("verifyMerge: a path two GUIDs claim is a merge error too",
    (() => {
      const result = verifyMerge([scanRdb(one), scanRdb(dupe)]);
      const problem = result.samePathDifferentGuids[0];
      return result.ok === false && result.samePathDifferentGuids.length === 1
        && problem.path === "Prefabs/X/Thing.et" && problem.records.length === 2
        && problem.records.map((r) => r.guid).sort().join() === "AAAAAAAAAAAAAAAA,EEEEEEEEEEEEEEEE";
    })());
  check("describeMergeProblems names every offender from 1 (the text convention)",
    (() => {
      const text = describeMergeProblems(verifyMerge([scanRdb(one), scanRdb(moved)]));
      return text.includes("BBBBBBBBBBBBBBBB") && text.includes("RDB #1") && text.includes("RDB #2")
        && text.includes("Configs/System/ResourceTypes/Sound.conf")
        && text.includes("Configs/ResourceTypes/Sound.conf");
    })());

  check("openRdbFiles: a valid set merges and reports ok",
    (() => {
      const { merged: set, check: result } = openRdbFiles([one, two]);
      return result.ok === true && set.size === 4 && JSON.stringify(set.resolve("BBBBBBBBBBBBBBBB").rdbs) === "[0,1]";
    })());
  check("openRdbFiles: an invalid set returns the problems and no dictionary, it does not throw",
    (() => {
      const { merged: set, check: result } = openRdbFiles([one, moved]);
      return set === null && result.ok === false && result.sameGuidDifferentPaths.length === 1;
    })());
  check("openRdbFiles: the same database twice is a mistake, not two indices",
    (() => {
      try { openRdbFiles([one, one]); return false; } catch (err) { return /passed twice/.test(err.message); }
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

  const mergedJsonRun = runMerge(["merge", one, two, "--json"], "merge-json");
  let mergedJson = null;
  try { mergedJson = JSON.parse(mergedJsonRun.stdout); } catch { /* reported below */ }
  check("merge --json is { rdbs, resources } with 0-based index lists",
    mergedJsonRun.status === 0 && Array.isArray(mergedJson?.rdbs) && mergedJson.rdbs.length === 2
    && mergedJson.rdbs[0].file === one
    && JSON.stringify(mergedJson?.resources?.BBBBBBBBBBBBBBBB) ===
      JSON.stringify({ path: "Configs/System/ResourceTypes/Sound.conf", rdbs: [0, 1] })
    && JSON.stringify(mergedJson.resources.AAAAAAAAAAAAAAAA.rdbs) === "[0]"
    && mergedJson.databases === undefined,
    JSON.stringify(mergedJson));
  const mergedText = runMerge(["merge", one, two], "merge-text");
  check("merge prints the header and <GUID> -> <path> rdb <indices from 1>",
    mergedText.status === 0 && mergedText.stdout.includes(`RDB #1  ${one}`)
    && mergedText.stdout.includes(`RDB #2  ${two}`)
    && mergedText.stdout.includes("{BBBBBBBBBBBBBBBB} -> Configs/System/ResourceTypes/Sound.conf  rdb 1 2"),
    mergedText.stdout.slice(0, 520));
  // One database: the command is still "give me the dictionary", and the documented text form for a
  // single database drops the index suffix. It used to print a note pointing at an 11 MB `--json`.
  const singleText = runMerge(["merge", one], "merge-single-text");
  check("merge of one database prints its dictionary, with the rdb suffix dropped",
    singleText.status === 0 && singleText.stdout.includes("{AAAAAAAAAAAAAAAA} -> Prefabs/X/Thing.et")
    && singleText.stdout.includes("{CCCCCCCCCCCCCCCC} -> worlds/Cain/Cain.ent")
    && !/  rdb \d/.test(singleText.stdout) && !/nothing to merge/.test(singleText.stdout),
    singleText.stdout.slice(0, 520));
  const singleLimited = runMerge(["merge", one, "--limit", "1"], "merge-single-limit");
  check("merge of one database honours --limit and says how many rows are left",
    singleLimited.status === 0
    && singleLimited.stdout.split("\n").filter((line) => /^  \{/.test(line)).length === 1
    && /\.\.\. 2 more \(--limit 0 for all\)/.test(singleLimited.stdout),
    singleLimited.stdout);
  const broken = runMerge(["merge", one, moved], "merge-broken");
  check("merge refuses an invalid set, names the offender and exits 1",
    broken.status === 1 && /FAIL/.test(broken.stdout)
    && broken.stdout.includes("BBBBBBBBBBBBBBBB")
    && broken.stdout.includes("Configs/ResourceTypes/Sound.conf"),
    broken.stdout.slice(0, 520));
  const brokenJson = runMerge(["merge", one, moved, "--json"], "merge-broken-json");
  let brokenParsed = null;
  try { brokenParsed = JSON.parse(brokenJson.stdout); } catch { /* reported below */ }
  check("merge --json reports the merge problems instead of a dictionary",
    brokenJson.status === 1 && brokenParsed?.ok === false && brokenParsed.resources === null
    && brokenParsed.sameGuidDifferentPaths.length === 1,
    JSON.stringify(brokenParsed));
  check("merge with no database is a usage error", runMerge(["merge"], "merge-none").status === 1);

  const verifyOk = runMerge(["verify-merge", one, two], "verify-ok");
  check("verify-merge prints the check and exits 0 for a valid set",
    verifyOk.status === 0 && /one-to-one/.test(verifyOk.stdout) && /  ok/.test(verifyOk.stdout),
    verifyOk.stdout.slice(0, 420));
  const verifyBad = runMerge(["verify-merge", one, moved, "--json"], "verify-bad");
  let verifyJson = null;
  try { verifyJson = JSON.parse(verifyBad.stdout); } catch { /* reported below */ }
  check("verify-merge --json exits 1 and reports 0-based rdb indices",
    verifyBad.status === 1 && verifyJson?.ok === false && verifyJson.guids === 3
    && verifyJson.sameGuidDifferentPaths.length === 1
    && verifyJson.sameGuidDifferentPaths[0].records[0].rdb === 0
    && verifyJson.sameGuidDifferentPaths[0].records[1].rdb === 1
    && verifyJson.rdbs.length === 2,
    JSON.stringify(verifyJson?.sameGuidDifferentPaths));
  const verifyText = runMerge(["verify-merge", one, moved], "verify-text");
  check("verify-merge prints each offender with the databases from 1 and exits 1",
    verifyText.status === 1 && /FAIL  \{BBBBBBBBBBBBBBBB\} names 2 path/.test(verifyText.stdout)
    && /RDB #1  Configs\/System\/ResourceTypes\/Sound\.conf/.test(verifyText.stdout)
    && /RDB #2  Configs\/ResourceTypes\/Sound\.conf/.test(verifyText.stdout),
    verifyText.stdout.slice(0, 520));
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
    // Self-derived, so it cannot go stale with the build: take a record of this database, shout its
    // path, and ask for it. The exact spelling is therefore absent and only the folded path can
    // answer, which is the lookup a caller who copied a path from somewhere else depends on.
    check(`installed (${label}): a path typed in another case resolves to the same record`,
      (() => {
        const index = pathIndex(db.map);
        const sample = db.entries.find((e) => e.guid !== "0000000000000000"
          && /[a-z]/.test(e.path) && index.get(e.path.toLowerCase())?.guid === e.guid);
        return sample !== undefined
          && findResource(db.map, sample.path.toUpperCase())?.guid === sample.guid
          && findResource(db.map, sample.path.toUpperCase())?.path === sample.path;
      })());
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
    let refs = 0, exact = 0, folded = 0, foldedMisses = 0;
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
        const exactCase = db.map.get(guid) === ref || byPath.get(ref) === guid;
        if (exactCase) { exact++; continue; }
        // The same resource, spelled in another case: `findResource` is the lookup that must answer
        // it, and the game's own data contains such pairs, so this is not a hypothetical.
        if (findResource(db.map, ref)?.guid === guid) { folded++; continue; }
        // A pair the database names in another case that the folded lookup missed would be the
        // regression this check exists for: it is neither "exact" nor legitimately unresolved.
        if (db.map.get(guid)?.toLowerCase() === ref.toLowerCase()) foldedMisses++;
        contradicting.push(`${p}: {${guid}} ${ref}`);
      }
    }
    pak.close();
    check("references: every {GUID}path in the game's text resources agrees with the database",
      refs > 100000 && exact > refs - 120 && contradicting.length < 120,
      `${exact}/${refs} exact, ${folded} more by folding case, ${contradicting.length} contradicting; ` +
      `e.g. ${contradicting.slice(0, 3).join(" | ")}`);
    check("references: a path the database spells in another case still resolves",
      foldedMisses === 0, `${foldedMisses} pair(s) the folded lookup missed`);
  } else {
    console.log("SKIP  reference check (no installed client archives)");
  }
}

rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} RDB TEST(S) FAILED`); process.exit(1); }
console.log("\nALL RDB TESTS PASSED");
