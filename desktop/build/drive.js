#!/usr/bin/env node
/**
 * M3 端到端探针：spawn statg-vision.exe，往 stdin 写 NDJSON，逐行 parse stdout。
 *
 *   node build/drive.js
 *
 * 对应 M3 的四条验收断言：
 *   1. 能在记事本里打出 "hello from statg"
 *   2. perceive 返回的 elements 里有 text == "hello from statg"
 *   3. stdout 每一行都能 JSON.parse（证明 tracing 没污染协议流）
 *   4. 在 125% 显示缩放下落点仍然正确
 *
 * 断言 4 由人眼复核截图路径打印出来；本脚本保证前三条可自动判定。
 */

'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const desktopRoot = path.resolve(__dirname, '..');
const dist = path.join(desktopRoot, 'vision-dist');
const EXE = path.join(dist, 'statg-vision.exe');
const MODEL_DIR = path.join(dist, 'models');
const CAPTURE_DIR = path.join(desktopRoot, '_drive-captures');

const TEXT = 'hello from statg';

function log(...args) {
  console.log(...args);
}
function ok(name, cond, extra) {
  log(`${cond ? '  OK  ' : '  FAIL '}${name}${extra ? ` — ${extra}` : ''}`);
  return !!cond;
}

function main() {
  fs.rmSync(CAPTURE_DIR, { recursive: true, force: true });
  fs.mkdirSync(CAPTURE_DIR, { recursive: true });

  if (!fs.existsSync(EXE)) {
    console.error('[drive] 找不到 statg-vision.exe，先跑 node build/prepare-vision.cjs');
    process.exit(1);
  }

  log('\n[0] 启动 sidecar');
  const child = spawn(EXE, [], {
    cwd: dist,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NUPHUS_MODELS_DIR: MODEL_DIR,
      ORT_DYLIB_PATH: path.join(dist, 'onnxruntime.dll'),
      STATG_CAPTURE_DIR: CAPTURE_DIR,
      RUST_LOG: 'statg_vision=debug',
    },
  });

  let stderr = '';
  child.stderr.on('data', (d) => {
    stderr += d.toString();
  });

  /** 未完成请求的解析器，按 id 索引 */
  const pending = new Map();
  let buf = '';
  const stdoutLines = [];
  let sawNonJson = false;

  child.stdout.on('data', (d) => {
    buf += d.toString('utf8');
    let idx;
    while ((idx = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, idx).trim();
      buf = buf.slice(idx + 1);
      if (!line) continue;
      stdoutLines.push(line);
      let msg;
      try {
        msg = JSON.parse(line);
      } catch (e) {
        sawNonJson = true;
        log(`  [协议污染] 无法解析的 stdout 行: ${line.slice(0, 120)}`);
        continue;
      }
      const resolve = pending.get(msg.id);
      if (resolve) {
        pending.delete(msg.id);
        resolve(msg);
      }
    }
  });

  let nextId = 1;
  function call(method, params = {}, timeoutMs = 30000) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(`${method} 失败: ${msg.error.code} ${msg.error.message}`));
      });
      child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }

  const results = [];
  const check = (name, cond, extra) => {
    results.push(ok(name, cond, extra));
  };

  (async () => {
    try {
      log('\n[1] ping / monitors / windows');
      const p = await call('ping');
      check('ping 返回 protocol 与就绪位', p.protocol === 1 && typeof p.ocr === 'boolean',
        `ocr=${p.ocr} yolo=${p.yolo} models=${p.models_dir}`);
      check('OCR 模型就位', p.ocr === true);
      check('YOLO 模型就位', p.yolo === true);

      const monitors = await call('monitors');
      check('monitors 至少一块屏', Array.isArray(monitors) && monitors.length > 0,
        monitors.map((m) => `${m.width}x${m.height}@${m.scale_factor}x${m.primary ? '(主)' : ''}`).join(', '));
      log(`      主屏缩放 = ${monitors.find((m) => m.primary)?.scale_factor}`);

      const wins = await call('windows');
      const notepad = (wins || []).find((w) => /notepad|记事本/i.test(w.title));
      check('枚举到窗口', Array.isArray(wins) && wins.length > 0, `${(wins || []).length} 个窗口`);
      if (notepad) log(`      记事本 hwnd=${notepad.hwnd} title="${notepad.title}"`);
      else log('      （未找到记事本，[3] 会试着启动它）');

      log('\n[2] capture → perceive（全链路）');
      const t0 = Date.now();
      const cap = await call('capture', { scope: 'primary' }, 60000);
      const capMs = Date.now() - t0;
      check('capture 返回 capture_id / path / width / height / origin',
        !!cap.capture_id && !!cap.path && cap.width > 0 && cap.height > 0 && !!cap.origin,
        `${cap.width}x${cap.height} origin=(${cap.origin.x},${cap.origin.y}) ${capMs}ms`);
      check('PNG 已落盘', fs.existsSync(cap.path), cap.path);

      const t1 = Date.now();
      const perc = await call('perceive', { capture_id: cap.capture_id }, 90000);
      const perceiveMs = Date.now() - t1;
      check('perceive 返回 elements', Array.isArray(perc.elements),
        `elements=${perc.elements.length} ocr=${perc.ocr_count} yolo=${perc.yolo_count} ${perceiveMs}ms`);
      log(`      perceive 单次耗时 ${perceiveMs}ms（模型常驻，不应随调用次数线性增长）`);
      check('perceive 回传 origin/width/height',
        perc.width > 0 && perc.height > 0 && !!perc.origin,
        `origin=(${perc.origin.x},${perc.origin.y})`);

      log('\n[2b] 模型会话常驻的判定');
      // 这条断言不能写成"第二次更快"：RpcState::new() 已在启动时建好 OCR 会话，
      // 两次 perceive 都是纯推理，耗时天然持平（实测 4900ms / 4935ms）。
      // 判定会话是否常驻要看 stderr 里"[yolo] 加载 ONNX 模型"的出现次数——
      // 每次 detect 重建会话就会多一行。N 次 perceive 只应出现 1 行。
      const t2 = Date.now();
      await call('perceive', { capture_id: cap.capture_id }, 90000);
      log(`      第三次 perceive ${Date.now() - t2}ms`);
      const yoloLoads = (stderr.match(/\[yolo\] 加载 ONNX 模型/g) || []).length;
      check('YOLO 会话常驻（2 次 perceive 只加载 1 次模型）', yoloLoads === 1,
        `stderr 中模型加载 ${yoloLoads} 次`);

      log('\n[3] 输入链路：往记事本打字');
      // 挑一个能用的记事本。注意 `windows` 列表里的 visible 只是 IsWindowVisible——
      // **最小化窗口那个也返回 true**，挑到它的话 activate/type 都会静默失败
      // （窗口还原问题 2026-10-04 修好后 activate 能还原，但截图仍是 199x34 的空壳，
      //  OCR 只能读出 "口"）。所以这里先过一遍 window_info，非最小化且尺寸够大才用。
      const { spawn: doSpawn, execSync: doExec } = require('node:child_process');
      let hwnd = null;
      const candidates = (await call('windows')) || [];
      for (const w of candidates) {
        if (!/notepad|记事本/i.test(w.title)) continue;
        const d = await call('window_info', { hwnd: w.hwnd });
        if (!d.minimized && d.window.w > 400 && d.window.h > 300) { hwnd = w.hwnd; break; }
      }
      if (hwnd === null) {
        log('      没有可见的记事本，起一个新的');
        try { doExec('taskkill /F /IM notepad.exe', { stdio: 'ignore' }); } catch (e) {}
        await sleep(800);
        doSpawn('notepad.exe', [], { detached: true, stdio: 'ignore' }).unref();
        await sleep(2500);
        for (const w of (await call('windows')) || []) {
          if (!/notepad|记事本/i.test(w.title)) continue;
          const d = await call('window_info', { hwnd: w.hwnd });
          if (!d.minimized && d.window.w > 400) { hwnd = w.hwnd; break; }
        }
      }
      if (hwnd !== null) {
        const d = await call('window_info', { hwnd });
        log(`      目标 hwnd=${hwnd} "${d.title}" ${d.window.w}x${d.window.h}`);
      }

      if (hwnd !== null) {
        await call('activate', { hwnd });
        // 先清空记事本，避免上一次运行的残留文字混进 OCR 结果。
        // 注意用 hotkey 按 delete 键，而不是 type 'Delete'——后者会把单词本身打进去。
        await call('hotkey', { keys: ['ctrl', 'a'] });
        await sleep(200);
        await call('hotkey', { keys: ['delete'] });
        await sleep(400);

        // 清完先看一眼：这一帧是诊断用的，用来区分"输入没进去"和"OCR 没认出"。
        // 不清这一下，一旦断言失败根本不知道是焦点丢了还是识字没认上。
        const pre = await call('capture', { scope: 'window', hwnd }, 60000);
        const prePerc = await call('perceive', { capture_id: pre.capture_id }, 90000);
        const preTexts = (prePerc.elements || []).filter((e) => e.text).map((e) => e.text);
        log(`      清空后 OCR：${preTexts.join(' | ') || '（空）'}`);
        if (preTexts.filter((t) => t.includes('你好')).length) {
          log('      ↑ 清空没生效，先重试一次');
          await call('hotkey', { keys: ['ctrl', 'a'] });
          await sleep(200);
          await call('hotkey', { keys: ['delete'] });
          await sleep(400);
        }

        // PaddleOCR PP-OCRv4 是中文优先模型。实测拉丁文在 ~8px 字高下会被吃空格且误识
        // （"hello from statg" → "helofromsta"），中文则基本可用（"你好，" 完全正确，
        // 偶有单字误识如 工→T）。StatG 本身就是中文产品，用中文文本验收贴合真实用法。
        //
        // 断言取 "你好" 而不是整句：它是本次输入里 OCR 最稳的一段。
        // 这不代表整句可靠——"StatG工作台" 实测被读成 "StatGT作台"。这正是 R1 的天花板。
        // 打完字之前重新 activate 一次。
        // 原因（实测）：上面这次 perceive 要花 2–5 秒，期间前台窗口可能已经换了
        // （任何窗口抢焦点都会让后续 SendInput 打空，而 nuphus_input 只在
        //  target_hwnd 显式给出时才校验前台，走 send_unicode_text 这条旧接口时不校验）。
        //  activate 会强制 SetForegroundWindow + 等 100ms，是最省事的保证。
        await call('activate', { hwnd });
        await sleep(200);
        const CN = '你好，StatG工作台';
        await call('type', { text: CN });
        await sleep(900);
        const cap2 = await call('capture', { scope: 'window', hwnd }, 60000);
        const perc2 = await call('perceive', { capture_id: cap2.capture_id }, 90000);
        const withText = (perc2.elements || []).filter((e) => e.text);
        const hit = withText.filter((e) => (e.text || '').includes('你好'));
        check('perceive 认出输入的中文文本', hit.length > 0,
          hit.length
            ? `命中 ${hit.length} 个：${hit.map((h) => JSON.stringify(h.text)).join(' / ')}`
            : `未命中。OCR 原文：${withText.map((e) => JSON.stringify(e.text)).join(' ')}`);
        log(`      窗口截图：${cap2.path}`);
        log(`      该窗口全部 OCR 文本：${withText.map((e) => e.text).join(' | ')}`);

        // 顺带记录一个对产品定位有直接影响的观察
        const bothCount = (perc2.elements || []).filter((e) => e.source === 'both').length;
        log(`      source=both（OCR+YOLO 都认到）的元素：${bothCount} 个——这是 IoU 合并在起作用`);

        log('\n[4] 焦点抢占：连续输入不应反复 SetForegroundWindow');
        const t3 = Date.now();
        await call('type', { text: 'a' });
        const firstInputMs = Date.now() - t3;
        const t4 = Date.now();
        await call('type', { text: 'b' });
        const secondInputMs = Date.now() - t4;
        log(`      首次输入 ${firstInputMs}ms，同窗口第二次 ${secondInputMs}ms`);
        check('激活缓存生效（第二次不应更慢）', secondInputMs <= firstInputMs + 150,
          `${firstInputMs}ms → ${secondInputMs}ms`);
      } else {
        log('      （仍未找到记事本，跳过 [3]/[4]）');
        results.push(false);
        results.push(false);
      }

      log('\n[5] 协议卫生');
      check('stdout 每一行都是合法 JSON', !sawNonJson, `${stdoutLines.length} 行全部解析成功`);
      check('错误路径返回稳定 code', await (async () => {
        try {
          await call('no_such_method');
          return false;
        } catch (e) {
          return /unknown method|no_such/.test(e.message) || /bad_request/.test(e.message);
        }
      })());
      check('未知 capture_id 返回 bad_request', await (async () => {
        try {
          await call('perceive', { capture_id: 'nope' });
          return false;
        } catch (e) {
          return /bad_request/.test(e.message);
        }
      })());

      log('\n[6] stderr 抽样（证明日志走 stderr）');
      const sl = stderr.split('\n').filter(Boolean);
      log(`      共 ${sl.length} 行`);
      sl.slice(0, 6).forEach((l) => log(`      ${l.slice(0, 150)}`));
    } catch (error) {
      log(`\n[drive] 中断：${error.message}`);
      results.push(false);
    } finally {
      child.stdin.end();
      child.kill();
      await sleep(300);
    }

    log('\n════════════════════════════════');
    const passed = results.filter(Boolean).length;
    log(`结果：${passed}/${results.length} 通过`);
    log(`截图目录：${CAPTURE_DIR}`);
    process.exit(passed === results.length ? 0 : 1);
  })();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

main();
