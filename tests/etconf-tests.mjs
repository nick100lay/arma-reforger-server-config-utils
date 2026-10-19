// Test suite for tools/etconf.mjs (the `.et` / `.conf` / `.ct` reader).
//
//   node tests/etconf-tests.mjs
//
// The fixtures are written here as text, so the suite pins the *format rules* rather than a
// captured prefab: the game's own files live inside 2 GB .pak archives and cannot be committed, and
// a captured file would pin one build's content instead of the reader's decisions. What is pinned,
// and why each one is worth a test:
//   * one entry per line decides member from array element — the one assumption the format forces
//     on a reader, because a value's arity lives in the class schema, not in the file;
//   * a quoted string that is followed on its line by anything is a *name* (`"Sort Priority" -100`),
//     one that stands alone is an *element* — and a quoted GUID is a value (`ID "…"`), never the
//     slot of an object that never opens;
//   * `\\"` inside a string is an escaped quote written double-escaped, and `\` after the closing
//     quote continues the value in the next string — the same two rules as `tools/loc.mjs`, which
//     is why one test reads a StringTableRuntime fixture with this parser;
//   * `{GUID}path` is a reference, `{GUID}` alone is a component slot, and a string that merely
//     starts with a GUID (`<image path="{GUID}x.imageset"/>`) is neither;
//   * the root may carry its own resource reference (`Class "{GUID}ownpath" : "…"`), which 33
//     shipped files do and which is identity, not a reference;
//   * `check` distinguishes the two ways a reference can be wrong: a GUID that names another file
//     (an error — 10 such references ship in the vanilla data) and a GUID no resource has (a
//     warning — 32 do, for editor-only assets);
//   * why `check` does *not* report a repeated `Building { … }` as a duplicate member: a block that
//     is itself an element is a child list, where repetition is the point.
//
// The CLI is exercised as a real child process with its output written to files, so the suite
// keeps working in sandboxes that forbid piped stdio.
import { spawnSync } from "node:child_process";
import { writeFileSync, mkdirSync, rmSync, readFileSync, openSync, closeSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readRdb } from "../tools/rdb.mjs";
import {
  parseText,
  tokenize,
  lookup,
  refsOf,
  componentsOf,
  classify,
  depthOf,
  describe,
  checkDocument,
  outline,
  treeJson,
  formatValue,
  formatEntry,
  entryLabel,
  inheritance,
  ancestorRoots,
  metaOf,
  identityOf,
  parseSourceSpec,
  openDocuments,
  ConfSyntaxError,
  EXTENSIONS,
} from "../tools/etconf.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tool = join(root, "tools", "etconf.mjs");
const tmp = join(root, "tests", ".tmp-etconf");

let failures = 0;
function check(what, ok, detail = "") {
  if (ok) console.log(`OK    ${what}`);
  else {
    failures++;
    console.log(`FAIL  ${what}${detail ? ` -- ${detail}` : ""}`);
  }
}

/** Write a fixture and return its path. `\.` cases are quoted from the game on purpose. */
function fixture(name, text, { bom = false, crlf = false } = {}) {
  const body = crlf ? text.replace(/\n/g, "\r\n") : text;
  const prefix = bom ? Buffer.from([0xef, 0xbb, 0xbf]) : Buffer.alloc(0);
  const path = join(tmp, name);
  writeFileSync(path, Buffer.concat([prefix, Buffer.from(body, "utf8")]));
  return path;
}

/** Run the CLI, with stdout and stderr going to files rather than to pipes. */
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
  return { status, out: readFileSync(outPath, "utf8"), err: readFileSync(errPath, "utf8") };
}

/** `true` when parsing throws a ConfSyntaxError whose message contains `needle` and a position. */
function refuses(what, text, needle, options) {
  try {
    parseText(text, options);
    check(what, false, "parsed without complaint");
  } catch (err) {
    check(
      what,
      err instanceof ConfSyntaxError && err.message.includes(needle) && /line \d+, column \d+/.test(err.message),
      `${err.name}: ${err.message}`,
    );
  }
}

rmSync(tmp, { recursive: true, force: true });
mkdirSync(join(tmp, "Prefabs"), { recursive: true });

// --- a prefab with (almost) everything a prefab has --------------------------------------
const basePath = join(tmp, "Prefabs", "Base.et");
writeFileSync(
  basePath,
  [
    "GenericEntity {",
    ' ID "1111111111111111"',
    " components {",
    '  MeshObject "{5872F0EB7FA40561}" {',
    '   Object "{D73D5FE0EEFBCD9B}Assets/Props/Barrel.xob"',
    "  }",
    " }",
    "}",
    "",
  ].join("\n"),
);

const prefab = `StaticModelEntity : "{4CC2C69DE1AEF103}Prefabs/Base.et" {
 ID "F0DBA538AC2A0552"
 components {
  MeshObject "{5872F0EB7FA40561}" {
   Object "{D73D5FE0EEFBCD9B}Assets/Props/Barrel.xob"
  }
  RigidBody "{5872F0EB7DFB5A9D}" {
   ResponseIndex "SmallDestructible"
   Static 1
  }
  SCR_SlotCompositionComponent "{5706EA5AE72F1280}" : "{F27DCA13BB9C3F3B}Prefabs/Editor/Components/SlotCompositionComponent.ct" {
   m_bOrientChildrenToTerrain 0
  }
 }
 Flags 0x80503 0
 coords 0 0 0
 angles 0 71.177 0
 "Sort Priority" -100
 ParentContextList +{
 }
 m_aHitZoneGroups {
  DRIVE_TRAIN
  FUEL_TANKS
 }
 m_aFactionLimits {
  SCR_FactionLimit "{693688C8C928FEBB}" {
   m_sFactionKey "FIA"
   m_iFactionLimit 0
  }
 }
 m_ModelPrefabs {
  "{1D9FAE5FB8B01383}Assets/Props/Barrel_dst_01.xob"
 }
 m_eMaterialSoundType BREAK_METAL
}`;
const prefabPath = join(tmp, "Prefabs", "Prefab.et");
writeFileSync(prefabPath, prefab);

