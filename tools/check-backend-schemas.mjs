#!/usr/bin/env node
// Validate schemas/backend-api/ against itself and against the captured examples.
//
//   node tools/check-backend-schemas.mjs [--quiet]
//
// Three things are checked, and each of them can fail the run:
//
//   1. the index and the tree agree - every schema file and every example file under
//      schemas/backend-api/ is listed in index.json, and every file it lists exists;
//   2. every example validates against the definition its entry names in the schema its entry
//      names, with $ref resolved across files (the shared value definitions live in
//      common.schema.json);
//   3. the schemas still reject what they must - a generic mutation of every example (a required
//      property removed, an unknown property added) plus a list of endpoint-specific mutations
//      below. Without this part a schema that has quietly become "accepts anything" passes.
//
// The validator implements the same deliberate subset of draft 2020-12 that
// tools/check-rcon-schema.mjs does - $ref, type, enum, pattern, minLength, minItems, minimum,
// maximum, properties, required, additionalProperties, propertyNames, items, oneOf, allOf - and
// nothing else, so an unsupported keyword fails loudly instead of validating nothing. No
// dependencies, like the rest of tools/.
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const BASE = "schemas/backend-api";
const quiet = process.argv.includes("--quiet");

const readJson = (rel) => JSON.parse(readFileSync(join(root, rel), "utf8"));
const index = readJson(`${BASE}/index.json`);

const problems = [];
const fail = (message) => problems.push(message);

// ------------------------------------------------------------------ the walker
const show = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 70 ? `${text.slice(0, 67)}…` : text;
};

