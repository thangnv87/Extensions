import fs from 'fs';
import path from 'path';
import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {fileURLToPath} from 'url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const profileId = String(process.argv[2] || 'tools').toLowerCase();
const profiles = {
  tools: {
    sourceFolder: 'Podhub-GPTs-Bridge-Clear',
    outputFolder: 'Podhub-GPTs-Bridge-Obfuscated',
    expectedName: 'Podhub GPTs Bridge',
    expectedOrigin: 'https://tools.podhub.space',
    zipPrefix: 'Podhub-GPTs-Bridge'
  },
  ex: {
    sourceFolder: 'Podhub-GPTs-Bridge-EX-Clear',
    outputFolder: 'Podhub-GPTs-Bridge-EX-Obfuscated',
    expectedName: 'Podhub GPTs Bridge EX',
    expectedOrigin: 'https://ex.podhub.space',
    zipPrefix: 'Podhub-GPTs-Bridge-EX'
  }
};
const profile = profiles[profileId];
if (!profile) throw new Error(`[release] Unknown profile: ${profileId}`);
const sourceDir = path.join(__dirname, profile.sourceFolder);
const outputDir = path.join(__dirname, profile.outputFolder);
const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
const zipName = `${profile.zipPrefix}-v${manifest.version}-Obfuscated.zip`;
const zipPath = path.join(__dirname, zipName);
const checksumPath = `${zipPath}.sha256`;

const javascriptFiles = [
  'service-worker.js',
  'bridge-v1-client.js',
  'background-source.js',
  'popup.js',
  'content.js',
  'marketplace.js',
  'ui-fix.js'
];
const staticFiles = ['manifest.json', 'popup.html', 'popup.css', 'content.css'];

const secretPatterns = [
  {label: 'GitHub token', pattern: /ghp_[A-Za-z0-9]{20,}/g},
  {label: 'Podhub Team API key', pattern: /phb_team_(?:live|test)_[A-Za-z0-9_-]{12,}/g},
  {label: 'private key', pattern: /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/g},
  {label: 'server password', pattern: /PodHubNopass/gi}
];

const obfuscatorOptions = {
  target: 'browser',
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.25,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 12,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.35,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 2,
  stringArrayWrappersType: 'variable',
  stringArrayThreshold: 0.7,
  unicodeEscapeSequence: false
};

function fail(message) {
  throw new Error(`[tools-release] ${message}`);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function sourcePath(file) {
  const filePath = path.join(sourceDir, file);
  if (!fs.existsSync(filePath)) fail(`Missing required source file: ${file}`);
  return filePath;
}

function manifestFiles() {
  const files = new Set([
    manifest.background?.service_worker,
    manifest.action?.default_popup,
    ...manifest.content_scripts.flatMap(script => [...(script.js || []), ...(script.css || [])])
  ]);
  files.delete(undefined);
  return [...files];
}

function scanSecrets(files) {
  for (const file of files) {
    const source = fs.readFileSync(sourcePath(file), 'utf8');
    for (const {label, pattern} of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) fail(`${label} found in ${file}`);
    }
  }
}

if (manifest.name !== profile.expectedName || manifest.version !== '0.1.9.5') {
  fail(`Unexpected manifest identity: ${manifest.name} v${manifest.version}`);
}

const sourceText = [...javascriptFiles, ...staticFiles]
  .map(file => fs.readFileSync(sourcePath(file), 'utf8'))
  .join('\n');
if (!sourceText.includes(profile.expectedOrigin)) {
  fail(`${profile.expectedOrigin} is missing from the clear source`);
}
const productionOrigins = [
  'https://tools.podhub.space',
  'https://ex.podhub.space',
  'https://api.fiercetee.com',
  'https://podhub.space'
];
const wrongOrigin = productionOrigins.find(origin => origin !== profile.expectedOrigin && sourceText.includes(origin));
if (wrongOrigin) {
  fail(`Unexpected production origin found in ${profileId} source: ${wrongOrigin}`);
}

for (const file of javascriptFiles) {
  execFileSync(process.execPath, ['--check', sourcePath(file)], {stdio: 'inherit'});
}
scanSecrets([...javascriptFiles, ...staticFiles]);
for (const file of manifestFiles()) sourcePath(file);

fs.rmSync(outputDir, {recursive: true, force: true});
fs.mkdirSync(outputDir, {recursive: true});

for (const file of staticFiles) {
  fs.copyFileSync(sourcePath(file), path.join(outputDir, file));
}

for (const file of javascriptFiles) {
  const source = fs.readFileSync(sourcePath(file), 'utf8');
  const result = JavaScriptObfuscator.obfuscate(source, obfuscatorOptions);
  fs.writeFileSync(path.join(outputDir, file), result.getObfuscatedCode(), 'utf8');
}

for (const file of javascriptFiles) {
  const outputFile = path.join(outputDir, file);
  execFileSync(process.execPath, ['--check', outputFile], {stdio: 'inherit'});
  const output = fs.readFileSync(outputFile, 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(output)) {
    fail(`MV3-incompatible dynamic code found in ${file}`);
  }
  if (output === fs.readFileSync(sourcePath(file), 'utf8')) {
    fail(`${file} was copied without obfuscation`);
  }
}

for (const file of manifestFiles()) {
  if (!fs.existsSync(path.join(outputDir, file))) {
    fail(`Manifest target missing from obfuscated output: ${file}`);
  }
}

fs.rmSync(zipPath, {force: true});
fs.rmSync(checksumPath, {force: true});
if (process.platform === 'win32') {
  const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;
  const command = `Compress-Archive -Path ${psQuote(path.join(outputDir, '*'))} -DestinationPath ${psQuote(zipPath)} -CompressionLevel Optimal`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command], {stdio: 'pipe'});
} else {
  execFileSync('zip', ['-X', '-qr', zipPath, '.'], {cwd: outputDir});
}

const zipListing = execFileSync(
  process.platform === 'win32' ? 'tar.exe' : 'unzip',
  process.platform === 'win32' ? ['-tf', zipPath] : ['-Z1', zipPath],
  {encoding: 'utf8'}
)
  .trim()
  .split(/\r?\n/)
  .filter(Boolean)
  .sort();
const expectedFiles = [...staticFiles, ...javascriptFiles].sort();
if (JSON.stringify(zipListing) !== JSON.stringify(expectedFiles)) {
  fail(`Unexpected ZIP contents: ${zipListing.join(', ')}`);
}

const checksum = sha256(zipPath);
fs.writeFileSync(checksumPath, `${checksum}  ${zipName}\n`, 'utf8');

console.log(`[tools-release] Clear source: ${sourceDir}`);
console.log(`[tools-release] Obfuscated output: ${outputDir}`);
console.log(`[tools-release] ZIP: ${zipPath}`);
console.log(`[tools-release] SHA-256: ${checksum}`);
console.log(`[tools-release] Files: ${expectedFiles.length}`);
