/**
 * Read an Arma Reforger world **layer** — `worlds/<Name>_Layers/default.layer`.
 *
 * A `.layer` is the text half of a world: the Workbench writes it beside the binary `worlds/<Name>.ent`
 * while the world is being edited, and it is the only place the world's content can be read as text.
 * Everything about the syntax is `tools/etconf.mjs` — one parser, one tokenizer, one set of value
 * shapes — and the one thing this tool adds is the `.layer`'s own difference:
 *
 *     GenericWorldEntity world { BSP 450 1 3120 … boundMins -92.984 0 -98 … }
 *     GenericTerrainEntity Terrain { Layers 0x411 0 }
 *     SCR_MapEntity MapEntity : "{731564B66F91B107}Prefabs/World/Game/MapEntity.et" { coords … }
 *     …
 *
 * — a **sequence of root objects**, where every other extension in this format holds exactly one.
 * `parseText` refuses a file that writes several (a caller that asked for *the* object would silently
 * get the first); `parseRoots`, which this tool is built on, returns them all with their `index`.
 *
 * The roots are addressed three ways, and the name is what says which:
 *
 *   --root N     the default root for every path of one `get` call
 *   @N/…         a path that names its root, `@0/BSP`, `@2/components/MeshObject/Object`
 *   <bare>       the only root of a single-root layer; refused, with the roots listed, when there
 *                are several and neither of the two above said which
 *
 * What this tool does **not** invent: a `.layer` has no resource GUID of its own — the world's is in
 * the `.meta` beside the binary `.ent`, which is what `etconf.mjs chain` reads. So `--guid` takes the
 * **world's** GUID, the database answers `worlds/<Name>.ent`, and the layer is derived from that path
 * (`worlds/<Name>_Layers/default.layer`); a GUID for anything else has no layer and says so. A layer's
 * `BSP` is decoded (see `tools/bsp.mjs`), so `@0/BSP` prints `450 nodes`.
 *
 * Two of the commands are `etconf.mjs`'s own machinery, not a second copy of it: `chain` walks the
 * `:` parents with the exported `inheritance` over a `DocumentLoader`, so a parent in the layer's own
 * `.pak`, in `--pak`, or in a `--addon` project is found by the same rule `etconf chain` uses — and
 * `--addons` contributes its layers as sources with `etconf`'s `documentsUnder`.
 *
 * Exit codes are `etconf.mjs`'s: 0 success, 1 the input is at fault (a document that does not parse,
 * a defect `check` found), 2 the command line, 3 a `get` path that is not there (`--missing-ok`
 * keeps 0). A failure is printed by `etconf.mjs`'s own `reportError`, so under `--json` it is the
 * same `{ ok: false, error: { code, message, source?, line?, hint? } }` every reader in this family
 * prints — `USAGE` for the command line, `PARSE`/`INPUT`/`IO`/`MERGE` for the input.
 */
import { readFileSync, existsSync, statSync } from "node:fs";
import { join, extname, resolve as resolvePath } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parseRoots,
  lookup,
  refsOf,
  checkDocument,
  describe,
  outline,
  treeJson,
  countNodes,
  formatValue,
  formatHead,
  expandSources,
  DocumentLoader,
  loadRdb,
  sourceDescriptor,
  identityOf,
  inheritance,
  ancestorRoots,
  addonDirs,
  addonRoots,
  documentsUnder,
  reportError,
  parseSourceSpec,
} from "./etconf.mjs";
import { checkAddonFilterFlags } from "./addons.mjs";
import { openPak, findEntry } from "./pak.mjs";
import { openRdbFiles, describeMergeProblems } from "./rdb.mjs";