const doc = parseText(readFileSync(prefabPath), { name: "Prefab.et", source: prefabPath });
check("root: class, parent, ID", doc.className === "StaticModelEntity" && doc.parent.guid === "4CC2C69DE1AEF103", doc.className);
check("root: the parent path is kept next to the GUID", doc.parent.path === "Prefabs/Base.et", doc.parent.path);
check("root: has no self reference", doc.self === null);
check("root: bytes and lines are counted", doc.bytes > 0 && doc.lines >= 20, `${doc.bytes} bytes, ${doc.lines} lines`);

// A world `.layer` writes the root's name **unquoted** — `GenericWorldEntity world { … }` — which is
// the one shape `.et`, `.conf`, `.ct`, `.layout`, `.meta` and `.gproj` do not use.
const layerDoc = parseText("GenericWorldEntity world {\n boundMins -92.984 0 -98\n SkyPreset \"{621C…}Sky.emat\"\n}\n");
check(
  "a root may name itself unquoted, which is what a .layer writes",
  layerDoc.className === "GenericWorldEntity" && layerDoc.name === "world" && formatValue(lookup(layerDoc, "boundMins").value) === "-92.984 0 -98",
  JSON.stringify([layerDoc.className, layerDoc.name]),
);
refuses(
  "a second root object is refused, and the refusal names the rule",
  "GenericWorldEntity world {\n}\nGenericTerrainEntity Terrain {\n}\n",
  "holds one object",
);

// --- members and values ------------------------------------------------------------------
check("ID is a string value, not a GUID token that opens an object", formatValue(lookup(doc, "ID").value) === '"F0DBA538AC2A0552"');
check("a bit mask keeps its two words", formatValue(lookup(doc, "Flags").value) === "0x80503 0", formatValue(lookup(doc, "Flags").value));
check("a vector is three numbers", formatValue(lookup(doc, "angles").value) === "0 71.177 0");
check("a quoted member name works like any other", formatValue(lookup(doc, '"Sort Priority"').value) === "-100");
check("an enum value is an identifier", formatValue(lookup(doc, "m_eMaterialSoundType").value) === "BREAK_METAL");
check("`+` is recorded as an append", lookup(doc, "ParentContextList").entry.append === true);
check(
  "an array of enums is a list of elements",
  (() => {
    const block = lookup(doc, "m_aHitZoneGroups").value;
    return classify(block) === "array" && block.items.map((x) => x.value.value).join(",") === "DRIVE_TRAIN,FUEL_TANKS";
  })(),
  JSON.stringify(classify(lookup(doc, "m_aHitZoneGroups").value)),
);
check(
  "an array of objects keeps the class and the slot GUID",
  (() => {
    const hit = lookup(doc, "m_aFactionLimits/#0");
    return hit.found && hit.value.type === "object" && hit.value.className === "SCR_FactionLimit" && hit.value.guid === "693688C8C928FEBB";
  })(),
);
check("a block of members classifies as an object", classify(lookup(doc, "components/RigidBody").value) === "object");
check("the components block classifies as objects", classify(lookup(doc, "components").value) === "objects");

// --- paths -------------------------------------------------------------------------------
check("a nested path walks members", lookup(doc, "components/RigidBody/Static").value.value === 1);
check(
  "a repeated name can be indexed, and the first wins without an index",
  (() => {
    const repeated = parseText('Thing {\n m_sX "a"\n m_sX "b"\n}', { name: "rep.et" });
    return lookup(repeated, "m_sX").value.value === "a" && lookup(repeated, "m_sX[1]").value.value === "b";
  })(),
);
check("a position in a block can be indexed", lookup(doc, "m_aFactionLimits/#0/m_sFactionKey").value.value === "FIA");
check("an empty path is the document itself", lookup(doc, "").value === doc);
check("a missing path says which segment failed", lookup(doc, "components/Nope/X").missing === "Nope");

// --- components --------------------------------------------------------------------------
const components = componentsOf(doc);
check("three components, in file order", components.length === 3 && components[0].className === "MeshObject", JSON.stringify(components.map((c) => c.className)));
check("each component carries its slot GUID", components[0].guid === "5872F0EB7FA40561");
check("a component derived from a .ct says so", components[2].derived?.path === "Prefabs/Editor/Components/SlotCompositionComponent.ct");
check("a prefab with no components block yields none", componentsOf(parseText("Thing { }", { name: "x.et" })).length === 0);

// --- references --------------------------------------------------------------------------
const refs = refsOf(doc);
check("four references: parent, object, derivation, element", refs.length === 4, JSON.stringify(refs.map((r) => r.where)));
check("the root parent is a derivation", refs[0].where === "derivation" && refs[0].member === "");
check("`Object` is a value reference", refs.some((r) => r.where === "value" && r.path.endsWith("Barrel.xob")));
check("a component deriving from a .ct is a derivation", refs.some((r) => r.where === "derivation" && r.path.endsWith(".ct")));
check("an array element is an element reference", refs.some((r) => r.where === "element" && r.path.endsWith("Barrel_dst_01.xob")));
check("every reference in this fixture is quoted", refs.every((r) => r.quoted));

