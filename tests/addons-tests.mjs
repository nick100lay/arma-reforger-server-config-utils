// Test suite for tools/addons.mjs — the dependency order and the mod-list filter every reader uses.
//
//   node tests/addons-tests.mjs
//
// The fixtures are written here as text, so the suite pins the *rules*: an `addon.gproj` names the
// addon and its dependencies, and the one order that satisfies those edges is dependents first, the
// game last. The readers are exercised as real child processes, with their output written to files
// so the suite keeps working in sandboxes that forbid piped stdio.
//
// What is pinned, and why each one is worth a test:
//   * `B`, `C` both depending on `A` are read as `B`, `C`, `A` — not as the folder's alphabetical
//     order, which is the defect this module exists for;
//   * a chain and a diamond are ordered by the edges, not by name;
//   * the game and its own `core` are recognised as vanilla whether given together (a folder of
//     addons) or alone (the game's own `addons/data`, which is itself one addon);
//   * the filter takes every shape a server or the game hands out, keeps the game unless
//     `--filter-vanilla`, and never filters an explicit `--addon`;
//   * a cycle, a duplicate GUID and a missing dependency are reported, and only the cycle and the
//     duplicate fail `check`;
//   * `etconf`, `layer`, `ebin` and `cscript` resolve `--addons` the same way — the integration
//     tests prove the order reaches the readers, not merely that the resolver computes it.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  VANILLA_GUID,
  VANILLA_CORE_GUID,
  readGameProject,
  readModsFilter,
  addonDirsOfRoot,
  resolveAddonSet,
  addonRdbDictionary,
} from "../tools/addons.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "addons.mjs");
const tmp = join(root, "tests", ".tmp-addons");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else {
    failures++;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
}
function same(what, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  check(what, a === e, `got ${a}, expected ${e}`);
}

/** Write a fixture and return its path. */
function fixture(name, text) {
  const path = join(tmp, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return path;
}

/** A `GameProject` file: the identity, the title, and the identities it depends on. */
function gproj(name, guid, dependencies, { id = name, title = name } = {}) {
  const deps = dependencies.map((dep) => `  "${dep}"`).join("\n");
  return `GameProject {\n ID "${id}"\n GUID "${guid}"\n TITLE "${title}"\n Dependencies {\n${deps}\n }\n}\n`;
}

function runCli(args) {
  const outPath = join(tmp, "cli.out");
  const errPath = join(tmp, "cli.err");
  writeFileSync(outPath, "");
  writeFileSync(errPath, "");
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  let status;
  try {
    status = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", out, err] }).status;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return { status, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8"), json: () => JSON.parse(readFileSync(outPath, "utf8")) };
}

