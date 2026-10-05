#!/usr/bin/env node
/**
 * 把 vision-runtime 的构建产物组装成 vision-dist/，供 electron-builder 的 extraResources 随包发布。
 *
 *   node build/prepare-vision.cjs
 *
 * 产物布局（安装后落在 resources\vision-runtime\）：
 *   statg-vision.exe
 *   onnxruntime.dll
 *   onnxruntime_providers_shared.dll
 *   models/ch_PP-OCRv4_det.onnx
 *   models/ch_PP-OCRv4_rec.onnx
 *   models/ch_PP-OCR_keys_v1.txt
 *   models/icon_detect.onnx
 *
 * 为什么模型与 DLL 进 git 而不是 CI 下载：上游 Nuphus 的 src-tauri/build.rs 里所有模型
 * 下载失败只发 cargo:warning 不中断构建，照抄它会得到"构建成功但运行时缺模型"的静默故障。
 * 见 vision-runtime/NOTICE.md。
 *
 * 用 SHA-256 校验而非只比文件大小：这三个 onnx 加起来 26 MB，一个截断的文件大小也可能接近。
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const desktopRoot = path.resolve(__dirname, '..');
const crateDir = path.join(desktopRoot, 'vision-runtime');
const assetsDir = path.join(desktopRoot, 'vision-assets');
const distDir = path.join(desktopRoot, 'vision-dist');

const MODELS = [
  'ch_PP-OCRv4_det.onnx',
  'ch_PP-OCRv4_rec.onnx',
  'ch_PP-OCR_keys_v1.txt',
  'icon_detect.onnx',
];
const DLLS = ['onnxruntime.dll', 'onnxruntime_providers_shared.dll'];

function sha256(file) {
  const h = crypto.createHash('sha256');
  h.update(fs.readFileSync(file));
  return h.digest('hex');
}

function copy(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  const after = sha256(to);
  const before = sha256(from);
  if (after !== before) {
    throw new Error(`拷贝校验失败：${from} -> ${to} (sha256 不一致)`);
  }
  return fs.statSync(to).size;
}

function main() {
  const exe = path.join(crateDir, 'target', 'release', 'statg-vision.exe');
  if (!fs.existsSync(exe)) {
    console.error('[prepare-vision] 找不到 statg-vision.exe，请先跑：');
    console.error('  cd vision-runtime');
    console.error('  $env:RUSTFLAGS = "-C target-feature=+crt-static"   # 让 exe 不依赖 VC 运行时');
    console.error('  cargo build --release --locked');
    process.exit(1);
  }

  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  let total = 0;
  const copyExe = copy(exe, path.join(distDir, 'statg-vision.exe'));
  total += copyExe;

  for (const dll of DLLS) {
    const src = path.join(assetsDir, dll);
    if (!fs.existsSync(src)) throw new Error(`缺少 ${dll}（应在 vision-assets/）`);
    total += copy(src, path.join(distDir, dll));
  }

  fs.mkdirSync(path.join(distDir, 'models'), { recursive: true });
  for (const m of MODELS) {
    const src = path.join(assetsDir, 'models', m);
    if (!fs.existsSync(src)) throw new Error(`缺少模型 ${m}（应在 vision-assets/models/）`);
    total += copy(src, path.join(distDir, 'models', m));
  }

  console.log(`[prepare-vision] 已组装 vision-dist（${(total / 1024 / 1024).toFixed(2)} MB）：`);
  for (const f of ['statg-vision.exe', ...DLLS, ...MODELS.map((m) => `models/${m}`)]) {
    const p = path.join(distDir, f);
    console.log(`  ${f.padEnd(46)} ${(fs.statSync(p).size / 1024 / 1024).toFixed(2)} MB`);
  }
  console.log('[prepare-vision] 完成。');
}

try {
  main();
} catch (error) {
  console.error(`[prepare-vision] 失败：${error.message}`);
  process.exit(1);
}