// --- a document that names itself --------------------------------------------------------
const selfNamed = parseText(
  'StaticModelEntity "{143046CEE500BC8B}PrefabLibrary/Runway_Letter_C.et" : "{A4C667C34B917CE3}Prefabs/Runway_Letter_C.et" {\n ID "51B2A74AA6B6A383"\n}',
  { name: "self.et", source: "self.et" },
);
check(
  "a root self reference is identity: doc.self, not a reference",
  selfNamed.self.guid === "143046CEE500BC8B" && selfNamed.self.path === "PrefabLibrary/Runway_Letter_C.et" && refsOf(selfNamed).length === 1,
);
check("the self reference is not the parent", selfNamed.parent.guid === "A4C667C34B917CE3");

// --- slot GUID versus resource reference -------------------------------------------------
const slots = parseText('Thing {\n components {\n  MeshObject "{5872F0EB7FA40561}" {\n  }\n }\n}', { name: "slot.et" });
check("a GUID with no path is a slot, not a reference", refsOf(slots).length === 0 && componentsOf(slots)[0].guid === "5872F0EB7FA40561");

// --- strings: escapes, markup, continuations ---------------------------------------------
const escapes = parseText(
  [
    "Thing {",
    ' m_sNewline "a\\nb"',
    ' m_sQuote "say \\"hi\\""',
    ' m_sMarkup "<color rgba=\\\\"226,168,79,255\\\\">Player List</color>"',
    ' m_sLiteral "\\u1f600 stays"',
    ' m_aText "first piece"\\',
    '  "second piece"',
    "}",
  ].join("\n"),
  { name: "strings.et" },
);
check("\\n in a string is a newline", lookup(escapes, "m_sNewline").value.value === "a\nb", JSON.stringify(lookup(escapes, "m_sNewline").value.value));
check('\\" is a quote', lookup(escapes, "m_sQuote").value.value === 'say "hi"', JSON.stringify(lookup(escapes, "m_sQuote").value.value));
check(
  "a double-escaped quote reads as the writer meant it",
  lookup(escapes, "m_sMarkup").value.value === '<color rgba=\\"226,168,79,255\\">Player List</color>',
  JSON.stringify(lookup(escapes, "m_sMarkup").value.value),
);
check("an unknown escape stays verbatim", lookup(escapes, "m_sLiteral").value.value === "\\u1f600 stays");
check(
  "a \\ after the closing quote continues the value",
  lookup(escapes, "m_aText").value.value === "first piecesecond piece" && lookup(escapes, "m_aText").value.pieces === 2,
  JSON.stringify(lookup(escapes, "m_aText").value),
);

// The same rules as tools/loc.mjs: this reader sees a StringTableRuntime as two arrays of strings.
const table = parseText(
  [
    "StringTableRuntime {",
    " Ids {",
    '  "AR-One"',
    '  "AR-Two"',
    " }",
    " Texts {",
    '  "First"\\',
    '  " and second"',
    '  "Second"',
    " }",
    "}",
  ].join("\n"),
  { name: "table.en_us.conf" },
);
check(
  "a string table reads as two arrays, with the continuation joined",
  (() => {
    const ids = lookup(table, "Ids").value.items.length;
    const texts = lookup(table, "Texts").value.items.map((x) => x.value.value);
    return ids === 2 && texts.length === 2 && texts[0] === "First and second" && texts[1] === "Second";
  })(),
  JSON.stringify(lookup(table, "Texts").value.items.map((x) => x.value)),
);

// --- markup that only looks like a reference ---------------------------------------------
const markup = parseText('Thing {\n m_sIcon "<image path=\\"{1872FFA1133724A2}UI/Textures/Chat/chat.imageset\\"/>"\n }', { name: "markup.conf" });
check(
  "a string that only starts with a GUID is not a reference",
  refsOf(markup).length === 0 && lookup(markup, "m_sIcon").value.kind === "string",
  JSON.stringify(lookup(markup, "m_sIcon").value),
);

// --- an unquoted reference is read, and warned about -------------------------------------
const unquoted = parseText("Thing : {4CC2C69DE1AEF103}Prefabs/Base.et {\n}", { name: "unquoted.et" });
check("an unquoted reference is still read", unquoted.parent.guid === "4CC2C69DE1AEF103");
check(
  "an unquoted reference is a warning, not a silent read",
  checkDocument(unquoted).some((p) => p.severity === "warning" && p.message.includes("unquoted reference")),
);

// --- CRLF and BOM ------------------------------------------------------------------------
const crlf = fixture("crlf.et", 'Thing {\n ID "ABCDEF0123456789"\n}\n', { crlf: true });
check("a CRLF file parses", parseText(readFileSync(crlf), { name: "crlf.et" }).className === "Thing");
const bom = fixture("bom.et", "Thing {\n}\n", { bom: true });
check("a BOM is skipped", parseText(readFileSync(bom), { name: "bom.et" }).className === "Thing");

