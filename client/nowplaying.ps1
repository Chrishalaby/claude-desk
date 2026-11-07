$ErrorActionPreference = 'SilentlyContinue'
$mutex = New-Object Threading.Mutex($false, 'claude-desk-nowplaying')
if (-not $mutex.WaitOne(0)) { exit 0 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ConfigPath = Join-Path $env:USERPROFILE '.claude-desk\config.json'

Add-Type -AssemblyName System.Runtime.WindowsRuntime
$AsTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1
function Await($op, [Type]$type) {
  $task = $AsTask.MakeGenericMethod($type).Invoke($null, @($op))
  if (-not $task.Wait(10000)) { return $null }
  $task.Result
}
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties, Windows.Media.Control, ContentType = WindowsRuntime]
$Manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

function AppName([string]$id) {
  if ($id -match 'spotify') { return 'Spotify' }
  if ($id -match 'AppleMusic|AppleInc') { return 'Apple Music' }
  if ($id -match 'chrome') { return 'Chrome' }
  if ($id -match 'msedge') { return 'Edge' }
  if ($id -match 'firefox') { return 'Firefox' }
  if ($id -match 'brave') { return 'Brave' }
  if ($id -match 'ZuneMusic') { return 'Media Player' }
  (($id -split '[\\!]')[-1] -replace '\.exe$', '')
}

function Current {
  if (-not $Manager) { return @{ playing = $false; error = 'unsupported' } }
  foreach ($s in @($Manager.GetSessions())) {
    if ([string]$s.GetPlaybackInfo().PlaybackStatus -ne 'Playing') { continue }
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if (-not $p -or -not $p.Title) { continue }
    return @{ playing = $true; title = [string]$p.Title; artist = [string]$p.Artist; app = (AppName $s.SourceAppUserModelId) }
  }
  @{ playing = $false }
}

$last = ''
$sentAt = [DateTime]::MinValue
$pauseUntil = [DateTime]::MinValue
while ($true) {
  $now = Get-Date
  if ($now -lt $pauseUntil) { Start-Sleep -Seconds 60; continue }
  $cfg = $null
  try { $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch {}
  if (-not $cfg) { Start-Sleep -Seconds 60; continue }
  $body = Current
  $body.os = 'windows'
  $key = ($body.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '|'
  $every = if ($body.playing) { 60 } else { 600 }
  if ($key -ne $last -or ($now - $sentAt).TotalSeconds -ge $every) {
    try {
      $json = [Text.Encoding]::UTF8.GetBytes(($body | ConvertTo-Json -Compress))
      $r = Invoke-RestMethod -Uri ($cfg.hub.TrimEnd('/') + '/api/nowplaying') -Method Post -Body $json `
        -ContentType 'application/json' -Headers @{ Authorization = "Bearer $($cfg.token)" } -TimeoutSec 15
      if ($r.off) { $pauseUntil = $now.AddMinutes(5) }
      $last = $key
      $sentAt = $now
    } catch {
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $pauseUntil = $now.AddMinutes(10) }
    }
  }
  if ($body.playing) { Start-Sleep -Seconds 5 } else { Start-Sleep -Seconds 10 }
}
