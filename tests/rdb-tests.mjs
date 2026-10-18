// Test suite for tools/rdb.mjs — the reader for resourceDatabase.rdb (GUID <-> path).
//
//   node tests/rdb-tests.mjs
//
// The fixtures are built here byte by byte, so the suite pins the record layout itself rather
// than a captured database: the real file is ~11 MB and is not part of this repository.
//
// What is pinned, and why each one is worth a test:
//   * the record `[u32LE pathLen + 1][path][0x00][6 bytes][8-byte GUID, little-endian]`, and the
//     GUID being read 7 bytes after the NUL;
//   * the length field as the thing that separates a record from another table's bytes — the
//     naive "walk back over printable bytes and read 8 bytes" reader invents entries such as
//     `hqy.MA4` whose "GUID" is the ASCII tail of the next path;
//   * a path with a space, which the database really has (244 of them) and which the old reader
//     silently refused;
//   * the last record in the file, whose GUID ends at the last byte — the scan bound must not
//     stop 24 bytes early;
//   * the published GUIDs as the guard `verify` refuses to work without;
//   * one GUID to one path, which is the property every consumer of the map assumes;
//   * the CLI as a real child process with its own stdout/stderr files, so it keeps working in
//     sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, existsSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRdb, scanRdb, reverseRdb, verifyRdb, PUBLISHED_GUIDS, GUID_OFFSET } from "../tools/rdb.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "rdb.mjs");
const tmp = join(root, "tests", ".tmp-rdb");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else { failures++; console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`); }
}

const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const guidBytes = (hex) => Buffer.from(hex, "hex").reverse();
const gapBytes = (hex) => Buffer.from(hex, "hex");

mkdirSync(tmp, { recursive: true });

/**
 * One resource record, as the database stores it. `lengthField` overrides the u32 so a candidate
 * can be built that looks like a record and is not; `gap` is the six bytes between the path and
 * the GUID, `060000000000` in all but a handful of real records.
 */
function record(path, guid, { gap = "060000000000", lengthField = null } = {}) {
  const bytes = Buffer.from(path, "latin1");
  return Buffer.concat([
    u32(lengthField ?? bytes.length + 1), bytes, Buffer.from([0]), gapBytes(gap), guidBytes(guid),
  ]);
}

/** A database is its records back to back: no header, no index, no length for the whole file. */
const database = (records) => Buffer.concat(records);

// --- the good database: the 8 published GUIDs plus the two shapes worth pinning --------------

const PUBLISHED_RECORDS = Object.entries(PUBLISHED_GUIDS).map(([path, guid]) => record(path, guid));
const good = database([
  ...PUBLISHED_RECORDS,
  record("anims/anm/editor_poses/poses/4_ medic.anm", "7D1B1D6C659D34C3"), // a space in the path
  record("worlds/Cain/Cain.ent", "1EA95DAE3230BEB0", { gap: "060001000000" }), // the other framing
]);
const goodPath = join(tmp, "good.rdb");
writeFileSync(goodPath, good);

// --- the map, and the reverse direction ------------------------------------------------------

{
  const map = readRdb(goodPath);
  check("readRdb: every record is in the map, GUID -> path",
    map.size === 10 && map.get("ECC61978EDCC2B5A") === "Missions/23_Campaign.conf",
    `${map.size} entries`);

  const fromBytes = readRdb(good, { name: "built-in-memory" });
  check("readRdb: takes the bytes themselves, with `name` labelling them", fromBytes.size === 10);
  check("readRdb: a byte input without a name is <buffer>", scanRdb(good).file === "<buffer>");

  check("readRdb: the GUID is read 7 bytes after the path's NUL", GUID_OFFSET === 7);

  const spaced = map.get("7D1B1D6C659D34C3");
  check("readRdb: a path with a space is a resource, not noise", spaced === "anims/anm/editor_poses/poses/4_ medic.anm", spaced);

  check("readRdb: a path at the very end of the file is read (the scan does not stop 24 bytes early)",
    map.get("1EA95DAE3230BEB0") === "worlds/Cain/Cain.ent");

  const back = reverseRdb(map);
  check("reverseRdb: path -> GUID is the other direction over the same table",
    back.get("Missions/23_Campaign.conf") === "ECC61978EDCC2B5A" && back.size === 10);
}

// --- what is not a record --------------------------------------------------------------------

{
  const junk = database([
    // The false positive measured on the real database: a run of printable bytes behind a NUL,
    // with a u32 in front that contradicts its length (`hqy.MA4` in
    // `...Assets/Decal`). The naive reader takes it and reads the next path's tail as a GUID.
    record("hqy.MA4", "6C616365442F7374", { lengthField: 999 }),
    record("Prefabs/Bad#Name.et", "1111111111111111"), // not a path character
    record("Prefabs/ZeroGUID.et", "0000000000000000"), // a placeholder, not a resource
    record("a.e", "2222222222222222"), // shorter than any resource path
    record("worlds/Kept.ent", "3333333333333333"),
  ]);
  const db = scanRdb(junk, { name: "junk" });
  // The file is used again by the CLI's `verify`, which must refuse a database whose published
  // GUIDs do not reproduce.
  writeFileSync(join(tmp, "junk.rdb"), junk);
  check("a candidate whose length field contradicts the path is refused",
    !db.map.has("6C616365442F7374") && db.rejected.lengthField === 1, JSON.stringify(db.rejected));
  check("a path outside the character set is refused, and counted", db.rejected.shape === 1, JSON.stringify(db.rejected));
  check("an all-zero GUID is refused, and counted", db.rejected.guid === 1, JSON.stringify(db.rejected));
  check("a path shorter than the minimum is not even a candidate", db.records === 1 && db.map.has("3333333333333333"),
    `${db.records} record(s)`);
}

// --- duplicates: the map would silently lose one, so verify says so ---------------------------

{
  const dupes = database([
    record("worlds/One.ent", "AAAAAAAAAAAAAAAA"),
    record("worlds/Two.ent", "BBBBBBBBBBBBBBBB"),
    record("worlds/One.ent", "CCCCCCCCCCCCCCCC"), // one path, two GUIDs
    record("worlds/Three.ent", "BBBBBBBBBBBBBBBB"), // one GUID, two paths
  ]);
  const db = scanRdb(dupes, { name: "dupes" });
  check("duplicates are counted, not hidden",
    db.records === 4 && db.map.size === 3 && reverseRdb(db.map).size === 2,
    `${db.records} records, ${db.map.size} GUIDs, ${reverseRdb(db.map).size} paths`);
  const result = verifyRdb(db, { known: { "worlds/One.ent": "AAAAAAAAAAAAAAAA" } });
  check("verify: a mapping that is not one-to-one is a failure", result.ok === false && result.unique === false);
  check("verify: a colliding GUID drops a path, and the failure names the counts",
    result.records === 4 && result.uniqueGuids === 3 && result.uniquePaths === 2,
    JSON.stringify({ r: result.records, g: result.uniqueGuids, p: result.uniquePaths }));
}

// --- the published GUIDs are the guard -------------------------------------------------------

{
  const db = scanRdb(goodPath);
  const result = verifyRdb(db);
  check("verify: all 8 published GUIDs are reproduced",
    result.ok === true && result.checks.length === 8 && result.failures.length === 0,
    JSON.stringify(result.failures));
  check("verify: every published pair is reported, matched", result.checks.every((c) => c.ok && c.found === c.expected));

  const wrong = verifyRdb(db, { known: { ...PUBLISHED_GUIDS, "Missions/23_Campaign.conf": "0000000000000001" } });
  check("verify: a changed GUID is a failure naming expected and found",
    wrong.ok === false && wrong.failures.length === 1
    && wrong.failures[0].expected === "0000000000000001"
    && wrong.failures[0].found === "ECC61978EDCC2B5A",
    JSON.stringify(wrong.failures));

  const missing = verifyRdb(scanRdb(record("worlds/Only.ent", "ABCDEF0123456789"), { name: "tiny" }));
  check("verify: a database without the published GUIDs fails all 8, rather than guessing",
    missing.ok === false && missing.failures.length === 8);
}

// --- stats: what `info` and `verify` print ---------------------------------------------------

{
  const db = scanRdb(goodPath);
  check("info: records, framing and rejected candidates are counted",
    db.records === 10 && db.gaps.get("060000000000") === 9 && db.gaps.get("060001000000") === 1
    && db.rejected.lengthField === 0,
    JSON.stringify({ records: db.records, gaps: [...db.gaps], rejected: db.rejected }));
  check("info: paths are counted by extension",
    db.extensions.get(".conf") === 8 && db.extensions.get(".anm") === 1 && db.extensions.get(".ent") === 1,
    JSON.stringify([...db.extensions]));
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
  check("info --json parses and describes the database",
    info.json?.records === 10 && info.json?.bytes === good.length
    && info.json?.uniqueGuids === 10 && info.json?.uniquePaths === 10
    && Array.isArray(info.json?.framing) && info.json.framing[0].bytes === "060000000000"
    && info.json?.extensions?.[".conf"] === 8,
    JSON.stringify(info.json).slice(0, 200));
  check("info --json reports the candidates it refused, so a wrong count is visible",
    info.json?.rejected?.lengthField === 0 && info.json?.rejected?.shape === 0 && info.json?.rejected?.guid === 0);

  const text = run(["info", goodPath], "info.txt");
  check("info prints the file, the record count and the framing",
    text.status === 0 && text.stdout.includes(goodPath) && /records\s+10 /.test(text.stdout)
    && text.stdout.includes("06 00 00 00 00 00"), text.stdout.slice(0, 200));

  const get = run(["get", goodPath, "ECC61978EDCC2B5A"], "get.txt");
  check("get prints the GUID and the path", get.status === 0
    && get.stdout.trim() === "{ECC61978EDCC2B5A}  Missions/23_Campaign.conf", JSON.stringify(get.stdout));
  check("get takes a GUID in braces and in any case",
    run(["get", goodPath, "{ecc61978edcc2b5a}"], "get-braces.txt").stdout.trim() === "{ECC61978EDCC2B5A}  Missions/23_Campaign.conf");

  const miss = run(["get", goodPath, "0123456789ABCDEF"], "get-miss.txt");
  check("get exits 1 for a GUID that names nothing, and says so on stderr",
    miss.status === 1 && miss.stdout === "" && /no resource with the GUID \{0123456789ABCDEF\}/.test(miss.stderr),
    JSON.stringify({ status: miss.status, stderr: miss.stderr }));

  const missJson = run(["get", goodPath, "0123456789ABCDEF", "--json"], "get-miss.json");
  check("get --json answers a miss with `path: null` and still exits 1",
    missJson.status === 1 && missJson.json?.path === null && missJson.json?.guid === "0123456789ABCDEF");

  const byPath = run(["guid", goodPath, "Missions/23_Campaign.conf"], "guid.txt");
  check("guid prints the GUID in front of the path",
    byPath.status === 0 && byPath.stdout.trim() === "{ECC61978EDCC2B5A}Missions/23_Campaign.conf", JSON.stringify(byPath.stdout));
  check("guid converts backslashes, so a Windows path is the same path",
    run(["guid", goodPath, "worlds\\Cain\\Cain.ent"], "guid-win.txt").stdout.trim() === "{1EA95DAE3230BEB0}worlds/Cain/Cain.ent");
  check("guid exits 1 for a path the database does not name",
    run(["guid", goodPath, "worlds/Nowhere.ent"], "guid-miss.txt").status === 1);

  const list = run(["list", goodPath], "list.txt");
  check("list prints every record in file order",
    list.status === 0 && list.stdout.trim().split("\n").length === 10
    && list.stdout.includes("{ECC61978EDCC2B5A}  Missions/23_Campaign.conf"), list.stdout.slice(0, 160));

  const limited = run(["list", goodPath, "--limit", "2"], "list-2.txt");
  check("list --limit stops at N and says how many are left",
    limited.stdout.trim().split("\n").length === 3 && /8 more/.test(limited.stdout), limited.stdout);

  const filtered = run(["list", goodPath, "^Missions/23"], "list-re.txt");
  check("list takes a case-insensitive regex", filtered.status === 0 && filtered.stdout.trim() === "{ECC61978EDCC2B5A}  Missions/23_Campaign.conf");

  const listJson = run(["list", goodPath, "--limit", "2", "--json"], "list.json");
  check("list --json is an envelope that makes truncation visible",
    listJson.json?.total === 10 && listJson.json?.returned === 2 && listJson.json?.truncated === true
    && listJson.json?.entries?.length === 2 && listJson.json?.filter === null,
    JSON.stringify(listJson.json).slice(0, 200));
  check("list --all is the same as --limit 0",
    run(["list", goodPath, "--all", "--json"], "list-all.json").json?.returned === 10);

  const verify = run(["verify", goodPath], "verify.txt");
  check("verify exits 0 when the published GUIDs and the one-to-one mapping hold",
    verify.status === 0 && /8\/8 GUIDs reproduced/.test(verify.stdout) && /ok/.test(verify.stdout), verify.stdout);

  const verifyJson = run(["verify", goodPath, "--json"], "verify.json");
  check("verify --json carries the checks, not only a verdict",
    verifyJson.json?.ok === true && verifyJson.json?.checks?.length === 8
    && verifyJson.json?.checks?.every((c) => c.ok) && verifyJson.json?.failures?.length === 0,
    JSON.stringify(verifyJson.json).slice(0, 200));

  const unguarded = run(["verify", join(tmp, "junk.rdb")], "verify-junk.txt");
  check("verify refuses a database whose published GUIDs do not reproduce",
    unguarded.status === 1 && /self-check FAILED/.test(unguarded.stdout) && /do not trust|cannot be trusted|no path it yields/i.test(unguarded.stdout),
    unguarded.stdout);
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

  check("a missing file exits 1 with the path in the message",
    run(["info", join(tmp, "nope.rdb")], "missing").status === 1);
  check("--help is a request, not a failure: exit 0", run(["--help"], "help").status === 0);
  const none = run([], "none");
  check("no arguments at all is a failure: exit 1, usage on stderr",
    none.status === 1 && /Read resourceDatabase\.rdb/.test(none.stderr));
}

// --- the installed databases, when there are any ---------------------------------------------
// The client and the dedicated server ship *different* copies — 98 598 records against 98 755 on
// 1.8.0.13, with a different framing word for a third of the server's — so both are read when
// both are present: a claim measured on one copy is not a claim about the other.

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
    check(`installed (${label}): the map is large and one-to-one`,
      db.records > 90000 && db.map.size === db.records && reverseRdb(db.map).size === db.records,
      `${db.records} records, ${db.map.size} GUIDs`);
    check(`installed (${label}): the known world GUID resolves to its path`,
      db.map.get("9DF143A76F5C6460") === "worlds/MP/CTI_Campaign_Eden.ent",
      db.map.get("9DF143A76F5C6460") ?? "not found");
    check(`installed (${label}): a path with a space resolves, which the old reader refused`,
      db.map.get("7D1B1D6C659D34C3") === "anims/anm/editor_poses/poses/4_ medic.anm",
      db.map.get("7D1B1D6C659D34C3") ?? "not found");
    const result = verifyRdb(db);
    check(`installed (${label}): verify reproduces the 8 published GUIDs and the mapping is one-to-one`,
      result.ok === true, JSON.stringify(result.failures));
  }
  if (!seen) console.log("SKIP  installed database (no installed resourceDatabase.rdb)");
}

rmSync(tmp, { recursive: true, force: true });
if (failures) { console.log(`\n${failures} RDB TEST(S) FAILED`); process.exit(1); }
console.log("\nALL RDB TESTS PASSED");
