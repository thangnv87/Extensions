import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import JavaScriptObfuscator from 'javascript-obfuscator';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const releaseDir = path.join(__dirname, 'release');
if (!fs.existsSync(releaseDir)) {
  fs.mkdirSync(releaseDir, { recursive: true });
}

const filesToObfuscate = [
  'team-routing.js',
  'chatgpt.js',
  'marketplace-shared.js',
  'etsy.js',
  'etsy-grid.js',
  'amazon.js',
  'gemini.js',
  'background.js'
];
const obfuscatorOptions = {
  compact: true,
  controlFlowFlattening: true,
  controlFlowFlatteningThreshold: 0.5,
  deadCodeInjection: false,
  debugProtection: false,
  disableConsoleOutput: false,
  identifierNamesGenerator: 'hexadecimal',
  log: false,
  numbersToExpressions: true,
  renameGlobals: false,
  selfDefending: false,
  simplify: true,
  splitStrings: true,
  splitStringsChunkLength: 10,
  stringArray: true,
  stringArrayCallsTransform: true,
  stringArrayCallsTransformThreshold: 0.5,
  stringArrayEncoding: ['base64'],
  stringArrayIndexShift: true,
  stringArrayRotate: true,
  stringArrayShuffle: true,
  stringArrayWrappersCount: 1,
  stringArrayWrappersChainedCalls: true,
  stringArrayWrappersParametersMaxCount: 2,
  stringArrayWrappersType: 'variable',
  stringArrayThreshold: 0.75,
  unicodeEscapeSequence: false
};

console.log('🚀 Bắt đầu build & mã hóa bảo mật cho Podhub GPT Bridge...');

// 1. Copy manifest.json
fs.copyFileSync(path.join(__dirname, 'manifest.json'), path.join(releaseDir, 'manifest.json'));
console.log('✅ Đã copy manifest.json sang thư mục release/');

// 2. Obfuscate JS files
for (const file of filesToObfuscate) {
  const srcPath = path.join(__dirname, file);
  if (fs.existsSync(srcPath)) {
    console.log(`🔒 Đang mã hóa ${file}... (vui lòng đợi vài giây)`);
    const code = fs.readFileSync(srcPath, 'utf8');
    const obfuscationResult = JavaScriptObfuscator.obfuscate(code, obfuscatorOptions);
    fs.writeFileSync(path.join(releaseDir, file), obfuscationResult.getObfuscatedCode(), 'utf8');
    const origSize = (Buffer.byteLength(code, 'utf8') / 1024).toFixed(2);
    const newSize = (Buffer.byteLength(obfuscationResult.getObfuscatedCode(), 'utf8') / 1024).toFixed(2);
    console.log(`✨ Đã bảo mật xong ${file} (${origSize} KB -> ${newSize} KB)`);
  } else {
    console.warn(`⚠️ Không tìm thấy file ${file}`);
  }
}

console.log('\n🎉 Hoàn tất! Thư mục "release/" đã sẵn sàng để chia sẻ/bán cho khách hàng thương mại.');
