# Arma Reforger dedicated server config — full guide

**Game version verified on:** Arma Reforger 1.8.0.13 (engine 192142, dedicated server build 2026-09-03).
**Format:** JSON. The file is usually called `server.json` and is passed to the server as `-config server.json`.

The key list and the range table come from the binary of this build. What a string search cannot
settle — which pre-0.9.8.73 field names the schema actually rejects (§4 rule 10), and the bounds on
`game.name` and `serverMinGrassDistance` (§4 rule 4, §5.4, §9) — was settled by running it
([`tools/probe-config-schema.mjs`](../../tools/probe-config-schema.mjs)), and each such claim says so
where it appears.

---

## 0. How to use this document

The document is aimed at two audiences at once.

**If you are a human** — read sections 1–3, then find the parameter you need in section 5.
Sections 6–7 show what a finished config looks like for typical tasks.

**If you are a language model tasked with assembling `server.json` from a description** —
work like this:

1. Read section 4 (hard rules). Do not violate them under any circumstances.
2. Take the template from section 6 and change **only** the fields that relate to the task.
3. Check every value against section 5: it gives the type, the allowed range and the
   default. Do not invent fields that are not in section 5 — the engine will silently
   ignore them (or, on a wrong type, refuse to start).
4. Take the `game.scenarioId` field **only** from
   [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md) — never make up a GUID.
5. If data for some field is missing from the request — use the default from section 5
   and list the assumptions you made in your answer.

**What in this document is verified and what is not.** Section 5 is assembled from three
independent sources, and the source is given for every parameter:

- **`[wiki]`** — the official BI page "Arma Reforger: Server Config"
  (revision of 2025-03-23). This is the only public description of the format.
- **`[binary]`** — the list of key names extracted from the strings of
  `ArmaReforgerServer.exe` build 1.8.0.13. This is the exact list of what this
  particular server version reads. Such a key exists, but its semantics may be
  undescribed publicly.
- **`[practice]`** — observed in a real config and in the logs of a running
  dedicated server.

Parameters marked `[binary]` without `[wiki]` exist but are **not documented**.
Use them carefully and do not invent values for them — take the ones given here,
or omit the field entirely.

---

## 1. The minimum you need to understand

1. **The format is flat JSON.** No comments, no trailing commas,
   no single quotes. A file with a syntax error will not be read.
2. **Keys are case-sensitive.** `maxPlayers` works, `maxplayers` does not.
   This is stated explicitly in the wiki and confirmed by the server's behaviour.
3. **Types matter.** Numbers — without quotes (`2001`), strings — in quotes (`"2001"`),
   booleans — `true`/`false` without quotes. The wiki phrases this as
   "values are strings unless stated otherwise", but in fact numeric and boolean fields
   must be numbers and booleans: the config is validated against a built-in JSON schema, and
   on a mismatch the server does not start and writes a block that **names the offending key**
   together with the schema branch that rejected it. §9 has the exact lines, and they are not
   the string the wiki quotes.
4. **The server has built-in schema validation.** On a successful start the log shows:
   ```
   BACKEND : Loading dedicated server config.
   BACKEND : Server config loaded.
   BACKEND : JSON Schema Validation:
   BACKEND : JSON is Valid
   ```
   `JSON is Valid` is the **only** proof that the file was accepted; on failure the server
   writes something more specific (§9). The string
   `Server Config file is Invalid - cannot start server!` is present in the executable and is
   quoted by older notes as the verdict, but on 1.8.0.13 the server did not write it on any of
   the three failure paths tested — verified by running it, see §9.
5. **One server — one scenario.** There is no mission rotation in Arma Reforger.
   To change the mission you have to change `game.scenarioId` and restart the server.
6. **Only one `game`.** You cannot describe several sets of settings in one file.

---

## 2. Required and optional fields

There are almost no strictly required fields in the schema — practically everything has
a default. But without the following fields the server either will not start or starts
in a useless state:

| Field | Why it matters |
|---|---|
| `game.scenarioId` | Without it the server has nothing to load. The only field that must be meaningful. |
| `game.name` | The name in the server browser. Always useful; 1..100 characters — an empty name and a name longer than 100 characters are both rejected (§5.4). |
| `game.maxPlayers` | If unset, the default is taken. |
| `a2s.address` | The wiki marks it as **required**. In practice an empty string works (see §5.2). |
| `rcon.address` + `rcon.password` | Needed **only if** you want RCON. Without a password RCON will not come up. |

The wiki directly advises **not** to specify the fields `bindAddress`, `bindPort`,
`publicAddress`, `publicPort`: the server will determine the public address itself
and take port 2001. Specify them only for a non-standard port-forwarding setup.

---

## 3. Anatomy of the file

```
{
  ├─ bindAddress, bindPort, publicAddress, publicPort     ← network (usually not needed)
  ├─ a2s        { address, port }                         ← Steam queries (monitoring)
  ├─ rcon       { address, port, password, ... }          ← remote console
  ├─ game       {                                         ← everything about the game itself
  │    ├─ name, password, passwordAdmin, admins
  │    ├─ scenarioId, maxPlayers, visible
  │    ├─ crossPlatform, supportedPlatforms
  │    ├─ mods [ { modId, name, version, required } ]
  │    ├─ gameProperties { ... }                          ← gameplay settings
  │    └─ [ session/database fields ]                     ← see §5.7
  └─ operating  { ... }                                   ← server behaviour
}
```

Default ports that need to be opened:

| Port | Protocol | Purpose | Required |
|---|---|---|---|
| 2001 | UDP | game (`publicPort`) | yes |
| 17777 | UDP | A2S / Steam queries (`a2s.port`) | no |
| 19999 | UDP | RCON (`rcon.port`) | no |

---

## 4. Hard rules (mandatory)

1. **`scenarioId` always carries a GUID.** Format: `{16 hex}Missions/Name.conf`.
   The list is in [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md).
   For a mod mission the GUID is taken from `<Mission>.conf.meta`, field `Name`.
2. **`modId` is the mod's GUID without curly braces and without dashes**, exactly 16 hex
   characters. It lives in `addon.gproj` on the line `GUID "..."`. Example: `"5DBD560C5148E1DA"`.
   Do not confuse it with `ID` — that is the project's short text name, and it will not do.
3. **The key is `modId`, not `modID`.** The wiki's conclusions contradict its own example;
   the correct form is `modId`, and it is confirmed by the example on that same page.
4. **`serverMinGrassDistance` is `50..150` when the key is present — an explicit `0` is
   rejected by this build.** Verified by running 1.8.0.13
   ([`tools/probe-config-schema.mjs`](../../tools/probe-config-schema.mjs)): `0`, `1` and `49`
   fail with `Param "#/game/gameProperties/serverMinGrassDistance" is bellow the minimum limit of
   value/length. The minimum allowed is 50.` and the server exits; omitting the key reaches
   `JSON is Valid`. The wiki's `0` means "do not force grass on clients" and is the *default* —
   it is obtained by leaving the key out, not by writing it.
5. **`rcon.password` cannot contain spaces and must be at least 3 characters long.**
   `game.passwordAdmin` — also without spaces.
6. **`fastValidation` for a public server is always `true`.**
   The wiki calls this out in a separate warning.
7. **`supportedPlatforms` — only three allowed values:**
   `PLATFORM_PC`, `PLATFORM_XBL`, `PLATFORM_PSN`.
   Allowed combinations: either PC only, or PC + all consoles.
   A vanilla server cannot be "PC + Xbox only". For a server with mods
   PlayStation is not added (see §5.5.1).
