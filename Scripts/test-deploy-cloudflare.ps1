# Tests du script privé avec HTTP et commandes natives simulés; aucune publication.
#Requires -Version 7.0
$ErrorActionPreference = "Stop"
$repoRoot = Split-Path -Parent $PSScriptRoot
$sourcePath = Join-Path $repoRoot "deploy-cloudflare.ps1"
if (-not (Test-Path -LiteralPath $sourcePath)) {
  throw "Le script privé deploy-cloudflare.ps1 est requis pour ces tests locaux."
}
$source = Get-Content -LiteralPath $sourcePath -Raw
$tokens = $null
$parseErrors = $null
[System.Management.Automation.Language.Parser]::ParseInput($source, [ref]$tokens, [ref]$parseErrors) | Out-Null
if ($parseErrors.Count -ne 0) { throw "Syntaxe PowerShell invalide." }

# Le vrai HttpClient conserve ses délais/annulations et son buffering. Seul son
# transport est remplacé; aucune résolution DNS ni connexion n'est possible.
if (-not ("DeploymentProbeHandler" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Net;
using System.Net.Http;
using System.Threading;
using System.Threading.Tasks;
public sealed class DeploymentProbeHandler : HttpClientHandler {
  public static string Body;
  public static int Status;
  public static bool WaitForCancellation;
  public static int Calls;
  protected override async Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken token) {
    Calls++;
    if (AllowAutoRedirect || request.Method != HttpMethod.Get ||
        request.RequestUri.Host != "tankwars-api.example.workers.dev" ||
        request.RequestUri.AbsolutePath != "/api/health" ||
        !request.Headers.Contains("Cache-Control") || !request.Headers.Contains("Pragma")) {
      throw new InvalidOperationException("Paramètres de la sonde incorrects.");
    }
    if (WaitForCancellation) { await Task.Delay(Timeout.Infinite, token); }
    var response = new HttpResponseMessage((HttpStatusCode)Status);
    response.Content = new StringContent(Body);
    if (Status >= 300 && Status < 400) {
      response.Headers.Location = new Uri("https://untrusted.invalid/SECRET_MARKER");
    }
    return response;
  }
}
'@
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("tankwars-deploy-tests-" + [guid]::NewGuid().ToString("N"))
$originalLocation = Get-Location
$savedEnvironment = @{}
foreach ($name in @("WORKER_API_URL", "VITE_API_BASE", "VITE_HOTSEAT_ONLY")) {
  $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, "Process")
}
$global:deploymentTestCommandLog = [System.Collections.Generic.List[object]]::new()
$global:deploymentTestFailureCommand = ""
$global:deploymentTestDeployOutput = "https://tankwars-api.example.workers.dev"
$global:deploymentTestDoctorWarning = $false

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function npm {
  $label = "npm " + ($args -join " ")
  if ($args[1] -eq "doctor" -and $global:deploymentTestDoctorWarning) {
    Assert-True ($label -eq "npm run doctor --verbose --scope changed --blocking error") "Les avertissements React Doctor doivent être non bloquants."
    Write-Host "React Doctor : avertissement simulé, aucune erreur."
  }
  $global:deploymentTestCommandLog.Add([pscustomobject]@{ Label = $label; Location = (Get-Location).Path; Api = $env:VITE_API_BASE; Hotseat = $env:VITE_HOTSEAT_ONLY })
  $global:LASTEXITCODE = [int]($label -eq $global:deploymentTestFailureCommand -or ($global:deploymentTestFailureCommand -eq "production-build" -and $label -eq "npm run build" -and $env:VITE_HOTSEAT_ONLY -eq "false"))
}

function git {
  $label = "git " + ($args -join " ")
  $global:deploymentTestCommandLog.Add([pscustomobject]@{ Label = $label; Location = (Get-Location).Path })
  $global:LASTEXITCODE = [int]($label -eq $global:deploymentTestFailureCommand)
}

function node {
  $operation = if ($args[1] -eq "pages") { "pages" } else { "worker" }
  Assert-True ($args[0] -eq (Join-Path $fixtureRoot "node_modules/wrangler/bin/wrangler.js")) "Wrangler non local."
  if ($operation -eq "worker") {
    Assert-True ($args[1] -eq "deploy" -and $args[2] -eq "--cwd" -and $args[3] -eq (Join-Path $fixtureRoot "worker") -and $args[4] -eq "--config" -and $args[5] -eq (Join-Path $fixtureRoot "worker/wrangler.toml")) "Configuration Worker incorrecte."
  }
  else {
    Assert-True ($args[2] -eq "deploy" -and $args[3] -eq (Join-Path $fixtureRoot "dist") -and $args[4] -eq "--project-name" -and $args[5] -eq "tankwars" -and $args[6] -eq "--branch" -and $args[7] -eq "main") "Cible Pages incorrecte."
    Assert-True ([DeploymentProbeHandler]::Calls -gt 0) "Pages sans sonde."
  }
  $global:deploymentTestCommandLog.Add([pscustomobject]@{ Label = $operation; Location = (Get-Location).Path })
  $global:LASTEXITCODE = [int]($operation -eq $global:deploymentTestFailureCommand)
  if ($operation -eq "worker") { $global:deploymentTestDeployOutput }
}

