// Sort an addons folder into dependency (override) order, and filter it by a server's mod list.
//
//   node tools/addons.mjs list  [--addon <dir>]... [--addons <root>]...
//                               [--mods-file <file>] [--no-vanilla]
//                               [--limit N|0] [--json]
//   node tools/addons.mjs info  <name|guid|id> [same options] [--json]
//   node tools/addons.mjs order [same options] [--dirs] [--json]
//   node tools/addons.mjs tree  [same options] [--depth N] [--limit N|0] [--json]
//   node tools/addons.mjs check [same options] [--strict] [--json]
//   node tools/addons.mjs mods  [same options] [--include-vanilla] [--json]
//
// ---------------------------------------------------------------------------
// WHY THIS EXISTS
//
// `--addons ROOT` gives the readers a folder of addons instead of forty arguments. Until this
// module, every tool that took it enumerated the folder's children **in path order** and handed
// them on in that order. But those children are not peers: the engine mounts a dependency before
// the addon that depends on it, so the dependent is the one whose records override. A folder whose
// names happen to sort `A`, `B`, `C` with `B` and `C` depending on `A` was therefore read as
// `A`, `B`, `C` — the base winning over both dependents. The order the tools need is
// `B`, `C`, `A`, the vanilla game last, and it is written down in `addon.gproj`.
//
// Every addon is a directory with a project file:
//
//   GameProject {
//    ID "ACE_Carrying"
//    GUID "5DBD560C5148E1DA"
//    TITLE "ACE Carrying"
//    Dependencies {
//     "58D0FB3206B6F859" "60C4CE4888FF4621"
//    }
//   }
//
// `GUID` is the addon's identity — the same 16 hex characters `game.mods[].modId` carries — and
// `Dependencies` lists the identities it needs. `58D0FB3206B6F859` is the game itself
// (`addons/data/ArmaReforger.gproj`), which in turn depends on `5614BBCCBB55ED1C`
// (`addons/core/core.gproj`). A downloaded Workshop addon keeps the same file, and additionally a
// `meta` cache holding the same id and the same dependencies, which is the fallback when the
// project file is missing or unreadable; `ServerData.json` is the second fallback.
//
// `--mods-file` narrows the folder to the mods a server actually runs. Its argument is the
// `game.mods` list of `server.json` (or the whole config, or the bare array), so the file a server
// already has is the filter:
//
//   { "mods": [ { "modId": "5DBD560C5148E1DA", "name": "ACE Carrying", "version": "1.4.3" } ] }
//
// Only the `modId`s matter; `name`, `version` and `required` are ignored. The vanilla game is
// selected whether or not it is listed — a server's mod list never contains it — unless
// `--no-vanilla` is given, which leaves it and the addons it depends on out of the set. An addon
// named with `--addon` is never filtered: that is an explicit source, not part of a scanned folder.
//
// ---------------------------------------------------------------------------
// THE ORDER
//
// Dependents before dependencies, the game last. That is a topological order of the graph
//
//   addon -> each of its Dependencies
//
// with the nodes that nothing depends on first. The game is the base and is placed last even for an
// addon that omits it from `Dependencies`: the engine mounts the game first, so a mod that forgot
// the entry still overrides it. Addons with no edge between them keep the order
// they were discovered in — the `--addon`s in command-line order, then each `--addons` root in
// command-line order, its children sorted by name — because nothing in the files orders them, and
// inventing a rule would hide that. A cycle is reported (`check` exits 1 on it) and its members are
// placed after the nodes that could be ordered, in discovery order: no order satisfies a cycle, so
// the tool says so instead of presenting one as derived.
//
// The result is the **override order** for every reader: the first entry wins a conflict. It is
// what `--rdb` documents as "the caller supplies the order", what `--use-addons-rdbs` merges in,
// and what `--addons` now hands to `etconf`, `layer`, `ebin` and `cscript`.
//
// ---------------------------------------------------------------------------
// WHAT IT DOES NOT DO
//
// It reads the dependency graph; it does not read the addons' contents. A built addon keeps its
// resources inside `data.pak`, and that archive is still named with `--pak` (or as a source's own
// container) — this module only decides which addon comes first, and which ones are in play. It
// also does not download anything: a dependency that is not in the folders given is reported, not
// fetched.
//
// Also usable as a library:
//
//   import { resolveAddonSet, addonSetFromFlags, addonRdbs, addonRdbDictionary } from "./addons.mjs";
//
// `resolveAddonSet` answers `{ all, selected, dropped, order, problems, filter, vanilla }` from the
// same options the command line uses; `addonSetFromFlags` adapts a tool's parsed `flags` object, so
// every reader resolves `--addon`/`--addons` one way instead of four.

import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { resolve as resolvePath, join, basename } from "node:path";
import { pathToFileURL } from "node:url";
import { scanRdb, verifyRdb, mergeRdb, verifyMerge, MergedRdb } from "./rdb.mjs";

// ---------------------------------------------------------------------------
// Identities and files
// ---------------------------------------------------------------------------

/** The game itself: `addons/data/ArmaReforger.gproj`, `TITLE "Arma Reforger"`. */
export const VANILLA_GUID = "58D0FB3206B6F859";

/**
 * The game's own dependency: `addons/core/core.gproj`, named in `addons/data/ArmaReforger.gproj`.
 * Kept beside the game GUID so the folder that holds only `core` still knows what it is, and so a
 * mod's dependency on the engine data is not reported as a missing addon when the folder given is
 * a Workshop one — the base game is never a `game.mods` entry.
 */
export const VANILLA_CORE_GUID = "5614BBCCBB55ED1C";

/** A resource GUID's spelling: 16 hex characters, case-insensitive. */
const GUID_SHAPE = /^[0-9A-F]{16}$/;

/**
 * A GUID in the form the files and the config use — uppercase, no braces, no dashes — or `null`
 * when the text is not a GUID at all. `{5dbd560c-5148-e1da}` is accepted on the way in because a
 * caller may have copied it out of a log line; the files themselves never write it that way.
 */
export function normaliseGuid(raw) {
  const text = String(raw ?? "").trim().replace(/[{}\s-]/g, "").toUpperCase();
  return GUID_SHAPE.test(text) ? text : null;
}

/** A library failure a command line can branch on: USAGE, INPUT or IO. */
function addonError(message, { code = "INPUT", hint = null, source = null } = {}) {
  const err = new Error(message);
  err.code = code;
  if (hint) err.hint = hint;
  if (source !== null) err.source = source;
  return err;
}

function usageError(message) {
  return addonError(message, { code: "USAGE" });
}

/** The first `NAME "value"` in a project file. `GUID` and `ID` appear once, at the top. */
function firstField(text, name) {
  const match = new RegExp(`\\b${name}\\s+"([^"]*)"`).exec(text);
  return match ? match[1] : null;
}

/**
 * Read one `*.gproj`: its identity and the identities it depends on.
 *
 * The format is Enfusion text and the fields are the first ones at the top of the file, so a small
 * scan is enough and a full parser (which `tools/etconf.mjs` has, for documents) is not needed
 * here — and importing it would make the two modules depend on each other. A file with no `GUID`
 * answers `null`: it is not a project this module can order.
 */
