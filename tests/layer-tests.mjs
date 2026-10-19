// Test suite for tools/layer.mjs (a world layer: a sequence of root objects).
//
//   node tests/layer-tests.mjs
//
// The fixture is written here as text, so the suite pins the format a `.layer` really has — several
// roots, the world's `BSP` on one line, the root's name unquoted — rather than a captured project.
// Everything this reader understands about syntax comes from tools/etconf.mjs, and that suite pins
// it; what is pinned *here* is the one thing a layer adds: the roots, and how a command line names
// the one it means.
//
// The CLI is exercised as a real child process with its output written to files, so the suite keeps
// working in sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRoots, lookup, formatValue } from "../tools/etconf.mjs";
import { decodeBsp } from "../tools/bsp.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "layer.mjs");
const tmp = join(root, "tests", ".tmp-layer");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else {
    failures++;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });
process.on("exit", () => rmSync(tmp, { recursive: true, force: true }));

function runCli(args) {
  const outPath = join(tmp, "cli.out");
  const errPath = join(tmp, "cli.err");
  const out = openSync(outPath, "w");
  const err = openSync(errPath, "w");
  let status;
  try {
    status = spawnSync(process.execPath, [tool, ...args], { stdio: ["ignore", out, err] }).status;
  } finally {
    closeSync(out);
    closeSync(err);
  }
  return { status, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8") };
}

/**
 * A three-root layer, shaped like the ones a Workbench project writes: the world entity (BSP and
 * bounds), the terrain, and a map entity with a component and a nested member.
 */
const LAYER = `GenericWorldEntity world {
 BSP 3 0 0 1 2 1 5 -1 -1 2 9 -1 -1
 boundMins -1 0 -1
 boundMaxs 100 20 100
 blockSize 200 2000 200
}
GenericTerrainEntity Terrain {
 Layers 0x411 0
}
SCR_MapEntity MapEntity : "{731564B66F91B107}Prefabs/World/Game/MapEntity.et" {
 coords 153.915 0 99.549
 "Map Geometry Data" "{39936D1DF2F5BC0F}worlds/test.topo"
 components {
  MeshObject "{5872F0EB7FA40561}" {
   Object "{D2A9D0E1C1F1B2A3}Prefabs/Props/Barrels/BarrelGreen_01_Base.et"
  }
 }
}
`;
const layerPath = join(tmp, "w_Layers", "default.layer");
mkdirSync(dirname(layerPath), { recursive: true });
writeFileSync(layerPath, LAYER);

// A single-root layer: the shape etconf.mjs itself reads, where a bare path is unambiguous.
const oneRoot = join(tmp, "one_Layers", "default.layer");
mkdirSync(dirname(oneRoot), { recursive: true });
writeFileSync(oneRoot, "GenericWorldEntity world {\n BSP 3 0 0 1 2 1 5 -1 -1 2 9 -1 -1\n boundMins -1 0 -1\n}\n");

// A BSP whose integers do not form a tree: the count is right, a child index is not.
const brokenPath = join(tmp, "broken_Layers", "default.layer");
mkdirSync(dirname(brokenPath), { recursive: true });
writeFileSync(brokenPath, "GenericWorldEntity world {\n BSP 2 0 0 1 5 1 0 -1 -1\n}\n");

// --- the parser, as the tool uses it ------------------------------------------------------
const roots = parseRoots(readFileSync(layerPath), { name: layerPath, source: layerPath });
check(
  "parseRoots: every root of the layer is read, in file order, with its index",
  roots.length === 3 && roots.map((r) => r.index).join() === "0,1,2"
    && roots[0].className === "GenericWorldEntity" && roots[0].name === "world"
    && roots[1].className === "GenericTerrainEntity" && roots[2].className === "SCR_MapEntity",
  JSON.stringify(roots.map((r) => [r.index, r.className, r.name])),
);
check(
  "the world root's BSP is decoded where the parser leaves it",
  roots[0].block.items.some((i) => i.name === "BSP" && i.value.kind === "bsp" && i.value.count === 3),
);
check(
  "a member after the BSP is still read (the payload does not eat the line)",
  formatValue(lookup(roots[0], "boundMins").value) === "-1 0 -1",
  formatValue(lookup(roots[0], "boundMins").value),
);
check("decodeBsp agrees with the parser's own value", decodeBsp([3, 0, 0, 1, 2, 1, 5, -1, -1, 2, 9, -1, -1]).count === 3);

// --- info ---------------------------------------------------------------------------------
{
  const r = runCli(["info", layerPath]);
  check("info: exits 0 and names every root", r.status === 0 && /@0 GenericWorldEntity "world"/.test(r.out)
    && /@1 GenericTerrainEntity "Terrain"/.test(r.out) && /@2 SCR_MapEntity "MapEntity"/.test(r.out), r.out);
  check("info: the BSP is a node count", /BSP 3 nodes/.test(r.out) && !/integers/.test(r.out), r.out);
  check("info: the component is counted on its root", /@2 .*\n\s+5 member\(s\).*1 component\(s\)/.test(r.out), r.out);

  const j = JSON.parse(runCli(["info", layerPath, "--json"]).out);
  const worldRoot = j.sources[0].roots[0];
  check(
    "info --json: nodes are arrays of four integers, not text",
    worldRoot.bsp.error === null && worldRoot.bsp.count === 3 && worldRoot.bsp.nodes[1].join() === "1,5,-1,-1",
    JSON.stringify(worldRoot.bsp),
  );
  check("info --json: every root carries its index and class", j.sources[0].roots.map((x) => x.index).join() === "0,1,2");
}

// --- tree ---------------------------------------------------------------------------------
{
  const r = runCli(["tree", layerPath, "--root", "1"]);
  check("tree --root: one root, by its index", r.status === 0 && /# @1/.test(r.out) && !/# @0/.test(r.out)
    && /Layers 0x411 0/.test(r.out), r.out);
  const all = runCli(["tree", layerPath, "--depth", "1"]);
  check("tree: every root gets a header", all.status === 0
    && ["# @0", "# @1", "# @2"].every((h) => all.out.includes(h)), all.out);
  check("tree: --root past the last root is an error that lists them", (() => {
    const bad = runCli(["tree", layerPath, "--root", "9"]);
    return bad.status === 1 && /has 3 root\(s\): --root 9 does not exist/.test(bad.err) && /@2 SCR_MapEntity/.test(bad.err);
  })());
  const j = JSON.parse(runCli(["tree", layerPath, "--json"]).out);
  check("tree --json: one tree per root, each with its index", j.roots.length === 3
    && j.roots[0].tree.class === "GenericWorldEntity" && j.roots[2].index === 2);
}

// --- get: the root prefix and the root option --------------------------------------------
{
  const prefixed = runCli(["get", layerPath, "@0/BSP"]);
  check("get: @N names the root a path starts in", prefixed.status === 0 && /@0\/BSP = 3 nodes/.test(prefixed.out), prefixed.out);
  const flagged = runCli(["get", layerPath, "boundMins", "--root", "0"]);
  check("get: --root is the default root for a bare path", flagged.status === 0 && /boundMins = -1 0 -1/.test(flagged.out), flagged.out);
  const nested = runCli(["get", layerPath, "@2/components/#0/Object"]);
  check("get: the path continues into a component", nested.status === 0
    && /Object = "\{D2A9D0E1C1F1B2A3\}Prefabs\/Props\/Barrels\/BarrelGreen_01_Base.et"/.test(nested.out), nested.out);
  const bare = runCli(["get", layerPath, "boundMins"]);
  check(
    "get: a bare path in a multi-root layer is refused, and the message lists the roots",
    bare.status === 1 && /holds 3 roots, so a bare path does not say which one/.test(bare.err)
      && /@0 GenericWorldEntity/.test(bare.err),
    bare.err,
  );
  const beyond = runCli(["get", layerPath, "@9/boundMins"]);
  check("get: a root index that does not exist is an error, not a miss", beyond.status === 1
    && /has 3 root\(s\): @9 does not exist/.test(beyond.err), beyond.err);
  const miss = runCli(["get", layerPath, "@0/nope"]);
  check("get: a path that is not there exits 3", miss.status === 3 && /no "nope"/.test(miss.err), miss.err);
  const kept = runCli(["get", layerPath, "@0/nope", "--missing-ok"]);
  check("get --missing-ok: the same miss exits 0", kept.status === 0);
  const json = JSON.parse(runCli(["get", layerPath, "@0/BSP", "--json"]).out);
  check("get --json: the value is the decoded tree", json.entries[0].root === 0
    && json.entries[0].value.kind === "bsp" && json.entries[0].value.nodes.length === 3);
}

// --- a single-root layer is addressable both ways -----------------------------------------
{
  const bare = runCli(["get", oneRoot, "boundMins"]);
  check("get: a bare path works when there is only one root", bare.status === 0 && /boundMins = -1 0 -1/.test(bare.out), bare.out);
  const prefixed = runCli(["get", oneRoot, "@0/boundMins"]);
  check("get: the same root by @0", prefixed.status === 0);
}

// --- refs, find, cat ----------------------------------------------------------------------
{
  const refs = runCli(["refs", layerPath]);
  check("refs: every reference, with its root, line and member", refs.status === 0
    && /@2\s+\d+\s+"\{731564B66F91B107\}Prefabs\/World\/Game\/MapEntity\.et"/.test(refs.out)
    && /Map Geometry Data/.test(refs.out), refs.out);
  check("refs: a layer with no --rdb says nothing about resolution", !/->/.test(refs.out));
  const j = JSON.parse(runCli(["refs", layerPath, "--json"]).out);
  check("refs --json: rows carry the root index and the reference", j.references.length === 3
    && j.references.every((x) => x.root === 2) && j.references.some((x) => x.path === "worlds/test.topo"),
    JSON.stringify(j.references.map((x) => [x.root, x.path])));

  const found = runCli(["find", layerPath, "Barrel"]);
  check("find: a value nested in a component is found", found.status === 0 && /BarrelGreen_01_Base\.et/.test(found.out), found.out);
  const byName = runCli(["find", layerPath, "boundMaxs", "--in", "name"]);
  check("find --in name: a member name matches", byName.status === 0 && /boundMaxs/.test(byName.out), byName.out);
  const byClass = runCli(["find", layerPath, "MeshObject", "--in", "class"]);
  check("find --in class: a component class matches", byClass.status === 0
    && /class\s+components\/MeshObject = MeshObject/.test(byClass.out), byClass.out);
  const rootName = runCli(["find", layerPath, "world"]);
  check("find: a root's own name is found too", rootName.status === 0 && /@0 = world/.test(rootName.out), rootName.out);

  const cat = runCli(["cat", layerPath, "2"]);
  check("cat: a line range prints those lines", cat.status === 0 && /^ BSP 3 0 0/.test(cat.out), cat.out);
  const numbered = runCli(["cat", layerPath, "2", "--numbers"]);
  check("cat --numbers: the line number is printed beside the line", numbered.status === 0 && /^\s*2 {2} BSP 3/.test(numbered.out), numbered.out);
}

// --- check: a broken BSP is an error, and the tool says why -------------------------------
{
  const clean = runCli(["check", layerPath]);
  check("check: a well-formed layer has no problems", clean.status === 0 && /no problems/.test(clean.out), clean.out);
  const broken = runCli(["check", brokenPath]);
  check(
    "check: a BSP that is not a tree fails, with the decoder's reason",
    broken.status === 1 && /BSP at line 2 holds no tree: .*child 5/.test(broken.out) && /1 error\(s\)/.test(broken.out),
    broken.out,
  );
  const info = runCli(["info", brokenPath]);
  check("info: the same defect is shown in the BSP field", /BSP invalid: .*child 5/.test(info.out), info.out);
  const get = runCli(["get", brokenPath, "@0/BSP"]);
  check("get: an invalid BSP prints the error, never a count", get.status === 0 && /BSP = invalid: .*child 5/.test(get.out), get.out);
}

// --- the command line itself ---------------------------------------------------------------
{
  check("--help exits 0 and prints the usage", (() => {
    const r = runCli(["--help"]);
    return r.status === 0 && /Read a world layer/.test(r.out);
  })());
  check("no arguments is a usage failure: exit 2", runCli([]).status === 2);
  check("an unknown command is a usage failure, and the usage names the real ones", (() => {
    const r = runCli(["nope", layerPath]);
    return r.status === 2 && /unknown command "nope" — info, tree, get, refs, find, check, cat/.test(r.err);
  })());
  check("an option a command does not take is refused", (() => {
    const r = runCli(["cat", layerPath, "--rdb", "x.rdb"]);
    return r.status === 2 && /cat does not take --rdb/.test(r.err);
  })());
  check("a directory source reads every .layer under it", (() => {
    const r = runCli(["info", tmp]);
    return r.status === 0 && /default\.layer: 3 root/.test(r.out) && /default\.layer: 1 root\b/.test(r.out);
  })());
  check("a non-.layer file is refused, naming what reads it", (() => {
    const path = join(tmp, "Prefab.et");
    writeFileSync(path, "Thing {\n}\n");
    const r = runCli(["info", path]);
    return r.status === 1 && /a layer is a \.layer file, and "\.et" is not one/.test(r.err)
      && /it is a prefab: tools\/etconf\.mjs reads it/.test(r.err);
  })());
}

if (failures) {
  console.log(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nALL LAYER TESTS PASSED");