/** Run one of the sibling readers, with the same file-based stdio. */
function runTool(toolName, args) {
  const outPath = join(tmp, `cli-${toolName}.out`);
  const errPath = join(tmp, `cli-${toolName}.err`);
  writeFileSync(outPath, "");
  writeFileSync(errPath, "");
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  let status;
  try {
    status = spawnSync(process.execPath, [join(root, "tools", `${toolName}.mjs`), ...args], { stdio: ["ignore", out, err] }).status;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return { status, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8"), json: () => JSON.parse(readFileSync(outPath, "utf8")) };
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

// ---------------------------------------------------------------------------
// Reading one project file
// ---------------------------------------------------------------------------
const projectFixture = fixture("one/addon.gproj", gproj("ACE_Carrying", "5DBD560C5148E1DA", ["58D0FB3206B6F859", "60C4CE4888FF4621"], { title: "ACE Carrying" }));
const project = readGameProject(projectFixture);
same("a project file gives its GUID, ID, title and dependencies", [project.guid, project.id, project.title], ["5DBD560C5148E1DA", "ACE_Carrying", "ACE Carrying"]);
same("dependencies are the identities it needs, in file order", project.dependencies, ["58D0FB3206B6F859", "60C4CE4888FF4621"]);
const duplicateDeps = fixture("one/dupe.gproj", gproj("Dupe", "DDDDDDDDDDDDDDD0", ["AAAAAAAAAAAAAAAA", "AAAAAAAAAAAAAAAA"]));
same("a repeated dependency is one edge", readGameProject(duplicateDeps).dependencies, ["AAAAAAAAAAAAAAAA"]);
const noGuid = fixture("one/noguid.gproj", 'GameProject {\n ID "NoGuid"\n}\n');
same("a project with no GUID is not a project this module can order", readGameProject(noGuid), null);

// A downloaded addon without its project file: the Workshop cache `meta`, then `ServerData.json`.
const metaRoot = join(tmp, "meta-root");
fixture("meta-root/by-meta/meta", JSON.stringify({
  meta: {
    id: "ABCDEFABCDEF0001",
    name: "Meta Only",
    selectedRev: 0,
    versions: [{ version: "2.0", dependencies: [{ assetId: "AAAAAAAAAAAAAAAA" }] }],
  },
}));
fixture("meta-root/by-serverdata/ServerData.json", JSON.stringify({
  id: "ABCDEFABCDEF0002",
  name: "ServerData Only",
  revision: { version: "1.0", dependencies: [] },
}));
const metaSet = resolveAddonSet({ addons: [metaRoot] });
const byMeta = metaSet.byGuid.get("ABCDEFABCDEF0001");
const byServerData = metaSet.byGuid.get("ABCDEFABCDEF0002");
check("the Workshop meta cache gives the identity and dependencies when the project file is missing",
  byMeta.identity === "meta" && byMeta.dependencies.includes("AAAAAAAAAAAAAAAA") && byMeta.title === "Meta Only",
  JSON.stringify(byMeta && { identity: byMeta.identity, deps: byMeta.dependencies, title: byMeta.title }));
check("ServerData.json is the last fallback, with no dependencies",
  byServerData.identity === "serverdata" && byServerData.dependencies.length === 0,
  JSON.stringify(byServerData && { identity: byServerData.identity, deps: byServerData.dependencies }));

// ---------------------------------------------------------------------------
// One folder of addons: A is the base, B and C depend on it
// ---------------------------------------------------------------------------
const universe = join(tmp, "universe");
fixture("universe/A/addon.gproj", gproj("A", "AAAAAAAAAAAAAAAA", [VANILLA_GUID]));
fixture("universe/B/addon.gproj", gproj("B", "BBBBBBBBBBBBBBBB", ["AAAAAAAAAAAAAAAA", VANILLA_GUID]));
fixture("universe/C/addon.gproj", gproj("C", "CCCCCCCCCCCCCCCC", ["AAAAAAAAAAAAAAAA", VANILLA_GUID]));
fixture("universe/loose/readme.txt", "a directory with no project file\n");

same("a root's children are the addons, sorted by name", addonDirsOfRoot(universe).map((dir) => dir.split(/[\\/]/).pop()), ["A", "B", "C", "loose"]);
check("a root with no child directory says it reads one level down", (() => {
  const empty = join(tmp, "empty-root");
  mkdirSync(empty, { recursive: true });
  try {
    addonDirsOfRoot(empty);
    return false;
  } catch (err) {
    return err.message.includes("no addon directory") && err.message.includes("one level down");
  }
})());

const resolved = resolveAddonSet({ addons: [universe] });
same("dependents come before the addon they depend on", resolved.order.map((record) => record.name), ["B", "C", "A", "loose"]);
same("every addon is in `all`, selected or not", resolved.all.map((record) => record.name), ["A", "B", "C", "loose"]);
check("a directory with no project file is reported, not dropped", resolved.problems.some((problem) => problem.code === "no-project" && problem.message.includes("loose")));
check("a dependency on the game is not a missing addon", !resolved.problems.some((problem) => problem.code === "missing-dependency" && problem.message.includes(VANILLA_GUID)));

const chain = join(tmp, "chain");
fixture("chain/A/addon.gproj", gproj("A", "AAAAAAAAAAAAAAAA", []));
fixture("chain/B/addon.gproj", gproj("B", "BBBBBBBBBBBBBBBB", ["AAAAAAAAAAAAAAAA"]));
fixture("chain/C/addon.gproj", gproj("C", "CCCCCCCCCCCCCCCC", ["BBBBBBBBBBBBBBBB"]));
same("a chain is ordered end to end", resolveAddonSet({ addons: [join(tmp, "chain")] }).order.map((record) => record.name), ["C", "B", "A"]);

const diamond = join(tmp, "diamond");
fixture("diamond/A/addon.gproj", gproj("A", "AAAAAAAAAAAAAAAA", []));
fixture("diamond/B/addon.gproj", gproj("B", "BBBBBBBBBBBBBBBB", ["AAAAAAAAAAAAAAAA"]));
fixture("diamond/C/addon.gproj", gproj("C", "CCCCCCCCCCCCCCCC", ["AAAAAAAAAAAAAAAA"]));
fixture("diamond/D/addon.gproj", gproj("D", "DDDDDDDDDDDDDDDD", ["BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC"]));
const diamondOrder = resolveAddonSet({ addons: [join(tmp, "diamond")] }).order.map((record) => record.name);
same("a diamond puts the shared base last", [diamondOrder[0], diamondOrder[3]], ["D", "A"]);
same("a diamond orders the peers by discovery", diamondOrder.slice(1, 3), ["B", "C"]);

// ---------------------------------------------------------------------------
// The game, its own core, and a folder that is one addon
// ---------------------------------------------------------------------------
const game = join(tmp, "game");
fixture("game/data/ArmaReforger.gproj", gproj("data", VANILLA_GUID, [VANILLA_CORE_GUID], { title: "Arma Reforger" }));
fixture("game/core/core.gproj", gproj("core", VANILLA_CORE_GUID, [], { title: "Enfusion core data" }));
const gameOrder = resolveAddonSet({ addons: [game] }).order.map((record) => record.name);
same("the game's data comes before the core it depends on", gameOrder, ["data", "core"]);
check("the game and its core are both vanilla", resolveAddonSet({ addons: [game] }).all.every((record) => record.vanilla));
same("a game folder given as one addon is one addon", addonDirsOfRoot(join(game, "data")).length, 1);
same("--addons on the game's own data directory is one vanilla addon", resolveAddonSet({ addons: [join(game, "data")] }).order.map((record) => record.name), ["data"]);
check("a folder with a top-level .gproj is itself the addon", addonDirsOfRoot(join(diamond, "A")).length === 1);

// The game is the base: a mod that forgot to list it in Dependencies still overrides it, so the
// game is last even though its folder name sorts first.
const gamePlusMod = join(tmp, "game-plus-mod");
fixture("game-plus-mod/data/ArmaReforger.gproj", gproj("data", VANILLA_GUID, []));
fixture("game-plus-mod/zmod/addon.gproj", gproj("zmod", "ZZZZZZZZZZZZZZZZ", []));
same("a mod that omits the game from Dependencies is still ordered before it",
  resolveAddonSet({ addons: [gamePlusMod] }).order.map((record) => record.name), ["zmod", "data"]);

// ---------------------------------------------------------------------------
// The filter
// ---------------------------------------------------------------------------
const filterB = fixture("filters/b.json", JSON.stringify({ mods: [{ modId: "bbbbbbbbbbbbbbbb", name: "B", version: "1.0" }] }));
const filtered = resolveAddonSet({ addons: [universe], filterFile: filterB });
same("a filter selects only the addon it names", filtered.order.map((record) => record.name), ["B"]);
same("the untouched addons are reported as dropped", filtered.dropped.map((entry) => entry.record.name), ["A", "C", "loose"]);
check("a selected addon whose dependency the filter dropped is reported", filtered.problems.some((problem) => problem.code === "filtered-dependency" && problem.message.includes("B")));
same("the filter reports what it matched", [filtered.filter.ids.length, filtered.filter.matched], [1, 1]);

const wholeConfig = fixture("filters/whole.json", JSON.stringify({
  game: { mods: [{ modId: "{5DBD560C5148E1DA}", name: "ACE Carrying" }, { modId: "60C4CE4888FF4621" }] },
}));
same("the whole server config is accepted, and braces are not part of the identity",
  readModsFilter(wholeConfig).ids, ["5DBD560C5148E1DA", "60C4CE4888FF4621"]);
const bareArray = fixture("filters/array.json", JSON.stringify([{ modId: "AAAAAAAAAAAAAAAA" }]));
same("a bare array is accepted", readModsFilter(bareArray).ids, ["AAAAAAAAAAAAAAAA"]);
const bareObject = fixture("filters/object.json", JSON.stringify({ modId: "CCCCCCCCCCCCCCCC" }));
same("one mod object is accepted", readModsFilter(bareObject).ids, ["CCCCCCCCCCCCCCCC"]);
const clipboard = fixture("filters/clipboard.json", '{\n  "modId": "AAAAAAAAAAAAAAAA",\n  "name": "A",\n  "version": "1.0"\n},\n{\n  "modId": "BBBBBBBBBBBBBBBB",\n  "name": "B"\n}\n');
same("the game's clipboard form (no array brackets) is accepted", readModsFilter(clipboard).ids, ["AAAAAAAAAAAAAAAA", "BBBBBBBBBBBBBBBB"]);
const strings = fixture("filters/strings.json", JSON.stringify(["AAAAAAAAAAAAAAAA"]));
same("bare GUID strings are accepted", readModsFilter(strings).ids, ["AAAAAAAAAAAAAAAA"]);
const ignored = fixture("filters/ignored.json", JSON.stringify([{ name: "no id" }, { modId: "not-hex" }]));
same("an entry with no usable modId is counted and ignored", [readModsFilter(ignored).ids.length, readModsFilter(ignored).ignored], [0, 2]);
check("a file that is not JSON is refused", (() => {
  const broken = fixture("filters/broken.json", "{ not json");
  try {
    readModsFilter(broken);
    return false;
  } catch (err) {
    return err.code === "INPUT" && err.message.includes("not JSON");
  }
})());
check("an empty filter file is refused rather than reading as an empty mod list", (() => {
  const empty = fixture("filters/empty.json", "  \n");
  try {
    readModsFilter(empty);
    return false;
  } catch (err) {
    return err.code === "INPUT" && err.message.includes("is empty");
  }
})());
check("a JSON file with no mod list is refused", (() => {
  const wrong = fixture("filters/wrong.json", JSON.stringify({ name: "not a server config" }));
  try {
    readModsFilter(wrong);
    return false;
  } catch (err) {
    return err.code === "INPUT" && err.message.includes("does not carry a mod list");
  }
})());
const noModsConfig = fixture("filters/no-mods.json", JSON.stringify({ game: { name: "a server with no mods" } }));
same("a server config with no game.mods is an empty filter, not a mistake", readModsFilter(noModsConfig).ids, []);

const filterAll = fixture("filters/all.json", JSON.stringify({
  mods: [
    { modId: "AAAAAAAAAAAAAAAA" },
    { modId: "BBBBBBBBBBBBBBBB" },
    { modId: "CCCCCCCCCCCCCCCC" },
    { modId: "9999999999999999" },
  ],
}));
const allFiltered = resolveAddonSet({ addons: [universe], filterFile: filterAll });
same("a filter that names every mod selects them in dependency order", allFiltered.order.map((record) => record.name), ["B", "C", "A"]);
check("a modId no addon has is reported", allFiltered.problems.some((problem) => problem.code === "filter-not-found" && problem.message.includes("9999999999999999")));
const withVanilla = resolveAddonSet({ addons: [game], filterFile: filterB });
same("the game is kept even when the filter does not name it", withVanilla.order.map((record) => record.name), ["data", "core"]);
const noVanilla = resolveAddonSet({ addons: [game], filterFile: filterB, filterVanilla: true });
same("--filter-vanilla applies the filter to the game too", noVanilla.order.map((record) => record.name), []);
const explicit = resolveAddonSet({ addon: [join(universe, "A")], addons: [universe], filterFile: filterB });
same("an explicit --addon is never filtered", explicit.order.filter((record) => record.explicit).map((record) => record.name), ["A"]);
check("--filter-vanilla without a filter is a usage error", (() => {
  try {
    resolveAddonSet({ addons: [universe], filterVanilla: true });
    return false;
  } catch (err) {
    return err.code === "USAGE";
  }
})());
check("--filter-addons-json without --addons is a usage error", (() => {
  try {
    resolveAddonSet({ addon: [join(universe, "A")], filterFile: filterB });
    return false;
  } catch (err) {
    return err.code === "USAGE";
  }
})());

// ---------------------------------------------------------------------------
// Problems: a cycle, a duplicate, a missing dependency
// ---------------------------------------------------------------------------
const cycle = join(tmp, "cycle");
fixture("cycle/E/addon.gproj", gproj("E", "EEEEEEEEEEEEEEEE", ["FFFFFFFFFFFFFFFF"]));
fixture("cycle/F/addon.gproj", gproj("F", "FFFFFFFFFFFFFFFF", ["EEEEEEEEEEEEEEEE"]));
const cycleSet = resolveAddonSet({ addons: [cycle] });
check("a cycle is reported as an error", cycleSet.problems.some((problem) => problem.severity === "error" && problem.code === "cycle" && problem.message.includes("EEEEEEEEEEEEEEEE") && problem.message.includes("FFFFFFFFFFFFFFFF")));
same("a cycle still lists both addons", cycleSet.order.length, 2);
const cycleCheck = runCli(["check", "--addons", cycle]);
same("check exits 1 on a cycle", cycleCheck.status, 1);
check("the cycle is named in the text", cycleCheck.out.includes("cycle"), cycleCheck.out);

const duplicate = join(tmp, "duplicate");
fixture("duplicate/One/addon.gproj", gproj("One", "1111111111111111", []));
fixture("duplicate/Two/addon.gproj", gproj("Two", "1111111111111111", []));
const duplicateCheck = runCli(["check", "--addons", duplicate]);
same("check exits 1 when two folders claim one GUID", duplicateCheck.status, 1);
check("the duplicate GUID is named", duplicateCheck.out.includes("1111111111111111"), duplicateCheck.out);

const missing = join(tmp, "missing");
fixture("missing/X/addon.gproj", gproj("X", "1111222233334444", ["1234123412341234"]));
const missingSet = resolveAddonSet({ addons: [missing] });
check("a dependency that is not in the folders is a warning, not an error", missingSet.problems.some((problem) => problem.severity === "warning" && problem.code === "missing-dependency" && problem.message.includes("1234123412341234")));
same("that warning does not fail check", runCli(["check", "--addons", missing]).status, 0);
same("--strict makes the warning fail", runCli(["check", "--addons", missing, "--strict"]).status, 1);

// ---------------------------------------------------------------------------
// CLI: list, order, info, tree, mods
// ---------------------------------------------------------------------------
const listJson = runCli(["list", "--addons", universe, "--json"]).json();
same("list --json names every addon in override order", listJson.addons.map((addon) => addon.name), ["B", "C", "A", "loose"]);
same("list carries the counts", [listJson.found, listJson.selected, listJson.dropped], [4, 4, 0]);
const listFiltered = runCli(["list", "--addons", universe, "--filter-addons-json", filterB, "--json"]).json();
same("a filter hides the dropped rows in list", listFiltered.addons.map((addon) => addon.name), ["B"]);
same("the dropped count is still reported", [listFiltered.selected, listFiltered.dropped], [1, 3]);
const listDropped = runCli(["list", "--addons", universe, "--filter-addons-json", filterB, "--dropped", "--json"]).json();
same("--dropped shows them too, selected first", listDropped.addons.map((addon) => addon.name), ["B", "A", "C", "loose"]);
same("a dropped row carries the reason", listDropped.addons.find((addon) => addon.name === "A").dropped, "not in the filter");

const orderText = runCli(["order", "--addons", universe]);
check(
  "order prints the dependents before the addon they depend on",
  orderText.out.indexOf("AAAAAAAAAAAAAAAA  A") > orderText.out.indexOf("BBBBBBBBBBBBBBBB  B") &&
    orderText.out.indexOf("AAAAAAAAAAAAAAAA  A") > orderText.out.indexOf("CCCCCCCCCCCCCCCC  C"),
  orderText.out,
);
const orderDirs = runCli(["order", "--addons", universe, "--dirs"]);
same("order --dirs prints one directory per line", orderDirs.out.trim().split("\n").length, 4);
check("order --dirs prints paths, not rows", orderDirs.out.trim().split("\n")[0].includes("universe"), orderDirs.out);

const infoByGuid = runCli(["info", "bbbbbbbbbbbbbbbb", "--addons", universe, "--json"]).json();
same("info finds an addon by GUID, in any case", [infoByGuid.addon.name, infoByGuid.addon.order], ["B", 1]);
same("info names the dependencies and their order", infoByGuid.addon.dependencies.map((dependency) => [dependency.name, dependency.missing]), [["A", false], [null, true]]);
const infoByName = runCli(["info", "B", "--addons", universe]);
check("info finds an addon by folder name", infoByName.status === 0 && infoByName.out.includes("GUID    BBBBBBBBBBBBBBBB"), infoByName.out);
const infoByTitle = fixture("titled/addon.gproj", gproj("folder", "ABABABABABABABAB", [], { title: "A Title With Spaces" }));
const infoByTitleRun = runCli(["info", "A Title With Spaces", "--addons", tmp]);
check("info finds an addon by TITLE", infoByTitleRun.status === 0 && infoByTitleRun.out.includes("ABABABABABABABAB"), `${infoByTitleRun.status} ${infoByTitleRun.out}`);
check("info refuses a name that matches nothing", runCli(["info", "nope", "--addons", universe]).status === 1);
check("info refuses an ambiguous name", (() => {
  const ambiguous = join(tmp, "ambiguous");
  fixture("ambiguous/a/One.gproj", gproj("One", "1111111111111111", []));
  fixture("ambiguous/b/One.gproj", gproj("One", "2222222222222222", []));
  const run = runCli(["info", "One", "--addons", ambiguous]);
  return run.status === 1 && run.err.includes("matches 2 addons");
})());

const treeText = runCli(["tree", "--addons", diamond]);
check("the tree puts a root at the top and its dependencies below", /^D\b/m.test(treeText.out) && treeText.out.includes("  - B") && treeText.out.includes("    - A"), treeText.out);
const treeJson = runCli(["tree", "--addons", diamond, "--json"]).json();
check("tree --json carries depth and order", treeJson.nodes[0].depth === 0 && treeJson.nodes.every((node) => Number.isInteger(node.order)), JSON.stringify(treeJson.nodes));
check("a repeated node is marked instead of repeated",
  treeJson.nodes.some((node) => node.alreadyShown) && treeJson.nodes.filter((node) => node.name === "A" && !node.alreadyShown).length === 1,
  JSON.stringify(treeJson.nodes.filter((node) => node.name === "A")));

const modsJson = runCli(["mods", "--addons", game]).json();
same("mods writes the game.mods fragment for the addons, not the game", modsJson.game.mods, []);
const modsVanilla = runCli(["mods", "--addons", game, "--include-vanilla"]).json();
same("--include-vanilla adds the game's own entries", modsVanilla.game.mods.map((mod) => mod.modId), [VANILLA_GUID, VANILLA_CORE_GUID]);
const modsUniverse = runCli(["mods", "--addons", universe]).json();
same("mods follows the override order and skips an addon with no GUID", modsUniverse.game.mods.map((mod) => mod.modId), ["BBBBBBBBBBBBBBBB", "CCCCCCCCCCCCCCCC", "AAAAAAAAAAAAAAAA"]);

const usageFilter = runCli(["list", "--filter-addons-json", filterB]);
same("the CLI refuses a filter with no --addons (exit 2)", usageFilter.status, 2);
const usageVanilla = runCli(["list", "--addons", universe, "--filter-vanilla"]);
same("the CLI refuses --filter-vanilla with no filter (exit 2)", usageVanilla.status, 2);
const usageNoSource = runCli(["list"]);
same("the CLI needs an addons folder (exit 2)", usageNoSource.status, 2);
const failureJson = runCli(["list", "--filter-addons-json", join(tmp, "nope.json"), "--addons", universe, "--json"]);
same("a failure under --json is one object with a code", [failureJson.json().ok, failureJson.json().error.code], [false, "INPUT"]);

// ---------------------------------------------------------------------------
// The readers: the same order and the same filter
// ---------------------------------------------------------------------------
const integration = join(tmp, "integration");
fixture("integration/A/addon.gproj", gproj("A", "AAAAAAAAAAAAAAAA", []));
fixture("integration/B/addon.gproj", gproj("B", "BBBBBBBBBBBBBBBB", ["AAAAAAAAAAAAAAAA"]));
fixture("integration/A/Prefabs/Shared.et", 'GenericEntity {\n ID "1111111111111111"\n}\n');
fixture("integration/B/Prefabs/Shared.et", 'GenericEntity {\n ID "2222222222222222"\n}\n');
fixture("integration/B/Prefabs/Child.et", 'Thing : "{9999999999999999}Prefabs/Shared.et" {\n ID "3333333333333333"\n}\n');
const integrationFilter = fixture("integration/filter.b.json", JSON.stringify({ mods: [{ modId: "BBBBBBBBBBBBBBBB" }] }));

const chainRun = runTool("etconf", ["chain", join(integration, "B", "Prefabs", "Child.et"), "--addons", integration]);
check(
  "etconf chain searches the dependent's addon first: B/Prefabs/Shared.et, not the alphabetical A",
  chainRun.status === 0 && chainRun.out.includes(join("B", "Prefabs", "Shared.et")) && !chainRun.out.includes(join("A", "Prefabs", "Shared.et")),
  chainRun.out,
);
const chainFiltered = runTool("etconf", ["check", "--addons", integration, "--filter-addons-json", integrationFilter, "--json"]);
same("etconf check reads only the addons the filter selected", chainFiltered.json().total, 3);
same("etconf refuses a filter with no --addons (exit 2)", runTool("etconf", ["check", join(integration, "A", "Prefabs", "Shared.et"), "--filter-addons-json", integrationFilter]).status, 2);

// A database per addon: B (the dependent) overrides the GUID with another path. The dependent is
// merged first, so it is the path that wins; the disagreement is counted, not refused.
const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const guidBytes = (hex) => Buffer.from(hex, "hex").reverse();
function rdbEntry({ path, guid }) {
  const bytes = Buffer.from(path, "latin1");
  const meta = path ? [1777368604, 6] : [];
  return Buffer.concat([u32(bytes.length + 1), bytes, Buffer.from([0]), u32(path ? 6 : 5), u16(0), guidBytes(guid), ...meta.map(u32)]);
}
function rdbFile(entries) {
  const header = Buffer.concat([u32(0), u32(0), u32(entries.length + 1)]);
  const body = Buffer.concat([rdbEntry({ path: "", guid: "0000000000000000" }), ...entries.map(rdbEntry)]);
  const size = 20 + header.length + body.length;
  const prologue = Buffer.alloc(20);
  prologue.write("FORM", 0, "latin1");
  prologue.writeUInt32BE(size - 8, 4);
  prologue.write("RDBC", 8, "latin1");
  prologue.writeUInt32LE(7, 12);
  prologue.writeUInt32LE(size, 16);
  return Buffer.concat([prologue, header, body]);
}
const rdbA = join(integration, "A", "resourceDatabase.rdb");
const rdbB = join(integration, "B", "resourceDatabase.rdb");
writeFileSync(rdbA, rdbFile([{ path: "Prefabs/Shared.et", guid: "DDDDDDDDDDDDDDD1" }]));
writeFileSync(rdbB, rdbFile([{ path: "Prefabs/Override.et", guid: "DDDDDDDDDDDDDDD1" }]));
same("the two addon databases disagree on the GUID's path",
  addonRdbDictionary(resolveAddonSet({ addons: [integration] }).order).conflicts.sameGuidDifferentPaths, 1);

const usesGuid = fixture("integration/Uses.et", 'Thing : "{DDDDDDDDDDDDDDD1}Prefabs/Shared.et" {\n ID "4444444444444444"\n}\n');
const refsRun = runTool("etconf", ["refs", usesGuid, "--addons", integration, "--use-addons-rdbs", "--json"]);
same("etconf merges the addon databases in dependency order: the dependent's path wins",
  [refsRun.json().references[0].target, refsRun.json().counts.contradiction, refsRun.json().conflicts.sameGuidDifferentPaths],
  ["Prefabs/Override.et", 1, 1]);

// A minimal EBIN with one GUID in its table: enough for `guids`, which only needs the header.
function ebinBytes(guids) {
  const parts = [Buffer.from("EBIN", "latin1"), u32(1), u16(0), u16(guids.length)];
  for (const guid of guids) parts.push(guidBytes(guid));
  parts.push(Buffer.from([0x00])); // one empty token: the reader refuses a file with no value stream
  return Buffer.concat(parts);
}
const world = join(tmp, "mini.ent");
writeFileSync(world, ebinBytes(["DDDDDDDDDDDDDDD1"]));
const ebinRun = runTool("ebin", ["guids", world, "--addons", integration, "--json"]);
same("ebin --addons resolves through the addon databases, dependent first",
  [ebinRun.json().guids[0].path, ebinRun.json().conflicts.sameGuidDifferentPaths], ["Prefabs/Override.et", 1]);
const ebinFiltered = runTool("ebin", ["guids", world, "--addons", integration, "--filter-addons-json", fixture("integration/filter.a.json", JSON.stringify({ mods: [{ modId: "AAAAAAAAAAAAAAAA" }] })), "--json"]);
same("ebin applies --filter-addons-json before merging", [ebinFiltered.json().guids[0].path, ebinFiltered.json().rdbs.length], ["Prefabs/Shared.et", 1]);
same("ebin refuses --filter-vanilla without a filter", runTool("ebin", ["guids", world, "--addons", integration, "--filter-vanilla"]).status, 1);
const noRdbRoot = join(tmp, "no-rdb");
fixture("no-rdb/A/addon.gproj", gproj("A", "AAAAAAAAAAAAAAAA", []));
const noRdb = runTool("ebin", ["guids", world, "--addons", noRdbRoot]);
same("ebin says when --addons found no database instead of answering unchecked", noRdb.status, 1);
check("the message names the file it looked for", noRdb.err.includes("resourceDatabase.rdb"), noRdb.err);

// layer: the filter narrows the layers a folder contributes.
fixture("integration/A/worlds/A_Layers/default.layer", 'SubScene {\n Parent "{1111111111111111}worlds/A.ent"\n}\n');
fixture("integration/B/worlds/B_Layers/default.layer", 'SubScene {\n Parent "{2222222222222222}worlds/B.ent"\n}\n');
const layerRun = runTool("layer", ["info", "--addons", integration, "--filter-addons-json", integrationFilter, "--json"]);
same("layer reads only the addons the filter selected", layerRun.json().total, 1);
const layerAll = runTool("layer", ["info", "--addons", integration, "--json"]);
same("layer without a filter reads both addons' layers", layerAll.json().total, 2);
same("layer refuses a filter with no --addons", runTool("layer", ["info", "--filter-addons-json", integrationFilter]).status, 2);

// cscript: the filter is how a 200-addon folder becomes the twelve a server runs.
fixture("integration/A/Scripts/Game/A.c", "class SCR_AddonA\n{\n}\n");
fixture("integration/B/Scripts/Game/B.c", "class SCR_AddonB\n{\n}\n");
const scriptFiltered = runTool("cscript", ["find-defs", "SCR_AddonB", "--addons", integration, "--filter-addons-json", integrationFilter, "--json"]);
same("cscript finds a class in the selected addon", scriptFiltered.json().total, 1);
const scriptDropped = runTool("cscript", ["find-defs", "SCR_AddonA", "--addons", integration, "--filter-addons-json", integrationFilter]);
same("cscript does not find a class in a dropped addon", scriptDropped.status, 1);
same("cscript refuses a filter with no --addons", runTool("cscript", ["stats", "--filter-addons-json", integrationFilter]).status, 1);

// ---------------------------------------------------------------------------
rmSync(tmp, { recursive: true, force: true });
console.log(`\n${failures === 0 ? "ALL ADDONS TESTS PASSED" : `${failures} TEST(S) FAILED`}`);
process.exit(failures ? 1 : 0);
