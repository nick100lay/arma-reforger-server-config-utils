---
name: arma-reforger-server-launch
description: Launch an Arma Reforger dedicated server on Windows or Linux and prove it is up - interview the user for the settings that matter (public address, RCON, profile and ownerToken, admins, cross-platform, max players, scenario, where the folder goes), write and validate server.json, place it next to the server executable with a start script, launch it outside any sandbox with the working directory set to the server directory, watch the log until "Server registered with address:", check the UDP ports and the A2S answer, then hand over the join code, the router port-forwarding rules and the NAT-hairpin warning. Use when asked to set up, launch, start or move a server; when the log shows "Missing Addon" / "Can't find '58D0FB3206B6F859' game addon"; when the server never appears in the browser or never registers; when a port looks closed or RCON does not answer; or when a new server needs a profile and an ownerToken.bin.
---

# Launching an Arma Reforger dedicated server

This skill takes a server from "the executable is installed" to "players can join, and here is the
evidence". It is the operational counterpart of the config authoring skill: the keys, ranges and
error strings live in [arma-reforger-server-config](../arma-reforger-server-config/SKILL.md) and
[the config guide](../../docs/en/ArmaReforger_ServerConfig_EN.md); this skill covers the
interview, the folder layout, the command line, the launch, and the checks that prove it worked.

## 0. What you are producing

1. A **folder next to the server executable** (default `<serverDir>/<ServerName>/`) that holds
   `config.json`, a start script for the platform, and — if the user chose it — the profile.
2. A **validated `server.json`** whose values are the user's answers, not your guesses.
3. A **running server**, evidenced by the log line `Server registered with address:` and by the
   operating-system socket table.
4. **Instructions**: the join code / address, the ports to forward, and the two things that make a
   home server look broken (NAT hairpin, and running the server inside a sandbox).

Do not write anything to the config until the interview in §2 is answered. The user's rule is that
these questions are asked *unless they already answered them* — so ask once, in one message, with
the recommended option marked, and skip what the user has already stated.

## 1. Three rules that decide whether it works at all

1. **The working directory must be the server directory.** The engine resolves `./addons/core`
   and `./addons/data` against the *current directory*, not against its own `.exe`. Launched from
   anywhere else it shows (or logs) `Missing Addon` / `Can't find '58D0FB3206B6F859' game addon!`
   — the GUID of the game itself. Every script below does `cd` (Windows) or `cd`/`WorkingDirectory=`
   (Linux) first.
2. **The server must not run inside a sandbox.** Under one that blocks named pipes or the TLS
   certificate store, the engine hangs before its first log line or fails every backend call with
   `Curl error=SSL peer certificate ...` / `ENV:[invalid]`. The server then never writes
   `Server registered with address:` and is invisible to the browser. Launch it from an
   unrestricted shell; if your own shell is sandboxed, ask the user to run the launch command or
   use the widest permission the environment offers for exactly that command.
3. **Never invent a `scenarioId`, an admin id or a password.** A `scenarioId` is
   `{16 hex}Missions/Name.conf` copied from [data/scenarios.json](../../data/scenarios.json)
   (38 vanilla scenarios); a mod mission's GUID comes from its `.conf.meta` (`Name` field). A wrong
   GUID fails silently or exits with a mission error.

## 2. The interview

Ask all of this in one message. Mark the recommended answer, keep the list short, and use the
user's own words for anything they already said.

```
Before I write the config, nine answers (recommended options are marked):

 1. Server name, and should it be listed in the server browser?   [required name; visible = yes]
    Join password?                                               [empty = open server]
 2. Public address: let the server detect it, or pin your public IP?   [auto = recommended]
 3. RCON: local 127.0.0.1, external 0.0.0.0, or off?   [local = recommended]
    Password and permission (admin / monitor)?
 4. Profile: the server default (next to the executable) or a path of your own?   [default]
    ownerToken.bin: copy one from another profile, or let the server create it?   [create]
 5. Administration: admin ids in `admins`, an admin password, or none?
    [none; the owner token holder stays the owner]
 6. Cross-platform: enable, disable, or a custom platform list?   [disabled: PC only]
 7. Maximum players?                                             [32]
 8. Which scenario should run?   [Conflict - Everon]
 9. Where should the folder with the config go?   [next to the server executable]
```

