#!/usr/bin/env node
// Validate the JSON that tools/rcon.mjs prints against schemas/rcon-result.schema.json, using the
// examples in skills/arma-reforger-rcon/SKILL.md as the instances: every ```json block preceded by
// an `<!-- rcon-json: result -->` or `<!-- rcon-json: command -->` marker is checked against the
// variant it names. Mutations of those examples that have to be rejected are checked too, so a
// schema that has quietly become "accepts anything" fails here rather than passing quietly.
//
// The schema uses a small, deliberate subset of draft 2020-12 — $ref, type, enum, properties,
// required, additionalProperties, items, oneOf — and the validator below implements exactly that
// subset. No dependencies, like the rest of tools/.
//
//   node tools/check-rcon-schema.mjs [file.md]
//
// The optional argument is a markdown file to read the examples from instead of the skill — used to
// validate captured output of a real run, so the schema is checked against the tool and not only
// against its own documentation.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCHEMA_FILE = "schemas/rcon-result.schema.json";
const SKILL_FILE = process.argv[2] ?? "skills/arma-reforger-rcon/SKILL.md";

const schema = JSON.parse(readFileSync(join(root, SCHEMA_FILE), "utf8"));
const skill = readFileSync(join(root, SKILL_FILE), "utf8");

// ------------------------------------------------------------------------------- the walker
const show = (value) => {
  const text = JSON.stringify(value);
  return text === undefined ? String(value) : text.length > 60 ? `${text.slice(0, 57)}…` : text;
};

function typeMatches(value, want) {
  if (want === "null") return value === null;
  if (want === "array") return Array.isArray(value);
  if (want === "object") return value !== null && typeof value === "object" && !Array.isArray(value);
  if (want === "integer") return Number.isInteger(value);
  if (want === "number") return typeof value === "number";
  if (want === "string") return typeof value === "string";
  if (want === "boolean") return typeof value === "boolean";
  return false;
}

function resolvePointer(pointer) {
  return pointer
    .replace(/^#\//, "")
    .split("/")
    .reduce((acc, key) => acc?.[key], schema);
}

function resolve(node) {
  let current = node;
  while (current && typeof current === "object" && typeof current.$ref === "string") {
    current = resolvePointer(current.$ref);
  }
  return current;
}

function check(node, value, path, errors) {
  // A bare pointer is allowed where a caller names a definition directly, and resolving it is not
  // optional: an unresolvable or unhandled node must fail loudly rather than validate nothing.
  const schemaNode = typeof node === "string" ? resolvePointer(node) : resolve(node);
  if (!schemaNode || typeof schemaNode !== "object") {
    errors.push(`${path}: unresolvable schema node ${JSON.stringify(node)}`);
    return;
  }
  if (schemaNode.oneOf) {
    const matches = schemaNode.oneOf.filter((branch) => {
      const branchErrors = [];
      check(branch, value, path, branchErrors);
      return branchErrors.length === 0;
    });
    if (matches.length !== 1) {
      errors.push(`${path}: expected exactly one of the ${schemaNode.oneOf.length} variants, ${matches.length} matched`);
    }
    return;
  }
  if (schemaNode.type !== undefined) {
    const wanted = Array.isArray(schemaNode.type) ? schemaNode.type : [schemaNode.type];
    if (!wanted.some((want) => typeMatches(value, want))) {
      errors.push(`${path}: expected ${wanted.join(" or ")}, got ${show(value)}`);
      return;
    }
  }
  if (schemaNode.enum && !schemaNode.enum.includes(value)) {
    errors.push(`${path}: ${show(value)} is not one of ${schemaNode.enum.map(show).join(", ")}`);
  }
  if (Array.isArray(value)) {
    if (schemaNode.items) value.forEach((item, i) => check(schemaNode.items, item, `${path}[${i}]`, errors));
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const key of schemaNode.required ?? []) {
      if (!(key in value)) errors.push(`${path}: missing required property "${key}"`);
    }
    for (const [key, child] of Object.entries(value)) {
      const property = schemaNode.properties?.[key];
      if (property) check(property, child, `${path}.${key}`, errors);
      else if (schemaNode.additionalProperties === false) errors.push(`${path}: unexpected property "${key}"`);
    }
  }
}

const validate = (node, value) => {
  const errors = [];
  check(node, value, "root", errors);
  return errors;
};

// ------------------------------------------------------------------- the examples in the skill
// A marker comment names the variant the block has to be; the block itself is plain JSON, so
// `npm run check:json` parses the same text. CRLF is tolerated here: the repository's own files are
// LF (check:encoding), but a captured run pasted into a file may not be.
const EXAMPLES = /<!--\s*rcon-json:\s*(result|command)\s*-->[ \t]*\r?\n+```json\r?\n([\s\S]*?)```/g;
const VARIANTS = { result: "#/$defs/result", command: "#/$defs/shellLine" };
const examples = [];
for (const match of skill.matchAll(EXAMPLES)) {
  const [, variant, body] = match;
  if (!VARIANTS[variant]) {
    console.error(`FAIL ${SKILL_FILE}: unknown marker "${variant}"`);
    process.exit(1);
  }
  let value;
  try {
    value = JSON.parse(body);
  } catch (err) {
    console.error(`FAIL ${SKILL_FILE}: the ${variant} example is not JSON — ${err.message}`);
    process.exit(1);
  }
  examples.push({ variant, value, node: VARIANTS[variant] });
}

let failed = 0;
const report = (ok, what, detail = "") => {
  if (!ok) failed += 1;
  console.log(`${ok ? "OK  " : "FAIL"} ${what}${detail ? ` — ${detail}` : ""}`);
};

if (!examples.length) {
  console.error(`FAIL ${SKILL_FILE}: no example carries an <!-- rcon-json: result|command --> marker`);
  process.exit(1);
}

for (const [i, example] of examples.entries()) {
  const errors = validate(example.node, example.value);
  report(errors.length === 0, `${SKILL_FILE} example ${i + 1} (${example.variant})`, errors.slice(0, 3).join("; "));
}

// The variants have to stay disjoint: that is what makes the top-level oneOf meaningful.
for (const example of examples) {
  const other = example.variant === "result" ? "#/$defs/shellLine" : "#/$defs/result";
  report(validate(other, example.value).length > 0, `the ${example.variant} example is not also a ${example.variant === "result" ? "shellLine" : "result"}`);
}

// Mutations that must be rejected — otherwise the schema accepts anything and the checks above
// would pass for the wrong reason.
const resultExample = examples.find((example) => example.variant === "result");
if (!resultExample) {
  console.error(`FAIL ${SKILL_FILE}: no example is marked as a result, so the mutations have nothing to start from`);
  process.exit(1);
}
const wrong = [
  ["an unknown extra property", (v) => (v.surprise = true)],
  ["a players list that is not an array", (v) => (v.players = { playerId: 1 })],
  ["a missing top-level field", (v) => delete v.loggedOut],
  ["a status outside the enum", (v) => (v.commands[0].status = "fine")],
  ["a command entry with a wrong exit code", (v) => (v.commands[0].exitCode = 1)],
];
for (const [what, mutate] of wrong) {
  const value = structuredClone(resultExample.value);
  mutate(value);
  const errors = validate("#/$defs/result", value);
  report(errors.length > 0, `rejected: ${what}`, errors[0] ?? "the schema accepted it");
}

console.log(failed === 0 ? `\nALL RCON EXAMPLES MATCH ${SCHEMA_FILE}` : `\n${failed} check(s) failed`);
process.exit(failed === 0 ? 0 : 1);
