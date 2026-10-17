#!/usr/bin/env node
'use strict';
/**
 * 从公开源码树构建 Windows x64「解压即用」Release ZIP。
 *
 * 用法：npm run release:zip
 * 产物：release/MCSoundStudio-<version>-win-x64.zip
 *
 * 本脚本只生成免安装目录版：先调用 electron-builder --dir，再把整个
 * dist/win-unpacked 收进一个根目录为 MCSoundStudio/ 的 ZIP。不调用 NSIS，
 * 不创建快捷方式，也不会把 data/、exports/ 或任何既有运行数据打进 ZIP。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const archiver = require('archiver');

const ROOT = path.resolve(__dirname, '..');
const pkg = require(path.join(ROOT, 'package.json'));
const PRODUCT = (pkg.build && pkg.build.productName) || 'MCSoundStudio';
const VERSION = pkg.version || '0.0.0';
const SOURCE_DIR = path.join(ROOT, 'dist', 'win-unpacked');
const RELEASE_DIR = path.join(ROOT, 'release');
const ZIP_NAME = `${PRODUCT}-${VERSION}-win-x64.zip`;
const ZIP_PATH = path.join(RELEASE_DIR, ZIP_NAME);
const FORBIDDEN_TOP_LEVEL = new Set(['data', 'userdata', 'exports']);

function fail(message) {
  console.error(`❌ ${message}`);
  process.exitCode = 1;
}

function walk(dir) {
  const result = { files: 0, bytes: 0, ogg: 0 };
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        const size = fs.statSync(full).size;
        result.files += 1;
        result.bytes += size;
        if (entry.name.toLowerCase().endsWith('.ogg')) result.ogg += 1;
      }
    }
  }
  return result;
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function buildUnpacked() {
  // 用 node 直接跑 electron-builder 的 CLI 入口，不走 .cmd + shell：
  // 仓库路径里带空格时，shell 会在空格处截断命令，导致「不是内部或外部命令」。
  const cli = path.join(ROOT, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js');
  if (!fs.existsSync(cli)) {
    throw new Error('没有找到本地 electron-builder；请先执行 npm ci。');
  }
  const result = spawnSync(process.execPath, [cli, '--win', '--x64', '--dir'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) throw new Error(`electron-builder --dir 失败（退出码 ${result.status}）。`);
}

function assertSource() {
  const exePath = path.join(SOURCE_DIR, `${PRODUCT}.exe`);
  if (!fs.existsSync(exePath)) throw new Error(`构建后没有找到 ${exePath}`);
  const forbidden = fs.readdirSync(SOURCE_DIR, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && FORBIDDEN_TOP_LEVEL.has(entry.name.toLowerCase()))
    .map((entry) => entry.name);
  if (forbidden.length) {
    throw new Error(`拒绝打包运行时数据目录：${forbidden.join('、')}。请关闭程序并删除 dist/win-unpacked 中的这些目录后重试。`);
  }
  const audioDir = path.join(SOURCE_DIR, 'resources', 'sounds', 'vanilla', 'audio');
  const audio = fs.existsSync(audioDir) ? walk(audioDir) : { ogg: 0 };
  if (!audio.ogg) throw new Error('构建产物内置音频为 0 个 .ogg；拒绝生成用户侧无法试听的 Release ZIP。');
  return { exePath, audio };
}

function makeZip() {
  fs.mkdirSync(RELEASE_DIR, { recursive: true });
  fs.rmSync(ZIP_PATH, { force: true });
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(ZIP_PATH);
    const archive = archiver('zip', { zlib: { level: 9 } });
    output.on('close', resolve);
    output.on('error', reject);
    archive.on('warning', reject);
    archive.on('error', reject);
    archive.pipe(output);
    // 指定目标名，确保 ZIP 根目录只有一个 MCSoundStudio/ 应用目录。
    archive.directory(SOURCE_DIR, PRODUCT);
    // 随包附上许可与第三方内容说明（壳外文档，不属于 electron-builder 产物）。
    for (const doc of ['LICENSE', 'THIRD_PARTY_NOTICES.txt', 'README.md']) {
      const docPath = path.join(ROOT, doc);
      if (fs.existsSync(docPath)) archive.file(docPath, { name: `${PRODUCT}/${doc}` });
    }
    archive.finalize();
  });
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Release ZIP 只支持在 Windows 上构建。');
  console.log(`=== 构建 ${ZIP_NAME}（免安装、解压即用）===`);
  buildUnpacked();
  const { exePath, audio } = assertSource();
  const source = walk(SOURCE_DIR);
  console.log(`目录版：${source.files} 个文件 / ${source.bytes} 字节 / 内置 ${audio.ogg} 个 .ogg`);
  await makeZip();
  const zipSize = fs.statSync(ZIP_PATH).size;
  console.log(`✅ Release ZIP: ${ZIP_PATH}`);
  console.log(`ZIP 字节数 : ${zipSize}`);
  console.log(`ZIP SHA-256: ${sha256(ZIP_PATH)}`);
  console.log(`EXE SHA-256: ${sha256(exePath)}`);
}

main().catch((error) => {
  fail(error && error.message ? error.message : String(error));
});
