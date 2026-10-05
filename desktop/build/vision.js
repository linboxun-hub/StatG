// 桌面视觉 sidecar 的 Electron 主进程桥接层。
//
// 职责：
//   1. 找到随包发布的 statg-vision.exe（development 时回退到 desktop/vision-dist）
//   2. 以 stdio NDJSON 拉起它，包一个带 id 关联 + 超时的客户端
//   3. 通过 ipcMain.handle('vision:*') 暴露给渲染进程
//
// 三条设计约束，每条都对应这个 sidecar 的一处实现细节：
//   - **stdout 只走协议帧**，所以 sidecar 的日志必须走 stderr（main.rs 已用
//     `.with_writer(std::io::stderr)`）。这里把 stderr 收进 visionErr，启动失败时弹给用户。
//   - **不开端口**。Python 后端已经占 8000，静态服务器占 5180；main.js 的静态服务器
//     在端口占用时是直接 reject 并弹致命对话框退出的，不要再引入第三个可能冲突的端口。
//   - **默认关闭、用户显式开启**。一个能全局点击、全局打字的进程是真实攻击面，
//     语义照抄 Nuphus 的 system_automation 默认 false（代码不抄，见下）。
//
// 与 Python 后端的关系：如果将来 Python 真的要调桌面能力，正确路径是
// Python → HTTP → Electron 主进程 → stdio → sidecar，让主进程做唯一的守门人，
// 而不是把 sidecar 绑到 0.0.0.0 上让谁都能调。

'use strict';

const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

// 单条请求的默认超时。OCR 一次全屏 perceive 实测约 4.6 秒（1920x1200，
// det+rec 推理），所以默认放宽到 60 秒；输入类调用本身是毫秒级。
const DEFAULT_TIMEOUT_MS = 60000;

// 渲染进程可调用的方法白名单。不在这张表里的方法一律拒绝——
// sidecar 有 shutdown 这类能杀掉自己的方法，不能裸暴露。
const ALLOWED = new Set([
  'ping',
  'monitors',
  'windows',
  'window_info',
  'capture',
  'perceive',
  'ocr',
  'find_image',
  'find_color',
  'activate',
  'click',
  'move',
  'drag',
  'scroll',
  'type',
  'hotkey',
  'clipboard_read',
  'clipboard_write',
]);

let visionProc = null;
let visionErr = '';
let nextId = 1;
const pending = new Map();
let buf = '';
let enabled = false;       // 用户是否显式开启了桌面能力
let starting = null;       // 正在启动中的 Promise，避免并发拉起两份

function log() {
  console.log('[vision]', ...arguments);
}

// 截图落盘目录与 userData 下其它状态放一处。放在函数里而不是模块顶层：
// 这样本模块在 Electron 之外也能被 require（CI 冒烟、node -e 检查），
// 不至于因为拿不到 app 就整个加载失败。
function userDataDir() {
  try {
    const { app } = require('electron');
    if (app && typeof app.getPath === 'function') return app.getPath('userData');
  } catch (e) {
    // 不在 Electron 里，走下面的兜底
  }
  const base = process.env.APPDATA || process.env.HOME || process.cwd();
  return path.join(base, 'StatG');
}

function captureDir() {
  return path.join(userDataDir(), 'vision', 'captures');
}

function visionDir() {
  // 打包后：resources/vision-runtime/
  const packaged = path.join(process.resourcesPath || '', 'vision-runtime');
  if (fs.existsSync(path.join(packaged, 'statg-vision.exe'))) return packaged;
  // 开发时：仓库 desktop/vision-dist（npm run vision:build 生成）
  return path.resolve(__dirname, '..', 'vision-dist');
}

function exePath() {
  return path.join(visionDir(), 'statg-vision.exe');
}

function isAvailable() {
  return fs.existsSync(exePath());
}

function pingRaw(timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!visionProc || visionProc.killed) {
    return Promise.reject(new Error('sidecar 未启动'));
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error('ping 超时'));
    }, timeoutMs);
    pending.set(id, (msg) => {
      clearTimeout(timer);
      msg.ok ? resolve(msg.result) : reject(new Error(msg.error.message));
    });
    visionProc.stdin.write(JSON.stringify({ id, method: 'ping', params: {} }) + '\n');
  });
}