function typeMatches(value, want) {
  if (want === "null") return value === null;
  if (want === "array") return Array.isArray(value);
  if (want === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (want === "integer") return Number.isInteger(value);
  if (want === "number") return typeof value === "number";
  if (want === "string") return typeof value === "string";
  if (want === "boolean") return typeof value === "boolean";
  throw new Error(`unsupported type ${want}`);
}

// Resolve a pointer that may name another file: "common.schema.json#/$defs/uuid" resolves against
// the file that contains the reference.
function resolvePointer(pointer, fromFile) {
  const [filePart, pointerPart = ""] = pointer.split("#");
  let file = fromFile;
  if (filePart) {
    file = join(dirname(join(root, fromFile)), filePart).replace(root + "\\", "").replace(root + "/", "").replace(/\\/g, "/");
  }
  if (!schemaCache.has(file)) schemaCache.set(file, readJson(file));
  const doc = schemaCache.get(file);
  if (!pointerPart) return { node: doc, file };
  const node = pointerPart
    .replace(/^\//, "")
    .split("/")
    .reduce((acc, key) => acc?.[key], doc);
  return { node, file };
}
const schemaCache = new Map();

function resolve(node, fromFile) {
  let current = node;
  let file = fromFile;
  let guard = 0;
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    if (++guard > 20) throw new Error(`$ref loop at ${current.$ref}`);
    const next = resolvePointer(current.$ref, file);
    current = next.node;
    file = next.file;
  }
  return { node: current, file };
}

const KNOWN = new Set([
  "$schema", "$comment", "$defs", "$ref", "title", "description", "type", "enum", "const",
  "pattern", "minLength", "minItems", "minimum", "maximum", "properties", "required",
  "additionalProperties", "propertyNames", "items", "oneOf", "allOf", "default",
]);

function walk(node, value, path, errors, file) {
  if (!node || typeof node !== "object") { errors.push(`${path}: unresolvable schema node ${show(node)}`); return; }
  const resolved = resolve(node, file);
  node = resolved.node;
  file = resolved.file;
  if (!node || typeof node !== "object") { errors.push(`${path}: unresolvable schema node ${show(node)}`); return; }

  for (const keyword of Object.keys(node)) {
    if (!KNOWN.has(keyword)) { errors.push(`${path}: unsupported keyword ${keyword} in ${file}`); return; }
  }

  if (node.allOf) for (const branch of node.allOf) walk(branch, value, path, errors, file);
  if (node.oneOf) {
    const matched = node.oneOf.filter((branch) => {
      const inner = [];
      walk(branch, value, path, inner, file);
      return inner.length === 0;
    });
    if (matched.length !== 1) errors.push(`${path}: oneOf matched ${matched.length} branches, expected 1`);
  }
  if (node.const !== undefined && JSON.stringify(value) !== JSON.stringify(node.const)) {
    errors.push(`${path}: expected const ${show(node.const)}, got ${show(value)}`);
  }
  if (node.enum && !node.enum.some((v) => JSON.stringify(v) === JSON.stringify(value))) {
    errors.push(`${path}: ${show(value)} is not one of ${show(node.enum)}`);
  }
  if (node.type) {
    const wanted = Array.isArray(node.type) ? node.type : [node.type];
    if (!wanted.some((t) => typeMatches(value, t))) errors.push(`${path}: expected ${wanted.join("|")}, got ${show(value)}`);
  }
  if (typeof value === "string") {
    if (node.pattern && !new RegExp(node.pattern).test(value)) errors.push(`${path}: ${show(value)} does not match ${node.pattern}`);
    if (node.minLength !== undefined && value.length < node.minLength) errors.push(`${path}: shorter than minLength ${node.minLength}`);
  }
  if (typeof value === "number") {
    if (node.minimum !== undefined && value < node.minimum) errors.push(`${path}: below minimum ${node.minimum}`);
    if (node.maximum !== undefined && value > node.maximum) errors.push(`${path}: above maximum ${node.maximum}`);
  }
  if (Array.isArray(value)) {
    if (node.minItems !== undefined && value.length < node.minItems) errors.push(`${path}: fewer than minItems ${node.minItems}`);
    if (node.items) value.forEach((v, i) => walk(node.items, v, `${path}[${i}]`, errors, file));
  }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    for (const key of node.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property ${key}`);
    }
    if (node.propertyNames) {
      for (const key of Object.keys(value)) walk(node.propertyNames, key, `${path}.<key ${key}>`, errors, file);
    }
    for (const [key, v] of Object.entries(value)) {
      const prop = node.properties?.[key];
      if (prop) { walk(prop, v, `${path}.${key}`, errors, file); continue; }
      if (node.additionalProperties === false) { errors.push(`${path}: unknown property ${key}`); continue; }
      if (node.additionalProperties && typeof node.additionalProperties === "object") {
        walk(node.additionalProperties, v, `${path}.${key}`, errors, file);
      }
    }
  }
}

function validate(schemaFile, definition, value) {
  const errors = [];
  try {
    const doc = readJson(schemaFile);
    const node = definition.replace(/^#\//, "").split("/").reduce((acc, k) => acc?.[k], doc);
    if (!node) return [`${schemaFile}: definition ${definition} does not exist`];
    walk(node, value, "$", errors, schemaFile);
  } catch (e) {
    return [`${schemaFile}: ${e.message}`];
  }
  return errors;
}

// ------------------------------------------------------------------ 1. index vs tree
const listedSchemas = new Set();
const listedExamples = new Set();
for (const entry of index.endpoints) {
  if (entry.schema) {
    if (!existsSync(join(root, BASE, entry.schema))) fail(`index: ${entry.id} names a missing schema ${entry.schema}`);
    listedSchemas.add(entry.schema.replace(/\\/g, "/"));
  }
  for (const rel of Object.values(entry.examples ?? {})) {
    if (!existsSync(join(root, BASE, rel))) fail(`index: ${entry.id} names a missing example ${rel}`);
    listedExamples.add(rel.replace(/\\/g, "/"));
  }
}

function walkDir(dir, out = []) {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) walkDir(rel, out);
    else out.push(rel);
  }
  return out;
}

for (const rel of walkDir(BASE)) {
  const local = rel.slice(BASE.length + 1);
  if (local === "index.json" || local === "README.md" || local === "common.schema.json") continue;
  if (local.endsWith(".schema.json")) {
    if (!listedSchemas.has(local)) fail(`orphan schema: ${rel} is not listed in index.json`);
  } else if (local.startsWith("examples/")) {
    if (!listedExamples.has(local)) fail(`orphan example: ${rel} is not listed in index.json`);
  } else {
    fail(`unexpected file in schemas/backend-api/: ${rel}`);
  }
}

// ------------------------------------------------------------------ 2. examples validate
let checked = 0;
for (const entry of index.endpoints) {
  for (const [kind, rel] of Object.entries(entry.examples ?? {})) {
    const definition = entry.definitions?.[kind];
    if (!definition) { fail(`index: ${entry.id} has a ${kind} example but no ${kind} definition`); continue; }
    const value = readJson(`${BASE}/${rel}`);
    const errors = validate(`${BASE}/${entry.schema}`, definition, value);
    if (errors.length) fail(`example ${rel} does not validate:\n      ${errors.slice(0, 4).join("\n      ")}`);
    else if (!quiet) console.log(`OK   ${entry.id} ${kind} — ${rel}`);
    checked++;
  }
}

// ------------------------------------------------------------------ 3. mutations must fail
function mutate(entry, kind, rel, change) {
  const value = readJson(`${BASE}/${rel}`);
  const mutated = change(JSON.parse(JSON.stringify(value)), value);
  if (mutated === null) return null; // nothing to mutate here
  const errors = validate(`${BASE}/${entry.schema}`, entry.definitions[kind], mutated);
  if (!errors.length) fail(`mutation not rejected: ${entry.id} ${kind} — ${rel} still validates after ${change.name}`);
  return errors.length;
}

let mutations = 0;
for (const entry of index.endpoints) {
  for (const [kind, rel] of Object.entries(entry.examples ?? {})) {
    const value = readJson(`${BASE}/${rel}`);
    if (value !== null && typeof value === "object" && !Array.isArray(value)) {
      const firstRequired = readJson(`${BASE}/${entry.schema}`) && (() => {
        const doc = readJson(`${BASE}/${entry.schema}`);
        const node = entry.definitions[kind].replace(/^#\//, "").split("/").reduce((acc, k) => acc?.[k], doc);
        return (node.required ?? [])[0];
      })();
      if (firstRequired && firstRequired in value) {
        const drop = (v) => { delete v[firstRequired]; return v; };
        Object.defineProperty(drop, "name", { value: `dropping required ${firstRequired}` });
        if (mutate(entry, kind, rel, drop)) mutations++;
      }
      const add = (v) => { v.__not_a_field = true; return v; };
      Object.defineProperty(add, "name", { value: "adding an unknown property" });
      if (mutate(entry, kind, rel, add)) mutations++;
    }
  }
}

// Endpoint-specific mutations: the values whose shape is the point of the schema.
const SPECIFIC = [
  ["lobby.rooms.register", "response", "examples/lobby/rooms.register.response.json", (v) => { v.mpRoom.directJoinCode = "123"; return v; }, "a 3-digit directJoinCode"],
  ["lobby.rooms.register", "request", "examples/lobby/rooms.register.request.json", (v) => { v.scenarioId = "Missions/23_Campaign.conf"; return v; }, "a scenarioId without its GUID"],
  ["lobby.rooms.register", "request", "examples/lobby/rooms.register.request.json", (v) => { v.hostAddress = "localhost:2001"; return v; }, "a hostAddress that is not ip:port"],
  ["lobby.dedicatedServers.registerUnmanagedServer", "response", "examples/lobby/dedicatedServers.registerUnmanagedServer.response.json", (v) => { v.ownerToken = "not-a-token"; return v; }, "an ownerToken that is not a JWS"],
  ["lobby.dedicatedServers.registerUnmanagedServer", "request", "examples/lobby/dedicatedServers.registerUnmanagedServer.request.json", (v) => { v.mods = [{ modId: "6653028f468bd115" }]; return v; }, "a lowercase modId"],
  ["lobby.rooms.listActiveBans", "response", "examples/lobby/rooms.listActiveBans.response.json", (v) => { v.activeBans.entries[0].scope = "global"; return v; }, "a ban scope that is not pinned to a room"],
  ["lobby.rooms.acceptPlayer", "response", "examples/lobby/rooms.acceptPlayer.response.json", (v) => { v.platformIdentities.steamId = "kolya_500"; return v; }, "a steamId that is not a SteamID64"],
  ["workshop.assets.download-list", "request", "examples/workshop/assets.download-list.request.json", (v) => { v.assets = { "not-a-mod-id": null }; return v; }, "an assets key that is not 16 hex characters"],
  ["workshop.manifest", "response", "examples/workshop/manifest.response.json", (v) => { v.fragments[0].sha512 = "abc"; return v; }, "a fragment hash that is not SHA-512"],
  ["platform.news", "response", "examples/platform/news.response.json", (v) => { delete v.items[0].coverImage; return v; }, "a news item without its cover image"],
];

for (const [id, kind, rel, change, label] of SPECIFIC) {
  const entry = index.endpoints.find((e) => e.id === id);
  if (!entry) { fail(`specific mutation names an unknown endpoint ${id}`); continue; }
  const value = readJson(`${BASE}/${rel}`);
  const mutated = change(JSON.parse(JSON.stringify(value)));
  const errors = validate(`${BASE}/${entry.schema}`, entry.definitions[kind], mutated);
  if (!errors.length) fail(`mutation not rejected: ${label} still validates against ${entry.schema}`);
  else mutations++;
}

// ------------------------------------------------------------------ summary
console.log("");
console.log(`${index.endpoints.length} endpoint(s) in the index, ${checked} example(s) validated, ${mutations} mutation(s) rejected`);
if (problems.length) {
  console.error(`\n${problems.length} PROBLEM(S)`);
  for (const p of problems) console.error(`FAIL  ${p}`);
  process.exit(1);
}
console.log("BACKEND SCHEMAS OK");