8. **`maxPlayers`: 1..128.**
9. **Ports: 1..65535.**
10. **Do not use the old field names.** Before version 0.9.8.73 they were called
    differently, and old configs using them do not work:

    | Now | Before 0.9.8.73 |
    |---|---|
    | `bindAddress` | `gameHostBindAddress` |
    | `bindPort` | `gameHostBindPort` |
    | `publicAddress` | `gameHostRegisterBindAddress` |
    | `publicPort` | `gameHostRegisterPort` |
    | `game.passwordAdmin` | `passwordAdmin` (at the root) |
    | `game.maxPlayers` | `playerCountLimit` |
    | `game.supportedPlatforms` | `supportedGameClientTypes` |
    | the `a2s` object | `a2sQueryEnabled` + `steamQueryPort` |

    > ⚠️ This is not a theoretical warning. Old configs and templates written
    > before 0.9.8.73 **are still found** with outdated names:
    > `gameHostBindAddress`, `gameHostBindPort`, `gameHostRegisterBindAddress`,
    > `gameHostRegisterPort`, `playerCountLimit`, `supportedGameClientTypes`,
    > `a2sQueryEnabled` and `steamQueryPort`. Do not take such a file as a template.
    >
    > This is verified by running the server, not assumed. On **1.8.0.13**, using
    > [`tools/probe-config-schema.mjs`](../../tools/probe-config-schema.mjs):
    >
    > - a config with the four `gameHost*` names, or with `playerCountLimit`, or with
    >   `supportedGameClientTypes`, or with an invented key, is **rejected**, and the log names
    >   the key: `Param "#/game/playerCountLimit" is not allowed and must be removed.`
    > - **`dedicatedServerId` and `region` are accepted**: a config setting either of them
    >   reaches `JSON is Valid`. They are not obsolete names but undocumented fields the schema
    >   still knows; see §5.1.
    >
    > The four `gameHost*` strings are also absent from that build's executable, so their
    > rejection is established twice over. `playerCountLimit` and `supportedGameClientTypes`,
    > by contrast, **are** present in it — as names in a pool shared with `operating`, `a2s` and
    > `rcon` — and the schema still refuses to accept them as config keys. A substring hit in an
    > executable is not evidence that a name works; that is what the probe is for.

---

## 5. Parameter reference

### 5.1 Root

| Key | Type | Default | Source | Description |
|---|---|---|---|---|
| `bindAddress` | string | empty → `0.0.0.0` | `[wiki]` | IP the game socket is bound to. Leave it empty. IPv6 is not supported. |
| `bindPort` | number 1..65535 | 2001 | `[wiki]` | UDP port of the game socket. Better not to specify it — it will be taken equal to `publicPort`. |
| `publicAddress` | string | empty → autodetection | `[wiki]` | IP registered with the backend. Empty = determine automatically (recommended). Accepts the literal `"local"`. **A public IP here breaks access from the local network — see the note below.** |
| `publicPort` | number 1..65535 | 2001 | `[wiki]` | UDP port registered with the backend. If the server is behind NAT, this is the external forwarding port. |
| `a2s` | object | — | `[wiki]` | The Steam Query section. See §5.2. |
| `rcon` | object | — | `[wiki]` | The remote console section. See §5.3. |
| `game` | object | — | `[wiki]` | Everything about the game. See §5.4. |
| `operating` | object | — | `[wiki]` | Server behaviour. See §5.6. |
| `serverId` | — | — | `[binary]` | Present in the 1.8.0.13 schema, not publicly documented. Do not specify it. |
| `ownerType` | — | — | `[binary]` | Same. |
| `dedicatedServerId` | string | — | `[binary]` | **Accepted by the schema.** Verified by running the server on 1.8.0.13 with this key set: the config reached `JSON is Valid`. Not publicly documented, and its effect is not established — the diagnostic line `Wrong dedicatedServerId, length exceed boundaries... <0 .. %d>` suggests a length bound. The wiki and older notes call it an obsolete pre-0.9.8.73 name; at least on this build that is wrong. |
| `region` | — | — | `[binary]` | **Accepted by the schema**, verified the same way. Not publicly documented, and its effect is not established. |

> ### ⚠️ A public IP in `publicAddress` breaks access from the local network
>
> **If `publicAddress` holds an external (public) IP while the server sits on a home
> machine, you most likely will not be able to join it from the same local network.**
> Verified in practice: joining did not work until forwarding from the public IP to the
> local one was configured on the router.
>
> **Why this happens.** The server registers with the backend exactly the address you
> specified. The game client and the server browser receive **the same** address for
> everyone — both for players from the internet and for you. When you connect from
> inside, the packet goes to the public IP of your own network and has to come back in.
> This works only if the router supports **NAT hairpin** (a.k.a. NAT loopback). Many home
> routers do not — and the connection simply never establishes, although the server is
> reachable from outside.
>
> **The symptom by which this is recognised:** the server is visible in the browser,
> people join it from outside, but you — from the same computer or the same network —
> cannot. At the same time there is nothing resembling a block in the server log:
> the packets simply never reach it.
>
> **What the wiki does.** It directly advises **leaving `publicAddress` empty** so that
> the address is determined automatically, and separately mentions the literal `"local"` —
> "it is possible to use the keyword `local` to automatically determine
> the local address of the network card". So the engine does have a mechanism for this
> case.
>
> **Solutions, from best to workable:**
>
> 1. **Do not specify `publicAddress` at all** (leave it `""`). This is what the wiki
>    recommends: the address will be determined by itself. This is the safest option for
>    a home server.
> 2. **Try `"local"`.** If the server is needed inside the local network only, the literal
>    `"local"` will make it use the local address. **I have not verified this** — the wiki
>    describes the possibility but does not spell out the behaviour; test it on your setup.
> 3. **Enable NAT hairpin / NAT loopback on the router**, if it supports it.
> 4. **Configure forwarding from the public IP to the local one**, as I had to do.
>    It works, but it requires all traffic to the public IP to be looped back inside.
>
> **What you should not do:** put a local address like `192.168.x.x` into
> `publicAddress` if the server is supposed to be reachable from the internet. Then that
> local address goes to the backend as the public one, and outside players cannot reach
> it. A local address is appropriate only for a server that knowingly runs inside the
> network alone — as in the example in §7 (there `publicAddress` is `127.0.0.1`, because
> the server is a test one).
>
> **Do not try to "override" this with the `-bindIP` parameter:** it overrides **both**
> `bindAddress` **and** `publicAddress`, that is, it will set the same address even harder.

### 5.2 `a2s` — Steam Query (monitoring, statistics)

| Key | Type | Default | Source | Description |
|---|---|---|---|---|
| `address` | string | — | `[wiki]` | Marked as **required**. IP the A2S socket is bound to. In a real working config this is `"0.0.0.0"`. |
| `port` | number 1..65535 | 17777 | `[wiki]` | UDP port for A2S queries. |

> With a wrong port the server does not crash: the log gets
> `[A2S] Invalid port, set to default=17777...` `[binary]`.
> If `a2s` is not needed at all — the section can be omitted.

### 5.3 `rcon` — remote console (optional)

The whole section is marked in the wiki as **Optional**. The full breakdown — permissions,
command list, diagnostics — is in a separate document:
[`ArmaReforger_RCON_EN.md`](ArmaReforger_RCON_EN.md).

| Key | Type | Default | Source | Description |
|---|---|---|---|---|
| `address` | string | — | `[wiki]` | Marked as **required**. IP the RCON socket is bound to. For local access — `"127.0.0.1"`. **Do not set it to `0.0.0.0` on a server reachable from the internet** — RCON gives full control over the server. |
| `port` | number 1..65535 | 19999 | `[wiki]` | RCON port. **UDP** — verified by running the server, see [`ArmaReforger_RCON_EN.md`](ArmaReforger_RCON_EN.md) §1. On a wrong value — `[RCON] Invalid port, set to default=19999...` `[binary]`. |
| `password` | string | — | `[wiki]` | **Required for RCON to start.** Without spaces. Minimum 3 characters. |
| `maxClients` | number 1..16 | 16 | `[wiki]` | Maximum simultaneous RCON clients. Absent from the wiki template, but described in its text. |
| `permission` | string | — | `[wiki]` | `"admin"` — any commands; `"monitor"` — only those that do not change state (in practice only `#players`). |
| `blacklist` | array | `[]` | `[wiki]` | List of commands excluded from execution. |
| `whitelist` | array | `[]` | `[wiki]` | If set — only the listed commands are allowed. |

> RCON cannot report a client disconnect: **a client that is merely closed leaves the server
> holding the connection for another 45 seconds** until the timeout, and the whole time the
> `maxClients` slot is occupied.
> Close it with the `@logout` protocol command — `0x01 | seq | @logout`, which
> [`tools/rcon.mjs`](../../tools/rcon.mjs) sends on every run — and the slot is free at once;
> otherwise increase `maxClients`. Verified by running 1.8.0.13, see
> [`ArmaReforger_RCON_EN.md`](ArmaReforger_RCON_EN.md) §6.3.

### 5.4 `game` — game settings

