// Coverage check: schemas/server.schema.json <-> data/server-keys.json.
//
//   node tools/check-schema-coverage.mjs
//
// The schema is hand-written while data/server-keys.json is generated from
// docs/en/ArmaReforger_ServerConfig_EN.md §5, so the two can drift apart silently.
// This is the guard, in both directions:
//
//   * a key documented in §5 but missing from the schema  -> the schema would let a
//     typo through, because additionalProperties:false only rejects keys it does not know;
//   * a key in the schema but not in §5 -> an invented key, or a stale one.
//
// It also verifies that every local $ref in the schema resolves, and that the objects
// derived from §5 keep additionalProperties:false (that is what makes unknown keys fail).
import { readFileSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const schema = JSON.parse(readFileSync(join(root, "schemas", "server.schema.json"), "utf8"));
const keys = JSON.parse(readFileSync(join(root, "data", "server-keys.json"), "utf8"));
const mh = JSON.parse(readFileSync(join(root, "data", "mission-header-fields.json"), "utf8"));

let failures = 0;
const fail = (message) => {
  failures++;
  console.log(`FAIL  ${message}`);
};
const ok = (message) => console.log(`OK    ${message}`);

/** Every local $ref must resolve — a typo here silently disables a whole branch. */
function checkRefs(node, path = "#") {
  if (Array.isArray(node)) return node.forEach((n, i) => checkRefs(n, `${path}/${i}`));
  if (!node || typeof node !== "object") return;
  if (typeof node.$ref === "string") {
    if (!node.$ref.startsWith("#/")) fail(`unresolvable non-local $ref ${node.$ref} at ${path}`);
    else if (resolveRef(node.$ref) == null) fail(`dangling $ref ${node.$ref} at ${path}`);
  }
  for (const [k, v] of Object.entries(node)) checkRefs(v, `${path}/${k}`);
}
function resolveRef(ref) {
  let node = schema;
  for (const part of ref.slice(2).split("/")) node = node?.[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  return node ?? null;
}

checkRefs(schema);
if (!failures) ok("every local $ref in the schema resolves");

/** Walk from the schema root to the object node that governs a documented parent. */
const SCOPES = [
  { parent: "root", steps: [] },
  { parent: "a2s", steps: ["a2s"] },
  { parent: "rcon", steps: ["rcon"] },
  { parent: "game", steps: ["game"] },
  { parent: "game.mods[]", steps: ["game", "mods", "[]"] },
  { parent: "game.gameProperties", steps: ["game", "gameProperties"] },
  { parent: "operating", steps: ["operating"] },
  { parent: "operating.joinQueue", steps: ["operating", "joinQueue"] },
];

for (const { parent, steps } of SCOPES) {
  // Start at the schema root itself, so that the "root" scope is checked against the real
  // root object (including its additionalProperties) rather than a synthetic wrapper.
  let node = schema;
  for (const step of steps) {
    node = step === "[]" ? node.items : node.properties?.[step];
    if (node?.$ref) node = resolveRef(node.$ref);
    if (!node) break;
  }
  if (!node?.properties) {
    fail(`${parent}: could not resolve the schema node`);
    continue;
  }

  const schemaKeys = Object.keys(node.properties).sort();
  const documented = keys.keys.filter((k) => k.parent === parent).map((k) => k.key);
  // Section 5.7 lists undocumented game fields in a fenced block rather than a table.
  const extra = parent === "game" ? keys.undocumentedKeys.map((k) => k.replace(/^game\./, "")) : [];
  const dataKeys = [...new Set([...documented, ...extra])].sort();

  const missing = dataKeys.filter((k) => !schemaKeys.includes(k));
  const invented = schemaKeys.filter((k) => !dataKeys.includes(k));
  if (missing.length) fail(`${parent}: documented in the guide but absent from the schema: ${missing.join(", ")}`);
  if (invented.length) fail(`${parent}: present in the schema but not documented: ${invented.join(", ")}`);
  if (!missing.length && !invented.length) ok(`${parent}: ${schemaKeys.length} keys agree with the guide`);

  if (node.additionalProperties !== false) {
    fail(`${parent}: additionalProperties is not false, so an unknown key would pass validation`);
  }
}

// missionHeader keys live in their own generated file and are checked by the validator
// against the scenario's header class, so the schema deliberately allows any key there.
const mhNode = resolveRef(schema.properties.game.properties.gameProperties.$ref).properties.missionHeader;
if (mhNode?.additionalProperties !== true) {
  fail("game.gameProperties.missionHeader: additionalProperties must stay true (the field set is class-dependent)");
} else if (!String(mhNode.description).includes("data/mission-header-fields.json")) {
  fail("game.gameProperties.missionHeader: the description must point at data/mission-header-fields.json");
} else {
  ok(`missionHeader: ${mh.fields.length} documented keys (${mh.counts.base} base + ${mh.counts.campaign} campaign) are checked by the validator, not the schema`);
}

console.log(`\n${failures === 0 ? "SCHEMA COVERS THE GUIDE" : failures + " COVERAGE PROBLEM(S)"}`);
process.exit(failures ? 1 : 0);