export function readGameProject(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw addonError(`${file}: cannot read the project file — ${err.message}`, {
      code: err.code === "ENOENT" ? "INPUT" : "IO",
      source: file,
    });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const guid = normaliseGuid(firstField(text, "GUID"));
  if (!guid) return null;
  const dependencies = [];
  const block = /\bDependencies\s*\{([^}]*)\}/.exec(text);
  if (block) {
    for (const match of block[1].matchAll(/"([0-9A-Fa-f]{16})"/g)) dependencies.push(match[1].toUpperCase());
  }
  return {
    file,
    guid,
    id: firstField(text, "ID"),
    title: firstField(text, "TITLE"),
    dependencies: [...new Set(dependencies)],
  };
}

/** The `*.gproj` at the top of an addon directory, if there is one (sorted, so a run is stable). */
export function projectFileIn(dir) {
  let names;
  try {
    names = readdirSync(dir);
  } catch {
    return null;
  }
  const found = names.filter((name) => /\.gproj$/i.test(name) && !name.startsWith(".")).sort();
  return found.length ? join(dir, found[0]) : null;
}

/**
 * Read the Workshop cache file `meta`, whose `versions[selectedRev]` names the same identity and the
 * same dependencies as the project — the fallback for an addon whose `*.gproj` is absent or
 * unreadable. A malformed cache is treated as absent: it is a download artefact, not the addon.
 */
export function readAddonMeta(dir) {
  const file = join(dir, "meta");
  if (!existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const meta = doc && typeof doc === "object" ? (doc.meta ?? doc) : null;
  const guid = meta ? normaliseGuid(meta.id) : null;
  if (!guid) return null;
  const versions = Array.isArray(meta.versions) ? meta.versions : [];
  const selected = versions[meta.selectedRev ?? 0] ?? versions[0] ?? null;
  const dependencies = [];
  for (const dep of selected?.dependencies ?? []) {
    const id = normaliseGuid(dep?.assetId ?? dep);
    if (id) dependencies.push(id);
  }
  return {
    file,
    guid,
    id: typeof meta.name === "string" ? meta.name : null,
    title: typeof meta.name === "string" ? meta.name : null,
    version: selected?.version ?? null,
    dependencies: [...new Set(dependencies)],
  };
}

/** The `ServerData.json` fallback: an id and a name, with no dependency list at all. */
export function readServerData(dir) {
  const file = join(dir, "ServerData.json");
  if (!existsSync(file)) return null;
  let doc;
  try {
    doc = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
  const guid = normaliseGuid(doc?.id);
  if (!guid) return null;
  return {
    file,
    guid,
    id: typeof doc.name === "string" ? doc.name : null,
    title: typeof doc.name === "string" ? doc.name : null,
    version: doc.revision?.version ?? null,
    dependencies: [],
  };
}

/**
 * The `*.rdb` files an addon directory carries, in a deterministic order.
 *
 * A Workbench project writes `resourceDatabase.rdb` at its root; a built addon may keep one under
 * `data/`. When neither is there the tree is searched (four levels, sorted), because a downloaded
 * addon lays its files out for the runtime rather than for the editor.
 */
export function addonRdbs(dir) {
  const root = resolvePath(dir);
  const direct = ["resourceDatabase.rdb", join("data", "resourceDatabase.rdb")]
    .map((rel) => join(root, rel))
    .filter((file) => existsSync(file));
  if (direct.length) return direct;
  const found = [];
  const walk = (current, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (entry.name.startsWith(".")) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) walk(full, depth + 1);
      else if (entry.isFile() && /\.rdb$/i.test(entry.name)) found.push(full);
    }
  };
  walk(root, 0);
  return found.sort();
}

/**
 * One addon directory, as this module knows it. `index` is the discovery position and the only
 * tie-break the order uses; `explicit` marks a `--addon`, which the filter never drops.
 *
 * A directory is not rejected for having no project file. A Workbench project under construction,
 * a copy laid out for the runtime, and a folder of loose documents all reach the readers today, and
 * the dependency order is a refinement rather than a gate — so a missing identity is a problem the
 * caller can report, not a reason to refuse the folder.
 */
export function inspectAddon(dir, { explicit = false, index = 0 } = {}) {
  const path = resolvePath(dir);
  const record = {
    dir: path,
    name: basename(path),
    explicit,
    fromRoots: false,
    index,
    project: null,
    meta: null,
    guid: null,
    id: null,
    title: null,
    version: null,
    dependencies: [],
    identity: "none",
    rdbs: [],
    paks: 0,
    hasMeta: existsSync(join(path, "meta")),
    problems: [],
  };
  record.project = projectFileIn(path);
  if (record.project) {
    try {
      const project = readGameProject(record.project);
      if (project) {
        record.guid = project.guid;
        record.id = project.id;
        record.title = project.title;
        record.dependencies = project.dependencies;
        record.identity = "gproj";
      } else {
        record.problems.push({
          severity: "warning",
          code: "no-guid",
          message: `${record.name}: ${record.project} has no GUID field`,
        });
      }
    } catch (err) {
      record.problems.push({
        severity: "warning",
        code: "unreadable-project",
        message: `${record.name}: ${err.message}`,
      });
    }
  }
  if (!record.guid) {
    const meta = readAddonMeta(path);
    const fallback = meta ?? readServerData(path);
    if (fallback) {
      record.meta = fallback.file;
      record.guid = fallback.guid;
      record.id = fallback.id ?? record.id;
      record.title = fallback.title ?? record.title;
      record.version = fallback.version ?? record.version;
      record.dependencies = fallback.dependencies;
      record.identity = meta ? "meta" : "serverdata";
    }
  }
  if (!record.guid && !record.project) {
    record.problems.push({
      severity: "warning",
      code: "no-project",
      message: `${record.name}: no .gproj and no meta — its GUID and dependencies are unknown, so it cannot be ordered or matched by --mods-file`,
    });
  }
  record.rdbs = addonRdbs(path);
  try {
    record.paks = readdirSync(path).filter((name) => /\.pak$/i.test(name)).length;
  } catch {
    record.paks = 0;
  }
  return record;
}

// ---------------------------------------------------------------------------
// A folder of addons
// ---------------------------------------------------------------------------

/**
 * True when the directory **is** one addon instead of a folder of them.
 *
 * The readers used to insist that the argument be a folder whose children are addons, which made
 * `--addons <install>/addons/data` — the game's own addon, the natural thing to paste — an error.
 * A top-level project file, a `data.pak` or a `resourceDatabase.rdb` is the marker; a directory of
 * addons has none of them, and a plain empty directory still gets the old error.
 */
function isAddonItself(path, entries) {
  return entries.some((entry) => entry.isFile()
    && (/\.gproj$/i.test(entry.name) || /^data\.pak$/i.test(entry.name) || /^resourceDatabase\.rdb$/i.test(entry.name)));
}

/**
 * The addon directories a `--addons ROOT` names: the root itself when it is an addon, otherwise its
 * child directories, sorted. An empty answer is an error with the wording the readers already used,
 * because "there are no addons here" must not read as "these addons have no documents".
 */
export function addonDirsOfRoot(root) {
  const path = resolvePath(root);
  let entries;
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch (err) {
    throw addonError(`${root}: cannot read the addons folder — ${err.message}`, {
      code: err.code === "ENOENT" ? "INPUT" : "IO",
      source: root,
    });
  }
  if (isAddonItself(path, entries)) return [path];
  const dirs = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => join(path, entry.name))
    .sort();
  if (!dirs.length) {
    throw addonError(
      `${root}: no addon directory inside it — --addons takes a folder whose child directories are the addons, read one level down`,
      { source: root },
    );
  }
  return dirs;
}

// ---------------------------------------------------------------------------
// The filter: a server's game.mods
// ---------------------------------------------------------------------------