try {
  foreach ($directory in @("node_modules/wrangler/bin", "worker", "src/game/online", "dist", "caller")) {
    New-Item -ItemType Directory -Path (Join-Path $fixtureRoot $directory) -Force | Out-Null
  }
  foreach ($file in @("node_modules/wrangler/bin/wrangler.js", "worker/wrangler.toml", "dist/index.html")) {
    [System.IO.File]::WriteAllText((Join-Path $fixtureRoot $file), "fixture")
  }
  $testSource = $source.Replace('[System.Net.Http.HttpClientHandler]::new()', '[DeploymentProbeHandler]::new()').Replace('[TimeSpan]::FromSeconds(60)', '[TimeSpan]::FromMilliseconds(100)')
  Assert-True ($testSource -ne $source -and $testSource.Contains('[DeploymentProbeHandler]::new()') -and $testSource.Contains('[TimeSpan]::FromMilliseconds(100)')) "Points de simulation absents."
  $fixtureScript = Join-Path $fixtureRoot "deploy-cloudflare.ps1"
  [System.IO.File]::WriteAllText($fixtureScript, $testSource)
  $validProtocol = "export const ONLINE_PROTOCOL_VERSION = 3 as const;`nexport const MINIMUM_CLIENT_PROTOCOL_VERSION = 3 as const;`n"
  $validHealth = '{"ok":true,"service":"tankwars-api","protocolVersion":3,"minimumClientProtocolVersion":3}'
  $cases = @(
    @{ Name = "succès et variables absentes"; Success = $true },
    @{ Name = "avertissement React Doctor visible et non bloquant"; Success = $true; DoctorWarning = $true },
    @{ Name = "succès et variables présentes"; Success = $true; Present = $true; Url = "https://tankwars-api.example.workers.dev:443/" },
    @{ Name = "versions lues dynamiquement"; Success = $true; Protocol = $validProtocol.Replace('3 as const', '4 as const'); Body = $validHealth.Replace(':3', ':4'); Version = 4 },
    @{ Name = "ancien protocole"; Body = $validHealth.Replace(':3', ':2') },
    @{ Name = "versions textuelles"; Body = $validHealth.Replace(':3', ':"3"') },
    @{ Name = "JSON invalide"; Body = 'SECRET_MARKER {' },
    @{ Name = "mauvais service"; Body = $validHealth.Replace('tankwars-api', 'SECRET_MARKER') },
    @{ Name = "ok faux"; Body = $validHealth.Replace('true', 'false') },
    @{ Name = "tableau JSON"; Body = "[$validHealth]" },
    @{ Name = "champs absents"; Body = '{}' },
    @{ Name = "réponse trop grande"; Body = (' ' * 65537) + $validHealth },
    @{ Name = "redirection"; Status = 302 },
    @{ Name = "erreur HTTP"; Status = 503 },
    @{ Name = "annulation au budget"; Wait = $true },
    @{ Name = "origine différente"; Url = "https://tankwars-api.other.workers.dev"; NoProbe = $true },
    @{ Name = "URL détectée absente"; Output = "https://example.invalid"; NoProbe = $true },
    @{ Name = "URL détectées ambiguës"; Output = "https://tankwars-api.example.workers.dev`nhttps://tankwars-api.other.workers.dev"; NoProbe = $true },
    @{ Name = "URL détectée avec suffixe"; Output = "https://tankwars-api.example.workers.dev.evil.invalid"; NoProbe = $true },
    @{ Name = "déploiement Worker échoué"; Failure = "worker"; NoProbe = $true },
    @{ Name = "build client échoué"; Failure = "production-build"; Present = $true },
    @{ Name = "Pages échoué"; Failure = "pages"; PagesAttempted = $true; Present = $true },
    @{ Name = "protocole absent"; Protocol = ""; NoCommands = $true },
    @{ Name = "protocole ambigu"; Protocol = $validProtocol + "export const ONLINE_PROTOCOL_VERSION = 3 as const;`n"; NoCommands = $true },
    @{ Name = "protocole non littéral"; Protocol = $validProtocol.Replace('3 as const', 'getVersion()'); NoCommands = $true }
  )
  foreach ($url in @(
    "http://tankwars-api.example.workers.dev", "https://SECRET_MARKER@tankwars-api.example.workers.dev",
    "https://tankwars-api.example.workers.dev:444", "https://tankwars-api.example.workers.dev/api",
    "https://tankwars-api.example.workers.dev?SECRET_MARKER", "https://tankwars-api.example.workers.dev#SECRET_MARKER",
    "https://tankwars-api.example.workers.dev.evil.invalid", "https://127.0.0.1", "https://tankwars-api.example.workers.dev/a/.."
  )) { $cases += @{ Name = "URL interdite"; Url = $url; NoCommands = $true } }
  foreach ($validation in @("npm run lint", "npm run build", "npm run test", "npm run doctor --verbose --scope changed --blocking error", "git diff --check")) {
    $cases += @{ Name = "échec $validation"; Failure = $validation; NoProbe = $true; NoWorker = $true }
  }
  foreach ($case in $cases) {
    $global:deploymentTestCommandLog.Clear()
    $global:deploymentTestFailureCommand = $case.Failure
    $global:deploymentTestDoctorWarning = $case.DoctorWarning -eq $true
    $global:deploymentTestDeployOutput = if ($case.ContainsKey("Output")) { $case.Output } else { "https://tankwars-api.example.workers.dev" }
    [DeploymentProbeHandler]::Body = if ($case.ContainsKey("Body")) { $case.Body } else { $validHealth }
    [DeploymentProbeHandler]::Status = if ($case.ContainsKey("Status")) { $case.Status } else { 200 }
    [DeploymentProbeHandler]::WaitForCancellation = $case.Wait -eq $true
    [DeploymentProbeHandler]::Calls = 0
    $protocol = if ($case.ContainsKey("Protocol")) { $case.Protocol } else { $validProtocol }
    [System.IO.File]::WriteAllText((Join-Path $fixtureRoot "src/game/online/protocol.ts"), $protocol)
    $env:WORKER_API_URL = $case.Url
    $env:VITE_API_BASE = if ($case.Present) { "original-api" } else { $null }
    $env:VITE_HOTSEAT_ONLY = if ($case.Present) { "original-hotseat" } else { $null }
    Set-Location -LiteralPath (Join-Path $fixtureRoot "caller")
    $global:LASTEXITCODE = 0
    $elapsed = [System.Diagnostics.Stopwatch]::StartNew()
    $output = (& $fixtureScript 6>&1 | Out-String)
    $exitCode = $LASTEXITCODE
    Assert-True (($exitCode -eq 0) -eq ($case.Success -eq $true)) "Résultat incorrect : $($case.Name). $output"
    Assert-True ((Get-Location).Path -eq (Join-Path $fixtureRoot "caller")) "Répertoire non restauré : $($case.Name)."
    Assert-True ($env:VITE_API_BASE -eq $(if ($case.Present) { "original-api" } else { $null })) "API non restaurée."
    Assert-True ($env:VITE_HOTSEAT_ONLY -eq $(if ($case.Present) { "original-hotseat" } else { $null })) "Mode non restauré."
    Assert-True ($output -notmatch 'SECRET_MARKER') "Donnée sensible dans les journaux."
    if ($case.DoctorWarning) { Assert-True ($output -match 'React Doctor : avertissement simulé, aucune erreur\.') "Diagnostic React Doctor masqué." }
    $labels = @($global:deploymentTestCommandLog | ForEach-Object Label)
    Assert-True (($labels -contains "pages") -eq ($case.Success -eq $true -or $case.PagesAttempted -eq $true)) "Publication Pages inattendue : $($case.Name)."
    foreach ($command in $global:deploymentTestCommandLog) { Assert-True ($command.Location -eq $fixtureRoot) "Commande hors du dépôt." }
    if ($case.NoCommands) { Assert-True ($labels.Count -eq 0) "Commande avant validation de la configuration." }
    if ($case.NoWorker) { Assert-True ($labels -notcontains "worker") "Worker publié malgré validation échouée." }
    if ($case.NoProbe) { Assert-True ([DeploymentProbeHandler]::Calls -eq 0) "Sonde après échec préalable." }
    if ($case.Wait) { Assert-True ($elapsed.Elapsed.TotalSeconds -lt 3) "Budget de sonde non respecté." }
    if ($case.Success) {
      Assert-True (($labels -join '|') -eq 'npm run lint|npm run build|npm run test|npm run doctor --verbose --scope changed --blocking error|git diff --check|worker|npm run build|pages') "Ordre incorrect : $($labels -join '|')"
      $build = @($global:deploymentTestCommandLog | Where-Object Label -eq 'npm run build')[1]
      Assert-True ($build.Api -eq 'https://tankwars-api.example.workers.dev' -and $build.Hotseat -eq 'false') "Build online incorrect."
      $expectedVersion = if ($case.Version) { $case.Version } else { 3 }
      Assert-True ($output -match "protocole $expectedVersion, client minimum $expectedVersion") "Message de succès incorrect."
    }
    Write-Output "PASS : $($case.Name)"
  }
  Write-Output "$($cases.Count) scénarios réussis; aucun réseau ni déploiement réel."
}
finally {
  Set-Location -LiteralPath $originalLocation.Path
  foreach ($name in $savedEnvironment.Keys) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], "Process") }
  Remove-Variable -Name deploymentTestCommandLog, deploymentTestFailureCommand, deploymentTestDeployOutput, deploymentTestDoctorWarning -Scope Global -ErrorAction SilentlyContinue
  # Seul le répertoire temporaire explicitement créé ci-dessus est supprimé.
  $resolvedFixture = [System.IO.Path]::GetFullPath($fixtureRoot)
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if ($resolvedFixture.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedFixture) -match '^tankwars-deploy-tests-[a-f0-9]{32}$') {
    Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
  }
}
