$ErrorActionPreference = 'Stop'

# Edit these three values for the Windows PC.
$AndroidSdk = 'D:\AndroidSDK'
$AndroidAvdHome = 'D:\Android\AVD'
$AvdName = 'PlayByPoint_API_35'

$ProjectDir = Split-Path -Parent $PSScriptRoot
$GitBash = 'C:\Program Files\Git\bin\bash.exe'

function Convert-ToBashPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if ($fullPath -notmatch '^([A-Za-z]):\\(.*)$') {
        throw "Expected an absolute Windows path, got: $Path"
    }
    $drive = $Matches[1].ToLowerInvariant()
    $rest = $Matches[2] -replace '\\', '/'
    return "/$drive/$rest"
}

if (-not (Test-Path $GitBash)) {
    throw 'Git Bash is required. Install Git for Windows, then rerun this script.'
}
if (-not (Test-Path (Join-Path $AndroidSdk 'platform-tools\adb.exe'))) {
    throw "adb.exe was not found under $AndroidSdk"
}
if (-not (Test-Path (Join-Path $AndroidSdk 'emulator\emulator.exe'))) {
    throw "emulator.exe was not found under $AndroidSdk"
}

$PythonExe = $null
$pyLauncher = Get-Command py.exe -ErrorAction SilentlyContinue
if ($null -ne $pyLauncher) {
    $PythonExe = (& $pyLauncher.Source -3 -c 'import sys; print(sys.executable)' | Select-Object -Last 1).Trim()
}
if ([string]::IsNullOrWhiteSpace($PythonExe) -or -not (Test-Path $PythonExe)) {
    $pythonCommand = Get-Command python.exe -ErrorAction SilentlyContinue
    if ($null -ne $pythonCommand) {
        $PythonExe = (& $pythonCommand.Source -c 'import sys; print(sys.executable)' | Select-Object -Last 1).Trim()
    }
}
if ([string]::IsNullOrWhiteSpace($PythonExe) -or -not (Test-Path $PythonExe)) {
    throw 'Python 3 could not be resolved from PowerShell. Install Python 3 with the Python Launcher and PATH options enabled.'
}

$bashProject = Convert-ToBashPath $ProjectDir
$bashSdk = Convert-ToBashPath $AndroidSdk
$bashAvdHome = Convert-ToBashPath $AndroidAvdHome
$bashPython = Convert-ToBashPath $PythonExe

$bashCommand = @"
export ANDROID_SDK_ROOT='$bashSdk'
export ANDROID_HOME='$bashSdk'
export ANDROID_AVD_HOME='$bashAvdHome'
export PLAYBYPOINT_PYTHON='$bashPython'
cd '$bashProject'
AVD_NAME='$AvdName' ./scripts/playbypoint-local-session.sh
"@

& $GitBash -lc $bashCommand
if ($LASTEXITCODE -ne 0) {
    throw "PlayByPoint automation exited with code $LASTEXITCODE"
}