/** 拉起 sidecar。已是运行中则直接复用。 */
async function ensureVision() {
  if (visionProc && !visionProc.killed && visionProc.stdin.writable) return visionProc;
  if (starting) return starting;

  starting = (async () => {
    const dir = visionDir();
    const exe = path.join(dir, 'statg-vision.exe');
    if (!fs.existsSync(exe)) {
      throw new Error(`找不到 statg-vision.exe（预期位置 ${exe}）。开发环境下先跑 node build/prepare-vision.cjs`);
    }

    buf = '';
    pending.clear();
    visionErr = '';

    visionProc = spawn(exe, [], {
      cwd: dir,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        // 模型放哪都不挑：resolution 链的第一优先，开发态与安装态同一套代码
        NUPHUS_MODELS_DIR: path.join(dir, 'models'),
        // 显式指定 onnxruntime。不设的话 exe 同目录本来也会被 Windows 加载器找到，
        // 设它是为了确定性——也是为了让"模型/DLL 没到位"变成显式错误而不是 panic
        ORT_DYLIB_PATH: path.join(dir, 'onnxruntime.dll'),
        // 截图落盘目录。放在 userData 下，随用户而不是随程序
        STATG_CAPTURE_DIR: captureDir(),
        RUST_LOG: process.env.STATA_DEV ? 'statg_vision=debug' : 'warn',
      },
    });

    let stdoutBuf = '';
    visionProc.stdout.on('data', (d) => {
      stdoutBuf += d.toString('utf8');
      let i;
      while ((i = stdoutBuf.indexOf('\n')) >= 0) {
        const line = stdoutBuf.slice(0, i).trim();
        stdoutBuf = stdoutBuf.slice(i + 1);
        if (!line) continue;
        let msg;
        try {
          msg = JSON.parse(line);
        } catch (e) {
          // 走到这里说明 sidecar 把日志打到了 stdout——那是 main.rs 的规矩 1 被破坏，
          // 属于必须发现的问题，不能悄悄吞掉。
          console.error('[vision] stdout 出现非协议帧:', line.slice(0, 200));
          continue;
        }
        const resolve = pending.get(msg.id);
        if (resolve) {
          pending.delete(msg.id);
          resolve(msg);
        }
      }
    });

    visionProc.stderr.on('data', (d) => {
      const s = d.toString();
      visionErr = (visionErr + s).slice(-4000);
      if (process.env.STATA_DEV) console.log('[vision!]', s.trim());
    });

    visionProc.on('exit', (code) => {
      log('sidecar exited:', code);
      visionProc = null;
      starting = null;
      // 还在等的请求全部失败，别让调用方挂到超时
      for (const [, reject] of pending) reject(new Error(`sidecar 退出（码 ${code}）`));
      pending.clear();
    });

    // 探活：ping 不过就不算启动成功
    const info = await pingRaw(15000);
    if (info.ocr !== true) {
      log('OCR 模型未就位：', info);
    }
    log('sidecar ready, protocol', info.protocol, '| ocr', info.ocr, 'yolo', info.yolo);
    return visionProc;
  })();

  try {
    return await starting;
  } finally {
    starting = null;
  }
}

async function stopVision() {
  const proc = visionProc;
  if (!proc) return;
  visionProc = null;
  try {
    proc.stdin.end();
  } catch (e) {}
  // 给一点时间让它自己走完 stdin EOF 的正常退出路径，再强制杀
  await new Promise((r) => setTimeout(r, 300));
  if (!proc.killed) {
    try { proc.kill(); } catch (e) {}
  }
}

function setEnabled(on) {
  enabled = !!on;
  if (!enabled) return stopVision();
  return Promise.resolve();
}

/**
 * 调一个 sidecar 方法。
 *
 * 注意这里的 enabled 检查是**模块自己的守门人**，不是可选的：ipcMain 那一层虽然也查，
 * 但如果只靠它，任何直接 require 本模块的调用方（包括测试）都能绕过"默认关闭"。
 * 一个能全局点击、全局打字的进程，开关必须只有一处但每一层都兜得住。
 */
function call(method, params = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  if (!ALLOWED.has(method)) {
    return Promise.reject(new Error(`方法不在白名单：${method}`));
  }
  if (!enabled) {
    return Promise.reject(new Error('not_enabled：桌面能力未开启'));
  }
  return (async () => {
    const proc = await ensureVision();
    const id = nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`${method} 超时 ${timeoutMs}ms`));
      }, timeoutMs);
      pending.set(id, (msg) => {
        clearTimeout(timer);
        if (msg.ok) resolve(msg.result);
        else reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      });
      proc.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  })();
}

/** 按 id 读一张截图，转成 data URL 给渲染进程。主进程读文件，不走静态服务器。 */
function readCapture(captureId) {
  const file = path.join(captureDir(), `${captureId}.png`);
  if (!fs.existsSync(file)) return Promise.reject(new Error(`截图不存在：${file}`));
  const b64 = fs.readFileSync(file).toString('base64');
  return Promise.resolve(`data:image/png;base64,${b64}`);
}

function register() {
  const { ipcMain, app } = require('electron');

  ipcMain.handle('vision:available', () => ({ ok: true, available: isAvailable(), enabled }));

  ipcMain.handle('vision:enable', async (e, on) => {
    try {
      await setEnabled(on);
      return { ok: true, enabled: !!on };
    } catch (err) {
      return { ok: false, error: err.message, stderr: visionErr.slice(-1500) };
    }
  });

  ipcMain.handle('vision:status', async () => {
    try {
      const info = await (visionProc ? pingRaw() : ensureVision().then(() => pingRaw()));
      return { ok: true, running: true, info };
    } catch (err) {
      return { ok: true, running: false, error: err.message, stderr: visionErr.slice(-1500) };
    }
  });

  ipcMain.handle('vision:call', async (e, method, params) => {
    if (!enabled) {
      return { ok: false, error: 'not_enabled', message: '桌面能力未开启（先在设置里打开）' };
    }
    try {
      const result = await call(method, params || {});
      return { ok: true, result };
    } catch (err) {
      return { ok: false, error: 'call_failed', message: err.message, stderr: visionErr.slice(-1500) };
    }
  });

  ipcMain.handle('vision:capture_image', async (e, captureId) => {
    try {
      return { ok: true, dataUrl: await readCapture(captureId) };
    } catch (err) {
      return { ok: false, error: 'read_failed', message: err.message };
    }
  });

  app.on('before-quit', () => {
    stopVision();
  });

  log('registered');
}

module.exports = { register, ensureVision, stopVision, call, isAvailable, setEnabled };
