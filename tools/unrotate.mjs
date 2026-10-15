// Un-rotate mission header configs extracted from an Arma Reforger .pak.
//
// WHY: pak entries for these .conf files come back cyclically shifted — the tail
// appears first and the head lands at the end. No bytes are lost, only the cut point
// is wrong. Reading such a file directly gives a config whose first line is the middle
// of the `World` value, which makes it look truncated when it is not.
//
// HOW: find the LAST occurrence of the header class marker in the raw bytes and rotate
// the buffer there. Works on Buffers, never on decoded text, so the file is not mangled.
//
// Usage:
//   node tools/unrotate.mjs <dir-with-conf-files>
// Originals are copied to <dir>/_orig before being rewritten.

import { readFileSync, writeFileSync, readdirSync, mkdirSync, copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir || !existsSync(dir)) {
  console.error("Usage: node tools/unrotate.mjs <dir-with-conf-files>");
  process.exit(1);
}

// Longest marker first: the more specific class must win when several are present.
const MARKERS = ["SCR_MissionHeaderCampaign", "SCR_MissionHeaderCombatOps", "SCR_MissionHeader"];

const origDir = join(dir, "_orig");
mkdirSync(origDir, { recursive: true });

let rotated = 0, aligned = 0, skipped = 0;

for (const name of readdirSync(dir)) {
  if (!name.toLowerCase().endsWith(".conf")) continue;
  const p = join(dir, name);
  const buf = readFileSync(p);
  const latin = buf.toString("latin1");

  let head = -1, which = null;
  for (const m of MARKERS) {
    const i = latin.lastIndexOf(m);
    if (i > head) { head = i; which = m; }
  }

  if (head < 0) {
    console.log(`??  ${name}: no header marker found, left untouched`);
    skipped++;
    continue;
  }
  if (head === 0) {
    console.log(`==  ${name}: already aligned (${which})`);
    aligned++;
    continue;
  }

  if (!existsSync(join(origDir, name))) copyFileSync(p, join(origDir, name));
  writeFileSync(p, Buffer.concat([buf.subarray(head), buf.subarray(0, head)]));
  console.log(`->  ${name}: rotated at ${head}/${buf.length} (${which})`);
  console.log(`    first line now: ${buf.subarray(head).toString("latin1").split("\n")[0]}`);
  rotated++;
}

console.log(`\n${rotated} rotated, ${aligned} already aligned, ${skipped} skipped.`);
if (rotated) console.log(`Untouched originals are in ${origDir}`);
if (skipped) console.log("Skipped files may use a class not in the marker list, or may be wrapped differently.");