/**
 * Parse the `--mods-file` file. Accepts every shape a server or the game hands out:
 *
 *   { "game": { "mods": [ { "modId": "…" } ] } }   the whole server.json
 *   { "game": { … } }                               a server config with no mods (an empty list)
 *   { "mods": [ { "modId": "…" } ] }                the field alone
 *   [ { "modId": "…" } ]                            the array
 *   { "modId": "…" }                                one mod
 *   { "modId": "…" }, { "modId": "…" }              the game's clipboard form, with no brackets
 *   [ "5DBD560C5148E1DA" ]                          bare GUIDs
 *
 * Only the identities matter. An entry with no `modId` is counted and ignored rather than refused:
 * the config validator is where a malformed mod entry belongs, and a filter that stops on one typo
 * cannot be used to answer "which mods of this folder does the server run".
 */
export function readModsFilter(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (err) {
    throw addonError(`${file}: cannot read the filter — ${err.message}`, {
      code: err.code === "ENOENT" ? "INPUT" : "IO",
      source: file,
      hint: "the filter is the game.mods list of the server config: { \"mods\": [ { \"modId\": \"<16 hex>\" } ] }",
    });
  }
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  if (!text.trim()) {
    throw addonError(`${file}: is empty — expected the game.mods list of a server config`, {
      code: "INPUT",
      source: file,
    });
  }
  let value;
  try {
    value = JSON.parse(text);
  } catch (first) {
    // The game hands out one `{ … }` object per mod with a comma between them and no array
    // brackets, which is not JSON. That is the shape most people copy, so accept it by wrapping.
    try {
      value = JSON.parse(`[${text.replace(/,\s*$/, "")}]`);
    } catch {
      throw addonError(`${file}: is not JSON — ${first.message}`, {
        code: "INPUT",
        source: file,
        hint: "accepted: the whole server.json, { \"mods\": [ … ] }, an array of mods, or the game's own clipboard form",
      });
    }
  }
  let entries;
  if (Array.isArray(value)) entries = value;
  else if (value && typeof value === "object" && Array.isArray(value.mods)) entries = value.mods;
  else if (value && typeof value === "object" && value.game && Array.isArray(value.game.mods)) entries = value.game.mods;
  // A config whose `game` block carries no `mods` at all is a server that runs none: an empty
  // filter, not a mistake. It still selects the vanilla game, which is the useful answer.
  else if (value && typeof value === "object" && value.game && typeof value.game === "object") entries = [];
  else if (value && typeof value === "object" && typeof value.modId === "string") entries = [value];
  else {
    throw addonError(`${file}: does not carry a mod list — expected the game.mods array of server.json`, {
      code: "INPUT",
      source: file,
    });
  }
  const ids = [];
  let ignored = 0;
  for (const entry of entries) {
    const raw = typeof entry === "string" ? entry : entry?.modId;
    const id = normaliseGuid(raw);
    if (!id) { ignored++; continue; }
    if (!ids.includes(id)) ids.push(id);
  }
  return { file: resolvePath(file), ids, entries: entries.length, ignored };
}

// ---------------------------------------------------------------------------
// The graph, and the one order
// ---------------------------------------------------------------------------

/**
 * The dependency edges among a set of addons. `byGuid` resolves an identity to the **first** record
 * that carries it (a duplicate is reported, and one of them has to answer); `edges` holds, per
 * record, the records it depends on **within the set**; `dependents` is the reverse.
 */
function buildGraph(records) {
  const byGuid = new Map();
  for (const record of records) {
    if (record.guid && !byGuid.has(record.guid)) byGuid.set(record.guid, record);
  }
  const edges = new Map(records.map((record) => [record, []]));
  const dependents = new Map(records.map((record) => [record, new Set()]));
  for (const record of records) {
    const seen = new Set();
    for (const guid of record.dependencies) {
      const dependency = byGuid.get(guid);
      if (!dependency || dependency === record || seen.has(dependency)) continue;
      seen.add(dependency);
      edges.get(record).push(dependency);
      dependents.get(dependency).add(record);
    }
  }
  // The game is the base, not a peer, so it is last even for an addon whose `Dependencies` omits
  // it: the engine mounts the game first regardless, and a mod that forgot the entry still
  // overrides it. Both vanilla records get the edge — `data` and the engine's `core` — so neither
  // can be placed before a mod; `data` already depends on `core`, which orders those two.
  const vanillaBases = [byGuid.get(VANILLA_GUID), byGuid.get(VANILLA_CORE_GUID)].filter(Boolean);
  for (const record of records) {
    if (record.guid === VANILLA_GUID || record.guid === VANILLA_CORE_GUID) continue;
    for (const base of vanillaBases) {
      if (base === record || edges.get(record).includes(base)) continue;
      edges.get(record).push(base);
      dependents.get(base).add(record);
    }
  }
  return { byGuid, edges, dependents };
}

/**
 * The members of the first cycle reachable from `start`, in the order the edges follow. Only edges
 * inside `within` are followed: a node the sort could already place cannot be part of a cycle.
 */
function findCycle(start, edges, state, within) {
  const stack = [];
  const visit = (record) => {
    state.set(record, 1);
    stack.push(record);
    for (const dependency of edges.get(record) ?? []) {
      if (!within.has(dependency)) continue;
      const seen = state.get(dependency) ?? 0;
      if (seen === 1) return stack.slice(stack.indexOf(dependency));
      if (seen === 0) {
        const found = visit(dependency);
        if (found) return found;
      }
    }
    state.set(record, 2);
    stack.pop();
    return null;
  };
  return visit(start);
}

/** A readable name for a record, in a problem or a tree: `Name (GUID)`. */
export function labelOf(record) {
  if (!record) return "(unknown)";
  return record.guid ? `${record.name} (${record.guid})` : `${record.name} (no GUID)`;
}

/**
 * Topologically order the selected records: dependents first, dependencies after them, the game
 * last. Ties are broken by discovery index, so the answer is deterministic without inventing a rule
 * for addons that do not reference each other.
 *
 * A cycle leaves its members unordered. They are appended in discovery order and reported once,
 * with the members named: no order satisfies `A -> B -> A`, and the honest answer is that the
 * folders contradict each other rather than an order that looks derived.
 */
function orderRecords(records, problems) {
  if (records.length < 2) return [...records];
  const { edges, dependents } = buildGraph(records);
  const pending = new Map(records.map((record) => [record, dependents.get(record).size]));
  const ready = records.filter((record) => pending.get(record) === 0);
  const out = [];
  const placed = new Set();
  while (ready.length) {
    ready.sort((a, b) => a.index - b.index);
    const record = ready.shift();
    if (placed.has(record)) continue;
    placed.add(record);
    out.push(record);
    for (const dependency of edges.get(record) ?? []) {
      pending.set(dependency, pending.get(dependency) - 1);
      if (pending.get(dependency) === 0 && !placed.has(dependency)) ready.push(dependency);
    }
  }
  const left = records.filter((record) => !placed.has(record));
  if (left.length) {
    const within = new Set(left);
    const state = new Map(left.map((record) => [record, 0]));
    for (const record of left) {
      if (state.get(record) !== 0) continue;
      const cycle = findCycle(record, edges, state, within);
      if (cycle) {
        const members = [...new Set(cycle)];
        problems.push({
          severity: "error",
          code: "cycle",
          message: `dependency cycle among ${members.length} addon(s): ${members.map(labelOf).join(" -> ")}; ` +
            "no order satisfies it, so they keep the order they were found in",
          addons: members.map((member) => member.dir),
        });
        break;
      }
    }
    for (const record of left.sort((a, b) => a.index - b.index)) out.push(record);
  }
  return out;
}