### 2.1 Name, join password, visibility

`game.name` is mandatory and the schema enforces **1..100 characters** — an empty or 101-character
name stops the server. `game.password` is the join password (`""` = none). `game.visible` puts the
server in the browser; `false` still allows joining by code/address and is the right answer for a
test server.

### 2.2 Public address

Two answers:

- **Let the server detect it** (recommended): `"publicAddress": ""`. The server registers the
  address it sees and writes it to the log as `Server registered with address: <ip>:<port>`.
- **Pin an IP**: put it in `publicAddress`. Then warn the user: a pinned public IP breaks joining
  **from the server's own LAN** unless the router does NAT hairpin, and the log shows nothing —
  see §8.4. If the external port differs from the local one, `publicPort` is the external port and
  `bindPort` the local one.

Never put a `192.168.x.x`/`10.x` address in `publicAddress` on an internet-facing server, and do
not "fix" an address problem with `-bindIP` — it overrides both `bindAddress` and `publicAddress`.

### 2.3 RCON

Ask which binding and get a password and a permission level. Write the block only if the user
wants RCON:

```json
"rcon": {
  "address": "127.0.0.1",
  "port": 19999,
  "password": "<no spaces, at least 3 characters>",
  "maxClients": 4,
  "permission": "admin"
}
```

- **`127.0.0.1` is the recommended binding.** RCON grants full control (kick, ban, restart,
  shutdown) and is protected by the password alone; a server reachable from the internet with
  `rcon.address: "0.0.0.0"` is an open door. The alternative is an SSH tunnel or a VPN, not
  opening the port.
- **`0.0.0.0` is the external choice.** Say plainly that this exposes the remote console to the
  whole internet, that it must then be firewalled, and that it needs a long random password. The
  minimum of 3 characters is an engine limit, not a recommendation.
- **`permission`: `admin` or `monitor`.** `monitor` can run only `#players`; there is no finer
  granularity. `blacklist`/`whitelist` exist for command filtering.
- **The password must not contain spaces and must be at least 3 characters**, otherwise the server
  writes `[RCON] Init failed... Missing password or password length < 3 characters !!!` and RCON
  stays off. Record the password in the config only; do not echo it in the transcript or in shell
  history (use the `RCON_PASSWORD` environment variable for client runs).

### 2.4 Profile and `ownerToken.bin`

The profile is the server's identity, not just a log folder. Ask which one:

- **Server default** (recommended): `<serverDir>/profile`, next to the executable. It is what the
  server uses when `-profile` is omitted; pass it explicitly so the script is unambiguous.
- **A path of your own**: use the absolute path. One profile per server — two servers must not
  share one, and copying `ownerToken.bin` does not clone a server.

Then the owner-token question. Explain, briefly:

- The token lives at **`<profile>/profile/ownerToken.bin`** (the profile directory contains a
  `profile` subdirectory). It is a JWT issued by Bohemia's backend on the first successful
  registration; a profile that never reached the backend has none.
- It is the server's ownership credential: one token = one room = one ban list. Giving the same
  token to a second running server makes the two fight over the room, and the earlier one shuts
  down with `DS Room/ Server not exist anymore, shutting down...`.
- Losing it loses the server's identity and ban list; back it up, and never publish it.

Ask: **copy an existing `ownerToken.bin` from another profile, or let the server create a new
one?** If copying, put it at `<profile>/profile/ownerToken.bin` *before* the first start, verify
the path, and make sure the source server is not running on the same token. If not copying and the
target has no token, say that the server will create one on its first registration — which needs
internet access.

To tell the user who the owner is, read only the claims — never print the token:

