#!/usr/bin/env node
/**
 * 集成测试：通过 build/vision.js（Electron 实际会走的那层）驱动 sidecar。
 *
 *   node build/test-integration.js
 *
 * build/vision.js 里的 userDataDir() 在 Electron 之外有兜底，所以本脚本能在
 * 不启动 Electron 的前提下跑通整条链路——这也是它适合进 CI 的原因。
 *
 * 覆盖：
 *   - enable/disable 生命周期（enable 拉起并探活，disable 杀进程）
 *   - 白名单：ALLOWED 之外的方法要拒绝
 *   - capture → perceive 全链路，并验证 readCapture 能读回 PNG
 */

'use strict';

const path = require('node:path');
const fs = require('node:fs');

const vision = require(path.resolve(__dirname, 'vision.js'));

const results = [];
function ok(name, cond, extra) {
  console.log(`${cond ? '  OK  ' : '  FAIL '}${name}${extra ? ` — ${extra}` : ''}`);
  results.push(!!cond);
}
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log('\n[1] available 报告');
  const avail = vision.isAvailable();
  ok('build/vision.js 找到 sidecar', avail);
  if (!avail) {
    console.error('  先跑 node build/prepare-vision.cjs');
    process.exit(1);
  }

  console.log('\n[2] 完整链路');
  await vision.setEnabled(true);
  const info = await vision.call('ping');
  ok('ping', info.protocol === 1 && info.ocr === true && info.yolo === true,
    `ocr=${info.ocr} yolo=${info.yolo}`);

  const mons = await vision.call('monitors');
  ok('monitors', mons.length > 0,
    mons.map((m) => `${m.width}x${m.height}@${m.scale_factor}x`).join(', '));

  const wins = await vision.call('windows');
  ok('windows', wins.length > 0, `${wins.length} 个窗口`);

  // 与 drive.js 同一条规矩：窗口列表里的 visible 只是 IsWindowVisible，
  // 最小化窗口也返回 true。必须用 window_info 的 minimized 筛，否则会挑到
  // 一个看不见的目标，之后 activate/type/capture 全线静默失效。
  const { execSync, spawn: doSpawn } = require('node:child_process');
  let np = null;
  for (const w of wins) {
    if (!/notepad|记事本/i.test(w.title)) continue;
    const d = await vision.call('window_info', { hwnd: w.hwnd });
    if (!d.minimized && d.window.w > 400 && d.window.h > 300) { np = w; break; }
  }
  if (!np) {
    console.log('  （没有可见的记事本，起一个新的）');
    try { execSync('taskkill /F /IM notepad.exe', { stdio: 'ignore' }); } catch (e) {}
    await sleep(800);
    doSpawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
    await sleep(2500);
    for (const w of (await vision.call('windows')) || []) {
      if (!/notepad|记事本/i.test(w.title)) continue;
      const d = await vision.call('window_info', { hwnd: w.hwnd });
      if (!d.minimized && d.window.w > 400) { np = w; break; }
    }
  }
  if (!np) {
    console.log('  （没有记事本，跳过输入链路）');
    results.push(false);
    results.push(false);
  } else {
    await vision.call('activate', { hwnd: np.hwnd });
    await vision.call('hotkey', { keys: ['ctrl', 'a'] });
    await vision.call('hotkey', { keys: ['delete'] });
    await sleep(200);

    const CN = '集成测试通过';
    await vision.call('type', { text: CN });
    await sleep(700);

    const cap = await vision.call('capture', { scope: 'window', hwnd: np.hwnd });
    ok('capture', !!cap.capture_id && cap.width > 0,
      `${cap.width}x${cap.height} origin=(${cap.origin.x},${cap.origin.y})`);

    const p = await vision.call('perceive', { capture_id: cap.capture_id });
    const texts = (p.elements || []).filter((e) => e.text).map((e) => e.text);
    const hit = texts.filter((t) => (t || '').includes('集成') || (t || '').includes('测试'));
    ok('perceive 认出输入的中文', hit.length > 0,
      `命中 ${hit.length}：${hit.map((t) => JSON.stringify(t)).join(' / ')}`);
    console.log(`      该窗口全部 OCR：${texts.join(' | ')}`);

    // 渲染进程拿图走 build/vision.js 的 readCapture()，它按 captureDir()/<id>.png 拼路径。
    // 这里必须拿 sidecar 返回的 cap.path 来对照——两者不一致就说明渲染进程读不到图。
    ok('截图 PNG 已落盘', fs.existsSync(cap.path), `path=${cap.path}`);
    const expectDir = path.join(
      process.env.APPDATA || process.env.HOME || process.cwd(),
      'StatG',
      'vision',
      'captures',
    );
    ok('截图落盘目录与 readCapture 一致',
      path.dirname(cap.path).toLowerCase() === expectDir.toLowerCase(),
      `sidecar 写 ${path.dirname(cap.path)}，readCapture 读 ${expectDir}`);
  }

  console.log('\n[3] 白名单');
  try {
    await vision.call('shutdown', {});
    ok('拒绝 ALLOWED 之外的方法', false, 'shutdown 竟然通过了');
  } catch (e) {
    ok('拒绝 ALLOWED 之外的方法', /白名单/.test(e.message), e.message);
  }

  console.log('\n[4] 错误语义');
  try {
    await vision.call('perceive', { capture_id: 'nope' });
    ok('未知 capture_id 报错', false);
  } catch (e) {
    ok('未知 capture_id 报错', /bad_request/.test(e.message), e.message);
  }

  console.log('\n[5] disable 生命周期');
  await vision.setEnabled(false);
  await sleep(500);
  let stopped = false;
  try {
    await vision.call('ping', {}, 3000);
  } catch (e) {
    stopped = true;
  }
  ok('disable 后进程被杀', stopped);

  console.log('\n════════════════════════════');
  const passed = results.filter(Boolean).length;
  console.log(`结果：${passed}/${results.length} 通过`);
  process.exit(passed === results.length ? 0 : 1);
}

main().catch((e) => {
  console.error('失败:', e.message);
  process.exit(1);
});
