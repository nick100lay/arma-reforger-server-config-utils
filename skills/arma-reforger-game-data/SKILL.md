---
name: arma-reforger-game-data
description: Read Arma Reforger game data out of the .pak archives and the EBIN worlds inside them - the entry tree, extracted .conf and .c sources, world .ent files with their entities and bases, resource GUIDs, and content searches. Use when a .pak read fails with "incorrect header check", "unknown compression method" or Z_DATA_ERROR, when an extracted file looks cyclically shifted or has another file's bytes at the end, when a world .ent file looks like binary, when you need the GUID for a scenario/world/prefab to put in a config, or when you need vanilla script or config text to override. Also use before writing any new pak- or .ent-parsing code - both formats and the one mistake that breaks pak reads are documented here.
---

# Reading Arma Reforger game data

Everything inside a `.pak` is readable with plain zlib and no key material. There is **no
encryption in the format** — no matter what an error message suggests. Three real obstacles
remain, and only one of them is about the archive at all:

| Symptom | Cause | What to do |
|---|---|---|
| `incorrect header check`, `unknown compression method`, `Z_DATA_ERROR` | entry payload read from the **wrong offset base** — by far the most common cause | §2. Fix the base; do not reach for a decryption tool |
| Text that starts mid-word, or ends with a fragment of an unrelated file | same wrong base: the window is shifted, so it begins late and the tail belongs to the neighbouring entry | §2 |
| `compressionType` other than `0` or `0x106` | a codec this toolkit does not know | `get --raw` the stored bytes, and report the type |
| Need a `{GUID}` for a config | GUIDs live in `resourceDatabase.rdb`, not in the pak | §4 |
| A world `.ent` starts with `EBIN` and looks like binary | it *is* binary — a different format from the pak around it | §3 |
| Need one file from a 2 GB archive | normal case | §1 |

**The rule that matters most:** in this engine a *failed* read and a *successful* read of the
wrong bytes look equally plausible. A shifted `.conf` still parses as text; a shifted
compressed entry just throws. Before reporting that something cannot be read, run
`verify` (§1) and confirm the base — a wrong base turns every compressed entry into
"encrypted" and every stored one into "rotated", and both conclusions are false.

## 1. The tool: `tools/pak.mjs`

```
node tools/pak.mjs info   <pak> [--json]                 # chunks, entry count, codec histogram, pack time, offset base
node tools/pak.mjs list   <pak> [pathRegex] [--limit N]  # find entries by path
node tools/pak.mjs tree   <pak> [pathRegex]              # the entry tree
node tools/pak.mjs get    <pak> <virtualPath> <outFile> [--raw] [--verbose]  # one file, or a whole directory
node tools/pak.mjs cat    <pak> <virtualPath> [--raw]    # print to stdout
node tools/pak.mjs find   <pak> <needle> [--max-size N] [--path-regex RE]
node tools/pak.mjs verify <pak> [--sample N]             # check every entry against the index
```

It is also a library — `import { openPak, findEntry, findTarget } from "./tools/pak.mjs"` — with
no dependencies, so a one-off script can use it instead of re-implementing the parser.

`get` takes a file **or a directory**. A directory extracts its whole subtree through the same
read path, so stored and zlib entries come out alike: on the installed server,
`get data002.pak Missions out/missions` writes 38 `.conf` files (23 stored, 15 zlib) and all 38
compare byte-identical to the archive. A virtual path of only separators — `/` — is the **archive
root**, so `get <pak> / out/dump` writes every entry of the archive at its own path (the installer's
`core/data.pak`: 939 entries / 18.8 MiB unpacked, all 939 byte-identical; the big ones are 5.58 GiB
unpacked for `worlds001.pak`, so a full dump is a deliberate act — `list`/`find` read in place
without it). `<outFile>` names the destination, and an existing directory — or a path written with
a trailing separator — means "inside it, under the entry's own name", the rule `cp -r` uses:
`get <pak> Missions out/` writes `out/Missions/…`, while `get <pak> Missions out/copy` roots the
tree at `copy/`; the root has no name of its own, so it is written straight into the destination.
Missing parents are created. A destination this platform cannot create is refused **by name**
before anything is written (a character Windows forbids in a name, a component longer than 255
characters, a reserved device name such as `CON`), because the file system answers exactly those
with `ENOENT: no such file or directory` — which reads as a missing directory, and creating one
does not help. `findTarget` and `entriesUnder` are exported for scripts that need the same
distinction.

The archives live in the install, not in this repository:

- dedicated server: `<Dedicated Server>/addons/data/data*.pak`, `worlds*.pak`, `addons/core/data.pak`
- client (same format, more content — scenarios and scripts are here): `<Arma Reforger>/addons/data/data*.pak`

Typical session:

```bash
node tools/pak.mjs verify "<client>/addons/data/data007.pak"     # always start here
node tools/pak.mjs list   "<client>/addons/data/data007.pak" "^Missions/.*\.conf$"
node tools/pak.mjs cat    "<client>/addons/data/data007.pak" Missions/23_Campaign_Western.conf
node tools/pak.mjs find   "<client>/addons/data/data007.pak" "GetFactionLimitMap"   # who calls it
```

`find` decompresses entries **in place** (there is no need to extract a 2 GB archive) and prints
the matches with surrounding text. It is the tool for "which file references X" and for locating
a method's callers — that is how the `SCR_FactionManager.EOnInit()` caller of
`GetFactionLimitMap()` was found when the documents still said the scripts were encrypted.

`verify` checks, mechanically: every entry's payload lies inside the DATA chunk, stored entries
agree with their own length, the reserved field is zero, and a sample of compressed entries
inflates to exactly the indexed length. On the installed 1.8.0.13 archives (23 files,
~408 000 entries) it reports the absolute base with 64/64 zlib headers where the index says
they are and 0/64 at the DATA-relative one, and no problems.

## 2. The format, and the one mistake

```
offset 0   "FORM" + u32BE size + "PAC1"                        (12 bytes)
then chunks, each u32BE magic + u32BE bodyLength + body:
  "HEAD"   28 bytes of pack metadata, skip
  "DATA"   every entry payload, back to back
  "FILE"   the entry tree, last in every archive observed
```