/**
 * The whole resolution: discover, filter, order, and collect what is wrong.
 *
 * `all` is every addon found (selected or not); `selected` and `order` are the same list, the one
 * the readers use; `dropped` names each excluded addon and why; `problems` is everything `check`
 * reports. `filter` is `null` when no filter was given.
 *
 * The vanilla set is the game GUID plus the addons it depends on **within the set** — the game's
 * own `core`, when `<install>/addons` was given. It is selected like any other addon — that is, a
 * mods file never has to name it, because a server's does not — except under `--no-vanilla`,
 * which leaves it out whether or not a mods file was given. An explicit `--addon` is still an
 * explicit source and stays: the caller named it.
 */
export function resolveAddonSet({ addon = [], addons = [], filterFile = null, excludeVanilla = false } = {}) {
  if (filterFile && !addons.length) {
    throw usageError("--mods-file filters the addons of --addons <root>: pass at least one --addons root");
  }
  const records = [];
  const byDir = new Map();
  const add = (dir, explicit, fromRoot) => {
    const key = resolvePath(dir).toLowerCase();
    const known = byDir.get(key);
    if (known) {
      if (explicit) known.explicit = true;
      if (fromRoot) known.fromRoots = true;
      return known;
    }
    const record = inspectAddon(dir, { explicit, index: records.length });
    record.fromRoots = !!fromRoot;
    byDir.set(key, record);
    records.push(record);
    return record;
  };
  // `--addon` first: an explicit source, never filtered, and the first tie-break position.
  for (const dir of addon) {
    let stat;
    try {
      stat = statSync(resolvePath(dir));
    } catch (err) {
      throw addonError(`${dir}: no such addon directory — ${err.message}`, { code: "INPUT", source: dir });
    }
    if (!stat.isDirectory()) throw usageError(`--addon needs a directory, not ${dir}`);
    add(dir, true, false);
  }
  const roots = [];
  for (const root of addons) {
    const dirs = addonDirsOfRoot(root);
    roots.push({ root: resolvePath(root), addons: dirs.length, dirs });
    for (const dir of dirs) add(dir, false, true);
  }

  // Vanilla: the game GUID and everything it depends on, as far as the set can tell.
  const allGraph = buildGraph(records);
  const vanilla = new Set([VANILLA_GUID, VANILLA_CORE_GUID]);
  const queue = [VANILLA_GUID];
  while (queue.length) {
    const record = allGraph.byGuid.get(queue.shift());
    if (!record) continue;
    for (const dependency of record.dependencies) {
      if (vanilla.has(dependency) || !allGraph.byGuid.has(dependency)) continue;
      vanilla.add(dependency);
      queue.push(dependency);
    }
  }
  for (const record of records) record.vanilla = !!record.guid && vanilla.has(record.guid);

  const filter = filterFile ? readModsFilter(filterFile) : null;
  const filterIds = filter ? new Set(filter.ids) : null;
  const dropped = [];
  for (const record of records) {
    let selected;
    let why = null;
    if (record.explicit) selected = true;
    else if (record.vanilla && excludeVanilla) {
      selected = false;
      why = "vanilla — --no-vanilla leaves the game and the addons it depends on out";
      dropped.push({ record, why });
    } else if (!filter) selected = true;
    else if (record.vanilla) selected = true;
    else if (record.guid && filterIds.has(record.guid)) selected = true;
    else {
      selected = false;
      why = !record.guid ? "no GUID, so no modId can match it"
        : "not in the filter";
      dropped.push({ record, why });
    }
    record.selected = selected;
    record.dropReason = why;
  }

  const problems = [];
  // One problem per record, so a folder with 200 identity-less documents is not 200 errors.
  for (const record of records) problems.push(...record.problems);
  for (const record of records) {
    if (!record.guid || !record.dependencies.includes(record.guid)) continue;
    problems.push({
      severity: "error",
      code: "self-dependency",
      message: `${labelOf(record)} lists its own GUID in Dependencies`,
      addons: [record.dir],
      guid: record.guid,
    });
  }
  const guidCounts = new Map();
  for (const record of records) {
    if (!record.guid) continue;
    guidCounts.set(record.guid, (guidCounts.get(record.guid) ?? 0) + 1);
  }
  for (const [guid, count] of guidCounts) {
    if (count < 2) continue;
    const names = records.filter((record) => record.guid === guid).map((record) => record.dir);
    problems.push({
      severity: "error",
      code: "duplicate-guid",
      message: `${count} addon directories claim the GUID ${guid}: ${names.join(", ")} — one of them wins ` +
        "every dependency lookup, so the order between them is not derivable",
      addons: names,
      guid,
    });
  }
  for (const record of records) {
    for (const guid of record.dependencies) {
      // The game and its engine data are not `game.mods` entries, so their absence from the folder
      // is normal; a *present* one the filter dropped is still worth saying.
      if (vanilla.has(guid) && !allGraph.byGuid.has(guid)) continue;
      const dependency = allGraph.byGuid.get(guid);
      if (!dependency) {
        problems.push({
          severity: "warning",
          code: "missing-dependency",
          message: `${labelOf(record)} depends on ${guid}, which is not in the addons given`,
          addons: [record.dir],
          dependency: guid,
        });
        continue;
      }
      if (record.selected && !dependency.selected) {
        problems.push({
          severity: "warning",
          code: "filtered-dependency",
          message: `${labelOf(record)} is selected but depends on ${labelOf(dependency)}, which --mods-file dropped — ` +
            "the filter should list every mod the server runs, dependencies included",
          addons: [record.dir, dependency.dir],
          dependency: guid,
        });
      }
    }
  }
  if (filter) {
    const found = new Set(records.map((record) => record.guid).filter(Boolean));
    const missing = filter.ids.filter((id) => !found.has(id) && !vanilla.has(id));
    if (missing.length) {
      problems.push({
        severity: "warning",
        code: "filter-not-found",
        message: `--mods-file lists ${missing.length} modId(s) that no addon in these folders has: ` +
          `${missing.slice(0, 5).map((id) => id).join(", ")}${missing.length > 5 ? ", …" : ""}`,
        modIds: missing,
      });
    }
    filter.matched = filter.ids.filter((id) => found.has(id)).length;
    filter.notFound = missing;
    if (filter.ignored) {
      problems.push({
        severity: "warning",
        code: "filter-entry",
        message: `--mods-file has ${filter.ignored} entr${filter.ignored === 1 ? "y" : "ies"} with no usable modId; ignored`,
      });
    }
  }

  const selected = records.filter((record) => record.selected);
  const order = orderRecords(selected, problems);
  order.forEach((record, position) => { record.order = position + 1; });
  for (const record of records) if (!record.selected) record.order = null;

  return {
    all: records,
    byDir,
    byGuid: allGraph.byGuid,
    selected,
    order,
    dropped,
    roots,
    filter,
    vanilla,
    problems,
  };
}

/**
 * The two mods options are meaningful only over an `--addons` root. Every reader calls this
 * before its command runs, so `--mods-file f` without `--addons` is refused instead of silently
 * ignored — which would answer about every addon while the caller believes it asked about the
 * ones in the file. `--no-vanilla` needs no file: it just leaves the vanilla set out.
 */
export function checkAddonFilterFlags(flags) {
  if (flags.modsFile && !flags.addons?.length) {
    throw usageError("--mods-file filters the addons of --addons <root>: pass at least one --addons root");
  }
}

