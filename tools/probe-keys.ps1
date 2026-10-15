param(
    [string]$Exe = "C:\Program Files (x86)\Steam\steamapps\common\Arma Reforger Server\ArmaReforgerServer.exe",
    [string[]]$Keys = @(
        'bindAddress','bindPort','publicAddress','publicPort',
        'gameHostBindAddress','gameHostBindPort','gameHostRegisterBindAddress','gameHostRegisterPort',
        'dedicatedServerId','region','serverId','ownerType',
        'scenarioId','maxPlayers','passwordAdmin','admins','visible','name','password',
        'mods','modId','modID','version','required','modsRequiredByDefault',
        'supportedPlatforms','crossPlatform','gameProperties',
        'serverMaxViewDistance','serverMinGrassDistance','networkViewDistance',
        'fastValidation','battlEye','disableThirdPerson',
        'VONDisableUI','VONDisableDirectSpeechUI','VONCanTransmitCrossFaction','missionHeader',
        'operating','lobbyPlayerSynchronise','disableCrashReporter','disableServerShutdown',
        'aiLimit','disableAI','disableNavmeshStreaming','slotReservationTimeout','playerSaveTime','joinQueue','maxSize',
        'a2s','rcon','permission','whitelist','blacklist','maxClients','address','port'
    )
)
$bytes = [System.IO.File]::ReadAllBytes($Exe)
$ascii = [System.Text.Encoding]::GetEncoding(28591).GetString($bytes)

"{0,-34} {1,-10} {2,-12} {3}" -f 'KEY', 'as "key"', 'as bare', 'offsets (first 3, quoted-preferring)'
"-" * 100
foreach ($k in $Keys) {
    $quoted = '"' + $k + '"'
    $qHits = New-Object System.Collections.Generic.List[int]
    $i = $ascii.IndexOf($quoted)
    while ($i -ge 0 -and $qHits.Count -lt 3) { $qHits.Add($i); $i = $ascii.IndexOf($quoted, $i + 1) }

    $bHits = New-Object System.Collections.Generic.List[int]
    $i = $ascii.IndexOf($k)
    while ($i -ge 0 -and $bHits.Count -lt 3) { $bHits.Add($i); $i = $ascii.IndexOf($k, $i + 1) }

    $off = if ($qHits.Count) { ($qHits | ForEach-Object { $_.ToString('X') }) -join ' ' }
           elseif ($bHits.Count) { ($bHits | ForEach-Object { $_.ToString('X') }) -join ' ' }
           else { '' }
    "{0,-34} {1,-10} {2,-12} {3}" -f $k, $qHits.Count, $bHits.Count, $off
}
