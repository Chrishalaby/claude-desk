# claude-desk client installer (Windows PowerShell 5.1+)
#   $env:CLAUDE_DESK_TOKEN='<hook-token>'; irm https://<your-hub>/install.ps1 | iex
# Installs %USERPROFILE%\.claude-desk\hook.ps1, writes config.json and adds the hooks to
# %USERPROFILE%\.claude\settings.json (backed up first; safe to re-run; removes older claude-desk entries).
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$Hub = if ($env:CLAUDE_DESK_HUB) { $env:CLAUDE_DESK_HUB } else { '__HUB_URL__' }
$Token = $env:CLAUDE_DESK_TOKEN
function Say($m) { Write-Host "> $m" -ForegroundColor DarkYellow }
function Die($m) { Write-Host "x $m" -ForegroundColor Red; throw $m }

if ($Hub -like ('*__HUB' + '_URL__*')) { Die "Hub URL unknown. Run it from your hub (see its 'Claude Code' page) or set `$env:CLAUDE_DESK_HUB." }
if (-not $Token) { Die "Missing token. Run: `$env:CLAUDE_DESK_TOKEN='<token>'; irm $Hub/install.ps1 | iex" }
$Hub = $Hub.TrimEnd('/')

$Dir = Join-Path $env:USERPROFILE '.claude-desk'
$Settings = Join-Path $env:USERPROFILE '.claude\settings.json'
$Utf8 = New-Object Text.UTF8Encoding $false

Say "Installing hook into $Dir"
New-Item -ItemType Directory -Force -Path $Dir | Out-Null
$HookPath = Join-Path $Dir 'hook.ps1'
Invoke-WebRequest -UseBasicParsing -Uri "$Hub/client/hook.ps1" -OutFile $HookPath
[IO.File]::WriteAllText((Join-Path $Dir 'config.json'), (@{ hub = $Hub; token = $Token } | ConvertTo-Json), $Utf8)

Say "Adding hooks to $Settings"
$HookCmd = 'powershell.exe -NoProfile -ExecutionPolicy Bypass -File "' + ($HookPath -replace '\\', '/') + '"'
if (Test-Path $Settings) {
  $raw = Get-Content $Settings -Raw
  Copy-Item $Settings ($Settings + '.bak-claude-desk-' + (Get-Date -Format 'yyyyMMddHHmmss'))
  $cfg = if ($raw -and $raw.Trim()) { $raw | ConvertFrom-Json } else { New-Object PSObject }
} else {
  New-Item -ItemType Directory -Force -Path (Split-Path $Settings) | Out-Null
  $cfg = New-Object PSObject
}
if (-not $cfg.PSObject.Properties['hooks']) { $cfg | Add-Member -NotePropertyName hooks -NotePropertyValue (New-Object PSObject) }

$events = [ordered]@{ UserPromptSubmit = $null; PermissionRequest = '*'; PostToolUse = '*'; Notification = '*'; Stop = $null; SessionEnd = $null }
# drop earlier claude-desk entries everywhere
foreach ($p in @($cfg.hooks.PSObject.Properties)) {
  $kept = @($p.Value | Where-Object { -not (@($_.hooks | ForEach-Object { [string]$_.command }) -match 'claude-desk') })
  if ($kept.Count) { $cfg.hooks.($p.Name) = $kept } else { $cfg.hooks.PSObject.Properties.Remove($p.Name) }
}
foreach ($ev in $events.Keys) {
  $group = [ordered]@{}
  if ($events[$ev]) { $group.matcher = $events[$ev] }
  $group.hooks = @([ordered]@{ type = 'command'; command = $HookCmd; async = $true; timeout = 5 })
  $list = @()
  if ($cfg.hooks.PSObject.Properties[$ev]) { $list = @($cfg.hooks.$ev) }
  $list += [pscustomobject]$group
  if ($cfg.hooks.PSObject.Properties[$ev]) { $cfg.hooks.$ev = $list } else { $cfg.hooks | Add-Member -NotePropertyName $ev -NotePropertyValue $list }
}
[IO.File]::WriteAllText($Settings, ($cfg | ConvertTo-Json -Depth 50), $Utf8)

$NoAgent = if ($env:CLAUDE_DESK_NO_AGENT) { $env:CLAUDE_DESK_NO_AGENT } else { $env:CLAUDE_DESK_NO_MUSIC }
if ($NoAgent -ne '1') {
  try {
    $AgentPath = Join-Path $Dir 'agent.ps1'
    $Startup = [Environment]::GetFolderPath('Startup')
    Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'claude-desk.(agent|nowplaying)\.ps1' } |
      ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Startup 'claude-desk-nowplaying.lnk'), (Join-Path $Dir 'nowplaying.ps1')
    Invoke-WebRequest -UseBasicParsing -Uri "$Hub/client/agent.ps1" -OutFile $AgentPath
    $Conhost = Join-Path $env:WINDIR 'System32\conhost.exe'
    $AgentArgs = '--headless powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File "' + $AgentPath + '"'
    $Lnk = (New-Object -ComObject WScript.Shell).CreateShortcut((Join-Path $Startup 'claude-desk-agent.lnk'))
    $Lnk.TargetPath = $Conhost
    $Lnk.Arguments = $AgentArgs
    $Lnk.WindowStyle = 7
    $Lnk.Save()
    Start-Process -FilePath $Conhost -ArgumentList $AgentArgs -WindowStyle Hidden
    Say "Your PC now feeds the desk: what's playing (any app or browser), when you're away, and your"
    Say 'Outlook calendar while Outlook is open.'
  } catch {
    Say "Couldn't set up the computer agent ($($_.Exception.Message)). The hook still works."
  }
}

Say "Testing connection to $Hub"
try {
  Invoke-RestMethod -Uri "$Hub/api/hook" -Method Post -ContentType 'application/json' `
    -Headers @{ Authorization = "Bearer $Token" } -Body '{"e":"Stop","sid":"install-test","project":"claude-desk"}' -TimeoutSec 10 | Out-Null
  Say 'Done. Your desk should show DONE - claude-desk for a few seconds.'
  Say 'Restart any open Claude Code sessions to pick up the hooks.'
} catch {
  Die "Hub test failed: $($_.Exception.Message). Check the token (regenerate it on the hub's Claude Code page) and re-run."
}
