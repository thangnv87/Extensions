$ErrorActionPreference = 'Stop'
$sourceDir = $PSScriptRoot
$releaseDir = Join-Path $sourceDir 'release'
$zipPath = Join-Path $sourceDir 'Podhub-Mockup-GPTs-v0.9.0.zip'
$runtimeFiles = @(
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'content.js',
  'content.css',
  'content-fixes.css'
)
$javascriptFiles = @('background.js', 'popup.js', 'content.js')
$cssFiles = @('popup.css', 'content.css', 'content-fixes.css')

if (-not (Get-Command npx.cmd -ErrorAction SilentlyContinue)) {
  throw 'Node.js/npx is required to create the protected release.'
}

if (Test-Path -LiteralPath $releaseDir) {
  Remove-Item -LiteralPath $releaseDir -Recurse -Force
}
New-Item -ItemType Directory -Path $releaseDir | Out-Null
foreach ($file in $runtimeFiles) {
  Copy-Item -LiteralPath (Join-Path $sourceDir $file) -Destination (Join-Path $releaseDir $file)
}

foreach ($file in $javascriptFiles) {
  $inputPath = Join-Path $releaseDir $file
  $outputPath = "$inputPath.protected.js"
  & npx.cmd --yes javascript-obfuscator $inputPath --output $outputPath `
    --compact true `
    --control-flow-flattening true `
    --control-flow-flattening-threshold 0.35 `
    --dead-code-injection false `
    --identifier-names-generator hexadecimal `
    --rename-globals false `
    --self-defending true `
    --simplify true `
    --split-strings true `
    --split-strings-chunk-length 8 `
    --string-array true `
    --string-array-encoding base64 `
    --string-array-threshold 0.8 `
    --transform-object-keys true `
    --unicode-escape-sequence false
  if ($LASTEXITCODE -ne 0) { throw "JavaScript protection failed: $file" }
  Move-Item -LiteralPath $outputPath -Destination $inputPath -Force
  & node --check $inputPath
  if ($LASTEXITCODE -ne 0) { throw "Protected JavaScript is invalid: $file" }
}

foreach ($file in $cssFiles) {
  $inputPath = Join-Path $releaseDir $file
  $outputPath = "$inputPath.min.css"
  & npx.cmd --yes clean-css-cli --output $outputPath $inputPath
  if ($LASTEXITCODE -ne 0) { throw "CSS minification failed: $file" }
  Move-Item -LiteralPath $outputPath -Destination $inputPath -Force
}

if (Test-Path -LiteralPath $zipPath) {
  Remove-Item -LiteralPath $zipPath -Force
}
Compress-Archive -Path (Join-Path $releaseDir '*') -DestinationPath $zipPath -CompressionLevel Optimal
Write-Output $zipPath
