# Tests du script privé avec HTTP et commandes natives simulés; aucune publication.
#Requires -Version 7.4
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

if (-not ("IndexNowTestHandler" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class IndexNowRecordedCommand {
  public string Label { get; set; }
  public string Location { get; set; }
}

internal sealed class NonSeekableStreamingContent : HttpContent {
  private readonly Func<Stream> _streamFactory;

  public NonSeekableStreamingContent(Func<Stream> streamFactory) {
    _streamFactory = streamFactory;
  }

  protected override Task SerializeToStreamAsync(Stream stream, TransportContext context) {
    return Task.CompletedTask;
  }

  protected override Task<Stream> CreateContentReadStreamAsync() {
    return Task.FromResult(_streamFactory());
  }

  protected override bool TryComputeLength(out long length) {
    length = 0;
    return false;
  }
}

internal sealed class OversizedChunkStream : Stream {
  private readonly int _totalBytes;
  private readonly Action _onCompleted;
  private int _sent;

  public OversizedChunkStream(int totalBytes, Action onCompleted) {
    _totalBytes = totalBytes;
    _onCompleted = onCompleted;
  }

  public override bool CanRead => true;
  public override bool CanSeek => false;
  public override bool CanWrite => false;
  public override long Length => throw new NotSupportedException();
  public override long Position {
    get => throw new NotSupportedException();
    set => throw new NotSupportedException();
  }

  public override void Flush() { }
  public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
  public override void SetLength(long value) => throw new NotSupportedException();
  public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

  public override int Read(byte[] buffer, int offset, int count) {
    return ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();
  }

  public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) {
    return ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
  }

  public override ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
    cancellationToken.ThrowIfCancellationRequested();
    if (_sent >= _totalBytes) {
      if (_onCompleted != null) { _onCompleted(); }
      return ValueTask.FromResult(0);
    }
    int toCopy = Math.Min(buffer.Length, Math.Min(16384, _totalBytes - _sent));
    buffer.Span.Slice(0, toCopy).Fill((byte)'x');
    _sent += toCopy;
    return ValueTask.FromResult(toCopy);
  }
}

internal sealed class SlowChunkStream : Stream {
  private readonly int _totalChunks;
  private readonly int _delayMs;
  private int _chunksSent;
  private static readonly byte[] Piece = Encoding.UTF8.GetBytes("<span>drip</span>");

  public SlowChunkStream(int totalChunks, int delayMs) {
    _totalChunks = totalChunks;
    _delayMs = delayMs;
  }

  public override bool CanRead => true;
  public override bool CanSeek => false;
  public override bool CanWrite => false;
  public override long Length => throw new NotSupportedException();
  public override long Position {
    get => throw new NotSupportedException();
    set => throw new NotSupportedException();
  }

  public override void Flush() { }
  public override long Seek(long offset, SeekOrigin origin) => throw new NotSupportedException();
  public override void SetLength(long value) => throw new NotSupportedException();
  public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();

  public override int Read(byte[] buffer, int offset, int count) {
    return ReadAsync(buffer, offset, count, CancellationToken.None).GetAwaiter().GetResult();
  }

  public override Task<int> ReadAsync(byte[] buffer, int offset, int count, CancellationToken cancellationToken) {
    return ReadAsync(buffer.AsMemory(offset, count), cancellationToken).AsTask();
  }

  public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken cancellationToken = default) {
    if (_chunksSent >= _totalChunks) {
      return 0;
    }
    if (_chunksSent > 0) {
      await Task.Delay(_delayMs, cancellationToken);
    }
    _chunksSent++;
    int toCopy = Math.Min(buffer.Length, Piece.Length);
    Piece.AsSpan(0, toCopy).CopyTo(buffer.Span);
    return toCopy;
  }
}

public sealed class IndexNowTestHandler : HttpMessageHandler {
  public bool AllowAutoRedirect { get; set; } = true;
  public int MaxResponseDrainSize { get; set; } = 1024 * 1024;
  public static IList CommandLog;
  public static string ExpectedLocation;
  public static bool AfterPages;
  public static bool SnapshotFailure;
  public static bool Unchanged;
  public static bool StalePage;
  public static bool ReorderedAttributes;
  public static int PublicAfterSuccessAttempt;
  public static bool EmptyPublicAfterBody;
  public static bool OversizedPublicAfterBody;
  public static bool SlowPublicAfterBody;
  public static int IndexNowStatus = 200;
  public static int PublicAfterCalls;
  public static bool OversizedCompleted;
  public static string PublishedHtml;
  public static string OldHtml;
  public static string ReorderedPublishedHtml;
  public static string ReorderedOldHtml;
  public static string IndexNowKey;

