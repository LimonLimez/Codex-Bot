$ErrorActionPreference = 'Stop'

function Test-LocalPortListener([int]$Port) {
    return $null -ne (Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Test-ExpectedLoopbackListener {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedExecutable,
        [int]$ExpectedProcessId = 0
    )

    # A bearer token authenticates the client, not the server. Establish the
    # listener's Windows identity before any caller is allowed to send a token.
    $listeners = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue)
    if ($listeners.Count -eq 0) { return $false }

    $expectedPath = [IO.Path]::GetFullPath($ExpectedExecutable)
    $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $processIds = @($listeners | Select-Object -ExpandProperty OwningProcess -Unique)

    foreach ($listener in $listeners) {
        if ([string]$listener.LocalAddress -ne '127.0.0.1') { return $false }
        if ($ExpectedProcessId -gt 0 -and [int]$listener.OwningProcess -ne $ExpectedProcessId) { return $false }
    }

    foreach ($ownerProcessId in $processIds) {
        $process = Get-CimInstance Win32_Process -Filter "ProcessId = $ownerProcessId" -ErrorAction SilentlyContinue
        if ($null -eq $process -or [string]::IsNullOrWhiteSpace([string]$process.ExecutablePath)) { return $false }

        try {
            $actualPath = [IO.Path]::GetFullPath([string]$process.ExecutablePath)
            $owner = Invoke-CimMethod -InputObject $process -MethodName GetOwnerSid -ErrorAction Stop
        } catch {
            return $false
        }

        if (-not [string]::Equals($actualPath, $expectedPath, [StringComparison]::OrdinalIgnoreCase)) { return $false }
        if ([int]$owner.ReturnValue -ne 0 -or [string]$owner.Sid -ne $currentSid) { return $false }
    }

    return $true
}

function Stop-ExpectedLoopbackListener {
    param(
        [Parameter(Mandatory = $true)]
        [int]$Port,
        [Parameter(Mandatory = $true)]
        [string]$ExpectedExecutable,
        [int]$ExpectedProcessId = 0
    )

    if (-not (Test-ExpectedLoopbackListener -Port $Port -ExpectedExecutable $ExpectedExecutable -ExpectedProcessId $ExpectedProcessId)) {
        return $false
    }
    $processIds = @(Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique)
    foreach ($ownerProcessId in $processIds) {
        Stop-Process -Id $ownerProcessId -Force -ErrorAction Stop
    }
    return $true
}