// --- what the reader refuses -------------------------------------------------------------
refuses("refused: a file that ends inside a block", 'Thing {\n ID "x"\n', "unterminated block");
refuses("refused: a member with a parent but no block", 'Thing {\n coords : "{1111111111111111}X.et"\n}\n', "has no value");
check(
  "an ident alone on a line is an array element, not a member — nothing in the file says which",
  (() => {
    const lone = parseText('Thing {\n m_aGroups {\n  DRIVE_TRAIN\n }\n}', { name: "lone.et" });
    return lookup(lone, "m_aGroups").value.items[0].kind === "element" && lookup(lone, "m_aGroups").value.items[0].value.value === "DRIVE_TRAIN";
  })(),
);
refuses("refused: content after the root block", "Thing {\n}\nMore {\n}\n", "after the closing brace");
refuses("refused: an empty file", "", "the file is empty");
refuses("refused: a string across a line break", 'Thing {\n m_s "a\n b"\n}\n', "runs across a line break");
refuses("refused: a value that is not a number", "Thing {\n m_i 1.2.3\n}\n", "is not a number");
refuses("refused: a class that is missing", "{\n}", "expected an object class");
refuses("refused: a stray character", "Thing {\n m_i 1 %\n}\n", "unexpected character");
try {
  parseText("Thing {\n");
  check("a syntax error is a ConfSyntaxError with a line", false);
} catch (err) {
  check("a syntax error is a ConfSyntaxError with a line", err instanceof ConfSyntaxError && err.line === 1 && err.column > 0, `${err.name} ${err.line}:${err.column}`);
}

// --- check: duplicates, child lists, IDs, references --------------------------------------
const childList = parseText(
  'GenericEntity {\n {\n  Building {\n   ID "1111111111111111"\n  }\n  Building {\n   ID "2222222222222222"\n  }\n }\n}',
  { name: "children.et" },
);
check(
  "a child list may repeat a class name — that is not a duplicate member",
  checkDocument(childList).length === 0,
  JSON.stringify(checkDocument(childList)),
);
const duplicated = parseText('Thing {\n ID "1"\n ID "2"\n}', { name: "dup.et" });
check(
  "a member defined twice in one block is an error",
  checkDocument(duplicated).some((p) => p.severity === "error" && p.message.includes("duplicate member")),
);
const badId = parseText('Thing {\n ID "4BB674EA9B89118"\n}', { name: "badid.et" });
check(
  "an ID that is not 16 hex digits is a warning",
  checkDocument(badId).some((p) => p.severity === "warning" && p.message.includes("not 16 hexadecimal")),
);

const byGuid = new Map([
  ["4CC2C69DE1AEF103", "Prefabs/Base.et"],
  ["0169C2E0E4C4E31C", "Prefabs/Other.et"],
]);
const byPath = new Map([
  ["prefabs/base.et", "4CC2C69DE1AEF103"],
  ["prefabs/other.et", "0169C2E0E4C4E31C"],
]);
const contradicting = parseText('Thing : "{4CC2C69DE1AEF103}Prefabs/Other.et" {\n}', { name: "contra.et" });
const contradictingProblems = checkDocument(contradicting, { byGuid, byPath });
check(
  "a GUID that names another file than its path is an error",
  contradictingProblems.some((p) => p.severity === "error" && p.message.includes('names "Prefabs/Base.et"')),
  JSON.stringify(contradictingProblems),
);
const unknownGuid = parseText('Thing : "{9999999999999999}Prefabs/Gone.et" {\n}', { name: "gone.et" });
check(
  "a GUID no resource has is a warning — the asset may simply not ship",
  checkDocument(unknownGuid, { byGuid, byPath }).some((p) => p.severity === "warning" && p.message.includes("neither the GUID nor the path")),
);
const selfWrong = parseText('Thing "{9999999999999999}Prefabs/Thing.et" {\n}', { name: "selfwrong.et" });
check(
  "a self reference the database contradicts is an error",
  checkDocument(selfWrong, { byGuid, byPath }).some((p) => p.severity === "error" && p.message.includes("names itself")),
);

// --- describe, depth, outline, tree ------------------------------------------------------
const described = describe(doc);
check(
  "describe counts what the summary prints",
  described.className === "StaticModelEntity" &&
    described.components === 3 &&
    described.componentsWithSlot === 3 &&
    described.componentsDerived === 1 &&
    described.refs === 4 &&
    described.entries === doc.block.items.length,
  JSON.stringify(described),
);
check("depthOf counts nesting levels", depthOf(doc) === 3, String(depthOf(doc)));
check(
  "outline stops at the depth it is given and says so",
  (() => {
    const shallow = outline(doc, { depth: 2 });
    return shallow.clipped && shallow.lines.some((l) => l.includes("item(s)"));
  })(),
);
check(
  "outline caps the lines and says so",
  (() => {
    const capped = outline(doc, { depth: 0, limit: 3 });
    return capped.clipped && capped.lines.length === 3;
  })(),
);
check(
  "outline's first line is the object head",
  outline(doc).lines[0].startsWith('StaticModelEntity : "{4CC2C69DE1AEF103}Prefabs/Base.et"'),
  outline(doc).lines[0],
);
check(
  "treeJson carries the same shape, with the parent beside the GUID",
  treeJson(doc, { depth: 1 }).parent.path === "Prefabs/Base.et" && treeJson(doc, { depth: 1 }).entries[1].value.clipped === true,
);
check("formatEntry spells an entry the way the file does", formatEntry(lookup(doc, "m_aFactionLimits/#0").entry) === 'SCR_FactionLimit "{693688C8C928FEBB}"');
check("entryLabel adds a scalar value", entryLabel(lookup(doc, "Flags").entry) === "Flags 0x80503 0");