  protected override Task<HttpResponseMessage> SendAsync(HttpRequestMessage request, CancellationToken cancellationToken) {
    if (AllowAutoRedirect || MaxResponseDrainSize != 0 || request.Method != HttpMethod.Get) {
      throw new InvalidOperationException("Options HTTP IndexNow incorrectes.");
    }
    string uri = request.RequestUri.AbsoluteUri;
    if (uri == "https://tankwars-game.com/") {
      string cacheControl = request.Headers.CacheControl != null ? request.Headers.CacheControl.ToString() : "";
      if (!cacheControl.Contains("no-cache")) {
        throw new InvalidOperationException("La vérification publique doit demander une revalidation.");
      }
      string label = AfterPages ? "public-after" : "public-before";
      CommandLog.Add(new IndexNowRecordedCommand { Label = label, Location = ExpectedLocation });

      if (!AfterPages && SnapshotFailure) {
        throw new HttpRequestException("Erreur réseau simulée avant publication.");
      }
      if (AfterPages) {
        PublicAfterCalls++;
        if (EmptyPublicAfterBody) {
          return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new ByteArrayContent(Array.Empty<byte>())
          });
        }
        if (OversizedPublicAfterBody) {
          return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new NonSeekableStreamingContent(() => new OversizedChunkStream(2 * 1024 * 1024, () => { OversizedCompleted = true; }))
          });
        }
        if (SlowPublicAfterBody) {
          return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new NonSeekableStreamingContent(() => new SlowChunkStream(100, 40))
          });
        }
        if (PublicAfterSuccessAttempt > 0 && PublicAfterCalls < PublicAfterSuccessAttempt) {
          return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new StringContent(OldHtml, Encoding.UTF8, "text/html")
          });
        }
        if (ReorderedAttributes) {
          return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
            Content = new StringContent(ReorderedPublishedHtml.Replace("bruit-nouveau", "bruit-public"), Encoding.UTF8, "text/html")
          });
        }
        string afterHtml = !StalePage ? PublishedHtml : OldHtml;
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
          Content = new StringContent(afterHtml, Encoding.UTF8, "text/html")
        });
      }

      if (ReorderedAttributes) {
        return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
          Content = new StringContent(ReorderedOldHtml, Encoding.UTF8, "text/html")
        });
      }
      string beforeHtml = Unchanged ? PublishedHtml.Replace("index-new.js", "index-old.js") : OldHtml;
      return Task.FromResult(new HttpResponseMessage(HttpStatusCode.OK) {
        Content = new StringContent(beforeHtml, Encoding.UTF8, "text/html")
      });
    }

    string expectedIndexNow = "https://api.indexnow.org/indexnow?url=https%3A%2F%2Ftankwars-game.com%2F&key=" + IndexNowKey;
    if (uri != expectedIndexNow) {
      throw new InvalidOperationException("Destination IndexNow incorrecte.");
    }
    CommandLog.Add(new IndexNowRecordedCommand { Label = "indexnow", Location = ExpectedLocation });
    return Task.FromResult(new HttpResponseMessage((HttpStatusCode)IndexNowStatus) {
      Content = new StringContent("SECRET_MARKER", Encoding.UTF8, "text/plain")
    });
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
$indexNowKey = "a" * 64
$publishedHtml = '<link rel="canonical" href="https://tankwars-game.com/"><title>TankWars</title><main>Nouvel aperçu</main><script type="module" src="/assets/index-new.js"></script>'
$oldHtml = $publishedHtml.Replace("Nouvel aperçu", "Ancien aperçu").Replace("index-new.js", "index-old.js")
$reorderedPublishedHtml = '<link href="https://tankwars-game.com/" rel="canonical"><meta data-name="description" content="bruit-nouveau"><title>TankWars</title><main>Nouvel aperçu</main><script src="/assets/index-new.js" type="module"></script>'
$reorderedOldHtml = '<link href="https://tankwars-game.com/" rel="canonical"><meta data-name="description" content="bruit-ancien"><title>TankWars</title><main>Ancien aperçu</main><script src="/assets/index-old.js" type="module"></script>'

