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
 * Exit codes are `etconf.mjs`'s: 0 success, 1 the input is at fault (a document that does not parse,
 * a defect `check` found), 2 the command line, 3 a `get` path that is not there (`--missing-ok`
 * keeps 0).
 */
import { readFileSync } from "node:fs";
import { extname, resolve as resolvePath } from "node:path";
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
} from "./etconf.mjs";
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
  node tools/layer.mjs cat   <source> [<lines>] [--lines N] [--numbers]

  <source>   a .layer file on disk, one entry inside a .pak written <pak>:<entry>, or a directory —
             info, refs, find and check read every .layer under it. A layer that a mod ships inside
             its .pak is read the same way: <pak>:worlds/<Name>_Layers/default.layer

A layer holds several roots, and every command names which one it means:

  --root N   the root every path of this call starts in (default: the only root, or 0 for info)
  @N/...     a path that names its root: "get default.layer @0/BSP", "@2/components/#1"

info        every root: class, name, parent, member/element/component counts, references, depth, and
            the BSP tree when it carries one. A level is a root, not a nested object, so this is the
            command that answers "what is in this layer".
tree        an indented outline of every root (or of --root N). The same outline etconf.mjs prints,
            with a root header per object.
get         the value at a path inside one root. A segment is a member name; #N is the N-th entry;
            the root is @N/ or --root. A missing path exits 3 (--missing-ok keeps it 0).
refs        every "{GUID}path" any root writes, with its root, line and the member that carries it.
            With --rdb the GUID is resolved; a reference whose GUID names another path is marked "!"
            and --check exits 1 on it. An unresolved reference is a warning, and --strict fails it.
find        member names, values and class names matching a query, across every root, case-
            insensitively; --regex and --in narrow it.
check       the defects etconf.mjs's check proves for a document — a duplicate member, a malformed ID,
            a BSP whose integers do not form a tree, a reference whose GUID and path disagree — for
            every root. Exits 1 on an error; --strict makes a warning count too.
cat         the file's text as stored. A line range as the second word prints those lines — "cat
            <source> 20", "20-30" (both ends included) or "20-" (to the end), 1-based. --lines N
            prints the first N lines instead.

Read are .layer documents. A shipped worlds/<Name>.ent is EBIN — read it with tools/ebin.mjs, which
now decodes the same BSP — and a .et/.conf/.ct/.layout/.meta/.gproj is a one-root document:
tools/etconf.mjs reads those.

Options
  --root N      the root a path or an outline starts in (default: the only root, else 0 for commands
                that read every root; a bare path in a multi-root layer is refused)
  --depth N     tree: how many levels to show (0 = no limit); get: how much of a subtree to print
  --limit N     maximum rows or lines (default 100; 0 = every one)
  --lines N     cat: print only the first N lines
  --rdb FILE    a resourceDatabase.rdb to resolve GUIDs through; repeatable, merged in the order
                given — the first database wins, exactly like "rdb merge"
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
  const flags = { _: [], given: [], rdb: [] };
  const BOOLEAN = {
    "--json": "json", "--compact": "compact", "--all": "all", "--check": "check", "--strict": "strict",
    "--regex": "regex", "--numbers": "numbers", "--missing-ok": "missingOk", "--no-pak-path-split": "noPakPathSplit",
  };
  const COUNTED = { "--limit": "limit", "--depth": "depth", "--lines": "lines", "--root": "root" };
  const MULTI = { "--rdb": "rdb" };
  const valueOf = (option, i) => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith("--")) throw usageError(`${option} needs a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
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

const COMMAND_OPTIONS = {
  info: ["rdb", "limit", "all"],
  tree: ["root", "depth", "limit", "all", "numbers"],
  get: ["root", "depth", "missingOk", "numbers"],
  refs: ["rdb", "check", "strict", "limit", "all"],
  find: ["limit", "all", "regex", "in"],
  check: ["rdb", "strict", "limit", "all"],
  cat: ["lines", "numbers"],
};
const GLOBAL_OPTIONS = ["json", "compact", "noPakPathSplit", "bsp"];

function checkOptions(command, flags) {
  const allowed = new Set([...COMMAND_OPTIONS[command], ...GLOBAL_OPTIONS]);
  for (const given of flags.given) {
    if (!allowed.has(given)) throw usageError(`${command} does not take --${given === "missingOk" ? "missing-ok" : given}`);
  }
}

function rowLimit(flags, fallback = 100) {
  if (flags.all) return Infinity;
  if (flags.limit === undefined) return fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

/** Every `.layer` a source names — a file, a pak entry, or a directory of layers. */
function sourcesOf(specs, flags, { multi = false } = {}) {
  const sources = expandSources(specs, {
    noPakPathSplit: !!flags.noPakPathSplit,
    multi,
    extensions: [".layer"],
  });
  for (const source of sources) assertLayer(source);
  return sources;
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

function loadOne(specs, flags) {
  if (specs.length > 1) throw usageError("this command reads one source; name one .layer");
  const [source] = sourcesOf(specs, flags);
  if (!source) throw usageError("this command needs a source: name a .layer file");
  return { source, ...loadRoots(source, flags) };
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
  for (const root of wanted) {
    const out = outline(root, { depth, limit, numbers: flags.numbers });
    console.log(`# @${root.index}  (line ${root.line})`);
    for (const line of out.lines) console.log(line);
    if (out.clipped) console.log("# outline truncated — raise --depth, or --limit 0 for every line");
  }
}