```bash
node -e "const p=JSON.parse(Buffer.from(require('fs').readFileSync(process.argv[1],'utf8').split('.')[1],'base64url'));console.log({ownerType:p.ownerType,ownerId:p.ownerId})" "<profile>/profile/ownerToken.bin"
```

`ownerType: "GameIdentity"` means the player in `ownerId` is the owner; `"Anonymous"` means no
player owns it (the typical dedicated-server token).

### 2.5 Administration

Offer three answers, and allow a combination:

- **Admins in the `admins` list** — the user lists identity ids (UUID, e.g.
  `0ac6169c-15e4-4b5d-8073-08e602583069`) and/or Steam ids (17 digits). Maximum 20 unique ids.
  Copy them exactly; never invent or "correct" one. Such players can log in without a password.
- **An admin password** — `game.passwordAdmin`, non-empty and without spaces. Required if the user
  chooses this. Warn: anyone with the password becomes an administrator, it sits in plain text in
  the config, and it is not a per-person account; the `admins` list is the safer option. Login in
  game is `#login <password>`.
- **Defaults** — no extra admins: `admins: []`, `passwordAdmin: ""`. Explain who is admin then:
  if the profile's token has `ownerType: "GameIdentity"`, the **owner is the admin** and logs in
  without a password; if the token is anonymous or absent, nobody has in-game admin rights until
  one of the two options above is configured (RCON still works).

### 2.6 Cross-platform

Three answers, and the combinations are not arbitrary:

| Answer | Config | Valid? |
|---|---|---|
| Disable | `crossPlatform: false`, `supportedPlatforms: ["PLATFORM_PC"]` | yes, vanilla and modded |
| Enable | `crossPlatform: true` (adds PC + XBL + PSN if absent) | yes, vanilla and modded |
| Custom | explicit `supportedPlatforms` | only the rows below |

| Combination | Allowed? |
|---|---|
| PC only | yes |
| PC + Xbox + PlayStation | yes |
| PC + Xbox | **only on a modded server**; PSN is never added there |
| PC + PlayStation, Xbox only, PlayStation only, Xbox + PlayStation | **no** |

If the user asks for a custom list that is not allowed, say so and offer the nearest allowed one.
`crossPlatform: true` is the simplest way to say "all consoles"; with mods it still means PC +
Xbox.

### 2.7 Maximum players

`game.maxPlayers`, integer 1..128. Ask; 64 is the class default, 32 is a safe answer for a first
server, 16 for a test.

### 2.8 Scenario

Ask which mode and map, then look up the exact string — do not type a GUID from memory:

- Vanilla: [data/scenarios.json](../../data/scenarios.json) / the
  [scenarios document](../../docs/en/ArmaReforger_Scenarios_EN.md). Map codenames are traps:
  `Eden` is Everon, `Cain` is Kolguyev, `Arland` is Arland.
- A mod mission: the mission's `.conf.meta`, field `Name`, e.g. `{GUID}Missions/X.conf`.

One scenario per server; there is no rotation. If the user wants mods, the list comes from the
game's mod window (JSON tab) wrapped in `[` `]` — see the config skill §3; mods also change the
cross-platform answer (no PSN).

### 2.9 Where the folder goes

Default: a folder next to the server executable, named after the server (`<serverDir>/MyServer/`).
Offer a different path if the user wants one. The folder must be readable by the server process and
should be writable if the profile lives inside it.

## 3. Write the config

1. Copy [assets/config.template.json](assets/config.template.json) — a complete, schema-valid
   config with the defaults from this skill (A2S on, PC only, Conflict Everon, 32 players).
2. Apply the answers. The template already contains every key this skill sets; add the `rcon`
   block only when RCON was requested, and `game.mods` only when there are mods.
3. **Omit `game.gameProperties.serverMinGrassDistance` unless the user asks for a value in
   50..150.** The wiki allows `0`, but build 1.8.0.13 rejects an explicit `0` with
   `... is bellow the minimum limit ... The minimum allowed is 50.` and the server exits. Leaving
   the key out gives the default (no forced grass distance); writing `50`..`150` forces one.