// --- sources: the <pak>:<entry> rule -----------------------------------------------------
check("a plain path stays a file", parseSourceSpec("C:\\dir\\X.et").kind === "file");
check(
  "<pak>:<entry> splits at the last colon",
  (() => {
    const spec = parseSourceSpec("C:\\dir\\data007.pak:Prefabs/X.et");
    return spec.kind === "pak" && spec.pak === "C:\\dir\\data007.pak" && spec.entry === "Prefabs/X.et";
  })(),
);
check("--no-pak never splits", parseSourceSpec("C:\\dir\\data007.pak:Prefabs/X.et", { noPak: true }).kind === "file");
check("the extensions are declared", EXTENSIONS.join(",") === ".et,.conf,.ct");
check("tokenize exposes the tokens a parser would need", tokenize("A {\n B 1\n}").map((t) => t.type).join(" ") === "ident { ident int }");

// --- inheritance through a chain of files ------------------------------------------------
writeFileSync(join(tmp, "Chain1.et"), 'GenericEntity : "{1111111111111111}Prefabs/Chain2.et" {\n ID "1"\n}\n');
writeFileSync(join(tmp, "Chain2.et"), 'GenericEntity : "{2222222222222222}Prefabs/Chain3.et" {\n ID "2"\n}\n');
writeFileSync(join(tmp, "Chain3.et"), 'GenericEntity {\n ID "3"\n}\n');
const loadFile = (path) => {
  const file = join(tmp, path.split("/").pop());
  try {
    return { path: file, doc: parseText(readFileSync(file), { name: file, source: file }) };
  } catch {
    return null;
  }
};
const chain = inheritance(parseText(readFileSync(join(tmp, "Chain1.et")), { name: "Chain1.et", source: join(tmp, "Chain1.et") }), { load: loadFile });
check("the chain is followed to the base", chain.rows.length === 3 && chain.rows[2].className === "GenericEntity", JSON.stringify(chain.rows.map((r) => r.path)));
check("a missing parent is an error, not a silent stop", inheritance(parseText(readFileSync(join(tmp, "Chain1.et")), { name: "Chain1.et" }), { load: () => null }).problems.some((p) => p.severity === "error"));
writeFileSync(join(tmp, "Loop.et"), 'GenericEntity : "{1111111111111111}Prefabs/Loop.et" {\n}\n');
const loopDoc = parseText(readFileSync(join(tmp, "Loop.et")), { name: "Loop.et", source: join(tmp, "Loop.et") });
check(
  "the chain reports the cycle instead of looping",
  inheritance(loopDoc, { load: () => ({ path: join(tmp, "Loop.et"), doc: loopDoc }) }).problems.some((p) => p.message.includes("loops back")),
);
check(
  "a database contradiction is reported, and the GUID followed",
  (() => {
    const start = parseText('GenericEntity : "{1111111111111111}Prefabs/Wrong.et" {\n}', { name: "start.et", source: "start.et" });
    const result = inheritance(start, {
      resolve: () => "Prefabs/Right.et",
      load: (path) => ({ path, doc: parseText("GenericEntity {\n}", { name: path, source: path }) }),
    });
    return result.rows[1].path === "Prefabs/Right.et" && result.problems.some((p) => p.severity === "warning");
  })(),
);
check(
  "a max the caller asked for truncates the chain, and is not an error",
  (() => {
    const start = parseText('GenericEntity : "{1111111111111111}Prefabs/Chain2.et" {\n}', { name: "start.et", source: "start.et" });
    const result = inheritance(start, { max: 1, load: loadFile });
    return (
      result.truncated === true &&
      result.rows.length === 2 &&
      result.problems.every((p) => p.severity !== "error") &&
      result.problems.some((p) => p.severity === "info")
    );
  })(),
);
check(
  "a chain that cannot be followed is an error, and truncated stays false",
  (() => {
    const start = parseText('GenericEntity : "{1111111111111111}Prefabs/Missing.et" {\n}', { name: "start.et", source: "start.et" });
    const result = inheritance(start, { load: () => null });
    return result.truncated === false && result.problems.some((p) => p.severity === "error" && p.message.includes("was not found"));
  })(),
);
check("ancestorRoots starts at the file's own folder", ancestorRoots(join(tmp, "Prefabs", "X.et"))[0].toLowerCase().endsWith("prefabs"));

// --- a real .rdb, built here, so the CLI's --rdb path is exercised ------------------------
const u16 = (n) => {
  const b = Buffer.alloc(2);
  b.writeUInt16LE(n);
  return b;
};
const u32 = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return b;
};
const guidBytes = (hex) => Buffer.from(hex, "hex").reverse();
const u32be = (n) => {
  const b = Buffer.alloc(4);
  b.writeUInt32BE(n);
  return b;
};
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
const rdbPath = join(tmp, "test.rdb");
writeFileSync(
  rdbPath,
  rdbFile([
    { path: "Prefabs/Base.et", guid: "4CC2C69DE1AEF103" },
    { path: "Prefabs/Editor/Components/SlotCompositionComponent.ct", guid: "F27DCA13BB9C3F3B" },
  ]),
);
check("the fixture database is readable by rdb.mjs", readRdb(readFileSync(rdbPath)).get("4CC2C69DE1AEF103") === "Prefabs/Base.et");

// --- CLI ---------------------------------------------------------------------------------
const info = runCli(["info", prefabPath]);
check("cli info: one line per source, class first", info.status === 0 && info.out.includes("StaticModelEntity, parent"), info.out.split("\n")[0]);
const infoJson = JSON.parse(runCli(["info", prefabPath, "--json"]).out);
check("cli info --json: an envelope with the counts", infoJson.sources[0].components === 3 && infoJson.sources[0].refs === 4, JSON.stringify(infoJson.sources[0]));