/** The resolution for one tool's parsed `flags`, memorised per option set. */
let addonMemo = null;
export function addonSetFromFlags(flags) {
  const key = JSON.stringify([
    flags.addon ?? [],
    flags.addons ?? [],
    flags.modsFile ?? null,
    !!flags.excludeVanilla,
  ]);
  if (addonMemo && addonMemo.key === key) return addonMemo.value;
  const value = resolveAddonSet({
    addon: flags.addon ?? [],
    addons: flags.addons ?? [],
    filterFile: flags.modsFile ?? null,
    excludeVanilla: !!flags.excludeVanilla,
  });
  addonMemo = { key, value };
  return value;
}

/** The addon directories in override order: what a reader's `--addon`/`--addons` resolve to. */
export function orderedAddonDirs(flags) {
  return addonSetFromFlags(flags).order.map((record) => record.dir);
}

// ---------------------------------------------------------------------------
// The databases of an ordered set
// ---------------------------------------------------------------------------

/**
 * Every `resourceDatabase.rdb` the records carry, in override order, without duplicates.
 * `exclude` is a set of lower-cased resolved paths to skip — the databases a caller already named
 * with `--rdb`, which must not be passed twice.
 */
export function addonRdbPaths(records, { exclude = null } = {}) {
  const out = [];
  const seen = new Set();
  for (const record of records) {
    for (const file of record.rdbs ?? []) {
      const key = resolvePath(file).toLowerCase();
      if (seen.has(key) || exclude?.has(key)) continue;
      seen.add(key);
      out.push(file);
    }
  }
  return out;
}

/**
 * The GUID dictionary of a set of databases **in the order given**, where a GUID declared by two
 * databases with different paths is an override rather than a refusal: the first one wins, which
 * is why the set has to be in dependency order.
 *
 * That is a deliberate difference from `rdb verify-merge`, which refuses a set that is not a
 * bijection, and from `--rdb`, which keeps that rule for the databases a caller named. The addon
 * layer has an order — the one `addons check` prints — so the first record *is* the answer, and the
 * disagreements are counted so the answer can say it chose. The case it exists for is the vanilla
 * pair: `addons/data` and `addons/core` share 151 GUIDs and 136 of them carry a different path, so
 * a strict merge of `<install>/addons` is impossible; with `data` first (it depends on `core`) the
 * paths the shipped worlds reference come out right.
 *
 * Each database is still checked on its own — a file that does not parse, or whose published
 * vanilla GUIDs disagree with it, is refused — so only the *cross-database* rule is relaxed.
 */
export function addonRdbDictionary(records, options = {}) {
  const paths = addonRdbPaths(records, options);
  if (!paths.length) return null;
  const scanned = paths.map((file) => {
    const db = scanRdb(file);
    const check = verifyRdb(db);
    if (!check.ok) {
      const problems = [];
      if (check.contradicted.length) {
        const sample = check.contradicted.slice(0, 3)
          .map((found) => `${found.path} is {${found.found}}, the wiki publishes {${found.expected}}`);
        problems.push(`the published GUIDs contradict it: ${sample.join("; ")}`);
      }
      if (!check.records) problems.push("it contains no records");
      throw addonError(`${file}: refusing to resolve through this database — ${problems.join("; ")}. ` +
        "No path it yields is confirmed.", { code: "INPUT", source: file });
    }
    return db;
  });
  const check = verifyMerge(scanned);
  const merged = mergeRdb(scanned);
  return {
    merged,
    files: merged.databases,
    conflicts: {
      sameGuidDifferentPaths: check.sameGuidDifferentPaths.length,
      samePathDifferentGuids: check.samePathDifferentGuids.length,
    },
    conflictList: check,
  };
}

/**
 * Two or more dictionaries layered: the first layer wins a GUID, a later one fills only what the
 * first does not know. `shadowed` counts the later-layer records whose GUID the first layer already
 * answered with a **different** path — a real disagreement, not merely a record answered twice.
 *
 * This is how `--rdb` and the addon layer combine: what the caller named stays authoritative, and
 * the addons add their own identities.
 */
