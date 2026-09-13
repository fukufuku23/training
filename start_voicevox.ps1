<#
  start_voicevox.ps1 — 公開版から使える設定で VOICEVOX エンジンを起動する

  VOICEVOX の既定の CORS 設定（localapps）は app:// と localhost しか許可しない。
  そのため https://<ユーザー名>.github.io からは弾かれる。
  --allow_origin で公開URLを追加して起動すると、公開版からも使えるようになる。

  許可するオリジンは git remote から自動で組み立てるので、設定を書く必要はない。

  使い方:
    start_voicevox.bat                     エンジンを起動
    start_voicevox.bat -CheckOnly          起動せず、現在の接続可否だけ調べる
    start_voicevox.bat -EnginePath D:\VOICEVOX
                                           インストール先を明示（初回だけでよい）

  うまくいかないときは、同じフォルダに出る次のログを見る:
    start_voicevox.log    このスクリプトの全出力
    engine.*.out.log      エンジンの標準出力
    engine.*.err.log      エンジンのエラー出力
    engine.help.log       エンジンが受け付けるオプション一覧
#>
[CmdletBinding()]
param(
  [switch]$CheckOnly,
  [string]$EnginePath
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$PORT = 50021
$CONFIG = Join-Path $PSScriptRoot 'start_voicevox.local.txt'
$LOG = Join-Path $PSScriptRoot 'start_voicevox.log'

try { Start-Transcript -LiteralPath $LOG -Force | Out-Null } catch { }

function Note($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Done($code) {
  Note "`nログ: $LOG"
  try { Stop-Transcript | Out-Null } catch { }
  Read-Host "`nEnter で終了" | Out-Null
  exit $code
}
function Fail($m) { Write-Host "`n[エラー] $m" -ForegroundColor Red; Done 1 }

Note "実行日時: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Note "PowerShell: $($PSVersionTable.PSVersion)"

# ------------------------------------------------ 許可するオリジンを git から導出
$origin = $null
try {
  $remote = (git config --get remote.origin.url) 2>$null
  if ($remote) {
    $slug = $remote -replace '^https://github\.com/', '' -replace '^git@github\.com:', '' -replace '\.git$', ''
    $p = $slug.Split('/')
    if ($p.Count -ge 2) { $origin = "https://$($p[0]).github.io" }
  }
} catch { }
if (-not $origin) { Fail "git remote から公開URLを判定できませんでした。リポジトリ内で実行してください。" }

Note "---------------------------------------------------------------"
Note "  許可するオリジン : $origin"
Note "  エンジンのポート : $PORT"
Note "---------------------------------------------------------------`n"

# ------------------------------------------------------------- 現状の確認
function Test-Port {
  $c = New-Object System.Net.Sockets.TcpClient
  try { $c.Connect('127.0.0.1', $PORT); return $true } catch { return $false } finally { $c.Dispose() }
}

# 起動中のエンジンが、すでに公開オリジンを許可しているかを調べる。
# CORS は「レスポンスに Access-Control-Allow-Origin が付くか」で判定できる。
function Test-OriginAllowed {
  try {
    $r = Invoke-WebRequest -Uri "http://127.0.0.1:$PORT/version" `
      -Headers @{ Origin = $origin } -UseBasicParsing -TimeoutSec 5
    return [bool]$r.Headers['Access-Control-Allow-Origin']
  } catch { return $false }
}

if (Test-Port) {
  if (Test-OriginAllowed) {
    Note "すでにエンジンが起動していて、$origin からの接続も許可されています。" Green
    Done 0
  }
  Note "ポート $PORT は使用中ですが、$origin は許可されていません。" Yellow
  Note "VOICEVOX（GUI）が起動している場合は終了してから、もう一度実行してください。"
  Done 1
}

Note "ポート $PORT は空いています（エンジンは起動していません）。"
if ($CheckOnly) { Done 0 }

# --------------------------------------------------------- エンジンを探す
# 与えられたパスが run.exe そのものでも、インストールフォルダでも受け付ける。
function Resolve-RunExe([string]$path) {
  if (-not $path) { return $null }
  $path = $path.Trim([char]0xFEFF, ' ', "`t", "`r", "`n")
  if (-not $path) { return $null }
  if (-not (Test-Path -LiteralPath $path)) { return $null }
  if ((Get-Item -LiteralPath $path) -is [System.IO.FileInfo]) { return $path }
  foreach ($sub in @('vv-engine\run.exe', 'run.exe')) {
    $c = Join-Path $path $sub
    if (Test-Path -LiteralPath $c) { return $c }
  }
  return $null
}

$tried = New-Object System.Collections.Generic.List[string]

function Find-Engine {
  if ($EnginePath) {
    $r = Resolve-RunExe $EnginePath
    if ($r) { return $r }
    Fail "指定された場所に run.exe が見つかりません: $EnginePath"
  }
  $r = Resolve-RunExe $env:VOICEVOX_ENGINE
  if ($r) { return $r }
  if (Test-Path -LiteralPath $CONFIG) {
    $r = Resolve-RunExe ((Get-Content -LiteralPath $CONFIG -Raw))
    if ($r) { return $r }
  }
  $roots = @("$env:LOCALAPPDATA\Programs", $env:ProgramFiles, "${env:ProgramFiles(x86)}")
  foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
    if ($d.DriveType -ne 'Fixed' -or -not $d.IsReady) { continue }
    $roots += $d.RootDirectory.FullName.TrimEnd('\')
    $roots += (Join-Path $d.RootDirectory.FullName 'Program Files').TrimEnd('\')
    $roots += (Join-Path $d.RootDirectory.FullName 'Program Files (x86)').TrimEnd('\')
  }
  foreach ($root in ($roots | Where-Object { $_ } | Select-Object -Unique)) {
    foreach ($sub in @('VOICEVOX\vv-engine\run.exe', 'VOICEVOX\run.exe')) {
      $c = Join-Path $root $sub
      $tried.Add($c) | Out-Null
      if (Test-Path -LiteralPath $c) { return $c }
    }
  }
  Note "既定の場所に見つからないため、検索します（少し時間がかかります）..." Yellow
  foreach ($d in [System.IO.DriveInfo]::GetDrives()) {
    if ($d.DriveType -ne 'Fixed' -or -not $d.IsReady) { continue }
    $dirs = Get-ChildItem -LiteralPath $d.RootDirectory.FullName -Directory -Filter 'VOICEVOX*' `
      -Depth 3 -ErrorAction SilentlyContinue
    foreach ($dir in $dirs) {
      $r = Resolve-RunExe $dir.FullName
      if ($r) { return $r }
    }
  }
  return $null
}

$engine = Find-Engine
if (-not $engine) {
  Note "探した場所:" Yellow
  $tried | Select-Object -First 12 | ForEach-Object { Note "  $_" }
  Fail ("VOICEVOX のエンジン（run.exe）が見つかりませんでした。`n" +
        "        例: start_voicevox.bat -EnginePath D:\VOICEVOX")
}

try { Set-Content -LiteralPath $CONFIG -Value $engine -Encoding ASCII } catch { }

$engineDir = Split-Path -Parent $engine
Note "エンジン: $engine"
Note "作業フォルダ: $engineDir`n"

# --------------------------------------------------------- 起動する
# 出力をログに落とす。起動に失敗したとき、理由はほぼ必ずここに出る。
function Start-Engine([string[]]$argv, [string]$tag) {
  $out = Join-Path $PSScriptRoot "engine.$tag.out.log"
  $err = Join-Path $PSScriptRoot "engine.$tag.err.log"
  Remove-Item -LiteralPath $out, $err -ErrorAction SilentlyContinue
  Note "起動コマンド: `"$engine`" $($argv -join ' ')"
  return @{
    Proc = (Start-Process -FilePath $engine -ArgumentList $argv `
              -WorkingDirectory $engineDir -PassThru `
              -RedirectStandardOutput $out -RedirectStandardError $err -NoNewWindow)
    Out = $out; Err = $err
  }
}

function Show-Log([string]$path, [string]$label) {
  if (-not (Test-Path -LiteralPath $path)) { return }
  $txt = (Get-Content -LiteralPath $path -Raw -ErrorAction SilentlyContinue)
  if (-not $txt -or -not $txt.Trim()) { return }
  Note "`n--- $label ---" Yellow
  ($txt -split "`n" | Select-Object -Last 25) | ForEach-Object { Note "  $_" }
}

# 起動待ち。初回はモデル読み込みで時間がかかるため長めに待つ。
function Wait-Engine($h, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  $t0 = Get-Date
  Write-Host "起動待ち" -NoNewline
  while ((Get-Date) -lt $deadline) {
    if ($h.Proc.HasExited) {
      Write-Host ""
      Note "エンジンが $([int]((Get-Date)-$t0).TotalSeconds) 秒で終了しました（終了コード $($h.Proc.ExitCode)）。" Red
      return 'exited'
    }
    Start-Sleep -Milliseconds 800
    # 括弧で囲まないと Test-Port に "-and" という引数を渡す解釈になる
    if (Test-Port) {
      Write-Host ""
      Note "ポートが開きました（$([int]((Get-Date)-$t0).TotalSeconds) 秒）。" Green
      return $(if (Test-OriginAllowed) { 'ok' } else { 'nocors' })
    }
    Write-Host "." -NoNewline
  }
  Write-Host ""
  return 'timeout'
}

$h = Start-Engine @('--allow_origin', $origin) 'allow_origin'
$result = Wait-Engine $h 180

if ($result -eq 'exited') {
  Show-Log $h.Err 'エンジンのエラー出力'
  Show-Log $h.Out 'エンジンの標準出力'

  # オプションが受け付けられなかった可能性を切り分ける
  Note "`n受け付けるオプションを確認しています..." Yellow
  $help = Join-Path $PSScriptRoot 'engine.help.log'
  try {
    Start-Process -FilePath $engine -ArgumentList @('--help') -WorkingDirectory $engineDir `
      -RedirectStandardOutput $help -RedirectStandardError "$help.err" -NoNewWindow -Wait
    Show-Log $help 'エンジンのオプション一覧'
  } catch { Note "  取得できませんでした: $_" }

  Note "`n--allow_origin なしでも起動しないか試します..." Yellow
  $h2 = Start-Engine @() 'plain'
  $r2 = Wait-Engine $h2 180
  if ($r2 -eq 'ok' -or $r2 -eq 'nocors') {
    Note "`n素の起動は成功しました。--allow_origin が原因です。" Yellow
    Note "engine.help.log のオプション名を確認してください。"
    Note "ローカル版（http://localhost:8080）からならこのまま使えます。" Green
    Note "`n終了するには、このウィンドウを閉じるか Ctrl+C を押してください。"
    try { Stop-Transcript | Out-Null } catch { }
    try { Wait-Process -Id $h2.Proc.Id } catch { }
    exit 0
  }
  Show-Log $h2.Err 'エンジンのエラー出力（素の起動）'
  Fail "エンジン自体が起動しませんでした。上のログを確認してください。"
}

if ($result -eq 'timeout') {
  Note "180秒待ちましたが、ポートが開きませんでした。" Yellow
  Show-Log $h.Err 'エンジンのエラー出力'
  Show-Log $h.Out 'エンジンの標準出力'
  try { $h.Proc.Kill() } catch { }
  Fail "起動を確認できませんでした。"
}

if ($result -eq 'nocors') {
  Note "`nエンジンは起動しましたが、$origin は許可されていません。" Yellow
  Note "engine.help.log / engine.allow_origin.out.log を確認してください。"
  Note "ローカル版（http://localhost:8080）からなら利用できます。" Green
} else {
  Note "`n起動しました。$origin から利用できます。" Green
}

Note ""
Note "ブラウザ側の許可が必要な場合があります（Chrome 142 以降）:" Yellow
Note "  アドレスバー左のアイコン → サイトの設定 → ローカルネットワーク → 許可"
Note "`nログ: $LOG"
Note "終了するには、このウィンドウを閉じるか Ctrl+C を押してください。"
try { Stop-Transcript | Out-Null } catch { }
try { Wait-Process -Id $h.Proc.Id } catch { }
