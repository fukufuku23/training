<#
  start_voicevox.ps1 — 公開版から使える設定で VOICEVOX エンジンを起動する

  VOICEVOX の既定の CORS 設定（localapps）は app:// と localhost しか許可しない。
  そのため https://<ユーザー名>.github.io からは弾かれる。
  --allow_origin で公開URLを追加して起動すると、公開版からも使えるようになる。

  許可するオリジンは git remote から自動で組み立てるので、設定を書く必要はない。

  使い方:
    start_voicevox.bat            エンジンを起動（このウィンドウが動いている間だけ有効）
    start_voicevox.bat -CheckOnly 起動せず、現在の接続可否だけ調べる
#>
[CmdletBinding()]
param([switch]$CheckOnly)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot
$PORT = 50021

function Note($m, $c = 'Gray') { Write-Host $m -ForegroundColor $c }
function Fail($m) { Write-Host "[エラー] $m" -ForegroundColor Red; Read-Host "Enter で終了"; exit 1 }

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
$candidates = @(
  "$env:LOCALAPPDATA\Programs\VOICEVOX\vv-engine\run.exe",   # v0.16 以降
  "$env:LOCALAPPDATA\Programs\VOICEVOX\run.exe",             # v0.15 以前
  "$env:ProgramFiles\VOICEVOX\vv-engine\run.exe",
  "${env:ProgramFiles(x86)}\VOICEVOX\vv-engine\run.exe"
)
$engine = $candidates | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

if (-not $engine) {
  Note "既定の場所に見つからないため、検索します..." Yellow
  foreach ($root in @("$env:LOCALAPPDATA\Programs", $env:ProgramFiles, "${env:ProgramFiles(x86)}")) {
    if (-not $root -or -not (Test-Path -LiteralPath $root)) { continue }
    $found = Get-ChildItem -LiteralPath $root -Filter 'run.exe' -Recurse -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -like '*VOICEVOX*' } | Select-Object -First 1
    if ($found) { $engine = $found.FullName; break }
  }
}
if (-not $engine) {
  Fail "VOICEVOX のエンジン（run.exe）が見つかりませんでした。`n        インストール先を確認してください。"
}

Note "エンジン: $engine"
Note "起動しています... （このウィンドウを閉じるとエンジンも止まります）`n" Yellow

# --allow_origin は既定の許可（localhost など）に追加する形で働くため、
# ローカル運用と公開版のどちらからでも使えるようになる。
$proc = Start-Process -FilePath $engine `
  -ArgumentList @('--allow_origin', $origin) `
  -PassThru -NoNewWindow

# ---------------------------------------------------- 起動を待って結果を出す
$deadline = (Get-Date).AddSeconds(60)
$ok = $false
Write-Host "起動待ち" -NoNewline
while ((Get-Date) -lt $deadline) {
  Start-Sleep -Milliseconds 800
  # 括弧で囲まないと Test-Port に "-and" という引数を渡す解釈になる
  if ((Test-Port) -and (Test-OriginAllowed)) { $ok = $true; break }
  Write-Host "." -NoNewline
}
Write-Host ""

if ($ok) {
  Note "`n起動しました。$origin から利用できます。" Green
  Note "公開版のページを開き直すと VOICEVOX が使えるようになります。"
} else {
  Note "`n[警告] 起動を確認できませんでした。エンジンのログを確認してください。" Yellow
}

Note "`n終了するには、このウィンドウを閉じるか Ctrl+C を押してください。"
try { Wait-Process -Id $proc.Id } catch { }
