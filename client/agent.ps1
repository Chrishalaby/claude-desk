$ErrorActionPreference = 'SilentlyContinue'
$mutex = New-Object Threading.Mutex($false, 'claude-desk-agent')
if (-not $mutex.WaitOne(0)) { exit 0 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ConfigPath = Join-Path $env:USERPROFILE '.claude-desk\config.json'
$AwaySecs = 600

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class DeskIdle {
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size; public uint Time; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput info);
  public static long Seconds() {
    var i = new LastInput();
    i.Size = (uint)Marshal.SizeOf(i);
    if (!GetLastInputInfo(ref i)) return -1;
    return (long)(((uint)Environment.TickCount - i.Time) / 1000);
  }
}
'@

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

function Media {
  if (-not $Manager) { return @{ playing = $false; error = 'unsupported' } }
  foreach ($s in @($Manager.GetSessions())) {
    if ([string]$s.GetPlaybackInfo().PlaybackStatus -ne 'Playing') { continue }
    $p = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
    if (-not $p -or -not $p.Title) { continue }
    return @{ playing = $true; title = [string]$p.Title; artist = [string]$p.Artist; app = (AppName $s.SourceAppUserModelId) }
  }
  @{ playing = $false }
}

function OutlookEvents {
  $ol = $null
  try { $ol = [Runtime.InteropServices.Marshal]::GetActiveObject('Outlook.Application') } catch { return $null }
  if (-not $ol) { return $null }
  $from = (Get-Date).AddHours(-1)
  $to = (Get-Date).AddHours(36)
  $items = $ol.Session.GetDefaultFolder(9).Items
  $items.IncludeRecurrences = $true
  $items.Sort('[Start]')
  $found = $items.Restrict("[Start] < '" + $to.ToString('g') + "' AND [End] > '" + $from.ToString('g') + "'")
  $list = New-Object System.Collections.ArrayList
  foreach ($i in $found) {
    if ($list.Count -ge 50) { break }
    if ($i.AllDayEvent) { continue }
    $null = $list.Add([ordered]@{
      t = [string]$i.Subject
      s = ([DateTimeOffset]$i.Start).ToUnixTimeSeconds()
      e = ([DateTimeOffset]$i.End).ToUnixTimeSeconds()
      l = [string]$i.Location
    })
  }
  , $list.ToArray()
}

$last = ''
$sentAt = [DateTime]::MinValue
$pauseUntil = [DateTime]::MinValue
$events = $null
$eventsCheckedAt = [DateTime]::MinValue
$eventsKey = ''
$eventsSentAt = [DateTime]::MinValue
while ($true) {
  $now = Get-Date
  if ($now -lt $pauseUntil) { Start-Sleep -Seconds 60; continue }
  $cfg = $null
  try { $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch {}
  if (-not $cfg) { Start-Sleep -Seconds 60; continue }
  $body = Media
  $body.os = 'windows'
  $idle = [DeskIdle]::Seconds()
  if ($idle -ge 0) { $body.away = ($idle -ge $AwaySecs) }
  if (($now - $eventsCheckedAt).TotalSeconds -ge 300) { $events = OutlookEvents; $eventsCheckedAt = $now }
  if ($null -ne $events) { $body.calendar = 'ok' }
  $key = ($body.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '|'
  $ek = if ($null -ne $events) { ($events | ConvertTo-Json -Compress -Depth 4) } else { '' }
  $sendEvents = ($null -ne $events) -and ($ek -ne $eventsKey -or ($now - $eventsSentAt).TotalSeconds -ge 600)
  $every = if ($body.playing) { 60 } else { 120 }
  if ($key -ne $last -or $sendEvents -or ($now - $sentAt).TotalSeconds -ge $every) {
    $out = @{} + $body
    if ($body.away) { $out.idle = $idle }
    if ($sendEvents) { $out.events = @($events) }
    try {
      $json = [Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Compress -Depth 5))
      Invoke-RestMethod -Uri ($cfg.hub.TrimEnd('/') + '/api/computer') -Method Post -Body $json `
        -ContentType 'application/json' -Headers @{ Authorization = "Bearer $($cfg.token)" } -TimeoutSec 15 | Out-Null
      $last = $key
      $sentAt = $now
      if ($sendEvents) { $eventsKey = $ek; $eventsSentAt = $now }
    } catch {
      if ($_.Exception.Response -and [int]$_.Exception.Response.StatusCode -eq 401) { $pauseUntil = $now.AddMinutes(10) }
    }
  }
  if ($body.playing) { Start-Sleep -Seconds 5 } else { Start-Sleep -Seconds 10 }
}
