// A minimal PAC1 writer, for the test suites that need a `.pak` to read.
//
//   import { buildPak } from "./helpers/pak-builder.mjs";
//   writeFileSync(path, buildPak([{ path: "configs/thing.conf", data: "…" }]));
//
// This lives outside both suites rather than in one of them because two now need it —
// `pak-tests.mjs` for the container itself, `ebin-tests.mjs` to read an EBIN resource *inside* an
// archive — and a second copy of the layout is how the two drift apart. The layout is the one
// `tools/pak.mjs` parses: FORM | PAC1 | HEAD | DATA | FILE, entry offsets from the start of the
// file (the game's choice), the index a tree of `kind | nameLength | name | …` records.
//
// `absoluteOffsets: false` writes the offsets relative to the DATA body instead. That is the layout
// the old tool assumed, and `pak-tests.mjs` keeps it as a fixture: reading it as absolute must be
// reported, not silently mis-decoded.

import { deflateSync } from "node:zlib";
import { COMPRESSION_ZLIB } from "../../tools/pak.mjs";

const HEAD_BODY = 28; // same size as every observed archive
const FORM_AND_HEAD = 12 + 8 + HEAD_BODY; // DATA body would start here
const DATA_BODY_START = FORM_AND_HEAD + 8;

const u32le = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };
const u32be = (n) => { const b = Buffer.alloc(4); b.writeUInt32BE(n >>> 0); return b; };

function encodeTree(nodes) {
  // nodes: [{ name, children }] | { name, offset, storedLength, originalLength, compressionType, timestamp }
  const parts = [];
  for (const node of nodes) {
    const nameBuf = Buffer.from(node.name, "utf8");
    if (node.children) {
      parts.push(Buffer.from([0, nameBuf.length]), nameBuf, u32le(node.children.length), encodeTree(node.children));
    } else {
      parts.push(
        Buffer.from([1, nameBuf.length]),
        nameBuf,
        u32le(node.offset), u32le(node.storedLength), u32le(node.originalLength),
        u32le(0), u32be(node.compressionType), u32le(node.timestamp ?? 0),
      );
    }
  }
  return Buffer.concat(parts);
}

/**
 * Build a PAC1 archive.
 * files: [{ path, data, compress?, compressionType?, timestamp? }]
 * absoluteOffsets: true writes the offsets the game writes (from the start of the file); false
 * writes them relative to the DATA body, which is the layout the old tool assumed and which the
 * suite must keep recognising as broken.
 */
export function buildPak(files, { absoluteOffsets = true } = {}) {
  const payloads = [];
  const flat = [];
  let cursor = 0;
  for (const f of files) {
    const compressionType = f.compressionType ?? (f.compress ? COMPRESSION_ZLIB : 0);
    const stored = compressionType === COMPRESSION_ZLIB ? deflateSync(Buffer.from(f.data)) : Buffer.from(f.data);
    const offset = absoluteOffsets ? DATA_BODY_START + cursor : cursor;
    payloads.push(stored);
    flat.push({ path: f.path, offset, storedLength: stored.length, originalLength: f.data.length, compressionType, timestamp: f.timestamp });
    cursor += stored.length;
  }

  // Tree: split the flat paths into directories.
  const rootChildren = [];
  const dirs = new Map();
  const dirFor = (segments) => {
    let list = rootChildren, prefix = "";
    for (const seg of segments) {
      prefix = prefix ? `${prefix}/${seg}` : seg;
      let dir = dirs.get(prefix);
      if (!dir) { dir = { name: seg, children: [] }; dirs.set(prefix, dir); list.push(dir); }
      list = dir.children;
    }
    return list;
  };
  for (const f of flat) {
    const segments = f.path.split("/");
    const name = segments.pop();
    dirFor(segments).push({
      name,
      offset: f.offset,
      storedLength: f.storedLength,
      originalLength: f.originalLength,
      compressionType: f.compressionType,
      timestamp: f.timestamp,
    });
  }

  const tree = Buffer.concat([Buffer.from([0, 0]), u32le(rootChildren.length), encodeTree(rootChildren)]);
  const dataBody = Buffer.concat(payloads);
  const head = Buffer.alloc(HEAD_BODY);
  const file = Buffer.alloc(12);
  file.write("FORM", 0, "latin1");
  file.writeUInt32BE(12 + 8 + HEAD_BODY + 8 + dataBody.length + 8 + tree.length, 4);
  file.write("PAC1", 8, "latin1");
  return Buffer.concat([
    file,
    Buffer.from("HEAD", "latin1"), u32be(HEAD_BODY), head,
    Buffer.from("DATA", "latin1"), u32be(dataBody.length), dataBody,
    Buffer.from("FILE", "latin1"), u32be(tree.length), tree,
  ]);
}