export function combineRdbLayers(layers) {
  const files = [];
  const map = new Map();
  let shadowed = 0;
  for (const layer of layers) {
    const offset = files.length;
    for (const db of layer.merged.databases) files.push(layer.fromAddons ? { ...db, fromAddons: true } : db);
    for (const [guid, found] of layer.merged.map) {
      const known = map.get(guid);
      if (known !== undefined) {
        if (layer.fromAddons && known.path !== found.path) shadowed++;
        continue;
      }
      map.set(guid, { path: found.path, rdbs: found.rdbs.map((index) => index + offset) });
    }
  }
  return { merged: new MergedRdb(files, map), files, shadowed };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Sort an addons folder into dependency (override) order, and filter it by a server's mod list.

  node tools/addons.mjs list  [--addon <dir>]... [--addons <root>]...
                              [--mods-file <file>] [--no-vanilla]
                              [--limit N|0] [--json]
  node tools/addons.mjs info  <name|guid|id> [same options] [--json]
  node tools/addons.mjs order [same options] [--dirs] [--json]
  node tools/addons.mjs tree  [same options] [--depth N] [--limit N|0] [--json]
  node tools/addons.mjs check [same options] [--strict] [--json]
  node tools/addons.mjs mods  [same options] [--include-vanilla] [--json]

What it answers
  list   every addon found: its identity, how many dependencies it declares, its position in the
         override order, and whether it is selected, vanilla or left out. A mods file hides the
         rows it left out by default — --show-dropped shows them too
  info   one addon in full: project file, dependency and dependent lists, order position, files
  order  the override order alone — the order every reader's --addons should be searched in:
         dependents first, the addons they depend on after them, the game last. --dirs prints just
         the directories, one per line, ready for another command
  tree   the dependency tree: the addons nothing depends on at the top, each one's Dependencies
         below it, the game at the leaves. A dependency already printed under another root is
         marked "already shown" instead of repeated
  check  what is wrong with the set: a dependency cycle, a GUID two folders claim, a dependency
         that is not in the folders, a filter that names a mod no folder has. Exit 1 on an error,
         and --strict makes a warning fail too
  mods   the game.mods list for the selected addons, as a server.json fragment — the reverse of
         --mods-file, for a config that should list exactly what is on disk

Where the order comes from
  Every addon is a directory with a GameProject: addon.gproj writes the identity (GUID, the same
  16 hex as game.mods[].modId), the title, and Dependencies — the identities it needs. 58D0FB3206B6F859
  is the game itself. The engine mounts a dependency before the addon that depends on it, so the
  dependent's records override; the order is a topological sort of those edges, with the addons
  that nothing depends on first and the game last. Addons with no edge between them keep the order
  they were found in, because nothing declares one. A missing addon.gproj falls back to the
  Workshop cache "meta" and then ServerData.json, and is reported when neither has a GUID.

The mods file
  --mods-file takes the game.mods list of a server config — the whole server.json, the
  field alone, the bare array, or the game's own clipboard form without brackets. Only modId
  matters. The vanilla game is selected whether or not the file names it, because a server's
  mods list never does; --no-vanilla is what leaves it out. Addons named with --addon are
  explicit and never filtered. An addon with no GUID cannot match a modId, so the file drops it.

Options
  --addon DIR    one addon directory: an explicit source, searched first in a tie, never filtered.
                 Repeatable
  --addons ROOT  a folder of addons: every child directory is one addon, unless ROOT is itself an
                 addon (it has a .gproj, data.pak or resourceDatabase.rdb at its top), in which case
                 ROOT is the one addon. Repeatable
  --mods-file FILE
                 keep only the addons whose GUID is a modId in FILE (see above)
  --no-vanilla   leave the vanilla game and the addons it depends on out of the set, with or
                 without --mods-file. An explicit --addon is still selected: the caller named it
  --show-dropped list: also show the addons the set left out, after the selected ones
  --limit N      list/tree: maximum rows (default 100; 0 = every one)
  --all          same as --limit 0
  --depth N      tree: how many dependency levels to show (0 = no limit); a node already shown is
                 marked instead of repeated
  --dirs         order: print only the directories
  --include-vanilla
                 mods: include the game's own entries, which a server config must not
  --strict       check: a warning fails too
  --json         machine-readable output; --compact prints it on one line
  --             end the options: info -- --odd-name searches for the literal --odd-name

Exit codes: 0 success, 1 the input at fault (a cycle, a duplicate GUID, an unreadable mods file), 2
the command line (USAGE). Under --json a failure is {ok:false, error:{code, message, hint?, source?}}.
`;

function spellOption(name) {
  return {
    modsFile: "mods-file",
    excludeVanilla: "no-vanilla",
    includeVanilla: "include-vanilla",
    showDropped: "show-dropped",
  }[name] ?? name;
}

function parseArgs(argv) {
  const flags = { _: [], given: [], addon: [], addons: [] };
  const valueOf = (option, i) => {
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) throw usageError(`${option} needs a value`);
    return value;
  };
  const BOOLEAN = {
    "--json": "json",
    "--compact": "compact",
    "--all": "all",
    "--dirs": "dirs",
    "--strict": "strict",
    "--no-vanilla": "excludeVanilla",
    "--include-vanilla": "includeVanilla",
    "--show-dropped": "showDropped",
  };
  const MULTI = { "--addon": "addon", "--addons": "addons" };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--") { flags._.push(...argv.slice(i + 1)); break; }
    const at = arg.indexOf("=");
    const name = at > 0 && arg.startsWith("--") ? arg.slice(0, at) : arg;
    const inline = at > 0 && arg.startsWith("--") ? arg.slice(at + 1) : null;
    const value = (option) => {
      if (inline !== null) return inline;
      const read = valueOf(option, i);
      i++;
      return read;
    };
    if (Object.hasOwn(BOOLEAN, name)) {
      if (inline !== null) throw usageError(`${name} does not take a value`);
      flags[BOOLEAN[name]] = true;
      flags.given.push(BOOLEAN[name]);
    } else if (Object.hasOwn(MULTI, name)) {
      const read = value(name);
      flags[MULTI[name]].push(read);
      flags.given.push(MULTI[name]);
    } else if (name === "--mods-file") {
      flags.modsFile = value(name);
      flags.given.push("modsFile");
    } else if (name === "--limit" || name === "--depth") {
      const raw = value(name);
      if (!/^\d+$/.test(raw)) throw usageError(`${name} needs a non-negative whole number, not "${raw}"`);
      flags[name.slice(2)] = Number(raw);
      flags.given.push(name.slice(2));
    } else if (name === "-h" || name === "--help") flags.help = true;
    else if (arg.startsWith("-") && arg !== "-") throw usageError(`unknown option "${arg}"`);
    else flags._.push(arg);
  }
  if (flags.compact) flags.json = true;
  return flags;
}

const BASE_OPTIONS = ["addon", "addons", "modsFile", "excludeVanilla"];
const COMMAND_OPTIONS = {
  list: [...BASE_OPTIONS, "limit", "all", "showDropped"],
  info: [...BASE_OPTIONS],
  order: [...BASE_OPTIONS, "dirs"],
  tree: [...BASE_OPTIONS, "depth", "limit", "all"],
  check: [...BASE_OPTIONS, "strict"],
  mods: [...BASE_OPTIONS, "includeVanilla"],
};
const GLOBAL_OPTIONS = ["json", "compact"];

function checkOptions(command, flags) {
  const allowed = new Set([...COMMAND_OPTIONS[command], ...GLOBAL_OPTIONS]);
  for (const given of flags.given) {
    if (!allowed.has(given)) throw usageError(`"${command}" does not take --${spellOption(given)}`);
  }
}

function rowLimit(flags, fallback = 100) {
  if (flags.all) return Infinity;
  if (flags.limit === undefined) return fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

function printJsonValue(value, flags) {
  console.log(JSON.stringify(value, null, flags.compact ? 0 : 2));
}

/** `dependent side` of the graph, for `info`: the addons that depend on this one. */
function dependentsOf(resolved, record) {
  return resolved.all.filter((other) => other.dependencies.includes(record.guid) && other.guid !== record.guid);
}

function dependencyRows(resolved, record) {
  return record.dependencies.map((guid) => {
    const dependency = resolved.byGuid.get(guid) ?? null;
    return {
      guid,
      addon: dependency ? dependency.dir : null,
      name: dependency ? dependency.name : null,
      selected: dependency ? dependency.selected : false,
      missing: !dependency,
    };
  });
}

function flagsOf(record) {
  const flags = [];
  if (record.vanilla) flags.push("vanilla");
  if (record.explicit) flags.push("explicit");
  if (!record.guid) flags.push("no-guid");
  if (!record.selected) flags.push("dropped");
  return flags.join(" ");
}

function summaryOf(resolved) {
  return {
    found: resolved.all.length,
    selected: resolved.selected.length,
    dropped: resolved.dropped.length,
    vanilla: resolved.all.filter((record) => record.vanilla).length,
    roots: resolved.roots.length,
  };
}

function filterLine(filter) {
  if (!filter) return null;
  return `FILTER  ${filter.file}: ${filter.ids.length} modId(s), ${filter.matched ?? 0} matched, ` +
    `${filter.notFound?.length ?? 0} not in the addons`;
}

function printHeader(resolved) {
  const counts = summaryOf(resolved);
  const where = counts.roots ? ` under ${counts.roots} folder(s)` : "";
  console.log(`ADDONS  ${counts.found} addon(s)${where}: ${counts.selected} selected, ` +
    `${counts.dropped} dropped, ${counts.vanilla} vanilla`);
  console.log("ORDER   dependents first, then the addons they depend on, the game last");
  const filter = filterLine(resolved.filter);
  if (filter) console.log(filter);
}

function cmdList(resolved, flags) {
  // Selected first, in override order; then — only when asked — the dropped ones, in the order
  // they were found. With no filter every addon is selected, so the default list is still whole.
  const rows = flags.showDropped ? [...resolved.order, ...resolved.dropped.map((entry) => entry.record)] : resolved.order;
  const limit = rowLimit(flags);
  const shown = rows.slice(0, limit === Infinity ? rows.length : limit);
  if (flags.json) {
    printJsonValue({
      command: "list",
      ...summaryOf(resolved),
      filter: resolved.filter ? { file: resolved.filter.file, ids: resolved.filter.ids.length, matched: resolved.filter.matched, notFound: resolved.filter.notFound } : null,
      addons: shown.map((record) => ({
        order: record.order,
        dir: record.dir,
        name: record.name,
        guid: record.guid,
        id: record.id,
        title: record.title,
        dependencies: record.dependencies.length,
        vanilla: record.vanilla,
        explicit: record.explicit,
        selected: record.selected,
        dropped: record.selected ? null : record.dropReason ?? "not selected",
        problems: record.problems.map((problem) => problem.code),
      })),
      total: rows.length,
      returned: shown.length,
      truncated: shown.length < rows.length,
    }, flags);
    return;
  }
  printHeader(resolved);
  console.log("");
  const nameWidth = Math.max(5, ...shown.map((record) => record.name.length));
  console.log(`  ${"#".padStart(3)}  ${"ADDON".padEnd(nameWidth)}  ${"GUID".padEnd(16)}  ${"DEPS".padStart(4)}  FLAGS`);
  for (const record of shown) {
    const order = record.order === null ? "-" : String(record.order);
    console.log(`  ${order.padStart(3)}  ${record.name.padEnd(nameWidth)}  ` +
      `${(record.guid ?? "-").padEnd(16)}  ${String(record.dependencies.length).padStart(4)}  ${flagsOf(record)}`);
  }
  if (shown.length < rows.length) console.log(`# ${rows.length} row(s), ${shown.length} shown — use --limit 0 for every one`);
}