const USAGE = `Read a world layer (.layer): a sequence of root objects, all of them.

  node tools/layer.mjs info  <source>... [--rdb <rdb>]... [--limit N|0] [--json]
  node tools/layer.mjs tree  <source> [--root N] [--depth N] [--limit N|0] [--numbers] [--json]
  node tools/layer.mjs get   <source> <path>... [--root N] [--depth N] [--numbers]
                             [--missing-ok] [--json]
  node tools/layer.mjs refs  <source>... [--rdb <rdb>]... [--check] [--strict] [--limit N|0] [--json]
  node tools/layer.mjs find  <source>... <query> [--regex] [--in name|value|class|all]
                             [--limit N|0] [--json]
  node tools/layer.mjs check <source>... [--rdb <rdb>]... [--strict] [--limit N|0] [--json]
  node tools/layer.mjs chain <source> [--root N] [--rdb <rdb>]... [--pak <pak|dir>]...
                             [--addon <dir>]... [--use-addons-rdbs] [--depth N] [--json]
  node tools/layer.mjs cat   <source> [<lines>] [--lines N] [--numbers]

  <source>   a .layer file on disk, one entry inside a .pak written <pak>:<entry>, or a directory —
             info, refs, find and check read every .layer under it. A layer that a mod ships inside
             its .pak is read the same way: <pak>:worlds/<Name>_Layers/default.layer
             Every command also takes the source as --guid G, which needs --rdb and one of
             --addon/--pak/--addons to say where the layer is. With --guid the source is already
             named, so every positional is a path (get) or the line range (cat): the rule
             etconf.mjs states for the same option.
  --guid G   the layer of the world whose resource GUID is G: --rdb answers its path, then
             <Name>.ent becomes <Name>_Layers/default.layer beside it, and --pak/--addon say where
             to look. A layer has **no GUID of its own** — the world's is in the .meta beside the
             binary .ent — so the GUID given is the world's

A layer holds several roots, and every command names which one it means:

  --root N   the root every path of this call starts in (default: the only root, or 0 for info)
  @N/...     a path that names its root: "get default.layer @0/BSP", "@2/components/#1"

info        every root: class, name, parent, member/element/component counts, references, depth, and
            the BSP tree when it carries one. A level is a root, not a nested object, so this is the
            command that answers "what is in this layer".
tree        an indented outline of every root (or of --root N). The same outline etconf.mjs prints,
            with a root header per object.
get         the value at a path inside one root. A segment is a member name; #N is the N-th entry;
            the root is @N/ or --root. "get --guid <guid> <path>..." has no source word, so every
            positional is a path. A missing path exits 3 (--missing-ok keeps it 0). One value is
            printed to 500 lines and then says so: --json carries it whole.
refs        every "{GUID}path" any root writes, with its root, line and the member that carries it.
            With --rdb the GUID is resolved; a reference whose GUID names another path is marked "!"
            and --check exits 1 on it. An unresolved reference is a warning, and --strict fails it.
find        member names, values and class names matching a query, across every root, case-
            insensitively; --regex and --in narrow it. Every hit says which layer it is in and
            which root of it, and --json puts that layer's index in "source" — @0 exists in every
            layer, so a hit without a source is half an answer.
check       the defects etconf.mjs's check proves for a document — a duplicate member, a malformed ID,
            a BSP whose integers do not form a tree, a reference whose GUID and path disagree — for
            every root. Exits 1 on an error; --strict makes a warning count too.
cat         the file's text as stored. A line range as the second word prints those lines — "cat
            <source> 20", "20-30" (both ends included) or "20-" (to the end), 1-based; with --guid
            the range is the first word. --lines N prints the first N lines instead.
chain       the ":" chain of one root: the prefab a placed entity derives from, that prefab's
            parent, and so on. Same walk and same container search as "etconf chain", so a parent in
            the layer's own .pak, in --pak, or in a --addon project is found. --root N picks the
            root (needed when the layer holds several). A .layer has no resource GUID of its own,
            so step 0 says "(no GUID)" — the prefabs after it carry theirs.

Read are .layer documents. A shipped worlds/<Name>.ent is EBIN — read it with tools/ebin.mjs, which
now decodes the same BSP — and a .et/.conf/.ct/.layout/.meta/.gproj is a one-root document:
tools/etconf.mjs reads those.

Options
  --            end the options: every word after it is a source, a path, a query or a line range, so
                a value that starts with a dash can be named — "find default.layer -- -92.984"
  --root N      the root a path or an outline starts in (default: the only root, else 0 for commands
                that read every root; a bare path in a multi-root layer is refused)
                A path that begins @N/ names its own root, so --root is not applied to it
  --depth N     tree: how many levels to show (0 = no limit); get: how much of a subtree to print
  --limit N     maximum rows or lines (default 100; 0 = every one)
  --lines N     cat: print only the first N lines
  --rdb FILE    a resourceDatabase.rdb to resolve GUIDs through; repeatable, merged in the order
                given — the first database wins, exactly like "rdb merge"
  --guid GUID   read the layer of the world that GUID names instead of a path: the database answers
                the world's path and the layer is derived from it. Repeatable
  --pak PATH    an extra .pak, or a directory of them, to search for a --guid's layer and for the
                parents of chain; repeatable
  --addon DIR   a mod project directory: searched for a --guid's layer and for chain's parents, and a
                place --use-addons-rdbs looks; repeatable
  --addons ROOT every addon under ROOT, in dependency order (the order the addons' own Dependencies
                declare, resolved by tools/addons.mjs): ROOT is itself one addon when it carries a
                .gproj at its top, otherwise its child directories are the addons. Their layers are
                sources for info, check, refs and find, and their directories are searched like
                --addon. Repeatable
  --filter-addons-json FILE
                keep only the addons of --addons whose GUID is a modId in FILE — the game.mods list
                of a server.json. The game is kept whether or not it is listed; --addon is explicit
                and never filtered
  --filter-vanilla
                apply --filter-addons-json to the game and its dependencies as well
  --use-addons-rdbs
                also resolve through the resourceDatabase.rdb beside each addon, after --rdb, in the
                same dependency order
  --in WHERE    find: name, value, class or all (default all)
  --regex       find: the query is a regular expression, matched case-insensitively
  --check       refs: exit 1 on a contradiction
  --strict      refs and check: a warning fails too
  --numbers     tree, get and cat: print the line number beside every row
  --missing-ok  get: exit 0 even when a path is not in the root
  --bsp MODE    what a decoded BSP carries: "count" (the default) is the node count and, when the
                integers are not a tree, the error; "nodes" adds the [[axis, plane, child, child], ...]
                arrays. **AI agents: leave this at count.** A terrain layer's tree is about 1 800
                integers, which as arrays is tens of kilobytes of JSON that have to be read to be
                seen — the count answers "is it there, is it whole" in one line
  --json        machine-readable output; boolean flags honour --compact
`;

// ---------------------------------------------------------------------------
// Errors, flags, sources
// ---------------------------------------------------------------------------

function usageError(message) {
  const err = new Error(message);
  err.code = "USAGE";
  err.usage = true;
  return err;
}

function inputError(message, { hint = null } = {}) {
  const err = new Error(message);
  err.code = "INPUT";
  err.hint = hint;
  return err;
}