| Key | Type | Default | Source | Description |
|---|---|---|---|---|
| `name` | string 1..100 | — | `[wiki]` | Server name in the browser. **Both bounds are enforced by the schema — an empty name and a name longer than 100 characters stop the server**, each with a message naming the limit (§9). The wiki gives the range as `0..100`; the lower bound the schema actually applies is 1. |
| `password` | string | `""` | `[wiki]` | Password to connect. Empty = no password. |
| `passwordAdmin` | string | — | `[wiki]` | Administrator password. Login in game: `#login <password>`. Without spaces. |
| `admins` | array of string | `[]` | `[wiki]` | identityId and/or steamId of the administrators. Since 1.3.0 — **no more than 20 unique IDs**. Such players can `#login` without a password. The priority join queue works only for IdentityId, not for SteamId. |
| `scenarioId` | string | — | `[wiki]` | Path to the scenario `.conf` **together with the GUID**. See [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md). |
| `maxPlayers` | number 1..128 | 64 | `[wiki]` | Maximum players. |
| `visible` | bool | `true` (since 0.9.8.73) | `[wiki]` | Show the server in the browser. |
| `crossPlatform` | bool | `false` | `[wiki]` | If `true` — automatically adds `PLATFORM_PC`, `PLATFORM_XBL`, `PLATFORM_PSN` to `supportedPlatforms` if they are not there. |
| `supportedPlatforms` | array of string | `["PLATFORM_PC"]` | `[wiki]` | Platforms the server accepts. See §5.5. |
| `gameProperties` | object | — | `[wiki]` | Gameplay settings. See §5.5. |
| `modsRequiredByDefault` | bool | `true` | `[wiki]` | The default `required` value for all mods. |
| `mods` | array of object | `[]` | `[wiki]` | List of mods. See §5.5.1. |
| `gameInstanceFiles` | — | — | `[binary]` | Present in the 1.8.0.13 schema, not documented. |
| `fileReferences` | — | — | `[binary]` | Same. |

