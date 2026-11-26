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
$publicPageUrl = $siteUrl
$indexNowApiUrl = "https://api.indexnow.org/indexnow"
$canonical = '<link\b(?=[^>]*\srel="canonical")(?=[^>]*\shref="https://tankwars-game\.com/")[^>]*>'
$moduleScript = '<script\b(?=[^>]*\stype="module")(?=[^>]*\ssrc="(/assets/[^"]+\.js)")[^>]*>'
$maxPublicHtmlBytes = 262144
$requestTimeout = [TimeSpan]::FromSeconds(5)

Add-Type -AssemblyName System.Net.Http
$httpHandler = $null
$httpClient = $null

function Get-IndexableContent {
  param([string]$Html)

  # Exclure les références d'actifs hachées et les ajouts Cloudflare du contenu comparé.
  $fields = [regex]::Matches(
    $Html,
    '(?is)<title\b[^>]*>.*?</title>|<main\b[^>]*>.*?</main>|<meta\b[^>]*(?:\sname="(?:description|twitter:[^"]+)"|\sproperty="og:[^"]+")[^>]*>|<link\b[^>]*\srel="canonical"[^>]*>'
  )
  return (($fields.Value -join ' ') -replace '\s+', ' ').Trim()
}

function Read-BoundedResponseText {
  param(
    [System.Net.Http.HttpResponseMessage]$Response,
    [int]$MaxBytes,
    [System.Threading.CancellationToken]$CancellationToken
  )

  $contentLength = $Response.Content.Headers.ContentLength
  if ($null -ne $contentLength -and ($contentLength -gt $MaxBytes -or $contentLength -eq 0)) {
    throw [System.IO.InvalidDataException]::new("La réponse de l’accueil public est vide ou anormalement volumineuse.")
  }

  $encoding = [System.Text.UTF8Encoding]::new($false)
  $charSet = $Response.Content.Headers.ContentType?.CharSet
  if (-not [string]::IsNullOrWhiteSpace($charSet)) {
    try {
      $encoding = [System.Text.Encoding]::GetEncoding($charSet.Trim('"'))
    }
    catch [System.ArgumentException] {
      $encoding = [System.Text.UTF8Encoding]::new($false)
    }
  }

  $stream = $null
  $bufferStream = $null
  try {
    $stream = $Response.Content.ReadAsStreamAsync($CancellationToken).GetAwaiter().GetResult()
    $bufferStream = [System.IO.MemoryStream]::new()
    $chunk = [byte[]]::new(8192)
    $totalBytes = 0
    while ($true) {
      $toRead = [Math]::Min($chunk.Length, ($MaxBytes + 1) - $totalBytes)
      $bytesRead = $stream.ReadAsync($chunk, 0, $toRead, $CancellationToken).GetAwaiter().GetResult()
      if ($bytesRead -le 0) { break }
      $totalBytes += $bytesRead
      if ($totalBytes -gt $MaxBytes) {
        throw [System.IO.InvalidDataException]::new("La réponse de l’accueil public est vide ou anormalement volumineuse.")
      }
      $bufferStream.Write($chunk, 0, $bytesRead)
    }
    if ($totalBytes -eq 0) {
      throw [System.IO.InvalidDataException]::new("La réponse de l’accueil public est vide ou anormalement volumineuse.")
    }
    return $encoding.GetString($bufferStream.GetBuffer(), 0, [int]$bufferStream.Length)
  }
  finally {
    if ($null -ne $bufferStream) { $bufferStream.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
  }
}

function Get-PublicPage {
  $requestCancellation = [System.Threading.CancellationTokenSource]::new($requestTimeout)
  $request = $null
  $response = $null
  try {
    $request = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, $publicPageUrl)
    $request.Headers.TryAddWithoutValidation("Cache-Control", "no-cache") | Out-Null
    try {
      $response = $httpClient.SendAsync($request, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $requestCancellation.Token).GetAwaiter().GetResult()
    }
    catch {
      throw "L’accueil public est inaccessible."
    }
    if ([int]$response.StatusCode -ne 200) {
      throw "L’accueil public a répondu HTTP $([int]$response.StatusCode)."
    }
    try {
      return Read-BoundedResponseText -Response $response -MaxBytes $maxPublicHtmlBytes -CancellationToken $requestCancellation.Token
    }
    catch {
      if ($_.Exception -is [System.IO.InvalidDataException]) {
        throw $_.Exception.Message
      }
      throw "L’accueil public est inaccessible."
    }
  }
  finally {
    if ($null -ne $response) { $response.Dispose() }
    if ($null -ne $request) { $request.Dispose() }
    $requestCancellation.Dispose()
  }
}

try {
  $httpHandler = [System.Net.Http.SocketsHttpHandler]::new()
  $httpHandler.AllowAutoRedirect = $false
  $httpHandler.MaxResponseDrainSize = 0
  $httpClient = [System.Net.Http.HttpClient]::new($httpHandler)
  $httpClient.Timeout = [System.Threading.Timeout]::InfiniteTimeSpan
  $httpClient.MaxResponseContentBufferSize = $maxPublicHtmlBytes

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
  $indexNowCancellation = [System.Threading.CancellationTokenSource]::new($requestTimeout)
  $indexNowRequest = $null
  $submission = $null
  try {
    $indexNowRequest = [System.Net.Http.HttpRequestMessage]::new([System.Net.Http.HttpMethod]::Get, "${indexNowApiUrl}?url=$encodedUrl&key=$key")
    try {
      $submission = $httpClient.SendAsync($indexNowRequest, [System.Net.Http.HttpCompletionOption]::ResponseHeadersRead, $indexNowCancellation.Token).GetAwaiter().GetResult()
    }
    catch {
      throw "Impossible de joindre IndexNow."
    }
    switch ([int]$submission.StatusCode) {
      200 { Write-Host "IndexNow : URL soumise ($siteUrl)." }
      202 { Write-Host "IndexNow : URL reçue, validation de la clé en attente ($siteUrl)." }
      default { throw "IndexNow a répondu HTTP $([int]$submission.StatusCode)." }
    }
  }
  finally {
    if ($null -ne $submission) { $submission.Dispose() }
    if ($null -ne $indexNowRequest) { $indexNowRequest.Dispose() }
    $indexNowCancellation.Dispose()
  }
}
finally {
  if ($null -ne $httpClient) { $httpClient.Dispose() }
  if ($null -ne $httpHandler) { $httpHandler.Dispose() }
}
