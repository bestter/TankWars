#Requires -Version 7.4
[CmdletBinding(DefaultParameterSetName = "Submit")]
param(
  [Parameter(Mandatory, ParameterSetName = "Snapshot")]
  [switch]$Snapshot,

  [Parameter(Mandatory, ParameterSetName = "Submit")]
  [string]$DistPath,

  [Parameter(ParameterSetName = "Submit")]
  [string]$PreviousContent
)

$ErrorActionPreference = "Stop"
$siteUrl = "https://tankwars-game.com/"
$canonical = '<link\b(?=[^>]*\srel="canonical")(?=[^>]*\shref="https://tankwars-game\.com/")[^>]*>'
$moduleScript = '<script\b(?=[^>]*\stype="module")(?=[^>]*\ssrc="(/assets/[^"]+\.js)")[^>]*>'
$maxPublicHtmlLength = 262144
$requestOptions = @{
  ConnectionTimeoutSeconds = 5
  OperationTimeoutSeconds = 5
  MaximumRedirection = 0
  SkipHttpErrorCheck = $true
}

function Get-IndexableContent {
  param([string]$Html)

  # Exclure les références d'actifs hachées et les ajouts Cloudflare du contenu comparé.
  $fields = [regex]::Matches(
    $Html,
    '(?is)<title\b[^>]*>.*?</title>|<main\b[^>]*>.*?</main>|<meta\b[^>]*(?:\sname="(?:description|twitter:[^"]+)"|\sproperty="og:[^"]+")[^>]*>|<link\b[^>]*\srel="canonical"[^>]*>'
  )
  return (($fields.Value -join ' ') -replace '\s+', ' ').Trim()
}

function Get-PublicPage {
  try {
    $page = Invoke-WebRequest @requestOptions -Uri $siteUrl -Headers @{ "Cache-Control" = "no-cache" }
  }
  catch {
    throw "L’accueil public est inaccessible."
  }
  if ([int]$page.StatusCode -ne 200) {
    throw "L’accueil public a répondu HTTP $([int]$page.StatusCode)."
  }
  if ($null -eq $page.Content -or $page.Content.Length -eq 0 -or $page.Content.Length -gt $maxPublicHtmlLength) {
    throw "La réponse de l’accueil public est vide ou anormalement volumineuse."
  }
  return [string]$page.Content
}

if ($Snapshot) {
  return Get-IndexableContent (Get-PublicPage)
}

$indexHtmlPath = Join-Path $DistPath "index.html"
if (-not (Test-Path -LiteralPath $indexHtmlPath -PathType Leaf)) {
  throw "Le build Pages ne contient pas index.html."
}
$localHtml = Get-Content -LiteralPath $indexHtmlPath -Raw
if ([string]::IsNullOrEmpty($localHtml)) {
  throw "Le build Pages ne contient pas l’URL canonique attendue ou le module Vite."
}
$builtModule = [regex]::Match($localHtml, $moduleScript)
if (-not $builtModule.Success -or $localHtml -cnotmatch $canonical) {
  throw "Le build Pages ne contient pas l’URL canonique attendue ou le module Vite."
}
$builtContent = Get-IndexableContent $localHtml
if ($PreviousContent -ceq $builtContent) {
  Write-Host "IndexNow : contenu d’accueil inchangé."
  return
}

for ($attempt = 1; $attempt -le 3; $attempt++) {
  $pageConfirmed = $false
  try {
    $pageHtml = Get-PublicPage
    $liveModule = [regex]::Match($pageHtml, $moduleScript)
    $pageConfirmed = $liveModule.Success -and
      $liveModule.Groups[1].Value -ceq $builtModule.Groups[1].Value -and
      (Get-IndexableContent $pageHtml) -ceq $builtContent
  }
  catch {
    if ($attempt -eq 3) { throw }
  }
  if ($pageConfirmed) { break }
  if ($attempt -lt 3) { Start-Sleep -Seconds 2 }
}
if (-not $pageConfirmed) {
  throw "Le nouveau build n’est pas encore confirmé sur le domaine public."
}

$keyFiles = @(Get-ChildItem -LiteralPath $DistPath -File -Filter "*.txt" |
  Where-Object { $_.BaseName -cmatch '\A[a-f0-9]{64}\z' })
if ($keyFiles.Count -ne 1) {
  throw "Le build doit contenir un seul fichier de clé IndexNow."
}
$key = $keyFiles[0].BaseName
$keyContent = Get-Content -LiteralPath $keyFiles[0].FullName -Raw
if ([string]::IsNullOrEmpty($keyContent) -or $keyContent.Trim() -cne $key) {
  throw "Le contenu du fichier de clé IndexNow ne correspond pas à son nom."
}

$encodedUrl = [uri]::EscapeDataString($siteUrl)
try {
  $submission = Invoke-WebRequest @requestOptions -Uri "https://api.indexnow.org/indexnow?url=$encodedUrl&key=$key"
}
catch {
  throw "Impossible de joindre IndexNow."
}
switch ([int]$submission.StatusCode) {
  200 { Write-Host "IndexNow : URL soumise ($siteUrl)." }
  202 { Write-Host "IndexNow : URL reçue, validation de la clé en attente ($siteUrl)." }
  default { throw "IndexNow a répondu HTTP $([int]$submission.StatusCode)." }
}