const tree = runCli(["tree", prefabPath, "--depth", "2"]);
check("cli tree: depth 2 stops early and says so", tree.status === 0 && tree.out.includes("# outline truncated"), tree.out.split("\n")[1]);
check("cli tree --json: truncated is honest", JSON.parse(runCli(["tree", prefabPath, "--depth", "1", "--json"]).out).truncated === true);

const got = runCli(["get", prefabPath, "components/RigidBody/Static", "components/MeshObject/Object"]);
check(
  "cli get: two paths, two lines",
  got.status === 0 && got.out.includes("components/RigidBody/Static = 1") && got.out.includes("Barrel.xob"),
  got.out,
);
const gotMissing = runCli(["get", prefabPath, "nope"]);
check("cli get: a missing path exits 1", gotMissing.status === 1 && gotMissing.err.includes("not in"), `${gotMissing.status}`);
check("cli get: --missing-ok keeps it 0", runCli(["get", prefabPath, "nope", "--missing-ok"]).status === 0);

const componentsOut = runCli(["components", prefabPath]);
check("cli components: class and slot per line", componentsOut.status === 0 && /MeshObject\s+\{5872F0EB7FA40561\}/.test(componentsOut.out), componentsOut.out);

const refsOut = runCli(["refs", prefabPath, "--rdb", rdbPath]);
check(
  "cli refs --rdb: resolves what the database holds and counts the rest",
  refsOut.status === 0 && refsOut.out.includes("2 ok, 0 contradict the database, 2 unresolved"),
  refsOut.out,
);
check("cli refs: without --rdb it says so", runCli(["refs", prefabPath]).out.includes("pass --rdb to resolve them"));

const contraPath = fixture("Contra.et", 'Thing : "{4CC2C69DE1AEF103}Prefabs/Other.et" {\n}\n');
const contraCheck = runCli(["check", contraPath, "--rdb", rdbPath]);
check("cli check --rdb: a contradiction fails and names both paths", contraCheck.status === 1 && contraCheck.out.includes("Prefabs/Base.et"), contraCheck.out);
check("cli check: a clean file exits 0", runCli(["check", prefabPath]).status === 0);
check("cli refs --check: a contradiction exits 1", runCli(["refs", contraPath, "--rdb", rdbPath, "--check"]).status === 1);

const chainOut = runCli(["chain", prefabPath]);
check(
  "cli chain: walks to the base through the project directories above the file",
  chainOut.status === 0 && chainOut.out.includes("Base.et") && chainOut.out.includes("2 step(s)"),
  chainOut.out,
);
writeFileSync(join(tmp, "Prefabs", "Depth1.et"), 'GenericEntity : "{1111111111111111}Prefabs/Depth2.et" {\n ID "1"\n}\n');
writeFileSync(join(tmp, "Prefabs", "Depth2.et"), 'GenericEntity : "{2222222222222222}Prefabs/Depth3.et" {\n ID "2"\n}\n');
writeFileSync(join(tmp, "Prefabs", "Depth3.et"), 'GenericEntity {\n ID "3"\n}\n');
const chainCapped = runCli(["chain", join(tmp, "Prefabs", "Depth1.et"), "--depth", "1"]);
check(
  "cli chain --depth: a limit truncates and still exits 0",
  chainCapped.status === 0 && chainCapped.out.includes("raise --depth for more"),
  `${chainCapped.status} ${chainCapped.out}`,
);
const chainJson = JSON.parse(runCli(["chain", prefabPath, "--json"]).out);
check("cli chain --json: the envelope says truncated", chainJson.truncated === false && chainJson.chain.length === 2, JSON.stringify(chainJson.chain));
const chainMissing = runCli(["chain", contraPath]);
check(
  "cli chain: a parent that is not there exits 1 and names it",
  chainMissing.status === 1 && chainMissing.out.includes("was not found"),
  chainMissing.out,
);

const found = runCli(["find", prefabPath, "Barrel", "--limit", "3"]);
check("cli find: finds a reference by its path", found.status === 0 && found.out.includes("Barrel.xob"), found.out);
const foundName = runCli(["find", prefabPath, "Static", "--in", "name"]);
check("cli find --in name: only member names", foundName.status === 0 && foundName.out.includes("Static 1"), foundName.out);

const cat = runCli(["cat", prefabPath, "--lines", "2"]);
check("cli cat: the first lines, and a count of the rest", cat.status === 0 && cat.out.includes('ID "F0DBA538AC2A0552"') && cat.out.includes("lines,"), cat.out);

// --- CLI misuse --------------------------------------------------------------------------
check("cli: no arguments prints the usage and exits 1", runCli([]).status === 1 && runCli([]).err.includes("Read Arma Reforger text resources"));
check("cli: --help exits 0", runCli(["--help"]).status === 0);
check("cli: an unknown option is refused", runCli(["info", prefabPath, "--nope"]).status === 1);
check(
  "cli: an option the command does not take is refused",
  runCli(["info", prefabPath, "--limit", "3"]).status === 1 && runCli(["info", prefabPath, "--limit", "3"]).err.includes("does not take"),
);
check("cli: a missing file is reported", runCli(["info", join(tmp, "nope.et")]).status === 1);
check("cli: a directory is not a source", runCli(["info", tmp]).status === 1);
check("cli: get without a path explains itself", runCli(["get", prefabPath]).status === 1);
check("cli: --in takes only four words", runCli(["find", prefabPath, "x", "--in", "nope"]).status === 1);
check(
  "cli: a parse error names the line and column",
  (() => {
    const bad = fixture("Bad.et", "Thing {\n m_i 1 %\n}\n");
    const run = runCli(["info", bad]);
    return run.status === 1 && /line 2, column/.test(run.err);
  })(),
);

