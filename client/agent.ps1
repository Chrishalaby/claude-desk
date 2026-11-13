$ErrorActionPreference = 'SilentlyContinue'
$mutex = New-Object Threading.Mutex($false, 'claude-desk-agent')
if (-not $mutex.WaitOne(0)) { exit 0 }
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$ConfigPath = Join-Path $env:USERPROFILE '.claude-desk\config.json'
$AwaySecs = 600
$Dir = Join-Path $env:USERPROFILE '.claude-desk'
$UpdateEvery = 6 * 3600
$checked = (Get-Date).AddSeconds(600 - $UpdateEvery)

function SelfUpdate($cfg) {
  $hub = ([string]$cfg.hub).TrimEnd('/')
  if (-not $hub.StartsWith('https://')) { return $false }
  $restart = $false
  foreach ($f in @(@('hook.ps1', '/api/hook'), @('agent.ps1', '/api/computer'))) {
    try {
      $path = Join-Path $Dir $f[0]
      $tmp = $path + '.new'
      Invoke-WebRequest -UseBasicParsing -Uri "$hub/client/$($f[0])" -OutFile $tmp -TimeoutSec 20
      $new = [IO.File]::ReadAllText($tmp)
      $old = if (Test-Path $path) { [IO.File]::ReadAllText($path) } else { '' }
      $errs = $null
      $null = [System.Management.Automation.Language.Parser]::ParseInput($new, [ref]$null, [ref]$errs)
      if ($new -eq $old -or $new.Length -lt 500 -or -not $new.Contains($f[1]) -or ($errs -and $errs.Count)) {
        Remove-Item -Force $tmp
        continue
      }
      Move-Item -Force $tmp $path
      if ($f[0] -eq 'agent.ps1') { $restart = $true }
    } catch { Remove-Item -Force -ErrorAction SilentlyContinue $tmp }
  }
  $restart
}

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

$NotifOk = $false
try {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
public static class DeskNotif {
  [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_open_v2")] static extern int Open(byte[] file, out IntPtr db, int flags, IntPtr vfs);
  [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_close")] static extern int Close(IntPtr db);
  [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_busy_timeout")] static extern int Busy(IntPtr db, int ms);
  [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_prepare_v2")] static extern int Prepare(IntPtr db, byte[] sql, int n, out IntPtr stmt, IntPtr tail);
  [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_step")] static extern int Step(IntPtr stmt);
  [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_finalize")] static extern int Fin(IntPtr stmt);
  [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_column_blob")] static extern IntPtr Blob(IntPtr stmt, int col);
  [DllImport("winsqlite3.dll", EntryPoint = "sqlite3_column_bytes")] static extern int Bytes(IntPtr stmt, int col);
  static string Col(IntPtr stmt, int col, int max) {
    int n = Math.Min(Bytes(stmt, col), max);
    IntPtr p = Blob(stmt, col);
    if (n <= 0 || p == IntPtr.Zero) return "";
    byte[] b = new byte[n];
    Marshal.Copy(p, b, 0, n);
    return Encoding.UTF8.GetString(b);
  }
  public static List<string[]> Read(string path) {
    var rows = new List<string[]>();
    IntPtr db;
    if (Open(Encoding.UTF8.GetBytes(path + "\0"), out db, 1, IntPtr.Zero) != 0) { Close(db); return null; }
    try {
      Busy(db, 500);
      IntPtr st;
      byte[] sql = Encoding.UTF8.GetBytes("SELECT h.PrimaryId, n.Type, n.Payload FROM Notification n JOIN NotificationHandler h ON h.RecordId = n.HandlerId WHERE n.Type IN ('toast','badge')\0");
      if (Prepare(db, sql, -1, out st, IntPtr.Zero) != 0) return null;
      while (Step(st) == 100 && rows.Count < 2000) rows.Add(new string[] { Col(st, 0, 300), Col(st, 1, 20), Col(st, 2, 400) });
      Fin(st);
    } finally { Close(db); }
    return rows;
  }
}
'@
  $NotifOk = $true
} catch {}

$NotifApps = @(@('whatsapp', 'WhatsApp'), @('slack', 'Slack'), @('discord', 'Discord'), @('teams', 'Teams'), @('telegram', 'Telegram'),
  @('messenger', 'Messenger'), @('outlook|windowscommunicationsapps', 'Outlook'), @('signal', 'Signal'))

function Badges {
  if (-not $NotifOk) { return $null }
  $src = Join-Path $env:LOCALAPPDATA 'Microsoft\Windows\Notifications\wpndatabase.db'
  if (-not (Test-Path $src)) { return $null }
  $rows = $null
  try { $rows = [DeskNotif]::Read($src) } catch {}
  if ($null -eq $rows) {
    try {
      $tmp = Join-Path $env:TEMP 'claude-desk-wpn.db'
      foreach ($ext in '', '-wal', '-shm') { if (Test-Path ($src + $ext)) { Copy-Item -Force ($src + $ext) ($tmp + $ext) } }
      $rows = [DeskNotif]::Read($tmp)
    } catch {}
  }
  if ($null -eq $rows) { return $null }
  $toasts = @{}
  $badge = @{}
  foreach ($r in $rows) {
    $name = $null
    foreach ($a in $NotifApps) { if ($r[0] -match $a[0]) { $name = $a[1]; break } }
    if (-not $name) { continue }
    if ($r[1] -eq 'badge') { if ($r[2] -match 'value="(\d+)"') { $badge[$name] = [int]$Matches[1] } }
    else { $toasts[$name] = 1 + [int]$toasts[$name] }
  }
  $out = @{}
  foreach ($n in @($toasts.Keys) + @($badge.Keys)) {
    $v = if ($badge.ContainsKey($n) -and $badge[$n] -gt 0) { $badge[$n] } else { [int]$toasts[$n] }
    if ($v -gt 0) { $out[$n] = $v }
  }
  $out
}

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
$badges = $null
$badgesAt = [DateTime]::MinValue
while ($true) {
  $now = Get-Date
  if ($now -lt $pauseUntil) { Start-Sleep -Seconds 60; continue }
  $cfg = $null
  try { $cfg = Get-Content $ConfigPath -Raw | ConvertFrom-Json } catch {}
  if (-not $cfg) { Start-Sleep -Seconds 60; continue }
  if (($now - $checked).TotalSeconds -ge $UpdateEvery) {
    $checked = $now
    if (SelfUpdate $cfg) {
      $mutex.ReleaseMutex()
      $mutex.Dispose()
      $self = '--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + (Join-Path $Dir 'agent.ps1') + '"'
      Start-Process -FilePath (Join-Path $env:WINDIR 'System32\conhost.exe') -ArgumentList $self -WindowStyle Hidden
      exit 0
    }
  }
  $body = Media
  $body.os = 'windows'
  $idle = [DeskIdle]::Seconds()
  if ($idle -ge 0) { $body.away = ($idle -ge $AwaySecs) }
  if (($now - $eventsCheckedAt).TotalSeconds -ge 300) { $events = OutlookEvents; $eventsCheckedAt = $now }
  if ($null -ne $events) { $body.calendar = 'ok' }
  if (($now - $badgesAt).TotalSeconds -ge 20) { $badges = Badges; $badgesAt = $now }
  if ($null -ne $badges) { $body.badges = $badges }
  $bk = if ($null -ne $badges) { ($badges.GetEnumerator() | Sort-Object Name | ForEach-Object { "$($_.Name):$($_.Value)" }) -join ',' } else { '' }
  $key = (($body.GetEnumerator() | Where-Object { $_.Name -ne 'badges' } | Sort-Object Name | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join '|') + '#' + $bk
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
