// Read Arma Reforger PAC1 archives (.pak): list, inspect, extract, search, verify.
//
//   node tools/pak.mjs info   <pak> [--json] [--compact]
//   node tools/pak.mjs list   <pak|dir> [pathRegex] [--limit N|0] [--all] [--from N] [--json]
//   node tools/pak.mjs tree   <pak> [pathRegex] [--depth N] [--limit N|0] [--json]
//   node tools/pak.mjs get    <pak> <virtualPath> <outFile> [--path-regex RE] [--dry-run] [--json]
//   node tools/pak.mjs cat    <pak> <virtualPath> [<lines>] [--lines A-B] [--numbers] [--json]
//   node tools/pak.mjs find   <pak|dir> <needle> [--regex] [--ignore-case] [--max-size N]
//                                            [--path-regex RE] [--from N] [--limit N|0] [--json]
//   node tools/pak.mjs verify <pak|dir> [--sample N] [--limit N|0] [--json]
//
// Three rules make this tool usable by a program as well as by a person, and every
// command follows them:
//
//   * No answer is silently partial. `--limit N` caps, `0`/`--all` lifts it, and a
//     cap that hid something is reported -- a footer in the text, `total`/`from`/
//     `returned`/`truncated` in the JSON.
//   * Every command that answers a list has `--json`, and a bad option or value is
//     refused instead of changing the answer (`--limit -1` used to drop the last
//     row, `--limit abc` every row, and a misspelt `--json` became the path regex).
//   * `<pak|dir>` takes a folder: the client install measured here is 16 archives and
//     222 572 entries, so "which archive holds this file" is one call, not a loop.
//
// Before these rules, `--limit 0` reached `slice(0, 0)` -- the command printed its
// header and no rows, and `--json` answered `[]`, indistinguishable from "nothing
// matched"; `find` encoded the needle as Latin-1, so no needle above U+00FF could
// ever match; and `tree` had no cap at all (51 558 lines on `worlds001.pak`).
//
// `get` takes a file *or* a directory and extracts the whole subtree of the
// latter; "/" is the archive root, so `get <pak> / <dir>` dumps every entry, and
// `--path-regex` extracts a subset of it. <outFile> names the destination, and an
// existing directory (or a path ending in a separator) means "inside it, under the
// entry's own name" -- the rule `cp -r` uses. Destination paths this platform
// cannot create are refused by name before anything is written; see "Output
// paths" below.
//
// Also usable as a library:
//   import { openPak, findEntry, findTarget } from "./pak.mjs";
//   const pak = openPak(path); pak.entries; pak.dirs; pak.read(entry);
//   listPaks(path), decodeEntry(bytes), splitLines(text) are exported for the
//   readers that grew out of this one (`loc`, `etconf`, `ebin`, `layer`).
//
// ---------------------------------------------------------------------------
// The container, as measured on the installed 1.8.0.13 client and server
// archives (all 24 .pak files under addons/, 190 000+ entries):
//
//   offset 0   "FORM" + u32BE size + "PAC1"                    (12 bytes)
//   then chunks, each `u32BE magic + u32BE bodyLength + body`:
//     "HEAD" -> 28 bytes of pack metadata, skip
//     "DATA" -> all entry payloads, back to back, in index order
//     "FILE" -> the entry tree, and the last chunk in every observed pak
//
// Entry tree, read sequentially (u8 kind, u8 nameLength, name, then):
//     kind 0 (directory): u32LE childCount, childCount entries
//     kind 1 (file):      u32LE offset          <-- ABSOLUTE file offset, see below
//                         u32LE storedLength
//                         u32LE originalLength  (0 for a directory-like stub)
//                         4 bytes, always zero in every archive observed
//                         u32BE compressionType: 0 = stored, 0x106 = zlib
//                         u32LE timestamp       (pack time, seconds since epoch)
//
// `offset` is measured from the start of the .pak file, NOT from the start of
// the DATA chunk body. The two differ by 56 bytes in every archive here -- the
// 12-byte FORM header, the 8+28-byte HEAD chunk and the 8-byte DATA chunk
// header -- and reading from the wrong base is exactly the defect that made
// earlier tools report `incorrect header check` on compressed files and hand
// back cyclically shifted text for stored ones. `verify` checks the choice on
// the archive in front of it; `--data-relative` reproduces the old behaviour
// so an extract made with the broken tool can be recognised.
//
// Compression types other than 0 and 0x106 have never been observed; if one
// appears, `read()` refuses to guess and `--raw` writes the stored bytes.
// ---------------------------------------------------------------------------

