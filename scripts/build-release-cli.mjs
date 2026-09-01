import {execSync} from 'node:child_process';
import {createHash} from 'node:crypto';
import {mkdirSync, readFileSync, writeFileSync, copyFileSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(import.meta.dirname, '..');
const distDir = resolve(root, 'dist');
mkdirSync(distDir, {recursive: true});

console.log('Building optimized release CLI binary for macOS arm64...');
execSync('CC=/usr/bin/cc PATH="/usr/bin:/bin:/usr/sbin:/sbin:$PATH" cargo build --release -p smallframe-cli --bin smallframe-cli', {
  cwd: root,
  stdio: 'inherit',
});

const builtBinaryPath = resolve(root, 'target/release/smallframe-cli');
const binaryPath = resolve(distDir, 'smallframe');
copyFileSync(builtBinaryPath, binaryPath);

const archivePath = resolve(distDir, 'smallframe-macos-arm64.tar.gz');

console.log('Packaging release archive...');
execSync(`tar -czf "${archivePath}" -C "${distDir}" smallframe`, {
  stdio: 'inherit',
});

const archiveBytes = readFileSync(archivePath);
const sha256 = createHash('sha256').update(archiveBytes).digest('hex');
const checksumPath = resolve(distDir, 'smallframe-macos-arm64.tar.gz.sha256');
writeFileSync(checksumPath, `${sha256}  smallframe-macos-arm64.tar.gz\n`);

console.log(`Release archive generated: ${archivePath}`);
console.log(`SHA-256 Checksum: ${sha256}`);
