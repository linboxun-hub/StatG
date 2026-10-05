#!/usr/bin/env node
/**
 * 感知探针：把一次 perceive 的元素表打全，用于判断 OCR 到底是"没识别"还是"识别了但被切碎"。
 *   node build/probe-perceive.js
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const dist = path.join(desktopRoot, 'vision-dist');
const EXE = path.join(dist, 'statg-vision.exe');
const MODEL_DIR = path.join(dist, 'models');
const CAPTURE_DIR = path.join(desktopRoot, '_probe-captures');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function main() {
  fs.rmSync(CAPTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });

  const child = spawn(EXE, [], {
    cwd: dist,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NUPHUS_MODELS_DIR: MODEL_DIR,
      ORT_DYLIB_PATH: path.join(dist, 'onnxruntime.dll'),
      STATG_CAPTURE_DIR: CAPTURE_DIR,
    },
  });
  child.stderr.resume();

  const pending = new Map();
  let buf = '';
  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try {
        const m = JSON.parse(line);
        pending.get(m.id)?.(m);
        pending.delete(m.id);
      } catch {}
    }
  });

  let id = 1;
  const call = (method, params = {}, ms = 90000) =>
    new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error(`${method} 超时`)), ms);
      pending.set(id, (m) => {
        clearTimeout(t);
        m.ok ? res(m.result) : rej(new Error(m.error.message));
      });
      child.stdin.write(JSON.stringify({ id: id++, method, params }) + '\n');
    });

  (async () => {
    try {
      const wins = (await call('windows')) || [];
      const np = wins.find((w) => /notepad|记事本/i.test(w.title));
      console.log(`记事本: ${np ? `hwnd=${np.hwnd} "${np.title}" ${np.width}x${np.height}` : '未找到'}`);

      const scope = np ? { scope: 'window', hwnd: np.hwnd } : { scope: 'primary' };
      console.log(`capture scope=${scope.scope} ...`);
      const cap = await call('capture', scope, 60000);
      console.log(`截图 ${cap.width}x${cap.height} origin=(${cap.origin.x},${cap.origin.y})`);

      const p = await call('perceive', { capture_id: cap.capture_id });
      console.log(`\nocr=${p.ocr_count} yolo=${p.yolo_count} elements=${p.elements.length}\n`);

      const withText = p.elements.filter((e) => e.text);
      console.log(`--- 有文字的 ${withText.length} 个元素 ---`);
      withText.forEach((e) => {
        console.log(
          `  #${String(e.id).padStart(3)} ${e.kind.padEnd(6)} ${e.source.padEnd(5)} conf=${e.confidence.toFixed(2)} ` +
            `rect=(${e.rect.x},${e.rect.y},${e.rect.w},${e.rect.h}) text=${JSON.stringify(e.text)}`,
        );
      });

      const hit = withText.filter((e) => e.text.includes('hello from statg'));
      const partial = withText.filter((e) => e.text.includes('statg') || e.text.includes('hello'));
      console.log(`\n完整命中 "hello from statg": ${hit.length}`);
      console.log(`部分命中: ${partial.length}`);
      partial.forEach((e) => console.log(`  ${JSON.stringify(e.text)}`));
      console.log(`\n截图文件: ${cap.path}`);
    } catch (e) {
      console.error('失败:', e.message);
      process.exitCode = 1;
    } finally {
      child.stdin.end();
      child.kill();
    }
  })();
}

main();