// --- a source inside a .pak --------------------------------------------------------------
// A tiny PAC1 archive written here: FORM/PAC1, HEAD, DATA (one stored entry), FILE (the tree).
function pakFile(entries) {
  const head = Buffer.alloc(28);
  const dataStart = 12 + 8 + 28 + 8;
  const nodes = [];
  let offset = 0;
  for (const { path, bytes } of entries) {
    nodes.push(
      Buffer.concat([
        Buffer.from([1, Buffer.byteLength(path)]),
        Buffer.from(path, "utf8"),
        u32(dataStart + offset),
        u32(bytes.length),
        u32(bytes.length),
        u32(0),
        Buffer.from([0, 0, 0, 0]),
        u32(0),
      ]),
    );
    offset += bytes.length;
  }
  const data = Buffer.concat(entries.map((e) => e.bytes));
  const tree = Buffer.concat([Buffer.from([0, 0]), u32(entries.length), ...nodes]);
  const body = Buffer.concat([
    Buffer.from("FORM", "latin1"),
    u32(0),
    Buffer.from("PAC1", "latin1"),
    Buffer.from("HEAD", "latin1"),
    u32be(head.length),
    head,
    Buffer.from("DATA", "latin1"),
    u32be(data.length),
    data,
    Buffer.from("FILE", "latin1"),
    u32be(tree.length),
    tree,
  ]);
  body.writeUInt32BE(body.length - 8, 4);
  return body;
}
const pakPath = join(tmp, "data.pak");
writeFileSync(
  pakPath,
  pakFile([{ path: "Prefabs/InPak.et", bytes: Buffer.from('Thing : "{4CC2C69DE1AEF103}Prefabs/Base.et" {\n ID "1111111111111111"\n}\n', "utf8") }]),
);
const [inPak] = openDocuments([`${pakPath}:Prefabs/InPak.et`]);
check("a source inside a .pak is read by the library", inPak.doc.className === "Thing" && inPak.source.kind === "pak", JSON.stringify(inPak.source));
const inPakCli = runCli(["info", `${pakPath}:Prefabs/InPak.et`]);
check("a source inside a .pak is read by the CLI", inPakCli.status === 0 && inPakCli.out.includes("Thing"), inPakCli.err || inPakCli.out);
check(
  "a pak entry that does not exist is reported by name",
  (() => {
    const run = runCli(["info", `${pakPath}:Nope.et`]);
    return run.status === 1 && run.err.includes('no entry "Nope.et"');
  })(),
);

// --- identity, the database order and the parent rule ------------------------------------
// `chain` used to print each step's `ID` member. A derived prefab *inherits* that member, so a
// vanilla chain printed one value for every step — the identity of a step is its **resource GUID**,
// which lives in `resourceDatabase.rdb` or in the `.meta` a Workbench project keeps beside a file.
const libDir = join(tmp, "lib");
const projDir = join(tmp, "project");
mkdirSync(join(libDir, "Prefabs"), { recursive: true });
mkdirSync(join(projDir, "Prefabs"), { recursive: true });
/** The `.meta` a Workbench project writes: `Name "{GUID}path"`, plus the platform variants. */
function meta(file, guid, path) {
  writeFileSync(
    `${file}.meta`,
    [
      "MetaFileClass {",
      ` Name "{${guid}}${path}"`,
      " Configurations {",
      "  EntityTemplateResourceClass PC {",
      "  }",
      "  EntityTemplateResourceClass XBOX_ONE : PC {",
      "  }",
      " }",
      "}",
      "",
    ].join("\n"),
  );
}
const libEt = join(libDir, "Prefabs", "Lib.et");
writeFileSync(libEt, 'GenericEntity {\n ID "1111111111111111"\n}\n');
meta(libEt, "AAAAAAAAAAAAAAA1", "Prefabs/Lib.et");
const childEt = join(projDir, "Prefabs", "Child.et");
writeFileSync(childEt, 'Thing : "{AAAAAAAAAAAAAAA1}Prefabs/Lib.et" {\n ID "1111111111111111"\n}\n');
meta(childEt, "AAAAAAAAAAAAAAA2", "Prefabs/Child.et");

check(
  "a .meta beside a file is the identity a project has",
  metaOf(childEt)?.guid === "AAAAAAAAAAAAAAA2" && metaOf(join(tmp, "nope.et")) === null,
);
const noAddon = runCli(["chain", childEt]);
check(
  "cli chain: a parent outside the source's own tree is not found, and says so",
  noAddon.status === 1 && noAddon.out.includes("was not found") && noAddon.out.includes("{AAAAAAAAAAAAAAA2}"),
  noAddon.out,
);
const withAddon = runCli(["chain", childEt, "--addon", libDir]);
check(
  "cli chain --addon: a project directory is searched for parents",
  withAddon.status === 0 && withAddon.out.includes("2 step(s)") && withAddon.out.includes("{AAAAAAAAAAAAAAA1}"),
  `${withAddon.status} ${withAddon.out}`,
);
check(
  "cli chain: every step is shown by its own GUID, never by the inherited ID member",
  withAddon.out.includes("{AAAAAAAAAAAAAAA2}") &&
    withAddon.out.includes("{AAAAAAAAAAAAAAA1}") &&
    !withAddon.out.includes("1111111111111111"),
  withAddon.out,
);