4. **Write UTF-8 without a BOM.** PowerShell's `Set-Content -Encoding utf8` and `Out-File` write a
   BOM, and the server then fails to parse the file (`JSON parse error: ... Unexpected token`,
   reported at line 1). Use an editor that writes plain UTF-8, or a Node/Python one-liner.
5. Validate before launching:
   - `npm run validate-server -- <path>/config.json` in this repository — errors mean the server
     will reject the file, warnings mean it starts but clamps or ignores a value.
   - When the repository is not available, check the hard rules in the config skill §3 and the
     failure table in §9 of the config guide.
   - Optional and closest to the truth: `node tools/probe-config-schema.mjs <config.json>` runs the
     server itself and reports `accepted` / `rejected` — it must run outside a sandbox (§1).

## 4. Place the folder and the start scripts

Layout (default profile inside the server directory shown separately):

```
<serverDir>/
  ArmaReforgerServer.exe        (Linux: ArmaReforgerServer)
  addons/                       the game itself — never move it
  <ServerName>/
    config.json
    start-server.cmd            Windows
    start-server.sh             Linux
  profile/                      the server-default profile (chosen in §2.4)
    logs/logs_<date>_<time>/console.log
    profile/ownerToken.bin
```

If the profile was placed inside the server folder instead, adjust the paths in the scripts.

**`start-server.cmd`** — bake the absolute server directory in; `%~dp0` is the script's own folder:

```bat
@echo off
setlocal
rem Working directory MUST be the server directory: otherwise "Missing Addon 58D0FB3206B6F859".
set "SERVER_DIR=C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server"
cd /d "%SERVER_DIR%" || exit /b 1
"%SERVER_DIR%\ArmaReforgerServer.exe" ^
  -config "%~dp0config.json" ^
  -profile "%SERVER_DIR%\profile" ^
  -maxFPS 60 -logTime datetime -logLevel normal
```

**`start-server.sh`** — `cd` first for the same reason, then `exec`:

```bash
#!/usr/bin/env bash
set -euo pipefail
SERVER_DIR="/home/steam/reforger/server"
cd "$SERVER_DIR"
exec "$SERVER_DIR/ArmaReforgerServer" \
  -config "/home/steam/reforger/server/MyServer/config.json" \
  -profile "/home/steam/reforger/server/profile" \
  -maxFPS 60 -logTime datetime -logLevel normal "$@"
```

Make it executable (`chmod +x`) and never launch it as root; the server must be able to write to
the profile directory.

### 4.1 The command line, and what each parameter is for

| Parameter | Why it is there |
|---|---|
| `-config <absolute path>` | the config; absolute so it cannot resolve against the wrong directory |
| `-profile <absolute path>` | the profile; absolute for the same reason |
| `-maxFPS 60` | without it the server tries to take all available CPU. 60..120 is the recommended range |
| `-logTime datetime` | timestamps become `2026-10-17 04:51:39.165`, so logs from several runs can be lined up |
| `-logLevel normal` | normal logging. Do **not** add the debug firehoses (`-logFS`, `-log-rdb-checksum`, `-log-scr-checksum`, `-logLevel debug/spam`) unless the problem calls for them |

Add what the user asked for, and screen every extra parameter against
[data/startup-params.json](../../data/startup-params.json) first: `present` is usable on 1.6.0.119,
`absent` is a silent no-op. Two parameters are traps: **`-addons` is incompatible with `-config`**
(mods go in `game.mods`), and **`-bindIP`/`-bindPort` override both the bind and the public
address/port**, so they are the wrong tool for a NAT problem.

## 5. Launch

### 5.1 Windows

From an unrestricted shell (not a sandbox), start the script with the server directory as the
working directory, so the script and the engine agree even before `cd` runs:

