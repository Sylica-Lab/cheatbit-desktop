param(
  [string]$JavaHome = $env:JAVA_HOME,
  [string]$AndroidSdkRoot = $env:ANDROID_SDK_ROOT
)

$ErrorActionPreference = "Stop"

$mobileRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$androidRoot = Join-Path $mobileRoot "android"
$portableJdkRoot = Join-Path $mobileRoot "jdk-win\jdk-17.0.18+8"
$defaultAndroidSdkRoot = Join-Path $env:LOCALAPPDATA "Android\Sdk"
$distRoot = Join-Path $mobileRoot "dist"
$expoConfigPath = Join-Path $mobileRoot "app.json"
$buildLogPath = Join-Path $mobileRoot "gradle-assemble-release.log"
$buildErrorLogPath = Join-Path $mobileRoot "gradle-assemble-release.err.log"

$candidateNodeDirs = @(
  "C:\nvm4w\nodejs",
  (Join-Path $env:LOCALAPPDATA "Programs\nodejs"),
  (Join-Path $env:ProgramFiles "nodejs")
) | Where-Object { $_ -and (Test-Path (Join-Path $_ "node.exe")) } | Select-Object -Unique

foreach ($nodeDir in $candidateNodeDirs) {
  if (-not ($env:PATH -split ";" | Where-Object { $_ -eq $nodeDir })) {
    $env:PATH = "$nodeDir;$env:PATH"
  }
}

if (-not (Get-Command node.exe -ErrorAction SilentlyContinue)) {
  throw "node.exe is not available on the Windows PATH. Install Node.js for Windows or update PATH before building."
}

$env:NODE_EXE = (Get-Command node.exe).Source

if (-not $JavaHome) {
  $JavaHome = $portableJdkRoot
}

if (-not (Test-Path (Join-Path $JavaHome "bin\java.exe"))) {
  throw "JAVA_HOME is invalid. Expected java.exe under '$JavaHome'."
}

$javaShimPath = Join-Path $JavaHome "bin\java"
if (-not (Test-Path $javaShimPath)) {
  Copy-Item (Join-Path $JavaHome "bin\java.exe") $javaShimPath
}

if (-not $AndroidSdkRoot) {
  if ($env:ANDROID_HOME) {
    $AndroidSdkRoot = $env:ANDROID_HOME
  }
  else {
    $AndroidSdkRoot = $defaultAndroidSdkRoot
  }
}

if (-not (Test-Path $AndroidSdkRoot)) {
  throw "ANDROID_SDK_ROOT is invalid. Expected Android SDK under '$AndroidSdkRoot'."
}

$normalizedJavaHome = $JavaHome -replace "\\", "/"
$normalizedAndroidSdkRoot = $AndroidSdkRoot -replace "\\", "/"

$env:JAVA_HOME = $normalizedJavaHome
$env:ANDROID_HOME = $normalizedAndroidSdkRoot
$env:ANDROID_SDK_ROOT = $normalizedAndroidSdkRoot
$env:NODE_ENV = "production"
$env:BABEL_ENV = "production"

$expoConfig = Get-Content $expoConfigPath -Raw | ConvertFrom-Json
$version = [string]$expoConfig.expo.version
if (-not $version) {
  throw "Unable to read Expo version from '$expoConfigPath'."
}

foreach ($logPath in @($buildLogPath, $buildErrorLogPath)) {
  if (Test-Path $logPath) {
    Remove-Item $logPath -Force
  }
}

$gradleProcess = Start-Process `
  -FilePath "cmd.exe" `
  -ArgumentList @("/c", "gradlew.bat --no-daemon clean assembleRelease --console=plain --stacktrace") `
  -WorkingDirectory $androidRoot `
  -NoNewWindow `
  -Wait `
  -PassThru `
  -RedirectStandardOutput $buildLogPath `
  -RedirectStandardError $buildErrorLogPath

$gradleExitCode = $gradleProcess.ExitCode
if ($gradleExitCode -ne 0) {
  if (Test-Path $buildLogPath) {
    Get-Content $buildLogPath -Tail 200
  }

  if (Test-Path $buildErrorLogPath) {
    Get-Content $buildErrorLogPath -Tail 200
  }

  throw "Gradle assembleRelease failed with exit code $gradleExitCode. See '$buildLogPath'."
}

$candidateApkPaths = @(
  (Join-Path $androidRoot "app\build\outputs\apk\release\app-release.apk"),
  (Join-Path $androidRoot "app\build\outputs\apk\release\app-release-unsigned.apk")
)

$apkPath = $candidateApkPaths | Where-Object { Test-Path $_ } | Select-Object -First 1
if (-not $apkPath) {
  throw "Release APK not found in '$androidRoot\app\build\outputs\apk\release'."
}

New-Item -ItemType Directory -Force -Path $distRoot | Out-Null

$stableApkPath = Join-Path $distRoot "Sylica-AI-Android.apk"
$versionedApkPath = Join-Path $distRoot ("Sylica-AI-Android-{0}.apk" -f $version)

Copy-Item $apkPath $stableApkPath -Force
Copy-Item $apkPath $versionedApkPath -Force

Write-Host "Stable APK: $stableApkPath"
Write-Host "Versioned APK: $versionedApkPath"
