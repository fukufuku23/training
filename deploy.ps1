<#
  deploy.ps1 — コミット → push → 公開反映を待つ → ブラウザで開く

  バッチではなく PowerShell にしている理由:
  文字列置換・ハッシュ計算・HTTP取得・パス操作が素直に書けるため。
  batch では for /f の引用符やカッコの扱いで壊れやすい。

  使い方（deploy.bat 経由でも同じ）:
    deploy.ps1                  自動メッセージでコミットして公開
    deploy.ps1 "変更内容"        メッセージを指定
    deploy.ps1 -OpenOnly        git を飛ばして公開ページを開くだけ
    deploy.ps1 -Private         シークレットウィンドウで開く（表示確認用）
#>
[CmdletBinding()]
param(
  [string]$Message,
  [switch]$OpenOnly,
  [switch]$Private
)

$ErrorActionPreference = 'Stop'
Set-Location -LiteralPath $PSScriptRoot

function Fail($msg) { Write-Host "[エラー] $msg" -ForegroundColor Red; Read-Host "Enter で終了"; exit 1 }

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail "git が見つかりません。" }

# ------------------------------------------------ 公開URLを git remote から導出
$origin = (git config --get remote.origin.url) 2>$null
if (-not $origin) { Fail "git remote が設定されていません。リポジトリ内で実行してください。" }

$slug = $origin -replace '^https://github\.com/', '' -replace '^git@github\.com:', '' -replace '\.git$', ''
$parts = $slug.Split('/')
if ($parts.Count -lt 2) { Fail "remote URL を解釈できません: $origin" }
$site = "https://$($parts[0]).github.io/$($parts[1])/"

Write-Host "---------------------------------------------------------------"
Write-Host "  公開URL : $site"
Write-Host "---------------------------------------------------------------`n"

# 照合するファイル（URL上のパス）。index.html だけだと
# app.js / style.css の変更を取りこぼすので複数見る。
$targets = @('index.html', 'js/app.js', 'css/style.css', 'js/domain.js')

function Open-Site {
  $chrome = @(
    "$env:LocalAppData\Google\Chrome\Application\chrome.exe",
    "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
    "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe"
  ) | Where-Object { $_ -and (Test-Path -LiteralPath $_) } | Select-Object -First 1

  if ($Private) {
    if ($chrome) {
      Write-Host "`nシークレットウィンドウで開きます..."
      Start-Process $chrome -ArgumentList '--incognito', $site
      Write-Host "※ シークレットでは記録が保存されません。表示確認専用です。" -ForegroundColor Yellow
      return
    }
    Write-Host "[警告] Chrome が見つからないため通常ウィンドウで開きます。" -ForegroundColor Yellow
  }
  Write-Host "`n$site を開きます"
  if ($chrome) { Start-Process $chrome -ArgumentList '--new-window', $site }
  else { Start-Process $site }
}

if ($OpenOnly) {
  Open-Site
  if ($Private) { Read-Host "`nEnter で終了" }   # 注意書きを読ませたいときだけ残す
  exit 0
}

# --------------------------------------------------------- バージョン刻印
# GitHub Pages は js/css を max-age=600 で配信する。
# しかもページ再読込時、JS/CSS は Service Worker を経由せず
# ブラウザのHTTPキャッシュから返される。URL を変える以外に手がない。
$stamp = Get-Date -Format 'yyyyMMddHHmmss'
$utf8 = New-Object System.Text.UTF8Encoding($false)
foreach ($f in @('index.html', 'js\app.js')) {
  $p = Join-Path $PSScriptRoot $f
  $t = [IO.File]::ReadAllText($p, $utf8)
  $t = [regex]::Replace($t, '\?v=[0-9A-Za-z]+', "?v=$stamp")
  [IO.File]::WriteAllText($p, $t, $utf8)
}
Write-Host "バージョンを刻印しました: $stamp"

# --------------------------------------------------------------- commit / push
if (-not $Message) { $Message = "update $(Get-Date -Format 'yyyy-MM-dd HH:mm')" }

git add -A | Out-Null
git diff --cached --quiet
if ($LASTEXITCODE -eq 0) {
  Write-Host "変更はありません。コミットを飛ばします。"
} else {
  Write-Host "コミット: $Message"
  git commit -m $Message | Out-Null
  if ($LASTEXITCODE -ne 0) { Fail "コミットに失敗しました。" }
}

Write-Host "push しています..."
git push | Out-Null
if ($LASTEXITCODE -ne 0) { Fail "push に失敗しました。" }

# ------------------------------------------------- 実際に配信されるまで待つ
Write-Host "`nGitHub Pages への反映を待っています（最大3分）..." -NoNewline

function Get-Sha1([string]$path) { (Get-FileHash -LiteralPath $path -Algorithm SHA1).Hash }

$deadline = (Get-Date).AddMinutes(3)
$ready = $false
while ((Get-Date) -lt $deadline) {
  $mismatch = $null
  foreach ($t in $targets) {
    $localPath = Join-Path $PSScriptRoot ($t -replace '/', '\')
    if (-not (Test-Path -LiteralPath $localPath)) { continue }
    $tmp = Join-Path $env:TEMP ("_dep_" + [guid]::NewGuid().ToString('N') + ".tmp")
    try {
      Invoke-WebRequest -Uri "$site$t`?nocache=$([guid]::NewGuid().ToString('N'))" `
        -OutFile $tmp -UseBasicParsing -TimeoutSec 20 | Out-Null
      if ((Get-Sha1 $localPath) -ne (Get-Sha1 $tmp)) { $mismatch = $t }
    } catch { $mismatch = $t }
    finally { if (Test-Path -LiteralPath $tmp) { Remove-Item -LiteralPath $tmp -Force } }
    if ($mismatch) { break }
  }
  if (-not $mismatch) { $ready = $true; break }
  Write-Host "." -NoNewline
  Start-Sleep -Seconds 5
}

# ブラウザは Start-Process で独立したプロセスとして起動するため、
# このウィンドウを閉じてもアプリには影響しない。
# 正常に終わったら自動で閉じ、問題があったときだけ内容を読めるよう残す。
if ($ready) {
  Write-Host "`n反映されました（照合したファイルすべて一致）。" -ForegroundColor Green
  Open-Site
  if ($Private) { Read-Host "`nEnter で終了" }
  exit 0
}

Write-Host "`n[警告] 時間内に反映が確認できませんでした。古い内容が表示される可能性があります。" -ForegroundColor Yellow
Write-Host "        数分おいて再実行するか、ブラウザで Ctrl+Shift+R を押してください。"
Open-Site
Read-Host "`nEnter で終了"