[IndexNowTestHandler]::CommandLog = $global:deploymentTestCommandLog
[IndexNowTestHandler]::ExpectedLocation = $fixtureRoot
[IndexNowTestHandler]::PublishedHtml = $publishedHtml
[IndexNowTestHandler]::OldHtml = $oldHtml
[IndexNowTestHandler]::ReorderedPublishedHtml = $reorderedPublishedHtml
[IndexNowTestHandler]::ReorderedOldHtml = $reorderedOldHtml
[IndexNowTestHandler]::IndexNowKey = $indexNowKey

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

function npm {
  $label = "npm " + ($args -join " ")
  if ($args[1] -eq "doctor" -and $global:deploymentTestDoctorWarning) {
    Assert-True ($label -eq "npm run doctor --verbose --scope full --blocking error") "Les avertissements React Doctor doivent être non bloquants."
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
    [IndexNowTestHandler]::AfterPages = $true
  }
  $global:deploymentTestCommandLog.Add([pscustomobject]@{ Label = $operation; Location = (Get-Location).Path })
  $global:LASTEXITCODE = [int]($operation -eq $global:deploymentTestFailureCommand)
  if ($operation -eq "worker") { $global:deploymentTestDeployOutput }
}

function Start-Sleep {
  param([int]$Milliseconds, [int]$Seconds)
  if ($Milliseconds -gt 0) { Microsoft.PowerShell.Utility\Start-Sleep -Milliseconds $Milliseconds }
}

