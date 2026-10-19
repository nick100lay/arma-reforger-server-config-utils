// A minimal RDBC writer, for the test suites that need a `resourceDatabase.rdb` to read.
//
//   import { entry, database, MTIME } from "./helpers/rdb-builder.mjs";
//   writeFileSync(path, database({ entries: [entry({ path: "worlds/Demo.ent", guid: "…" })] }));
//
// This lives outside the suites rather than in one of them because two now need it — `rdb-tests.mjs`
// for the container itself, `layer-tests.mjs` for the GUID → world → layer resolution — and a second
// copy of the layout is how the two drift apart. The layout is the one `tools/rdb.mjs` parses:
// `FORM | size | RDBC | version | size`, then `flags | names | count`, then the root record and the
// entries, every record `u32 pathLen+1 | path | 0 | u32 kind | u16 flags | GUID 8 | (mtime, type)`.
//
// The GUID is written **little-endian** (`reverse()`), which is what the game's writer does and what
// makes `rdb.mjs` read it back as the same hex string it was given.
import { KIND, RDB_VERSION } from "../../tools/rdb.mjs";

export const u16 = (n) => { const b = Buffer.alloc(2); b.writeUInt16LE(n); return b; };
export const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
export const guidBytes = (hex) => Buffer.from(hex, "hex").reverse();

/** A real mtime (~1.7e9), which is what lets the parser tell metadata from the next record. */
export const MTIME = 1777368604;

/**
 * One record: `u32 pathLen+1 | path | 0 | u32 kind | u16 flags | GUID 8` and, when `meta` is given,
 * `u32 mtime | u32 type`.
 */
export function entry({ path = "", kind = KIND.FILE, flags = 0, guid = "0000000000000000", meta = null }) {
  const bytes = Buffer.from(path, "latin1");
  const parts = [u32(bytes.length + 1), bytes, Buffer.from([0]), u32(kind), u16(flags), guidBytes(guid)];
  if (meta) for (const word of meta) parts.push(u32(word));
  return Buffer.concat(parts);
}

/** A database: prologue, header (flags, names, count), the root, then the entries. */
export function database({
  names = [], entries, version = RDB_VERSION, flags = 0, count = null, rootMeta = null,
  rootGuid = "0000000000000000",
}) {
  // Version 5 has no name table: the field after the flags is the record count.
  const nameFields = version <= 5 ? [] : [
    u32(names.length),
    ...names.map((name) => {
      const bytes = Buffer.from(name, "utf8");
      return Buffer.concat([u32(bytes.length + 1), bytes, Buffer.from([0])]);
    }),
  ];
  const header = Buffer.concat([u32(flags), ...nameFields, u32(count ?? entries.length + 1)]);
  const body = Buffer.concat([entry({ path: "", kind: KIND.DIRECTORY, guid: rootGuid, meta: rootMeta }), ...entries]);
  const size = 20 + header.length + body.length;
  const prologue = Buffer.alloc(20);
  prologue.write("FORM", 0, "latin1");
  prologue.writeUInt32BE(size - 8, 4);
  prologue.write("RDBC", 8, "latin1");
  prologue.writeUInt32LE(version, 12);
  prologue.writeUInt32LE(size, 16);
  return Buffer.concat([prologue, header, body]);
}
