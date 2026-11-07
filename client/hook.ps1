# claude-desk hook (Windows PowerShell 5.1+).
# Claude Code runs this for each hook event and pipes the event JSON on stdin. We keep only the
# few fields the hub needs (never tool output or file contents), POST them to your hub, and exit.
# Never prints, never fails, gives up after 2 s.  Config: %USERPROFILE%\.claude-desk\config.json
$ErrorActionPreference = 'SilentlyContinue'
try {
  [Console]::InputEncoding = [Text.Encoding]::UTF8
  [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
  $ev  = [Console]::In.ReadToEnd() | ConvertFrom-Json
  $cfg = Get-Content (Join-Path $env:USERPROFILE '.claude-desk\config.json') -Raw | ConvertFrom-Json

  $detail = ''
  $ti = $ev.tool_input
  if ($ti) {
    foreach ($k in 'command', 'file_path', 'url', 'pattern') { if ($ti.$k) { $detail = [string]$ti.$k; break } }
    if ($ti.file_path) { $detail = [IO.Path]::GetFileName([string]$ti.file_path) }
  }
  $detail = (($detail -split '\s+') -join ' ').Trim()
  if ($detail.Length -gt 60) { $detail = $detail.Substring(0, 60) }

  $cwd = ([string]$ev.cwd).TrimEnd('\', '/')
  $project = if ($cwd) { [IO.Path]::GetFileName($cwd) } else { '' }
  if (-not $project) { $project = 'claude code' }

  $out = [ordered]@{ e = [string]$ev.hook_event_name; sid = [string]$ev.session_id; project = $project }
  if ($ev.tool_name)   { $out.tool = [string]$ev.tool_name; $out.detail = $detail }
  if ($ev.tool_use_id) { $out.tid = [string]$ev.tool_use_id }
  if ($out.e -eq 'Notification') {
    $m = [string]$ev.message
    if ($m.Length -gt 80) { $m = $m.Substring(0, 80) }
    $out.ntype = [string]$ev.notification_type
    $out.msg = $m
  }
  $body = [Text.Encoding]::UTF8.GetBytes(($out | ConvertTo-Json -Compress))
  Invoke-RestMethod -Uri ($cfg.hub.TrimEnd('/') + '/api/hook') -Method Post -Body $body `
    -ContentType 'application/json' -Headers @{ Authorization = "Bearer $($cfg.token)" } -TimeoutSec 2 | Out-Null
} catch {}
exit 0
