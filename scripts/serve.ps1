param([string]$Root, [int]$Port = 47615)
# The 3D viewer's server: serves the files of one folder to this machine alone,
# so the page runs as a web page (a file:// page may be frozen as a snapshot).
$root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\') + '\'
$listener = [System.Net.HttpListener]::new()
$listener.Prefixes.Add("http://localhost:$Port/")
$listener.Prefixes.Add("http://127.0.0.1:$Port/")
try { $listener.Start() } catch { Write-Output "terrarium-server: port $Port is taken"; exit 0 }
Write-Output "terrarium-server: listening on $Port"
$types = @{
  '.html' = 'text/html; charset=utf-8'; '.js' = 'text/javascript; charset=utf-8'
  '.svg' = 'image/svg+xml'; '.png' = 'image/png'; '.jpg' = 'image/jpeg'; '.json' = 'application/json'
}
# The page may hand back five files, and only the page itself: a picture for
# the side pane, a scene for a photo, its sound switch, a message typed in its
# chat panel. Other sites' pages are refused by Origin.
$uploads = @('mirror.json', 'photo-scene.json', 'photo-scene.bin', 'sound.json', 'prompt.json')
$origins = @("http://localhost:$Port", "http://127.0.0.1:$Port")
# Only requests addressed to this machine by name: a page whose own address was
# pointed here (DNS rebinding) carries its own Host, and is refused.
$hosts = @("localhost:$Port", "127.0.0.1:$Port")
$updir = Join-Path $root 'upload'
while ($listener.IsListening) {
  $ctx = $listener.GetContext()
  try {
    if ($hosts -notcontains $ctx.Request.Headers['Host']) { $ctx.Response.StatusCode = 403; continue }
    $name = [Uri]::UnescapeDataString($ctx.Request.Url.AbsolutePath.TrimStart('/'))
    if ($ctx.Request.HttpMethod -eq 'POST') {
      $leaf = $name -replace '^upload/', ''
      $size = $ctx.Request.ContentLength64
      # A message is a few lines of text, never more.
      if ($leaf -eq 'prompt.json' -and $size -gt 64KB) { $size = -1 }
      if ($name -notmatch '^upload/[a-z.-]+$' -or $uploads -notcontains $leaf -or $origins -notcontains $ctx.Request.Headers['Origin'] -or $size -lt 0 -or $size -gt 128MB) {
        $ctx.Response.StatusCode = 403
      } else {
        [void][System.IO.Directory]::CreateDirectory($updir)
        $part = Join-Path $updir "$leaf.part"
        $out = [System.IO.File]::Create($part)
        try { $ctx.Request.InputStream.CopyTo($out) } finally { $out.Close() }
        Move-Item -LiteralPath $part -Destination (Join-Path $updir $leaf) -Force
        $ctx.Response.StatusCode = 204
      }
      continue
    }
    # Nothing is read by another site's page: the frame and the conversation stay on this machine's viewer.
    $site = $ctx.Request.Headers['Sec-Fetch-Site']
    if ($site -eq 'cross-site' -or $site -eq 'same-site') { $ctx.Response.StatusCode = 403; continue }
    if ($name -eq '') { $name = 'index.html' }
    $path = [System.IO.Path]::GetFullPath([System.IO.Path]::Combine($root, $name))
    $inside = $path.StartsWith($root, [StringComparison]::OrdinalIgnoreCase)
    if ($ctx.Request.HttpMethod -ne 'GET' -or -not $inside -or -not [System.IO.File]::Exists($path)) {
      $ctx.Response.StatusCode = 404
    } else {
      $bytes = [System.IO.File]::ReadAllBytes($path)
      $ext = [System.IO.Path]::GetExtension($path).ToLower()
      $ctx.Response.ContentType = $(if ($types.ContainsKey($ext)) { $types[$ext] } else { 'application/octet-stream' })
      $ctx.Response.Headers.Add('Cache-Control', 'no-store')
      $ctx.Response.Headers.Add('X-Content-Type-Options', 'nosniff')
      $ctx.Response.OutputStream.Write($bytes, 0, $bytes.Length)
    }
  } catch {
    $ctx.Response.StatusCode = 500
  } finally {
    $ctx.Response.Close()
  }
}