try {
  foreach ($directory in @("node_modules/wrangler/bin", "worker", "src/game/online", "dist", "caller", "Scripts")) {
    New-Item -ItemType Directory -Path (Join-Path $fixtureRoot $directory) -Force | Out-Null
  }
  foreach ($file in @("node_modules/wrangler/bin/wrangler.js", "worker/wrangler.toml")) {
    [System.IO.File]::WriteAllText((Join-Path $fixtureRoot $file), "fixture")
  }
  [System.IO.File]::WriteAllText((Join-Path $fixtureRoot "dist/index.html"), $publishedHtml)
  [System.IO.File]::WriteAllText((Join-Path $fixtureRoot "dist/$indexNowKey.txt"), $indexNowKey)
  $indexNowSource = Get-Content -LiteralPath (Join-Path $PSScriptRoot "notify-indexnow.ps1") -Raw
  $testIndexNowSource = $indexNowSource.
    Replace('[System.Net.Http.SocketsHttpHandler]::new()', '[IndexNowTestHandler]::new()').
    Replace('[TimeSpan]::FromSeconds(5)', '[TimeSpan]::FromMilliseconds(150)').
    Replace('Start-Sleep -Seconds 2', 'Start-Sleep -Milliseconds 10')
  Assert-True ($testIndexNowSource -ne $indexNowSource -and $testIndexNowSource.Contains('[IndexNowTestHandler]::new()') -and $testIndexNowSource.Contains('[TimeSpan]::FromMilliseconds(150)') -and $testIndexNowSource.Contains('Start-Sleep -Milliseconds 10')) "Points de simulation IndexNow absents."
  [System.IO.File]::WriteAllText((Join-Path $fixtureRoot "Scripts/notify-indexnow.ps1"), $testIndexNowSource, [System.Text.UTF8Encoding]::new($false))
  $testSource = $source.Replace('[System.Net.Http.HttpClientHandler]::new()', '[DeploymentProbeHandler]::new()').Replace('[TimeSpan]::FromSeconds(60)', '[TimeSpan]::FromMilliseconds(100)')
  Assert-True ($testSource -ne $source -and $testSource.Contains('[DeploymentProbeHandler]::new()') -and $testSource.Contains('[TimeSpan]::FromMilliseconds(100)')) "Points de simulation absents."
  $fixtureScript = Join-Path $fixtureRoot "deploy-cloudflare.ps1"
  [System.IO.File]::WriteAllText($fixtureScript, $testSource)
  $validProtocol = "export const ONLINE_PROTOCOL_VERSION = 3 as const;`nexport const MINIMUM_CLIENT_PROTOCOL_VERSION = 3 as const;`n"
  $validHealth = '{"ok":true,"service":"tankwars-api","protocolVersion":3,"minimumClientProtocolVersion":3}'
  $cases = @(
    @{ Name = "succès et variables absentes"; Success = $true },
    @{ Name = "contenu inchangé malgré un nouveau module Vite"; Success = $true; Unchanged = $true },
    @{ Name = "nouveau build public non confirmé"; Success = $true; StalePage = $true; IndexNowWarning = $true },
    @{ Name = "reprise publique réussie à la 2e tentative"; Success = $true; PublicAfterSuccessAttempt = 2 },
    @{ Name = "attributs HTML inversés et data-name ignoré"; Success = $true; ReorderedAttributes = $true },
    @{ Name = "échec du snapshot initial avant publication"; Success = $true; SnapshotFailure = $true; ExpectedIndexNowWarning = 'IndexNow : comparaison avant publication indisponible\.' },
    @{ Name = "fichier de clé IndexNow vide"; Success = $true; EmptyKeyFile = $true; NoIndexNow = $true; ExpectedIndexNowWarning = 'IndexNow : Le contenu du fichier de clé IndexNow ne correspond pas à son nom\.' },
    @{ Name = "réponse publique vide"; Success = $true; EmptyPublicAfterBody = $true; NoIndexNow = $true; PublicAfterRetries = 3; ExpectedIndexNowWarning = "IndexNow : La réponse de l’accueil public est vide ou anormalement volumineuse\." },
    @{ Name = "réponse publique anormalement volumineuse"; Success = $true; OversizedPublicAfterBody = $true; NoIndexNow = $true; PublicAfterRetries = 3; ExpectedIndexNowWarning = "IndexNow : La réponse de l’accueil public est vide ou anormalement volumineuse\." },
    @{ Name = "réponse publique lente"; Success = $true; SlowPublicAfterBody = $true; NoIndexNow = $true; PublicAfterRetries = 3; ExpectedIndexNowWarning = "IndexNow : Délai dépassé lors de l’accès à l’accueil public\." },
    @{ Name = "IndexNow reçu avec validation de clé en attente"; Success = $true; IndexNowStatus = 202 },
    @{ Name = "échec IndexNow après publication"; Success = $true; IndexNowStatus = 429; IndexNowWarning = $true },
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
  foreach ($validation in @("npm run lint", "npm run build", "npm run test", "npm run doctor --verbose --scope full --blocking error", "git diff --check")) {
    $cases += @{ Name = "échec $validation"; Failure = $validation; NoProbe = $true; NoWorker = $true }
  }
  foreach ($case in $cases) {
    $global:deploymentTestCommandLog.Clear()
    $global:deploymentTestFailureCommand = $case.Failure
    $global:deploymentTestDoctorWarning = $case.DoctorWarning -eq $true
    [IndexNowTestHandler]::AfterPages = $false
    [IndexNowTestHandler]::SnapshotFailure = $case.SnapshotFailure -eq $true
    [IndexNowTestHandler]::Unchanged = $case.Unchanged -eq $true
    [IndexNowTestHandler]::StalePage = $case.StalePage -eq $true
    [IndexNowTestHandler]::ReorderedAttributes = $case.ReorderedAttributes -eq $true
    [IndexNowTestHandler]::PublicAfterSuccessAttempt = if ($case.PublicAfterSuccessAttempt) { $case.PublicAfterSuccessAttempt } else { 0 }
    [IndexNowTestHandler]::EmptyPublicAfterBody = $case.EmptyPublicAfterBody -eq $true
    [IndexNowTestHandler]::OversizedPublicAfterBody = $case.OversizedPublicAfterBody -eq $true
    [IndexNowTestHandler]::SlowPublicAfterBody = $case.SlowPublicAfterBody -eq $true
    [IndexNowTestHandler]::IndexNowStatus = if ($case.IndexNowStatus) { $case.IndexNowStatus } else { 200 }
    [IndexNowTestHandler]::PublicAfterCalls = 0
    [IndexNowTestHandler]::OversizedCompleted = $false
    $global:deploymentTestDeployOutput = if ($case.ContainsKey("Output")) { $case.Output } else { "https://tankwars-api.example.workers.dev" }
    $distHtml = if ($case.ReorderedAttributes) { $reorderedPublishedHtml } else { $publishedHtml }
    [System.IO.File]::WriteAllText((Join-Path $fixtureRoot "dist/index.html"), $distHtml)
    $keyFileBody = if ($case.EmptyKeyFile) { "" } else { $indexNowKey }
    [System.IO.File]::WriteAllText((Join-Path $fixtureRoot "dist/$indexNowKey.txt"), $keyFileBody)
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
    $output = (& $fixtureScript 3>&1 6>&1 | Out-String)
    $exitCode = $LASTEXITCODE
    Assert-True (($exitCode -eq 0) -eq ($case.Success -eq $true)) "Résultat incorrect : $($case.Name). $output"
    Assert-True ((Get-Location).Path -eq (Join-Path $fixtureRoot "caller")) "Répertoire non restauré : $($case.Name)."
    Assert-True ($env:VITE_API_BASE -eq $(if ($case.Present) { "original-api" } else { $null })) "API non restaurée."
    Assert-True ($env:VITE_HOTSEAT_ONLY -eq $(if ($case.Present) { "original-hotseat" } else { $null })) "Mode non restauré."
    Assert-True ($output -notmatch 'SECRET_MARKER') "Donnée sensible dans les journaux."
    if ($case.DoctorWarning) { Assert-True ($output -match 'React Doctor : avertissement simulé, aucune erreur\.') "Diagnostic React Doctor masqué." }
    $labels = @($global:deploymentTestCommandLog | ForEach-Object Label)
    Assert-True (($labels -contains "pages") -eq ($case.Success -eq $true -or $case.PagesAttempted -eq $true)) "Publication Pages inattendue : $($case.Name)."
    Assert-True (($labels -contains "indexnow") -eq ($case.Success -eq $true -and -not $case.Unchanged -and -not $case.StalePage -and -not $case.NoIndexNow)) "Envoi IndexNow inattendu : $($case.Name)."
    if ($case.ExpectedIndexNowWarning) {
      Assert-True ($output -match $case.ExpectedIndexNowWarning) "Avertissement IndexNow attendu absent ($($case.Name)). $output"
    }
    else {
      Assert-True (($output -match "IndexNow : (Le nouveau build|IndexNow a répondu|comparaison avant publication|Le contenu du fichier|La réponse de l’accueil|L’accueil public|Délai dépassé|Impossible de joindre)") -eq ($case.IndexNowWarning -eq $true)) "Avertissement IndexNow inattendu : $($case.Name). $output"
    }
    if ($case.OversizedPublicAfterBody) {
      Assert-True (-not [IndexNowTestHandler]::OversizedCompleted) "Le flux volumineux sans Content-Length aurait dû être interrompu avant la fin."
    }
    if ($case.SlowPublicAfterBody) {
      Assert-True ($elapsed.Elapsed.TotalSeconds -lt 3) "Le délai global par requête IndexNow n’a pas interrompu la réponse lente ($($elapsed.Elapsed.TotalSeconds)s)."
    }
    foreach ($command in $global:deploymentTestCommandLog) { Assert-True ($command.Location -eq $fixtureRoot) "Commande hors du dépôt." }
    if ($case.NoCommands) { Assert-True ($labels.Count -eq 0) "Commande avant validation de la configuration." }
    if ($case.NoWorker) { Assert-True ($labels -notcontains "worker") "Worker publié malgré validation échouée." }
    if ($case.NoProbe) { Assert-True ([DeploymentProbeHandler]::Calls -eq 0) "Sonde après échec préalable." }
    if ($case.Wait) { Assert-True ($elapsed.Elapsed.TotalSeconds -lt 3) "Budget de sonde non respecté." }
    if ($case.Success) {
      $expectedLabels = 'npm run lint|npm run build|npm run test|npm run doctor --verbose --scope full --blocking error|git diff --check|worker|npm run build|public-before|pages'
      if ($case.StalePage) { $expectedLabels += '|public-after|public-after|public-after' }
      elseif ($case.PublicAfterRetries) { $expectedLabels += ('|public-after' * $case.PublicAfterRetries) }
      elseif ($case.PublicAfterSuccessAttempt) { $expectedLabels += ('|public-after' * $case.PublicAfterSuccessAttempt) + '|indexnow' }
      elseif ($case.NoIndexNow) { $expectedLabels += '|public-after' }
      elseif (-not $case.Unchanged) { $expectedLabels += '|public-after|indexnow' }
      Assert-True (($labels -join '|') -eq $expectedLabels) "Ordre incorrect : $($labels -join '|')"
      if ($case.IndexNowStatus -eq 202) { Assert-True ($output -match 'validation de la clé en attente') "L’état 202 doit être visible." }
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
  [IndexNowTestHandler]::CommandLog = $null
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
