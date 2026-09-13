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
                                           インストール先を明示（初回だけでよい。
                                           見つかった場所は記憶される）

  補足: Chrome 142 以降、公開サイトから 127.0.0.1 への接続には
        「ローカルネットワークへのアクセス」の許可がブラウザ側で必要。
        エンジンが起動していても、ブラウザで許可しないと繋がらない。
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

function Note($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Fail($m) { Write-Host "`n[エラー] $m" -ForegroundColor Red; Read-Host "`nEnter で終了"; exit 1 }

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
    Note "このまま公開版で利用できます。"
    Note "`n繋がらない場合はブラウザ側の許可を確認してください:"
    Note "  アドレスバー左のアイコン → サイトの設定 → ローカルネットワーク → 許可"
    if (-not $CheckOnly) { Read-Host "`nEnter で終了" }
    exit 0
  }
  Note "ポート $PORT は使用中ですが、$origin は許可されていません。" Yellow
  Note "VOICEVOX（GUI）が起動している場合は終了してから、もう一度実行してください。"
  Note "GUI のエンジンは既定設定のため、公開版からは接続できません。"
  Read-Host "`nEnter で終了"
  exit 1
}

if ($CheckOnly) { Note "エンジンは起動していません。" Yellow; Read-Host "`nEnter で終了"; exit 0 }

# --------------------------------------------------------- エンジンを探す
# 与えられたパスが run.exe そのものでも、インストールフォルダでも受け付ける。
function Resolve-RunExe([string]$path) {
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
  # 1) 明示指定
  if ($EnginePath) {
    $r = Resolve-RunExe $EnginePath
    if ($r) { return $r }
    Fail "指定された場所に run.exe が見つかりません: $EnginePath"
  }
  # 2) 環境変数
  $r = Resolve-RunExe $env:VOICEVOX_ENGINE
  if ($r) { return $r }
  # 3) 前回見つかった場所（記憶）
  if (Test-Path -LiteralPath $CONFIG) {
    $saved = (Get-Content -LiteralPath $CONFIG -Raw).Trim()
    $r = Resolve-RunExe $saved
    if ($r) { return $r }
  }
  # 4) よくあるインストール先。固定ドライブすべてを見る（D:\VOICEVOX なども拾う）
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
  # 5) 最後の手段: 固定ドライブの浅い階層から VOICEVOX フォルダを探す
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
        "        インストール先を指定して実行してください。例:`n" +
        "          start_voicevox.bat -EnginePath D:\VOICEVOX")
}

# 次回以降のために記憶しておく（このファイルは .gitignore 済み）
try { Set-Content -LiteralPath $CONFIG -Value $engine -Encoding UTF8 } catch { }

Note "エンジン: $engine"
Note "起動しています... （このウィンドウを閉じるとエンジンも止まります）`n" Yellow

# --allow_origin は既定の許可（localhost など）に追加する形で働くため、
# ローカル運用と公開版のどちらからでも使えるようになる。
$proc = Start-Process -FilePath $engine `
  -ArgumentList @('--allow_origin', $origin) `
  -WorkingDirectory (Split-Path -Parent $engine) `
  -PassThru -NoNewWindow

# ---------------------------------------------------- 起動を待って結果を出す
$deadline = (Get-Date).AddSeconds(90)
$ok = $false
Write-Host "起動待ち" -NoNewline
while ((Get-Date) -lt $deadline) {
  if ($proc.HasExited) { Write-Host ""; Fail "エンジンが起動直後に終了しました（終了コード $($proc.ExitCode)）。" }
  Start-Sleep -Milliseconds 800
  # 括弧で囲まないと Test-Port に "-and" という引数を渡す解釈になる
  if ((Test-Port) -and (Test-OriginAllowed)) { $ok = $true; break }
  Write-Host "." -NoNewline
}
Write-Host ""

if ($ok) {
  Note "`n起動しました。$origin から利用できます。" Green
  Note ""
  Note "ブラウザ側でもう1つ許可が要ります（Chrome 142 以降）:" Yellow
  Note "  公開版のページを開き直すと「ローカルネットワークに接続しようとしています」と"
  Note "  聞かれるので「許可」を選んでください。"
  Note "  出ない場合: アドレスバー左のアイコン → サイトの設定 → ローカルネットワーク → 許可"
} else {
  Note "`n[警告] 起動を確認できませんでした。エンジンのログを確認してください。" Yellow
}

Note "`n終了するには、このウィンドウを閉じるか Ctrl+C を押してください。"
try { Wait-Process -Id $proc.Id } catch { }
