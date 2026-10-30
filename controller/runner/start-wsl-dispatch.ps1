param([ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Distribution = 'upstream')
$ErrorActionPreference = 'Stop'
$wslPath = Join-Path $env:SystemRoot 'System32\wsl.exe'
$process = Start-Process -FilePath $wslPath -ArgumentList @('-d', $Distribution, '-u', 'root', '--', '/bin/sh', '-c', '"systemctl start nibfin-dispatch.service && exec sleep infinity"') -WindowStyle Hidden -PassThru -Wait
exit $process.ExitCode