```powershell
$folder = "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server\MyServer"
$serverDir = "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server"
Start-Process -FilePath "$folder\start-server.cmd" -WorkingDirectory $serverDir -PassThru
```

`-PassThru` gives a process object; the server also writes its own log, which is what §6 reads.
If the shell you are in is sandboxed, do not "try harder" here — ask the user to double-click
`start-server.cmd` (it sets its own working directory) or re-run the command with unrestricted
access. A sandboxed launch is indistinguishable from a broken config until you read the log.

### 5.2 Linux

```bash
chmod +x "<folder>/start-server.sh"
setsid nohup "<folder>/start-server.sh" > "<folder>/server.out" 2>&1 &
echo $!
```

For a server that must survive a reboot, use the systemd unit from Appendix A.4 of the
[startup parameters document](../../docs/en/ArmaReforger_StartupParams_EN.md): the essential part
is `WorkingDirectory=<serverDir>` and `ExecStart=<folder>/start-server.sh`, with
`KillSignal=SIGINT` for a clean stop. The Linux build is native x86_64 — no Wine, no Proton, no
ARM64, and it does not work under Steam Linux Runtime (`T165196`).

## 6. Watch the log until it is ready

The log lives at `<profile>/logs/logs_<YYYY-MM-DD>_<HH-MM-SS>/console.log` — a new directory per
launch, so always take the newest one. The sequence below is what build 1.8.0.13 writes; the whole
start takes about 15-20 s (18 s observed on this machine).

| Log line | Means |
|---|---|
| `CLI Params: ...` | what the engine actually received — the first thing to check when a flag "does not work" |
| `dir: './addons'` + `gproj: './addons/data/ArmaReforger.gproj' guid: '58D0FB3206B6F859'` | the working directory was right |
| `Server config loaded.` then `JSON is Valid` | the schema accepted the file; `JSON is invalid!` names the offending key |
| `Entities load 'worlds/...'` | the scenario's world is loading |
| `Starting RPL server, listening on address <ip>:<port>` | the game socket is up |
| `Server registered with address: <ip>:<port>` | the backend accepted the server: this is the "ready" line |
| `Direct Join Code: <code>` / `Ping Site: <site>` | what players type to join directly |
| `[RCON] Init, Ip address=... and Port=...` | RCON is up (absent when RCON is not configured) |

Do not conclude "ready" from the process being alive, and do not read `[RCON] Init failed...` as a
fatal server error — RCON is optional and stays off, the server itself runs.

### 6.1 The check to run

```bash
node tools/server-status.mjs --profile "<profile>" --config "<folder>/config.json" --wait 180
```

It polls the newest `console.log`, stops at registration or at a fatal line, reads the expected
ports from the config, asks the operating system which UDP endpoints exist, probes A2S, and prints
a verdict. Exit codes: `0` ready and all expected ports bound, `1` not ready, `2` usage. States:

- `ready` — registration seen; go to §7.
- `listening` — the game socket is up but registration never happened: no internet, a proxy, or a
  sandboxed launch (`Curl error=SSL peer certificate`, `ENV:[invalid]`). Fix the environment, not
  the config.
- `starting` — the world is still loading; wait.
- `failed` — read the fatal line. A schema rejection names the key; `Missing Addon` with
  `58D0FB3206B6F859` means the working directory was wrong.
- `new` — no log at all: the server did not start, or `-profile` points at a different directory
  than the one you are reading.

Without the repository, do the same three checks by hand: newest `console.log` for
`JSON is Valid` / `Server registered with address:`, `Get-NetUDPEndpoint -LocalPort 2001`
(Windows) or `ss -lunp | grep 2001` (Linux), and `node tools/rcon.mjs` if available.

## 7. Verify the ports

What must be open is UDP only — the game port, A2S and RCON are all UDP; there is no TCP listener:

| Port | Protocol | Purpose | Config key | Forward on the router? |
|---|---|---|---|---|
| 2001 | UDP | the game (RPL) | `bindPort` / `publicPort` | yes |
| 17777 | UDP | A2S / Steam Query — server browser and monitoring | `a2s.port` | yes |
| 19999 | UDP | RCON | `rcon.port` | only if `rcon.address` is `0.0.0.0`; otherwise never |