function parseArgs(argv) {
  const flags = { _: [], given: [], rdb: [], pak: [], addon: [], addons: [], guid: [] };
  const BOOLEAN = {
    "--json": "json", "--compact": "compact", "--all": "all", "--check": "check", "--strict": "strict",
    "--regex": "regex", "--numbers": "numbers", "--missing-ok": "missingOk", "--no-pak-path-split": "noPakPathSplit",
    "--use-addons-rdbs": "useAddonsRdbs", "--filter-vanilla": "filterVanilla",
  };
  const COUNTED = { "--limit": "limit", "--depth": "depth", "--lines": "lines", "--root": "root" };
  const MULTI = { "--rdb": "rdb", "--pak": "pak", "--addon": "addon", "--addons": "addons", "--guid": "guid" };
  const valueOf = (option, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw usageError(`${option} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--") {
      // Everything after `--` is a word, not an option: a query, a path or a line range that begins
      // with a dash is otherwise unreachable (`find <layer> -- -92.984`, a coordinate in a layer).
      // The family rule — `loc`, `pak`, `ebin` and `addons` all read `--` this way.
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (Object.hasOwn(BOOLEAN, a)) {
      flags[BOOLEAN[a]] = true;
      flags.given.push(BOOLEAN[a]);
    } else if (Object.hasOwn(COUNTED, a)) {
      const raw = valueOf(a, i);
      i++;
      if (!/^\d+$/.test(raw)) throw usageError(`${a} needs a non-negative whole number, not "${raw}"`);
      flags[COUNTED[a]] = Number(raw);
      flags.given.push(COUNTED[a]);
    } else if (Object.hasOwn(MULTI, a)) {
      const raw = valueOf(a, i);
      i++;
      flags[MULTI[a]].push(raw);
      flags.given.push(MULTI[a]);
    } else if (a === "--filter-addons-json") {
      flags.filterAddonsJson = valueOf(a, i);
      i++;
      flags.given.push("filterAddonsJson");
    } else if (a === "--in") {
      const raw = valueOf(a, i);
      i++;
      if (!["name", "value", "class", "all"].includes(raw)) throw usageError(`--in takes name, value, class or all, not "${raw}"`);
      flags.in = raw;
      flags.given.push("in");
    } else if (a === "--bsp") {
      const raw = valueOf(a, i);
      i++;
      // A mode, not a number: `count` and `nodes` are the two shapes a decoded tree can take.
      if (raw !== "count" && raw !== "nodes") throw usageError(`--bsp takes count or nodes, not "${raw}"`);
      flags.bsp = raw;
      flags.given.push("bsp");
    } else if (a === "-h" || a === "--help") flags.help = true;
    else if (a.startsWith("-") && a !== "-") throw usageError(`unknown option "${a}"`);
    else flags._.push(a);
  }
  if (flags.compact) flags.json = true;
  return flags;
}

/**
 * The options that let a source be *found* rather than named: a GUID through a database, and the
 * containers (`--pak`, `--addon`, `--addons`) the file behind it is read out of. They ride together
 * because a GUID without a container, or a container without a GUID, answers nothing.
 */
const CONTAINER_OPTIONS = ["rdb", "pak", "addon", "addons", "filterAddonsJson", "filterVanilla", "useAddonsRdbs", "guid"];

const COMMAND_OPTIONS = {
  info: [...CONTAINER_OPTIONS, "limit", "all"],
  tree: ["root", "depth", "limit", "all", "numbers", ...CONTAINER_OPTIONS],
  get: ["root", "depth", "missingOk", "numbers", ...CONTAINER_OPTIONS],
  refs: [...CONTAINER_OPTIONS, "check", "strict", "limit", "all"],
  find: [...CONTAINER_OPTIONS, "limit", "all", "regex", "in"],
  check: [...CONTAINER_OPTIONS, "strict", "limit", "all"],
  cat: ["lines", "numbers", ...CONTAINER_OPTIONS],
  chain: ["root", "depth", ...CONTAINER_OPTIONS],
};
const GLOBAL_OPTIONS = ["json", "compact", "noPakPathSplit", "bsp"];

function checkOptions(command, flags) {
  const allowed = new Set([...COMMAND_OPTIONS[command], ...GLOBAL_OPTIONS]);
  const spelling = {
    missingOk: "missing-ok",
    noPakPathSplit: "no-pak-path-split",
    useAddonsRdbs: "use-addons-rdbs",
    filterAddonsJson: "filter-addons-json",
    filterVanilla: "filter-vanilla",
  };
  for (const given of flags.given) {
    if (!allowed.has(given)) throw usageError(`${command} does not take --${spelling[given] ?? given}`);
  }
}

function rowLimit(flags, fallback = 100) {
  if (flags.all) return Infinity;
  if (flags.limit === undefined) return fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

/**
 * The layers of every `--addons` child: the folder is a universe and each child is an addon, the rule
 * `etconf.mjs` states for the same option. `--addon` (one project) is a *search* location only —
 * naming it does not silently add fifteen layers to an audit of one.
 */
function addonLayerSpecs(flags) {
  if (!flags.addons?.length) return [];
  const specs = [];
  for (const dir of addonRoots(flags)) specs.push(...documentsUnder(dir, { extensions: [".layer"] }));
  return specs;
}

/**
 * A source the caller typed, checked before `expandSources` reads it.
 *
 * `etconf.mjs` refuses an extension it does not know with its own list — "it reads .et, .conf, .ct,
 * .layout … and a single-root .layer" — which is a true sentence about *that* reader and a false one
 * about this: a caller who mistyped a path was told to try the six formats this tool refuses, and
 * the tool named was not the one running. The same refusal, in this tool's words, names the reader
 * that does read what was handed over.
 */
function assertNamedLayer(spec, flags) {
  const source = parseSourceSpec(spec, { noPakPathSplit: !!flags.noPakPathSplit });
  if (source.kind === "file" && existsSync(source.path) && statSync(source.path).isDirectory()) return;
  const ext = extname(String(source.kind === "pak" ? source.entry : source.path)).toLowerCase();
  if (ext === ".layer") return;
  throw inputError(`${source.display}: a layer is a .layer file, and "${ext || "no extension"}" is not one`, {
    source: source.display,
    hint: ONE_ROOT_HINTS[ext] ?? "a world's layers are worlds/<Name>_Layers/*.layer",
  });
}

/** Every `.layer` a source names — a file, a pak entry, a directory of layers, or a `--guid`. */
function sourcesOf(specs, flags, { multi = false } = {}) {
  // The words the caller typed are checked here, so the refusal is this tool's; `--addons` and
  // `--guid` contribute `.layer` paths by construction and need no such check.
  for (const spec of specs) assertNamedLayer(spec, flags);
  const fromAddons = addonLayerSpecs(flags);
  const named = [...specs, ...fromAddons, ...layerGuidSpecs(flags)];
  // `--addons` was the only thing named and it contributed nothing: an empty answer would look like
  // "these addons have no layers", when the truth is that the folder holds no `.layer` at all.
  if (!named.length && flags.addons?.length) {
    throw inputError(
      `${flags.addons.join(", ")}: no .layer under any addon in it` +
        (flags.filterAddonsJson ? " that --filter-addons-json selected" : ""),
      { hint: "a layer lives in worlds/<Name>_Layers/default.layer inside the addon" },
    );
  }
  const sources = expandSources(named, {
    noPakPathSplit: !!flags.noPakPathSplit,
    multi,
    extensions: [".layer"],
  });
  for (const source of sources) assertLayer(source);
  return sources;
}

/**
 * The layer a resource path has, if it has one: a world writes it beside the binary resource, in
 * `<dir>/<Name>_Layers/default.layer`. A `.layer` names itself; anything else has no layers, which
 * is why a GUID for an `.emat` or a `.xob` is refused rather than searched for.
 *
 * The rule is the Workbench's, measured on the projects of this machine: `worlds/Cain.ent` →
 * `worlds/Cain_Layers/default.layer`, `worlds/InsideDMFFA/CainBase.ent` →
 * `worlds/InsideDMFFA/CainBase_Layers/default.layer`, and `Ruha` ships exactly that shape in a pak.
 */
export function layerPathFor(resourcePath) {
  const text = String(resourcePath ?? "");
  const ext = extname(text).toLowerCase();
  if (ext === ".layer") return text;
  if (ext !== ".ent") return null;
  const cut = text.lastIndexOf("/");
  const dir = cut === -1 ? "" : text.slice(0, cut);
  const base = text.slice(cut + 1).replace(/\.ent$/i, "");
  return `${dir ? `${dir}/` : ""}${base}_Layers/default.layer`;
}

/**
 * Where a layer path lives, asked of a `DocumentLoader` — the same container search `etconf chain`
 * uses (`--addon` first, then the paks, then the directories above the source), so a layer in a
 * mod's `.pak` is found by the same rule that finds a prefab there. Returns a source spec: a file
 * path, or `<pak>:<entry>`.
 */
function findInContainers(loader, resourcePath) {
  for (const container of loader.containers()) {
    if (container.kind === "pak") {
      let entry = null;
      try {
        entry = findEntry(loader.open(container.file), resourcePath);
      } catch {
        entry = null;
      }
      if (entry) return `${container.file}:${entry.path}`;
      continue;
    }
    const candidate = join(container.root, resourcePath);
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate;
  }
  return null;
}

/**
 * `--guid` → the layer of the world that GUID names. A layer has no resource GUID of its own — the
 * world's is in the `.meta` beside the binary `.ent` — so the GUID has to be the world's, and the
 * layer is derived from its path. A GUID the database does not name, one for a non-world, and one
 * whose layer no container has are three different errors, each said in its own words.
 */
function layerGuidSpecs(flags) {
  const guids = flags.guid ?? [];
  if (!guids.length) return [];
  const db = loadRdb(flags);
  if (!db.byGuid) {
    throw usageError("--guid needs a database to turn a GUID into a path: pass --rdb <rdb>, or --use-addons-rdbs with --addon");
  }
  const loader = new DocumentLoader({
    paks: flags.pak ?? [],
    addons: addonDirs(flags),
    roots: [],
    noPakPathSplit: !!flags.noPakPathSplit,
  });
  try {
    return guids.map((raw) => {
      const guid = String(raw).replace(/[{}]/g, "").trim().toUpperCase();
      const path = db.byGuid.get(guid) ?? null;
      if (!path) {
        throw inputError(`no resource has the GUID ${guid}`, {
          source: String(raw),
          hint: "the database[s] given do not name it; --use-addons-rdbs adds the ones beside the addons",
        });
      }
      const layerPath = layerPathFor(path);
      if (!layerPath) {
        throw inputError(`the GUID ${guid} is ${path}, and a resource that is neither a world nor a .layer has no layers`, {
          source: String(raw),
          hint: "a layer belongs to a world: worlds/<Name>.ent with worlds/<Name>_Layers/default.layer beside it",
        });
      }
      const found = findInContainers(loader, layerPath);
      if (!found) {
        throw inputError(`the GUID ${guid} is ${path}, but no container has ${layerPath}`, {
          source: String(raw),
          hint: `searched ${loader.describeSearch()}; pass --pak <pak|dir> or --addon <dir> so the layer can be read`,
        });
      }
      return found;
    });
  } finally {
    loader.close();
  }
}

/**
 * A layer is a `.layer`. `expandSources` accepts every extension this *format* uses, and a `.et`
 * named as a file is read by it deliberately — but it holds one root object, so this tool is not
 * what should answer for it. Refused here, naming the reader that does.
 */
const ONE_ROOT_HINTS = {
  ".et": "it is a prefab: tools/etconf.mjs reads it",
  ".conf": "it is a config: tools/etconf.mjs reads it",
  ".ct": "it is a component template: tools/etconf.mjs reads it",
  ".layout": "it is a UI layout: tools/etconf.mjs reads it",
  ".meta": "it is a resource's identity file: tools/etconf.mjs reads it",
  ".gproj": "it is a Workbench project: tools/etconf.mjs reads it",
  ".ent": "a shipped .ent is EBIN (tools/ebin.mjs); a world's text half is <Name>_Layers/default.layer",
  ".pak": "a .pak is an archive; name one entry inside it: <pak>:<entry>",
};
function assertLayer(source) {
  const name = source.kind === "pak" ? source.entry : source.path;
  const ext = extname(String(name)).toLowerCase();
  if (ext === ".layer") return;
  throw inputError(
    `${source.display}: a layer is a .layer file, and "${ext || "no extension"}" is not one`,
    { hint: ONE_ROOT_HINTS[ext] ?? "a world's layers are worlds/<Name>_Layers/*.layer" },
  );
}

const paks = new Map();
function bytesOf(source) {
  if (source.kind === "pak") {
    const key = resolvePath(source.pak).toLowerCase();
    let pak = paks.get(key);
    if (!pak) {
      pak = openPak(source.pak);
      paks.set(key, pak);
    }
    return pak.read(findEntry(pak, source.entry));
  }
  return readFileSync(source.path);
}

/** One source, parsed: its roots, in file order. */
function loadRoots(source, flags) {
  const bytes = bytesOf(source);
  const roots = parseRoots(bytes, { name: source.display, source: source.display, bsp: flags.bsp });
  return { roots, bytes };
}

/**
 * One source, parsed: the layer a command that answers about *one* layer reads. `--guid` and
 * `--addons` can name it as legitimately as a path can, so the source is whatever the options add
 * up to — and when they add up to more than one, this refuses instead of reading the first and
 * answering about a file nobody named. (A layer folder is the corpus commands' input, not this.)
 */
function loadOne(specs, flags) {
  if (specs.length > 1) throw usageError("this command reads one source; name one .layer");
  const sources = sourcesOf(specs, flags);
  if (!sources.length) {
    throw usageError("this command needs a source: name a .layer file, or --guid <world guid> with --rdb and --addon/--pak");
  }
  if (sources.length > 1) {
    const named = sources.slice(0, 4).map((s) => s.display);
    const rest = sources.length - named.length;
    throw inputError(
      `${named.join(", ")}${rest ? ` and ${rest} more` : ""}: this command reads one source, and that names ${sources.length}`,
      { hint: "name one .layer; --addons is a folder of layers, which only info, refs, find and check read" },
    );
  }
  return { source: sources[0], ...loadRoots(sources[0], flags) };
}

function loadCorpus(specs, flags) {
  const sources = sourcesOf(specs, flags, { multi: true });
  const rows = [];
  const failures = [];
  for (const source of sources) {
    try {
      rows.push({ source, ...loadRoots(source, flags) });
    } catch (err) {
      failures.push({ source: source.display, error: err.message });
    }
  }
  return { rows, failures };
}

function sourceRow(source) {
  return { kind: source.kind, display: source.display, pak: source.pak ?? null, entry: source.entry ?? null, path: source.path ?? null };
}

/**
 * The root a path starts in. `@N/…` names one; without it `--root` decides, and a bare path in a
 * layer that holds several roots is refused rather than guessed at — the first root is a world
 * entity, and a typo that lands there would read as "the member is not here".
 */
function resolveRootPath(path, { roots, flags, source }) {
  const text = String(path);
  const addressed = /^@(\d+)(?:\/([^]*))?$/.exec(text);
  if (addressed) {
    const index = Number(addressed[1]);
    if (index >= roots.length) {
      throw inputError(`${source.display} has ${roots.length} root(s): @${index} does not exist`, { hint: rootList(roots) });
    }
    return { root: roots[index], path: addressed[2] ?? "" };
  }
  if (flags.root !== undefined) {
    if (flags.root >= roots.length) {
      throw inputError(`${source.display} has ${roots.length} root(s): --root ${flags.root} does not exist`, { hint: rootList(roots) });
    }
    return { root: roots[flags.root], path: text };
  }
  if (roots.length === 1) return { root: roots[0], path: text };
  throw inputError(
    `${source.display} holds ${roots.length} roots, so a bare path does not say which one: precede it with @N/ ` +
      "(for example @0/BSP) or give --root N",
    { hint: rootList(roots) },
  );
}

/** One line per root, for a message that has to tell the caller what it could have named. */
function rootList(roots) {
  return roots
    .map((r) => `@${r.index} ${formatHead(r)}`.trim())
    .join("\n");
}

// ---------------------------------------------------------------------------
// Printing helpers
// ---------------------------------------------------------------------------

function printJson(payload, flags) {
  console.log(JSON.stringify(payload, null, flags.compact ? 0 : 2));
}

/** The BSP a root carries, if any: `{ member, count, nodes, error }` — the decoder's own shape. */
function bspOf(root) {
  for (const item of root.block.items) {
    if (item.kind === "member" && item.value?.kind === "bsp") return { member: item.name, ...item.value };
  }
  return null;
}

function footer(flags, total, returned) {
  if (returned < total) console.log(`# ${total} row(s), ${returned} shown — use --limit 0 for every one`);
}

function lineRange(raw, total) {
  const match = /^(\d+)(?:-(\d*))?$/.exec(String(raw));
  if (!match) throw usageError(`cat takes a line range like 20, 20-30 or 20-, not "${raw}"`);
  const from = Number(match[1]);
  if (from < 1) throw usageError(`cat: a line number starts at 1, not ${from}`);
  const to = match[2] === undefined ? from : match[2] === "" ? total : Number(match[2]);
  if (to < from) throw usageError(`cat: the range "${raw}" ends at ${to}, before it starts at ${from}`);
  return { from, to: Math.min(to, total) };
}

/** The inheritance an rdb answers for a GUID, and "!" when it names a different path. */
function rdbOf(flags) {
  if (!flags.rdb.length) return { db: null, byGuid: null, byPath: null, files: [] };
  const opened = openRdbFiles(flags.rdb);
  if (!opened.check.ok) {
    const err = new Error(
      `the databases do not merge: ${describeMergeProblems(opened.check, 3)}. ` +
        `Run \`node tools/rdb.mjs verify-merge ${flags.rdb.map((p) => JSON.stringify(p)).join(" ")}\` for the full list.`,
    );
    err.code = "MERGE";
    throw err;
  }
  const byGuid = new Map();
  const byPath = new Set();
  for (const [guid, found] of opened.merged.map) {
    byGuid.set(guid, found.path);
    byPath.add(found.path.toLowerCase());
  }
  return { db: opened.merged, byGuid, byPath, files: opened.merged.databases.map((d) => d.path ?? d.file ?? null) };
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdInfo(specs, flags) {
  const { rows, failures } = loadCorpus(specs, flags);
  const limit = rowLimit(flags);
  const shown = rows.slice(0, limit === Infinity ? rows.length : limit);
  const total = rows.length + failures.length;
  if (flags.json) {
    printJson({
      sources: shown.map((r) => ({
        ...sourceRow(r.source),
        roots: r.roots.map((root) => {
          const info = describe(root);
          const bsp = bspOf(root);
          return {
            index: root.index,
            line: root.line,
            class: info.className,
            name: info.name,
            parent: info.parent,
            entries: info.entries,
            members: info.members,
            elements: info.elements,
            components: info.components,
            refs: info.refs,
            depth: info.depth,
            bsp: bsp ? { count: bsp.count, nodes: bsp.nodes, error: bsp.error } : null,
            problems: checkDocument(root, { extension: ".layer" }).length,
          };
        }),
      })),
      ...(failures.length ? { parseFailures: failures } : {}),
      total,
      returned: shown.length + failures.length,
      truncated: shown.length < rows.length,
    }, flags);
  } else {
    for (const f of failures) console.error(`FAIL  ${f.source}: ${f.error}`);
    for (const { source, roots } of shown) {
      console.log(`${source.display}: ${roots.length} root${roots.length === 1 ? "" : "s"}`);
      for (const root of roots) {
        const info = describe(root);
        const bsp = bspOf(root);
        const details = `${info.members} member(s), ${info.elements} array element(s)` +
          `${info.components ? `, ${info.components} component(s)` : ""}${info.refs ? `, ${info.refs} reference(s)` : ""}` +
          `${bsp ? `, BSP ${bsp.error ? `invalid: ${bsp.error}` : `${bsp.count} nodes`}` : ""}`;
        console.log(`  @${root.index} ${formatHead(root)}  (line ${root.line})`);
        console.log(`      ${details}`);
      }
    }
    footer(flags, total, shown.length + failures.length);
    if (failures.length) console.log(`# ${failures.length} source(s) could not be read — the exit code is 1`);
  }
  if (failures.length) process.exitCode = 1;
}

function cmdTree(specs, flags) {
  const { source, roots } = loadOne(specs, flags);
  const depth = flags.depth ?? 4;
  const limit = rowLimit(flags);
  const wanted = flags.root === undefined ? roots : [roots[flags.root] ?? null];
  if (wanted.some((r) => r === null)) {
    throw inputError(`${source.display} has ${roots.length} root(s): --root ${flags.root} does not exist`, { hint: rootList(roots) });
  }
  if (flags.json) {
    const budget = { left: limit === Infinity ? Infinity : limit, used: 0, cut: false };
    const trees = wanted.map((root) => ({ index: root.index, tree: treeJson(root, { depth, budget }) }));
    printJson({
      source: sourceRow(source),
      depth,
      total: wanted.reduce((n, root) => n + countNodes(root), 0),
      returned: budget.used,
      truncated: trees.some((t) => t.tree.clipped === true) || budget.cut,
      roots: trees,
    }, flags);
    return;
  }
  // `--limit` is one budget for the call, as it is in the JSON branch above and in every other
  // command: an outline per root with its own budget turns `--limit 100` into 100 lines times the
  // number of roots, which is not a limit a caller can plan with.
  let left = limit;
  for (const [position, root] of wanted.entries()) {
    const out = outline(root, { depth, limit: left, numbers: flags.numbers });
    console.log(`# @${root.index}  (line ${root.line})`);
    for (const line of out.lines) console.log(line);
    if (out.clipped) console.log("# outline truncated — raise --depth, or --limit 0 for every line");
    if (left !== Infinity) left -= out.lines.length;
    // `outline` reads 0 as "no cap", so a spent budget must stop the loop rather than be passed on.
    if (left <= 0 && position < wanted.length - 1) {
      const rest = wanted.length - position - 1;
      console.log(`# --limit ${limit} reached: ${rest} root(s) not shown — use --limit 0 for every one`);
      break;
    }
  }
}

function cmdGet(specs, flags) {
  // `--guid` names the layer, so every positional is a path — the rule `etconf.mjs` states for the
  // same option, because a caller that wrote `get --guid <guid> @0/BSP` has no source word to spare.
  const byGuid = (flags.guid ?? []).length > 0;
  const [sourceSpec, ...rest] = specs;
  const paths = byGuid ? specs : rest;
  if (paths.length === 0 || (!byGuid && sourceSpec === undefined)) {
    throw usageError(
      'get needs a path: get <source> <path>..., or get --guid <guid> <path>..., with "@0/BSP" or --root N ' +
        "when the layer has several roots",
    );
  }
  const { source, roots } = loadOne(byGuid ? [] : [sourceSpec], flags);
  const depth = flags.depth ?? 4;
  const rows = paths.map((path) => {
    const { root, path: inner } = resolveRootPath(path, { roots, flags, source });
    const hit = inner ? lookup(root, inner) : { found: true, value: root, entry: null, missing: null };
    return { path, root, found: hit.found, value: hit.value, line: hit.entry?.line ?? root.line, missing: hit.missing };
  });
  const missing = rows.filter((r) => !r.found);
  if (flags.json) {
    printJson({
      source: sourceRow(source),
      total: rows.length,
      returned: rows.length,
      truncated: false,
      missing: missing.length,
      entries: rows.map((r) => ({
        path: r.path, root: r.root.index, found: r.found, line: r.line, value: r.found ? r.value : null,
      })),
    }, flags);
  } else {
    for (const r of rows) {
      if (!r.found) {
        process.stderr.write(`! ${r.path} — not in @${r.root.index} of ${source.display} (no "${r.missing}")\n`);
        continue;
      }
      const { lines, clipped } = valueLines(r.value, depth);
      const where = flags.numbers ? `  (line ${r.line})` : "";
      if (lines.length === 1) console.log(`${r.path} = ${lines[0]}${where}`);
      else console.log(`${r.path} = ${lines.join("\n")}${where}`);
      // A block stopped at VALUE_LINES still ends in `}`; say so, or the reader takes a truncated
      // value for the whole of it — which is worse than a longer answer.
      if (clipped) {
        console.log(`# ${r.path}: only the first ${VALUE_LINES} line(s) — raise --depth, or read the value with --json`);
      }
    }
  }
  if (missing.length && !flags.missingOk) process.exitCode = 3;
}

/** A `get` prints at most this many lines of one value; beyond it the value is a `--json` question. */
const VALUE_LINES = 500;

/**
 * A value as `get` prints it: one line, or the block it opens — and `clipped`, because a block cut
 * short still ends in a `}` and would otherwise read as the whole thing. `etconf.mjs` owns the
 * shapes; the limit above is this printer's, so `--json` returns the value entire.
 */
function valueLines(value, depth) {
  const block = value && typeof value === "object" && (value.type === "block" || value.type === "object");
  if (!block) return { lines: [formatValue(value)], clipped: false };
  if (!value.items?.length) return { lines: [value.type === "object" ? `${formatHead(value)} { }` : "{ }"], clipped: false };
  const inner = outline(value, { depth: depth === 0 ? 0 : Math.max(1, depth), limit: VALUE_LINES });
  const open = value.type === "object" ? `${formatHead(value)} {` : "{";
  return { lines: [open, ...inner.lines.slice(1), "}"], clipped: inner.clipped };
}

function cmdRefs(specs, flags) {
  const { rows, failures } = loadCorpus(specs, flags);
  const { db, byGuid, byPath } = rdbOf(flags);
  const all = [];
  for (const { source, roots } of rows) {
    for (const root of roots) {
      for (const ref of refsOf(root)) {
        const resolved = byGuid ? byGuid.get(ref.guid) ?? null : null;
        const mismatch = !!resolved && resolved.toLowerCase() !== ref.path.toLowerCase();
        const staled = !resolved && byGuid !== null && byPath.has(ref.path.toLowerCase());
        all.push({ source, root, ref, resolved, mismatch, staled });
      }
    }
  }
  const limit = rowLimit(flags);
  const shown = all.slice(0, limit === Infinity ? all.length : limit);
  const contradictions = all.filter((r) => r.mismatch || r.staled).length;
  const unresolved = all.filter((r) => byGuid !== null && !r.resolved && !r.staled).length;
  if (flags.json) {
    printJson({
      sources: rows.map((r) => sourceRow(r.source)),
      rdbs: db ? db.databases.map((d) => ({ path: d.path ?? null, guids: d.map?.size ?? null })) : [],
      ...(failures.length ? { parseFailures: failures } : {}),
      total: all.length,
      returned: shown.length,
      truncated: shown.length < all.length,
      contradictions,
      unresolved,
      references: shown.map((r) => ({
        source: rows.findIndex((x) => x.source === r.source),
        root: r.root.index,
        line: r.ref.line,
        guid: r.ref.guid,
        path: r.ref.path,
        member: r.ref.member,
        where: r.ref.where,
        quoted: r.ref.quoted,
        resolved: r.resolved,
        ...(r.mismatch ? { mismatch: true } : {}),
        ...(r.staled ? { stale: true } : {}),
      })),
    }, flags);
  } else {
    for (const f of failures) console.error(`FAIL  ${f.source}: ${f.error}`);
    let lastSource = null;
    for (const r of shown) {
      if (r.source !== lastSource) {
        console.log(`\n${r.source.display}`);
        lastSource = r.source;
      }
      const mark = r.mismatch || r.staled ? " !" : "";
      const resolved = r.resolved && r.mismatch ? `  -> ${r.resolved}` : "";
      const stale = r.staled ? `  -> no resource has the GUID ${r.ref.guid}` : "";
      const member = r.ref.member ? `  ${r.ref.member}` : "";
      console.log(`  @${r.root.index} ${String(r.ref.line).padStart(5)}  "{${r.ref.guid}}${r.ref.path}"${mark}${member}${resolved}${stale}`);
    }
    footer(flags, all.length, shown.length);
    if (contradictions) console.log(`# ${contradictions} contradiction(s) between a GUID and its path`);
    if (unresolved) console.log(`# ${unresolved} reference(s) the database does not name (editor-only or removed)`);
    if (failures.length) console.log(`# ${failures.length} source(s) could not be read — the exit code is 1`);
  }
  if (failures.length) process.exitCode = 1;
  if (flags.check && contradictions) process.exitCode = 1;
  if (flags.strict && unresolved) process.exitCode = 1;
}

function cmdFind(specs, flags) {
  if (specs.length < 1) throw usageError("find needs a source and a query: find <source> <query>");
  const query = specs[specs.length - 1];
  const sourceSpecs = specs.slice(0, -1);
  if (!sourceSpecs.length) throw usageError("find needs a source before the query");
  const { rows, failures } = loadCorpus(sourceSpecs, flags);
  const where = flags.in ?? "all";
  let test;
  if (flags.regex) {
    let re;
    try {
      re = new RegExp(query, "i");
    } catch (err) {
      // A pattern the engine refuses is a mistake in the command line, not in the layer: exit 2,
      // like every other bad option, rather than reporting the file as defective.
      throw usageError(`--regex "${query}" is not a regular expression: ${err.message}`);
    }
    test = (s) => re.test(String(s ?? ""));
  } else {
    const needle = query.toLowerCase();
    test = (s) => String(s ?? "").toLowerCase().includes(needle);
  }
  const hits = [];
  const search = (container, root, path, source) => {
    // A root's block and a member's block are the same shape; an `object` value keeps its entries
    // one level down, under `block`, which is why both are read here.
    const items = container.items ?? container.block?.items ?? [];
    for (const [index, item] of items.entries()) {
      const here = item.kind === "member" ? (path ? `${path}/${item.name}` : item.name) : `${path}#${index}`;
      if (where === "all" || where === "class") {
        // A class is written two ways: as an ident in the spec (`Class "…" : "…"`) or as the entry's
        // own name when a slot GUID follows it (`MeshObject "{GUID}"`), which is how a component is
        // written. Both are the class, so both are matched.
        const className = item.value && typeof item.value === "object" && item.value.type === "object"
          ? item.value.className
          : null;
        const specHit = item.spec?.some((t) => t.type === "ident" && test(t.value));
        if (specHit || (className && test(className))) {
          hits.push({ source, root, line: item.line, where: "class", path: here, value: className ?? null });
        }
      }
      if (item.kind === "member") {
        if (where === "all" || where === "name") {
          if (test(item.name)) hits.push({ source, root, line: item.line, where: "name", path: here, value: null });
        }
        if (where === "all" || where === "value") {
          const text = formatValue(item.value);
          if (text && test(text)) hits.push({ source, root, line: item.line, where: "value", path: here, value: text });
        }
      }
      const inner = blockOfValue(item.value);
      if (inner) search(inner, root, here, source);
    }
  };
  // A hit is only half an answer across several layers: `@0` exists in every one of them, so the
  // source index travels with the hit, exactly as it does for `refs`.
  rows.forEach(({ roots }, source) => {
    for (const root of roots) {
      // A root is a level of its own: its class and its name are not members, so they are matched
      // here or a query like "GameMode_Editor_Full1" would find nothing in a layer that is named so.
      if ((where === "all" || where === "class") && test(root.className)) {
        hits.push({ source, root, line: root.line, where: "class", path: `@${root.index}`, value: root.className });
      }
      if ((where === "all" || where === "name") && root.name && test(root.name)) {
        hits.push({ source, root, line: root.line, where: "name", path: `@${root.index}`, value: root.name });
      }
      search(root.block, root, "", source);
    }
  });
  const limit = rowLimit(flags);
  const shown = hits.slice(0, limit === Infinity ? hits.length : limit);
  if (flags.json) {
    printJson({
      sources: rows.map((r) => sourceRow(r.source)),
      query,
      regex: !!flags.regex,
      in: where,
      ...(failures.length ? { parseFailures: failures } : {}),
      total: hits.length,
      returned: shown.length,
      truncated: shown.length < hits.length,
      hits: shown.map((h) => ({ source: h.source, root: h.root.index, line: h.line, in: h.where, path: h.path, value: h.value })),
    }, flags);
  } else {
    for (const f of failures) console.error(`FAIL  ${f.source}: ${f.error}`);
    let lastSource = null;
    let lastRoot = null;
    for (const h of shown) {
      if (h.source !== lastSource) {
        console.log(`\n${rows[h.source].source.display}`);
        lastSource = h.source;
        lastRoot = null;
      }
      if (h.root !== lastRoot) {
        console.log(`\n@${h.root.index} ${formatHead(h.root)}`);
        lastRoot = h.root;
      }
      console.log(`  ${String(h.line).padStart(5)}  ${h.where.padEnd(5)}  ${h.path}${h.value ? ` = ${h.value}` : ""}`);
    }
    footer(flags, hits.length, shown.length);
    if (failures.length) console.log(`# ${failures.length} source(s) could not be read — the exit code is 1`);
  }
  if (failures.length) process.exitCode = 1;
}

function blockOfValue(value) {
  if (!value || typeof value !== "object") return null;
  if (value.type === "block") return value;
  if (value.type === "object") return value.block ?? null;
  return null;
}

function cmdCheck(specs, flags) {
  const { rows, failures } = loadCorpus(specs, flags);
  const { byGuid, byPath } = rdbOf(flags);
  const results = rows.map(({ source, roots }) => ({
    source,
    roots: roots.map((root) => ({
      index: root.index,
      problems: checkDocument(root, { byGuid, byPath, extension: ".layer" }),
    })),
  }));
  const errors = results.reduce((n, r) => n + r.roots.reduce((m, x) => m + x.problems.filter((p) => p.severity === "error").length, 0), 0);
  const warnings = results.reduce((n, r) => n + r.roots.reduce((m, x) => m + x.problems.filter((p) => p.severity !== "error").length, 0), 0);
  const limit = rowLimit(flags);
  if (flags.json) {
    printJson({
      sources: results.slice(0, limit === Infinity ? results.length : limit).map((r) => ({
        ...sourceRow(r.source),
        roots: r.roots.map((x) => ({ index: x.index, problems: x.problems })),
        problems: r.roots.reduce((n, x) => n + x.problems.length, 0),
      })),
      ...(failures.length ? { parseFailures: failures } : {}),
      total: results.length + failures.length,
      returned: Math.min(results.length, limit === Infinity ? results.length : limit) + failures.length,
      truncated: results.length > limit,
      errors,
      warnings,
    }, flags);
  } else {
    for (const f of failures) console.error(`FAIL  ${f.source}: ${f.error}`);
    for (const r of results) {
      const problems = r.roots.flatMap((x) => x.problems);
      if (!problems.length) {
        console.log(`${r.source.display}: ${r.roots.length} root(s), no problems`);
        continue;
      }
      console.log(`${r.source.display}: ${problems.length} problem(s)`);
      for (const p of problems) {
        console.log(`  ${p.severity === "error" ? "ERROR" : "WARN "}  ${p.line ? `line ${p.line}  ` : ""}${p.message}`);
      }
    }
    if (errors || warnings) console.log(`\n${errors} error(s), ${warnings} warning(s)`);
    if (failures.length) console.log(`# ${failures.length} source(s) could not be read`);
  }
  if (failures.length || errors) process.exitCode = 1;
  if (flags.strict && warnings) process.exitCode = 1;
}

/**
 * Which root `chain` walks. One root is unambiguous; several need `--root N`, for the same reason a
 * bare `get` path does — the first root is a world entity and a chain through it is a chain through
 * nothing.
 */
function chainRoot(roots, flags, source) {
  if (flags.root !== undefined) {
    if (flags.root >= roots.length) {
      throw inputError(`${source.display} has ${roots.length} root(s): --root ${flags.root} does not exist`, { hint: rootList(roots) });
    }
    return flags.root;
  }
  if (roots.length === 1) return 0;
  throw inputError(
    `${source.display} holds ${roots.length} roots, so chain does not know which to follow: give --root N`,
    { hint: rootList(roots) },
  );
}

/**
 * The `:` chain of one root: the prefab it derives from, that prefab's parent, and so on — the same
 * walk `etconf chain` does, over the same loader, so a mod's `.pak` and an addon directory on disk
 * are searched by one rule. What it cannot do is name the layer's **own** resource: a `.layer` has
 * no resource GUID (the world's is in the `.meta` beside the binary `.ent`), so step 0 says so.
 */
function cmdChain(specs, flags) {
  const { source, roots } = loadOne(specs, flags);
  const db = loadRdb(flags);
  const addons = addonDirs(flags);
  const ancestors = source.path ? ancestorRoots(source.path) : [];
  const loader = new DocumentLoader({
    paks: [source.pak, ...(flags.pak ?? [])].filter(Boolean),
    addons,
    roots: ancestors,
    noPakPathSplit: !!flags.noPakPathSplit,
  });
  try {
    const index = chainRoot(roots, flags, source);
    const self = { ...sourceDescriptor(source, addons), path: `${source.display} @${index}`, resourcePath: null };
    const result = inheritance(roots[index], {
      load: (path) => loader.load(path),
      resolve: db.byGuid ? (guid) => db.byGuid.get(guid) ?? null : null,
      max: flags.depth ?? 64,
      self,
      identify: (loaded) => identityOf(loaded, db),
      copies: (loaded) =>
        loaded.resourcePath
          ? loader.loadAll(loaded.resourcePath).map((copy) => ({ parent: copy.doc.parent, container: copy.container }))
          : [],
      where: () => `${loader.describeSearch()}; pass --pak <pak|dir> or --addon <dir> to search more`,
    });
    if (flags.json) {
      printJson({
        source: sourceRow(source),
        root: index,
        rdbs: db.files,
        ...(db.shadowed ? { shadowed: db.shadowed } : {}),
        total: result.rows.length,
        returned: result.rows.length,
        truncated: result.truncated,
        problems: result.problems,
        warnings: result.warnings,
        chain: result.rows.map((r) => ({
          depth: r.depth,
          path: r.path,
          class: r.className,
          guid: r.identity?.guid ?? null,
          rdbs: r.identity?.rdbs ?? [],
          memberId: r.memberId,
          parent: r.parent,
          via: r.via,
        })),
      }, flags);
    } else {
      const strip = (filePath) => {
        if (!source.pak) return filePath;
        const prefix = `${source.pak}:`;
        return filePath.startsWith(prefix) ? filePath.slice(prefix.length) : filePath;
      };
      const multi = db.multi ?? false;
      console.log(`# @${index} of ${source.display}`);
      for (const r of result.rows) {
        const pad = "  ".repeat(r.depth);
        const guid = r.identity ? `  {${r.identity.guid}}` : "  (no GUID)";
        const rdbs = multi && r.identity?.rdbs?.length ? `  rdb ${r.identity.rdbs.map((i) => i + 1).join(",")}` : "";
        const via = r.depth > 0 && r.via === "path" && db.byGuid ? "  (path)" : "";
        console.log(`${pad}${r.className ?? "?"}  ${strip(r.path)}${guid}${rdbs}${via}`);
      }
      for (const p of result.problems) console.log(`[${p.severity}] ${p.message}`);
      console.log(`${result.rows.length} step(s) in the chain${result.truncated ? " — raise --depth for more" : ""}`);
      // Step 0 is the layer, which has no GUID of its own by design (its row says so), and a step the
      // walk could not find is already an `[error]` above. Counting either as "pass --rdb for the
      // prefabs" sends the caller to a flag that cannot help, so only the prefabs that were found
      // and carry no GUID are counted.
      const unidentified = result.rows.filter((r) => r.depth > 0 && r.className !== null && !r.identity).length;
      if (unidentified) {
        console.log(`# ${unidentified} step(s) without a resource GUID — pass --rdb, or --use-addons-rdbs, so the prefabs carry theirs`);
      }
    }
    if (result.problems.some((p) => p.severity === "error")) process.exitCode = 1;
  } finally {
    loader.close();
  }
}

function cmdCat(specs, flags) {
  // With `--guid` the layer is already named, so one positional is the line range — the same rule as
  // `get`'s paths, and the reason `cat --guid <guid> 20-30` means what it says instead of refusing.
  const byGuid = (flags.guid ?? []).length > 0;
  if (byGuid && specs.length > 1) {
    throw usageError("cat takes one line range with --guid: cat --guid <guid> [<lines>]");
  }
  if (!byGuid && specs.length > 2) {
    throw usageError("cat takes one source and optionally a line range: cat <source> [<lines>]");
  }
  const sourceSpec = byGuid ? undefined : specs[0];
  const range = byGuid ? specs[0] : specs[1];
  if (range !== undefined && flags.lines !== undefined) throw usageError("cat takes a range or --lines, not both");
  const { source } = loadOne(sourceSpec === undefined ? [] : [sourceSpec], flags);
  const text = bytesOf(source).toString("utf8");
  const lines = text.split("\n");
  let wanted = lines;
  let from = 1;
  let to = lines.length;
  if (range !== undefined) {
    ({ from, to } = lineRange(range, lines.length));
    wanted = lines.slice(from - 1, to);
  } else if (flags.lines !== undefined) {
    wanted = lines.slice(0, flags.lines);
    to = wanted.length;
  }
  if (flags.json) {
    printJson({ source: sourceRow(source), from, to, total: lines.length, returned: wanted.length, truncated: wanted.length < lines.length, text: wanted.join("\n") }, flags);
    return;
  }
  if (flags.numbers) {
    const width = String(lines.length).length;
    const numbered = wanted.map((line, k) => `${String(from + k).padStart(width)}  ${line}`);
    process.stdout.write(numbered.join("\n"));
  } else process.stdout.write(wanted.join("\n"));
  if (range === undefined && wanted.length < lines.length) {
    process.stdout.write(`\n# ${lines.length} lines, ${wanted.length} shown\n`);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

function main() {
  const argv = process.argv.slice(2);
  // `--json` is read from the raw arguments too: a command line that does not parse still has to
  // answer in the shape the caller asked for, and by then there are no flags to ask.
  const jsonWanted = argv.includes("--json");
  const compactWanted = argv.includes("--compact");
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    reportError(err, { json: jsonWanted || compactWanted, compact: compactWanted, tool: "layer" });
    return;
  }
  if (flags.help) {
    process.stdout.write(USAGE);
    return;
  }
  if (flags._.length === 0) {
    process.stderr.write(USAGE);
    process.exitCode = 2;
    return;
  }
  const [command, ...rest] = flags._;
  const commands = {
    info: cmdInfo, tree: cmdTree, get: cmdGet, refs: cmdRefs, find: cmdFind, check: cmdCheck, chain: cmdChain, cat: cmdCat,
  };
  const handler = commands[command];
  if (!handler) {
    reportError(usageError(`unknown command "${command}" — ${Object.keys(commands).join(", ")}`), {
      json: flags.json, compact: flags.compact, tool: "layer",
    });
    return;
  }
  try {
    checkOptions(command, flags);
    checkAddonFilterFlags(flags);
    handler(rest, flags);
  } catch (err) {
    reportError(err, { json: flags.json, compact: flags.compact, tool: "layer" });
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main();