import { openSync, readSync, closeSync, fstatSync, writeFileSync, mkdirSync, statSync, existsSync, readdirSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { dirname, join, parse, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const MAGIC_FORM = 0x464f524d; // "FORM"
export const MAGIC_PAC1 = 0x50414331; // "PAC1"
export const CHUNK_HEAD = 0x48454144; // "HEAD"
export const CHUNK_DATA = 0x44415441; // "DATA"
export const CHUNK_FILE = 0x46494c45; // "FILE"

export const COMPRESSION_STORED = 0x0;
export const COMPRESSION_ZLIB = 0x106;

const COMPRESSION_NAMES = {
  [COMPRESSION_STORED]: "stored",
  [COMPRESSION_ZLIB]: "zlib",
};

export function compressionName(type) {
  return COMPRESSION_NAMES[type] ?? `unknown(0x${type.toString(16)})`;
}

/** Read exactly `length` bytes at `position`, or throw with the position in the message. */
function readAt(fd, position, length, what) {
  const buf = Buffer.alloc(length);
  const n = readSync(fd, buf, 0, length, position);
  if (n < length) {
    throw new Error(
      `truncated archive: wanted ${length} bytes of ${what} at offset ${position}, got ${n}`,
    );
  }
  return buf;
}

export class PakEntry {
  constructor({ path, kind, offset, storedLength, originalLength, zeroField, compressionType, timestamp }) {
    this.path = path;
    this.kind = kind; // "file" | "dir"
    this.offset = offset;
    this.storedLength = storedLength;
    this.originalLength = originalLength;
    this.zeroField = zeroField;
    this.compressionType = compressionType;
    this.timestamp = timestamp; // Date, or null for a directory
    this.children = kind === "dir" ? [] : null;
  }
  get name() {
    return this.path.slice(this.path.lastIndexOf("/") + 1);
  }
}

export class Pak {
  constructor(fd, path, { chunks, dataStart, dataLength, fileChunkOffset, fileChunkLength, root, entries, dirs, formLength, size }) {
    this.fd = fd;
    this.path = path;
    this.chunks = chunks;
    this.dataStart = dataStart;
    this.dataLength = dataLength;
    this.fileChunkOffset = fileChunkOffset;
    this.fileChunkLength = fileChunkLength;
    this.root = root;
    this.entries = entries;
    /** Every directory in the index except the unnamed root, in tree order. */
    this.dirs = dirs;
    /** The `FORM` chunk length declared at offset 4, and the size of the file on disk. */
    this.formLength = formLength;
    this.size = size;
    this.closed = false;
  }

  close() {
    if (!this.closed) {
      closeSync(this.fd);
      this.closed = true;
    }
  }

  /** Read the payload bytes of one entry. Returns raw stored bytes when `raw` is true. */
  read(entry, { raw = false, dataRelative = false } = {}) {
    const at = dataRelative ? this.dataStart + entry.offset : entry.offset;
    if (entry.storedLength === 0) return Buffer.alloc(0);
    const bytes = readAt(this.fd, at, entry.storedLength, `entry ${entry.path}`);
    if (raw || entry.compressionType === COMPRESSION_STORED) return bytes;
    if (entry.compressionType !== COMPRESSION_ZLIB) {
      throw new Error(
        `entry ${entry.path} uses compression type ${compressionName(entry.compressionType)}, ` +
          `which this tool does not know how to decompress; re-run with --raw to get the stored bytes`,
      );
    }
    try {
      const out = inflateSync(bytes);
      return out;
    } catch (err) {
      throw new Error(
        `entry ${entry.path} did not inflate (${err.code ?? err.message}) from offset ${at}; ` +
          `this is the signature of a wrong offset base -- run \`node tools/pak.mjs verify ${this.path}\``,
      );
    }
  }
}

/** Walk the FILE chunk tree. Returns the root entry plus the flat file and directory lists. */
function parseTree(buf) {
  let pos = 0;
  const files = [];
  const dirs = [];

  function parseOne(prefix) {
    const kind = buf.readUInt8(pos); pos += 1;
    const nameLength = buf.readUInt8(pos); pos += 1;
    const name = buf.toString("utf8", pos, pos + nameLength); pos += nameLength;
    // The root entry has an empty name; skip it so paths never start with "/".
    const childPrefix = name ? prefix + name + "/" : prefix;
    if (kind === 0) {
      const entry = new PakEntry({ path: prefix + name, kind: "dir" });
      // The unnamed root is not an addressable path, so it stays out of `dirs`.
      if (name) dirs.push(entry);
      const childCount = buf.readUInt32LE(pos); pos += 4;
      for (let i = 0; i < childCount; i++) entry.children.push(parseOne(childPrefix));
      return entry;
    }
    if (kind !== 1) {
      throw new Error(`unexpected entry kind ${kind} in the FILE chunk at byte ${pos - 2 - nameLength}`);
    }
    const offset = buf.readUInt32LE(pos); pos += 4;
    const storedLength = buf.readUInt32LE(pos); pos += 4;
    const originalLength = buf.readUInt32LE(pos); pos += 4;
    const zeroField = buf.readUInt32LE(pos); pos += 4;
    const compressionType = buf.readUInt32BE(pos); pos += 4;
    const timestamp = buf.readUInt32LE(pos); pos += 4;
    const entry = new PakEntry({
      path: prefix + name,
      kind: "file",
      offset,
      storedLength,
      originalLength,
      zeroField,
      compressionType,
      timestamp: timestamp > 0 ? new Date(timestamp * 1000) : null,
    });
    files.push(entry);
    return entry;
  }

  const root = parseOne("");
  return { root, files, dirs, consumed: pos, leftover: buf.length - pos };
}

/** Open an archive and parse its index. The caller owns the returned Pak and must close() it. */
export function openPak(path) {
  const fd = openSync(path, "r");
  try {
    const size = fstatSync(fd).size;
    if (size < 16) throw new Error(`${path} is too small to be a PAC1 archive`);
    const form = readAt(fd, 0, 12, "the FORM header");
    if (form.readUInt32BE(0) !== MAGIC_FORM) {
      throw new Error(`${path} does not start with "FORM" -- not a PAC1 archive`);
    }
    if (form.readUInt32BE(8) !== MAGIC_PAC1) {
      throw new Error(`${path} has FORM but not PAC1 at offset 8 -- not a PAC1 archive`);
    }
    const formLength = form.readUInt32BE(4);

    const chunks = [];
    let dataStart = -1, dataLength = 0, fileChunkOffset = -1, fileChunkLength = 0;
    let pos = 12;
    while (pos + 8 <= size) {
      const header = readAt(fd, pos, 8, "a chunk header");
      const magic = header.readUInt32BE(0);
      const length = header.readUInt32BE(4);
      const name = magic === CHUNK_HEAD ? "HEAD"
        : magic === CHUNK_DATA ? "DATA"
        : magic === CHUNK_FILE ? "FILE"
        : `0x${magic.toString(16)}`;
      chunks.push({ name, offset: pos, bodyOffset: pos + 8, length });
      if (magic === CHUNK_DATA && dataStart < 0) {
        dataStart = pos + 8;
        dataLength = length;
      }
      if (magic === CHUNK_FILE) {
        fileChunkOffset = pos + 8;
        fileChunkLength = length;
        break;
      }
      pos += 8 + length;
    }
    if (fileChunkOffset < 0) throw new Error(`${path} has no FILE chunk -- the index cannot be read`);
    if (dataStart < 0) throw new Error(`${path} has no DATA chunk`);
    if (fileChunkOffset + fileChunkLength > size) {
      throw new Error(
        `${path} is truncated: the FILE chunk claims ${fileChunkLength} bytes at ${fileChunkOffset}, ` +
          `but the file is ${size} bytes`,
      );
    }

    const fileBuf = readAt(fd, fileChunkOffset, fileChunkLength, "the FILE chunk");
    const { root, files, dirs, consumed, leftover } = parseTree(fileBuf);
    if (leftover > 0) {
      throw new Error(
        `the FILE chunk of ${path} has ${leftover} bytes left after ${files.length} entries ` +
          `(parsed ${consumed} of ${fileBuf.length}); the index is not a plain entry tree`,
      );
    }
    return new Pak(fd, path, { chunks, dataStart, dataLength, fileChunkOffset, fileChunkLength, root, entries: files,
      dirs, formLength, size });
  } catch (err) {
    closeSync(fd);
    throw err;
  }
}

/** Normalise a virtual path for comparison: leading slash optional, backslashes allowed. */
export function normalisePath(path) {
  return path.replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
}

/**
 * A source as the tool command lines write it: a file on disk, or one entry inside a `.pak`,
 * written `<pak>:<entry>`.
 *
 *   node tools/loc.mjs get "<install>/addons/data/data007.pak:Language/localization.ru_ru.conf" …
 *
 * Two rules keep a Windows path out of the way: the split is at the **last** colon, and only when
 * everything before it ends in `.pak` — so `C:\dir\localization.ru_ru.conf` is a file (its only
 * colon is the drive's) while `C:\dir\data007.pak:Language/…` is an entry. `noPakPathSplit` turns
 * the split off altogether: the escape hatch for a file name that carries a colon or ends in
 * `.pak` — it is the code name of the `--no-pak-path-split` option every reader offers.
 *
 * This lives here rather than in one reader because every reader that accepts a `.pak` entry needs
 * the same rule, and a second copy is how the two drift apart.
 */
export function parseSourceSpec(spec, { noPakPathSplit = false } = {}) {
  const wanted = String(spec);
  if (noPakPathSplit) return { kind: "file", path: wanted, display: wanted };
  const at = wanted.lastIndexOf(":");
  if (at > 0 && /\.pak$/i.test(wanted.slice(0, at))) {
    const pak = wanted.slice(0, at);
    const entry = normalisePath(wanted.slice(at + 1));
    if (!entry) throw new Error(`"${spec}" names a pak but no entry: write <pak>:<entry>`);
    return { kind: "pak", pak, entry, display: `${pak}:${entry}` };
  }
  return { kind: "file", path: wanted, display: wanted };
}

/**
 * Find one *file* entry by virtual path (with or without a leading slash). Throws
 * when absent. Directories are not entries; use findTarget to resolve either.
 */
export function findEntry(pak, virtualPath) {
  const want = normalisePath(virtualPath);
  const lowered = want.toLowerCase();
  let hit = pak.entries.find((e) => normalisePath(e.path) === want);
  if (!hit) hit = pak.entries.find((e) => normalisePath(e.path).toLowerCase() === lowered);
  if (!hit) {
    const near = pak.entries
      .filter((e) => normalisePath(e.path).toLowerCase().endsWith(lowered.split("/").pop()))
      .slice(0, 5)
      .map((e) => `    ${normalisePath(e.path)}`);
    throw new Error(
      `no entry "${want}" in ${pak.path}` + (near.length ? `\n  similarly named entries:\n${near.join("\n")}` : ""),
    );
  }
  return hit;
}

/**
 * Resolve a virtual path to either one file entry or one directory.
 *
 * A path of only separators (or an empty one) is the archive **root**: it has no
 * name of its own, and extracting it means every entry in the archive. Files win
 * over directories of the same name, exact case wins over a case-insensitive hit,
 * and a miss reports the near-matching names of both kinds -- a path that names a
 * directory is the common mistake, and `get` accepts it.
 * Returns { kind: "file"|"dir", entry, path, name }.
 */
export function findTarget(pak, virtualPath) {
  const want = normalisePath(virtualPath);
  if (want === "") return { kind: "dir", entry: pak.root, path: "", name: "" };
  const lowered = want.toLowerCase();
  const byPath = (list) =>
    list.find((e) => normalisePath(e.path) === want) ??
    list.find((e) => normalisePath(e.path).toLowerCase() === lowered);

  const file = byPath(pak.entries);
  if (file) return { kind: "file", entry: file, path: normalisePath(file.path), name: file.name };
  const dir = byPath(pak.dirs);
  if (dir) return { kind: "dir", entry: dir, path: normalisePath(dir.path), name: dir.name };

  const tail = lowered.split("/").pop();
  const all = [
    ...pak.entries.map((e) => normalisePath(e.path)),
    ...pak.dirs.map((d) => `${normalisePath(d.path)}/`),
  ];
  // The exact tail first, then anywhere in the path, then tolerating one wrong
  // last character -- the typos that actually happen when a path is copied.
  const attempts = [
    (p) => p.toLowerCase().endsWith(tail),
    (p) => tail.length > 2 && p.toLowerCase().includes(tail),
    (p) => tail.length > 3 && p.toLowerCase().includes(tail.slice(0, -1)),
  ];
  let near = [];
  for (const test of attempts) {
    near = all.filter(test);
    if (near.length) break;
  }
  near = near.slice(0, 5).map((p) => `    ${p}`);
  throw new Error(
    `no entry or directory "${want}" in ${pak.path}` +
      (near.length ? `\n  similarly named paths:\n${near.join("\n")}` : ""),
  );
}

/**
 * Decide whether this archive's offsets are absolute or relative to the DATA body.
 * Compressed entries start with a zlib header (0x78, then a byte that makes the
 * 16-bit value a multiple of 31), so a handful of them is enough to tell the two
 * bases apart. Returns { base, absoluteHits, relativeHits, tested }.
 */
export function detectOffsetBase(pak) {
  const candidates = pak.entries.filter((e) => e.compressionType === COMPRESSION_ZLIB && e.storedLength >= 2).slice(0, 64);
  let absoluteHits = 0, relativeHits = 0;
  for (const e of candidates) {
    const probe = (at) => {
      if (at < 0 || at + 2 > pak.fileChunkOffset) return false;
      const b = readAt(pak.fd, at, 2, `probe for ${e.path}`);
      return b[0] === 0x78 && ((b[0] << 8) | b[1]) % 31 === 0;
    };
    if (probe(e.offset)) absoluteHits++;
    if (probe(pak.dataStart + e.offset)) relativeHits++;
  }
  const base = absoluteHits >= relativeHits ? "absolute" : "data-relative";
  return { base, absoluteHits, relativeHits, tested: candidates.length };
}

/** Structural checks over the whole index. Returns { checked, problems[] }. */
export function verifyPak(pak, { sample = 50, dataRelative = false } = {}) {
  const problems = [];
  const dataEnd = pak.dataStart + pak.dataLength;
  const base = dataRelative ? pak.dataStart : 0;
  let storedMismatch = 0;
  for (const e of pak.entries) {
    if (e.offset + base < pak.dataStart || e.offset + base + e.storedLength > dataEnd) {
      problems.push(
        `${e.path}: payload at ${e.offset}..${e.offset + e.storedLength} falls outside the DATA body ` +
          `(${pak.dataStart}..${dataEnd})`,
      );
      continue;
    }
    if (e.compressionType === COMPRESSION_STORED && e.storedLength !== e.originalLength) {
      storedMismatch++;
      problems.push(
        `${e.path}: stored entry with storedLength ${e.storedLength} != originalLength ${e.originalLength}`,
      );
    }
    if (e.zeroField !== 0) problems.push(`${e.path}: the reserved field is ${e.zeroField}, not 0`);
  }
  if (storedMismatch) problems.push(`${storedMismatch} stored entries disagree about their own length`);

  const compressed = pak.entries.filter((e) => e.compressionType === COMPRESSION_ZLIB);
  const step = Math.max(1, Math.floor(compressed.length / Math.max(1, sample)));
  let inflated = 0, sampled = 0;
  for (let i = 0; i < compressed.length; i += step) {
    const e = compressed[i];
    sampled++;
    try {
      const out = pak.read(e, { dataRelative });
      if (out.length !== e.originalLength) {
        problems.push(`${e.path}: inflated to ${out.length} bytes, index says ${e.originalLength}`);
      } else inflated++;
    } catch (err) {
      problems.push(err.message);
    }
  }
  return { checked: pak.entries.length, compressed: compressed.length, inflated, sampled, problems };
}

// ---------------------------------------------------------------------------
// Output paths
//
// `get` writes real files, so a destination it cannot create has to fail with a
// sentence about the path instead of a bare `ENOENT: no such file or directory`.
// That is not a cosmetic difference: on Windows a component containing one of
// `<>:"|?*`, a reserved device name (`CON`, `NUL`, `COM1`..), or a name longer
// than 255 characters makes `mkdirSync` AND `writeFileSync` fail with exactly
// the ENOENT a genuinely missing parent produces -- so "no such file or
// directory" points at the wrong cause, and creating the parent does not help.
// The check runs before anything is written, and `platform` is a parameter so
// the Windows rules can be tested from a host that is not Windows.
// ---------------------------------------------------------------------------

const WINDOWS_ILLEGAL_CHARS = '<>:"|?*';
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const WINDOWS_RESERVED_NAMES = new Set([
  "CON", "PRN", "AUX", "NUL",
  ...Array.from({ length: 9 }, (_, i) => `COM${i + 1}`),
  ...Array.from({ length: 9 }, (_, i) => `LPT${i + 1}`),
]);

/** The components of an absolute path, without its root or drive prefix. */
function pathComponents(absPath, platform = process.platform) {
  if (platform === "win32") {
    const { root } = parse(absPath);
    return absPath.slice(root.length).split(/[\\/]+/).filter(Boolean);
  }
  return absPath.split("/").filter(Boolean);
}

/**
 * Why `absPath` cannot be created on this platform, as a phrase, or null when
 * nothing about the path is obviously impossible.
 */
export function describeUnusablePath(absPath, { platform = process.platform } = {}) {
  const win = platform === "win32";
  const control = CONTROL_CHARS.exec(absPath);
  if (control) {
    const code = control[0].charCodeAt(0).toString(16).padStart(2, "0");
    return `it contains the control character 0x${code}, which no file name may contain`;
  }
  for (const part of pathComponents(absPath, platform)) {
    if (part.length > 255) {
      return `the component "${part.slice(0, 32)}..." is ${part.length} characters long, ` +
        `and no file system here allows a single name longer than 255`;
    }
    if (!win) continue;
    const illegal = [...part].find((ch) => WINDOWS_ILLEGAL_CHARS.includes(ch));
    if (illegal) {
      return `the component "${part}" contains "${illegal}", which Windows does not allow in a file name`;
    }
    const stem = part.split(".")[0].toUpperCase();
    if (WINDOWS_RESERVED_NAMES.has(stem)) {
      return `the component "${part}" starts with "${stem}", a reserved device name on Windows ` +
        `(CON, PRN, AUX, NUL, COM1-9, LPT1-9)`;
    }
  }
  return null;
}

const FS_ERROR_HINTS = {
  ENOENT: "the parents are created before this call, so what remains is a dangling symlink or " +
    "junction in the path, an unavailable drive or network share, or a name this file system refuses",
  EISDIR: "the destination is an existing directory",
  ENOTDIR: "a component of the path is an existing file",
  EEXIST: "something already exists where a directory has to be",
  EPERM: "the file system refused the write (a controlled-folder or antivirus policy does this)",
  EACCES: "this process may not write here",
};

function fsFailure(operation, absPath, err) {
  const hint = FS_ERROR_HINTS[err.code];
  return new Error(
    `cannot ${operation} "${absPath}": ${err.code ?? err.message}` + (hint ? ` -- ${hint}` : ""),
  );
}

/** Throw unless `absPath` is a path this platform can actually create. */
function requireUsablePath(absPath) {
  const why = describeUnusablePath(absPath);
  if (why) throw new Error(`cannot use "${absPath}" as an output path: ${why}`);
}

/** Create `absPath` as a directory, parents included, with a diagnosable failure. */
function makeDirectory(absPath) {
  requireUsablePath(absPath);
  try {
    mkdirSync(absPath, { recursive: true });
  } catch (err) {
    throw fsFailure("create the directory", absPath, err);
  }
}

/** Write `data` to `absPath`, with a diagnosable failure. */
function writeOutputFile(absPath, data) {
  requireUsablePath(absPath);
  try {
    writeFileSync(absPath, data);
  } catch (err) {
    throw fsFailure("write", absPath, err);
  }
}

/** True when `p` exists and is a directory. */
function isExistingDirectory(p) {
  try {
    return statSync(p).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Where the requested entry actually lands.
 *
 * A path that already is a directory, or one written with a trailing separator,
 * means "put it inside, under the name it has in the archive" -- the rule `cp -r`
 * uses, and the reason `get <pak> <path> out/` does what it looks like it does.
 * Anything else is the destination itself, its parents created as needed.
 */
function planDestination(outFile, name) {
  const inside = /[\\/]$/.test(outFile) || isExistingDirectory(outFile);
  const abs = resolve(outFile);
  return inside ? join(abs, name) : abs;
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

const USAGE = `Read Arma Reforger PAC1 archives (.pak)

  node tools/pak.mjs info   <pak> [--json] [--compact]
  node tools/pak.mjs list   <pak|dir> [pathRegex] [--limit N|0] [--all] [--from N] [--json] [--compact]
  node tools/pak.mjs tree   <pak> [pathRegex] [--depth N] [--limit N|0] [--all] [--json] [--compact]
  node tools/pak.mjs get    <pak> <virtualPath> <outFile> [--path-regex RE] [--dry-run] [--raw] [--verbose] [--json]
  node tools/pak.mjs cat    <pak> <virtualPath> [<lines>] [--lines A-B] [--numbers] [--raw] [--json]
  node tools/pak.mjs find   <pak|dir> <needle> [--regex] [--ignore-case] [--max-size N] [--path-regex RE]
                                                [--from N] [--limit N|0] [--all] [--json] [--compact]
  node tools/pak.mjs verify <pak|dir> [--sample N] [--limit N|0] [--all] [--json] [--compact]

A <pak> argument is a .pak file, or a directory: list, find and verify then work
on every .pak under it (recursively, in path order) -- which is how "which archive
holds this file" is one call instead of 16. info, tree, get and cat need one
archive: they answer about one index, or name one entry.

Options
  --limit N       rows to print (list, tree: default 100; find: 15; verify: how many
                  problems, default 20); 0 = every one
  --all           same as --limit 0
  --from N        start at row N: paging a long list (list, find)
  --depth N       tree: how many levels to descend (0 = the whole tree)
  --regex         find: <needle> is a JavaScript regular expression
  --ignore-case   find: case-insensitive, for a literal needle and a regex alike
  --max-size N    find: skip entries whose original length exceeds N (default 0 =
                  no cap: a no-hit search reads every entry, 17.8 s on the 5.58 GiB
                  worlds001.pak, while a search that finds its hits stops early)
  --path-regex RE list/tree/get/find: only paths that match RE (list and tree also
                  take it positionally; get uses it to extract a subset)
  --dry-run       get: print what would be written, write nothing
  --numbers       cat: number every line
  --raw           write/print the stored bytes without decompressing
  --verbose       get: print every file of a directory as it is written
  --data-relative read offsets relative to the DATA body (the pre-2026
                  mis-reading; only for recognising an old broken extract)
  --json          machine-readable output
  --compact       one-line JSON
  --              ends the options: everything after it is an argument, which is how
                  a needle that begins with a hyphen is written (find <pak> -- --i)

No answer is silently incomplete. Text ends with a "# N row(s), M shown" line when
it hid rows, find says when it stopped at the limit, and every JSON answer carries
total, from, returned and truncated. --json obeys the same cap as the text, so
--limit 0 is what makes a JSON answer complete. An option a command does not use
(tree --from, get --limit) is refused by name instead of being ignored.

find searches the decoded text -- UTF-8 when the entry is valid UTF-8, Latin-1
otherwise -- so a needle in any script matches, and reports the line and column
beside the byte offset; --json carries the matched line as text, and the skip
counts are split into empty, oversized and unreadable.

get writes one entry, or a whole directory and everything under it. --path-regex
extracts a subset (every "*.et" of a 2 GB archive without dumping the rest), and
--dry-run prints the same plan without writing. A virtual path of only separators
("/") is the archive root, i.e. every entry in it. <outFile> is the destination;
an existing directory, or a path ending in a separator, means "write inside it
under the entry's own name" (the rule cp -r uses) -- the root has no name of its
own, so it is written straight into the destination. Missing parents are created.
A path this platform cannot create is refused by name before anything is written.

cat prints the bytes unchanged, which is what makes "pak cat ... > file" exact.
With a line range or --numbers it prints a header and numbered lines instead, so
"pak cat <pak> <path> 138-160" reads a method the way "cscript cat" does.

Exit status: 0 for any successful answer (an empty list is one), 1 when an archive,
an entry or a command line could not be used.
`;

/** A bad command line: reported with the usage, and the exit status is 1. */
function usageError(message) {
  const err = new Error(message);
  err.usage = true;
  return err;
}

/** `--limit`/`--from`/`--depth`/`--max-size`/`--sample`: a whole number, never a silent NaN or a sign. */
function countOption(name, raw) {
  if (raw === undefined || raw.startsWith("--")) throw usageError(`${name} needs a value`);
  if (!/^\d+$/.test(raw)) throw usageError(`${name} needs a non-negative whole number, not "${raw}"`);
  const n = Number(raw);
  if (!Number.isSafeInteger(n)) throw usageError(`${name} is too large: ${raw}`);
  return n;
}

/** Options that take no value, and the flag each one sets. */
const BOOLEAN_OPTIONS = {
  "--raw": "raw",
  "--json": "json",
  "--compact": "compact",
  "--verbose": "verbose",
  "--all": "all",
  "--regex": "regex",
  "--ignore-case": "ignoreCase",
  "--dry-run": "dryRun",
  "--numbers": "numbers",
  "--data-relative": "dataRelative",
};

/** Options that take a whole number, and the flag each one sets. */
const COUNTED_OPTIONS = {
  "--limit": "limit",
  "--from": "from",
  "--depth": "depth",
  "--max-size": "maxSize",
  "--sample": "sample",
};

function parseArgs(argv) {
  const flags = { _: [], given: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    // `--` ends the options: a *needle* may well begin with a hyphen (`--i`, `-1`),
    // and refusing it as an unknown option would be the same silent-answer defect in
    // the other direction.
    if (a === "--") {
      flags._.push(...argv.slice(i + 1));
      break;
    }
    if (Object.hasOwn(BOOLEAN_OPTIONS, a)) {
      const key = BOOLEAN_OPTIONS[a];
      flags[key] = true;
      flags.given.push(key);
    } else if (Object.hasOwn(COUNTED_OPTIONS, a)) {
      const key = COUNTED_OPTIONS[a];
      flags[key] = countOption(a, argv[++i]);
      flags.given.push(key);
    } else if (a === "--path-regex") {
      const raw = argv[++i];
      if (raw === undefined) throw usageError("--path-regex needs a value");
      flags.pathRegex = raw;
      flags.given.push("pathRegex");
    } else if (a === "--lines") {
      const raw = argv[++i];
      if (raw === undefined) throw usageError("--lines needs a range, e.g. --lines 400-500");
      flags.lines = raw;
      flags.given.push("lines");
    } else if (a === "-h" || a === "--help") {
      flags.help = true;
    }
    // An option this tool does not know would otherwise change the answer silently
    // (a misspelt --json became the path regex, which matched nothing).
    else if (a.startsWith("-") && a !== "-") throw usageError(`unknown option "${a}"`);
    else flags._.push(a);
  }
  return flags;
}

/**
 * The options each command uses. An option outside its row is refused, not ignored:
 * `tree --from 10` and `get --limit 5` read as honoured requests and are not, which is
 * the same defect as a cap that hides rows without saying so. `--json` and `--compact`
 * are accepted everywhere, because they change how the answer is presented, never what
 * it is.
 */
const COMMAND_OPTIONS = {
  info: [],
  list: ["limit", "all", "from", "pathRegex"],
  tree: ["limit", "all", "depth", "pathRegex"],
  get: ["raw", "verbose", "dryRun", "pathRegex", "dataRelative"],
  cat: ["raw", "numbers", "lines", "dataRelative"],
  find: ["limit", "all", "from", "maxSize", "regex", "ignoreCase", "pathRegex", "dataRelative"],
  verify: ["limit", "all", "sample", "dataRelative"],
};

const GLOBAL_OPTIONS = ["json", "compact"];

/** `maxSize` -> `--max-size`, so the message names the option as it is written. */
function optionSpelling(key) {
  return `--${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

function checkOptions(command, flags) {
  const allowed = new Set([...COMMAND_OPTIONS[command], ...GLOBAL_OPTIONS]);
  for (const given of flags.given) {
    if (!allowed.has(given)) {
      throw usageError(`${command} does not take ${optionSpelling(given)}; see the usage for what it does take`);
    }
  }
}

/** Rows to print: `--limit 0` and `--all` mean "every one"; a bare run stops at `fallback`. */
function rowLimit(flags, fallback) {
  if (flags.all) return Infinity;
  if (flags.limit === undefined) return fallback;
  return flags.limit === 0 ? Infinity : flags.limit;
}

/** The window `--from`/`--limit` select out of `rows`, with the counts every footer and JSON answer carries. */
function windowOf(rows, flags, fallback) {
  const from = flags.from ?? 0;
  const limit = rowLimit(flags, fallback);
  const shown = limit === Infinity ? rows.slice(from) : rows.slice(from, from + limit);
  return { from, shown, total: rows.length, truncated: from + shown.length < rows.length };
}

/** The one line that says a list was cut, and how to get the rest. */
function truncationLine({ total, from, shown, truncated }, what = "row") {
  if (!truncated) return null;
  const plural = `${total} ${what}(s), ${shown.length} shown`;
  if (from === 0) return `# ${plural} — use --limit 0 for every one`;
  return `# ${plural} from ${from} — use --from ${from + shown.length} for the next page, or --limit 0 for every one`;
}

/** Compile a user-supplied regular expression, naming the option and the reason. */
function compileRegex(source, what, { caseInsensitive = false, global = false } = {}) {
  if (source === undefined || source === null || source === "") return null;
  try {
    // Never global here unless asked: a `g` regex used through `.test()` keeps
    // `lastIndex`, so a path filter would skip every second entry.
    return new RegExp(source, `${caseInsensitive ? "i" : ""}${global ? "g" : ""}`);
  } catch (err) {
    throw usageError(`${what} "${source}" is not a valid regular expression: ${err.message}`);
  }
}

function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Text, for `find` and `cat`
//
// An entry is decoded as UTF-8 when it *is* UTF-8 and as Latin-1 otherwise, which
// is a 1:1 byte mapping. Searching the decoded text rather than the raw bytes is
// what lets a Cyrillic, Greek or CJK needle match: the old code encoded the needle
// as Latin-1 (`Buffer.from(needle, "latin1")`), which turns every code point above
// U+00FF into one wrong byte, so such a search could only ever answer "0 hits".
// A Latin-1 search is still byte-exact, so binary entries behave as before.
// ---------------------------------------------------------------------------

const UTF8_DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });

/** `{ text, encoding }`: UTF-8 when the bytes are valid UTF-8, Latin-1 otherwise. */
export function decodeEntry(bytes) {
  try {
    return { text: UTF8_DECODER.decode(bytes), encoding: "utf8" };
  } catch {
    return { text: bytes.toString("latin1"), encoding: "latin1" };
  }
}

/** Every match of a literal or regex needle in `text`, as `{ index, length }`. */
function findMatches(text, needle, flags) {
  const out = [];
  if (flags.regex) {
    const re = compileRegex(needle, "needle", { caseInsensitive: !!flags.ignoreCase, global: true });
    let m;
    while ((m = re.exec(text)) !== null) {
      out.push({ index: m.index, length: m[0].length });
      // A pattern that can match nothing would otherwise spin forever.
      if (m[0].length === 0) re.lastIndex++;
    }
    return out;
  }
  if (flags.ignoreCase) {
    const re = compileRegex(escapeRegExp(needle), "needle", { caseInsensitive: true, global: true });
    let m;
    while ((m = re.exec(text)) !== null) out.push({ index: m.index, length: m[0].length });
    return out;
  }
  let at = text.indexOf(needle);
  while (at >= 0) {
    out.push({ index: at, length: needle.length });
    at = text.indexOf(needle, at + Math.max(1, needle.length));
  }
  return out;
}

/** Line, column and the line itself for a character index into `text`. */
function placeInText(text, index, { width = 240 } = {}) {
  const before = text.slice(0, index);
  const line = before.split("\n").length;
  const column = index - (before.lastIndexOf("\n") + 1) + 1;
  const start = text.lastIndexOf("\n", index - 1) + 1;
  let end = text.indexOf("\n", index);
  if (end < 0) end = text.length;
  let source = text.slice(start, end);
  if (source.endsWith("\r")) source = source.slice(0, -1);
  if (source.length > width) {
    const inLine = index - start;
    const half = Math.floor((width - 20) / 2);
    const from = Math.max(0, Math.min(inLine - half, source.length - width));
    source = `...${source.slice(from, from + width - 6)}...`;
  }
  return { line, column, source };
}

/** The byte offset of a character index, in the encoding the text was decoded from. */
function byteOffsetOf(text, index, encoding) {
  const prefix = text.slice(0, index);
  return encoding === "utf8" ? Buffer.byteLength(prefix, "utf8") : Buffer.byteLength(prefix, "latin1");
}

/** A string split into lines, the way both `cat` and the documents count them. */
export function splitLines(text) {
  const lines = text.split("\n").map((line) => (line.endsWith("\r") ? line.slice(0, -1) : line));
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** `400`, `400-500` or `400-`: the inclusive line range a reader asked for. */
function parseLineSpec(spec, total) {
  const m = /^(\d+)(?:\s*-\s*(\d*))?$/.exec(String(spec).trim());
  if (!m) throw usageError(`a line range is 400, 400-500 or 400-, not "${spec}"`);
  const from = Number(m[1]);
  const to = m[2] === undefined ? from : m[2] === "" ? total : Number(m[2]);
  if (from < 1) throw usageError(`line numbers start at 1, not ${from}`);
  if (to < from) throw usageError(`the range "${spec}" ends before it starts`);
  return { from, to: Math.min(to, total), requestedTo: to, clamped: to > total };
}

function printJson(payload, flags) {
  console.log(JSON.stringify(payload, null, flags.compact ? 0 : 2));
}

// ---------------------------------------------------------------------------
// Which archives an argument names
// ---------------------------------------------------------------------------

/**
 * A `<pak|dir>` argument as the list of archives it names: the file itself, or
 * every `*.pak` under a directory, recursively and in path order.
 *
 * Reading one archive at a time is what the callers do -- the client install measured
 * here is 16 files and 222 572 entries, and holding every index at once costs memory
 * for no answer. A directory with no archive is an error, not an empty success.
 */
export function listPaks(spec) {
  const abs = resolve(spec);
  let stat;
  try {
    stat = statSync(abs);
  } catch (err) {
    throw new Error(`cannot read "${spec}": ${err.code ?? err.message}`);
  }
  if (stat.isFile()) return [abs];
  if (!stat.isDirectory()) throw new Error(`"${spec}" is neither a .pak file nor a directory`);
  const found = [];
  const walk = (dir) => {
    for (const dirent of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const at = join(dir, dirent.name);
      if (dirent.isDirectory()) walk(at);
      else if (/\.pak$/i.test(dirent.name) && (dirent.isFile() || dirent.isSymbolicLink())) found.push(at);
    }
  };
  walk(abs);
  if (!found.length) throw new Error(`no .pak files under "${spec}"`);
  return found;
}

function humanBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MiB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(2)} GiB`;
}

function histogram(entries) {
  const byType = new Map();
  let storedBytes = 0, originalBytes = 0;
  const timestamps = [];
  for (const e of entries) {
    byType.set(e.compressionType, (byType.get(e.compressionType) ?? 0) + 1);
    storedBytes += e.storedLength;
    originalBytes += e.originalLength;
    if (e.timestamp) timestamps.push(e.timestamp);
  }
  timestamps.sort((a, b) => a - b);
  return { byType, storedBytes, originalBytes, timestamps };
}

/** `info`: one archive's chunks, codecs, pack time and offset base. */
function cmdInfo(path, pak, flags) {
  const { byType, storedBytes, originalBytes, timestamps } = histogram(pak.entries);
  const base = detectOffsetBase(pak);
  const info = {
    file: path,
    bytes: pak.size,
    chunks: pak.chunks.map((c) => ({ name: c.name, offset: c.offset, length: c.length })),
    dataStart: pak.dataStart,
    dataLength: pak.dataLength,
    fileChunkOffset: pak.fileChunkOffset,
    fileChunkLength: pak.fileChunkLength,
    entries: pak.entries.length,
    compression: Object.fromEntries(
      [...byType].map(([type, count]) => [compressionName(type), count]),
    ),
    storedBytes,
    originalBytes,
    compressedBytesSaved: originalBytes - storedBytes,
    timestamps: timestamps.length
      ? { from: timestamps[0].toISOString(), to: timestamps[timestamps.length - 1].toISOString() }
      : null,
    offsetBase: base,
  };
  if (flags.json) return info;
  console.log(`${path}`);
  console.log(`  chunks`);
  for (const c of pak.chunks) console.log(`    ${c.name.padEnd(6)} at ${String(c.offset).padStart(12)}  ${humanBytes(c.length)}`);
  console.log(`  entries        ${pak.entries.length}`);
  for (const [type, count] of byType) {
    console.log(`    ${compressionName(type).padEnd(16)} ${count}`);
  }
  console.log(`  payload        ${humanBytes(storedBytes)} stored, ${humanBytes(originalBytes)} unpacked`);
  if (info.timestamps) {
    console.log(`  pack time      ${info.timestamps.from.slice(0, 10)} .. ${info.timestamps.to.slice(0, 10)}`);
  }
  console.log(
    `  offset base    ${base.base} (zlib headers found: ${base.absoluteHits} absolute, ` +
      `${base.relativeHits} data-relative, of ${base.tested} compressed entries)`,
  );
  return info;
}

/** The path regex `list` and `tree` take positionally or as `--path-regex`, never both. */
function pathFilter(flags) {
  if (flags.pathRegex !== undefined && flags._[2] !== undefined) {
    throw usageError("give the path regex once: as an argument or as --path-regex, not both");
  }
  return compileRegex(flags.pathRegex ?? flags._[2], "path regex", { caseInsensitive: true });
}

/** `list`: entries whose path matches, as rows an agent can parse. */
function cmdList(path, pak, flags) {
  const source = flags.pathRegex ?? flags._[2];
  const re = pathFilter(flags);
  const rows = pak.entries
    .filter((e) => !re || re.test(normalisePath(e.path)))
    .map((e) => ({
      path: normalisePath(e.path),
      offset: e.offset,
      storedLength: e.storedLength,
      bytes: e.originalLength,
      compression: compressionName(e.compressionType),
      timestamp: e.timestamp ? e.timestamp.toISOString() : null,
    }));
  const win = windowOf(rows, flags, 100);
  const result = {
    file: path,
    entries: pak.entries.length,
    total: win.total,
    from: win.from,
    returned: win.shown.length,
    truncated: win.truncated,
    rows: win.shown,
  };
  if (flags.json) return result;
  console.log(`${path}: ${pak.entries.length} entries, ${win.total} match${source ? ` /${source}/i` : ""}`);
  for (const row of win.shown) console.log(`${row.path}\t${row.bytes}\t${row.compression}`);
  const line = truncationLine(win);
  if (line) console.log(line);
  return result;
}

/**
 * The entry tree with `--depth` and a path regex applied: a file is kept when its
 * path matches, a directory when it still holds something kept. A directory at
 * the depth limit is kept as a leaf (`cut: true`), so `tree --depth 2` shows the
 * shape without walking the 51 000 entries below it.
 */
function filteredTree(pak, { re, depth }) {
  const keptPaths = pak.entries
    .map((e) => normalisePath(e.path))
    .filter((p) => !re || re.test(p));
  const hasKeptUnder = (dirPath) => {
    const prefix = dirPath ? `${dirPath}/` : "";
    return keptPaths.some((p) => p.startsWith(prefix));
  };
  const build = (node, level) => {
    const path = normalisePath(node.path);
    if (node.kind === "file") {
      if (re && !re.test(path)) return null;
      return { entry: node, children: null, cut: false };
    }
    if (depth > 0 && level >= depth) {
      return hasKeptUnder(path) ? { entry: node, children: [], cut: true } : null;
    }
    const children = [];
    for (const child of node.children) {
      const built = build(child, level + 1);
      if (built) children.push(built);
    }
    if (!children.length) return null;
    return { entry: node, children, cut: false };
  };
  const children = [];
  for (const child of pak.root.children) {
    const built = build(child, 0);
    if (built) children.push(built);
  }
  return { entry: pak.root, children, cut: false };
}

/** The filtered tree as one line per node, parent before its children. */
function treeLines(root) {
  const lines = [];
  const walk = (nodes, prefix) => {
    for (const node of nodes) {
      const name = node.entry.kind === "dir" ? `${node.entry.name}/` : node.entry.name;
      const line = prefix + name;
      if (node.entry.kind === "dir") {
        lines.push(line);
        walk(node.children, `${line} `);
      } else {
        lines.push(`${line}  ${node.entry.originalLength}  ${compressionName(node.entry.compressionType)}`);
      }
    }
  };
  walk(root.children, "");
  return lines;
}

/** The filtered tree as JSON, cut at `limit` nodes and marking every cut node. */
function treeJson(root, limit) {
  const state = { used: 0 };
  const build = (node) => {
    if (state.used >= limit) return null;
    state.used++;
    const row = {
      name: node.entry.name,
      path: normalisePath(node.entry.path),
      kind: node.entry.kind,
    };
    if (node.entry.kind === "file") {
      row.bytes = node.entry.originalLength;
      row.compression = compressionName(node.entry.compressionType);
      if (node.entry.timestamp) row.timestamp = node.entry.timestamp.toISOString();
      return row;
    }
    row.children = [];
    if (node.cut) {
      row.truncated = true;
      return row;
    }
    for (const child of node.children) {
      const built = build(child);
      if (!built) {
        row.truncated = true;
        break;
      }
      row.children.push(built);
    }
    return row;
  };
  const tree = { name: "", path: "", kind: "dir", children: [] };
  for (const child of root.children) {
    const built = build(child);
    if (!built) {
      tree.truncated = true;
      break;
    }
    tree.children.push(built);
  }
  return { tree, returned: state.used };
}

/** `tree`: the shape of the index, with `--depth` and `--limit` bounding it. */
function cmdTree(path, pak, flags) {
  const source = flags.pathRegex ?? flags._[2];
  const re = pathFilter(flags);
  const depth = flags.depth ?? 0;
  const root = filteredTree(pak, { re, depth });
  const lines = treeLines(root);
  const total = lines.length;
  if (flags.json) {
    const limit = rowLimit(flags, 100);
    const { tree, returned } = treeJson(root, limit);
    return { file: path, depth, total, returned, truncated: returned < total, tree };
  }
  const win = windowOf(lines, flags, 100);
  for (const line of win.shown) console.log(line);
  const footer = truncationLine(win, "line");
  if (footer) console.log(footer);
  return { file: path, depth, total, returned: win.shown.length, truncated: win.truncated };
}

/** Every file entry inside a directory, i.e. every path under `<dir>/`. */
export function entriesUnder(pak, dirPath) {
  const prefix = normalisePath(dirPath);
  const under = prefix ? `${prefix}/` : "";
  return pak.entries.filter((e) => normalisePath(e.path).startsWith(under));
}

function cmdGet(path, pak, flags) {
  const [, , virtualPath, outFile] = flags._;
  if (!virtualPath || !outFile) throw usageError("get needs a virtual path and an output file");
  const filter = compileRegex(flags.pathRegex, "--path-regex", { caseInsensitive: true });
  const target = findTarget(pak, virtualPath);
  const dest = planDestination(outFile, target.name);
  if (target.kind === "dir") return getDirectory(path, pak, target, dest, filter, flags);
  if (filter && !filter.test(normalisePath(target.path))) {
    throw new Error(
      `"${target.path}" does not match --path-regex "${flags.pathRegex}"; there is nothing to write`,
    );
  }
  return getFile(path, pak, target.entry, dest, flags);
}

/** How a directory is named in messages: the root is "/", not "". */
function dirLabel(dir) {
  return dir.path ? `${normalisePath(dir.path)}/` : "/";
}

function getFile(path, pak, entry, dest, flags) {
  const bytes = pak.read(entry, { raw: flags.raw, dataRelative: flags.dataRelative });
  if (!flags.dryRun) {
    makeDirectory(dirname(dest));
    writeOutputFile(dest, bytes);
  }
  const row = {
    path: normalisePath(entry.path),
    dest,
    bytes: bytes.length,
    expectedBytes: entry.originalLength,
    storedBytes: entry.storedLength,
    compression: compressionName(entry.compressionType),
    written: !flags.dryRun,
  };
  const result = { file: path, dryRun: !!flags.dryRun, total: 1, returned: 1, truncated: false, files: [row] };
  if (flags.json) return result;
  console.log(
    `${row.path}: ${row.compression} ${entry.storedLength} -> ${bytes.length} bytes ` +
      `(index says ${row.expectedBytes}) -> ${flags.dryRun ? "would write " : ""}${dest}`,
  );
  return result;
}

function getDirectory(path, pak, dir, dest, filter, flags) {
  const under = dir.path ? `${dir.path}/` : "";
  const label = dirLabel(dir);
  const all = entriesUnder(pak, dir.path);
  const files = filter ? all.filter((e) => filter.test(normalisePath(e.path))) : all;
  if (filter && !files.length) {
    throw new Error(
      `--path-regex "${flags.pathRegex}" matched none of the ${all.length} ` +
        `entr${all.length === 1 ? "y" : "ies"} under "${label}"; nothing to write`,
    );
  }
  if (!flags.dryRun && existsSync(dest) && !isExistingDirectory(dest)) {
    throw new Error(
      `"${label}" is a directory in this archive (${files.length} file${files.length === 1 ? "" : "s"}), ` +
        `but "${dest}" is an existing file; give a directory, or a path that does not exist yet`,
    );
  }
  const rows = [];
  let bytes = 0;
  const byCodec = new Map();
  for (const e of files) {
    const rel = normalisePath(e.path).slice(under.length);
    const parts = rel.split("/");
    if (parts.some((p) => !p || p === "." || p === "..")) {
      throw new Error(
        `entry "${normalisePath(e.path)}" has no usable path inside "${label}": ` +
          `"${rel}" does not stay under the directory being extracted`,
      );
    }
    const at = join(dest, ...parts);
    let data;
    try {
      data = pak.read(e, { raw: flags.raw, dataRelative: flags.dataRelative });
      if (!flags.dryRun) {
        makeDirectory(dirname(at));
        writeOutputFile(at, data);
      }
    } catch (err) {
      throw new Error(`${normalisePath(e.path)}: ${err.message}`);
    }
    bytes += data.length;
    byCodec.set(e.compressionType, (byCodec.get(e.compressionType) ?? 0) + 1);
    rows.push({
      path: normalisePath(e.path),
      dest: at,
      bytes: data.length,
      expectedBytes: e.originalLength,
      storedBytes: e.storedLength,
      compression: compressionName(e.compressionType),
      written: !flags.dryRun,
    });
    if (flags.verbose && !flags.json) {
      console.log(`  ${rel}\t${compressionName(e.compressionType)}\t${data.length}`);
    }
  }
  const result = {
    file: path,
    path: label,
    dest,
    dryRun: !!flags.dryRun,
    entries: all.length,
    filter: flags.pathRegex ?? null,
    total: files.length,
    returned: rows.length,
    // There is no cap here: a filter narrows what is written, and `entries` says how
    // much it narrowed, so `truncated` stays false and means what it says elsewhere.
    truncated: false,
    files: rows,
  };
  if (flags.json) return result;
  const codecs = [...byCodec].map(([type, n]) => `${n} ${compressionName(type)}`).join(", ");
  console.log(
    `${label}: directory, ${files.length} file${files.length === 1 ? "" : "s"}, ` +
      `${humanBytes(bytes)} ${flags.dryRun ? "would be written" : "written"} (${codecs || "empty"}) -> ${dest}` +
      (filter ? ` [--path-regex "${flags.pathRegex}"]` : ""),
  );
  return result;
}

function cmdCat(path, pak, flags) {
  const [, , virtualPath, positionalRange] = flags._;
  const range = positionalRange ?? flags.lines;
  if (!virtualPath) throw usageError("cat needs a virtual path");
  if (positionalRange !== undefined && flags.lines !== undefined) {
    throw usageError("give the line range once: as an argument or as --lines, not both");
  }
  const target = findTarget(pak, virtualPath);
  if (target.kind === "dir") {
    const files = entriesUnder(pak, target.path);
    throw new Error(
      `"${dirLabel(target)}" is a directory in this archive (${files.length} file${files.length === 1 ? "" : "s"}), ` +
        `not a file; use list to see what is in it, or get to extract it`,
    );
  }
  if (flags.raw && (range !== undefined || flags.numbers || flags.json)) {
    throw usageError(
      "cat --raw prints the stored bytes, which have no lines: drop --raw, or drop the line range / --numbers / --json",
    );
  }
  // The default is the bytes themselves: that is what makes `cat ... > file` exact.
  if (range === undefined && !flags.numbers && !flags.json) {
    process.stdout.write(pak.read(target.entry, { raw: flags.raw, dataRelative: flags.dataRelative }));
    return undefined;
  }
  const data = pak.read(target.entry, { dataRelative: flags.dataRelative });
  const all = splitLines(decodeEntry(data).text);
  const spec = range === undefined
    ? { from: 1, to: all.length, requestedTo: all.length, clamped: false }
    : parseLineSpec(range, all.length);
  const shown = all.slice(spec.from - 1, spec.to);
  const result = {
    file: path,
    path: normalisePath(target.path),
    from: spec.from,
    to: spec.to,
    fileLines: all.length,
    total: all.length,
    returned: shown.length,
    truncated: spec.clamped,
    text: shown.join("\n"),
    lines: shown.map((text, n) => ({ line: spec.from + n, text })),
  };
  if (flags.json) return result;
  const span = spec.from === spec.to ? `line ${spec.from}` : `lines ${spec.from}-${spec.to}`;
  console.log(
    `${path}:${result.path}: ${span} of ${all.length}` +
      (spec.clamped ? ` (asked for ${spec.from}-${spec.requestedTo}, the file ends at ${all.length})` : ""),
  );
  const width = String(spec.to).length;
  for (let n = 0; n < shown.length; n++) console.log(`${String(spec.from + n).padStart(width)}\t${shown[n]}`);
  return result;
}

/** `find`: where a literal or regex needle appears, with the line it is on. */
function cmdFind(path, pak, flags) {
  const needle = flags._[2];
  if (!needle) throw usageError("find needs a needle");
  // No cap by default: a size cap that hides a 2.2 MB localization table made an
  // agent's "no hits" false, and a full scan of the installed `data007.pak` (1.9 GiB
  // unpacked, 34 202 entries) costs 2.7 s. `--max-size N` is there for speed, and
  // `--max-size 0` is the same "no cap" the other options spell as 0.
  const maxSize = flags.maxSize ?? 0;
  const oversize = (n) => maxSize > 0 && n > maxSize;
  const pathRe = compileRegex(flags.pathRegex, "--path-regex", { caseInsensitive: true });
  const limit = rowLimit(flags, 15);
  const from = flags.from ?? 0;
  const want = limit === Infinity ? Infinity : from + limit;
  const skipped = { empty: 0, oversized: 0, unreadable: 0 };
  const found = [];
  let scanned = 0, total = 0, stopped = false;
  for (const e of pak.entries) {
    if (pathRe && !pathRe.test(normalisePath(e.path))) continue;
    if (!e.originalLength) { skipped.empty++; continue; }
    if (oversize(e.originalLength)) { skipped.oversized++; continue; }
    let bytes;
    try {
      bytes = pak.read(e, { dataRelative: flags.dataRelative });
    } catch {
      skipped.unreadable++;
      continue;
    }
    scanned++;
    const { text, encoding } = decodeEntry(bytes);
    for (const match of findMatches(text, needle, flags)) {
      total++;
      if (found.length < want) {
        const place = placeInText(text, match.index);
        found.push({
          path: normalisePath(e.path),
          bytes: e.originalLength,
          offset: byteOffsetOf(text, match.index, encoding),
          line: place.line,
          column: place.column,
          text: place.source,
        });
      } else stopped = true;
    }
    if (found.length >= want) { stopped = true; break; }
  }
  const shown = found.slice(from, limit === Infinity ? undefined : from + limit);
  const result = {
    file: path,
    needle,
    regex: !!flags.regex,
    ignoreCase: !!flags.ignoreCase,
    maxSize,
    scanned,
    skipped,
    total,
    totalExact: !stopped,
    from,
    returned: shown.length,
    truncated: stopped,
    hits: shown,
  };
  if (flags.json) return result;
  console.log(`# ${path}`);
  for (const hit of shown) {
    console.log(`HIT ${hit.path} (${hit.bytes} B) line ${hit.line}:${hit.column}  ${hit.text}`);
  }
  const skipTotal = skipped.empty + skipped.oversized + skipped.unreadable;
  console.log(
    `# scanned ${scanned}, skipped ${skipTotal} (${skipped.empty} empty, ${skipped.oversized} oversized, ` +
      `${skipped.unreadable} unreadable), hits ${total}${from ? `, ${shown.length} shown from ${from}` : ""}`,
  );
  if (stopped) console.log(`# stopped at the --limit ${limit} cap — --limit 0 reads every entry`);
  return result;
}

/** `verify`: the offset base and the structural checks, with the problems it found. */
function cmdVerify(path, pak, flags) {
  const base = detectOffsetBase(pak);
  const { compressed, inflated, sampled, problems } = verifyPak(pak, {
    sample: flags.sample ?? 50,
    dataRelative: flags.dataRelative,
  });
  const limit = rowLimit(flags, 20);
  const shown = limit === Infinity ? problems : problems.slice(0, limit);
  const result = {
    file: path,
    entries: pak.entries.length,
    ok: problems.length === 0,
    offsetBase: base,
    sample: { compressed, sampled, inflated },
    problemCount: problems.length,
    returned: shown.length,
    truncated: shown.length < problems.length,
    problems: shown,
  };
  if (flags.json) return result;
  console.log(`${path}: ${pak.entries.length} entries`);
  console.log(
    `  offset base: zlib headers at absolute offsets ${base.absoluteHits}/${base.tested}, ` +
      `at DATA-relative offsets ${base.relativeHits}/${base.tested} -> ${base.base}`,
  );
  console.log(`  decompressed ${inflated}/${sampled} sampled compressed entries to the indexed length (of ${compressed} compressed)`);
  if (!problems.length) {
    console.log("  no problems found");
    return result;
  }
  console.log(`  ${problems.length} problem(s):`);
  for (const p of shown) console.log(`    ${p}`);
  if (shown.length < problems.length) {
    console.log(`    ... and ${problems.length - shown.length} more — use --limit 0 for every one`);
  }
  return result;
}

/** What each command does, whether it takes one archive or a folder, and its shape. */
const COMMANDS = {
  info: { many: false, takes: 2, shape: "info <pak>", run: cmdInfo },
  list: { many: true, takes: 3, shape: "list <pak|dir> [pathRegex]", run: cmdList },
  tree: { many: false, takes: 3, shape: "tree <pak> [pathRegex]", run: cmdTree },
  get: { many: false, takes: 4, shape: "get <pak> <virtualPath> <outFile>", run: cmdGet },
  cat: { many: false, takes: 4, shape: "cat <pak> <virtualPath> [<lines>]", run: cmdCat },
  find: { many: true, takes: 3, shape: "find <pak|dir> <needle>", run: cmdFind },
  verify: { many: true, takes: 2, shape: "verify <pak|dir>", run: cmdVerify },
};

function main() {
  const flags = parseArgs(process.argv.slice(2));
  if (flags.help || flags._.length === 0) {
    process.stdout.write(USAGE);
    process.exit(flags._.length === 0 && !flags.help ? 1 : 0);
  }
  const [command, sourceSpec] = flags._;
  if (!sourceSpec) {
    process.stderr.write(USAGE);
    process.exit(1);
  }
  const spec = COMMANDS[command];
  if (!spec) throw usageError(`unknown command "${command}"`);
  checkOptions(command, flags);
  // An argument the command has no place for would otherwise be dropped in silence
  // (`find <pak> -- --i --limit 2` put `--limit 2` after the terminator and read
  // every hit). Refusing it says which words were extra.
  if (flags._.length > spec.takes) {
    throw usageError(
      `${command} has no place for "${flags._.slice(spec.takes).join(" ")}": ` +
        `the shape is ${spec.shape} (put options before --)`,
    );
  }
  const paths = listPaks(sourceSpec);
  if (!spec.many && paths.length > 1) {
    throw usageError(
      `${command} needs one archive, and "${sourceSpec}" holds ${paths.length}: ` +
        `pass one of them, or use list/find/verify, which take the folder`,
    );
  }
  const results = [];
  let bad = false;
  const failed = [];
  for (const path of paths) {
    let pak;
    try {
      pak = openPak(path);
    } catch (err) {
      // One unreadable archive must not swallow the answer for the other 22: it is
      // named, counted and reported as an archive that failed, and the exit code says
      // so. A single-archive command still fails outright, because that archive *is*
      // the answer.
      if (!spec.many) throw err;
      failed.push({ file: path, ok: false, error: err.message });
      process.stderr.write(`! ${path}: ${err.message}\n`);
      bad = true;
      continue;
    }
    let result;
    try {
      result = spec.run(path, pak, flags);
    } finally {
      pak.close();
    }
    if (result && result.ok === false) bad = true;
    results.push(result);
  }
  const archives = [...results, ...failed];
  if (flags.json) {
    if (spec.many) {
      printJson({
        archives,
        failed: failed.length,
        total: archives.reduce((n, r) => n + (r.total ?? 0), 0),
        returned: archives.reduce((n, r) => n + (r.returned ?? 0), 0),
        truncated: archives.some((r) => r.truncated),
      }, flags);
    } else if (results[0] !== undefined) {
      printJson(results[0], flags);
    }
  } else if (failed.length) {
    console.log(`# ${failed.length} archive(s) could not be read — the exit code is 1`);
  }
  if (bad) process.exitCode = 1;
}

const isEntryPoint = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isEntryPoint) {
  // A reader that closes the pipe early (`| head`, a harness that truncates the answer)
  // is not a failure of the archive: end quietly instead of reporting an EPIPE.
  process.stdout.on("error", (err) => {
    if (err.code === "EPIPE") process.exit(0);
    throw err;
  });
  try {
    main();
  } catch (err) {
    process.stderr.write(`error: ${err.message}\n`);
    if (err.usage) process.stderr.write(`\n${USAGE}`);
    process.exitCode = 1;
  }
}