Three different questions, and they need three different answers:

1. **Did the server bind the ports?** The status tool's socket table (or
   `Get-NetUDPEndpoint`/`ss -lunp`) with the server's pid. `MISSING` means the server did not
   bind: a config or startup-parameter override, or the wrong profile.
2. **Does the port answer?** A2S is the only endpoint that answers without a password: the status
   tool sends an A2S_INFO query and prints the server name, map and player count. For RCON, log in
   with the client — in bash `RCON_PASSWORD='<password>' node tools/rcon.mjs players --port <port>`,
   in PowerShell `$env:RCON_PASSWORD='<password>'; node tools/rcon.mjs players --port <port>`
   (`--json` for the machine-readable form). A silent RCON with `[RCON] Init` in the log means the
   port or address is wrong, or a firewall eats the packet.
3. **Is the port reachable from the internet?** This cannot be answered on the server host: a bound
   socket says nothing about the router. Forward the ports and probe from outside (a phone on
   mobile data, a VPS, or an online UDP port checker). Say so explicitly instead of promising that
   "the ports are open" from a local check.

## 8. Tell the user how to connect

### 8.1 Joining

- **Direct Join Code** from the log (`Direct Join Code: 0340196985`) — the shortest path, and the
  one to quote in a chat.
- **By address**: `<publicAddress>:<publicPort>` from `Server registered with address:` (for a
  LAN-only test, `<server LAN IP>:2001`).
- **Server browser**: only when `game.visible` is `true`; the name is `game.name`.
- **Password**: `game.password`, if set.
- **Admin in game**: `#login <passwordAdmin>`, or the owner token holder without a password.

### 8.2 Router port forwarding

Forward on the router, to the server's **LAN** address (give it a static DHCP lease so the rule
keeps working):

- `2001/udp` → `<LAN IP>:2001`
- `17777/udp` → `<LAN IP>:17777`
- `19999/udp` only if RCON was deliberately bound to `0.0.0.0` — and then firewall it to known
  addresses if the router can.

If the external port differs from the internal one, set `publicPort` to the external port and
`bindPort` to the internal one, and forward external → internal.

### 8.3 Host firewall

Windows Defender Firewall, one rule per protocol (all three ports can share it):

```powershell
New-NetFirewallRule -DisplayName "Arma Reforger Server" -Direction Inbound -Protocol UDP `
  -LocalPort 2001,17777 -Action Allow
