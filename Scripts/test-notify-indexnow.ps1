# Tests autonomes de Scripts/notify-indexnow.ps1 avec un serveur HTTP/1.1 local contrôlé.
#Requires -Version 7.4
$ErrorActionPreference = "Stop"

$sourceScriptPath = Join-Path $PSScriptRoot "notify-indexnow.ps1"
if (-not (Test-Path -LiteralPath $sourceScriptPath -PathType Leaf)) {
  throw "Scripts/notify-indexnow.ps1 est introuvable."
}

if (-not ("IndexNowLocalHttpServer" -as [type])) {
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using System.Threading.Tasks;

public sealed class IndexNowRecordedRequest {
  public string Method { get; set; }
  public string Target { get; set; }
  public string CacheControl { get; set; }
}

public sealed class IndexNowLocalHttpServer : IDisposable {
  private readonly TcpListener _listener;
  private readonly CancellationTokenSource _cts = new CancellationTokenSource();
  private readonly Task _acceptLoop;

  public int Port { get; private set; }
  public string PublicMode = "normal";
  public string PublicHtml = "";
  public int PublicStatusCode = 200;
  public int ExactChunkedBytes = 0;
  public int OversizedTotalBytes = 8 * 1024 * 1024;
  public int SlowTotalChunks = 100;
  public int SlowDelayMs = 60;
  public int IndexNowStatusCode = 200;
  public int LastPayloadBytesSent;
  public readonly ConcurrentQueue<IndexNowRecordedRequest> Requests = new ConcurrentQueue<IndexNowRecordedRequest>();

  public IndexNowLocalHttpServer() {
    _listener = new TcpListener(IPAddress.Loopback, 0);
    _listener.Start();
    Port = ((IPEndPoint)_listener.LocalEndpoint).Port;
    _acceptLoop = Task.Run(AcceptLoopAsync);
  }

  public void Reset(string mode, string html) {
    PublicMode = mode;
    PublicHtml = html ?? "";
    PublicStatusCode = 200;
    ExactChunkedBytes = 0;
    IndexNowStatusCode = 200;
    Interlocked.Exchange(ref LastPayloadBytesSent, 0);
    IndexNowRecordedRequest ignored;
    while (Requests.TryDequeue(out ignored)) { }
  }

  private async Task AcceptLoopAsync() {
    while (!_cts.IsCancellationRequested) {
      TcpClient client;
      try {
        client = await _listener.AcceptTcpClientAsync(_cts.Token);
      }
      catch {
        break;
      }
      var ignoredTask = Task.Run(() => HandleClientAsync(client));
    }
  }

  private async Task HandleClientAsync(TcpClient client) {
    try {
      using (client)
      using (NetworkStream stream = client.GetStream()) {
        string rawRequest = await ReadHeadersAsync(stream, _cts.Token);
        if (string.IsNullOrEmpty(rawRequest)) { return; }

        string[] lines = rawRequest.Split(new[] { "\r\n" }, StringSplitOptions.None);
        string[] parts = lines[0].Split(' ');
        string method = parts.Length > 0 ? parts[0] : "";
        string target = parts.Length > 1 ? parts[1] : "";
        string cacheControl = null;
        for (int i = 1; i < lines.Length; i++) {
          int colon = lines[i].IndexOf(':');
          if (colon > 0 && lines[i].Substring(0, colon).Trim().Equals("Cache-Control", StringComparison.OrdinalIgnoreCase)) {
            cacheControl = lines[i].Substring(colon + 1).Trim();
          }
        }
        Requests.Enqueue(new IndexNowRecordedRequest {
          Method = method,
          Target = target,
          CacheControl = cacheControl
        });

        if (target.StartsWith("/indexnow", StringComparison.Ordinal)) {
          await WriteSimpleResponseAsync(stream, IndexNowStatusCode, "OK", "text/plain", Encoding.UTF8.GetBytes("ok"), null);
          return;
        }

        if (PublicMode == "redirect") {
          await WriteSimpleResponseAsync(stream, 302, "Found", "text/plain", Encoding.UTF8.GetBytes("redirect"), "https://example.invalid/");
          return;
        }

        if (PublicMode == "empty") {
          await WriteChunkedHeaderAsync(stream, PublicStatusCode);
          await WriteChunkAsync(stream, Array.Empty<byte>());
          return;
        }

        if (PublicMode == "exact-chunked") {
          await WriteChunkedHeaderAsync(stream, 200);
          byte[] payload = CreateSizedHtmlBytes(ExactChunkedBytes);
          int sent = 0;
          int offset = 0;
          while (offset < payload.Length) {
            int len = Math.Min(16384, payload.Length - offset);
            byte[] slice = new byte[len];
            Buffer.BlockCopy(payload, offset, slice, 0, len);
            await WriteChunkAsync(stream, slice);
            sent += len;
            offset += len;
          }
          await WriteChunkAsync(stream, Array.Empty<byte>());
          Interlocked.Exchange(ref LastPayloadBytesSent, sent);
          return;
        }

        if (PublicMode == "oversized-chunked") {
          await WriteChunkedHeaderAsync(stream, 200);
          byte[] chunk = new byte[16384];
          for (int i = 0; i < chunk.Length; i++) { chunk[i] = (byte)'a'; }
          int sent = 0;
          try {
            while (sent < OversizedTotalBytes && !_cts.IsCancellationRequested) {
              int len = Math.Min(chunk.Length, OversizedTotalBytes - sent);
              byte[] slice = len == chunk.Length ? chunk : new byte[len];
              if (len != chunk.Length) {
                for (int i = 0; i < slice.Length; i++) { slice[i] = (byte)'a'; }
              }
              await WriteChunkAsync(stream, slice);
              sent += len;
              await Task.Delay(1, _cts.Token);
            }
            await WriteChunkAsync(stream, Array.Empty<byte>());
          }
          catch {
            // Fermeture précoce attendue lorsque le client interrompt la lecture.
          }
          Interlocked.Exchange(ref LastPayloadBytesSent, sent);
          return;
        }

        if (PublicMode == "slow-drip") {
          await WriteChunkedHeaderAsync(stream, 200);
          byte[] piece = Encoding.UTF8.GetBytes("<span>drip</span>");
          int sent = 0;
          try {
            for (int i = 0; i < SlowTotalChunks && !_cts.IsCancellationRequested; i++) {
              await WriteChunkAsync(stream, piece);
              sent += piece.Length;
              await Task.Delay(SlowDelayMs, _cts.Token);
            }
            await WriteChunkAsync(stream, Array.Empty<byte>());
          }
          catch {
            // Fermeture précoce attendue après expiration du délai global client.
          }
          Interlocked.Exchange(ref LastPayloadBytesSent, sent);
          return;
        }

        await WriteChunkedHeaderAsync(stream, PublicStatusCode);
        byte[] bodyBytes = Encoding.UTF8.GetBytes(PublicHtml);
        if (bodyBytes.Length > 0) {
          await WriteChunkAsync(stream, bodyBytes);
          Interlocked.Exchange(ref LastPayloadBytesSent, bodyBytes.Length);
        }
        await WriteChunkAsync(stream, Array.Empty<byte>());
      }
    }
    catch {
      // Ignorer les fermetures de socket côté client pendant les tests négatifs.
    }
  }

  private static byte[] CreateSizedHtmlBytes(int totalBytes) {
    string prefix = "<title>TankWars</title><main>";
    string suffix = "</main>";
    int overhead = Encoding.UTF8.GetByteCount(prefix) + Encoding.UTF8.GetByteCount(suffix);
    int fillerCount = Math.Max(0, totalBytes - overhead);
    string html = prefix + new string('x', fillerCount) + suffix;
    byte[] bytes = Encoding.UTF8.GetBytes(html);
    if (bytes.Length != totalBytes) {
      throw new InvalidOperationException("Taille générée inattendue.");
    }
    return bytes;
  }

  private static async Task<string> ReadHeadersAsync(NetworkStream stream, CancellationToken token) {
    byte[] buffer = new byte[4096];
    MemoryStream ms = new MemoryStream();
    while (ms.Length < 16384) {
      int read = await stream.ReadAsync(buffer, 0, buffer.Length, token);
      if (read <= 0) { break; }
      ms.Write(buffer, 0, read);
      string text = Encoding.ASCII.GetString(ms.GetBuffer(), 0, (int)ms.Length);
      int idx = text.IndexOf("\r\n\r\n", StringComparison.Ordinal);
      if (idx >= 0) {
        return text.Substring(0, idx);
      }
    }
    return "";
  }

  private static async Task WriteSimpleResponseAsync(NetworkStream stream, int statusCode, string reason, string contentType, byte[] body, string location) {
    StringBuilder sb = new StringBuilder();
    sb.Append("HTTP/1.1 ").Append(statusCode).Append(' ').Append(reason).Append("\r\n");
    sb.Append("Content-Type: ").Append(contentType).Append("; charset=utf-8\r\n");
    sb.Append("Content-Length: ").Append(body.Length).Append("\r\n");
    if (!string.IsNullOrEmpty(location)) {
      sb.Append("Location: ").Append(location).Append("\r\n");
    }
    sb.Append("Connection: close\r\n\r\n");
    byte[] headers = Encoding.ASCII.GetBytes(sb.ToString());
    await stream.WriteAsync(headers, 0, headers.Length);
    if (body.Length > 0) {
      await stream.WriteAsync(body, 0, body.Length);
    }
    await stream.FlushAsync();
  }

  private static async Task WriteChunkedHeaderAsync(NetworkStream stream, int statusCode) {
    string reason = statusCode == 200 ? "OK" : "Status";
    string headers = "HTTP/1.1 " + statusCode + " " + reason + "\r\nContent-Type: text/html; charset=utf-8\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n";
    byte[] headerBytes = Encoding.ASCII.GetBytes(headers);
    await stream.WriteAsync(headerBytes, 0, headerBytes.Length);
    await stream.FlushAsync();
  }

  private static async Task WriteChunkAsync(NetworkStream stream, byte[] data) {
    byte[] sizeLine = Encoding.ASCII.GetBytes(data.Length.ToString("X") + "\r\n");
    await stream.WriteAsync(sizeLine, 0, sizeLine.Length);
    if (data.Length > 0) {
      await stream.WriteAsync(data, 0, data.Length);
    }
    byte[] crlf = Encoding.ASCII.GetBytes("\r\n");
    await stream.WriteAsync(crlf, 0, crlf.Length);
    await stream.FlushAsync();
  }

  public void Dispose() {
    _cts.Cancel();
    try { _listener.Stop(); } catch { }
    try { _acceptLoop.Wait(1000); } catch { }
    _cts.Dispose();
  }
}
'@
}