const modRdb = join(tmp, "mod.rdb");
const baseRdb = join(tmp, "base.rdb");
const twoResources = [
  { path: "Prefabs/Child.et", guid: "AAAAAAAAAAAAAAA2" },
  { path: "Prefabs/Lib.et", guid: "AAAAAAAAAAAAAAA1" },
];
writeFileSync(modRdb, rdbFile(twoResources));
writeFileSync(baseRdb, rdbFile(twoResources));
const ordered = runCli(["chain", childEt, "--addon", libDir, "--rdb", modRdb, "--rdb", baseRdb]);
check(
  "cli chain: --rdb merges in the order given and names the databases that declare each resource",
  ordered.status === 0 && ordered.out.includes("rdb 1,2"),
  ordered.out,
);
check(
  "cli chain: one database has nothing to order, so no index is printed",
  !runCli(["chain", childEt, "--addon", libDir, "--rdb", modRdb]).out.includes("rdb 1"),
);
writeFileSync(join(tmp, "broken.rdb"), rdbFile([
  { path: "Prefabs/Lib.et", guid: "AAAAAAAAAAAAAAA1" },
  { path: "Prefabs/Elsewhere.et", guid: "AAAAAAAAAAAAAAA1" },
]));
const broken = runCli(["chain", childEt, "--rdb", modRdb, "--rdb", join(tmp, "broken.rdb")]);
check(
  "cli: a set of databases that does not merge is refused, not answered from one of them",
  broken.status === 1 && broken.err.includes("do not merge"),
  broken.err,
);
check(
  "cli info --rdb: the resource GUID is reported, the ID member is labelled as one",
  (() => {
    const run = runCli(["info", childEt, "--rdb", modRdb]);
    return run.status === 0 && run.out.includes("resource {AAAAAAAAAAAAAAA2}") && run.out.includes("not the resource identity");
  })(),
);

// Two copies of one resource that name different parents: which one applies depends on mount
// order, so the chain is ambiguous and the walk stops with an error.
const dupPak = join(tmp, "dupa.pak");
const dupPak2 = join(tmp, "dupb.pak");
const dupSource = (guid, path) => Buffer.from(`Thing : "{${guid}}${path}" {\n ID "2222222222222222"\n}\n`, "utf8");
writeFileSync(dupPak, pakFile([{ path: "Prefabs/Dup.et", bytes: dupSource("4CC2C69DE1AEF103", "Prefabs/Base.et") }]));
writeFileSync(dupPak2, pakFile([{ path: "Prefabs/Dup.et", bytes: dupSource("F27DCA13BB9C3F3B", "Prefabs/Other.et") }]));
writeFileSync(join(projDir, "Prefabs", "Dup.et"), dupSource("4CC2C69DE1AEF103", "Prefabs/Base.et"));
const useDup = join(projDir, "Prefabs", "UseDup.et");
writeFileSync(useDup, 'Thing : "{BBBBBBBBBBBBBBB1}Prefabs/Dup.et" {\n ID "2222222222222222"\n}\n');
writeFileSync(join(tmp, "dup.rdb"), rdbFile([{ path: "Prefabs/Dup.et", guid: "BBBBBBBBBBBBBBB1" }]));
writeFileSync(join(tmp, "dup2.rdb"), rdbFile([{ path: "Prefabs/Dup.et", guid: "BBBBBBBBBBBBBBB1" }]));
const twoParents = runCli(["chain", useDup, "--pak", dupPak, "--pak", dupPak2, "--rdb", join(tmp, "dup.rdb"), "--rdb", join(tmp, "dup2.rdb")]);
check(
  "cli chain: two copies of one resource with different parents stop the walk",
  twoParents.status === 1 &&
    twoParents.out.includes("Multiple parents detected at {BBBBBBBBBBBBBBB1}Prefabs/Dup.et in rdbs 1,2") &&
    twoParents.out.includes("Prefabs/Base.et") &&
    twoParents.out.includes("Prefabs/Other.et"),
  `${twoParents.status} ${twoParents.out}`,
);
check(
  "cli chain: the walk stops at the ambiguous step instead of walking on",
  twoParents.out.includes("2 step(s) in the chain"),
  twoParents.out,
);
const oneParent = runCli(["chain", useDup, "--pak", dupPak, "--addon", projDir]);
check(
  "cli chain: the same parent in both copies is not an ambiguity",
  oneParent.status === 0 && oneParent.out.includes("step(s) in the chain") && !oneParent.out.includes("Multiple parents"),
  `${oneParent.status} ${oneParent.out}`,
);
writeFileSync(join(projDir, "Prefabs", "Dup.et"), dupSource("F27DCA13BB9C3F3B", "Prefabs/Other.et"));
const noRdbParents = runCli(["chain", useDup, "--addon", projDir, "--pak", dupPak]);
check(
  "cli chain: without databases the copies are named by their containers",
  noRdbParents.status === 1 &&
    noRdbParents.out.includes("Multiple parents detected at") &&
    !noRdbParents.out.includes("in rdbs") &&
    noRdbParents.out.includes("dupa.pak"),
  noRdbParents.out,
);

// --- summary -----------------------------------------------------------------------------
rmSync(tmp, { recursive: true, force: true });
console.log(failures === 0 ? "\nALL ETCONF TESTS PASSED" : `\n${failures} ETCONF TEST(S) FAILED`);
if (failures) process.exitCode = 1;