```

Linux: `sudo ufw allow 2001/udp`, `sudo ufw allow 17777/udp`, and `19999/udp` only for an
external RCON. Open TCP for these ports nowhere: there is no TCP listener.

### 8.4 The NAT-hairpin trap

If `publicAddress` holds the public IP, players from outside can join but **you cannot join from
the same LAN**: the client is told the public address, sends packets to its own network's public
IP, and the router must loop them back in (NAT hairpin). Many home routers cannot. The server log
shows nothing — the packets never arrive.

What to tell the user, best first: leave `publicAddress` empty (the server detects it); join from
inside by the LAN address; enable NAT loopback/hairpin on the router; or set up forwarding from the
public IP to the LAN one. Do not try `-bindIP` — it overrides both addresses and pins the problem.

## 9. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Missing Addon` window or log line, GUID `58D0FB3206B6F859` | the working directory was not the server directory | run the start script, or `cd` into the server directory first |
| The same window with another GUID | an addon of the scenario or a mod is missing | check `addons/` and `game.mods` |
| `Param "#/game/..." is not allowed` / `... bellow the minimum limit` | the schema rejected a key or value; the line names it | fix the named key; for `serverMinGrassDistance: 0` omit the key (§3) |
| `JSON parse error: ... (Line: 1, Char: 1)` / `Unexpected token` at the very start of the file | the file has a BOM or is not JSON (comments, trailing comma, mod list pasted without `[` `]`) | rewrite as UTF-8 without BOM, validate with `npm run validate-server` |
| `Unable to open server config file: <path>` | `-config` points elsewhere; a relative path resolves against the working directory | use an absolute path |
| `[RCON] Init failed... Missing password or password length < 3 characters` | the password is empty, has spaces, or is shorter than 3 | fix `rcon.password` |
| RCON does not answer although `[RCON] Init` is in the log | wrong port/address, UDP blocked, or the client is not logged in | `RCON_PASSWORD=... node tools/rcon.mjs players --port <port>`; check the socket table |
| RCON answers `PENDING` on a ban, or a command gets silence | a `maxClients` slot is held by a closed client for 45 s | let `tools/rcon.mjs` send `@logout`, or raise `maxClients` |
| `Server registered with address:` never appears; `Curl error=SSL peer certificate` or `ENV:[invalid]` | no internet, a TLS proxy, or a sandboxed launch | run outside the sandbox; check the clock and the proxy |
| Server visible outside but not joinable from the LAN | NAT hairpin, see §8.4 | leave `publicAddress` empty / use the LAN address |
| Server invisible in the browser | `visible: false`, or registration failed, or A2S is blocked | set `visible: true`; read the log for registration; forward 17777/udp |
| Two servers: one shuts down with `DS Room/ Server not exist anymore, shutting down...` | both profiles carry the same `ownerToken.bin` | one profile and one token per server |
| `No log yet` from the status tool | `-profile` points somewhere else, or the server never started | check `CLI Params:` in the log, then the working directory |
| Server exits immediately after `Attempting online Game Config instead.` | the local config was rejected; the engine tried the online one and gave up | read the schema lines above it |

## 10. The final report to the user

Keep it short and factual:

```
Server ready.
  Folder:     <serverDir>\MyServer\   (config.json, start-server.cmd)
  Profile:    <serverDir>\profile     (ownerToken.bin, logs)
  Scenario:   Conflict - Everon       maxPlayers: 32   crossPlatform: off
  RCON:       127.0.0.1:19999         admin
  Join:       Direct Join Code 0340196985, or 203.0.113.10:2001
  Ports:      2001/udp and 17777/udp are bound and the A2S query answers with the server name.
              Forward both on the router (UDP) to <LAN IP>; 19999/udp stays closed.
  Note:       You cannot join through the public IP from the same LAN unless the router does
              NAT hairpin - use <LAN IP>:2001 from inside.
```

If something is still wrong, say exactly which check failed and what the log said, rather than
"it should work".

## 11. References

- [The config guide](../../docs/en/ArmaReforger_ServerConfig_EN.md) — keys, ranges, defaults,
  templates, the error table, and the launch section.
- [Scenarios](../../docs/en/ArmaReforger_Scenarios_EN.md) — every `scenarioId` with its GUID.
- [Startup parameters](../../docs/en/ArmaReforger_StartupParams_EN.md) — the command line,
  parameter-by-parameter, plus Appendix A on Linux (SteamCMD, launch script, systemd, ports).
- [RCON](../../docs/en/ArmaReforger_RCON_EN.md) — permissions, commands, diagnostics.
- [Profile](../../docs/en/ArmaReforger_Profile_EN.md) — logs, `ownerToken.bin`, saves, bans.
- [Backend API](../../docs/en/ArmaReforger_BackendAPI_EN.md) — what registration means, and why a
  sandboxed or proxied server cannot do it.
- Sibling skills: [server config](../arma-reforger-server-config/SKILL.md),
  [RCON](../arma-reforger-rcon/SKILL.md).
- Tools: [server-status.mjs](../../tools/server-status.mjs) (readiness + ports),
  [rcon.mjs](../../tools/rcon.mjs), [probe-config-schema.mjs](../../tools/probe-config-schema.mjs),
  [validate-server-config.mjs](../../tools/validate-server-config.mjs).
