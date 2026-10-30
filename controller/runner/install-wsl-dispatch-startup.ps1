param([ValidatePattern('^[A-Za-z0-9_.-]+$')][string]$Distribution = 'upstream')
$ErrorActionPreference = 'Stop'
# Run once by the distro-owning Windows user after installing the Linux service.
# Keep WSL alive while systemd supervises the controller; never open a window.
# Permit the reviewed local launcher in this child process only. Do not alter
# persistent user/machine policy; managed Group Policy still takes precedence.
$powershellPath = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
$launcher = Join-Path $PSScriptRoot 'start-wsl-dispatch.ps1'
$action = New-ScheduledTaskAction -Execute $powershellPath -Argument "-ExecutionPolicy RemoteSigned -NoProfile -NonInteractive -WindowStyle Hidden -File `"$launcher`" -Distribution $Distribution"
$trigger = New-ScheduledTaskTrigger -AtLogOn -User ([System.Security.Principal.WindowsIdentity]::GetCurrent().Name)
$settings = New-ScheduledTaskSettingsSet -Hidden -MultipleInstances IgnoreNew -ExecutionTimeLimit ([TimeSpan]::Zero) -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries
Register-ScheduledTask -TaskName "upstream Public Dispatch ($Distribution)" -Action $action -Trigger $trigger -Settings $settings -Description 'Start the private WSL dispatch service at owner sign-in; systemd enforces execution gates.' | Out-Null