Entry tree, read sequentially (`u8 kind`, `u8 nameLength`, name, then):

```
kind 0 (directory): u32LE childCount, then childCount entries
kind 1 (file):      u32LE offset            <- ABSOLUTE file offset
                    u32LE storedLength
                    u32LE originalLength    (0 for a stub)
                    4 bytes                 always 0 in every archive observed
                    u32BE compressionType   0x0 = stored, 0x106 = zlib
                    u32LE timestamp         pack time, seconds since epoch
```

**`offset` is measured from the start of the `.pak` file.** Reading it from the start of the DATA
chunk body — the intuitive reading, and the one an earlier version of this repository's tool
used — is wrong by exactly 56 bytes in every archive here: 12 (FORM) + 8 + 28 (HEAD) + 8 (DATA
header). That single error produces all of these, at once:

- compressed entries throw `Z_DATA_ERROR` / `incorrect header check`, which reads exactly like
  encryption and is not;
- stored entries come back as a window into the middle of the concatenated DATA stream, so the
  text starts mid-word and the tail is the beginning of the **next** entry in the archive;
- a "repair" that rotates the buffer to the first class declaration it can find stitches the
  file together out of two different files, silently. This is how wrong `World` GUIDs were
  published for vanilla scenarios: the GUID belonged to the entry stored after the one being
  read, while the rest of the line came from the intended file.

`--data-relative` reproduces the broken behaviour on purpose, so an extract made with the old
tool can be recognised as such.

Compression: `0x106` is zlib, i.e. `inflateSync` on the stored bytes with no header stripping.
`0x0` is stored. Nothing else has ever been observed in ~408 000 entries; if a type appears,
`pak.mjs` refuses to guess and names it rather than emitting plausible garbage.

