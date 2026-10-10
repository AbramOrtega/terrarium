param([string]$Drive = 'C', [int]$Every = 4)
# The island's eyes on the machine: one JSON line every few seconds. The cheap
# readings (CPU, disk and network throughput, keyboard idle) come every time;
# memory and the busiest programs every other time; the drive, the GPU and the
# listening dev servers every fifth. All of it stays on this machine.
$ErrorActionPreference = 'SilentlyContinue'
$cores = [Environment]::ProcessorCount

function Counter($category, $name, $instance) {
  try { $c = New-Object Diagnostics.PerformanceCounter($category, $name, $instance); [void]$c.NextValue(); $c } catch { $null }
}
$cpu = Counter 'Processor' '% Processor Time' '_Total'
$diskRead = Counter 'PhysicalDisk' 'Disk Read Bytes/sec' '_Total'
$diskWrite = Counter 'PhysicalDisk' 'Disk Write Bytes/sec' '_Total'
$nics = @()
try { $nics = [Diagnostics.PerformanceCounterCategory]::new('Network Interface').GetInstanceNames() } catch {}
$down = @($nics | ForEach-Object { Counter 'Network Interface' 'Bytes Received/sec' $_ } | Where-Object { $_ })
$up = @($nics | ForEach-Object { Counter 'Network Interface' 'Bytes Sent/sec' $_ } | Where-Object { $_ })

$hasIdle = $false
try {
  Add-Type -Name Idle -Namespace Terrarium -MemberDefinition @'
[StructLayout(LayoutKind.Sequential)] public struct LII { public uint cbSize; public uint dwTime; }
[DllImport("user32.dll")] public static extern bool GetLastInputInfo(ref LII p);
public static uint Ms() { LII l = new LII(); l.cbSize = 8; GetLastInputInfo(ref l); return (uint)Environment.TickCount - l.dwTime; }
'@
  $hasIdle = $true
} catch {}

$smi = (Get-Command nvidia-smi -ErrorAction SilentlyContinue).Source
$dev = '^(node|python|python3|pythonw|ruby|java|php|dotnet|deno|bun|go|uvicorn|gunicorn|nginx|httpd|caddy|postgres|mysqld|mongod|redis-server|ollama|hugo|jekyll|esbuild|vite|next-server|flask|rails|cargo|http-server|docker|com\.docker\.backend|wslrelay)$'

$prev = @{}
$prevAt = $null
$slow = [ordered]@{}
$loop = 0
while ($true) {
  $out = [ordered]@{ t = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() }
  if ($cpu) { $out.cpu = [math]::Round($cpu.NextValue() / 100, 3) }
  if ($diskRead) { $out.diskRead = [math]::Round($diskRead.NextValue()) }
  if ($diskWrite) { $out.diskWrite = [math]::Round($diskWrite.NextValue()) }
  if ($down.Count) { $out.netDown = [math]::Round(($down | ForEach-Object { $_.NextValue() } | Measure-Object -Sum).Sum) }
  if ($up.Count) { $out.netUp = [math]::Round(($up | ForEach-Object { $_.NextValue() } | Measure-Object -Sum).Sum) }
  if ($hasIdle) { $out.idle = [math]::Round([Terrarium.Idle]::Ms() / 1000) }

  if ($loop % 2 -eq 0) {
    $os = Get-CimInstance Win32_OperatingSystem -Property FreePhysicalMemory, TotalVisibleMemorySize
    if ($os -and $os.TotalVisibleMemorySize) { $slow.ram = [math]::Round(1 - $os.FreePhysicalMemory / $os.TotalVisibleMemorySize, 3) }
    $now = Get-Date
    $ps = Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64
    if ($prevAt) {
      $span = ($now - $prevAt).TotalSeconds
      $byName = @{}
      $mem = @{}
      $many = @{}
      foreach ($p in $ps) {
        $many[$p.ProcessName] = [int]$many[$p.ProcessName] + 1
        $mem[$p.ProcessName] = [double]$mem[$p.ProcessName] + [double]$p.WorkingSet64
        if ($p.CPU -ne $null -and $p.Id -ne $PID -and $prev.ContainsKey($p.Id)) {
          $share = ($p.CPU - $prev[$p.Id]) / ($span * $cores)
          if ($share -gt 0) { $byName[$p.ProcessName] = [double]$byName[$p.ProcessName] + $share }
        }
      }
      # Each busy program: its share, the memory its processes hold (MB), how
      # many there are, and when the oldest started (asked of these few only:
      # it is slow to ask, and the system will not say for its own).
      $slow.procs = @($byName.GetEnumerator() | Where-Object { $_.Value -ge 0.02 -and $_.Key -ne 'Idle' } |
        Sort-Object Value -Descending | Select-Object -First 6 |
        ForEach-Object {
          $o = [ordered]@{ name = $_.Key; cpu = [math]::Round($_.Value, 3); mem = [math]::Round($mem[$_.Key] / 1e6); count = [int]$many[$_.Key] }
          $starts = @(Get-Process -Name $_.Key | ForEach-Object { try { $_.StartTime } catch { $null } } | Where-Object { $_ } | Sort-Object)
          if ($starts.Count) { $o.since = ([DateTimeOffset]$starts[0]).ToUnixTimeMilliseconds() }
          $o
        })
    }
    $prev = @{}
    foreach ($p in $ps) { if ($p.CPU -ne $null) { $prev[$p.Id] = $p.CPU } }
    $prevAt = $now
  }

  if ($loop % 5 -eq 0) {
    $d = Get-PSDrive -Name $Drive
    if ($d -and ($d.Free + $d.Used) -gt 0) {
      $slow.diskFree = [math]::Round($d.Free / ($d.Free + $d.Used), 4)
      $slow.diskFreeGb = [math]::Round($d.Free / 1e9, 1)
    }
    if ($smi) {
      $g = ((& $smi --query-gpu=utilization.gpu,temperature.gpu,memory.used,memory.total,name --format=csv,noheader,nounits) | Select-Object -First 1) -split ',\s*'
      if ($g.Count -ge 5 -and [double]$g[3] -gt 0) {
        $slow.gpu = [ordered]@{ load = [double]$g[0] / 100; temp = [double]$g[1]; mem = [math]::Round([double]$g[2] / [double]$g[3], 3); name = $g[4].Trim() }
      }
    }
    $seen = @{}
    $ports = @()
    foreach ($c in (Get-NetTCPConnection -State Listen | Where-Object { $_.LocalPort -ge 1024 -and $_.LocalPort -le 49151 })) {
      if ($seen.ContainsKey($c.LocalPort)) { continue }
      $seen[$c.LocalPort] = $true
      $name = (Get-Process -Id $c.OwningProcess).ProcessName
      if ($name -match $dev) { $ports += [ordered]@{ port = [int]$c.LocalPort; name = $name } }
    }
    $slow.ports = @($ports | Sort-Object { $_.port } | Select-Object -First 8)
  }

  foreach ($k in $slow.Keys) { $out[$k] = $slow[$k] }
  [Console]::Out.WriteLine((ConvertTo-Json -InputObject $out -Compress -Depth 4))
  [Console]::Out.Flush()
  $loop++
  Start-Sleep -Seconds $Every
}
