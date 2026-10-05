#!/usr/bin/env node
/**
 * 输入诊断：把 type 这一路的每一步都摊开看。
 *   node build/probe-input.js
 *
 * 已知事实（2026-10-04）：同一个 sidecar，test-integration.js 里
 * activate → ctrl+a → delete → sleep 200 → type 能成功；
 * drive.js 里 activate → ... → perceive(5s) → activate → type 失败，
 * 且 type 不报错、窗口确实是空的。所以要看的是中间到底哪一步断了。
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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
      RUST_LOG: 'warn',
    },
  });
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d.toString(); });

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
        m.ok ? res(m.result) : rej(new Error(`${m.error.code}: ${m.error.message}`));
      });
      child.stdin.write(JSON.stringify({ id: id++, method, params }) + '\n');
    });

  (async () => {
    try {
      const wins = (await call('windows')) || [];
      // 排除最小化的：window_info 的 minimized 才是真相，windows 列表里的 visible
      // 只是 IsWindowVisible——最小化窗口那个也返回 true，光看它会挑到一个看不见的。
      let np = null;
      for (const w of wins) {
        if (!/notepad|记事本/i.test(w.title)) continue;
        const d = await call('window_info', { hwnd: w.hwnd });
        console.log(`  候选 hwnd=${w.hwnd} minimized=${d.minimized} ${d.window.w}x${d.window.h}`);
        if (!d.minimized && d.window.w > 400) { np = w; break; }
      }
      if (!np) {
        console.log('  没有可用的可见记事本 → 关掉旧的，起一个新的');
        try {
          require('node:child_process').execSync('taskkill /F /IM notepad.exe', { stdio: 'ignore' });
        } catch (e) { /* 本来就没有 */ }
        await sleep(800);
        require('node:child_process').spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
        await sleep(2500);
        for (const w of (await call('windows')) || []) {
          if (!/notepad|记事本/i.test(w.title)) continue;
          const d = await call('window_info', { hwnd: w.hwnd });
          console.log(`  新候选 hwnd=${w.hwnd} minimized=${d.minimized} ${d.window.w}x${d.window.h}`);
          if (!d.minimized) { np = w; break; }
        }
      }
      console.log('记事本:', np ? `hwnd=${np.hwnd} "${np.title}" ${np.width}x${np.height}` : '未找到');
      if (!np) return;

      const info = await call('window_info', { hwnd: np.hwnd });
      console.log('window_info:', JSON.stringify(info));

      console.log('\n-- A. activate');
      console.log('  activate 前 minimized:', info.minimized, 'rect:', JSON.stringify(info.window));
      console.log('  activate →', JSON.stringify(await call('activate', { hwnd: np.hwnd })));
      const afterAct = await call('window_info', { hwnd: np.hwnd });
      console.log('  activate 后 minimized:', afterAct.minimized, 'rect:', JSON.stringify(afterAct.window));
      if (afterAct.minimized) {
        console.log('  ↑ activate 没能还原最小化窗口——这是 sidecar 要修的');
      }

      console.log('\n-- B. 清空（ctrl+a, delete）');
      await call('hotkey', { keys: ['ctrl', 'a'] });
      await sleep(150);
      await call('hotkey', { keys: ['delete'] });
      await sleep(300);

      console.log('\n-- C. 立即 type');
      const r1 = await call('type', { text: '第一次' });
      console.log('  type 返回:', JSON.stringify(r1));
      await sleep(800);
      const c1 = await call('capture', { scope: 'window', hwnd: np.hwnd }, 60000);
      const p1 = await call('perceive', { capture_id: c1.capture_id });
      console.log('  OCR:', (p1.elements || []).filter((e) => e.text).map((e) => e.text).join(' | ') || '（空）');

      console.log('\n-- D. 再清空 + 等 5 秒后再 type（复现 drive.js 的时序）');
      await call('hotkey', { keys: ['ctrl', 'a'] });
      await sleep(150);
      await call('hotkey', { keys: ['delete'] });
      await sleep(300);
      await call('capture', { scope: 'window', hwnd: np.hwnd }, 60000);
      await call('perceive', { capture_id: (await call('capture', { scope: 'window', hwnd: np.hwnd }, 60000)).capture_id });
      await sleep(3000);
      console.log('  （已过若干秒）');
      const r2 = await call('type', { text: '第二次' });
      console.log('  type 返回:', JSON.stringify(r2));
      await sleep(800);
      const c2 = await call('capture', { scope: 'window', hwnd: np.hwnd }, 60000);
      const p2 = await call('perceive', { capture_id: c2.capture_id });
      console.log('  OCR:', (p2.elements || []).filter((e) => e.text).map((e) => e.text).join(' | ') || '（空）');

      console.log('\n-- E. 不 activate，直接连着 type 第三次');
      const r3 = await call('type', { text: '第三次' });
      console.log('  type 返回:', JSON.stringify(r3));
      await sleep(800);
      const c3 = await call('capture', { scope: 'window', hwnd: np.hwnd }, 60000);
      const p3 = await call('perceive', { capture_id: c3.capture_id });
      console.log('  OCR:', (p3.elements || []).filter((e) => e.text).map((e) => e.text).join(' | ') || '（空）');

      if (stderr.trim()) console.log('\n-- stderr --\n' + stderr.trim());
    } catch (e) {
      console.error('失败:', e.message);
      if (stderr.trim()) console.error('stderr:', stderr.slice(-1500));
      process.exitCode = 1;
    } finally {
      child.stdin.end();
      child.kill();
    }
  })();
}

main();
