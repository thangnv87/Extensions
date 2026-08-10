import fs from 'fs';
import path from 'path';
import {execFileSync} from 'child_process';
import {createHash} from 'crypto';
import {fileURLToPath} from 'url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const releaseDir = path.join(__dirname, 'release');
const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'manifest.json'), 'utf8'));
const zipName = `Podhub-GPTs-Bridge-v${manifest.version}.zip`;
const zipPath = path.join(__dirname, zipName);
const checksumPath = `${zipPath}.sha256`;
const javascriptFiles = [
  'background.js',
  'popup.js',
  'content.js',
  'marketplace.js'
];
const staticFiles = [
  'manifest.json',
  'popup.html',
  'popup.css',
  'content.css'
];

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
  throw new Error(`[release] ${message}`);
}

function sha256(filePath) {
  return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function assertFile(file) {
  const filePath = path.join(__dirname, file);
  if (!fs.existsSync(filePath)) fail(`Missing required file: ${file}`);
  return filePath;
}

function scanSecrets(files) {
  for (const file of files) {
    const source = fs.readFileSync(assertFile(file), 'utf8');
    for (const {label, pattern} of secretPatterns) {
      pattern.lastIndex = 0;
      if (pattern.test(source)) fail(`${label} found in ${file}`);
    }
  }
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

console.log(`[release] Building ${manifest.name} v${manifest.version}`);
for (const file of javascriptFiles) {
  execFileSync(process.execPath, ['--check', file], {cwd: __dirname, stdio: 'inherit'});
}
scanSecrets([...javascriptFiles, ...staticFiles]);

for (const file of manifestFiles()) assertFile(file);

fs.rmSync(releaseDir, {recursive: true, force: true});
fs.mkdirSync(releaseDir, {recursive: true});

for (const file of staticFiles) {
  fs.copyFileSync(path.join(__dirname, file), path.join(releaseDir, file));
}

for (const file of javascriptFiles) {
  const source = fs.readFileSync(path.join(__dirname, file), 'utf8');
  const result = JavaScriptObfuscator.obfuscate(source, obfuscatorOptions);
  fs.writeFileSync(path.join(releaseDir, file), result.getObfuscatedCode(), 'utf8');
}

for (const file of javascriptFiles) {
  const releaseFile = path.join(releaseDir, file);
  execFileSync(process.execPath, ['--check', releaseFile], {stdio: 'inherit'});
  const code = fs.readFileSync(releaseFile, 'utf8');
  if (/\beval\s*\(|new\s+Function\s*\(/.test(code)) {
    fail(`MV3-incompatible dynamic code found in release/${file}`);
  }
  if (code === fs.readFileSync(path.join(__dirname, file), 'utf8')) {
    fail(`${file} was copied without obfuscation`);
  }
}

for (const file of manifestFiles()) {
  if (!fs.existsSync(path.join(releaseDir, file))) fail(`Manifest target missing from release: ${file}`);
}

fs.rmSync(zipPath, {force: true});
fs.rmSync(checksumPath, {force: true});
execFileSync('zip', ['-X', '-qr', zipPath, '.'], {cwd: releaseDir});

const checksum = sha256(zipPath);
fs.writeFileSync(checksumPath, `${checksum}  ${zipName}\n`, 'utf8');

const zipListing = execFileSync('unzip', ['-Z1', zipPath], {encoding: 'utf8'})
  .trim()
  .split('\n')
  .filter(Boolean);
const expectedFiles = [...staticFiles, ...javascriptFiles].sort();
if (JSON.stringify(zipListing.sort()) !== JSON.stringify(expectedFiles)) {
  fail(`Unexpected ZIP contents: ${zipListing.join(', ')}`);
}

console.log(`[release] ZIP: ${zipPath}`);
console.log(`[release] SHA-256: ${checksum}`);
console.log(`[release] Files: ${expectedFiles.length}`);