function cmdGet(specs, flags) {
  const [sourceSpec, ...paths] = specs;
  if (sourceSpec === undefined || paths.length === 0) {
    throw usageError('get needs a path: get <source> <path>..., with "@0/BSP" or --root N when the layer has several roots');
  }
  const { source, roots } = loadOne([sourceSpec], flags);
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
      const lines = valueLines(r.value, depth);
      const where = flags.numbers ? `  (line ${r.line})` : "";
      if (lines.length === 1) console.log(`${r.path} = ${lines[0]}${where}`);
      else console.log(`${r.path} = ${lines.join("\n")}${where}`);
    }
  }
  if (missing.length && !flags.missingOk) process.exitCode = 3;
}

/** A value as `get` prints it: one line, or the block it opens. `etconf.mjs` owns the shapes. */
function valueLines(value, depth) {
  const block = value && typeof value === "object" && (value.type === "block" || value.type === "object");
  if (!block) return [formatValue(value)];
  if (!value.items?.length) return [value.type === "object" ? `${formatHead(value)} { }` : "{ }"];
  const inner = outline(value, { depth: depth === 0 ? 0 : Math.max(1, depth), limit: 500 });
  const open = value.type === "object" ? `${formatHead(value)} {` : "{";
  return [open, ...inner.lines.slice(1), "}"];
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
    const re = new RegExp(query, "i");
    test = (s) => re.test(String(s ?? ""));
  } else {
    const needle = query.toLowerCase();
    test = (s) => String(s ?? "").toLowerCase().includes(needle);
  }
  const hits = [];
  const search = (container, root, path) => {
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
          hits.push({ root, line: item.line, where: "class", path: here, value: className ?? null });
        }
      }
      if (item.kind === "member") {
        if (where === "all" || where === "name") {
          if (test(item.name)) hits.push({ root, line: item.line, where: "name", path: here, value: null });
        }
        if (where === "all" || where === "value") {
          const text = formatValue(item.value);
          if (text && test(text)) hits.push({ root, line: item.line, where: "value", path: here, value: text });
        }
      }
      const inner = blockOfValue(item.value);
      if (inner) search(inner, root, here);
    }
  };
  for (const { roots } of rows) {
    for (const root of roots) {
      // A root is a level of its own: its class and its name are not members, so they are matched
      // here or a query like "GameMode_Editor_Full1" would find nothing in a layer that is named so.
      if ((where === "all" || where === "class") && test(root.className)) {
        hits.push({ root, line: root.line, where: "class", path: `@${root.index}`, value: root.className });
      }
      if ((where === "all" || where === "name") && root.name && test(root.name)) {
        hits.push({ root, line: root.line, where: "name", path: `@${root.index}`, value: root.name });
      }
      search(root.block, root, "");
    }
  }
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
      hits: shown.map((h) => ({ root: h.root.index, line: h.line, in: h.where, path: h.path, value: h.value })),
    }, flags);
  } else {
    for (const f of failures) console.error(`FAIL  ${f.source}: ${f.error}`);
    let lastRoot = null;
    for (const h of shown) {
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

function cmdCat(specs, flags) {  if (specs.length < 1 || specs.length > 2) throw usageError("cat takes one source and optionally a line range: cat <source> 20-30");
  const [spec, range] = specs;
  if (range !== undefined && flags.lines !== undefined) throw usageError("cat takes a range or --lines, not both");
  const [source] = sourcesOf([spec], flags);
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
  let flags;
  try {
    flags = parseArgs(argv);
  } catch (err) {
    console.error(`error: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (flags.help || flags._.length === 0) {
    process.stdout.write(USAGE);
    if (flags.help) return;
    process.exitCode = 2;
    return;
  }
  const [command, ...rest] = flags._;
  const commands = {
    info: cmdInfo, tree: cmdTree, get: cmdGet, refs: cmdRefs, find: cmdFind, check: cmdCheck, cat: cmdCat,
  };
  const handler = commands[command];
  if (!handler) {
    console.error(`error: unknown command "${command}" — ${Object.keys(commands).join(", ")}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  try {
    checkOptions(command, flags);
    handler(rest, flags);
  } catch (err) {
    if (err.code === "USAGE") {
      console.error(`error: ${err.message}\n\n${USAGE}`);
      process.exitCode = 2;
      return;
    }
    const hint = err.hint ? `\n  hint: ${err.hint}` : "";
    console.error(`error: ${err.message}${hint}`);
    process.exitCode = err.code === "PARSE" || err.code === "INPUT" ? 1 : 1;
  }
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) main();