function Assert-True {
  param([bool]$Condition, [string]$Message)
  if (-not $Condition) { throw $Message }
}

$fixtureRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("tankwars-indexnow-tests-" + [guid]::NewGuid().ToString("N"))
$server = $null

try {
  $distDir = Join-Path $fixtureRoot "dist"
  New-Item -ItemType Directory -Path $distDir -Force | Out-Null

  $server = [IndexNowLocalHttpServer]::new()
  $baseUrl = "http://127.0.0.1:$($server.Port)"

  $source = Get-Content -LiteralPath $sourceScriptPath -Raw
  $patched = $source.
    Replace('$publicPageUrl = $siteUrl', "`$publicPageUrl = `"$baseUrl/`"").
    Replace('$indexNowApiUrl = "https://api.indexnow.org/indexnow"', "`$indexNowApiUrl = `"$baseUrl/indexnow`"").
    Replace('$requestTimeout = [TimeSpan]::FromSeconds(5)', '$requestTimeout = [TimeSpan]::FromMilliseconds(300)').
    Replace('Start-Sleep -Seconds 2', 'Start-Sleep -Milliseconds 20')

  Assert-True ($patched.Contains("`"$baseUrl/`"") -and $patched.Contains("`"$baseUrl/indexnow`"") -and $patched.Contains("FromMilliseconds(300)") -and $patched.Contains("Start-Sleep -Milliseconds 20")) "Points de patch absents dans notify-indexnow.ps1."
  $scriptUnderTest = Join-Path $fixtureRoot "notify-indexnow.ps1"
  [System.IO.File]::WriteAllText($scriptUnderTest, $patched, [System.Text.UTF8Encoding]::new($false))

  $indexNowKey = "b" * 64
  $publishedHtml = '<link rel="canonical" href="https://tankwars-game.com/"><title>TankWars</title><main>Nouvel aperçu</main><script type="module" src="/assets/index-new.js"></script>'
  $oldHtml = $publishedHtml.Replace("Nouvel aperçu", "Ancien aperçu").Replace("index-new.js", "index-old.js")
  $unchangedPublicHtml = $publishedHtml.Replace("index-new.js", "index-old.js")

  [System.IO.File]::WriteAllText((Join-Path $distDir "index.html"), $publishedHtml, [System.Text.UTF8Encoding]::new($false))
  [System.IO.File]::WriteAllText((Join-Path $distDir "$indexNowKey.txt"), $indexNowKey, [System.Text.UTF8Encoding]::new($false))

  # 1. Contenu modifié avec réponse IndexNow HTTP 202
  $server.Reset("normal", $oldHtml)
  $prev = & $scriptUnderTest -Snapshot
  $server.Reset("normal", $publishedHtml)
  $server.IndexNowStatusCode = 202
  $output = (& $scriptUnderTest -DistPath $distDir -PreviousContent $prev 6>&1 | Out-String)
  Assert-True ($output -match 'validation de la clé en attente') "Réponse HTTP 202 non signalée. $output"
  $reqs = @($server.Requests.ToArray())
  Assert-True ($reqs.Count -eq 2) "Deux requêtes attendues (accueil + IndexNow), reçu $($reqs.Count)."
  Assert-True ($reqs[0].Target -eq "/" -and $reqs[0].CacheControl -eq "no-cache") "Requête d’accueil incorrecte."
  Assert-True ($reqs[1].Target -eq "/indexnow?url=https%3A%2F%2Ftankwars-game.com%2F&key=$indexNowKey") "Requête IndexNow incorrecte : $($reqs[1].Target)"
  Write-Output "PASS : contenu modifié avec réponse IndexNow HTTP 202"

  # 2. Contenu inchangé malgré un nouveau module Vite
  $server.Reset("normal", $unchangedPublicHtml)
  $prev = & $scriptUnderTest -Snapshot
  $server.Reset("normal", $publishedHtml)
  $output = (& $scriptUnderTest -DistPath $distDir -PreviousContent $prev 6>&1 | Out-String)
  Assert-True ($output -match "IndexNow : contenu d’accueil inchangé\.") "Message de contenu inchangé absent. $output"
  $reqs = @($server.Requests.ToArray())
  Assert-True ($reqs.Count -eq 0) "Aucune requête attendue quand le contenu est inchangé ($($reqs.Count))."
  Write-Output "PASS : contenu inchangé malgré un nouveau module Vite"

  # 3. Build public encore périmé après les 3 tentatives prévues
  $server.Reset("normal", $oldHtml)
  $threw = $false
  try {
    & $scriptUnderTest -DistPath $distDir -PreviousContent "ancien" | Out-Null
  }
  catch {
    $threw = $true
    Assert-True ($_.Exception.Message -eq "Le nouveau build n’est pas encore confirmé sur le domaine public.") "Message inattendu : $($_.Exception.Message)"
  }
  Assert-True $threw "Une erreur était attendue pour un build périmé."
  $reqs = @($server.Requests.ToArray())
  Assert-True ($reqs.Count -eq 3 -and -not ($reqs.Target -like "/indexnow*")) "3 requêtes d’accueil et 0 appel IndexNow attendus."
  Write-Output "PASS : build public périmé après 3 tentatives"

  # 4. Réponse trop volumineuse sans Content-Length (interruption pendant le flux)
  $server.Reset("oversized-chunked", "")
  $threw = $false
  try {
    & $scriptUnderTest -Snapshot | Out-Null
  }
  catch {
    $threw = $true
    Assert-True ($_.Exception.Message -eq "La réponse de l’accueil public est vide ou anormalement volumineuse.") "Message taille dépassée inattendu (-Snapshot) : $($_.Exception.Message)"
  }
  Assert-True $threw "Une erreur était attendue pour la réponse volumineuse sans Content-Length (-Snapshot)."
  Assert-True ($server.LastPayloadBytesSent -lt $server.OversizedTotalBytes) "Le serveur a envoyé tout le flux volumineux ($($server.LastPayloadBytesSent) / $($server.OversizedTotalBytes))."

  $server.Reset("oversized-chunked", "")
  $threw = $false
  try {
    & $scriptUnderTest -DistPath $distDir -PreviousContent "ancien" | Out-Null
  }
  catch {
    $threw = $true
    Assert-True ($_.Exception.Message -eq "La réponse de l’accueil public est vide ou anormalement volumineuse.") "Message taille dépassée inattendu (-DistPath) : $($_.Exception.Message)"
  }
  Assert-True $threw "Une erreur était attendue pour la réponse volumineuse sans Content-Length (-DistPath)."
  $reqs = @($server.Requests.ToArray())
  Assert-True ($reqs.Count -eq 3 -and -not ($reqs.Target -like "/indexnow*")) "3 tentatives sans soumission IndexNow attendues."
  Write-Output "PASS : réponse trop volumineuse sans Content-Length"

  # 5. Bornes exactes sans Content-Length (262144 accepté, 262145 rejeté)
  $server.Reset("exact-chunked", "")
  $server.ExactChunkedBytes = 262144
  $content262144 = & $scriptUnderTest -Snapshot
  Assert-True ($content262144 -match '<title>TankWars</title>') "La réponse de 262144 octets sans Content-Length doit être acceptée."

  $server.Reset("exact-chunked", "")
  $server.ExactChunkedBytes = 262145
  $threw = $false
  try {
    & $scriptUnderTest -Snapshot | Out-Null
  }
  catch {
    $threw = $true
    Assert-True ($_.Exception.Message -eq "La réponse de l’accueil public est vide ou anormalement volumineuse.") "Message borne 262145 inattendu : $($_.Exception.Message)"
  }
  Assert-True $threw "La réponse de 262145 octets sans Content-Length doit être rejetée."
  Write-Output "PASS : bornes exactes 262144 / 262145 sans Content-Length"

  # 6. Réponse lente (slow-drip dépassant le délai global par requête)
  $server.Reset("slow-drip", "")
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $threw = $false
  try {
    & $scriptUnderTest -Snapshot | Out-Null
  }
  catch {
    $threw = $true
    Assert-True ($_.Exception.Message -eq "L’accueil public est inaccessible.") "Message délai global inattendu (-Snapshot) : $($_.Exception.Message)"
  }
  $sw.Stop()
  Assert-True $threw "Une erreur était attendue sur réponse lente (-Snapshot)."
  Assert-True ($sw.Elapsed.TotalSeconds -lt 2) "Le délai global par requête n’a pas interrompu la réponse lente assez tôt ($($sw.Elapsed.TotalSeconds)s)."

  $server.Reset("slow-drip", "")
  $sw = [System.Diagnostics.Stopwatch]::StartNew()
  $threw = $false
  try {
    & $scriptUnderTest -DistPath $distDir -PreviousContent "ancien" | Out-Null
  }
  catch {
    $threw = $true
    Assert-True ($_.Exception.Message -eq "L’accueil public est inaccessible.") "Message délai global inattendu (-DistPath) : $($_.Exception.Message)"
  }
  $sw.Stop()
  Assert-True $threw "Une erreur était attendue sur réponse lente (-DistPath)."
  Assert-True ($sw.Elapsed.TotalSeconds -lt 3) "Les 3 tentatives sur réponse lente ont pris trop de temps ($($sw.Elapsed.TotalSeconds)s)."
  $reqs = @($server.Requests.ToArray())
  Assert-True ($reqs.Count -eq 3 -and -not ($reqs.Target -like "/indexnow*")) "3 tentatives sans soumission IndexNow attendues sur réponse lente."
  Write-Output "PASS : réponse lente interrompue par le délai global"

  # 7. Redirection HTTP 302 non suivie
  $server.Reset("redirect", "")
  $threw = $false
  try {
    & $scriptUnderTest -Snapshot | Out-Null
  }
  catch {
    $threw = $true
    Assert-True ($_.Exception.Message -eq "L’accueil public a répondu HTTP 302.") "Message HTTP 302 inattendu : $($_.Exception.Message)"
  }
  Assert-True $threw "La redirection HTTP 302 ne doit pas être suivie."
  Write-Output "PASS : redirection HTTP 302 non suivie"

  Write-Output "7 scénarios HTTP locaux réussis."
}
finally {
  if ($null -ne $server) { $server.Dispose() }
  $resolvedFixture = [System.IO.Path]::GetFullPath($fixtureRoot)
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd([System.IO.Path]::DirectorySeparatorChar) + [System.IO.Path]::DirectorySeparatorChar
  if ($resolvedFixture.StartsWith($tempRoot, [System.StringComparison]::OrdinalIgnoreCase) -and (Split-Path -Leaf $resolvedFixture) -match '^tankwars-indexnow-tests-[a-f0-9]{32}$') {
    if (Test-Path -LiteralPath $resolvedFixture) {
      Remove-Item -LiteralPath $resolvedFixture -Recurse -Force
    }
  }
}
