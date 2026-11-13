param([string]$LocalArchive)

$ErrorActionPreference = 'Stop'

$release = 'autobuild-2026-11-13-12-43'
$build = 'ffmpeg-n8.1.3-35-gf1acb0a266-win64-gpl-8.1'
$sha256 = '096d0596ba87ee534c6357797dc68882e714b53aac76859fca4be9c012a6a91c'
$binaries = Join-Path $PSScriptRoot 'binaries'
$stamp = Join-Path $binaries "$build.ready"
$files = @{
    'bin/ffmpeg.exe' = 'ffmpeg-x86_64-pc-windows-msvc.exe'
    'bin/ffprobe.exe' = 'ffprobe-x86_64-pc-windows-msvc.exe'
    'LICENSE.txt' = 'ffmpeg-COPYING.txt'
}

$missing = $files.Values | Where-Object {
    !(Test-Path -LiteralPath (Join-Path $binaries $_) -PathType Leaf)
}
if (!$missing -and (Test-Path -LiteralPath $stamp -PathType Leaf) -and
    (Get-Content -LiteralPath $stamp -Raw).Trim() -eq $sha256) {
    exit 0
}

$staging = Join-Path ([IO.Path]::GetTempPath()) "minividcut-$([guid]::NewGuid())"
New-Item -ItemType Directory -Path $staging -Force | Out-Null
try {
    $archive = $LocalArchive
    if (!$archive) {
        $archive = Join-Path $staging "$build.zip"
        $url = "https://github.com/FFmpeg-Builds/FFmpeg-Builds/releases/download/$release/$build.zip"
        Write-Host "Downloading FFmpeg and FFprobe for Windows x64..."
        & curl.exe --fail --silent --show-error --location --retry 2 `
            --connect-timeout 20 --speed-limit 1024 --speed-time 30 --output $archive $url
        if ($LASTEXITCODE -ne 0) {
            throw "Could not download FFmpeg from $url"
        }
    }
    $stream = [IO.File]::OpenRead($archive)
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $hash = [BitConverter]::ToString($hasher.ComputeHash($stream)).Replace('-', '')
    } finally {
        $hasher.Dispose()
        $stream.Dispose()
    }
    if ($hash -ne $sha256) {
        throw 'The downloaded FFmpeg archive failed SHA-256 verification.'
    }

    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $zip = [IO.Compression.ZipFile]::OpenRead($archive)
    try {
        foreach ($file in $files.GetEnumerator()) {
            $entry = $zip.GetEntry("$build/$($file.Key)")
            if ($null -eq $entry) {
                throw "The FFmpeg archive is missing $($file.Key)."
            }
            [IO.Compression.ZipFileExtensions]::ExtractToFile(
                $entry, (Join-Path $staging $file.Value)
            )
        }
    } finally {
        $zip.Dispose()
    }

    New-Item -ItemType Directory -Path $binaries -Force | Out-Null
    foreach ($file in $files.Values) {
        Move-Item -LiteralPath (Join-Path $staging $file) -Destination (Join-Path $binaries $file) -Force
    }
    Set-Content -LiteralPath $stamp -Value $sha256
} finally {
    Get-ChildItem -LiteralPath $staging -File | Remove-Item -Force
    Remove-Item -LiteralPath $staging
}