> **`game.name` is bounded on both sides, and a violation is a rejection, not a crop.**
> The wiki says `0..100`, and the string
> `Session name exceed max value > N, cropped under limit...` is present in the executable, so
> older notes describe a too long name as cut down to the limit. That is not what the dedicated
> server does with `server.json`: on 1.8.0.13 the schema stopped the server for an empty name
> (`Param "#/game/name" is bellow the minimum limit of value/length. The minimum allowed is 1.` —
> the game's own spelling of "below") and for a 101-character name
> (`... has surpassed the maximum limit of value/length. The maximum allowed is 100.`), while
> names of 1, 2, 3 and 100 characters reached `JSON is Valid` and the session started. No name
> was cropped on this path.
>
> Reproduce it with [`tools/probe-config-schema.mjs`](../../tools/probe-config-schema.mjs); the
> lines it prints are listed in §9. The lower bound is therefore **1 character**: the name may not
> be empty, and nothing beyond that is required.

> **`game.admins` is effective even though the log says its items are skipped.** Loading a config
> whose `admins` array is not empty on 1.8.0.13 writes
> `!!! JsonApi Array name="admins" found in JSON - which missing adequate script declaration, items will be skipped!`
> into the `BACKEND` channel, and the list works all the same: the player whose `identityId` is in it
> connects and the server writes `Player '<name>' signed in as server admin.` — no `passwordAdmin`
> and no `#login`. The warning describes one structure the file is expanded into, not the
> administrator check, so it must not be read as "the key is ignored". The same wording appears for
> the `blacklist`, `whitelist` and `admins` arrays of the backend's own payloads, where the items
> really are dropped — see [`ArmaReforger_BackendAPI_EN.md`](ArmaReforger_BackendAPI_EN.md) §5.
> Verified by running 1.8.0.13 with a non-empty `admins` list (`[practice]`).
>
> **The same warning for `missionHeader` arrays is cosmetic too, and this one was tested directly.**
> A non-empty `m_aCampaignCustomBaseList` writes
> `!!! JsonApi Array name="m_aCampaignCustomBaseList" found in JSON - which missing adequate script declaration, items will be skipped!`
> and the entries are applied. (Any array of script classes emits this wording; only the base list was
> run.) On 1.8.0.13 the discriminating run was the *empty* list: the same
> `missionHeader` with `m_bCustomBaseWhitelist: true` and no entries printed
> `Not enough suitable starting locations found…` and started with no HQ at all. With three named
> bases the same config started normally and the round was played to a win. A list that had really
> been skipped would have produced the empty-list failure, because the whitelist would leave zero HQ
> candidates — see [the `missionHeader` document](ArmaReforger_MissionHeader_EN.md) §3.4.4.
> Verified by running 1.8.0.13 (`[practice]`).

#### 5.4.1 `game.mods[]` — array elements

| Key | Type | Default | Description |
|---|---|---|---|
| `modId` | string | — | **The mod's GUID, 16 hex characters, without `{}`.** From `addon.gproj`, the `GUID` line. A ready-made list is handed out by the game itself — see below. |
| `name` | string | — | **Affects nothing.** Just a human-readable comment. |
| `version` | string | — | Optional. If not specified — the latest version of the mod is taken. |
| `required` | bool | `true` or `modsRequiredByDefault` | If `false` and the mod cannot be downloaded from the Workshop — it is automatically removed from the list with a warning in the log. |

Example:

```json
"mods": [
  { "modId": "5DBD560C5148E1DA", "name": "ACECarrying", "version": "1.4.3" },
  { "modId": "60C4CE4888FF4621", "name": "ACECore" }
]
```

> Server stability requires that the `modId` of all mods match what the clients have
> installed. A version mismatch leads to a connection refusal.

#### How to get a ready-made mod list out of the game

**Do not type `modId` by hand — the game hands out ready-made JSON.** This is the
supported way, and it saves you from typos in GUIDs.

1. Launch the game (client), in the main menu press the **mods** icon (puzzle piece)
   in the top right corner.
2. In the window that opens — **"Saved mod settings"**. There are three tabs:
   **"Saved setups"** (mod presets), **JSON** and **"Command line"**.
   Presets are covered below — if there are many mods, start with them.
3. Open the **JSON** tab and press **"Copy to clipboard"**.

You will get exactly the objects the `game.mods` field needs.
**Below is the verbatim look of that output, copied from the clipboard.** Note
that it starts straight with `{` and ends with `}`:

```text
{
  "modId": "5965550F24A0C152",
  "name": "Where Am I",
  "version": "1.2.0"
},
{
  "modId": "5DBD560C5148E1DA",
  "name": "ACE Carrying",
  "version": "1.4.3"
},
{
  "modId": "60C4CE4888FF4621",
  "name": "ACE Core",
  "version": "1.4.4"
}
```

> ### ⚠️ This is not valid JSON yet — add the square brackets
>
> **The game hands out a list of objects, but does not wrap it in an array.** That is,
> there is no `[` at the start and no `]` at the end. That is exactly why the block above
> is fenced as `text` and not `json`: it **is not** correct JSON, and a parser will not
> accept it.
>
> To get a value for `game.mods`, wrap what you pasted in square brackets:
>
> ```json
> "mods": [
>   {
>     "modId": "5965550F24A0C152",
>     "name": "Where Am I",
>     "version": "1.2.0"
>   },
>   {
>     "modId": "5DBD560C5148E1DA",
>     "name": "ACE Carrying",
>     "version": "1.4.3"
>   }
> ]
> ```
>
> Watch the commas: **between** objects they are needed, after the **last** one they are
> not. This is the place where the config most often breaks after pasting a mod list.
>
> Without the brackets the result is not JSON at all, so what fails is **parsing**, not the
> schema, and the server writes `JSON parse error: <reason> (Line: N, Char: M)` followed by
> `There are errors in server config!` — while the game's own text looks correct, which is
> confusing. The authors of container builds know about the problem too: their instructions
> include a separate step "add `[` at the top and `]` at the bottom, because the game does not
> hand out valid JSON".

What is useful to know about the output itself:

- `modId` is already **without curly braces** — exactly in the form the config requires;
- `version` is filled in automatically, so mod versions will be pinned explicitly;
- `name` is just a comment, it does not affect operation;
- the order of mods does not matter.

#### The "Saved setups" tab — mod presets

The first tab of the same window you copied the JSON from is **mod presets (sets)**.
It is the convenient way to prepare a list for the server when there are many mods and
you do not need all of them.

What is there:

- **"Create new setup"** — add a new preset.
- A list of saved presets with a checkbox on the left. On the right, each one shows the
  **number of mods in it** — so you can see what is inside without opening it.
- Action buttons on the selected row: **save**, **delete**, **rename**,
  and at the bottom — **"Load"**.

**How this relates to the mod manager.** The contents of a preset are set in the mod
manager itself (the **"Mod manager"** button at the bottom of the window): there you
**enable and disable** the mods you need from the shared list of installed ones. The set
you assemble is saved as a preset, and it gets its own mod count.

**The working order of actions** for assembling a list for the server:

1. In the mod manager, enable exactly the mods that will be on the server.
2. Go back to "Saved setups", create a preset (for example `server`) and
   save it.
3. Select that preset, press **"Load"**.
4. Switch to the **JSON** tab and copy the list — it will contain only the mods of the
   selected preset.

The point of presets is that you **do not rebuild the list by hand every time**: one
preset for the server, another for playing with friends without mods, a third for testing
a specific mod. Loading a preset switches the active set as a whole.

> **Caveat.** The tab and button names are given as they appear in the Russian
> localization of the client. I describe the contents of a preset by the observed
> behaviour of the interface (the checkbox, the mod count, the "Load" button) — **I have
> not verified the internal logic of how presets are stored, nor what exactly the
> checkbox switches.** If a preset behaves differently from what you expect, go by the
> contents of the JSON tab: it always shows what will really go into the config.

#### The "Command line" tab

The third tab of the same window gives a mod list **for the `-addons` startup parameter** —
this is an alternative to the `game.mods` field. The list also depends on the selected
preset.

Remember the incompatibility: **`-addons` and `-config` cannot be used together**
(see [`ArmaReforger_StartupParams_EN.md`](ArmaReforger_StartupParams_EN.md) §6).
Pick one: either mods in `server.json`, or via the startup parameter.

### 5.5 `game.gameProperties`

| Key | Type / range | Default | Source | Description |
|---|---|---|---|---|
| `serverMaxViewDistance` | number 500..10000 | 1600 | `[wiki]` | Draw distance on the server. |
| `serverMinGrassDistance` | number 50..150 | 0 | `[wiki]` | Minimum grass distance in metres. `0` = do not force it on clients — that is the default when the key is absent; **an explicit `0` is rejected by 1.8.0.13**, so omit the key for that behaviour (§4 rule 4). |
| `networkViewDistance` | number 500..5000 | 1500 | `[wiki]` | Maximum network transmission distance for replicated entities. |
| `fastValidation` | bool | `true` | `[wiki]` | Fast check that the map state matches between client and server. **For a public server always `true`.** |
| `battlEye` | bool | `true` | `[wiki]` | Enable the BattlEye anti-cheat. |
| `disableThirdPerson` | bool | `false` | `[wiki]` | Forbid the third-person view. |
| `VONDisableUI` | bool | `false` | `[wiki]` | Disable the voice chat interface. |
| `VONDisableDirectSpeechUI` | bool | `false` | `[wiki]` | Disable the direct speech interface. |
| `VONCanTransmitCrossFaction` | bool | `false` | `[wiki]` | `true` — you can transmit on other factions' radio; `false` — listen only. |
| `missionHeader` | object | — | `[wiki]` | Overrides the scenario's `SCR_MissionHeaderCampaign`. See §5.5.2. |

**About `fastValidation` in detail** `[wiki]`. With `true`, a minimum of data sufficient
to check for a match is transmitted between server and client; on a mismatch you cannot
tell which exact entity differed. With `false`, additional data is transmitted for every
entity and component, and the mismatch can be localised. `false` makes sense only for
local development (server and client on the same machine). For a public server — `true`.

**About `battlEye`.** The default is `true`, but in a real working config
(see §7) it is often `false`. If anti-cheat is not needed, disabling it reduces load.

#### 5.5.1 `supportedPlatforms` — allowed combinations

Values: `PLATFORM_PC`, `PLATFORM_XBL`, `PLATFORM_PSN`.

| Server type | Allowed combination |
|---|---|
| Vanilla | PC only |
| Vanilla | PC + Xbox + PlayStation (all three) |
| With mods | PC + Xbox (PlayStation is not added) |

**Not allowed combinations:** PC + Xbox only; PC + PlayStation only;
Xbox only; PlayStation only; Xbox + PlayStation.

#### 5.5.2 `missionHeader` — overriding the scenario header

The wiki describes this field in one phrase: "overrides the scenario's
`SCR_MissionHeaderCampaign`", and gives **no** list of keys at all. Therefore the full
breakdown is moved to a separate document:
**[`ArmaReforger_MissionHeader_EN.md`](ArmaReforger_MissionHeader_EN.md)**.
There, all fields with types, defaults and descriptions, obtained from the class sources,
plus working examples.

The most important things in brief:

- `missionHeader` is the same object as the one in `Missions/<Name>.conf`. The engine
  lays the specified fields **over** those read from the scenario; the rest stay
  as in the scenario.
- **The key names are the class field names**, not strings from the `.conf`.
  `World` and `SystemsConfig` are **not carried over** here: they are only read from the
  scenario.
- **The set of available fields depends on the scenario header class**:
  Conflict uses `SCR_MissionHeaderCampaign` (campaign fields — supplies, bases,
  starting rank), Game Master — the base `SCR_MissionHeader`, Combat Ops —
  `SCR_MissionHeaderCombatOps`. A key from a foreign class will be silently ignored.
- Write boolean fields as `true`/`false` (in scenario `.conf` files they are written as
  `0`/`1`).
- **The defaults given in the breakdown depend on the game mode**
  and do not describe the current state of your server. They are the *class* defaults,
  and the scenario sets its own values on top of them. Besides, the logic of some fields
  only kicks in in a certain mode (for example, campaign HQs and military bases exist
  only in Conflict). More — §3.0 of the breakdown.

A working example `[practice]` (a real config on 1.8.0.13, the server started
with `JSON is Valid`):

```json
"missionHeader": {
  "m_iStartingHQSupplies": 10000,
  "m_bRandomStartingDaytime": false,
  "m_iStartingHours": 1,
  "m_iStartingMinutes": 0,
  "m_bOverrideScenarioTimeAndWeather": true,
  "m_fXpMultiplier": 20.0,
  "m_eStartingRank": 6
}
```

`"m_eStartingRank": 6` is `MAJOR`. The numeric values of all ranks
(`SCR_ECharacterRank`, 0..18) are tabulated in
[`ArmaReforger_MissionHeader_EN.md`](ArmaReforger_MissionHeader_EN.md) §3.2;
`1` is `PRIVATE`, that is, the vanilla behaviour.

The server can read values of several types from here: on an unsupported type the log
gets one of the strings `Server Config MissionHeader: Parameter '%s' is not
supported type!` or `... Item on index %d in parameter '%s' is invalid type!`
`[binary]`. An error in this block **does not bring the server down**, but the parameter
will be ignored — and that is the way to check whether a key was accepted.

### 5.6 `operating` — server behaviour

| Key | Type / range | Default | Source | Description |
|---|---|---|---|---|
| `lobbyPlayerSynchronise` | bool | `true` | `[wiki]` | Send the list of present players to GameAPI together with the heartbeat. Removes the mismatch between the real and the displayed player count. |
| `disableCrashReporter` | bool | `false` | `[wiki]` | Disable automatic sending of crash reports. The analogue of `-disableCrashReporter`. |
| `disableNavmeshStreaming` | array of string | not set | `[wiki]` | Disable navmesh streaming: the navmesh is held entirely in memory — slightly better performance and AI response, but hundreds of MB more memory. An empty array = disable for all; with a list = only for those listed. Before 1.2.0 it was boolean. |
| `disableServerShutdown` | bool | `false` | `[wiki]` | Do not shut the server down when the connection to the backend is lost. |
| `disableAI` | bool | `false` | `[wiki]` | Disable AI completely: no AIWorld is created or ticked. |
| `playerSaveTime` | number (sec) | 120 | `[wiki]` | Player autosave period. |
| `aiLimit` | number | -1 | `[wiki]` | Upper limit on the number of AIs. A negative value = the limit is not applied. Overridden by the `-aiLimit` startup parameter. |
| `slotReservationTimeout` | number 5..300 | 60 | `[wiki]` | How many seconds to hold a slot for a kicked player. The minimum value = disabled. Works only for kicks by replication. |
| `joinQueue` | object | — | `[wiki]` | Join queue settings. |
| `joinQueue.maxSize` | number 0..50 | 0 (off) | `[wiki]` | Maximum people in the queue. `0` = queue disabled. |
| `heartbeat` | — | — | `[binary]` | Present in the 1.8.0.13 schema, not publicly documented. |

### 5.7 Session and database fields `[binary]`

The following keys are present in the 1.8.0.13 schema but are **not publicly
documented**. The exact semantics, ranges and defaults are unknown. Only the names are
given — so that you do not take them for a typo if you meet them in someone else's
config, and so that you do not invent them yourself.

```
game.loadSessionSave        game.keepSessionSave      game.saveRetention
game.autoSaveInterval       game.hiveId               game.databases
game.storages               game.preset               game.options
game.database
```

> The message `Storage "%s" contains undefined database named "%s"!` `[binary]`
> indicates that `storages` references entries from `databases` by name.
> This relates to the server persistent storage; for an ordinary server
> these fields are not needed.

---

## 6. Ready-made templates

### 6.1 Minimal working config (local test)

This is enough for the server to start and for you to be able to join it.

```json
{
  "bindAddress": "0.0.0.0",
  "bindPort": 2001,
  "publicAddress": "127.0.0.1",
  "publicPort": 2001,
  "a2s": {
    "address": "0.0.0.0",
    "port": 17777
  },
  "game": {
    "name": "Test Server",
    "password": "",
    "passwordAdmin": "admin",
    "admins": [],
    "scenarioId": "{ECC61978EDCC2B5A}Missions/23_Campaign.conf",
    "maxPlayers": 16,
    "visible": false,
    "gameProperties": {
      "serverMaxViewDistance": 1600,
      "serverMinGrassDistance": 50,
      "networkViewDistance": 1500,
      "disableThirdPerson": false,
      "fastValidation": true,
      "battlEye": false,
      "VONDisableUI": false,
      "VONDisableDirectSpeechUI": false,
      "VONCanTransmitCrossFaction": false
    },
    "mods": []
  }
}
```

`visible: false` — the server will not be visible in the browser, but you can connect by
address. For local tests this is preferable.

Here `publicAddress` is `127.0.0.1`, because the server is knowingly a test and local one.
For a server reachable from the internet this must not be done: that address will go to
the backend as the public one (see the note in §5.1).

### 6.2 Public server with RCON and mods

```json
{
  "bindAddress": "0.0.0.0",
  "bindPort": 2001,
  "publicAddress": "",
  "publicPort": 2001,
  "a2s": {
    "address": "0.0.0.0",
    "port": 17777
  },
  "rcon": {
    "address": "127.0.0.1",
    "port": 19999,
    "password": "ChangeMe123",
    "maxClients": 4,
    "permission": "admin",
    "blacklist": [],
    "whitelist": []
  },
  "game": {
    "name": "My Community Server",
    "password": "",
    "passwordAdmin": "AdminPassNoSpaces",
    "admins": [
      "76561198000000000"
    ],
    "scenarioId": "{2B4183DF23E88249}Missions/CAH_Morton.conf",
    "maxPlayers": 64,
    "visible": true,
    "crossPlatform": true,
    "supportedPlatforms": [
      "PLATFORM_PC",
      "PLATFORM_XBL"
    ],
    "modsRequiredByDefault": true,
    "gameProperties": {
      "serverMaxViewDistance": 1600,
      "serverMinGrassDistance": 50,
      "networkViewDistance": 1500,
      "disableThirdPerson": false,
      "fastValidation": true,
      "battlEye": true,
      "VONDisableUI": false,
      "VONDisableDirectSpeechUI": false,
      "VONCanTransmitCrossFaction": false
    },
    "mods": [
      {
        "modId": "5DBD560C5148E1DA",
        "name": "ACECarrying",
        "version": "1.4.3"
      }
    ]
  },
  "operating": {
    "lobbyPlayerSynchronise": true,
    "disableCrashReporter": false,
    "joinQueue": {
      "maxSize": 10
    },
    "slotReservationTimeout": 60,
    "playerSaveTime": 120
  }
}
```

> `publicAddress` is left empty deliberately — the server will determine the public
> address itself. Specify it only if the automatic detection gets it wrong (for example,
> under Docker).
>
> `supportedPlatforms` contains `PLATFORM_PC` and `PLATFORM_XBL`, because the server has
> mods: the "PC + Xbox" combination is allowed precisely for modded servers,
> and `PLATFORM_PSN` is not added in that case.

### 6.3 Template with placeholders (for generation)

> ⚠️ **This is a schema, not valid JSON.** Inside there are `<placeholders>`, `//`
> comments and constructs of the form `a | b`, which JSON does not allow. Use the block
> as a map of the fields, and assemble the finished file following the pattern of §6.2:
> real values, double quotes, no comments. If you are a language model — **do not copy
> this block verbatim**.

```
{
  "bindAddress": "0.0.0.0",
  "bindPort": <1..65535, usually 2001>,
  "publicAddress": "",                       // empty = autodetection
  "publicPort": <1..65535, usually 2001>,
  "a2s": {
    "address": "0.0.0.0",
    "port": <1..65535, usually 17777>
  },
  "rcon": {                                  // section is optional
    "address": "127.0.0.1",
    "port": <1..65535, usually 19999>,
    "password": "<without spaces, >=3 characters>",
    "maxClients": <1..16, usually 16>,
    "permission": "admin" | "monitor",
    "blacklist": [],
    "whitelist": []
  },
  "game": {
    "name": "<1..100 characters>",
    "password": "<empty = no password>",
    "passwordAdmin": "<without spaces>",
    "admins": [ "<identityId or steamId>", ... ],    // maximum 20
    "scenarioId": "{GUID}Missions/<Name>.conf",       // only from the reference!
    "maxPlayers": <1..128>,
    "visible": true | false,
    "crossPlatform": true | false,
    "supportedPlatforms": [ "PLATFORM_PC" (, "PLATFORM_XBL" [, "PLATFORM_PSN"]) ],
    "modsRequiredByDefault": true | false,
    "gameProperties": {
      "serverMaxViewDistance": <500..10000>,
      "serverMinGrassDistance": <50..150, omit the key for the default 0>,
      "networkViewDistance": <500..5000>,
      "disableThirdPerson": true | false,
      "fastValidation": true,                 // always true for a public one
      "battlEye": true | false,
      "VONDisableUI": true | false,
      "VONDisableDirectSpeechUI": true | false,
      "VONCanTransmitCrossFaction": true | false
    },
    "mods": [
      { "modId": "<16 hex without braces>", "name": "<comment>", "version": "<opt.>", "required": true | false }
    ]
  },
  "operating": {
    "lobbyPlayerSynchronise": true | false,
    "disableCrashReporter": true | false,
    "disableNavmeshStreaming": [ "<navmesh name>", ... ],
    "disableServerShutdown": true | false,
    "disableAI": true | false,
    "playerSaveTime": <seconds>,
    "aiLimit": <number, -1 = no limit>,
    "slotReservationTimeout": <5..300>,
    "joinQueue": { "maxSize": <0..50, 0 = disabled> }
  }
}
```

---

## 7. Walkthrough of a real config

Below is a config from a working dedicated server `[practice]`. It is useful because it
shows the style that really passes schema validation.

```json
{
  "bindAddress": "0.0.0.0",
  "bindPort": 2001,
  "publicAddress": "203.0.113.10",
  "publicPort": 2001,
  "a2s": {
    "address": "0.0.0.0",
    "port": 17777
  },
  "rcon": {
    "address": "127.0.0.1",
    "port": 12345,
    "password": "123",
    "permission": "admin",
    "blacklist": [],
    "whitelist": []
  },
  "game": {
    "name": "watafa",
    "password": "123",
    "passwordAdmin": "admin",
    "admins": [],
    "scenarioId": "{F45C6C15D31252E6}Missions/27_GM_Cain.conf",
    "maxPlayers": 24,
    "visible": false,
    "gameProperties": {
      "serverMaxViewDistance": 1600,
      "serverMinGrassDistance": 50,
      "networkViewDistance": 1500,
      "disableThirdPerson": false,
      "fastValidation": true,
      "battlEye": false,
      "VONDisableUI": false,
      "VONDisableDirectSpeechUI": false,
      "VONCanTransmitCrossFaction": false,
      "missionHeader": {
        "m_iStartingHQSupplies": 10000,
        "m_bRandomStartingDaytime": false,
        "m_iStartingHours": 1,
        "m_iStartingMinutes": 0,
        "m_bOverrideScenarioTimeAndWeather": true,
        "m_fXpMultiplier": 20.0,
        "m_eStartingRank": 6
      }
    },
    "mods": []
  }
}
```

What is worth noting here:

- There is **no `operating` section at all** — it is entirely optional.
- `rcon.port` is `12345`, not the standard `19999`. That is allowed;
  the main thing is to open that port.
- `rcon.password` is `"123"`, exactly 3 characters: the minimum allowed length.
- `rcon.maxClients`, `game.crossPlatform`, `supportedPlatforms`,
  `modsRequiredByDefault` are not specified — the defaults apply.
- `game.scenarioId` references the Game Master scenario Cain
  (`{F45C6C15D31252E6}`), not Conflict. **`Cain` is the code name of the Kolguyev map**
  (in the interface it is called Kolguyev), so do not look for a file with "Kolguyev" in
  its name in the scenario list — there is none. In exactly the same way
  **`Eden` is Everon**.
  The mapping breakdown is in
  [`ArmaReforger_MissionHeader_EN.md`](ArmaReforger_MissionHeader_EN.md) §2.1.
- In the log of this launch: `JSON Schema Validation: JSON is Valid`,
  then `Starting RPL server, listening on address 0.0.0.0:2001, fastValidation=true`
  and `[RCON] Init, Ip address=127.0.0.1 and Port=12345`.

---

## 8. Common tasks → what to change

| Task | What to change |
|---|---|
| A server for your own crowd, no password | `game.password: ""`, `game.visible: false` |
| Password only | `game.password: "<password>"` |
| Change the map/mode | only `game.scenarioId` (from the reference) |
| More players | `game.maxPlayers` (maximum 128) |
| First person only | `gameProperties.disableThirdPerson: true` |
| Disable the voice interface | `gameProperties.VONDisableUI: true`, `VONDisableDirectSpeechUI: true` |
| Radio between factions | `gameProperties.VONCanTransmitCrossFaction: true` |
| Less network load | reduce `gameProperties.networkViewDistance` (minimum 500) |
| Remove grass on clients | omit `gameProperties.serverMinGrassDistance` — its default is `0`, while an explicit `0` is rejected by 1.8.0.13 |
| Disable anti-cheat | `gameProperties.battlEye: false` |
| Reduce the AI load | `operating.aiLimit: <number>` or `operating.disableAI: true` |
| Join queue | `operating.joinQueue.maxSize: <1..50>` |
| Remote console | add the `rcon` section with a `password` |
| Server monitoring | the `a2s` section (port 17777) |
| Modded server | fill `game.mods[]` (GUID from `addon.gproj`) + `supportedPlatforms` without PSN |
| Console players | `game.crossPlatform: true` (PC + all consoles) |
| Your own scenario from a mod | `game.scenarioId` with the GUID from `<Mission>.conf.meta` |
| Fixed time of day | `missionHeader.m_iStartingHours` / `m_iStartingMinutes` (+ `m_bOverrideScenarioTimeAndWeather`) |
| Random weather | `missionHeader.m_bRandomStartingWeather`, `m_bRandomWeatherChanges` (+ `m_bOverrideScenarioTimeAndWeather`) |
| Experience multiplier | `missionHeader.m_fXpMultiplier` |
| Faction limits | `missionHeader.m_aFactionLimits` |
| More supplies at start | `missionHeader.m_iStartingHQSupplies` |
| Allow base building | `missionHeader.m_bEstablishingBasesEnabled` |
| Players' starting rank | `missionHeader.m_eStartingRank` — a number `1`..`18` (`1` = PRIVATE, `6` = MAJOR) |

> `missionHeader` fields do not work for all scenarios: the set depends on the header
> class. Details and full lists — in
> [`ArmaReforger_MissionHeader_EN.md`](ArmaReforger_MissionHeader_EN.md).

---

## 9. Verification and common errors

### Verification order

1. **Check the JSON syntax** with any validator (`jq`, an editor, an online validator).
2. **Start the server and read the log.** Look for three lines:
   ```
   BACKEND : Loading dedicated server config.
   BACKEND : Server config loaded.
   BACKEND : JSON is Valid
   ```
   The third line is confirmation that the schema was accepted.
3. **Check that the socket came up:**
   ```
   NETWORK : Starting RPL server, listening on address 0.0.0.0:2001, fastValidation=true
   ```
4. **Check the registration with the backend:**
   ```
   BACKEND : Server registered with address: <IP>:<port>
   BACKEND : Direct Join Code: <code>
   ```
   `Direct Join Code` is convenient to pass on to players — they can connect directly
   with it.
5. **Check RCON**, if it is configured:
   ```
   BACKEND : [RCON] Init, Ip address=127.0.0.1 and Port=12345
   ```
6. **Check that the scenario loaded** — a line of the form
   `WORLD : Entities load 'worlds/...'` appears in the log, and
   `RESOURCES : Loaded mission headers from N addon(s)!`.

Where the dedicated server logs live:

```
<Dedicated Server>\<profile>\logs\logs_<date>_<time>\console.log
<Dedicated Server>\<profile>\logs\logs_<date>_<time>\error.log
<Dedicated Server>\<profile>\logs\logs_<date>_<time>\script.log
```

The `profile` directory is set by the `-profile` startup parameter; by default it is
`profile` next to the executable.

### Symptom table

| Symptom in the log | Cause | What to do |
|---|---|---|
| `JSON Schema Validation:` then `additionalProperties error:` / `Param "#/game/x" is not allowed and must be removed.` / `Reference in schema: "#/properties/game"` / `JSON is invalid!` / `There are errors in server config!` | The JSON did not pass the schema. **The game names the offending key and the schema branch that rejected it** | Fix the key it names — usually a typo or a pre-0.9.8.73 name (§4 rule 10, and the checklist below) |
| `JSON parse error: <reason> (Line: N, Char: M)` then `There are errors in server config!` | The file is not valid JSON at all: a trailing comma, a comment, an unquoted key, or a mod list pasted without its surrounding `[` `]` | Fix the syntax at the reported line and character. Syntax-check the file (`jq .`) before blaming the server |
| `Unable to open server config file: <path>` then `Failed to load server config!` | `-config` points at a file that does not exist or cannot be read | Check the path. A relative path is resolved against the **current directory**, so launch from the server directory (§10) |
| The `Missing Addon` window: `Can't find '58D0FB3206B6F859' game addon!` | The server was not started from its working directory | `cd` into the server directory before launching (see §10) |
| The `Missing Addon` window with a **different** GUID | An addon required by the scenario or by a mod is missing | Check that the addon is in `addons/` and in `game.mods` |
| The server is visible and reachable from outside, but **will not let you in from your own local network** | `publicAddress` holds a public IP and the router does not support NAT hairpin | Remove `publicAddress` (leave it `""`) or set up forwarding; see §5.1 |
| `Param "#/game/name" is bellow the minimum limit of value/length. The minimum allowed is 1.` | `game.name` is an empty string | Give the server a name — the lower bound is 1 character (§5.4) |
| `Param "#/game/name" has surpassed the maximum limit of value/length. The maximum allowed is 100.` | `game.name` is longer than 100 characters | Shorten it to 100 characters. The name is **rejected, not cropped** |
| `Param "#/game/gameProperties/serverMinGrassDistance" is bellow the minimum limit of value/length. The minimum allowed is 50.` | an explicit `0` (or `1..49`) was written | omit the key (the default `0` means "do not force grass"), or set `50..150` — §4 rule 4 |
| `[A2S] Invalid port, set to default=17777...` | `a2s.port` is out of range | Set 1..65535 |
| `[RCON] Invalid port, set to default=19999...` | `rcon.port` is out of range | Set 1..65535 |
| `[RCON] Init failed... Missing password or password length < 3 characters !!!` | RCON did not come up: the password is empty or shorter than 3 characters | Set `rcon.password` without spaces, from 3 characters |
| `[RCON] Init failed... RCON is now turned off.` | A consequence of the line above — RCON is disabled | Fix the password and restart |
| `Server Config MissionHeader: Parameter 'X' is not supported type!` | An unsupported value type in `missionHeader` | Remove the parameter or change the type |
| `Server Config MissionHeader: Item on index N in parameter 'X' is invalid type!` | A wrong array element type in `missionHeader` | Check the array elements |
| `Storage "X" contains undefined database named "Y"!` | `storages` references a non-existent entry in `databases` | Reconcile the names |
| RCON does not respond, there is no `[RCON] Init` in the log | `rcon.password` is not set, or the password has spaces / is shorter than 3 characters | Fix the password |
| The port is open but the client does not connect | The server is listening on the wrong interface | Check `bindAddress` |
| `Failed to fetch addon details from workshop API!` | No connection to the Workshop API | Check the internet; a wrong `modId` |
| `%d addons are not downloadable! Automatically removed as they have set "required" to false` | The mod is unavailable and marked optional | This is not an error — the mod was removed from the list |

> **About `Server Config file is Invalid - cannot start server!`.** The string is present in the
> executable — it opens the continuous block of schema key names described in §12 — and the
> wiki and older notes quote it as the verdict for a rejected config. **It is not what the
> server wrote on 1.8.0.13 in any of the three failure modes above.** All three rows were
> produced by running the server with
> [`tools/probe-config-schema.mjs`](../../tools/probe-config-schema.mjs) and reading its own log;
> a schema violation and an unparsable file both make the server end by itself within seconds.
> Diagnose from the specific line, not from the quoted string.

> **About `Session name exceed max value > N, cropped under limit...`.** The string is in the
> executable, and older notes gave it as the symptom of a `game.name` that is too long. A
> 101-character name never reaches it: the schema rejects the config first, with the maximum
> message in the table above. Names of 1, 2, 3 and 100 characters all reached `JSON is Valid` on
> 1.8.0.13, so the bound is 1..100 characters and nothing is cropped on the config path. If you do
> meet the cropping line, it comes from somewhere other than `server.json` — do not expect the
> server to trim a name you gave it.

### Checklist before publishing the server

- [ ] `game.scenarioId` — the GUID is taken from the reference, not invented.
- [ ] `fastValidation: true`.
- [ ] `rcon.password` without spaces, at least 3 characters.
- [ ] `game.passwordAdmin` without spaces.
- [ ] `game.name` 1..100 characters — an empty name and a name longer than 100 characters are both rejected.
- [ ] `supportedPlatforms` — an allowed combination.
- [ ] `game.mods[].modId` — the GUID from `addon.gproj` (not `ID`), without curly braces.
- [ ] `game.maxPlayers` ≤ 128.
- [ ] The required UDP ports are open.
- [ ] The log contains `JSON is Valid`.
- [ ] Launch with `-maxFPS` (see §11).

---

## 10. Launching the server

> ### ⚠️ First `cd` into the server directory
>
> **Launch only from the server's working directory.** Otherwise it will not find its own
> game base and will show a modal window:
>
> ```
> Missing Addon
> Can't find '58D0FB3206B6F859' game addon! Check setup guidelines!
> ```
>
> `58D0FB3206B6F859` is the GUID of the `addons\data\ArmaReforger.gproj` file, that is,
> **of the game itself**, not of your mod. The server looks for `.\addons\core` and
> `.\addons\data` relative to the **current directory**, not relative to its own `.exe`.
> The error occurs if `ArmaReforgerServer.exe` was launched by double-clicking it in
> Explorer or by a shortcut with someone else's "Start in" directory.
>
> ```powershell
> cd "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server"
> .\ArmaReforgerServer.exe -config .\config.json -profile .\profile
> ```
>
> To check that the directory is right: `console.log` contains an `Addon dirs:` line with
> `dir: './addons'`, followed by `Available addons:` with the list
> `gproj: './addons/core/core.gproj'` and `gproj: './addons/data/ArmaReforger.gproj'`.
> No such lines — the working directory is wrong.
>
> **Do not confuse this with similar errors.** Here we are talking specifically about the
> `game addon` with GUID `58D0FB3206B6F859`. A different GUID in that window means an
> addon of your mod is missing — that is a different problem.

```powershell
cd "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server"
.\ArmaReforgerServer.exe -config server.json -profile profile
```

> **Linux?** Installation via SteamCMD, a launch script, a `systemd` unit and the
> Linux-specific gotchas (path case, permissions, the RCON protocol) — in Appendix A of
> the document [`ArmaReforger_StartupParams_EN.md`](ArmaReforger_StartupParams_EN.md).
> The requirement for the working directory there is the same, only expressed through
> `WorkingDirectory=` in the unit.

Config parameters can be overridden on the command line. The full breakdown — in
[`ArmaReforger_StartupParams_EN.md`](ArmaReforger_StartupParams_EN.md); here only the
most necessary:

| Parameter | Purpose |
|---|---|
| `-config <file.json>` | Path to the config |
| `-profile <directory>` | Profile directory (logs, saves) |
| `-maxFPS <number>` | Limit the server FPS (60..120 recommended) |
| `-bindIP <IP>` | Override `bindAddress` and `publicAddress` |
| `-bindPort <port>` | Override `bindPort` and `publicPort` |
| `-a2sPort <port>` | Override the A2S port |
| `-a2sIpAddress <IP>` | Override the A2S address |
| `-addons <GUID,...>` | Load mods by GUID. **Incompatible with `-config`** |
| `-addonsDir <path>` | Additional mod directories |
| `-disableAI` | Disable AI |
| `-aiLimit <number>` | AI limit (overrides `operating.aiLimit`) |
| `-disableCrashReport` | Disable the crash reporter |
| `-disableNavmeshStreaming` | Disable navmesh streaming |
| `-logLevel <level>` | Log level: `spam`…`fatal` — useful when debugging |

> Notes on the names verified in the binary of build 1.8.0.13:
> the parameter is called **`-disableCrashReport`** (without `er`; in `server.json` the
> field is called `operating.disableCrashReporter` — with `er`), and the AI limit is
> **`-aiLimit`**, not `-AILimit`. Names are case-insensitive, but the strings must match
> letter for letter.

> ⚠️ `-listScenarios` is **completely absent** from the 1.8.0.13 server binary
> (verified by a case-insensitive search through the strings). It lives in the client
> branch: in `scripts/Game/game.c` (the `OnGameStart` method) it calls
> `SCR_GameLogHelper.LogScenariosConfPaths()`, that is, it prints the list of paths to
> `.conf` files **into the client log**, not to stdout. Running
> `ArmaReforgerServer.exe -listScenarios` produced no list: the output contained only
> backend access errors
> `[RestApi] TYPE:[GameConfig/List] Error - Cannot send request`, and the list never made
> it into the log. If you want to get the listing on the client — launch the game with
> this parameter and look at `console.log` in `logs/<session>/`.
> A ready-made list with GUIDs is already in
> [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md).

> ⚠️ The `-server "<world>"` parameter forces a local world to be loaded,
> and **the config is ignored in that case**.

---

## 11. Two important operations rules

Both are taken from the wiki and marked there as "very important" for public hosting:

1. **`fastValidation` must be `true`.** Otherwise, as every client connects, an excessive
   amount of data is transmitted for all replicated entities and components.
2. **Limit the server FPS with the `-maxFPS` parameter.** Without it the server will try
   to take all the available CPU resources. The recommended range is 60..120.

In addition:

3. **BattlEye is configured by a separate file** `battleye\BEServer_x64.cfg`.
   It already contains the lines `GameID armar` and `MasterPort 2001`.
   Your settings (`RConPort`, `RConPassword`) must be **appended**, not written over the
   file: if `GameID`/`MasterPort` are lost, players get the message
   `Missing GameID/MasterPort server config settings` on join and are kicked out,
   and changed values break BattlEye.
4. **Do not copy the server config between incompatible game versions** without checking
   the log: the set of fields changed between versions, and old names are silently
   ignored.

---

## 12. Sources and caveats

| What | Where from |
|---|---|
| Descriptions, ranges, defaults, versions in which fields appeared | BI Wiki "Arma Reforger: Server Config", revision `oldid=370749` of 2025-03-23. Direct access to the wiki is blocked by Cloudflare (403), a raw Wayback Machine snapshot was used. |
| The full list of key names read by build 1.8.0.13; the texts of the A2S/RCON/Storage/MissionHeader errors | Strings of `ArmaReforgerServer.exe` (dedicated server, v1.8.0.13, engine 192142) |
| The format of a real config, the order of lines in the log, startup parameters | A working dedicated server: `config.json`, `test/logs/logs_*/console.log` |
| The length limits of `game.name` and the exact messages for them | Running 1.8.0.13 with [`tools/probe-config-schema.mjs`](../../tools/probe-config-schema.mjs): empty → `minimum allowed is 1`, 101 characters → `maximum allowed is 100`, 1/2/3/100 characters → `JSON is Valid` |
| The scenario GUID table | `resourceDatabase.rdb` + a cross-check against 8 GUIDs from the wiki (all matched). Tool: [`tools/rdb.mjs`](../../tools/rdb.mjs) (`verify` repeats the cross-check) |
| Platform types, launch, RCON commands | BI Wiki "Server Hosting", "Startup Parameters", "Server Management" |

### Boundaries of reliability

- **Sections §5.7 and everything marked `[binary]` without `[wiki]` are not documented.**
  All that is known is that these keys are read by build 1.8.0.13. Do not rely on them
  without verifying with the log.
- **`missionHeader` is not publicly described in the wiki**, but it has been broken down
  from the sources in
  [`ArmaReforger_MissionHeader_EN.md`](ArmaReforger_MissionHeader_EN.md): the fields,
  types, defaults and the numeric values of the `SCR_ECharacterRank` ranks are taken from
  the classes `SCR_MissionHeader`, `SCR_MissionHeaderCampaign` and `SCR_RankInfo`.
  Not extracted: the composition of `SCR_CampaignCustomBase`, the fields of
  `SCR_RankInfoCampaign` and the experience thresholds for military ranks — they are
  marked as unknown.
- **The wiki revision is March 2025, the server build is January 2026.** Fields added
  between those dates may not have made it into the wiki. That is exactly why §5.5–§5.7
  contain `[binary]` entries — those are precisely such fields. The reverse situation
  (a field is in the wiki but is not read by the build) has not been observed:
  all keys from the wiki are present in build 1.8.0.13.
- The wiki warns that "values are strings unless stated otherwise". Practice shows that
  numeric and boolean fields must be numbers and booleans: the config from §7 with
  numbers and `true`/`false` passes validation.
  If in doubt — check against §6.1 and §7.
- `/` in `scenarioId` for mod missions: the path is given relative to the addon root,
  the GUID — from `<file>.conf.meta`. If the `.meta` is absent, the resource is not
  registered and the server will not find it.

### Related documents

- [`ArmaReforger_Scenarios_EN.md`](ArmaReforger_Scenarios_EN.md) — the scenario and GUID table.
- [`ArmaReforger_MissionHeader_EN.md`](ArmaReforger_MissionHeader_EN.md) — the full breakdown of `missionHeader`: all fields with types and defaults, rank values, the list of custom bases.
- [`ArmaReforger_StartupParams_EN.md`](ArmaReforger_StartupParams_EN.md) — startup parameters, including the appendix about Linux.
- [`ArmaReforger_Profile_EN.md`](ArmaReforger_Profile_EN.md) — the profile directory: logs, session saves, `ownerToken.bin`, engine settings.
- [`ArmaReforger_RCON_EN.md`](ArmaReforger_RCON_EN.md) — remote administration: configuration, permissions, the full command list, diagnostics.
- [`skills/`](../../skills/) — skills for future sessions: reading game data, assembling a server config, remote administration over RCON.
- [`tools/rdb.mjs`](../../tools/rdb.mjs) — reading `resourceDatabase.rdb`: `get` (GUID → path),
  `guid` (path → GUID), `list`, `info`, and `verify`, which reproduces the 8 published GUIDs
  before the table is trusted.
- [`tools/verify-against-install.mjs`](../../tools/verify-against-install.mjs) — the same checks
  against an installed build in one command: which key names and parameters are present, the
  pre-0.9.8.73 field names, every scenario GUID and the installed version. Run it after a game
  update to see whether a field has been renamed again.
- [`tools/pak.mjs`](../../tools/pak.mjs) — reading and extracting anything from a `pak` by virtual
  path: `list`, `tree`, `get`, `cat`, `find` (content search across the archive) and `verify`
  (checks the archive's own offset base and decompresses a sample against the index). Both
  storage forms — stored and zlib — are handled; there is no encryption in the format. The
  format and the one mistake that breaks it are in
  [`skills/arma-reforger-game-data`](../../skills/arma-reforger-game-data/SKILL.md).
- [`tools/validate-doc-json.mjs`](../../tools/validate-doc-json.mjs) — validating all JSON blocks in these documents.

### How to verify the `[binary]` claims yourself

Key names and error texts can be searched for in the server executable as ordinary
strings — they are not encrypted or compressed:

```powershell
$exe = "ArmaReforgerServer.exe"
$s = [System.Text.Encoding]::GetEncoding(28591).GetString([IO.File]::ReadAllBytes($exe))
$s.IndexOf("serverMaxViewDistance")   # -> an offset, or -1 if the string is absent
```

The full list of schema keys lies in one continuous block (in build 1.8.0.13 —
at offset `0x1A87640`), starting with the string
`Server Config file is Invalid - cannot start server!`.
That string is still present in **1.8.0.13, at the same offset `0x1A87640`** — which is why old
notes kept quoting it as "the verdict", even though the server writes more specific messages when
it rejects a config (§9).
To check a whole list of names at once, use
[`tools/verify-against-install.mjs`](../../tools/verify-against-install.mjs).

Whether a name is actually **accepted by the schema** is a different question, and only the server
answers it: [`tools/probe-config-schema.mjs`](../../tools/probe-config-schema.mjs) launches it with
a config, reads the verdict from the log, and prints the lines the game wrote — including the
offending key when the schema rejects one.

---

## Appendix A. Verbatim blocks from the wiki page

These two blocks are quoted **verbatim** from the BI "Arma Reforger: Server Config" page
(revision of 2025-03-23). They are useful as a primary source: the rest of the document's
sections are a paraphrase plus build-specific corrections, whereas here you can see what
Bohemia actually wrote.

### A.1 The `## Template` block (as is)

```json
{
	"bindAddress": "",
	"bindPort": 0,
	"publicAddress": "",
	"publicPort": 0,
	"a2s": {
		"address": "",
		"port": 0
	},
	"rcon": {
		"address": "",
		"port": 0,
		"password": "",
		"permission": "monitor",
		"blacklist": [],
		"whitelist": []
	},
	"game": {
		"name": "",
		"password": "",
		"passwordAdmin": "",
		"admins" : [],
		"scenarioId": "",
		"maxPlayers": 0,
		"visible": true,
		"gameProperties": {
			"serverMaxViewDistance": 1600,
			"serverMinGrassDistance": 0,
			"networkViewDistance": 1500,
			"disableThirdPerson": false,
			"fastValidation": true,
			"battlEye": true,
			"VONDisableUI": false,
			"VONDisableDirectSpeechUI": false,
			"VONCanTransmitCrossFaction": false
		},
		"mods": []
	}
}
```

> **What is missing from this template**, although it is present in the wiki text and/or
> in its example: `rcon.maxClients`, `game.crossPlatform`, `game.supportedPlatforms`,
> `game.modsRequiredByDefault`, `gameProperties.missionHeader` and **the whole
> `operating` section**. The template is incomplete — do not treat it as an exhaustive
> list of fields.
>
> The `0` values for the ports in the template are stubs: they must not be substituted,
> see §3 for the working ports.

### A.2 The `## Example` block (as is)

```json
{
	"bindAddress": "0.0.0.0",
	"bindPort": 2001,
	"publicAddress": "192.168.9.10",
	"publicPort": 2001,
	"a2s": {
		"address": "192.168.9.10",
		"port": 17777
	},
	"rcon": {
		"address": "192.168.9.10",
		"port": 19999,
		"password": "changeme_withoutspaces",
		"permission": "monitor",
		"blacklist": [],
		"whitelist": []
	},
	"game": {
		"name": "Server Name - Mission Name",
		"password": "",
		"passwordAdmin": "changeme",
		"admins" : [
			"76561198200329058"
		],
		"scenarioId": "{ECC61978EDCC2B5A}Missions/23_Campaign.conf",
		"maxPlayers": 32,
		"visible": true,
		"crossPlatform": true,
		"supportedPlatforms": [
			"PLATFORM_PC",
			"PLATFORM_XBL"
		],
		"gameProperties": {
			"serverMaxViewDistance": 2500,
			"serverMinGrassDistance": 50,
			"networkViewDistance": 1000,
			"disableThirdPerson": true,
			"fastValidation": true,
			"battlEye": true,
			"VONDisableUI": true,
			"VONDisableDirectSpeechUI": true,
			"missionHeader": {
				"m_iPlayerCount": 40,
				"m_eEditableGameFlags": 6,
				"m_eDefaultGameFlags": 6,
				"other": "values"
			}
		},
		"mods": [
			{
				"modId": "59727DAE364DEADB",
				"name": "WeaponSwitching",
				"version": "1.0.1"
			},
			{
				"modId": "59727DAE32981C7D",
				"name": "Explosive Goats beta",
				"version": "0.5.42"
			}
		]
	},
	"operating": {
		"lobbyPlayerSynchronise": true,
		"joinQueue" : {
			"maxSize" : 12
		},
		"disableNavmeshStreaming": [
			"Soldiers",
			"BTRlike"
		]
	}
}
```

> This example contains knowingly unverifiable stubs: `"other": "values"`
> in `missionHeader` and the obviously demonstrative `changeme`/`changeme_withoutspaces`.
> The mod GUIDs here are fictional. Take only the structure from the block, not the
> values.