function cmdInfo(resolved, flags, query) {
  const text = String(query).trim();
  const guid = normaliseGuid(text);
  const lower = text.toLowerCase();
  const attempts = [
    (record) => record.guid === guid && guid !== null,
    (record) => record.dir.toLowerCase() === resolvePath(text).toLowerCase(),
    (record) => (record.id ?? "").toLowerCase() === lower,
    (record) => (record.title ?? "").toLowerCase() === lower,
    (record) => record.name.toLowerCase() === lower,
    (record) => [record.name, record.id, record.title, record.guid].filter(Boolean).some((value) => value.toLowerCase().includes(lower)),
  ];
  let hits = [];
  for (const attempt of attempts) {
    hits = resolved.all.filter(attempt);
    if (hits.length) break;
  }
  if (!hits.length) {
    throw addonError(`no addon matches "${text}"`, {
      code: "INPUT",
      source: text,
      hint: "match by GUID, folder name, project ID or TITLE; `list` prints all of them",
    });
  }
  if (hits.length > 1) {
    throw addonError(`"${text}" matches ${hits.length} addons: ${hits.map((record) => `${record.name} (${record.guid ?? "no GUID"})`).join(", ")}`, {
      code: "INPUT",
      source: text,
      hint: "name it by GUID, which is unique",
    });
  }
  const record = hits[0];
  const dependencies = dependencyRows(resolved, record);
  const dependents = dependentsOf(resolved, record);
  if (flags.json) {
    printJsonValue({
      command: "info",
      addon: {
        order: record.order,
        dir: record.dir,
        name: record.name,
        guid: record.guid,
        id: record.id,
        title: record.title,
        version: record.version,
        identity: record.identity,
        project: record.project,
        meta: record.meta,
        vanilla: record.vanilla,
        explicit: record.explicit,
        selected: record.selected,
        paks: record.paks,
        rdbs: record.rdbs,
        dependencies,
        dependents: dependents.map((other) => ({ dir: other.dir, name: other.name, guid: other.guid, selected: other.selected })),
        problems: record.problems,
      },
    }, flags);
    return;
  }
  console.log(`ADDON   ${record.name}`);
  console.log(`GUID    ${record.guid ?? "(none)"}`);
  console.log(`ID      ${record.id ?? "-"}`);
  console.log(`TITLE   ${record.title ?? "-"}`);
  console.log(`DIR     ${record.dir}`);
  console.log(`PROJECT ${record.project ?? "-"}`);
  console.log(`META    ${record.meta ?? "-"}`);
  console.log(`SOURCE  ${record.identity === "gproj" ? "addon.gproj"
    : record.identity === "meta" ? "the Workshop meta cache"
      : record.identity === "serverdata" ? "ServerData.json"
        : "none — no identity"}`);
  console.log(`ORDER   ${record.order === null ? `not selected (${record.dropReason ?? "filtered"})` : `${record.order} of ${resolved.selected.length}`}`);
  console.log(`VANILLA ${record.vanilla ? "yes" : "no"}`);
  console.log(`FILES   ${record.paks} .pak, ${record.rdbs.length} .rdb${record.hasMeta ? ", meta" : ""}`);
  console.log(`\nDEPENDS ON (${dependencies.length})`);
  if (!dependencies.length) console.log("  (none declared)");
  for (const dependency of dependencies) {
    const name = dependency.addon ? `${dependency.name}` : "(not in the addons given)";
    const dependencyOrder = dependency.addon ? resolved.byGuid.get(dependency.guid)?.order : null;
    console.log(`  ${name.padEnd(40)} ${dependency.guid}  ${dependencyOrder ? `order ${dependencyOrder}` : "-"}`);
  }
  console.log(`\nDEPENDED ON BY (${dependents.length})`);
  if (!dependents.length) console.log("  (nothing here depends on it: it is a root of the tree)");
  for (const other of dependents) {
    console.log(`  ${other.name.padEnd(40)} ${other.guid ?? "-"}  ${other.selected ? "selected" : "dropped"}`);
  }
  if (record.problems.length) {
    console.log(`\nPROBLEMS (${record.problems.length})`);
    for (const problem of record.problems) console.log(`  ${problem.code}: ${problem.message}`);
  }
}

function cmdOrder(resolved, flags) {
  if (flags.json) {
    printJsonValue({
      command: "order",
      ...summaryOf(resolved),
      dirs: resolved.order.map((record) => record.dir),
      addons: resolved.order.map((record) => ({
        order: record.order,
        dir: record.dir,
        name: record.name,
        guid: record.guid,
        id: record.id,
        title: record.title,
        vanilla: record.vanilla,
        explicit: record.explicit,
        dependencies: record.dependencies,
      })),
    }, flags);
    return;
  }
  if (flags.dirs) {
    for (const record of resolved.order) console.log(record.dir);
    return;
  }
  printHeader(resolved);
  console.log("");
  for (const record of resolved.order) {
    console.log(`${String(record.order).padStart(3)}  ${(record.guid ?? "-").padEnd(16)}  ${record.name}` +
      (record.vanilla ? "  [vanilla]" : "") + (record.explicit ? "  [explicit]" : ""));
  }
}