**Independent confirmation of the layout.** [rvost/PakInspector](https://github.com/rvost/PakInspector)
reaches the same structure from a Kaitai Struct description
([`formats/pak.ksy`](https://github.com/rvost/PakInspector/blob/main/formats/pak.ksy)) and reads
payloads at `io: _root._io, pos: offset` — the whole file, not the DATA body — with
`compression_type` as `u4be` and `0x106` handled as DEFLATE in its extractor. Two independent
parsers agreeing on both the offset base and the codec value is worth more than either alone;
it is also why the 56-byte defect above is a defect in the reader and not a change in the
container format between builds.

## 3. Reading a world (`worlds/**.ent`) — the EBIN format

**In the shipped game, only worlds are binary.** Every `.et` prefab in the archives is text
(`GenericEntity { ... }`) and needs nothing more than `pak.mjs get`; the 103 vanilla `worlds/**.ent`
start with the four bytes `EBIN`. **A mod's world is often text instead**: a `SubScene { Parent … }`
stub or a **0-byte** `.ent` beside `worlds/<Name>_Layers/*.layer`, as `Ruha` and `RuhaWinter` ship —
checking one of those with `ebin.mjs` is a "missing the EBIN magic" error, not a decode failure.
The map itself is then in the `.layer` files (`pak.mjs cat`), and `ebin.mjs` has nothing to read.
The EBIN format is a container the table above does not cover, and `tools/ebin.mjs` is the reader:

```
node tools/ebin.mjs info      <file> [--lenient] [--json]     # version, tables, decode coverage
node tools/ebin.mjs names     <file> [--json]                 # name table: classes, fields, syntax tokens
node tools/ebin.mjs guids     <file> [--rdb <rdb>] [--json]    # GUID table, optionally resolved to paths
node tools/ebin.mjs resources <file> ... --rdb <rdb> [--lenient] [--json]
node tools/ebin.mjs worlds    <file> ... --rdb <rdb> [--lenient] [--json]
node tools/ebin.mjs tokens    <file> [--from N] [--limit N|0] [--lenient] [--json]
node tools/ebin.mjs entities  <file> [--filter RE] [--limit N|0] [--rdb <rdb>] [--instances N] [--lenient] [--json]
node tools/ebin.mjs find      <file> <needle> [--json]
node tools/ebin.mjs lengths   <file> ... [--lenient] [--json]  # blocks whose stored u16 is short, and where it lands
node tools/ebin.mjs verify    <file> ... [--lenient] [--json]
```

An unknown option, a missing value, or a value that is not a non-negative whole number is an
error naming the option (`--limit needs a non-negative whole number, not "abc"`), not silently
the default — `--filte X` used to read as no filter at all. `--help` exits 0; no arguments does
not.

As a library, `readEbin(input, { strict, name })` takes a path **or the bytes** — a `Buffer` or
`Uint8Array`, which is what `pak.read(entry)` returns — so a world does not have to be written to
disk to be read; `name` labels a byte input in errors and in `file` (default `<buffer>`). The
result carries `header`, `tokens`, `gaps`, `tokenCount`, `exact` and `lengths`, and
`entities(ebin, { instances })` turns it into the tree below.

**Strict is the default.** A file whose value stream does not tile is an error naming the byte
(`… at offset N (byte 0x..)`), not a 99 %-decoded result; `--lenient` brings back the old
resynchronising pass and its gap list, for a file that is already known to be damaged. The 103
shipped worlds are exact, so the default changes nothing on them.

### A world stores overrides, not entities

This single fact decides how to read everything else here. A record names the **prefab** the
entity was made from, then stores only the properties whose value differs from that prefab:

```cpp
GenericEntity "CP_Kamensk" : "{...}ConflictControlPoint.et" {     // class, id, prefab
 m_sBaseName "#AR-Campaign_MapLocation_Cain_Kamensk"              // only what differs
}
```

So a world file is a patch list, and the reader can only tell you what the file *changes*. It
cannot tell you the entity's full component list, because that lives in the `.et`. `CP_Kamensk`
has 22 components in Workbench and exactly **one** in `CTI_Campaign_Cain` — the one whose
`m_sBaseName` was edited. Print an entity from a world file and you have its overrides, not its
definition. `[practice]` 1.8.0.13, checked against Workbench's view of the same world.

That is why `--rdb` matters more than any other option. The prefab is stored as a **GUID**, and
only `resourceDatabase.rdb` can turn it into a path. Measured over all 103 binary worlds shipped
in `addons/data` and `addons/core`: **9 560 of 9 560** entity records that name a prefab resolve
to a path, and of the 20 252 `:`+GUID+block constructs in those files — the rest are group members
and resource-valued members — every single one resolves (19 580 `.et`, 647 `.conf`, 25 `.ct`).
`[binary]` 1.8.0.13.

`--rdb` parses the database **before it prints a single path** and refuses one that contradicts
itself: the container header, the record count stored in it, and the record chain must all agree
with the bytes, and the records must end at the file's last byte. A truncated, padded or foreign
file cannot get through. The 8 GUIDs published on the BI wiki are compared when they are present —
a published path carrying another GUID is a contradiction and refuses the database — but a
**workshop database contains none of them and is read**: absence means "not vanilla", not
"broken".

A world's bases — the things a Conflict scenario fights over — are plain entities with a name:

```bash
node tools/pak.mjs get "<client>/addons/data/worlds001.pak" worlds/MP/CTI_Campaign_Cain.ent out/cain.ent
node tools/ebin.mjs entities out/cain.ent --filter "Kamensk" \
  --rdb "<install>/addons/data/resourceDatabase.rdb"
```

```
  instance of GenericEntity "CP_Kamensk"  @13870
    position 11866.496, 8.292, 10679.665   angle -2.121, -15.205, 2.43
    component SCR_CampaignMilitaryBaseComponent {621EB97024DABD3C}
        m_sBaseName = "#AR-Campaign_MapLocation_Cain_Kamensk"
        m_sBaseNameUpper = "#AR-Campaign_MapLocation_Cain_Kamensk-UC"
```

That transform and rotation are the ones Workbench reports for `CP_Kamensk`. `[practice]`

### Records, components, groups, nesting

The text form of the same graph is the authority, and the engine writes it to a `.layer` sidecar
(worlds built in Workbench can be text rather than EBIN) and to every prefab `.et`:

```cpp
GenericEntity "Area_A" : "{...}Area.et" {      // record: class, id, prefab
 components {                                   // the component list
  SCR_ScenarioFrameworkArea "{59E8CDC50969206E}" {   // component: a class WITH a GUID
   m_fAreaRadius 75
  }
 }
 coords 81.09 4.70 64.02                        // the transform: coords, angles, scale
 angles 0 173.65 0                              //   each written only when it is not the default
 scale 2.2
 {                                              // a child list: its own children
  $grp Building : "{...}win_brown.et" {          //   grouped by class and prefab
   { … } { … }
  }
  GenericEntity : "{...}Drain.et" { … }          //   a child that appears once
 }
}
```

The transform is three ordinary members — `coords`, `angles` and `scale` — and the World Editor's
Transformation panel shows exactly those three rows. **A value equal to the default is not written**:
`angles 0 0 0` and `scale 1` never appear, so an entity with no `scale` is at scale 1, not at an
unknown scale. `scale` is a single `f32`; 2 637 808 of them are stored across the shipped worlds (816
of `Arland.ent`'s 2 271 nodes are not at 1), and a value typed into the panel reaches the file only
when the world is **saved** — observed on a hand-made entity whose panel read 2.200 while the layer on
disk had no `scale` at all, until a save added `scale 2.2`.

**"The default" is not always the prefab's value.** A member is omitted when it equals the default,
and that default can be declared in three different places, which are not interchangeable:

- the **prefab's effective value** — the usual case, and itself possibly inherited from the prefab's
  own class or attribute default;
- the **attribute declared on the member in the class definition**: `[Attribute("5", …)]` carries
  `"5"` in `Attribute.m_DefValue` (`scripts/Core/generated/Attributes/Attribute.c`, where the
  constructor's first parameter is `defvalue`), so the class declaration itself is a source of the
  default — not just the prefab's text;
- the **engine's default** when the attribute declares none (`[Attribute()]` leaves
  `m_DefValue = ""`), or when the class or component is engine-implemented and its default exists
  only in the binary.

So an absent member means "the default", not "zero/empty": read the class (and its bases) and the
attribute before deciding what value is in effect, and do not present the prefab's value as the
default when the prefab itself omits the member.

`Flags` — the other row of the entity's General section — is **two `u32` words**, and the two words
mean opposite things. Both were measured box by box: one box changed in the panel, one save, one
reading of `worlds/arland_test_Layers/default.layer`, with a watcher recording every save.

The **first** word holds the boxes that are *ticked*, one bit each:

| ticked alone | stored as |
|---|---|
| `Static` | `0x400` |
| `Feature` | `0x40` |
| `No Link` | `0x20` |
| `Streamable` | `0x100` |
| `On Filtered Navmesh` | `0x10000` |
| `Relative Y` | `0x80000` |
| `Editor Only` | `0x100000` |
| `Disabled` | `0x200000` |
| `Proxy` | `0x400000` |

The **second** word holds the two that are *cleared*, a set bit meaning the box is **off** — the
opposite sense. All four states of those two boxes were measured: both ticked is `0x4`, both cleared
`0x7`, `Traceable` alone `0x5`, `Visible` alone `0x6`; so `Visible` is `0x1`, `Traceable` is `0x2`, and
`0x4` is constant in every state with no box behind it. A save made to test that prediction — untick
`Visible` only — came back `0x5`, which is what `Visible = 0x1` predicts.

A value equal to the class default is **not stored at all**: an entity with no `Flags` line is at its
defaults, not at zeros.

**Do not read the numbering off `EntityFlags.c`.** The generated script
(`scripts/Core/generated/Entities/EntityFlags.c`, 1.8.0.13, `addons/core/data.pak`) lists the same
names, but it puts `STATIC` at bit 7 (`0x80`) where the file writes `0x400`, and it has no bit that
explains the second word's constant. The stored numbering is the engine's own. Read with the table
above, the shipped values decode as `0x80403 0` = `Static` + `Relative Y` + two unmeasured bits,
`0x100003 0` = `Editor Only` + the same two, and every vegetation instance `0 0x80000` = an empty first
word and a second word with no panel box behind it.

In the binary, each of those is a length-delimited scope (`0x0e`), and the grammar is
unambiguous:

- an **entity** is `[class] [id] ":" <guidRef> <block>`. The `:`+GUID+block triple is present in
  every record measured, so it is the anchor — not a guess about capitalisation or prefixes. The
  **id is optional**: a child that keeps the prefab's name stores none, and that is most of a
  world's entities. An entity that stores no prefab at all is `[class] [id] <block>` — the world
  entity and the sun carry an id, a road child of a road generator carries neither
  (`RoadEntity { … }`, 434 in `Arland.ent`).
- **consecutive entities of one class and prefab are compacted**: only the first names them, and
  `[id] <block>` entries after it inherit both. `MP/Coop_CombatOps_Cain.ent` has 205 of those after
  a record; a group is the same compaction at scale.
- the entity's **own members** are the `name value` pairs directly in its block, before and after
  the `components` section alike. A child list lives inside its own block, so it can never leak
  members onto its parent.
- a **component** is `[class] [GUID] <block>` inside the `components` block. The GUID belongs to
  the component *slot*, not to the class: an entity that overrides a property of a component it
  inherited carries the **prefab's** GUID for it, which is what makes a world's override readable
  as "this component of the prefab". `SCR_ScenarioFrameworkArea` carries `59E8CDC50969206E` in
  `Area.et` and in all 246 occurrences across the shipped worlds — but do not generalise: 60 of
  the 216 component classes seen appear with more than one GUID, because a class that a prefab
  creates per instance (`MeshObject`, 25 distinct) gets a fresh one each time.
- a component can carry **sub-components** of its own: its block holds a `components { … }` list,
  exactly as an entity does, and that list can nest one level further. Same keyword, one level down —
  the shape Workbench writes when a component is built out of components, read from a project's own
  text layer:

  ```cpp
  SCR_RespawnSystemComponent "{6AA37B0DFEF7C77E}" {
   components {
    SCR_FreeSpawnHandlerComponent "{6AA37B0DC66AC72F}" {
     m_bDestroyPreviousControlledEntity 1
    }
   }
   m_bEnablePauseMenuRespawn 0        // the parent's own field, written after the list
  }
  ```

  57 components in the shipped worlds carry such a list, 140 sub-components in total
  (`BaseVehicleNodeComponent` → `ControllersManagerComponent`, `SCR_BaseHUDComponent`,
  `SCR_CarControllerComponent`). Nothing else in a component's block is one: a class-and-GUID
  *without* a `components` wrapper is a member's object value (`LinkType NavmeshDoorLink {…}`).
- two shapes are *not* components: a nested sub-object without a GUID (`EventHandlers`), and a
  member whose *value* is a class name (`m_BaseLayout` → `SCR_DebriefingScreenUnevenFourTiles`).
- **the graph is a tree of child lists**, and the file is one of them: the top is the world's own
  children, an entity's children sit in a child list inside its body, theirs inside a child list in
  theirs. `depth` is that distance from the root — up to 8 in the shipped worlds
  (`MP/Coop_CombatOps_Cain.ent`; 7 in `SP/Tutorial`). A group is not a scene node of its own: it
  belongs to the child list it sits in, and that is what `parent` names.
- `$grp <class> [":" <prefab>] <block>` is a **group**: one header and N member blocks that carry
  only transforms and overrides. That is where a terrain world hides its trees — 1 542 groups and
  1 419 984 members in `Cain.ent` alone — so a group is one node with `instances: N`, and
  `--instances 0` / `--instances N` decides whether the members are listed or only counted. An
  `id` inside a group belongs to the member block that follows it, which is how `$grp
  GenericEntity : <prefab>` keeps `CP_Kamensk` attached to the first of its instances.
- **the member list is not bounded by that block.** When it does not fit, the rest of the members
  follow *outside* it as sibling blocks — `[id] <block>` pairs with no second header — and the
  parent's recorded length stops short of them, which is the stored-length rule seen from the other
  side (below). A group is therefore the body's blocks **plus every block that follows**, and that is
  measured, not assumed: `Arland.ent` holds 63 644 members inside bodies and 108 078 outside, and
  with them the world has **173 206** entity-and-member nodes against the **173 226 the World
  Editor reports for the same file** (20 off, 0.01 %); without them it is 64 822, a third of the
  world. 253 groups in the corpus overflow this way.
- a **member's block is never a child list**, however much it looks like one: `Data { … }` is a
  member of a `ShapePoint` whose value is a struct (285 in `Eden.ent`), while `RoadEntity { … }` is
  a child. Both are a name followed by a block; only the token in front says which — a value, or
  the list's boundary (padding, or the previous entry's block). Reading the first as the second
  invented 339 nodes in `Eden.ent`.

### What a member's value is

A value that is not a scalar is almost always a block, and what is inside it is readable, so it is
read rather than summarised. Four shapes cover every member in the shipped worlds:

| in the file | what it is | printed as |
|---|---|---|
| `name { <padding> <array> }` | an array, always wrapped this way | `[36, 37]`, `["Slot3", "Slot4"]` |
| `name { <Class> <GUID> {…} … }` | an array of objects | one line per object, members under it |
| `name <Class> <GUID> {…}` | a nested object | the class and GUID, members under it |
| `name { <member> <value> … }` | a plain struct | braces with the members inside |

```
m_aIncludedEditableEntityLabels = [46]
m_aExcludedEditableEntityLabels = [52, 51, 21, 35, 23]
m_aActivationActions =
  SCR_ScenarioFrameworkActionKillEntity {5EBEEB2CAE8F801C}
    m_Getter = SCR_ScenarioFrameworkGetSpawnedEntity {5EBEEB2CAD2066C2}
      m_sLayerName = "SlotAI8"
m_aBlacklistZones =
  SCR_SpawnPointBlacklistZone {691E6E23D83D1172}
    m_vCenter = 11392.4, 35, 2089
    m_fRadius = 2000
```

Two details that change what the value *means*:

- **`+` is the append operator**, not a field. The text form writes `m_aWheels + { 4 5 6 7 }`
  meaning "append to the array the prefab already has", and the binary stores the same `+` as a name
  token between the member name and its value. The tool prints `+=` so an append cannot be read as
  a replacement. `+` and `:` are the only two non-identifier names in any world's name table.
- **Arrays print their first 256 elements**, and say so (`… 40 more`); the `count` in `--json` is
  always exact. Element types are whatever the array's tag fixed: `0x81` i32, `0x85` GUID reference,
  `0x86` f32, `0x88` vec3, `0x8c` string, `0x8d` name, `0x80` empty (which has zero width, and
  getting that wrong shifts the rest of the file by one byte per element). An array of GUID
  references is a list of resources: `--rdb` prints each resolved path in place and adds `paths`
  (one per value, `null` where the entry names nothing) to the member in `--json`. `--filter` looks
  inside an array too — at its string values (`m_aLayerName ["SlotAI8"]`) and at those resolved
  paths — so a prefab referenced only from an array is findable.

Only a block that did **not** tile stays a size — `<block, N bytes, opaque>` — because it is data
and not a value (see the `BSP` member of the world entity, below).

### The container and the tag table

```
"EBIN" | u32 version (1) | u16 nameCount | u16 guidCount
       | nameCount x (u16 length + UTF-8 name)     <- class names, field names, even ":" and "$grp"
       | guidCount x 8 bytes, little-endian        <- resources AND component instance GUIDs
       | the value stream
```

The value stream is a sequence of `<u8 tag> <payload>`. Every tag below is established the same
way: it makes whole files tile to their exact last byte, and the value it yields agrees with the
text form of the same object.

| tag | payload | what it is |
|---|---|---|
| `0x00` | none | padding between fields; carries nothing |
| `0x01` | `i32` | `m_iRandomPercent` reads `100` |
| `0x02` | **two `u32` words** | a bit mask, and the text form prints it as a pair: `Flags 0x100003 0`, `LightType 0x40 0`, `Rendering 0x1d 0x20`. Every field that carries it is a mask — `Flags` is 2 107 724 of the 2 107 782 occurrences |
| `0x05` | `u16` index into the GUID table | **a resource reference**: the prefab of a record, the `Parent` of a sub-scene, a resource-valued member |
| `0x06` | `f32` | `m_fAreaRadius` reads `75` |
| `0x07` | `vec2` (2 × f32) | found in the last undecoded blocks: `-45 45` |
| `0x08` | `vec3` (3 × f32) | `coords`, `angles` |
| `0x09` | `vec4` (4 × f32) | colours, quaternions |
| `0x0b` | `u8` | boolean-ish fields read 0/1 |
| `0x0c` | `u16` length + bytes | field strings ("Terrain", "PoseID") |
| `0x0d` | `u16` index into the name table | every class name, member name, `:` and `$grp` |
| `0x0e` | `u16` length | **a scope**: `blockEnd = at + 1 + length`, so the content is `length - 2` bytes after the field. Tokens, a text payload, or a list behind two bytes |
| `0x43` | `u16` length + bytes | **entity ids** ("CP_Kamensk") — a different tag from `0x0c` |
| `0x44` | 8 bytes inline | a GUID carried in the stream, not in the table |
| `0x45` | `u16` index into the GUID table | a **component instance GUID**, not a resource |
| `0x8X` | `u32` count + `count` untagged elements of type `0xX` | arrays: `0x81` i32, `0x85` guid reference, `0x86` f32, `0x87` vec2, `0x88` vec3, `0x8c` string, `0x8d` name, `0x80` empty (zero width) |

Tags `0x03`, `0x04` and `0x0a` are still unidentified, and they now appear only inside payloads that
do not decode at all — never in a scope that otherwise tiles. Inventing a width for one would corrupt
everything after it, so they stay unknown on purpose.

### Payloads that are not token streams

Three shapes are established by tiling, and none of them is "undecoded":

| shape | what it is | how it is reported |
|---|---|---|
| printable ASCII | `BSP`, the world's visibility tree: `<u32 nodeCount>` then `nodeCount` × 4 integers — true for all 19 in the shipped worlds | `<text: 4545 integers, 1136 records of 4>` |
| two bytes, then `0x0e` sub-blocks that tile exactly | a group's instances. The second byte is `0`, and the first is a value of the **prefab in that world** — see below — never interpreted | `<N entries behind 2 unknown bytes>` |
| neither | not seen in the shipped worlds any more (1.8.0.13) | `opaque`/gap, bytes counted |

**The two-byte prefix is a property of the prefab, per world.** Measured over the 117 instance lists
in the shipped worlds:

- it is **constant for a given (world, prefab) pair** — 108 of 108 pairs;
- it **differs between worlds for the same prefab** — all 14 prefabs that appear in more than one
  world: `b_juniperus_communis_0.et` is 4 in Arland and 13 in Cain, `b_corylus_avellana_1l.et` is 5
  in Arland and 48 in Eden;
- it **groups prefabs together** inside a world: Arland has 10 prefabs and 5 values, Cain 46 and 22,
  Eden 47 and 19;
- a group of *records* rather than instances starts `00 00`, i.e. the value is `0`.

That is the shape of an index into a per-world table that several prefabs share — most consistent
with the terrain's surface/vegetation material bucket, whose order differs per terrain and would
explain both the sharing and the cross-world difference. **That interpretation is not proven**, so
the reader carries the byte as `headerBytes: 2` / `header: [N, 0]` in `--json` and prints it as
unknown, which is also what makes it checkable: open the same world in Workbench and compare the
number with what the editor shows for that group.

What it is *not*, each tested against all 117 lists and matching only by chance: the unit count
(2/117), the unit count mod 256 (4), the number of members in a member (14 at best), the number of
distinct unit shapes or lengths (3 each), the length of the initial run of equal units (7), the
first unit's own length field (4), the run of padding bytes at the start of a unit (11), a count of
distinct `Flags`/`scale`/`coords` values (≤ 9), a world cell index across 17 cell sizes × 5
formulas (≤ 13), and an index into the world's GUID table (`guids[N]` are world entities, not
materials).

Four writer quirks are compensated rather than reported as corruption, each with its evidence:

- **a stored length that is short of its block's content** — 256 blocks in 11 files. The `0x0e`
  u16 is a **lower bound, not a delimiter**, and the reader never ends a scope at it when the tokens
  disagree:
  - a block of more than 64 KiB **cannot be expressed in a u16 at all**; twelve are that big, and
    seven of them store exactly `trueLength mod 65536`, so only the tokens say where they end;
  - 189 of the short ends fall **inside a value** (`vec3`, `u64`, `f32`, `string`, `guid`, or a
    block's own header) — a place no block can end;
  - the other 67 fall on a token boundary, but on one that cannot continue the enclosing record
    list: 53 before a member name (`coords` 14, `angles` 15, `scale` 16, `Flags` 7, `Position` 1),
    10 on padding before one of those, 3 on a bare value and 1 on a bare block;
  - **248 are the last child block's own doing**: its stored length is exactly its content and
    reaches past the parent's end. The other 8 are enclosing blocks whose last child is itself short.

  The child's number is corroborated by its bytes, the parent's is contradicted by them. That is why
  the scope is extended to the child and never cut at the stored end — a measurement, not a
  preference. `node tools/ebin.mjs lengths <worlds>` prints every case with the token its stored end
  lands in; `info` and `verify` report the counts.
- **the two-byte offset** in the instance lists above.
- **a scope that stops two bytes into its last child's header**: the parent's bytes run out inside
  `0e` + one length byte, and the block continuing there is that child, written without its tail in
  the parent's length. Re-parsing the scope to the child's own end is what the last 92 612 bytes of
  `Eden.ent` were — before that, two blocks came back `opaque`.
- **a member list that ends inside its last member**: while the bytes after a list are a named member
  (`[id] [block]`), they are part of the list, and the block — and every scope above it — is extended
  to them. `Ugoldar_Randomization_Arena` in `MP/Coop_CombatOps_Cain.ent` needs it for four of its seven
  layer members, which otherwise land outside the arena the World Editor shows them in.

Over the 103 shipped worlds that is **100.00 % of 168 530 192 value-stream bytes decoded, and all 103
files tile to their exact last byte**. `[binary]` 1.8.0.13, `node tools/ebin.mjs verify <worlds>`.

Report the coverage next to any conclusion drawn from a file with gaps — but after this pass a gap no
longer means "the reader gave up early", it means those particular bytes contradict themselves.

### What a world is based on: `worlds`

A sub-scene holds only the layers added on top of a base scene, so its own records cannot tell you
what it is based on. The base scene is named in the **GUID table** and referenced by the
sub-scene's `Parent` member:

```bash
node tools/ebin.mjs worlds out/cain.ent --rdb "<install>/addons/data/resourceDatabase.rdb"
#   [0] {1EA95DAE3230BEB0}  worlds/Cain/Cain.ent
```

Across the four `CTI_Campaign_*` worlds, entry 0 is that map's terrain world
(`CTI_Campaign_Cain` → `worlds/Cain/Cain.ent`, `CTI_Campaign_Arland` → `worlds/Arland/Arland.ent`,
`CTI_Campaign_Montignac` → `worlds/Eden/Eden.ent`). `--rdb` is required, because only the resource
database can say which GUIDs are world resources. Each row carries `used`, which is what the
`Parent` reference sets.

### What a world references: `resources` and `entities --rdb`

The GUID table holds two kinds of entry, and the tags tell them apart:

| tokens | resolves to a resource |
|---|---|
| tag `0x05`, 37 266 | **36 989** |
| tag `0x45`, 31 310 | 1 |
| `ID` field values (16 hex chars) | 0 |

`0x45` values are component instance GUIDs local to the file: every instance of a component class
carries the same GUID (`SCR_AmbientVehicleSpawnPointComponent` is `5D5E85F932F777FA` all 62 times
it appears), they are not stable across worlds, and no class-name hash (FNV-1a, CRC32, djb2)
reproduces them. `ID` values are a name-like id that appears nowhere else in the file. Neither is
a resource reference — the trap is to read them as one.

`0x05` values **are** resource references, and that is the tag the reader follows:

```bash
node tools/ebin.mjs resources out/cain.ent --rdb "<install>/addons/data/resourceDatabase.rdb"
#   [   0] {1EA95DAE3230BEB0} used   worlds/Cain/Cain.ent
#   [   1] {672531FAC0834C06} used   Prefabs/AI/SCR_AIWorld_Cain.et
#   ...
#   116 resource name(s) in a table of 148, 32 entries naming nothing in the resource database
```

`resources` lists every GUID-table entry that resolves to a path, marks the ones a token
references (`used`), and counts the entries that name nothing (`localIds` in JSON). It takes
several files and carries the same envelope as `worlds`.

`entities --rdb` resolves the prefab of every record and every resource-valued member in place, so
the answer is visible where the question arises:

```
GenericEntity "Area_A"  @349
  prefab   {C72F956E4AC6A6E7} Prefabs/Systems/ScenarioFramework/Components/Area.et
  position 81.093, 4.706, 64.021
  component SCR_ScenarioFrameworkArea {59E8CDC50969206E}
      m_iRandomPercent = 100
      m_bShowDebugShapesDuringRuntime = true
      m_fAreaRadius = 75
```

Each resource-valued member keeps `guid` and `index` (its GUID-table entry) plus `path`, which is
`null` only when the entry is not a resource.

### `--json`, and the 200-row limit

`entities` and `tokens` stop at **200 rows** unless told otherwise: `--limit N` sets the count and
`--limit 0` (or `--all`) lifts it. Their `--json` output is an **envelope, not a bare array**, so a
truncated read cannot be mistaken for a complete one:

```json
{
  "file": "out/cain.ent",
  "total": 1059,
  "returned": 200,
  "truncated": true,
  "filter": null,
  "coverage": {
    "tokens": 15594,
    "bodyBytes": 55136,
    "decodedBytes": 55136,
    "undecodedBytes": 0,
    "opaqueBlocks": 0,
    "opaqueBytes": 0,
    "gaps": 0,
    "exact": true
  },
  "entities": []
}
```

`total` is every **node** the reader found (after `--filter`) — entity, group or expanded member —
`returned` is how many are in `entities`, and `truncated` is `returned < total` — when it is true,
`entities` is the first `--limit` rows and nothing more. `tokens --json` carries `from` and `tokens`
instead of `filter` and `entities`. Read `total` and `truncated` before concluding anything from
the row list, and `coverage` before concluding anything from the entities.

The other commands answer `--json` with the same idea — an object that names the file, never a bare
list whose completeness you cannot check:

| command | `--json` |
|---|---|
| `names` | `{ file, total, names: ["…"] }`, in table order |
| `guids` | `{ file, total, resolved?, guids: [{ index, guid, path? }] }` — `path` and `resolved` only with `--rdb` |
| `find` | `{ file, needle, total, hits: [{ at, depth, kind, value }] }` |
| `verify`, `lengths`, `worlds`, `resources` | an array of per-file rows, **always an array**, even for one file |

Every node carries `depth` and `parent` (its index in the same array, `null` at the root), so the
tree in the file is recovered from `--json` without guessing from the indentation: an entity's
children are the following rows whose `parent` chain leads back to it.

### Limits worth knowing before you trust a number

- **Overrides only.** A record lists what the world changed; the prefab holds everything else.
  Follow the prefab path with `pak.mjs cat` if you need the full component list.
- **A group is counted, not expanded, past `--instances`.** `Cain.ent` has 1 542 groups and
  1 419 984 members; listing every tree is possible but rarely what you want, so the default caps
  expansion at 2 000 members. The count is exact whether or not the members are listed.
- **`0x02` is two `u32` words**, and the text form of the same object prints the same pair — compare
  with it directly. What each bit *means* belongs to the class that declares the field, not to the
  file; `Flags` alone has 46 distinct values across the shipped worlds.
- **Nothing is undecoded in the shipped worlds.** All 103 tile to their last byte; a file that does
  not is an **error naming the byte** (strict is the default), and `--lenient` reports the gap list
  instead — so a gap means those particular bytes contradict themselves rather than "the reader gave
  up early".
- **A stored block length can be short — the tokens are the delimiter.** 256 blocks across the 103
  worlds carry a u16 short of their content (11 files); 7 are a u16 wrap of a block over 64 KiB.
  Never cut a scope at the stored end when a token disagrees: `lengths` lists every case and
  `info`/`verify` count them.
- **Deep structure is printed to three levels**, then as a size (`<block, N bytes, not expanded>`);
  `--json` carries the structure itself, so use it when the printed tree stops early. Arrays above
  256 elements and object lists above 8 entries are abbreviated on screen, never in `--json`.
- **Block nesting is capped at 512 levels.** No shipped world goes past 8, so the cap is a guard
  against a hand-made or hostile file overflowing the stack; past it the deepest block is reported
  as an opaque payload whose gap names the cap (and `--lenient` keeps everything above it).
- **A terrain world costs seconds and gigabytes.** `Cain.ent` is 19 803 563 tokens: reading it takes
  ~3 s and about 3 GB of RSS, and expanding its 1 419 984 members doubles that — measured on
  1.8.0.13. Use `--instances 0` (or `--filter`) when the members are not the question, and give the
  process room (`node --max-old-space-size=8192 …`) if it is.
- **Counts here are for the installed 1.8.0.13 archives.** The number of files, records and
  coverage percentages move with the build; re-run `verify` rather than quoting them.

## 4. Getting a GUID

`{2B4183DF23E88249}Missions/CAH_Morton.conf` — the GUID is a resource identity. It is stored in
Workbench `<file>.meta` sidecars, which are **not shipped inside the pak**, but it *is* in
`resourceDatabase.rdb` (in the install under `addons/data/`, ~11 MB) as raw little-endian bytes.
[`tools/rdb.mjs`](../../tools/rdb.mjs) reads it in both directions:

```bash
node tools/rdb.mjs get    <rdb> <guid>         # GUID -> path
node tools/rdb.mjs guid   <rdb> <path>         # path -> GUID, the direction a scenarioId needs
node tools/rdb.mjs list   <rdb> [regex]        # browse with kinds; --limit N|0, --json
node tools/rdb.mjs info   <rdb>                # container, header, kinds, metadata, extensions
node tools/rdb.mjs verify <rdb>                # structure, mapping, and the 8 published GUIDs
```

The file is a `FORM` container with a header, a root record and then the records:

```
"FORM" | u32BE size-8 | "RDBC" | u32LE version | u32LE size
u32 flags | u32 nameCount | names (u32 length incl. NUL, bytes, 0x00) | u32 recordCount
root record: empty path, kind 5 (directory), zero GUID
records, back to back, to the last byte of the file
```

Every copy checked — the client's and the dedicated server's data and core databases and 224
workshop addons' — parses to its exact last byte, and the parsed record count equals
`recordCount - 1`; `scanRdb` refuses a file where either is untrue. That is what makes the read a
parse rather than a carve: a 2 MB prefix of a database is refused at the header instead of yielding
19 837 "valid" records and "not found" for everything after it. The name list names the build: the
data database lists `spruce`, the core database `license`, workshop databases none.

Three versions occur, and the reader handles all of them: **7** is the installed build's, **6** is
current Workshop content, **5** is old Workshop content. Version 5 has no name table (flags are
followed directly by the count) and its root record carries a GUID; the record layout is otherwise
the same. The version is reported, not gated — the structure is what is validated.

A record is

```
[u32LE pathLen + 1][path][0x00][u32LE kind][u16 flags][GUID 8][metadata 0..16]
```

and the GUID starts **7 bytes after the path's NUL terminator**. The u32 counts the path **and its
NUL**; the path is printable ASCII — 244 paths contain a space, a dozen contain `@ ! # ( ) +`, so
the whole printable range is accepted.

- **kind**: the low 4 bits are the base type — 4 script, 5 directory, 6 file, 7 group — and the
  higher bits are flags. On the server's copy 35 461 records carry `0x10` and every one names a
  resource whose file is in none of its paks (the client has the same paths as plain 5/6/7), so
  `0x10` marks what this build knows but does not ship; 9 Cain vegetation prefabs carry `0x10000`.
- **metadata** is a whole number of 4-byte words: 8 bytes `[mtime, type]` on version 7's files and
  groups and version 6's directories, 16 bytes (two such pairs) on version 6's files, 4 bytes on
  version 5's directories and root, 12 bytes on version 5's files. Which length applies is decided
  by the bytes — a timestamp is not a small length followed by a printable path — and then
  validated by the record that follows. The mtime is identical in both copies for all 98 751
  shared records that carry it, and equal to the matching pak entry's timestamp for two thirds.
  `type` is a 16-bit resource type id — 3 471 distinct, shared by similar resources — exposed and
  not mapped to names, because the file does not hold the mapping.
- a **script** record has a zero GUID: it is in `entries`, not in the GUID map.

`verify` keeps three answers apart:

- **`ok`** — the structural check: the container and header parsed, the count matches, the records
  end at the file's last byte, it is non-empty, and no published pair contradicts it. It holds for
  any database, including a workshop one.
- **`vanilla`** — the 8 pairs the BI wiki publishes for the vanilla scenarios. They are the only
  external evidence for where in a record the GUID sits (a reader shifted by a byte cannot match
  them), but they are 8 records of ~116 000 and a workshop database has none. A *contradiction*
  (a published path with another GUID) is reported as such; absence is not a defect.
- **`unique`** — one GUID to one path. The installed databases are one-to-one; **14 of the 228
  copies checked reuse a GUID** (a mod packaging fault), which `verify` reports as
  `duplicateGuids`/`duplicatePaths`; the map keeps the first record, deterministically, and the
  file is still read.

On 1.8.0.13 the client's copy is 116 389 records (110 576 with a GUID, 5 813 scripts) and the
server's 116 541 (110 728), both 8/8. The library form is `readRdb` (GUID -> `Map`), `scanRdb` (the
same read plus the header, kinds and metadata), `reverseRdb` and `verifyRdb`. The parsing does not
rest on the 8 pairs: `tests/rdb-tests.mjs` repeats the stronger check when the game is installed —
every `{GUID}path` pair written in the game's own text resources (132 843 in `data007.pak`, of
which 132 781 resolve exactly) — and the client's and server's copies agree on all 116 375 records
they share.

`extract-guid-table.ps1` still prints `{GUID}path` lines and takes `-Filter` / `-Validate`; it
does not parse the container, so prefer `rdb.mjs` when the answer has to be right.

The RDB is a second opinion for anything read out of the pak: a `.conf` that names a world or a
prefab can be cross-checked by looking the same path up in the RDB and comparing GUIDs. Doing
that is what proved the corrected `World` values in
[the MissionHeader document](../../docs/en/ArmaReforger_MissionHeader_EN.md) §2.1.

Session scenario table for build 1.6.0.119:
[ArmaReforger_Scenarios_EN.md](../../docs/en/ArmaReforger_Scenarios_EN.md).

## 5. Vanilla `.c` and `.conf` sources

Both read straight out of the pak now, compressed or not. Use the pak — it is the build you
actually run.

Arma Reforger Explorer (`https://arexplorer.zeroy.com/`) remains useful as an independent
**second source** for a `.c` or `.h` file: a different build, a different extraction path. Its
pages truncate when fetched directly, so two steps are needed:

1. Build the page URL:

   ```
   https://arexplorer.zeroy.com/_<filename_lowercased_with_underscores>_8c_source.html
   ```

   `SCR_NotificationsComponent.c` → `_s_c_r___notifications_component_8c_source.html`
   (`SCR` → `s_c_r`, then `_` between words, `.c` → `_8c`).
   For names that exist in several modules, use the path form:
   `_game_2game_8c_source.html` for `scripts/Game/game.c`.

2. Wrap it in the W3C HTML→text service, urlencoded, with `nonums=on`:

   ```
   https://www.w3.org/services/html2txt?url=<URLENCODED>&nonums=on
   ```

   Encode `:` → `%3A` and `/` → `%2F`.

Why the wrapper is mandatory: `web_fetch` on an arexplorer source page hits the output budget and
stops mid-file **and does not create a spill file**. The result is a text render with tokens and
line numbers exact.

**Limits.** The explorer has `.c` and `.h` and **no `.conf` or `.layout` files at all** — for those
the pak is the only source. It is also pinned to an older build than the installed game, so a
class added recently may be absent (HTTP 403/404) while still existing in the game; check the
installed build before concluding a class does not exist.

If a wiki page was saved locally as `.htm`, [`tools/html2text.mjs`](../../tools/html2text.mjs)
converts it to clean text with no network access at all.

## 6. What is genuinely out of reach

- **`-listScenarios` expecting stdout** — the wiki confirms it prints scenario `.conf` paths
  **to the game log**, and Workshop scenarios appear only when no scenario is loaded
  (e.g. through a config). Read the log, not the console.
- **GUIDs from the pak itself.** They are not in entry payloads; a full content scan of
  `data007.pak` for one known GUID returns zero hits. Use §4.
- **A `.pak` written by a different tool with a different offset convention.** `pak.mjs`
  detects this (`info`/`verify` print the base) but the archives it has been tested against are
  all the game's own. If `verify` reports a data-relative base, read with `--data-relative`
  and say so.

## 7. Verification checklist

Before reporting a result from this skill:

- [ ] Did you confirm the read actually succeeded, rather than that the file is absent?
- [ ] Did `verify` (or `info`) show the offset base the archive really uses?
- [ ] If a GUID: did `npm run rdb -- verify <rdb>` reproduce the 8 published GUIDs, and for a
      value taken from a `.conf`, does the RDB agree?
- [ ] If you extracted a `.conf`: is the first line a class declaration, not mid-value?
- [ ] If a world: did `info` show the decode coverage, and did you say which build the record
      counts belong to?
- [ ] If a world's entity: did you report what the file *overrides*, and not present a prefab's
      defaults as this entity's values?
- [ ] If you gave up on an entry: did you say *why* (unknown `compressionType`, truncated
      archive), not just "unreadable"?
