#!/usr/bin/env node
/**
 * 专门验 restore_if_minimized：先手动把记事本最小化，再让 sidecar 的 activate 去还原。
 *   node build/probe-restore.js
 *
 * 背景：SetForegroundWindow 不会还原最小化窗口。修复前实测是
 * activate 返回 ok → type 返回 "已输入 N 字" → 但窗口仍是最小化，
 * PNG 里只有一个 199x34 的空壳，OCR 读出 "口"——**静默失败，全程无报错**。
 */

'use strict';

const { spawn, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const dist = path.resolve(__dirname, '..', 'vision-dist');
const EXE = path.join(dist, 'statg-vision.exe');
const CAP = path.resolve(__dirname, '..', '_probe-captures');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

fs.rmSync(CAP, { recursive: true, force: true });
fs.mkdirSync(CAP, { recursive: true });

const child = spawn(EXE, [], {
  cwd: dist,
  windowsHide: true,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: {
    ...process.env,
    NUPHUS_MODELS_DIR: path.join(dist, 'models'),
    ORT_DYLIB_PATH: path.join(dist, 'onnxruntime.dll'),
    STATG_CAPTURE_DIR: CAP,
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
const call = (m, p = {}, ms = 90000) =>
  new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error(`${m} 超时`)), ms);
    pending.set(id, (x) => {
      clearTimeout(t);
      x.ok ? res(x.result) : rej(new Error(x.error.message));
    });
    child.stdin.write(JSON.stringify({ id: id++, method: m, params: p }) + '\n');
  });

(async () => {
  const results = [];
  const ok = (n, c, e) => { console.log(`${c ? '  OK  ' : '  FAIL '}${n}${e ? ` — ${e}` : ''}`); results.push(!!c); };

  // 找一个记事本；没有就起一个并最小化它
  let np = null;
  for (const w of (await call('windows')) || []) {
    if (/notepad|记事本/i.test(w.title)) { np = w; break; }
  }
  if (!np) {
    require('node:child_process').spawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
    await sleep(2500);
    for (const w of (await call('windows')) || []) {
      if (/notepad|记事本/i.test(w.title)) { np = w; break; }
    }
  }
  if (!np) { console.error('没有记事本可用'); process.exit(1); }

  // 主动把它最小化
  try {
    execSync('powershell -NoProfile -Command "Add-Type -TypeDefinition \'using System;using System.Runtime.InteropServices;public class Z{[DllImport(\\\"user32.dll\\\")]public static extern bool ShowWindow(IntPtr h,int c);}\'; $p=Get-Process notepad|Select-Object -First 1; [Z]::ShowWindow($p.MainWindowHandle,6)"', { stdio: 'ignore' });
  } catch (e) { console.log('  （最小化调用失败，可能已是最小化）'); }
  await sleep(1500);

  const before = await call('window_info', { hwnd: np.hwnd });
  ok('测试前置：窗口确实是最小化的', before.minimized === true,
    `rect=${before.window.w}x${before.window.h} @(${before.window.x},${before.window.y})`);

  await call('activate', { hwnd: np.hwnd });
  await sleep(600);
  const after = await call('window_info', { hwnd: np.hwnd });
  ok('activate 还原了最小化窗口', after.minimized === false,
    `rect=${after.window.w}x${after.window.h} @(${after.window.x},${after.window.y})`);

  if (after.minimized === false) {
    await call('type', { text: '还原后输入' });
    await sleep(800);
    const cap = await call('capture', { scope: 'window', hwnd: np.hwnd }, 60000);
    const perce = await call('perceive', { capture_id: cap.capture_id });
    const texts = (perce.elements || []).filter((e) => e.text).map((e) => e.text);
    ok('还原后打字能落到窗口里', texts.some((t) => t.includes('还原') || t.includes('输入')),
      texts.join(' | '));
    console.log(`      截图尺寸 ${cap.width}x${cap.height}`);
  }

  const passed = results.filter(Boolean).length;
  console.log(`\n结果：${passed}/${results.length} 通过`);
  if (stderr.trim()) console.log('stderr:', stderr.slice(-800));
  child.stdin.end(); child.kill();
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => { console.error('失败:', e.message); process.exit(1); });