function cmdTree(resolved, flags) {
  const { edges, dependents } = buildGraph(resolved.selected);
  const roots = resolved.order.filter((record) => dependents.get(record).size === 0);
  const limit = rowLimit(flags);
  const maxDepth = flags.depth === undefined ? 0 : flags.depth;
  const shown = new Set();
  let rows = 0;
  let cut = false;
  const lines = [];
  const walk = (record, depth, path, { unrooted = false } = {}) => {
    if (rows >= limit) { cut = true; return; }
    if (maxDepth && depth > maxDepth) return;
    if (path.has(record)) {
      lines.push({ depth, record, cycle: true });
      rows++;
      return;
    }
    if (shown.has(record)) {
      lines.push({ depth, record, repeated: true });
      rows++;
      return;
    }
    shown.add(record);
    lines.push({ depth, record, unrooted });
    rows++;
    path.add(record);
    for (const dependency of edges.get(record) ?? []) walk(dependency, depth + 1, path);
    path.delete(record);
  };
  for (const root of roots) {
    if (rows >= limit) { cut = true; break; }
    walk(root, 0, new Set());
  }
  // A cycle leaves no root above it, and a cap can hide a subtree; every selected addon that the
  // walk did not reach is shown as a root of its own rather than silently missing from the tree.
  for (const record of resolved.order) {
    if (shown.has(record)) continue;
    if (rows >= limit) { cut = true; break; }
    walk(record, 0, new Set(), { unrooted: roots.length > 0 });
  }
  // A dependency declared by a selected addon but not selected itself is not an edge; it still has
  // to be visible, or the tree would silently omit what the addon says it needs.
  const missing = [];
  const seenMissing = new Set();
  for (const record of resolved.selected) {
    for (const guid of record.dependencies) {
      const dependency = resolved.byGuid.get(guid);
      if (dependency && dependency.selected) continue;
      // Every mod depends on the game; naming the game in the folder is optional, so an absent
      // 58D0FB3206B6F859 or 5614BBCCBB55ED1C is not a miss — a *present* one the filter dropped still is.
      if ((guid === VANILLA_GUID || guid === VANILLA_CORE_GUID) && !dependency) continue;
      const key = `${record.dir}\0${guid}`;
      if (seenMissing.has(key)) continue;
      seenMissing.add(key);
      missing.push({ record, guid, dependency });
    }
  }
  if (flags.json) {
    printJsonValue({
      command: "tree",
      ...summaryOf(resolved),
      total: lines.length,
      returned: lines.length,
      truncated: cut,
      nodes: lines.map((line) => ({
        depth: line.depth,
        name: line.record.name,
        dir: line.record.dir,
        guid: line.record.guid,
        order: line.record.order,
        vanilla: line.record.vanilla,
        ...(line.repeated ? { alreadyShown: true } : {}),
        ...(line.cycle ? { cycle: true } : {}),
        ...(line.unrooted ? { unrooted: true } : {}),
      })),
      missing: missing.map((entry) => ({ from: entry.record.name, guid: entry.guid, inAddons: !!entry.dependency })),
    }, flags);
    return;
  }
  printHeader(resolved);
  console.log("");
  for (const line of lines) {
    const indent = "  ".repeat(line.depth);
    const marks = [];
    if (line.record.vanilla) marks.push("vanilla");
    if (line.repeated) marks.push("already shown");
    if (line.cycle) marks.push("cycle");
    if (line.unrooted) marks.push("no root above it");
    console.log(`${indent}${line.depth ? "- " : ""}${line.record.name}` +
      `  ${line.record.guid ?? "(no GUID)"}${marks.length ? `  [${marks.join(", ")}]` : ""}`);
  }
  for (const entry of missing.slice(0, 20)) {
    const where = entry.dependency ? "dropped by the filter" : "not in the addons given";
    console.log(`! ${entry.record.name} depends on ${entry.guid} — ${where}`);
  }
  if (missing.length > 20) console.log(`! … and ${missing.length - 20} more dependency miss(es)`);
  if (cut) console.log(`# ${resolved.selected.length} addon(s), the tree was cut at ${lines.length} row(s) — use --limit 0`);
}

function cmdCheck(resolved, flags) {
  const problems = resolved.problems;
  const errors = problems.filter((problem) => problem.severity === "error").length;
  const warnings = problems.filter((problem) => problem.severity === "warning").length;
  const failed = errors > 0 || (flags.strict && warnings > 0);
  if (flags.json) {
    printJsonValue({
      command: "check",
      ok: !failed,
      ...summaryOf(resolved),
      errors,
      warnings,
      problems: problems.map((problem) => ({
        severity: problem.severity,
        code: problem.code,
        message: problem.message,
        ...(problem.addons ? { addons: problem.addons } : {}),
        ...(problem.guid ? { guid: problem.guid } : {}),
        ...(problem.modIds ? { modIds: problem.modIds } : {}),
      })),
    }, flags);
    if (failed) process.exitCode = 1;
    return;
  }
  printHeader(resolved);
  if (!problems.length) {
    console.log(`OK  no problems: ${resolved.selected.length} addon(s) in a derivable order`);
  } else {
    for (const problem of problems) {
      console.log(`${problem.severity === "error" ? "ERROR" : "WARN "} ${problem.code.padEnd(19)} ${problem.message}`);
    }
  }
  console.log(`# ${errors} error(s), ${warnings} warning(s)` + (flags.strict && warnings ? " — --strict makes a warning a failure" : ""));
  if (failed) process.exitCode = 1;
}

function cmdMods(resolved, flags) {
  // A `game.mods` entry needs a modId, so an addon with no identity cannot be listed — there is
  // nothing to write. The other commands report it; reproducing it as `{ "name": … }` would be a
  // config the server refuses.
  const records = resolved.order.filter((record) => (flags.includeVanilla || !record.vanilla) && record.guid);
  const mods = records.map((record) => ({
    modId: record.guid,
    ...(record.title ? { name: record.title } : {}),
    ...(record.version ? { version: record.version } : {}),
  }));
  const value = { game: { mods } };
  printJsonValue(value, flags);
}

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help) { process.stdout.write(USAGE); return; }
  if (flags._.length === 0) {
    if (flags.json) { printJsonValue({ ok: false, error: { code: "USAGE", message: "no command: name one of list, info, order, tree, check or mods" } }, flags); process.exitCode = 2; }
    else { process.stderr.write(USAGE); process.exitCode = 2; }
    return;
  }
  const [command, ...rest] = flags._;
  if (!Object.hasOwn(COMMAND_OPTIONS, command)) throw usageError(`unknown command "${command}"`);
  checkOptions(command, flags);
  if (command === "mods" && flags.includeVanilla && flags.excludeVanilla) {
    throw usageError("mods --include-vanilla asks for the game's own entries, --no-vanilla leaves them out: pick one");
  }
  if (!flags.addon.length && !flags.addons.length) {
    throw usageError(`${command} needs an addons folder: pass --addons <root>, or --addon <dir>`);
  }
  if (command === "info" && rest.length !== 1) {
    throw usageError(`info takes one addon, by name, ID, title or GUID: ${rest.length === 0 ? "none was given" : `${rest.length} were given`}`);
  }
  const resolved = resolveAddonSet({
    addon: flags.addon,
    addons: flags.addons,
    filterFile: flags.modsFile ?? null,
    excludeVanilla: !!flags.excludeVanilla,
  });
  switch (command) {
    case "list": cmdList(resolved, flags); break;
    case "info": cmdInfo(resolved, flags, rest[0]); break;
    case "order": cmdOrder(resolved, flags); break;
    case "tree": cmdTree(resolved, flags); break;
    case "check": cmdCheck(resolved, flags); break;
    case "mods": cmdMods(resolved, flags); break;
    default: throw usageError(`unknown command "${command}"`);
  }
}

/** The failure as `{ code, message }`, with the exit status a caller can rely on. */
function errorCode(err) {
  if (err.code === "USAGE" || err.usage) return "USAGE";
  if (err.code === "INPUT" || err.code === "PARSE" || err.code === "IO") return err.code;
  if (typeof err.code === "string" && /^E[A-Z]+$/.test(err.code)) return "IO";
  return "ERROR";
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  const argv = process.argv.slice(2);
  let json = false;
  for (const arg of argv) {
    if (arg === "--") break;
    if (arg === "--json" || arg === "--compact") { json = true; break; }
  }
  try {
    main();
  } catch (err) {
    const code = errorCode(err);
    if (json) {
      console.log(JSON.stringify({
        ok: false,
        error: {
          code,
          message: err.message,
          ...(err.hint ? { hint: err.hint } : {}),
          ...(err.source !== null && err.source !== undefined ? { source: err.source } : {}),
        },
      }, null, 2));
    } else {
      process.stderr.write(`error: ${err.message}\n`);
      if (err.hint) process.stderr.write(`${err.hint}\n`);
      if (code === "USAGE") process.stderr.write("run `node tools/addons.mjs --help` for the commands and options\n");
    }
    process.exitCode = code === "USAGE" ? 2 : 1;
  }
}
