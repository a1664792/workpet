#!/usr/bin/env node
'use strict';
/**
 * TraeWork 签到宠物 daemon
 *
 * 为 TraeWork 提供 CDP 注入与签到机制，只保留三个能力：
 *
 * 注意：客户端安装目录会改名（TRAE SOLO CN → TraeWork CN），因此本文件一律不写死
 * 品牌名做路径/进程匹配，统一按 TRAEWORK_NAME_RE「含 trae 且含 solo/work」动态探测
 * （见 findTraeExecutable / findTraeDataDir / TRAE_PROCESS_ERE）。
 * 普通版 Trae（Trae CN / Trae）是另一个产品，不在适配范围内，需排除。
 *   1) 桌面宠物机器人   —— 注入到 TraeWork 窗口内的 SVG 动画宠物
 *   2) 每日签到         —— 调用官方 checkin_credits/status + claim 接口
 *   3) 签到过期显示     —— 距下次签到倒计时 + 本次/累计积分与到期信息
 *
 * 职责：
 *   - 解密 storage.json 里的登录态（还原自 main.js 的 smart-secret AES）
 *   - 拉起 / 复用带 --remote-debugging-port 的 TraeWork，经 CDP 注入 inject.js
 *   - 本地 HTTP API 供注入的宠物面板调用（签到状态、签到、健康检查）
 *   - watchdog：CDP 掉线自动重连、页面重载自动补种
 */
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const isMac = process.platform === 'darwin';

const APP_BRAND = 'TraeWork';
const DAEMON_VERSION = '1.0.3';
const APP_VERSION = DAEMON_VERSION;
const HOST = '127.0.0.1';

// 自身脚本指纹：进程启动时读一次并缓存，随 /api/health 上报，供桌面端判断
// 「47921 端口上那个常驻进程，是不是本安装包里的这份 daemon.js」。
//
// 为什么需要它：桌面端原本只比对版本号（DAEMON_VERSION vs app 版本），但同一版本号
// 重新构建（本地修 bug 重打包、版本号没 bump）时版本号是一致的，于是旧常驻进程会被
// 判定为「本包的」而一直被复用 —— 表现为换了 node 和 daemon.js，跑的还是旧逻辑
// （例如内置 Node 已升 24，进程里却仍是 Node 20，CDP 全部失效）。
//
// 必须「启动时」读取并缓存：进程跑起来之后安装包可能已把 daemon.js 覆盖，
// 那时再 statSync 拿到的是新文件，无法反映本进程实际加载的版本。
const SELF_FINGERPRINT = (() => {
  try {
    const st = fs.statSync(__filename);
    // 只用「字节数 + 整秒 mtime」，避免浮点毫秒在 JS/Rust 两侧的取整差异
    return `${st.size}-${Math.floor(st.mtimeMs / 1000)}`;
  } catch (_) { return ''; }
})();

// 语义化版本比较：a>b 返回正数，a<b 返回负数，相等返回 0（支持 v 前缀；
// 预发布后缀按 semver 规则处理：同为 1.0.3 时 1.0.3 > 1.0.3-beta.3，正式版发布后测试版能收到更新提示）
function compareSemver(a, b) {
  const norm = (s) => {
    const m = String(s).trim().replace(/^v/i, '').split('-');
    return { core: (m[0] || '').split('.').map(n => parseInt(n, 10) || 0), pre: m.slice(1).join('-') || null };
  };
  const A = norm(a), B = norm(b);
  for (let i = 0; i < 3; i++) {
    const d = (A.core[i] || 0) - (B.core[i] || 0);
    if (d) return d;
  }
  if (A.pre && !B.pre) return -1;
  if (!A.pre && B.pre) return 1;
  return 0;
}

// ---------------- WorkBuddy / CodeBuddy / AutoClaw Token 用量统计（扫描本机会话日志，数据不出本机） ----------------
// 数据源：~/.workbuddy/projects、~/.codebuddy/projects 下的 **/*.jsonl（providerData.rawUsage/usage），
// ~/.openclaw-autoclaw/agents 下的 */sessions/*.jsonl（message.usage，文件名即 sessionId），均为请求级真实 usage
const CLIENT_USAGE_DIRS = {
  wb: path.join(os.homedir(), '.workbuddy', 'projects'),
  cb: path.join(os.homedir(), '.codebuddy', 'projects'),
  ac: path.join(os.homedir(), '.openclaw-autoclaw', 'agents'),
};
const clientUsageCaches = {}; // kind -> { at, data }（各端独立 60s 缓存）

function wbListJsonl(dir, out) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) wbListJsonl(p, out);
    else if (e.isFile() && e.name.endsWith('.jsonl')) out.push(p);
  }
}

function wbLocalDay(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function wbExtractUsage(rec) {
  // OpenClaw/AutoClaw 格式：rec.message.usage = { input, output, cacheRead, cacheWrite, totalTokens, ... }
  // 必须校验 input 为数字：cb 的 message.usage 是 snake_case（input_tokens），不能误入此分支
  const oc = rec.message && rec.message.usage;
  if (oc && typeof oc === 'object' && typeof oc.input === 'number') {
    const input = Number(oc.input || 0);
    const output = Number(oc.output || 0);
    if (!input && !output) return null;
    return {
      input,
      output,
      cached: Number(oc.cacheRead || 0) + Number(oc.cacheWrite || 0),
      total: Number(oc.totalTokens || input + output),
    };
  }
  // WorkBuddy / CodeBuddy 格式：providerData.rawUsage/usage 或顶层 usage（OpenAI 风格字段）
  const pd = rec.providerData;
  const u = (pd && (pd.rawUsage || pd.usage)) || rec.usage;
  if (!u || typeof u !== 'object') return null;
  const input = Number(u.prompt_tokens || 0);
  const output = Number(u.completion_tokens || 0);
  if (!input && !output) return null;
  const cached = Number(
    u.prompt_cache_hit_tokens ??
    (u.prompt_tokens_details && u.prompt_tokens_details.cached_tokens) ??
    u.cache_read_input_tokens ?? 0
  );
  return { input, output, cached, total: Number(u.total_tokens || input + output) };
}

function scanClientTokenUsage(kind) {
  const now = Date.now();
  const cache = clientUsageCaches[kind] || (clientUsageCaches[kind] = { at: 0, data: null });
  if (cache.data && now - cache.at < 60_000) return cache.data;
  const byDay = Object.create(null);
  const sessions = new Set();
  let requests = 0;
  const files = [];
  wbListJsonl(CLIENT_USAGE_DIRS[kind] || '', files);
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(f, 'utf8'); } catch (_) { continue; }
    const fileSession = path.basename(f, path.extname(f)); // 兜底：AutoClaw 文件名即 sessionId
    for (const line of text.split('\n')) {
      const s = line.trim();
      if (s.length < 2) continue;
      let rec;
      try { rec = JSON.parse(s); } catch (_) { continue; }
      const u = wbExtractUsage(rec);
      if (!u) continue;
      requests++;
      const sid = rec.sessionId != null ? rec.sessionId : fileSession;
      if (sid) sessions.add(String(sid));
      // 优先 message.timestamp（AutoClaw 毫秒数字，避免其顶层 "MM/DD/YYYY" 字符串的月日歧义），回退顶层 timestamp
      const ts = (rec.message && rec.message.timestamp) ?? rec.timestamp;
      const d = ts ? new Date(ts) : new Date();
      const day = wbLocalDay(isNaN(d.getTime()) ? new Date() : d);
      const agg = (byDay[day] = byDay[day] || { input: 0, output: 0, cached: 0, total: 0, requests: 0 });
      agg.input += u.input; agg.output += u.output; agg.cached += u.cached; agg.total += u.total; agg.requests++;
    }
  }
  const data = { at: now, byDay, requests, sessions: sessions.size };
  clientUsageCaches[kind] = { at: now, data };
  return data;
}

function clientUsageSummary(kind) {
  const scan = scanClientTokenUsage(kind);
  const empty = () => ({ input: 0, output: 0, cached: 0, total: 0, requests: 0 });
  const sumRange = (fromDay, toDay) => {
    const s = empty();
    for (const day of Object.keys(scan.byDay)) {
      if (day >= fromDay && day <= toDay) {
        const a = scan.byDay[day];
        s.input += a.input; s.output += a.output; s.cached += a.cached; s.total += a.total; s.requests += a.requests;
      }
    }
    return s;
  };
  const today = wbLocalDay(new Date());
  const daysAgo = (n) => wbLocalDay(new Date(Date.now() - n * 86_400_000));
  const byDay = Object.keys(scan.byDay).sort().slice(-30).map((day) => ({ day, ...scan.byDay[day] }));
  return {
    today: sumRange(today, today),
    days7: sumRange(daysAgo(6), today),
    days30: sumRange(daysAgo(29), today),
    all: sumRange('0000-00-00', '9999-99-99'),
    allSessions: scan.sessions,
    allRequests: scan.requests,
    byDay,
    scannedAt: scan.at,
  };
}
const CDP_PORT = 9222;
const UI_PORT = parseInt(process.env.TRAEWORK_UI_PORT || '47921', 10);
const CDP_STARTUP_TIMEOUT_MS = 60000;

// 签到接口按官方 iCubeEntitlement 的实现：POST，body "{}"，多域名兜底（www.trae.cn 是官网非 API，不参与）
const CHECKIN_HOSTS = ['https://api.trae.cn', 'https://trae-api-cn.mchost.guru'];
const CHECKIN_PATH = '/trae/api/v2/ug/checkin_credits/';
const CHECKIN_REQUEST_TIMEOUT_MS = 12000;

// ---------------- 路径探测 ----------------
const USER_DATA_ROOT = isMac
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : path.join(os.homedir(), 'AppData', 'Roaming');

// TraeWork 的安装目录/包名历经改名：TRAE SOLO CN → TraeWork CN。
// 普通版 Trae（"Trae CN" / "Trae"）是另一个产品，不在本项目适配范围内，必须排除：
// 否则会拉起错误的客户端、或读到别家产品的登录态。
// 判定依据：名称含 trae，且同时含 solo 或 work。
// 匹配：TRAE SOLO CN / TRAE SOLO / TraeWork CN / TraeWork
// 排除：Trae CN / Trae
const TRAEWORK_NAME_RE = /trae.*(solo|work)/i;

const EXE_CANDIDATES = isMac
  ? [
      '/Applications/TraeWork CN.app/Contents/MacOS/TraeWork CN',
      '/Applications/TRAE SOLO CN.app/Contents/MacOS/TRAE SOLO CN',
      '/Applications/TraeWork.app/Contents/MacOS/TraeWork',
      path.join(
        os.homedir(),
        'Applications',
        'TraeWork CN.app',
        'Contents',
        'MacOS',
        'TraeWork CN'
      ),
      path.join(
        os.homedir(),
        'Applications',
        'TRAE SOLO CN.app',
        'Contents',
        'MacOS',
        'TRAE SOLO CN'
      ),
      path.join(
        os.homedir(),
        'Applications',
        'TraeWork.app',
        'Contents',
        'MacOS',
        'TraeWork'
      ),
    ]
  : [
      'D:/Program Files/TRAE SOLO CN/TRAE SOLO CN.exe',
      path.join(
        process.env.ProgramFiles || 'C:/Program Files',
        'TRAE SOLO CN',
        'TRAE SOLO CN.exe'
      ),
      path.join(
        process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)',
        'TRAE SOLO CN',
        'TRAE SOLO CN.exe'
      ),
      path.join(
        process.env.LOCALAPPDATA || '',
        'Programs',
        'TRAE SOLO CN',
        'TRAE SOLO CN.exe'
      ),
    ];

const DATA_DIR_CANDIDATES = [
  'TraeWork CN',
  'TRAE SOLO CN',
  'TraeWork',
].map((name) => path.join(USER_DATA_ROOT, name));

function findTraeExecutable() {
  const direct = EXE_CANDIDATES.find((f) => f && fs.existsSync(f));
  if (direct) return direct;

  if (!isMac) return '';

  // macOS 兜底：
  // 扫描 /Applications 与 ~/Applications 中的 TraeWork.app（排除普通版 Trae）。
  for (const root of [
    '/Applications',
    path.join(os.homedir(), 'Applications'),
  ]) {
    let apps = [];

    try {
      apps = fs
        .readdirSync(root)
        .filter((name) => TRAEWORK_NAME_RE.test(name) && name.endsWith('.app'));
    } catch (_) {}

    for (const app of apps) {
      const macosDir = path.join(root, app, 'Contents', 'MacOS');

      let bins = [];
      try {
        bins = fs.readdirSync(macosDir);
      } catch (_) {}

      for (const bin of bins) {
        const full = path.join(macosDir, bin);

        try {
          if (fs.statSync(full).isFile()) return full;
        } catch (_) {}
      }
    }
  }

  return '';
}

function findTraeDataDir() {
  // 保留上游 v1.0.2 的逻辑：
  // 多个 Trae 客户端并存时，优先选择 storage.json 中
  // 真正含 iCubeAuthInfo 登录态的目录。
  const scanDirs = [...DATA_DIR_CANDIDATES];

  try {
    for (const name of fs.readdirSync(USER_DATA_ROOT)) {
      if (!TRAEWORK_NAME_RE.test(name)) continue;

      const dir = path.join(USER_DATA_ROOT, name);

      if (!scanDirs.includes(dir)) {
        scanDirs.push(dir);
      }
    }
  } catch (_) {}

  for (const dir of scanDirs) {
    if (!dir || !fs.existsSync(dir)) continue;

    const storage = path.join(
      dir,
      'User',
      'globalStorage',
      'storage.json'
    );

    if (!fs.existsSync(storage)) continue;

    try {
      if (
        fs
          .readFileSync(storage, 'utf8')
          .includes('iCubeAuthInfo://')
      ) {
        return dir;
      }
    } catch (_) {}
  }

  // 都没有有效登录态时，回退到第一个实际存在的数据目录。
  for (const dir of scanDirs) {
    if (dir && fs.existsSync(dir)) return dir;
  }

  return '';
}

function detectPaths() {
  return {
    exe: findTraeExecutable(),
    dataDir: findTraeDataDir(),
  };
}

let CFG = { exe: '', dataDir: '' };
function storageFile() { return path.join(CFG.dataDir, 'User', 'globalStorage', 'storage.json'); }

function log(...args) {
  const line = `[traework] ${new Date().toISOString()} ${args.join(' ')}\n`;
  try { process.stdout.write(line); } catch (_) {}
  try { fs.appendFileSync(path.join(__dirname, 'traework.log'), line); } catch (_) {}
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------- 登录态解密（还原自 main.js 的 KUe/GGe） ----------------
const vh = 64, pv = 32, TO = 64, qm = 6;
const Ioe = Uint8Array.from([82,9,106,213,48,54,165,56,191,64,163,158,129,243,215,251,124,227,57,130,155,47,255,135,52,142,67,68,196,222,233,203,84,123,148,50,166,194,35,61,238,76,149,11,66,250,195,78,8,46,161,102,40,217,36,178,118,91,162,73,109,139,209,37]);
const Poe = Uint8Array.from([31,221,168,51,136,7,199,49,177,18,16,89,39,128,236,95,96,81,127,169,25,181,74,13,45,229,122,159,147,201,156,239,160,224,59,77,174,42,245,176,200,235,187,60,131,83,153,97,23,43,4,126,186,119,214,38,225,105,20,99,85,33,12,125]);
const sha512 = (u8) => new Uint8Array(crypto.createHash('sha512').update(Buffer.from(u8)).digest());

/** 解密 iCubeAuthInfo 值（base64 → Uint8Array → 明文 JSON buffer） */
function KUe(t) {
  const key = t.slice(qm, qm + pv);
  if (key.length !== pv) return null;
  const o = sha512(key);
  const a = new Uint8Array(TO);
  for (let i = 0; i < TO; i++) a[i] = Ioe[i] ^ Poe[i];
  const n = new Uint8Array(vh + TO);
  n.set(o, 0); n.set(a, vh);
  n.set(sha512(n), 0);
  const aesKey = n.slice(0, 16), iv = n.slice(16, 32);
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(aesKey), Buffer.from(iv));
  const pt = Buffer.concat([d.update(Buffer.from(t.slice(pv + qm))), d.final()]);
  const l = sha512(pt.slice(vh));
  for (let i = 0; i < vh; i++) if (l[i] !== pt[i]) return null;
  return pt.slice(vh);
}

/** 读取并解密登录态，返回 { token, userId, account, deviceId, raw }。
 *  任何失败都只返回 { error }，绝不抛异常：/api/health 会调用本函数，
 *  一旦抛出（如未安装 TraeWork 时 storageFile() 退化为相对路径导致 ENOENT），
 *  健康检查返回 500，桌面端据此误判 daemon 版本不匹配，最终误报「后台服务启动超时」。 */
function getAuth() {
  if (!CFG.dataDir) return { error: '未找到 TraeWork 数据目录（TraeWork 未安装或未登录）' };
  let json;
  try {
    json = JSON.parse(fs.readFileSync(storageFile(), 'utf8'));
  } catch (e) {
    return { error: '读取 storage.json 失败: ' + e.message };
  }
  const deviceId = json['telemetry.devDeviceId'] || '';
  const secret = json['iCubeAuthInfo://icube.cloudide'];
  if (!secret) return { error: '未找到 iCubeAuthInfo://icube.cloudide' };
  const buf = KUe(new Uint8Array(Buffer.from(secret, 'base64')));
  if (!buf) return { error: '登录态解密失败（校验和不通过）' };
  let info;
  try { info = JSON.parse(Buffer.from(buf).toString('utf8')); } catch (e) { return { error: '登录态解析失败: ' + e.message }; }
  return { token: info.token || '', userId: info.userId || '', account: info.account || {}, deviceId, info };
}

// ---------------- 便携数据目录 ----------------
// 账号备份/设置/积分缓存全部存放在数据目录（默认与 daemon.js 同目录）；
// Windows 继续使用便携目录；macOS 由桌面端指定到 ~/Library/Application Support/WorkPet。
// 目录不可写时回退到平台标准用户数据目录。
let DATA_ROOT =
  (process.env.WORKPET_DATA_DIR && fs.existsSync(process.env.WORKPET_DATA_DIR))
    ? process.env.WORKPET_DATA_DIR
    : __dirname;
const FALLBACK_DATA_DIR = path.join(
  isMac
    ? path.join(os.homedir(), 'Library', 'Application Support')
    : (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')),
  'WorkPet'
);
try {
  fs.mkdirSync(path.join(DATA_ROOT, 'accounts'), { recursive: true });
  fs.accessSync(path.join(DATA_ROOT, 'accounts'), fs.constants.W_OK);
} catch (e) {
  log('[data] 目录不可写，回退到: ' + FALLBACK_DATA_DIR + ' (' + e.message + ')');
  DATA_ROOT = FALLBACK_DATA_DIR;
  try { fs.mkdirSync(path.join(DATA_ROOT, 'accounts'), { recursive: true }); } catch (_) {}
}

// ---------------- 多账号管理（备份/列表/切换/删除） ----------------
// 登录态密文保存在 storage.json 的 iCubeAuthInfo://icube.cloudide 键里（自研 smart-secret AES）。
// 每个账号按 <userId>.json 备份到数据目录 accounts/ 下，
// 备份里保存「原始密文字符串 + 展示字段」；切换时把密文原样写回 storage.json 即可（解密是纯函数）。
const BACKUP_DIR = path.join(DATA_ROOT, 'accounts'); // 备份快照目录：WorkPet-accounts-<时间戳>.json
// 单一账号库：三端所有账号都在这一个文件里（WorkPet 自有格式）
const STORE_FILE = path.join(DATA_ROOT, 'WorkPet-accounts.json');
function loadStore() {
  const st = readJsonOrNull(STORE_FILE) || {};
  return {
    app: 'WorkPet', schema: 1, updatedAt: st.updatedAt || null,
    traework: Object.assign({ currentSecret: null, deviceId: null, accounts: [] }, st.traework),
    workbuddy: Object.assign({ current: null, accounts: [] }, st.workbuddy),
    codebuddy: Object.assign({ current: null, accounts: [] }, st.codebuddy),
    ac: Object.assign({ current: null, accounts: [] }, st.ac),
    codearts: Object.assign({ current: null, accounts: [] }, st.codearts),
  };
}
function saveStore(store) {
  store.updatedAt = new Date().toISOString();
  const tmp = STORE_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, STORE_FILE);
}
// 一次性迁移：旧版平铺/traework 子目录的账号并入单文件账号库，然后删除旧目录
(function migrateToSingleStore() {
  try {
    const store = loadStore();
    const have = new Set(store.traework.accounts.map((a) => String(a.uid)));
    let moved = false;
    const legacyDirs = [path.join(BACKUP_DIR, 'traework'), BACKUP_DIR];
    for (const dir of legacyDirs) {
      let files = [];
      try { files = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch (_) {}
      for (const f of files) {
        const j = readJsonOrNull(path.join(dir, f));
        if (!j || !j.uid || !j.secret) continue;
        if (!have.has(String(j.uid))) { store.traework.accounts.push(j); have.add(String(j.uid)); moved = true; }
      }
    }
    if (moved) saveStore(store);
    try { fs.rmSync(path.join(BACKUP_DIR, 'traework'), { recursive: true, force: true }); } catch (_) {}
    try {
      // 只清理旧版平铺的 uid 数字命名文件，不动用户放入的任何其他文件
      for (const f of fs.readdirSync(BACKUP_DIR)) {
        if (/^\d+\.json$/.test(f)) { try { fs.unlinkSync(path.join(BACKUP_DIR, f)); } catch (_) {} }
      }
    } catch (_) {}
  } catch (_) {}
})();

function decodeSecret(secret) {
  const buf = KUe(new Uint8Array(Buffer.from(String(secret || ''), 'base64')));
  if (!buf) return null;
  try { return JSON.parse(Buffer.from(buf).toString('utf8')); } catch (_) { return null; }
}

/** 从解密信息抽取展示字段；secret 仅落盘备份用，不对外暴露 */
function accountMetaFromInfo(info) {
  const acct = (info && info.account) || {};
  return {
    uid: String(info.userId || ''),
    nickname: String(acct.username || ''),
    mobile: String(acct.nonPlainTextMobile || ''),
    avatarUrl: String(acct.avatar_url || ''),
    expiredAt: info.expiredAt || null,
    refreshExpiredAt: info.refreshExpiredAt || null,
    scope: String(acct.scope || ''),
  };
}

/** 当前登录账号（不含 token/secret） */
function readCurrentAccount() {
  const auth = getAuth();
  if (auth.error) return null;
  return accountMetaFromInfo(auth.info);
}

/** 备份当前登录账号：解密 → 连同密文写入 accounts/<uid>.json（原子写） */
function backupCurrentAccount() {
  const auth = getAuth();
  if (auth.error) throw new Error(auth.error);
  const raw = fs.readFileSync(storageFile(), 'utf8');
  const json = JSON.parse(raw);
  const secret = json['iCubeAuthInfo://icube.cloudide'];
  if (!secret) throw new Error('storage.json 中缺少 iCubeAuthInfo://icube.cloudide');
  const meta = accountMetaFromInfo(auth.info);
  if (!meta.uid) throw new Error('无法识别当前账号');
  const store = loadStore();
  const record = Object.assign({ schema: 1, backedUpAt: Date.now(), secret }, meta);
  const idx = store.traework.accounts.findIndex((a) => String(a.uid) === String(meta.uid));
  if (idx >= 0) store.traework.accounts[idx] = Object.assign({}, store.traework.accounts[idx], record);
  else store.traework.accounts.push(record);
  store.traework.currentSecret = secret;
  saveStore(store);
  return { uid: meta.uid, nickname: meta.nickname };
}

/**
 * 跨客户端收集：扫描 Roaming 下所有 TraeWork 客户端（TRAE SOLO CN / TraeWork CN /
 * TraeWork，不含普通版 Trae）的已登录账号，把有可用登录态的都并入备份库，实现「登录过的账号
 * 都能显示」。只读别的客户端 storage，绝不写回别人。
 */
function collectAllTraeAccounts() {
  const roam = USER_DATA_ROOT;
  let dirs = [];
  try { dirs = fs.readdirSync(roam).filter((n) => TRAEWORK_NAME_RE.test(n)); } catch (_) {}
  const saved = [];
  const store = loadStore();
  for (const name of dirs) {
    const storage = path.join(roam, name, 'User', 'globalStorage', 'storage.json');
    if (!fs.existsSync(storage)) continue;
    try {
      const json = JSON.parse(fs.readFileSync(storage, 'utf8'));
      const secret = json['iCubeAuthInfo://icube.cloudide'];
      if (!secret) continue;
      const info = decodeSecret(secret);
      if (!info || !info.userId) continue;
      const meta = accountMetaFromInfo(info);
      if (!meta.uid) continue;
      const record = Object.assign({ schema: 1, backedUpAt: Date.now(), secret, src: name }, meta);
      const idx = store.traework.accounts.findIndex((a) => String(a.uid) === String(meta.uid));
      if (idx >= 0) store.traework.accounts[idx] = Object.assign({}, store.traework.accounts[idx], record);
      else store.traework.accounts.push(record);
      saved.push((meta.nickname || meta.uid) + ':' + name);
    } catch (_) { /* 该客户端无有效登录态则跳过 */ }
  }
  if (saved.length) saveStore(store);
  return saved;
}

/** 列出所有已备份账号（不含 secret），按备份时间倒序 */
function listAccounts() {
  const store = loadStore();
  const list = store.traework.accounts
    .filter((rec) => rec && rec.uid)
    .map((rec) => ({
      uid: rec.uid, nickname: rec.nickname || '', mobile: rec.mobile || '',
      avatarUrl: rec.avatarUrl || '', expiredAt: rec.expiredAt || null,
      refreshExpiredAt: rec.refreshExpiredAt || null, scope: rec.scope || '',
      backedUpAt: rec.backedUpAt || null,
    }));
  list.sort((a, b) => (b.backedUpAt || 0) - (a.backedUpAt || 0));
  return list;
}

/** 读取某账号备份并校验：备份里存的密文必须能解密出相同 uid */
function readAccountSecret(uid) {
  const store = loadStore();
  const rec = store.traework.accounts.find((a) => String(a.uid) === String(uid));
  if (!rec) throw new Error('未找到账号 ' + uid + ' 的备份');
  if (String(rec.uid) !== String(uid)) throw new Error('备份 uid 不匹配');
  const info = decodeSecret(rec.secret);
  if (!info) throw new Error('备份密文无法解密');
  if (String(info.userId) !== String(uid)) throw new Error('备份校验失败：解密 userId 与 uid 不匹配');
  return { secret: rec.secret, info };
}

/** 把指定密文写回 storage.json（保留其它键；切换前必须先停宿主，防其覆盖） */
function writeAuthSecret(secret) {
  const file = storageFile();
  const json = JSON.parse(fs.readFileSync(file, 'utf8'));
  json['iCubeAuthInfo://icube.cloudide'] = secret;
  const tmp = file + '.twswitch.tmp';
  fs.writeFileSync(tmp, JSON.stringify(json, null, 2));
  fs.renameSync(tmp, file);
}

/** 删除账号备份文件（不影响当前登录） */
function deleteAccountBackup(uid) {
  const store = loadStore();
  const before = store.traework.accounts.length;
  store.traework.accounts = store.traework.accounts.filter((a) => String(a.uid) !== String(uid));
  saveStore(store);
  return store.traework.accounts.length < before;
}

/** 切换账号：停宿主 → 写回密文 → 以 CDP 模式重启 → 自动重注入 */
async function switchToAccount(uid) {
  const { secret, info } = readAccountSecret(uid);
  const nickname = ((info.account && info.account.username) || uid);
  log('[switch] 切换账号 -> ' + nickname + ' (' + uid + ')');
  killTraeWork(); // 先停宿主，避免其把内存身份写回 storage.json 覆盖切换
  await sleep(1500);
  writeAuthSecret(secret);
  log('[switch] 已写回登录态到 storage.json');
  statusCache.at = 0; statusCache.data = null;
  entCache.at = 0; entCache.data = null;
  await ensureTraeWorkWithCdp(); // 重启 TraeWork 使切换生效；桌面版不再注入
  log('[switch] 已切换账号: ' + nickname);
  // 切换后重备份一次：宿主重启时可能已刷新登录态（新 token/新有效期），
  // 把最新的 Cookie 时限同步进账号库，避免面板显示过期日期。
  try {
    const r = backupCurrentAccount();
    log('[switch] 已刷新账号备份 ' + r.nickname + ' (' + r.uid + ')');
  } catch (e) { log('[switch] 切换后备份失败: ' + e.message); }
  return { uid, nickname };
}

// ---------------- 签到 API ----------------
function postJson(url, body, headers) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const data = body != null ? Buffer.from(typeof body === 'string' ? body : JSON.stringify(body)) : null;
    const u = new URL(url);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'POST',
      headers: Object.assign(
        { 'Content-Type': 'application/json', Accept: 'application/json' },
        data ? { 'Content-Length': data.length } : {},
        headers || {}
      ),
      timeout: CHECKIN_REQUEST_TIMEOUT_MS,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let obj = {};
        try { obj = JSON.parse(text); } catch (_) { obj = { code: -1, message: text.slice(0, 300) }; }
        resolve({ status: res.statusCode, body: obj, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function getJson(url, headers, redirects) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('https:') ? require('https') : require('http');
    const u = new URL(url);
    const req = mod.request({
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: Object.assign({ Accept: 'application/json', 'User-Agent': 'WorkPet-Desktop' }, headers || {}),
      timeout: 8000,
    }, (res) => {
      // 跟随 3xx 重定向（GitHub 仓库改名的 301 会指向新地址），最多 5 跳
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers && res.headers.location) {
        res.destroy(new Error('redirect'));
        if ((redirects || 0) >= 5) return reject(new Error('重定向次数过多'));
        return resolve(getJson(new URL(res.headers.location, url).toString(), headers, (redirects || 0) + 1));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let obj = null;
        try { obj = JSON.parse(text); } catch (_) {}
        resolve({ status: res.statusCode, body: obj, text });
      });
    });
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.end();
  });
}

function checkinHeaders(auth) {
  return {
    'Authorization': 'Cloud-IDE-JWT ' + auth.token,
    'x-device-id': auth.deviceId,
    'Origin': 'vscode-file://vscode-app',
    'User-Agent': 'TRAE SOLO CN',
  };
}

/** 带多域名兜底的签到请求：action = 'status' | 'claim' */
async function checkinRequest(action, auth) {
  let lastErr = null;
  for (const host of CHECKIN_HOSTS) {
    const url = host + CHECKIN_PATH + action;
    const t0 = Date.now();
    try {
      const r = await postJson(url, {}, checkinHeaders(auth));
      const body = r.body || {};
      const hasCode = typeof body.code === 'number';
      // 每次尝试都留痕，便于排查「签到失败」的真实服务端原因
      log(`[checkin/${action}] ${host} HTTP ${r.status} code=${body.code} msg=${body.message || body.msg || ''} checked_in=${body.checked_in} (${Date.now() - t0}ms)`);
      // 200 且返回了合法 JSON（带 code 字段）= 服务端的确定结果：
      // 无论 code 是否为 0 都直接返回，避免误落到返回 HTML 的错误 host 上。
      if (r.status === 200 && hasCode) {
        const ok = body.code === 0 || body.code === undefined || body.code === null;
        return { ok, status: r.status, body, host };
      }
      // 4xx/5xx（非 404）也视为确定失败
      if (r.status >= 400 && r.status < 500 && r.status !== 404) {
        return { ok: false, status: r.status, body, host };
      }
      lastErr = 'HTTP ' + r.status + ' ' + (body.message || body.msg || '');
    } catch (e) {
      log(`[checkin/${action}] ${host} 请求失败: ${e.message} (${Date.now() - t0}ms)`);
      lastErr = e.message;
    }
  }
  return { ok: false, status: 0, body: {}, host: CHECKIN_HOSTS[0], error: lastErr };
}

// ---------------- 设置（持久化到数据目录 config.json） ----------------
const CONFIG_DIR = DATA_ROOT;
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');
const SETTING_DEFAULTS = { launchHostOnStart: false, wbLaunchOnStart: false, cbLaunchOnStart: false, acLaunchOnStart: isMac, caLaunchOnStart: false, showPhone: false, fontScale: 1, tabOrder: ['wb', 'cb', 'ac', 'ca', 'tw'], tabShowText: false, hidePet: true };
// 旧配置兼容：TraeWork Tab 的 key 原为 'accounts'，v1.0.2 起统一为 'tw'
function normalizeTabOrder(v) {
  if (!Array.isArray(v)) return null;
  const mapped = v.map((t) => (t === 'accounts' ? 'tw' : String(t)));
  const known = ['wb', 'cb', 'ac', 'ca', 'tw'];
  const uniq = Array.from(new Set(mapped)).filter((t) => known.includes(t));
  return uniq.length === known.length ? uniq : null;
}
function loadSettings() {
  try {
    return Object.assign({}, SETTING_DEFAULTS, JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')));
  } catch (_) { return Object.assign({}, SETTING_DEFAULTS); }
}
function saveSettings(patch) {
  const next = Object.assign({}, loadSettings(), patch);
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CONFIG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, CONFIG_FILE);
  return next;
}

// ---------------- 全账号轮换（批量签到 + 每账号积分缓存） ----------------
// 签到/查积分接口只认 storage.json 里的登录态（getAuth 是纯读文件），因此批量
// 操作不需要逐个重启宿主：停宿主 → 依次写回各账号密文并查询/签到 → 恢复原账号。
// 顺带把每个账号的权益包数据缓存到 credits.json，供面板显示非当前账号的剩余积分。
let claimAllJob = { running: false, total: 0, done: 0, results: [], startedAt: 0, finishedAt: 0 };

const CREDITS_FILE = path.join(CONFIG_DIR, 'credits.json');
function loadCreditsStore() {
  try { return JSON.parse(fs.readFileSync(CREDITS_FILE, 'utf8')); } catch (_) { return {}; }
}
function saveCreditsStore(store) {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = CREDITS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2));
  fs.renameSync(tmp, CREDITS_FILE);
}
let creditsStore = loadCreditsStore();

// 「设备签到名额」按天记忆：Trae 限制每台设备每日只能一个账号领签到积分。
// 一旦确认本设备今日名额已用（某账号签到成功 / 服务端返回「设备已签到」），
// 当天其余账号直接跳过宿主 IPC 签到，避免每次打开 Pet 都无意义地拉起 TraeWork。
function todayStrLocal() {
  const d = new Date();
  const z = (n) => String(n).padStart(2, '0');
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate());
}
function markDeviceClaimedToday() {
  if (creditsStore.deviceClaimDate === todayStrLocal()) return;
  creditsStore.deviceClaimDate = todayStrLocal();
  saveCreditsStore(creditsStore);
}
function isDeviceClaimedToday() {
  return creditsStore.deviceClaimDate === todayStrLocal();
}

/**
 * 依次把每个账号的登录态写回 storage.json 并执行 fn；结束后恢复原账号。
 * fn 收到当前账号，返回 { ok, already, checkedIn, packs, remaining, msg }。
 * claim=true 时对未签到账号执行签到（含限流自动重试）。
 */
// ---------------- 经宿主官方 IPC 签到（CDP） ----------------
// 实测：Trae 服务端对非 TTNet 客户端的直连 HTTP claim 一律返回 9074「当前参与用户太多」
// （换 UA / 设备指纹头 / req_source / curl(Schannel) 均被拒，凭证本身有效——status 正常）。
// 但宿主主进程经 TTNet 发出的同一请求可以成功。因此退化为：带 CDP 拉起宿主，
// 经 window.vscode.ipcRenderer.invoke 调用官方「签到按钮」完全相同的 IPC 通道。
async function claimViaApp(timeoutMs = 150000) {
  const started = await ensureTraeWorkWithCdp();
  if (started.error) {
    // 拉起失败时清理宿主，避免留下一个没开 CDP、无法签到的 TraeWork 窗口
    try { killTraeWork(); await sleep(1000); } catch (_) {}
    return { ok: false, error: started.error };
  }
  const deadline = Date.now() + timeoutMs;
  let lastErr = 'unknown';
  while (Date.now() < deadline) {
    const target = await getPageTarget(CDP_PORT).catch(() => null);
    if (!target) { await sleep(2000); lastErr = '未找到 TraeWork 页面目标'; continue; }
    const raw = await new Promise((resolve) => {
      let ws = null;
      const finish = (v) => { clearTimeout(timer); try { ws && ws.close(); } catch (_) {} resolve(v); };
      const timer = setTimeout(() => finish(null), 25000);
      try { ws = new WebSocket(target.webSocketDebuggerUrl); } catch (e) { return finish(null); }
      ws.onopen = () => {
        const expr = `(async () => {
          try {
            if (!window.vscode || !window.vscode.ipcRenderer) return JSON.stringify({ err: 'no vscode bridge' });
            const r = await window.vscode.ipcRenderer.invoke('vscode:sandbox::main-invoke-claimCheckinCredits');
            const st = await window.vscode.ipcRenderer.invoke('vscode:sandbox::main-invoke-fetchCheckinCreditsStatus').catch(() => null);
            return JSON.stringify({ claim: r, status: st && st.data });
          } catch (e) { return JSON.stringify({ err: String(e && e.message || e) }); }
        })()`;
        ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: expr, awaitPromise: true, returnByValue: true } }));
      };
      ws.onmessage = (ev) => {
        try {
          const d = JSON.parse(ev.data);
          if (d.id === 1) finish(d.result && d.result.result && d.result.result.value);
        } catch (_) {}
      };
      ws.onerror = () => finish(null);
    });
    if (raw) {
      let o = {};
      try { o = JSON.parse(raw); } catch (_) {}
      // 无论结果如何，先退出宿主：防止其在后续账号轮换时覆盖 storage.json 中的登录态
      try { killTraeWork(); await sleep(1500); } catch (_) {}
      if (o.err) { lastErr = o.err; }
      else {
        const claimData = (o.claim && o.claim.data) || {};
        const stData = o.status || {};
        const claimed = stData.checked_in === true;
        const ok = o.claim && o.claim.status === 200 && (claimData.code === 0 || claimData.code === undefined || claimData.code === null);
        if (ok || claimed) {
          statusCache.at = 0; statusCache.data = null; entCache.at = 0; entCache.data = null;
          return { ok: true, data: claimData, checkedIn: true, via: 'app-ipc' };
        }
        lastErr = claimData.message || claimData.msg || ('code=' + claimData.code);
        // 明确的业务失败（非限流）直接返回，避免无意义重试
        return { ok: false, error: lastErr, data: claimData };
      }
    }
    await sleep(2500);
  }
  try { killTraeWork(); await sleep(1000); } catch (_) {}
  return { ok: false, error: lastErr };
}

// ---------------- 全账号单文件备份/恢复（WorkPet 自有格式，跨电脑迁移） ----------------
// 导出为一个 WorkPet-accounts-<时间戳>.json，包含三端全部账号：
//   traework  当前登录密文 + 全部账号备份（accounts/*.json）
//   workbuddy 当前登录文件 + 全部账号备份（clients/accounts/*.info）
//   codebuddy 当前登录文件 + 全部账号备份（clients/profiles/codebuddy-cn/accounts/*.info）
// 恢复时写回各自位置即可在新电脑上使用。
// WB/CB 账号备份目录：WorkPet 自有目录。旧版曾借用 WorkDaddy 目录存放，
// 首次运行把旧目录文件搬迁过来（只读复制，旧目录原样保留）。
const APP_DATA_ROOT = isMac
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : (process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'));
const LOCAL_DATA_ROOT = isMac
  ? path.join(os.homedir(), 'Library', 'Application Support')
  : (process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'));
const SHARED_DATA_DIR = path.join(APP_DATA_ROOT, 'WorkPet', 'clients');
const WB_ACCOUNTS_DIR = path.join(SHARED_DATA_DIR, 'accounts');
const CB_ACCOUNTS_DIR = path.join(SHARED_DATA_DIR, 'profiles', 'codebuddy-cn', 'accounts');
const LEGACY_SHARED_DIR = path.join(APP_DATA_ROOT, 'WorkDaddy');
function migrateLegacySharedDir(rel) {
  try {
    const dstDir = path.join(SHARED_DATA_DIR, rel);
    const srcDir = path.join(LEGACY_SHARED_DIR, rel);
    fs.mkdirSync(dstDir, { recursive: true });
    if (!fs.existsSync(srcDir)) return;
    for (const f of fs.readdirSync(srcDir)) {
      const dst = path.join(dstDir, f);
      const src = path.join(srcDir, f);
      if (!fs.existsSync(dst) && fs.statSync(src).isFile()) fs.copyFileSync(src, dst);
    }
  } catch (_) {}
}
migrateLegacySharedDir('accounts');
migrateLegacySharedDir(path.join('profiles', 'codebuddy-cn', 'accounts'));
const EXT_AUTH_DIR = path.join(LOCAL_DATA_ROOT, 'CodeBuddyExtension', 'Data', 'Public', 'auth');
const WB_AUTH_FILE = path.join(EXT_AUTH_DIR, 'workbuddy-desktop.info');
const CB_AUTH_FILE = path.join(EXT_AUTH_DIR, 'Tencent-Cloud.coding-copilot.info');

function readJsonOrNull(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return null; }
}

function collectExportAccounts() {
  // TraeWork：直接取自单文件账号库
  const store = loadStore();
  const traeworkAccounts = store.traework.accounts;
  // WorkBuddy / CodeBuddy：账号备份为原始登录文件内容，uid 取自 account.uid
  const collectInfoFiles = (dir) => {
    const out = [];
    try {
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.info') && !f.endsWith('.tmp') && !f.includes('.logged-out'))) {
        const j = readJsonOrNull(path.join(dir, f));
        const uid = j && j.account && j.account.uid;
        if (j && uid) out.push(j);
      }
    } catch (_) {}
    return out;
  };
  const out = {
    traework: {
      currentSecret: (() => {
        try { return JSON.parse(fs.readFileSync(storageFile(), 'utf8'))['iCubeAuthInfo://icube.cloudide'] || store.traework.currentSecret || null; } catch (_) { return store.traework.currentSecret || null; }
      })(),
      deviceId: (() => {
        try { return JSON.parse(fs.readFileSync(storageFile(), 'utf8'))['telemetry.devDeviceId'] || null; } catch (_) { return null; }
      })(),
      accounts: traeworkAccounts,
    },
    workbuddy: {
      current: readJsonOrNull(WB_AUTH_FILE),
      accounts: collectInfoFiles(WB_ACCOUNTS_DIR),
    },
    codebuddy: {
      current: readJsonOrNull(CB_AUTH_FILE),
      accounts: collectInfoFiles(CB_ACCOUNTS_DIR),
    },
    autoclaw: {
      current: clientReadAuth('ac'),
      accounts: (store.ac && store.ac.accounts) || [],
    },
    codearts: {
      current: (store.codearts && store.codearts.current) || null, // 保持已有 current，不因导出而清空
      accounts: (store.codearts && store.codearts.accounts) || [],
    },
  };
  // 把引擎目录的最新账号状态同步回单文件账号库，保证 WorkPet-accounts.json 始终完整
  store.traework.currentSecret = out.traework.currentSecret;
  store.traework.deviceId = out.traework.deviceId;
  store.workbuddy = { current: out.workbuddy.current, accounts: out.workbuddy.accounts };
  store.codebuddy = { current: out.codebuddy.current, accounts: out.codebuddy.accounts };
  store.ac = { current: out.autoclaw.current, accounts: out.autoclaw.accounts };
  store.codearts = { current: out.codearts.current, accounts: out.codearts.accounts };
  saveStore(store);
  return out;
}

function exportBackupFile() {
  const data = {
    app: 'WorkPet', schema: 1, exportedAt: new Date().toISOString(),
    ...collectExportAccounts(),
  };
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const name = `WorkPet-accounts-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.json`;
  const file = path.join(BACKUP_DIR, name);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
  fs.renameSync(tmp, file);
  return {
    file: name,
    counts: {
      traework: data.traework.accounts.length,
      workbuddy: data.workbuddy.accounts.length,
      codebuddy: data.codebuddy.accounts.length,
      autoclaw: (data.autoclaw.accounts || []).length,
      codearts: (data.codearts.accounts || []).length,
    },
  };
}

function listBackupFiles() {
  try {
    return fs.readdirSync(BACKUP_DIR)
      .filter((f) => /^WorkPet-accounts-\d{8}-\d{6}\.json$/.test(f))
      .sort()
      .reverse();
  } catch (_) { return []; }
}

async function restoreBackupData(data) {
  if (!data || data.app !== 'WorkPet') throw new Error('不是有效的 WorkPet 备份文件');
  const counts = { traework: 0, workbuddy: 0, codebuddy: 0, autoclaw: 0, codearts: 0 };
  const atomicWrite = (file, content) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.tmp';
    fs.writeFileSync(tmp, content);
    fs.renameSync(tmp, file);
  };
  // TraeWork：先停宿主（运行中的实例退出时会用内存中的旧登录覆盖 storage.json）
  if (isProcessRunning()) { try { killTraeWork(); await sleep(1500); } catch (_) {} }
  // 账号并入单文件账号库 + 当前登录密文写回 storage.json（保留本机 deviceId）
  const store = loadStore();
  if (data.traework) {
    for (const a of data.traework.accounts || []) {
      if (!a.uid || !a.secret) continue;
      const idx = store.traework.accounts.findIndex((x) => String(x.uid) === String(a.uid));
      if (idx >= 0) store.traework.accounts[idx] = Object.assign({}, store.traework.accounts[idx], a, { backedUpAt: Date.now() });
      else store.traework.accounts.push(Object.assign({ backedUpAt: Date.now() }, a));
      counts.traework++;
    }
    if (data.traework.currentSecret) {
      store.traework.currentSecret = data.traework.currentSecret;
      writeAuthSecret(data.traework.currentSecret);
    }
  }
  // WorkBuddy：账号写回 accounts；当前登录写回扩展 auth 文件
  if (data.workbuddy) {
    for (const a of data.workbuddy.accounts || []) {
      const uid = a && a.account && a.account.uid;
      if (!uid) continue;
      atomicWrite(path.join(WB_ACCOUNTS_DIR, `${uid}.info`), JSON.stringify(a, null, 2));
      counts.workbuddy++;
    }
    if (data.workbuddy.current) atomicWrite(WB_AUTH_FILE, JSON.stringify(data.workbuddy.current, null, 2));
    store.workbuddy = { current: data.workbuddy.current || null, accounts: data.workbuddy.accounts || [] };
  }
  // CodeBuddy：同上（独立 profile）
  if (data.codebuddy) {
    for (const a of data.codebuddy.accounts || []) {
      const uid = a && a.account && a.account.uid;
      if (!uid) continue;
      atomicWrite(path.join(CB_ACCOUNTS_DIR, `${uid}.info`), JSON.stringify(a, null, 2));
      counts.codebuddy++;
    }
    if (data.codebuddy.current) atomicWrite(CB_AUTH_FILE, JSON.stringify(data.codebuddy.current, null, 2));
    store.codebuddy = { current: data.codebuddy.current || null, accounts: data.codebuddy.accounts || [] };
  }
  // AutoClaw：仅并入账号库（不回写 auth.json —— 跨机恢复需本机 DPAPI 重加密，无意义）
  if (data.autoclaw) {
    for (const a of data.autoclaw.accounts || []) {
      const uid = a && a.uid;
      if (!uid) continue;
      const idx = store.ac.accounts.findIndex((x) => x && String(x.uid) === String(uid));
      if (idx >= 0) store.ac.accounts[idx] = Object.assign({}, store.ac.accounts[idx], a, { backedUpAt: Date.now() });
      else store.ac.accounts.push(Object.assign({ backedUpAt: Date.now() }, a));
      counts.autoclaw = (counts.autoclaw || 0) + 1;
    }
  }
  // CodeArts Agent：仅并入账号库（不回写 vscdb —— 切换时优先用本机可解的 secretRaw，
  // 跨机备份则用 secretPlain 以本机 safeStorage key 重加密，见 caSwitchToAccount）
  if (data.codearts) {
    for (const a of data.codearts.accounts || []) {
      const uid = a && a.uid;
      if (!uid || (!a.secretRaw && !a.secretPlain)) continue;
      const idx = store.codearts.accounts.findIndex((x) => x && String(x.uid) === String(uid));
      if (idx >= 0) store.codearts.accounts[idx] = Object.assign({}, store.codearts.accounts[idx], a, { backedUpAt: Date.now() });
      else store.codearts.accounts.push(Object.assign({ backedUpAt: Date.now() }, a));
      counts.codearts = (counts.codearts || 0) + 1;
    }
  }
  saveStore(store);
  return counts;
}


// ================= WB/CB 客户端支持（原生实现，替代外部引擎） =================
// WorkBuddy / CodeBuddy 的账号备份、切换、签到、积分查询全部由本 daemon 原生完成：
// 登录态 = CodeBuddyExtension 扩展 auth 文件（两个客户端各一条独立通道）；
// 账号库 = WorkPet-accounts.json 的 workbuddy/codebuddy 段；
// 签到/积分 = 各端 apiHost 的 HTTP 接口（Bearer accessToken）。

const { extractCreditSegments, sortCreditSegments, mergeCreditSegments } = require('./credit-segments.js');

// ---------------- AutoClaw（智谱 AutoGLM 桌面端，独立账号体系） ----------------
// 登录态 = %APPDATA%/autoclaw/auth.json（token/refreshToken 为 Electron safeStorage "enc:v10" 加密，
//   密钥在 Local State 的 os_crypt.encrypted_key —— DPAPI 包裹的 AES-256-GCM key，与浏览器同构）。
// 签到 = POST /autoclaw-proxy/proxy/autoclaw-task-complete { task_id: 'daily_signin' }（任务中心任务，
//   实测 daily_signin 的 reward_points 为 400，不写死数字，一律以服务端返回为准）。
// 积分 = GET /agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw（total_points / expiring_points）。
// 签名头 = X-Auth-Appid/X-Auth-TimeStamp/X-Auth-Sign（md5(appid&ts&appkey)），token 走 Authorization Bearer。
// Cookie 时限 = JWT exp（access_token 是 JWT，24h）；refresh 走 /userapi/v1/refresh（refresh_token 轮换，回写 auth.json）。
// macOS：Electron safeStorage 密钥在登录钥匙串（service "autoclaw Safe Storage"，密码经 PBKDF2 派生 AES key）
const AC_DATA_DIR = isMac
  ? path.join(os.homedir(), 'Library', 'Application Support', 'autoclaw')
  : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'autoclaw');
const AC_AUTH_FILE = path.join(AC_DATA_DIR, 'auth.json');
const AC_LOCAL_STATE = path.join(AC_DATA_DIR, 'Local State');
const AC_API_HOST = 'https://autoglm-acceleration-api.zhipuai.cn';
const AC_APP_ID = '100003';
const AC_APP_KEY = '38d2391985e2369a5fb8227d8e6cd5e5';

// ---------------- CodeArts Agent（华为云 CodeArts IDE 客户端，独立账号体系） ----------------
// 无签到：额度按官方政策自动发放（不写死任何数字）。WorkPet 只做「多账号登录态管理 + 一键切换」。
// 登录态 = VSCode 系数据目录 User/globalStorage/state.vscdb（SQLite ItemTable）里的两个键：
//   1) secret://{"extensionId":"huaweicloud.authentication","key":"HuaweiCloudSession"}
//      值为 {"type":"Buffer","data":[...]} 包装的 Electron safeStorage v10 密文，
//      密钥获取按平台分（与 AutoClaw 同构）：
//        Windows：AES-256-GCM，key 在数据目录 Local State 的 os_crypt.encrypted_key（DPAPI 包裹）；
//        macOS：AES-128-CBC（IV 固定 16 空格），key = PBKDF2(钥匙串随机密码, 'saltysalt', 1003 次, 16B, sha1)，
//          钥匙串条目 service "CodeArts Agent Safe Storage" / account "CodeArts Agent"（实测确认）。
//      明文含 refresh_token（长期）+ 临时 IAM 凭证 expires_at（约 1h，客户端运行期间自动续）；
//   2) huaweicloud.codearts-snap 键内含 userInfoKey（账号 id / 华为账号用户名 / 临时凭证快照）。
// 切换 = 停客户端（IDE 会持有/回写 vscdb）→ 备份库密文写回 vscdb（同机原样写回；跨机导入的备份
//   用 secretPlain 以本机 key 重加密）→ 同步内核侧 .codeartsdoer 的 userInfo.json → 按需重启客户端。
const CA_SECRET_KEY_DEFAULT = 'secret://{"extensionId":"huaweicloud.authentication","key":"HuaweiCloudSession"}';
const CA_SNAP_KEY = 'huaweicloud.codearts-snap';
const CA_IDE_EXE = 'codearts-agent.exe';
// Electron safeStorage 在 macOS 把随机密码存进登录钥匙串（与 AutoClaw 同构）。
// 实测：-w 读密码必须同时带 -a，只给 -s 会报条目不存在。
const CA_MAC_KEYCHAIN_SERVICE = 'CodeArts Agent Safe Storage';
const CA_MAC_KEYCHAIN_ACCOUNT = 'CodeArts Agent';
const CA_MAC_PBKDF2_SALT = Buffer.from('saltysalt', 'utf8');
const CA_MAC_PBKDF2_ITERS = 1003;
// macOS 主进程识别：路径形如 …/CodeArts Agent.app/Contents/MacOS/Electron（CFBundleExecutable
// 固定为 "Electron"），Helper 子进程路径不含该子串，不会误伤。
// 实测坑：Electron 主进程的 argv 区会被框架改写，pgrep/pkill -f 读不到它（Helper 却正常），
// 进程检测/终止一律走 ps 全量枚举 + kill，绝不能用 pgrep/pkill。
const CA_MAC_PROCESS_RE = /CodeArts[ _-]?Agent\.app\/Contents\/MacOS\/Electron(?: |$)/;
// macOS AgentKernel 内核进程（路径形如 ~/.codeartsdoer/CodeArts_Agent/AgentKernel_*，名字带版本号）
const CA_MAC_KERNEL_RE = /CodeArts_Agent\/AgentKernel_/;
function detectCodeArtsDataDir() {
  if (process.env.WORKPET_CODEARTS_DIR) {
    const d = process.env.WORKPET_CODEARTS_DIR;
    if (fs.existsSync(path.join(d, 'User', 'globalStorage', 'state.vscdb'))) return d;
  }
  // macOS: ~/Library/Application Support；Windows: %APPDATA%（目录名两平台都形如 "CodeArts Agent"）
  const roots = isMac
    ? [path.join(os.homedir(), 'Library', 'Application Support')]
    : [process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')];
  for (const root of roots) {
    let names = [];
    try { names = fs.readdirSync(root).filter((n) => /^codearts[-_ ]?agent$/i.test(n)); } catch (_) {}
    for (const n of names) {
      const d = path.join(root, n);
      if (fs.existsSync(path.join(d, 'User', 'globalStorage', 'state.vscdb'))) return d;
    }
  }
  // 二改：新版码道客户端（数据目录 "codearts"，登录态在 secretStorage/*.enc，无 state.vscdb）
  for (const root of roots) {
    try {
      const d = path.join(root, 'codearts');
      if (fs.existsSync(path.join(d, 'Local State')) && fs.existsSync(path.join(d, 'secretStorage'))) return d;
    } catch (_) {}
  }
  return null;
}
const CA_DATA_DIR = detectCodeArtsDataDir();
const CA_VSCDB = CA_DATA_DIR ? path.join(CA_DATA_DIR, 'User', 'globalStorage', 'state.vscdb') : null;
const CA_LOCAL_STATE = CA_DATA_DIR ? path.join(CA_DATA_DIR, 'Local State') : null;
const CA_LAYOUT = !CA_DATA_DIR ? null : (CA_VSCDB && fs.existsSync(CA_VSCDB) ? 'vscdb' : 'storage'); // 二改：新版码道客户端为 storage 布局
// CodeArts Agent（Doer 内核）侧的用户身份文件：切换账号时一并换回，保持内核会话一致
const CA_DOER_USERINFO = path.join(os.homedir(), '.codeartsdoer', 'codearts-data', 'storage', 'userInfo.json');
// macOS 主二进制名固定为 "Electron"，且安装位置不限于 /Applications（找不到时 caFindExe 会从运行中进程反查）
const CA_MAC_EXE_CANDIDATES = [
  '/Applications/CodeArts Agent.app/Contents/MacOS/Electron',
  path.join(os.homedir(), 'Applications', 'CodeArts Agent.app', 'Contents', 'MacOS', 'Electron'),
];
const CA_EXE_CANDIDATES = (process.env.WORKPET_CODEARTS_BIN ? [process.env.WORKPET_CODEARTS_BIN] : []).concat(isMac ? CA_MAC_EXE_CANDIDATES : [
  'D:/Program Files/CodeArts Agent/' + CA_IDE_EXE,
  path.join(process.env.ProgramFiles || 'C:/Program Files', 'CodeArts Agent', CA_IDE_EXE),
  path.join(process.env['ProgramFiles(x86)'] || 'C:/Program Files (x86)', 'CodeArts Agent', CA_IDE_EXE),
  path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'CodeArts Agent', CA_IDE_EXE),
]);

const CLIENT_PROFILES = {
  wb: {
    id: 'wb', name: 'WorkBuddy',
    authFile: WB_AUTH_FILE,
    apiHost: 'https://www.workbuddy.cn',
    checkinHosts: ['https://www.workbuddy.cn', 'https://www.codebuddy.cn'],
    cdpPort: 9222,
  },
  cb: {
    // 二改：此槽位改为 WorkBuddy 国际版（www.workbuddy.ai）——与国内 WorkBuddy 共用腾讯 OneID，
    // 登录态文件为 workbuddy-desktop-ai.info；国际版无签到（积分自动发放），仅做账号管理+积分查询
    id: 'cb', name: 'WorkBuddy AI',
    authFile: path.join(EXT_AUTH_DIR, 'workbuddy-desktop-ai.info'),
    apiHost: 'https://www.workbuddy.ai',
    checkinHosts: [],
    cdpPort: 9224,
  },
  ac: {
    id: 'ac', name: 'AutoClaw',
    authFile: AC_AUTH_FILE,
    apiHost: AC_API_HOST,
    checkinHosts: [AC_API_HOST],
    cdpPort: 9226,
  },
  ca: {
    id: 'ca', name: 'CodeArts Agent',
    authFile: CA_VSCDB, // 仅作路径展示用；ca 登录态在 SQLite 里，读写全部走专用函数
    apiHost: '',
    checkinHosts: [],
    cdpPort: 9228,
  },
};

// ---------------- AutoClaw 登录态解密（DPAPI + AES-256-GCM） ----------------
// Node 无内置 DPAPI，解 Local State 的 key 需要拉起 powershell。
// 绝不能像旧实现那样用 execFileSync 同步等它：powershell 一旦卡死（曾实测挂死数分钟），
// 整个 daemon 事件循环被堵住，HTTP 全部无响应，前端就报「后台服务未运行」。
// 因此这里统一为：异步 spawn + 12s 硬超时（按进程树强杀）+ AES key 只解一次并缓存。
const AC_KEY_PENDING = Symbol('ac-key-pending');
let acKeyCache = null;    // 已解出的 AES-256 key（Buffer），只解密一次
let acKeyPromise = null;  // 进行中的异步解密（并发共享）

/** 仅当 win-dpapi 原生模块可用时同步解密；不可用返回 null（走 powershell） */
function acDpapiNative(data) {
  try {
    const { CryptUnprotectData } = (() => { try { return require('win-dpapi'); } catch (_) { return {}; } })();
    if (CryptUnprotectData) return CryptUnprotectData(Buffer.from(data));
  } catch (_) {}
  return null;
}

/** 异步跑一次 powershell Unprotect；12s 未完成则按进程树强杀，绝不悬挂 */
function acDpapiViaPowershell(data) {
  return new Promise((resolve, reject) => {
    const inB64 = Buffer.from(data).toString('base64');
    const ps = `$ProgressPreference='SilentlyContinue'; Add-Type -AssemblyName System.Security; [Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String('${inB64}'), $null, [Security.Cryptography.DataProtectionScope]::CurrentUser))`;
    const encCmd = Buffer.from(ps, 'utf16le').toString('base64');
    const child = spawn('powershell', ['-NoProfile', '-EncodedCommand', encCmd], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // 只杀 powershell 不够（其子进程可能还握着 stdout 管道）；按进程树强杀
      try { spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch (_) {}
      reject(new Error('DPAPI 解密超时（已强杀 powershell 进程树）'));
    }, 12000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('DPAPI powershell 启动失败: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) { reject(new Error('DPAPI powershell 退出码 ' + code)); return; }
      try {
        // PowerShell 5 会在 stdout 前打 CLIXML 进度块，去掉到 </Objs> 之后的部分
        const idx = out.lastIndexOf('</Objs>');
        const clean = (idx >= 0 ? out.slice(idx + 7) : out).trim();
        const key = Buffer.from(clean, 'base64');
        if (!key.length) throw new Error('解密结果为空');
        resolve(key);
      } catch (e) { reject(new Error('DPAPI 解密结果解析失败: ' + e.message)); }
    });
  });
}

// ---------------- macOS：从登录钥匙串读取 safeStorage 密码并派生 AES key ----------------
// Electron safeStorage 在 macOS 上把随机密码存进登录钥匙串（service "<AppName> Safe Storage"，
// account "<AppName>"），AES key = PBKDF2-HMAC-SHA1(password, salt="saltysalt", 1003 次, 16B)。
// 与 Windows 的 Local State + DPAPI 完全不同的路径；首次读取会弹钥匙串授权框，用户点允许后记住。
const AC_KEYCHAIN_SERVICE = 'autoclaw Safe Storage';
const AC_KEYCHAIN_ACCOUNT = 'autoclaw';
const AC_MAC_PBKDF2_SALT = Buffer.from('saltysalt', 'utf8');
const AC_MAC_PBKDF2_ITERS = 1003;

function acMacDeriveKey(keychainPassword) {
  return crypto.pbkdf2Sync(keychainPassword, AC_MAC_PBKDF2_SALT, AC_MAC_PBKDF2_ITERS, 16, 'sha1');
}

/** 异步读钥匙串密码（spawn security；15s 超时，不阻塞事件循环，与 Windows powershell 路径同理） */
function acMacReadPasswordAsync() {
  return new Promise((resolve, reject) => {
    const child = spawn('security', ['find-generic-password', '-s', AC_KEYCHAIN_SERVICE, '-a', AC_KEYCHAIN_ACCOUNT, '-w'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill(); } catch (_) {}
      reject(new Error('AutoClaw 钥匙串读取超时（15s）'));
    }, 15000);
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', () => {});
    child.on('error', (e) => { clearTimeout(timer); reject(new Error('AutoClaw 钥匙串启动失败: ' + e.message)); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) return;
      if (code !== 0) { reject(new Error('AutoClaw 钥匙串读取失败(exit ' + code + ')')); return; }
      const pw = out.trim();
      if (!pw) { reject(new Error('AutoClaw 钥匙串密码为空')); return; }
      resolve(acMacDeriveKey(pw));
    });
  });
}

/** 获取 AutoClaw AES key：只解一次并缓存；并发调用共享同一个 Promise */
function acRequestKey() {
  if (acKeyCache) return Promise.resolve(acKeyCache);
  if (!acKeyPromise) {
    acKeyPromise = (isMac
      ? acMacReadPasswordAsync()
      : (async () => {
          const ls = readJsonOrNull(AC_LOCAL_STATE);
          const enc = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
          if (!enc) throw new Error('AutoClaw Local State 无 os_crypt.encrypted_key');
          const raw = Buffer.from(enc, 'base64');
          if (raw.slice(0, 5).toString() !== 'DPAPI') return raw;
          const viaNative = acDpapiNative(raw.slice(5));
          if (viaNative) return viaNative;
          return await acDpapiViaPowershell(raw.slice(5));
        })()
    ).then((k) => { acKeyCache = k; acKeyPromise = null; return k; })
      .catch((e) => { acKeyPromise = null; throw e; });
  }
  return acKeyPromise;
}

/** 后台预热 key（静默失败；daemon 启动时调用，让首次读账号前已就绪） */
function acWarmKey() {
  acRequestKey().catch((e) => log('[client:ac] AES key 预取失败: ' + e.message));
}

/** 同步取 key：已缓存直接返回；未就绪抛 AC_KEY_PENDING（调用方快速失败，绝不阻塞） */
function acKeySync() {
  if (acKeyCache) return acKeyCache;
  throw AC_KEY_PENDING;
}

/** 纯 AES 解密单个 token；key 可显式传入（异步路径）或走缓存（同步路径）。
 *  Windows: v10 + nonce(12) + ciphertext + tag(16)，AES-256-GCM，key 来自 DPAPI。
 *  macOS:   v10 + ciphertext，AES-128-CBC（IV 固定 16 空格，PKCS7），key 来自钥匙串 PBKDF2 派生。 */
function acDecryptToken(encStr, key) {
  if (!encStr) return '';
  if (!encStr.startsWith('enc:')) return encStr.replace(/^Bearer\s+/, '');
  const raw = Buffer.from(encStr.slice(4), 'base64');
  if (raw.slice(0, 3).toString() !== 'v10') return encStr.replace(/^Bearer\s+/, '');
  const k = key || acKeySync(); // 同步路径未就绪时抛 AC_KEY_PENDING
  let pt;
  if (isMac) {
    const dec = crypto.createDecipheriv('aes-128-cbc', k, Buffer.alloc(16, 0x20));
    pt = Buffer.concat([dec.update(raw.slice(3)), dec.final()]);
  } else {
    const nonce = raw.slice(3, 15), ct = raw.slice(15);
    const tag = ct.slice(ct.length - 16), body = ct.slice(0, ct.length - 16);
    const dec = crypto.createDecipheriv('aes-256-gcm', k, nonce);
    dec.setAuthTag(tag);
    pt = Buffer.concat([dec.update(body), dec.final()]);
  }
  return pt.toString('utf8').replace(/^Bearer\s+/, '');
}

/** 异步解密单 token（等待/触发 key 就绪后再解） */
async function acDecryptTokenAsync(encStr) {
  if (!encStr || !encStr.startsWith('enc:')) return acDecryptToken(encStr);
  return acDecryptToken(encStr, await acRequestKey());
}

/** 读取 AutoClaw 登录态（解密后），返回 { token, refreshToken, userId, phone, deviceId, raw } 或 { error } */
function acReadAuth() {
  const raw = readJsonOrNull(AC_AUTH_FILE);
  if (!raw || !raw.token) return null;
  try {
    const key = acKeySync();
    const token = acDecryptToken(raw.token, key);
    const refreshToken = acDecryptToken(raw.refreshToken || '', key);
    return acBuildAuth(raw, token, refreshToken);
  } catch (e) {
    // key 未就绪（AC_KEY_PENDING）或解密失败：快速返回错误，绝不阻塞等待 powershell
    return { error: e === AC_KEY_PENDING ? 'AutoClaw 登录态解密未就绪（稍后自动重试）' : 'AutoClaw 登录态解密失败: ' + e.message };
  }
}

/** 异步版 acReadAuth：先确保 AES key 就绪（内部 12s 硬超时+树杀），再同步解密 */
async function acReadAuthAsync() {
  const raw = readJsonOrNull(AC_AUTH_FILE);
  if (!raw || !raw.token) return null;
  try {
    const key = await acRequestKey();
    const token = acDecryptToken(raw.token, key);
    const refreshToken = acDecryptToken(raw.refreshToken || '', key);
    return acBuildAuth(raw, token, refreshToken);
  } catch (e) {
    return { error: 'AutoClaw 登录态解密失败: ' + e.message };
  }
}

/** 由明文 token/refreshToken 组装统一形状 */
function acBuildAuth(raw, token, refreshToken) {
  let jwt = {};
  try {
    const p = token.split('.')[1];
    if (p) jwt = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
  } catch (_) {}
  return {
    token,
    refreshToken,
    userId: (jwt.user_id || raw.userInfo && raw.userInfo.user_id || ''),
    phone: (raw.userInfo && (raw.userInfo.user_phone || raw.userInfo.phone)) || '',
    deviceId: raw.deviceId || '',
    jwtExp: jwt.exp ? jwt.exp * 1000 : null,
    raw,
  };
}

// ── 二改: AutoClaw 每账号独立续期 + OmniRoute 推送 + 全自动签到轮 ──
function omniSyncConfig() {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_ROOT, 'omniroute-sync.json'), 'utf8')); } catch (_) { return null; }
}
async function acRefreshStoreAccount(rec) {
  const body = JSON.stringify({ source_id: 'autoclaw', device_id: rec.deviceId || '', refresh_token: rec.refreshToken });
  const r = await fetch(AC_API_HOST + '/userapi/v1/refresh', {
    method: 'POST',
    headers: acSignHeaders({ 'content-type': 'application/json' }),
    body,
    signal: AbortSignal.timeout(12000),
  });
  const o = await r.json().catch(() => ({}));
  if (o.code !== 0 || !o.data || !o.data.access_token) throw new Error('refresh 失败: ' + (o.msg || ('HTTP ' + r.status)));
  return { accessToken: String(o.data.access_token), refreshToken: String(o.data.refresh_token || rec.refreshToken) };
}
async function acEnsureFreshForAccount(uid) {
  const store = loadStore();
  const rec = (store.ac.accounts || []).find((x) => String(x.uid) === String(uid));
  if (!rec) return null;
  const exp = Number(rec.tokenExpiresAt || 0);
  if (rec.accessToken && exp && Date.now() < exp - 30 * 60 * 1000) return rec; // 仍新鲜
  if (!rec.refreshToken) return rec;
  const r = await acRefreshStoreAccount(rec);
  rec.accessToken = r.accessToken;
  rec.refreshToken = r.refreshToken;
  rec.tokenExpiresAt = acJwtExpMs(r.accessToken) || (Date.now() + 86400 * 1000);
  rec.lastRefreshTime = Date.now();
  saveStore(store);
  log('[client:ac] 二改续期 uid ' + uid + ' (' + (rec.nickname || '') + ')');
  const omni = omniSyncConfig();
  if (omni && omni.enabled && omni.url && omni.apiKey && omni.uidMap && omni.uidMap[String(uid)]) {
    try {
      await fetch(omni.url.replace(/\/$/, '') + '/api/providers/' + omni.uidMap[String(uid)], {
        method: 'PATCH',
        headers: { 'Authorization': 'Bearer ' + omni.apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: r.accessToken, providerSpecificData: { refreshToken: r.refreshToken, deviceId: rec.deviceId || '' } }),
        signal: AbortSignal.timeout(15000),
      });
      log('[client:ac] 新 token 已推送 OmniRoute uid ' + uid);
    } catch (e) { log('[client:ac] OmniRoute 推送失败: ' + e.message); }
  }
  return rec;
}
async function re2ClaimAllProfiles() {
  for (const pid of ['wb', 'cb', 'ac']) {
    try { await clientClaimDailyForAll(pid); } catch (e) { log('[re2] ' + pid + ' 签到轮异常: ' + e.message); }
    await sleep(1000);
  }
}
// ── 二改结束 ──

function acSignHeaders(extra) {
  const ts = String(Math.floor(Date.now() / 1000));
  const sign = crypto.createHash('md5').update(`${AC_APP_ID}&${ts}&${AC_APP_KEY}`).digest('hex');
  return Object.assign({
    accept: '*/*',
    'x-version': '1.0.0',
    'x-tm': 'win',
    'x-product': 'autoclaw',
    'x-auth-appid': AC_APP_ID,
    'x-auth-timestamp': ts,
    'x-auth-sign': sign,
    'x-trace-id': crypto.randomUUID(),
    'user-agent': 'autoclaw/1.0',
  }, extra || {});
}

/** AutoClaw refresh：refresh_token 轮换，成功后回写 auth.json（加密格式保持原样：只换 token 字段） */
async function acRefreshToken() {
  const auth = await acReadAuthAsync();
  if (!auth || auth.error || !auth.refreshToken) throw new Error('AutoClaw 无 refresh_token');
  const body = JSON.stringify({ source_id: 'autoclaw', device_id: auth.deviceId, refresh_token: auth.refreshToken });
  const r = await fetch(AC_API_HOST + '/userapi/v1/refresh', {
    method: 'POST',
    headers: acSignHeaders({ 'content-type': 'application/json' }),
    body,
    signal: AbortSignal.timeout(12000),
  });
  const o = await r.json().catch(() => ({}));
  if (o.code !== 0 || !o.data || !o.data.access_token) throw new Error('refresh 失败: ' + (o.msg || ('HTTP ' + r.status)));
  return { accessToken: String(o.data.access_token), refreshToken: String(o.data.refresh_token || auth.refreshToken), jwtExp: null };
}

/** 解析 JWT exp（毫秒） */
function acJwtExpMs(token) {
  try {
    const p = token.split('.')[1];
    if (!p) return null;
    const j = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return j.exp ? j.exp * 1000 : null;
  } catch (_) { return null; }
}

/** 把刷新后的 token 写回 auth.json（保持 enc:v10 加密格式：重新加密需要 DPAPI，这里只在能加密时回写，否则不动文件） */
async function acPersistRefreshedToken(newAccess, newRefresh) {
  try {
    const raw = readJsonOrNull(AC_AUTH_FILE);
    if (!raw) return false;
    // 尝试用同 key 重新加密（保持各平台 Electron safeStorage 原生格式，AutoClaw 自身可读回）
    const key = await acRequestKey();
    const enc = (plain) => {
      if (isMac) {
        // macOS：enc: + base64(v10 + AES-128-CBC 密文)，IV 固定 16 空格
        const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
        const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
        return 'enc:' + Buffer.concat([Buffer.from('v10', 'utf8'), ct]).toString('base64');
      }
      // Windows：v10 + nonce(12) + ciphertext + tag(16)，AES-256-GCM
      const nonce = crypto.randomBytes(12);
      const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
      const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
      const tag = cipher.getAuthTag();
      return 'enc:v10' + Buffer.concat([nonce, ct, tag]).toString('base64');
    };
    const next = Object.assign({}, raw, {
      token: enc('Bearer ' + newAccess.replace(/^Bearer\s+/, '')),
      refreshToken: enc('Bearer ' + newRefresh.replace(/^Bearer\s+/, '')),
      updatedAt: String(Date.now()),
    });
    const tmp = AC_AUTH_FILE + '.workpet-tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, AC_AUTH_FILE);
    return true;
  } catch (e) {
    log('[client:ac] 回写 auth.json 失败（不影响签到）: ' + e.message);
    return false;
  }
}

/** refresh 成功后同步进账号库（ac 段） */
function acSyncStoreAfterRefresh(accessToken, refreshToken, jwtExp) {
  try {
    const store = loadStore();
    if (!store.ac) store.ac = { current: null, accounts: [] };
    let uid = '';
    try {
      const p = accessToken.split('.')[1];
      if (p) uid = String(JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8')).user_id || '');
    } catch (_) {}
    const rec0 = store.ac.current || store.ac.accounts[0];
    uid = uid || (rec0 && rec0.uid) || '';
    if (!uid) return;
    const idx = store.ac.accounts.findIndex((x) => x && String(x.uid) === uid);
    if (idx < 0) return;
    store.ac.accounts[idx] = Object.assign({}, store.ac.accounts[idx], {
      accessToken, refreshToken, tokenExpiresAt: jwtExp || null, lastRefreshTime: Date.now(),
    });
    if (store.ac.current && String(store.ac.current.uid) === uid) store.ac.current = store.ac.accounts[idx];
    saveStore(store);
  } catch (_) {}
}

// ---------------- CodeArts Agent 登录态（safeStorage 解密 + state.vscdb 读写） ----------------
// 与 AutoClaw 同构的 Electron safeStorage v10。key 获取按平台分：
//   Windows：DPAPI 解 Local State 的 key，再 AES-256-GCM；
//   macOS：登录钥匙串读随机密码 → PBKDF2 派生，再 AES-128-CBC。
// CodeArts 的 key 缓存与 AC 分开维护。

const CA_KEY_PENDING = Symbol('ca-key-pending');
let caKeyCache = null;    // 已解出的 CodeArts AES key（Windows 32B / macOS 16B）
let caKeyPromise = null;  // 进行中的异步解密（并发共享）

/** macOS：从登录钥匙串读 safeStorage 随机密码（异步 spawn + 15s 硬超时，绝不阻塞事件循环）。
 *  首次访问若系统弹钥匙串授权框，用户点「始终允许」后不会再问（README 有说明）。 */
function caMacReadKeychainPasswordAsync() {
  return new Promise((resolve, reject) => {
    const child = spawn('security', ['find-generic-password', '-s', CA_MAC_KEYCHAIN_SERVICE, '-a', CA_MAC_KEYCHAIN_ACCOUNT, '-w'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', done = false;
    const t = setTimeout(() => {
      if (done) return; done = true;
      try { child.kill('SIGKILL'); } catch (_) {}
      reject(new Error('security 读取钥匙串超时'));
    }, 15000);
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => { if (!done) { done = true; clearTimeout(t); reject(e); } });
    child.on('close', (code) => {
      if (done) return; done = true; clearTimeout(t);
      const pw = String(out || '').trim();
      if (code === 0 && pw) resolve(pw);
      else reject(new Error('读取钥匙串失败(code=' + code + '): ' + (String(err || '').trim() || '无输出')));
    });
  });
}

/** macOS：钥匙串随机密码 → PBKDF2-HMAC-SHA1 派生 16B AES key（Electron/Chromium 固定参数） */
function caMacDeriveKey(keychainPassword) {
  return crypto.pbkdf2Sync(keychainPassword, CA_MAC_PBKDF2_SALT, CA_MAC_PBKDF2_ITERS, 16, 'sha1');
}

/** 获取 CodeArts safeStorage AES key：只解一次并缓存（Windows 复用 AC 的 DPAPI 实现，入参即密文） */
function caRequestKey() {
  if (caKeyCache) return Promise.resolve(caKeyCache);
  if (!caKeyPromise) {
    caKeyPromise = (async () => {
      if (isMac) return caMacDeriveKey(await caMacReadKeychainPasswordAsync());
      const ls = readJsonOrNull(CA_LOCAL_STATE);
      const enc = ls && ls.os_crypt && ls.os_crypt.encrypted_key;
      if (!enc) throw new Error('CodeArts Local State 无 os_crypt.encrypted_key');
      const raw = Buffer.from(enc, 'base64');
      if (raw.slice(0, 5).toString() !== 'DPAPI') return raw;
      const viaNative = acDpapiNative(raw.slice(5));
      if (viaNative) return viaNative;
      return await acDpapiViaPowershell(raw.slice(5));
    })().then((k) => { caKeyCache = k; caKeyPromise = null; return k; })
      .catch((e) => { caKeyPromise = null; throw e; });
  }
  return caKeyPromise;
}

/** 后台预热（daemon 启动时调用，静默失败） */
function caWarmKey() {
  if (!CA_VSCDB) return;
  caRequestKey().catch((e) => log('[client:ca] AES key 预取失败: ' + e.message));
}

/** node:sqlite 惰性加载（需 Node 22+；缺失时给出明确错误而不是崩溃） */
let CaSqliteModule = undefined; // undefined=未探测 / null=不可用
function caSqlite() {
  if (CaSqliteModule !== undefined) return CaSqliteModule;
  try { CaSqliteModule = require('node:sqlite'); }
  catch (_) { CaSqliteModule = null; }
  return CaSqliteModule;
}

/** 打开 vscdb（读路径优先只读；readOnly 选项在不支持的 Node 版本上自动降级） */
function caOpenDb(file, readOnly) {
  const sqlite = caSqlite();
  if (!sqlite) throw new Error('当前 Node 运行时无 node:sqlite（切换 CodeArts 账号需 Node 22+）');
  if (readOnly) {
    try { return new sqlite.DatabaseSync(file, { readOnly: true }); } catch (_) {}
  }
  return new sqlite.DatabaseSync(file);
}

/**
 * 读取 state.vscdb 里的两个登录键（只读，带重试：客户端运行期间可能瞬时持锁）。
 * 返回 { secretKey, secretRaw, snapState }；无数据目录/无登录返回 null；不可用返回 { error }。
 */
function caReadDb(retries) {
  if (!CA_VSCDB || !fs.existsSync(CA_VSCDB)) return null;
  if (!caSqlite()) return { error: '当前 Node 运行时无 node:sqlite（需 Node 22+，请更新 Work Pet 安装包）' };
  const n = retries || 3;
  for (let i = 0; i < n; i++) {
    let db = null;
    try {
      db = caOpenDb(CA_VSCDB, true);
      const srow = db.prepare("SELECT key, value FROM ItemTable WHERE key LIKE 'secret://%' AND key LIKE '%HuaweiCloudSession%'").get();
      const snapRow = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(CA_SNAP_KEY);
      return {
        secretKey: srow ? String(srow.key) : CA_SECRET_KEY_DEFAULT,
        secretRaw: srow ? String(srow.value) : null,
        snapState: snapRow ? String(snapRow.value) : null,
      };
    } catch (e) {
      if (i >= n - 1) return { error: '读取 CodeArts 登录库失败: ' + e.message };
    } finally {
      try { if (db) db.close(); } catch (_) {}
    }
  }
  return null;
}

/** 解密 vscdb 的 secret 值（{"type":"Buffer","data":[...]} → v10 → 平台分支 → 明文 JSON 字符串） */
function caDecryptVscSecret(vscValue, key) {
  const s = String(vscValue || '');
  let bytes;
  if (s.startsWith('{"type":"Buffer"')) bytes = Buffer.from(JSON.parse(s).data);
  else bytes = Buffer.from(s, 'latin1'); // 兼容旧形态
  if (bytes.slice(0, 3).toString('latin1') !== 'v10') throw new Error('非 safeStorage v10 格式');
  if (isMac) {
    // macOS：v10 + ciphertext，AES-128-CBC（IV 固定 16 空格 0x20，PKCS7）
    const dec = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    return Buffer.concat([dec.update(bytes.slice(3)), dec.final()]).toString('utf8');
  }
  const nonce = bytes.slice(3, 15), ct = bytes.slice(15);
  const tag = ct.slice(ct.length - 16), body = ct.slice(0, ct.length - 16);
  const dec = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  dec.setAuthTag(tag);
  return Buffer.concat([dec.update(body), dec.final()]).toString('utf8');
}

/** 用本机 key 把明文会话 JSON 重新加密成 vscdb 的 secret 值（跨机器恢复用） */
function caEncryptVscSecret(plain, key) {
  if (isMac) {
    const cipher = crypto.createCipheriv('aes-128-cbc', key, Buffer.alloc(16, 0x20));
    const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
    const bytes = Buffer.concat([Buffer.from('v10', 'latin1'), ct]);
    return JSON.stringify({ type: 'Buffer', data: Array.from(bytes) });
  }
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  const bytes = Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ct, cipher.getAuthTag()]);
  return JSON.stringify({ type: 'Buffer', data: Array.from(bytes) });
}

// ── 二改：新版码道客户端（secretStorage 布局）读取/写回 ──
function caStorageDir() { return path.join(CA_DATA_DIR, 'secretStorage'); }
function caStorageListEnc() {
  try { return fs.readdirSync(caStorageDir()).filter((f) => f.endsWith('.enc')); } catch (_) { return []; }
}
function caNewDecryptSession(b64Text, key) {
  const raw = Buffer.from(String(b64Text || ''), 'utf8');
  if (raw.slice(0, 3).toString('latin1') !== 'v10') throw new Error('非 safeStorage v10 格式');
  const nonce = raw.slice(3, 15), ct = raw.slice(15);
  const tag = ct.slice(ct.length - 16), body = ct.slice(0, ct.length - 16);
  const dec = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  dec.setAuthTag(tag);
  return JSON.parse(Buffer.concat([dec.update(body), dec.final()]).toString('utf8'));
}
function caNewEncryptSession(sessionJson, key) {
  const plain = Buffer.from(JSON.stringify(sessionJson), 'utf8');
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ct = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  return Buffer.from(Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ct])).toString('base64');
}
/** 列出新布局全部会话 → [{ file, uid, nickname, session, secretRaw, secretPlain }] */
async function caStorageReadSessions() {
  const key = await caRequestKey();
  const out = [];
  for (const f of caStorageListEnc()) {
    try {
      const b64 = fs.readFileSync(path.join(caStorageDir(), f), 'utf8');
      const session = caNewDecryptSession(b64, key);
      const uid = String(session.session && session.session.userId || session.userId || '');
      if (!uid) continue;
      out.push({
        file: f, uid,
        nickname: String(session.session && session.session.userName || uid),
        session, secretRaw: b64, secretPlain: JSON.stringify(session),
      });
    } catch (_) {}
  }
  return out;
}

/** 读取并解密当前登录态 → { uid, nickname, sessionExp, refreshTokenExp, secretRaw, secretPlain, snapState, userInfoJson } */
async function caReadAuthAsync() {
  if (CA_LAYOUT === 'storage') {
    // 二改：新版码道客户端（secretStorage 布局）
    const sessions = await caStorageReadSessions();
    if (!sessions.length) return null;
    // 当前会话 = mtime 最新的 .enc
    let newest = sessions[0];
    for (const s of sessions) {
      try {
        if (fs.statSync(path.join(caStorageDir(), s.file)).mtimeMs > fs.statSync(path.join(caStorageDir(), newest.file)).mtimeMs) newest = s;
      } catch (_) {}
    }
    return {
      uid: newest.uid,
      nickname: newest.nickname,
      sessionExp: null,
      refreshTokenExp: null,
      secretRaw: newest.secretRaw,
      secretPlain: newest.secretPlain,
      snapState: null,
      userInfoJson: null,
      re2File: newest.file,
      re2Sessions: sessions,
    };
  }
  const dbv = caReadDb();
  if (!dbv || dbv.error) return dbv && dbv.error ? { error: dbv.error } : null;
  if (!dbv.secretRaw) return null; // 从未登录过
  const key = await caRequestKey();
  const secretPlain = caDecryptVscSecret(dbv.secretRaw, key); // 解密失败会抛出（key 不匹配/数据损坏）
  let j = null;
  try { j = JSON.parse(secretPlain); } catch (e) { throw new Error('会话明文解析失败: ' + e.message); }
  let snap = null;
  try { snap = dbv.snapState ? JSON.parse(dbv.snapState) : null; } catch (_) {}
  const info = (snap && snap.userInfoKey) || {};
  const uid = String((j.account && j.account.id) || info.id || '');
  if (!uid) return null;
  const nickname = String((j.account && j.account.label) || info.name || uid);
  return {
    uid, nickname,
    sessionExp: j.expires_at ? Date.parse(j.expires_at) : null,
    refreshTokenExp: acJwtExpMs(j.refresh_token || ''),
    secretRaw: dbv.secretRaw,
    secretPlain,
    snapState: dbv.snapState || null,
    userInfoJson: (() => { try { return fs.readFileSync(CA_DOER_USERINFO, 'utf8'); } catch (_) { return null; } })(),
  };
}

/** 把当前登录同步进账号库 codearts 段（登录库变化时调用；仅在内容变化时落盘） */
let caSwitching = false; // 切换过程中挂起同步，防止读到中间态
async function caSyncStore() {
  if (caSwitching) return null;
  if (CA_LAYOUT === 'storage') {
    // 二改：新版码道客户端 —— 全部会话并入账号库
    const all = await caStorageReadSessions();
    if (!all.length) return null;
    const store = loadStore();
    store.codearts = store.codearts || { current: null, accounts: [] };
    store.codearts.accounts = store.codearts.accounts || [];
    for (const s of all) {
      const rec = {
        uid: s.uid, nickname: s.nickname,
        sessionExpiresAt: null, tokenExpiresAt: null,
        secretRaw: s.secretRaw, secretPlain: s.secretPlain,
        snapState: null, userInfoJson: null,
        re2File: s.file, backedUpAt: Date.now(),
      };
      const idx = store.codearts.accounts.findIndex((x) => x && String(x.uid) === String(s.uid));
      if (idx >= 0) store.codearts.accounts[idx] = Object.assign({}, store.codearts.accounts[idx], rec);
      else store.codearts.accounts.push(rec);
    }
    if (!store.codearts.accounts.length) return null;
    store.codearts.current = store.codearts.accounts[store.codearts.accounts.length - 1];
    saveStore(store);
    return a = null, store.codearts.current;
  }
  if (!CA_VSCDB) return null;
  const a = await caReadAuthAsync();
  if (!a || a.error || !a.uid) return a || null;
  const store = loadStore();
  const rec = {
    uid: a.uid,
    nickname: a.nickname,
    sessionExpiresAt: a.sessionExp,
    tokenExpiresAt: a.refreshTokenExp || a.sessionExp, // 卡片「Cookie 时限」= refresh_token 有效期
    secretRaw: a.secretRaw,
    secretPlain: a.secretPlain,
    snapState: a.snapState,
    userInfoJson: a.userInfoJson,
    backedUpAt: Date.now(),
  };
  const idx = store.codearts.accounts.findIndex((x) => x && String(x.uid) === String(a.uid));
  const prev = idx >= 0 ? store.codearts.accounts[idx] : null;
  const changed = !prev
    || prev.secretRaw !== rec.secretRaw || prev.snapState !== rec.snapState
    || prev.nickname !== rec.nickname || prev.tokenExpiresAt !== rec.tokenExpiresAt
    || prev.sessionExpiresAt !== rec.sessionExpiresAt || prev.userInfoJson !== rec.userInfoJson;
  if (idx >= 0) store.codearts.accounts[idx] = Object.assign({}, prev, rec);
  else store.codearts.accounts.push(rec);
  store.codearts.current = store.codearts.accounts[idx >= 0 ? idx : store.codearts.accounts.length - 1];
  if (changed) saveStore(store);
  return a;
}

/** 列出 CodeArts 全部账号（供 /api/client/ca/accounts） */
function caListAccounts() {
  const store = loadStore();
  const cur = store.codearts.current;
  const curUid = cur ? String(cur.uid) : null;
  const seen = new Set();
  const list = [];
  const push = (r) => {
    if (!r || !r.uid || seen.has(String(r.uid))) return;
    seen.add(String(r.uid));
    list.push({
      uid: String(r.uid),
      nickname: r.nickname || String(r.uid),
      phone: '',
      tokenExpiresAt: r.tokenExpiresAt || null,
      sessionExpiresAt: r.sessionExpiresAt || null,
      checkin: null, // CodeArts 无签到
    });
  };
  if (cur) push(cur);
  for (const r of store.codearts.accounts) push(r);
  list.sort((a, b) => (a.uid === curUid ? -1 : b.uid === curUid ? 1 : 0));
  return { currentUid: curUid, accounts: list };
}

// ---------------- CodeArts 进程管理 ----------------

/** macOS：ps 全量枚举 CodeArts 主进程。
 *  实测 Electron 主进程 argv 区被框架改写，pgrep/pkill -f 读不到它（Helper 却正常），
 *  ps 的 command 列稳定可见，进程检测与终止都必须走这条路。返回 [{ pid, argv0 }]。 */
function caMacListIdeProcs() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const list = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (!m) continue;
      const am = m[2].match(/(?:^|\s)(\S*CodeArts[ _-]?Agent\.app\/Contents\/MacOS\/Electron)(?: |$)/);
      if (am) list.push({ pid: Number(m[1]), argv0: am[1] });
    }
    return list;
  } catch (_) { return []; }
}

/** macOS：ps 全量枚举 AgentKernel 内核进程（路径 ~/.codeartsdoer/CodeArts_Agent/AgentKernel_*） */
function caMacListKernelProcs() {
  try {
    const out = execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' });
    const list = [];
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^\s*(\d+)\s+(.+)$/);
      if (m && CA_MAC_KERNEL_RE.test(m[2])) list.push({ pid: Number(m[1]) });
    }
    return list;
  } catch (_) { return []; }
}

function caIsIdeRunning() {
  if (isMac) return caMacListIdeProcs().length > 0;
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + CA_IDE_EXE, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return out.includes(CA_IDE_EXE);
  } catch (_) { return false; }
}

/** 停 CodeArts Agent：先优雅关闭（给 IDE 保存未保存编辑的机会），等不到再强杀；
 *  最后清理 AgentKernel 内核进程（名字带版本号，按路径匹配后逐个杀）。 */
async function caKillIde() {
  if (isMac) {
    const procs = caMacListIdeProcs();
    if (procs.length) {
      try { execFileSync('osascript', ['-e', 'tell application "CodeArts Agent" to quit'], { stdio: 'ignore' }); } catch (_) {}
      for (let i = 0; i < 6; i++) {
        if (!caMacListIdeProcs().length) break;
        await sleep(1000);
      }
      for (const p of caMacListIdeProcs()) { try { process.kill(p.pid, 'SIGTERM'); } catch (_) {} }
      for (let i = 0; i < 5; i++) {
        if (!caMacListIdeProcs().length) break;
        await sleep(1000);
      }
      for (const p of caMacListIdeProcs()) { try { process.kill(p.pid, 'SIGKILL'); } catch (_) {} }
    }
    // 主进程退出会连带 Helper；再清理 AgentKernel 内核进程（路径 ~/.codeartsdoer/CodeArts_Agent/AgentKernel_*）
    for (const p of caMacListKernelProcs()) { try { process.kill(p.pid, 'SIGKILL'); } catch (_) {} }
    return;
  }
  try { execFileSync('taskkill', ['/IM', CA_IDE_EXE, '/T'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  for (let i = 0; i < 6; i++) {
    if (!caIsIdeRunning()) break;
    await sleep(1000);
  }
  if (caIsIdeRunning()) {
    try { execFileSync('taskkill', ['/IM', CA_IDE_EXE, '/F', '/T'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  }
  try {
    const out = execFileSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    const kernels = new Set();
    for (const line of String(out).split(/\r?\n/)) {
      const m = line.match(/^"([^"]+\.exe)"/i);
      if (m && /^AgentKernel_/i.test(m[1])) kernels.add(m[1]);
    }
    for (const k of kernels) {
      try { execFileSync('taskkill', ['/IM', k, '/F', '/T'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
    }
  } catch (_) {}
}

/** 定位 CodeArts Agent 可执行文件（切换后重启 / 启动设置用）。
 *  macOS 上 App 可装在任意目录：候选路径找不到时从运行中的主进程反查安装位置。 */
function caFindExe() {
  const found = CA_EXE_CANDIDATES.find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
  if (found) return found;
  if (!isMac) return null;
  const proc = caMacListIdeProcs()[0];
  return (proc && proc.argv0 && fs.existsSync(proc.argv0)) ? proc.argv0 : null;
}

function caLaunchIde() {
  const exe = caFindExe();
  if (!exe) return false;
  try { spawn(exe, [], { detached: true, stdio: 'ignore', windowsHide: true }).unref(); return true; } catch (_) { return false; }
}

/**
 * CodeArts Agent 一键切换账号：
 * 停客户端（vscdb 被 IDE 持有，且防其退出时回写旧会话）→ 备份库密文写回 vscdb
 * （本机备份原样写回；跨机导入的备份用明文以本机 key 重加密）→ 同步 .backup 副本
 * 与内核侧 userInfo.json → 原来在运行则重启客户端。
 */
async function caSwitchToAccount(uid) {
  const store = loadStore();
  const rec = store.codearts.accounts.find((x) => x && String(x.uid) === String(uid));
  if (!rec) throw new Error('账号备份不存在');
  if (!rec.secretRaw && !rec.secretPlain) throw new Error('该备份缺少登录态数据');
  // 二改：新版码道客户端（secretStorage 布局）——停客户端 → 用本机 key 重加密会话 → 写回 .enc
  if (CA_LAYOUT === 'storage') {
    const wasRunning2 = caIsIdeRunning();
    caSwitching = true;
    try {
      if (wasRunning2) {
        log('[client:ca] 停止码道客户端以写入登录态…');
        await caKillIde();
        for (let i = 0; i < 10 && caIsIdeRunning(); i++) await sleep(1000);
        await sleep(800);
      }
      const key = await caRequestKey();
      const plain = rec.secretPlain || JSON.stringify(caNewDecryptSession(rec.secretRaw, key));
      const b64 = caNewEncryptSession(JSON.parse(plain), key);
      const file = rec.re2File || caStorageListEnc()[0];
      fs.writeFileSync(path.join(caStorageDir(), file), b64, 'utf8');
      log('[client:ca] 已切换账号 ' + (rec.nickname || uid) + '（storage 布局）');
      caSwitching = false;
      if (wasRunning2) {
        try { await caLaunchIde(); } catch (_) {}
      }
      return { nickname: rec.nickname || uid, relaunched: !!wasRunning2 };
    } catch (e) {
      caSwitching = false;
      throw e;
    }
  }
  if (!CA_VSCDB || !fs.existsSync(CA_VSCDB)) throw new Error('未找到 CodeArts Agent 数据目录（请先安装并登录一次）');
  const wasRunning = caIsIdeRunning();
  caSwitching = true;
  try {
    if (wasRunning || caIsIdeRunning()) {
      log('[client:ca] 停止 CodeArts Agent 以写入登录态…');
      await caKillIde();
      for (let i = 0; i < 10 && caIsIdeRunning(); i++) await sleep(1000);
      await sleep(800);
    }
    // 决定写入的密文：本机备份（能被本机 key 解开）原样写回，字节级一致最稳；
    // 解不开（跨机导入）则用明文本机重加密。
    let secretValue = rec.secretRaw || null;
    const key = await caRequestKey();
    if (secretValue) {
      try { caDecryptVscSecret(secretValue, key); } catch (_) { secretValue = null; }
    }
    if (!secretValue) {
      if (!rec.secretPlain) throw new Error('备份无可用登录态（既无本机密文也无明文）');
      log('[client:ca] 备份来自其他电脑，用本机密钥重新加密会话');
      secretValue = caEncryptVscSecret(rec.secretPlain, key);
    }
    // 写 vscdb（读一次真实 secret 键名，缺行则按默认键名插入）
    const dbv = caReadDb() || {};
    const secretKey = dbv.secretKey || CA_SECRET_KEY_DEFAULT;
    let db = null;
    try {
      db = caOpenDb(CA_VSCDB, false);
      db.exec('PRAGMA busy_timeout = 3000');
      db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(secretKey, secretValue);
      if (rec.snapState) db.prepare('INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)').run(CA_SNAP_KEY, rec.snapState);
    } finally {
      try { if (db) db.close(); } catch (_) {}
    }
    // VSCode 保有 state.vscdb.backup 兜底副本（打开异常时会回退到它），同步覆盖防止旧会话复活
    try { fs.copyFileSync(CA_VSCDB, CA_VSCDB + '.backup'); } catch (_) {}
    // 内核侧 userInfo.json 一并换回（若备份里带）
    if (rec.userInfoJson) {
      try {
        fs.mkdirSync(path.dirname(CA_DOER_USERINFO), { recursive: true });
        const tmp = CA_DOER_USERINFO + '.workpet-tmp';
        fs.writeFileSync(tmp, rec.userInfoJson);
        fs.renameSync(tmp, CA_DOER_USERINFO);
      } catch (e) { log('[client:ca] 回写 userInfo.json 失败（不影响登录态）: ' + e.message); }
    }
    // 账号库：当前账号指向切换后的记录
    const st2 = loadStore();
    const idx = st2.codearts.accounts.findIndex((x) => x && String(x.uid) === String(uid));
    if (idx >= 0) st2.codearts.current = st2.codearts.accounts[idx];
    saveStore(st2);
    log('[client:ca] 已切换账号 -> ' + (rec.nickname || uid));
    let relaunched = false;
    if (wasRunning) {
      relaunched = caLaunchIde();
      log('[client:ca] 切换前客户端在运行，已自动重启');
    }
    return { uid, nickname: rec.nickname || uid, relaunched };
  } finally {
    caSwitching = false;
  }
}

const CLIENT_CHECKIN_CACHE_FILE = path.join(DATA_ROOT, 'client-checkin-cache.json');
const clientCheckinState = {
  wb: { inFlight: false, running: false, total: 0, done: 0, startedAt: 0, finishedAt: 0 },
  cb: { inFlight: false, running: false, total: 0, done: 0, startedAt: 0, finishedAt: 0 },
  ac: { inFlight: false, running: false, total: 0, done: 0, startedAt: 0, finishedAt: 0 },
  ca: { inFlight: false, running: false, total: 0, done: 0, startedAt: 0, finishedAt: 0 },
};
// WB/CB 账号体系互通：同一账号在两端并发签到会被服务端以「请求处理中」拒绝，
// 因此签到全局串行（一次只跑一个 profile 的签到轮）
let clientClaimGlobalLock = false;

function clientLoadCheckinCache(profileId) {
  try {
    const all = JSON.parse(fs.readFileSync(CLIENT_CHECKIN_CACHE_FILE, 'utf8'));
    return all[profileId] || {};
  } catch (_) { return {}; }
}
function clientSaveCheckinCache(profileId, cache) {
  try {
    let all = {};
    try { all = JSON.parse(fs.readFileSync(CLIENT_CHECKIN_CACHE_FILE, 'utf8')); } catch (_) {}
    all[profileId] = cache;
    const tmp = CLIENT_CHECKIN_CACHE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(all, null, 2));
    fs.renameSync(tmp, CLIENT_CHECKIN_CACHE_FILE);
  } catch (_) {}
}

/** 读取客户端当前登录（auth 文件为唯一真相） */
function clientReadAuth(profileId) {
  if (profileId === 'ac') {
    // AutoClaw：解密 auth.json，归一化成 { account, auth } 形状供下游统一消费
    const a = acReadAuth();
    if (!a || a.error || !a.userId) return null;
    return {
      account: { uid: String(a.userId), nickname: a.phone || String(a.userId), phoneNumber: a.phone || '' },
      auth: {
        accessToken: a.token,
        refreshToken: a.refreshToken || '',
        expiresAt: a.jwtExp || null,
        lastRefreshTime: Date.now(),
      },
    };
  }
  const raw = readJsonOrNull(CLIENT_PROFILES[profileId].authFile);
  if (!raw || !raw.account || !raw.account.uid) return null;
  return raw;
}

/** 把当前登录同步进账号库（登录文件变化时调用）；CodeArts 走异步解密，单独实现 */
function clientSyncStore(profileId) {
  if (profileId === 'ca') return; // ca 由 caSyncStore（异步）维护，不走 auth 文件路径
  const raw = clientReadAuth(profileId);
  if (!raw) return;
  const store = loadStore();
  const sec = store[profileId === 'wb' ? 'workbuddy' : profileId === 'cb' ? 'codebuddy' : 'ac'];
  const uid = String(raw.account.uid);
  if (profileId === 'ac') {
    // ac 段存扁平记录（uid/accessToken/tokenExpiresAt），与 wb/cb 的 { account, auth } 结构不同
    const rec = {
      uid,
      nickname: raw.account.nickname || uid,
      phone: raw.account.phoneNumber || '',
      tokenExpiresAt: raw.auth.expiresAt || null,
      accessToken: raw.auth.accessToken,
      refreshToken: raw.auth.refreshToken || '',
      lastRefreshTime: raw.auth.lastRefreshTime || Date.now(),
    };
    const i = sec.accounts.findIndex((x) => x && String(x.uid) === uid);
    if (i >= 0) sec.accounts[i] = Object.assign({}, sec.accounts[i], rec);
    else sec.accounts.push(rec);
    sec.current = sec.accounts[i >= 0 ? i : sec.accounts.length - 1];
    saveStore(store);
    return;
  }
  const idx = sec.accounts.findIndex((a) => a && a.account && String(a.account.uid) === uid);
  if (idx >= 0) sec.accounts[idx] = raw;
  else sec.accounts.push(raw);
  sec.current = raw;
  saveStore(store);
}

/** 列出客户端全部账号 + 当前登录（当前以 auth 文件为准）；CodeArts 单独实现 */
function clientListAccounts(profileId) {
  if (profileId === 'ca') return caListAccounts();
  clientSyncStore(profileId);
  const store = loadStore();
  const sec = store[profileId === 'wb' ? 'workbuddy' : profileId === 'cb' ? 'codebuddy' : 'ac'];
  const currentRaw = clientReadAuth(profileId);
  const currentUid = currentRaw && currentRaw.account ? String(currentRaw.account.uid) : null;
  const seen = new Set();
  const list = [];
  const push = (raw) => {
    if (profileId === 'ac') {
      // ac 段扁平记录
      if (!raw || !raw.uid) return;
      const uid2 = String(raw.uid);
      if (seen.has(uid2)) return;
      seen.add(uid2);
      list.push({
        uid: uid2,
        nickname: raw.nickname || uid2,
        phone: raw.phone || '',
        uin: '',
        tokenExpiresAt: raw.tokenExpiresAt || null,
        refreshExpiresAt: null,
        lastRefreshTime: raw.lastRefreshTime || null,
      });
      return;
    }
    if (!raw || !raw.account) return;
    const uid = String(raw.account.uid);
    if (seen.has(uid)) return;
    seen.add(uid);
    const auth = raw.auth || {};
    list.push({
      uid,
      nickname: raw.account.nickname || '',
      phone: raw.account.phoneNumber || '',
      uin: raw.account.uin || '',
      tokenExpiresAt: auth.expiresAt || null,
      refreshExpiresAt: auth.refreshExpiresAt || null,
      lastRefreshTime: auth.lastRefreshTime || null,
    });
  };
  if (currentRaw) push(currentRaw);
  for (const a of sec.accounts) push(a);
  list.sort((a, b) => (a.uid === currentUid ? -1 : b.uid === currentUid ? 1 : 0));
  const cache = clientLoadCheckinCache(profileId);
  const today = todayStrLocal();
  return {
    currentUid,
    accounts: list.map((a) => {
      const rec = cache[a.uid];
      return Object.assign(a, {
        checkin: rec && rec.date === today && !clientCheckinState[profileId].inFlight
          ? { ok: !!rec.ok, already: !!rec.already, code: rec.code, message: rec.message }
          : null,
      });
    }),
  };
}

function clientTokenFor(profileId, uid) {
  if (profileId === 'ca') return null; // CodeArts 无签到/积分，不需要取 token
  const raw = clientReadAuth(profileId);
  if (raw && String(raw.account.uid) === String(uid)) return raw.auth && raw.auth.accessToken;
  const store = loadStore();
  const sec = store[profileId === 'wb' ? 'workbuddy' : profileId === 'cb' ? 'codebuddy' : 'ac'];
  const rec = sec.accounts.find((a) => a && (a.account ? String(a.account.uid) === String(uid) : String(a.uid) === String(uid)));
  if (!rec) return null;
  if (rec.auth) return rec.auth.accessToken;
  return rec.accessToken || null; // ac 段账号记录直接存 accessToken
}

/** AutoClaw 调试端口（CDP）是否已在监听（复用中，无需重复拉起） */
async function isAcCdpUp(port) {
  try {
    const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(800) });
    if (!r.ok) return false;
    const o = await r.json().catch(() => ({}));
    return !!(o && o.webSocketDebuggerUrl);
  } catch (_) { return false; }
}

/** 启动 AutoClaw（带 --remote-debugging-port，供 CDP 签到所用）；不做 download 等待，只需拉起 */
function acLaunchBinary() {
  const port = CLIENT_PROFILES.ac.cdpPort;
  // 复用已运行的调试实例
  return isAcCdpUp(port).then((up) => {
    if (up) { log('[client:ac] CDP 已在监听，复用现有 AutoClaw'); return 'reuse'; }
    const exe = isMac
      ? '/Applications/AutoClaw.app/Contents/MacOS/AutoClaw'
      : ['D:/Program Files/AutoClaw/AutoClaw.exe',
         path.join(process.env.ProgramFiles || 'C:/Program Files', 'AutoClaw', 'AutoClaw.exe'),
         path.join(process.env.LOCALAPPDATA || '', 'Programs', 'AutoClaw', 'AutoClaw.exe')]
        .find((p) => { try { return fs.existsSync(p); } catch (_) { return false; } });
    if (!exe) throw new Error('未找到 AutoClaw 可执行文件');
    if (isMac && (() => { try { return !fs.existsSync(exe); } catch (_) { return true; } })()) {
      throw new Error('未找到 AutoClaw 可执行文件（' + exe + '）');
    }
    const args = ['--remote-debugging-port=' + port];
    if (isMac) {
      // 拉起前先杀旧实例：用户已开 / 上次拉起的实例都会带 single-instance-lock，
      // 不杀干净，新进程会立刻退出 → CDP 端口永远不开 → 反复拉起。
      // 最多两轮，每轮都重新杀 + 等退出 + spawn
      return acLaunchMacWithRetry(exe, args, port, 2);
    }
    spawn(exe, args, { detached: true, stdio: 'ignore', windowsHide: true }).unref();
    log(`[client:ac] 已拉起 AutoClaw (--remote-debugging-port=${port})`);
    return Promise.resolve('launched');
  });
}

/** macOS 上带「杀旧实例 + 等退出 + spawn + 端口就绪检测」重试逻辑的拉起 */
async function acLaunchMacWithRetry(exe, args, port, maxAttempts) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    killAutoClaw();
    const gone = await waitProcessGone(exe, 5000);
    if (!gone) log(`[client:ac] 旧实例未在 5s 内退出（第 ${attempt} 次）`);
    // spawn 的 ENOENT 等错误经异步 'error' 事件抛出，不监听会整个进程崩溃（unhandled 'error'）
    const ch = spawn(exe, args, { stdio: 'ignore', detached: true });
    ch.on('error', (e) => log(`[client:ac] 拉起 AutoClaw 失败: ${e.message}`));
    ch.unref();
    log(`[client:ac] 已拉起 AutoClaw (--remote-debugging-port=${port}) 第 ${attempt} 次`);
    // 轮询端口就绪（最坏 15s）
    const dl = Date.now() + 15000;
    while (Date.now() < dl) {
      if (await isAcCdpUp(port)) return 'launched';
      await sleep(400);
    }
    log(`[client:ac] 第 ${attempt} 次拉起后 CDP 端口未就绪`);
  }
  throw new Error('AutoClaw CDP 端口在 2 次拉起后仍未就绪（单实例锁可能未释放）');
}

/** 等指定进程完全退出（macOS 强杀后旧 lock 文件可能残留） */
async function waitProcessGone(exe, timeoutMs) {
  const name = path.basename(exe);
  const dl = Date.now() + timeoutMs;
  while (Date.now() < dl) {
    try {
      const out = execFileSync('pgrep', ['-x', name], { encoding: 'utf8' });
      if (!out.trim()) return true;
    } catch (_) { return true; } // pgrep 找不到进程 = 退出码 1
    await sleep(300);
  }
  return false;
}

/**
 * AutoClaw CDP 点击签到（方案1，macOS 优先）：当 AutoClaw 正以 --remote-debugging-port 运行时，
 * 经 CDP 找到「每日签到」按钮点击，让 AutoClaw 用自己内存中的登录态完成签到，
 * 从而完全绕开 auth.json 的 AES key 解密（macOS 上钥匙串密码与实际 key 不匹配的坑）。
 *
 * 仅在界面可见「签到」且未显示「已完成/已签到」时触发；成功返回 { cdp: true, already }。
 */
async function acCdpClickSignin() {
  const ports = [9226, 9225, 9224, 9223, 9222, 9227, 9228];
  let lastErr = null;
  for (const port of ports) {
    let ws = null;
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1200) }).then(r => r.json()).catch(() => null);
      if (!Array.isArray(list)) { lastErr = `port${port}不可达`; continue; }
      const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl && /AutoClaw|autoclaw/i.test(t.title || ''));
      if (!target) { lastErr = `port${port}无AutoClaw页面`; continue; }
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws连接失败')); });
      let id = 0; const pend = new Map();
      ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } } catch (_) {} };
      const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
      const evalJs = (expression) => send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }).then(r => r.result && r.result.value);
      // 检查签到区状态
      const state = await evalJs(`(() => { const t = (document.body && document.body.innerText) || '';
        const doneBtn = [...document.querySelectorAll('button')].some(b => /已.?完成|已签.{1,3}天/i.test((b.textContent||'').trim()));
        return { textHasDone: /已.?完成|已签.{1,3}天/i.test(t) }; })()`);
      if (state && state.textHasDone) {
        log('[client:ac] CDP 检查：今日已签到（界面显示已完成），跳过');
        return { cdp: true, already: true };
      }
      // 点击「签到」按钮（避免点到「去邀请」「已完成」等）
      const clicked = await evalJs(`(() => { const btns = [...document.querySelectorAll('button')];
        const b = btns.find(x => /^签到$|^签\s*到$/.test((x.textContent||'').trim()));
        if (b) { b.click(); return 'clicked'; }
        return 'notfound'; })()`);
      if (clicked !== 'clicked') { lastErr = '未找到「签到」按钮'; continue; }
      log('[client:ac] CDP 已点击「签到」按钮，等待 AutoClaw 自行完成...');
      await new Promise(r => setTimeout(r, 6000));
      // 回读结果（界面是否变为已完成/已签）
      const after = await evalJs(`(() => { const t = (document.body && document.body.innerText) || '';
        return { done: /已.?完成|已签.{1,3}天/i.test(t), around: (t.match(/每日签到得[\\s\\S]{0,120}/) || [])[0] || '' }; })()`);
      return { cdp: true, already: false, message: '已触发 AutoClaw 自己签到', body: { after } };
    } catch (e) {
      lastErr = e.message;
    } finally {
      if (ws) { try { ws.close(); } catch (_) {} }
    }
  }
  throw new Error('CDP 点击签到失败: ' + lastErr);
}

/**
 * 通用：在 AutoClaw 的 CDP 渲染进程执行一段 JS，返回 returnByValue 结果。
 * 遍历常见调试端口，命中 AutoClaw 页面即执行；全部失败则 throw。
 */
async function acCdpEvalOnce(jsExpr) {
  const ports = [9226, 9225, 9224, 9223, 9222, 9227, 9228];
  let lastErr = null;
  // 只保留最后一个端口的错误会掩盖真实原因：AutoClaw 实际监听 9226，而列表末尾的 9228
  // 通常压根没监听，于是 9226 上的真实失败（ws 连接失败 / 页面内 JS 报错）会被
  // "port9228不可达" 覆盖掉，日志里看不到任何有效线索。这里同时记住首个错误。
  let firstErr = null;
  const note = (m) => { if (firstErr === null) firstErr = m; lastErr = m; };
  for (const port of ports) {
    let ws = null;
    try {
      const list = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) }).then(r => r.json()).catch(() => null);
      if (!Array.isArray(list)) { note(`port${port}不可达`); continue; }
      const target = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl && /AutoClaw|autoclaw/i.test(t.title || ''));
      if (!target) { note(`port${port}无AutoClaw页面`); continue; }
      ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws连接失败')); });
      let id = 0; const pend = new Map();
      ws.onmessage = (ev) => { try { const m = JSON.parse(ev.data); if (m.id && pend.has(m.id)) { const { res, rej } = pend.get(m.id); pend.delete(m.id); m.error ? rej(new Error(m.error.message)) : res(m.result); } } catch (_) {} };
      const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pend.set(i, { res, rej }); ws.send(JSON.stringify({ id: i, method, params })); });
      const r = await send('Runtime.evaluate', { expression: jsExpr, returnByValue: true, awaitPromise: true, scriptTimeout: 8000 });
      return r.result && r.result.value;
    } catch (e) {
      note(e.message);
    } finally {
      if (ws) { try { ws.close(); } catch (_) {} }
    }
  }
  throw new Error('CDP 不可用: ' + (firstErr === lastErr ? String(lastErr) : `${firstErr} … ${lastErr}`));
}

/**
 * macOS 专属：经 CDP 从 AutoClaw 渲染进程的 electronAPI.auth 读取登录态与积分，
 * 完全绕开 auth.json 的 AES 钥匙串解密（macOS 上钥匙串密码与实际 key 不匹配的坑）。
 * 成功写入 store 的 ac 段（扁平记录），并返回 { raw, points }。
 */
async function acEnsureAuthViaCdp() {
  if (!isMac) return null;
  const obj = await acCdpEvalOnce(`(async () => {
    const auth = window.electronAPI && window.electronAPI.auth;
    if (!auth) return { error: 'no-auth-api' };
    try {
      const uc = await auth.getUserCache();
      const tc = await auth.getTokenCache();
      let pts = null, exp = null;
      try { pts = await auth.getPoints(); } catch (e) {}
      try { exp = await auth.getExpiringPoints(); } catch (e) {}
      return {
        userCache: uc || null,
        tokenCache: tc || null,
        points: (pts && pts.ok) ? pts : null,
        expiring: (exp && exp.ok) ? exp : null,
      };
    } catch (e) { return { error: 'call-fail: ' + (e && e.message) }; }
  })()`);
  if (!obj || obj.error || !obj.tokenCache || !obj.tokenCache.token) {
    throw new Error('CDP 读取 AutoClaw 登录态失败: ' + (obj && obj.error));
  }
  const tc = obj.tokenCache;
  const uc = obj.userCache || {};
  const rawToken = String(tc.token).replace(/^Bearer\s+/i, '');
  // jwt payload（未验证签名，仅解析字段）；tc 本身无 jwt 字段，需自行解码
  let jwtPayload = {};
  try {
    const p = rawToken.split('.');
    if (p[1]) jwtPayload = JSON.parse(Buffer.from(p[1], 'base64url').toString('utf8'));
  } catch (_) {}
  const token = rawToken;
  const uid = String(jwtPayload.user_id || uc.userId || tc.userId || '');
  // 手机号优先取 tokenCache.user.phone；否则退而用 email（jwt jti 形如 xxx@gmail.com）
  const email = jwtPayload.jti || '';
  const store = loadStore();
  const tab = store.ac;
  const rec = {
    uid,
    nickname: uc.userName || uc.nickname || uid,
    phone: (tc.user && tc.user.phone) || uc.phone || (email || ''),
    tokenExpiresAt: (jwtPayload.exp ? jwtPayload.exp * 1000 : null) || tc.expiresAt || null,
    lastRefreshTime: Date.now(),
    accessToken: token,
  };
  // 加分字段不污染账号记录：积分类单独缓存
  acCdpPointsCache = { points: (obj.points && obj.points.points) || null, expiring: (obj.expiring && obj.expiring.expiringPoints) || null, ts: Date.now() };
  const i = tab.accounts.findIndex((x) => x && String(x.uid) === String(uid));
  if (i >= 0) tab.accounts[i] = Object.assign({}, tab.accounts[i], rec);
  else tab.accounts.push(rec);
  tab.current = Object.assign({}, tab.accounts[i >= 0 ? i : tab.accounts.length - 1], rec);
  saveStore(store);
  log('[client:ac] CDP 已从 AutoClaw 读取登录态: ' + uid + ' (' + (rec.nickname || '') + ') 积分=' + (acCdpPointsCache.points));
  return { raw: { token, uid, nickname: rec.nickname, phone: rec.phone }, points: acCdpPointsCache };
}

/** AutoClaw 经 CDP 读取的积分缓存（{ points, expiring, ts }） */
let acCdpPointsCache = null;

/**
 * macOS 专属：经 CDP 调用 AutoClaw 的 electronAPI.auth 完成任务中心签到。
 * 使用 getTaskList 判断 daily_signin 状态，未完成才调用 completeClientTask 执行签到；
 * 幂等返回 { already }，完全绕开 HTTP 接口（macOS token 无法经 HTTP 认证的坑）。
 */
async function acCdpSignin() {
  const r = await acCdpEvalOnce(`(async () => {
    const auth = window.electronAPI && window.electronAPI.auth;
    if (!auth) return { error: 'no-auth-api' };
    try {
      const tl = await auth.getTaskList();
      const task = (tl && tl.data || []).find((x) => x.task_id === 'daily_signin');
      if (task && task.status === 'completed') {
        return { already: true, day: task.status_description || '' };
      }
      const done = await auth.completeClientTask({ task_id: 'daily_signin' });
      return { already: !!(done && done.data && done.data.already_completed), resp: done };
    } catch (e) { return { error: 'call-fail: ' + (e && e.message) }; }
  })()`);
  if (!r || r.error) throw new Error('CDP 任务签到失败: ' + (r && r.error));
  return { cdp: true, already: !!r.already };
}

/** AutoClaw 签到 = 任务中心 daily_signin 任务完成（每日 200 分）；响应 data.already_completed = 已签 */
async function acDailyCheckin(accessToken) {
  // 方案1（macOS 优先，临启即关，对齐 TraeWork）：签到时自动启动 AutoClaw（CDP 模式），
  // 经应用内任务 API 自行签到（绕开 HTTP token 认证坑），签到完成后自动关闭 AutoClaw。
  if (isMac) {
    // 记录是否由本进程临时拉起 AutoClaw：仅「临时拉起」场景签到后自动关闭，
    // 若复用用户已运行的实例则不关闭，避免打扰用户正在使用的客户端。
    try {
      const how = await acLaunchBinary(); // 'reuse' 复用现有实例，'launched' 本次临时拉起
      // acLaunchBinary 内部已确保 9226 端口就绪
      const r = await acCdpSignin();
      if (how === 'launched') {
        try { killAutoClaw(); log('[client:ac] CDP 签到完成，已自动关闭临时拉起的 AutoClaw'); } catch (_) {}
      } else {
        log('[client:ac] CDP 签到完成（复用已运行实例，保持 AutoClaw 不关闭）');
      }
      return { ok: true, ...r, code: 0 };
    } catch (e) { log('[client:ac] CDP 签到失败: ' + e.message + ' → 回退 API 方式'); }
  }
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(2000);
    try {
      const r = await fetch(AC_API_HOST + '/autoclaw-proxy/proxy/autoclaw-task-complete', {
        method: 'POST',
        headers: acSignHeaders({ 'content-type': 'application/json', authorization: 'Bearer ' + accessToken }),
        body: JSON.stringify({ task_id: 'daily_signin' }),
        signal: AbortSignal.timeout(12000),
      });
      const o = await r.json().catch(() => ({}));
      const code = o.code;
      const already = !!(o.data && o.data.already_completed);
      if (code === 0 || already) {
        return { ok: true, already, code, message: o.msg || 'ok', body: o, reward: (o.data && o.data.reward_points) || 0 };
      }
      if (code === 410000 || r.status === 401) return { ok: false, code, message: '登录身份过期', body: o };
      lastErr = o.msg || ('HTTP ' + r.status);
    } catch (e) {
      lastErr = e.message;
    }
  }
  return { ok: false, message: lastErr || '签到失败' };
}

/** AutoClaw 积分查询：GET /agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw */
async function acFetchCredits(accessToken) {
  // macOS 优先：用 CDP 从 AutoClaw 应用内读取积分（electronAPI.auth.getPoints），
  // 完全绕开 HTTP 接口对 auth.json 解密的依赖；缓存不过期则直接用。
  if (isMac && acCdpPointsCache && acCdpPointsCache.points != null) {
    const { points, expiring } = acCdpPointsCache;
    const segments = [];
    const exp = Number(expiring) || 0;
    const tot = Number(points) || 0;
    if (exp > 0) segments.push({ remaining: exp, total: exp, expiresAt: null, source: exp + ' 积分即将过期' });
    if (tot - exp > 0) segments.push({ remaining: tot - exp, total: tot - exp, expiresAt: null, source: '长期积分' });
    return { credits: tot, count: segments.length, totalDosage: 0, segments };
  }
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(AC_API_HOST + '/agent-assetmgr/api/v1/points/expiring?biz_app_id=autoclaw', {
        method: 'GET',
        headers: acSignHeaders({ authorization: 'Bearer ' + accessToken }),
        signal: AbortSignal.timeout(12000),
      });
      const o = await r.json().catch(() => ({}));
      if (o.code !== 0) throw new Error(o.msg || ('code=' + o.code));
      const total = Number(o.data && o.data.total_points) || 0;
      const expiring = Number(o.data && o.data.expiring_points) || 0;
      const expireText = String((o.data && o.data.expiring_points_text) || '');
      const segments = [];
      if (expiring > 0) {
        segments.push({ remaining: expiring, total: expiring, expiresAt: null, source: expireText || '即将过期' });
      }
      if (total - expiring > 0) {
        segments.push({ remaining: total - expiring, total: total - expiring, expiresAt: null, source: '长期积分' });
      }
      return { credits: total, count: segments.length, totalDosage: 0, segments };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(300 * attempt);
    }
  }
  throw lastErr || new Error('积分查询失败');
}

async function clientDailyCheckin(profileId, accessToken) {
  if (profileId === 'ca') return { ok: false, message: 'CodeArts Agent 无签到（额度按官方政策自动发放）' };
  if ((profileId === 'wb' || profileId === 'cb') && isIntlWorkbuddyToken(accessToken)) return { ok: true, already: true, message: '国际版积分自动发放，无需签到' };
  if (profileId === 'ac') return acDailyCheckin(accessToken);
  const profile = CLIENT_PROFILES[profileId];
  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
  if (attempt > 0) await sleep(2000);
  for (const host of profile.checkinHosts) {
    for (const cpath of ['/billing/meter/daily-checkin', '/v2/billing/meter/daily-checkin']) {
      try {
        const r = await fetch(host + cpath, {
          method: 'POST',
          headers: {
            accept: 'application/json, text/plain, */*',
            'content-type': 'application/json',
            'x-client-platform': 'web',
            origin: profile.apiHost,
            referer: profile.apiHost + '/profile/plans-usage',
            authorization: 'Bearer ' + accessToken,
            'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
          },
          body: '{}',
          signal: AbortSignal.timeout(12000),
        });
        const text = await r.text();
        let o = {};
        try { o = JSON.parse(text); } catch (_) {}
        const code = o.code;
        const already = code === 10001;
        const deviceLimit = /已经签到/.test(o.msg || o.message || '');
        if (already || deviceLimit || (r.ok && (code === 0 || code === undefined))) {
          return { ok: true, already, deviceLimit, code, message: o.msg || o.message || 'ok', body: o };
        }
        if (r.status === 401) return { ok: false, code, message: '登录身份过期', body: o };
        const busy = /请求处理中|重复操作|请稍后再试/.test(o.msg || o.message || '');
        if (busy) { lastErr = o.msg || o.message; break; }
        if (r.status >= 400 && r.status !== 404) return { ok: false, code, message: 'HTTP ' + r.status, body: o };
        lastErr = o.msg || o.message || ('HTTP ' + r.status);
      } catch (e) {
        lastErr = e.message;
      }
    }
  }
  }
  return { ok: false, message: lastErr || '签到失败' };
}

/**
 * 签到后同步账号的 Cookie 时限（tokenExpiresAt）进账号库：
 * - 当前登录账号：auth 文件是唯一真相（客户端刷新 token 时会重写该文件），
 *   立即把 auth.expiresAt / refreshExpiresAt / lastRefreshTime 同步进记录，
 *   不等 5s 的 watchFile 轮询，切换走之后记录也不会残留旧有效期。
 * - 其他账号：登录态只有备份库里一份，仅当签到响应明确带「刷新 token + 有效期」
 *   时才兜底更新，否则保持原值（不臆造有效期）。
 * 只更新有效期元数据，绝不改写 accessToken，避免写坏登录态。
 */
function clientSyncTokenExpiryAfterCheckin(profileId, uid, respBody) {
  if (profileId === 'ca') return; // CodeArts 无签到，有效期由 caSyncStore 维护
  // 各种形态 → 毫秒时间戳（数字秒/毫秒、数字字符串、ISO 日期字符串）
  const asMs = (v) => {
    if (v == null) return null;
    if (typeof v === 'number') {
      if (!Number.isFinite(v) || v <= 0) return null;
      return v > 1e12 ? v : v * 1000; // 秒 → 毫秒
    }
    if (typeof v === 'string') {
      const s = v.trim();
      if (!s) return null;
      if (/^\d+(\.\d+)?$/.test(s)) {
        const n = Number(s);
        if (!Number.isFinite(n) || n <= 0) return null;
        return n > 1e12 ? n : n * 1000;
      }
      const ms = Date.parse(s);
      return Number.isFinite(ms) && ms > 0 ? ms : null;
    }
    return null;
  };

  const store = loadStore();
  const sec = store[profileId === 'wb' ? 'workbuddy' : profileId === 'cb' ? 'codebuddy' : 'ac'];
  const idx = sec.accounts.findIndex((x) => x && (x.account ? String(x.account.uid) === String(uid) : String(x.uid) === String(uid)));
  if (idx < 0) return;
  const rec = sec.accounts[idx];

  // AutoClaw：账号记录是扁平结构（uid/accessToken/tokenExpiresAt），JWT exp 即 Cookie 时限
  if (profileId === 'ac') {
    const fileAuth = clientReadAuth('ac');
    const fileExp = fileAuth && fileAuth.auth ? fileAuth.auth.expiresAt : null;
    const prevExp = rec.tokenExpiresAt || null;
    const nextExp = fileExp != null ? fileExp : prevExp;
    if (nextExp !== prevExp && nextExp != null) {
      sec.accounts[idx] = Object.assign({}, rec, { tokenExpiresAt: nextExp, lastRefreshTime: Date.now() });
      if (sec.current && String(sec.current.uid) === String(uid)) sec.current = sec.accounts[idx];
      saveStore(store);
      log('[client:ac] ' + (rec.nickname || uid) + ' Cookie 时限已同步 -> ' + new Date(nextExp).toISOString());
    }
    return;
  }

  const prevAuth = rec.auth || {};
  const nextAuth = Object.assign({}, prevAuth);

  // 当前登录账号：以 auth 文件为准
  const fileRaw = clientReadAuth(profileId);
  if (fileRaw && fileRaw.auth && String(fileRaw.account.uid) === String(uid)) {
    const fe = asMs(fileRaw.auth.expiresAt);
    const fr = asMs(fileRaw.auth.refreshExpiresAt);
    const fl = asMs(fileRaw.auth.lastRefreshTime);
    if (fe != null) nextAuth.expiresAt = fe;
    if (fr != null) nextAuth.refreshExpiresAt = fr;
    if (fl != null) nextAuth.lastRefreshTime = fl;
  }

  // 签到响应若带刷新后的 token 及其有效期则兜底更新：
  // 只认明确的 token 对象（data.token / data.tokenInfo / data.auth，或顶层带 accessToken），
  // 避免把积分包到期时间之类的字段误当成 Cookie 时限。
  if (respBody && typeof respBody === 'object') {
    const d = (respBody.data && typeof respBody.data === 'object') ? respBody.data : {};
    const tokenObjs = [d.token, d.tokenInfo, d.auth].filter((t) => t && typeof t === 'object');
    if (respBody.accessToken || respBody.token) tokenObjs.push(respBody);
    let exp = null;
    for (const t of tokenObjs) {
      exp = asMs(t.expiresAt) ?? asMs(t.expireTime) ?? asMs(t.expiredAt);
      if (exp != null) break;
    }
    if (exp != null && exp > Date.now() && asMs(nextAuth.expiresAt) !== exp) nextAuth.expiresAt = exp;
  }

  const changed = nextAuth.expiresAt !== prevAuth.expiresAt
    || nextAuth.refreshExpiresAt !== prevAuth.refreshExpiresAt
    || nextAuth.lastRefreshTime !== prevAuth.lastRefreshTime;
  if (!changed) return;
  sec.accounts[idx] = Object.assign({}, rec, { auth: nextAuth });
  if (sec.current && sec.current.account && String(sec.current.account.uid) === String(uid)) {
    sec.current = sec.accounts[idx];
  }
  saveStore(store);
  log('[client:' + profileId + '] ' + (rec.account.nickname || uid) + ' Cookie 时限已同步 -> '
    + (nextAuth.expiresAt ? new Date(nextAuth.expiresAt).toISOString() : '(无)'));
}

async function clientClaimDailyForAll(profileId) {
  if (profileId === 'ca') return { skipped: true, reason: 'no-checkin' }; // CodeArts 无签到，不进入签到轮
  const st = clientCheckinState[profileId];
  if (st.inFlight || clientClaimGlobalLock) return { skipped: true, reason: 'in-flight' };
  // AutoClaw 首次读账号前确保 AES key 已就绪（异步，12s 硬超时；失败则本轮按无 key 处理）
  if (profileId === 'ac') { try { await acRequestKey(); } catch (_) {} }
  const accounts = clientListAccounts(profileId).accounts;
  if (!accounts.length) return { skipped: true, reason: 'no-accounts' };
  st.inFlight = true;
  clientClaimGlobalLock = true;
  st.running = true;
  st.total = accounts.length;
  st.done = 0;
  st.startedAt = Date.now();
  st.finishedAt = 0;
  const cache = clientLoadCheckinCache(profileId);
  const today = todayStrLocal();
  const results = [];
  try {
    for (const a of accounts) {
      const hit = cache[a.uid];
      if (hit && hit.date === today && hit.ok) {
        st.done++;
        results.push({ uid: a.uid, nickname: a.nickname || a.uid, ok: true, already: !!hit.already, msg: hit.message || '今日已签' });
        continue;
      }
      let tk = null;
      if (profileId === 'ac') {
        try {
          const fresh = await acEnsureFreshForAccount(a.uid);
          if (fresh && fresh.accessToken) tk = fresh.accessToken;
        } catch (e) { log('[client:ac] 续期失败 ' + a.uid + ': ' + e.message); }
        if (!tk) tk = clientTokenFor(profileId, a.uid);
      } else {
        tk = clientTokenFor(profileId, a.uid);
      }
      let rec;
      let respBody = null;
      if (!tk) rec = { date: today, ok: false, code: -1, message: '无 accessToken' };
      else {
        const r = await clientDailyCheckin(profileId, tk);
        respBody = r.body;
        rec = { date: today, ok: !!r.ok, already: !!r.already, deviceLimit: !!r.deviceLimit, code: r.code, message: r.message || '' };
      }
      cache[a.uid] = rec;
      clientSaveCheckinCache(profileId, cache);
      // 签到后同步该账号的 Cookie 时限（tokenExpiresAt）：当前登录账号以 auth 文件为准，
      // 响应带刷新 token 的有效期则兜底更新，账号库不再残留旧的有效期
      try { clientSyncTokenExpiryAfterCheckin(profileId, a.uid, respBody); } catch (_) {}
      // AutoClaw：token 是 24h JWT，签到时若快过期（<2h）自动 refresh 并回写 auth.json，
      // 让「Cookie 时限」跟随签到保持即时续期（与用户需求：签到即同步 Cookie 时限一致）
      if (profileId === 'ac' && rec.ok) {
        try {
          const cur = clientReadAuth('ac');
          const exp = cur && cur.auth ? cur.auth.expiresAt : null;
          if (exp != null && exp - Date.now() < 2 * 3600 * 1000) {
            const r2 = await acRefreshToken();
            const newExp = acJwtExpMs(r2.accessToken);
            await acPersistRefreshedToken(r2.accessToken, r2.refreshToken);
            acSyncStoreAfterRefresh(r2.accessToken, r2.refreshToken, newExp);
            log('[client:ac] token 快过期，已 refresh 并回写，新时限 -> ' + (newExp ? new Date(newExp).toISOString() : '(无)'));
          }
        } catch (e) {
          log('[client:ac] token refresh 失败（不影响本次签到）: ' + e.message);
        }
      }
      st.done++;
      results.push({ uid: a.uid, nickname: a.nickname || a.uid, ok: !!rec.ok, already: !!rec.already, msg: rec.message || '' });
      log('[client:' + profileId + '] ' + a.nickname + ' 签到: ' + (rec.ok ? (rec.already ? '已签' : '成功') : rec.message));
      await sleep(500);
    }
  } finally {
    st.inFlight = false;
    st.running = false;
    st.finishedAt = Date.now();
    clientClaimGlobalLock = false;
  }
  return { total: st.total, done: st.done, results };
}

/** 积分查询（credit-resource-queries + fetchResource） */
function clientBuildResourceBody(now) {
  now = now || new Date();
  const end = new Date(now.getTime());
  end.setFullYear(end.getFullYear() + 101);
  const pad = (v) => String(v).padStart(2, '0');
  const f = (d) => d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
  return {
    PageNumber: 1, PageSize: 100, ProductCode: 'p_tcaca', Status: [0, 3],
    PackageEndTimeRangeBegin: f(now), PackageEndTimeRangeEnd: f(end),
  };
}

// ── 二改: WorkBuddy 国际版（www.workbuddy.ai）token 识别与积分分流 ──
function isIntlWorkbuddyToken(token) {
  try {
    const p = String(token || '').split('.')[1];
    if (!p) return false;
    const j = JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'));
    return String(j.iss || '').indexOf('workbuddy.ai') !== -1;
  } catch (_) { return false; }
}
const INTL_WB_HOST = 'https://www.workbuddy.ai';

async function clientFetchCredits(profileId, accessToken) {
  if (profileId === 'ca') throw new Error('CodeArts Agent 额度按官方政策自动发放，无积分查询接口');
  if (profileId === 'ac') return acFetchCredits(accessToken);
  const profile = CLIENT_PROFILES[profileId];
  const host = (profileId === 'wb' && isIntlWorkbuddyToken(accessToken)) ? INTL_WB_HOST : profile.apiHost;
  let lastErr = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const r = await fetch(host + '/v2/billing/meter/get-user-resource', {
        method: 'POST',
        headers: {
          accept: 'application/json, text/plain, */*',
          'content-type': 'application/json',
          'x-client-platform': 'web',
          origin: host,
          referer: host + '/profile/plans-usage',
          authorization: 'Bearer ' + accessToken,
          'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36',
        },
        body: JSON.stringify(clientBuildResourceBody()),
        signal: AbortSignal.timeout(12000),
      });
      const text = await r.text();
      let o;
      try { o = JSON.parse(text); } catch (e) { throw new Error('解析积分响应失败: ' + e.message); }
      if (!r.ok) throw new Error('积分接口 HTTP ' + r.status + ': ' + text.slice(0, 120));
      if (o.code !== 0 && o.code !== undefined) throw new Error(o.msg || ('积分接口返回 code=' + o.code));
      const data = (o.data && o.data.Response && o.data.Response.Data) ||
        (o.data && o.data.data && o.data.data.Response && o.data.data.Response.Data) || null;
      const accounts = (data && Array.isArray(data.Accounts) ? data.Accounts : null) ||
        (o.data && Array.isArray(o.data.accounts) ? o.data.accounts : null) ||
        (o.data && o.data.data && Array.isArray(o.data.data.accounts) ? o.data.data.accounts : null) || [];
      if (accounts.length === 0 && attempt < 3) { await sleep(300 * attempt); continue; }
      let credits = 0;
      for (const a of accounts) {
        // 剩余字段优先「周期剩余」(CycleCapacityRemainPrecise)：月度包用完时 CapacityRemainPrecise
        // 仍是满额，必须用周期剩余才算对。所有包组的剩余求和 = 总积分。
        const cands = [a.CycleCapacityRemainPrecise, a.CycleCapacityRemain, a.CapacityRemainPrecise, a.CapacityRemain];
        let v = NaN;
        for (const c of cands) {
          if (c === undefined || c === null || c === '') continue;
          const n = parseFloat(c);
          if (!Number.isNaN(n)) { v = n; break; }
        }
        if (!Number.isNaN(v)) credits += v;
      }
      let segments = sortCreditSegments(mergeCreditSegments(extractCreditSegments(accounts, '积分')));
      const visible = segments.reduce((sum, x) => sum + x.remaining, 0);
      if (credits > visible + 0.01) {
        segments = sortCreditSegments([
          ...segments,
          { remaining: credits - visible, total: credits - visible, expiresAt: null, source: '其他积分' },
        ]);
      }
      return { credits: parseFloat(credits.toFixed(2)), count: accounts.length, totalDosage: 0, segments: segments };
    } catch (e) {
      lastErr = e;
      if (attempt < 3) await sleep(300 * attempt);
    }
  }
  throw lastErr || new Error('积分查询失败');
}

/** CDP 刷新客户端页面（客户端以调试模式运行时） */
async function clientReloadViaCdp(profileId) {
  const profile = CLIENT_PROFILES[profileId];
  let list;
  try {
    const r = await fetch('http://127.0.0.1:' + profile.cdpPort + '/json/list', { signal: AbortSignal.timeout(2000) });
    list = await r.json();
  } catch (_) { return false; }
  const page = (Array.isArray(list) ? list : []).find(
    (t) => t.type === 'page' && /workbench(\.html)?|vscode-file/i.test(String(t.url || ''))
  );
  if (!page || !page.webSocketDebuggerUrl) return false;
  return new Promise((resolve) => {
    let ws = null;
    const finish = (v) => { clearTimeout(timer); try { ws && ws.close(); } catch (_) {} resolve(v); };
    const timer = setTimeout(() => finish(false), 6000);
    try { ws = new WebSocket(page.webSocketDebuggerUrl); } catch (e) { return finish(false); }
    ws.onopen = () => ws.send(JSON.stringify({ id: 1, method: 'Page.reload', params: {} }));
    ws.onmessage = (ev) => {
      try {
        const d = JSON.parse(ev.data);
        if (d.id === 1) finish(true);
      } catch (_) {}
    };
    ws.onerror = () => finish(false);
  });
}

// 登录文件变化 → 同步进账号库（每次打开/切换客户端都会重写 auth 文件）
// AutoClaw 的同步要先异步解密（key 缓存+树杀超时），不能同步阻塞事件循环
for (const pid of ['wb', 'cb', 'ac']) {
  try {
    fs.watchFile(CLIENT_PROFILES[pid].authFile, { interval: 5000 }, (cur, prev) => {
      if (!fs.existsSync(CLIENT_PROFILES[pid].authFile)) return;
      if (cur.mtimeMs !== prev.mtimeMs) {
        const sync = () => { try { clientSyncStore(pid); log('[client:' + pid + '] 登录文件变化，已同步账号库'); } catch (_) {} };
        if (pid === 'ac') acRequestKey().then(sync).catch(() => {});
        else sync();
      }
    });
  } catch (_) {}
}
// 启动即预热 AutoClaw AES key（后台异步，不阻塞；避免首次读账号时等解密）
try { if (fs.existsSync(AC_AUTH_FILE)) acWarmKey(); } catch (_) {}

// CodeArts Agent：启动即预热 key + 备份当前登录；之后监听 state.vscdb 变化
// （客户端运行期间约每小时自动续期会话，续期后备份要跟着刷新，保证切换用的
//   refresh_token 始终新鲜）。文件变化频繁但仅在内容真正变化时才落盘。
try {
  if (CA_VSCDB && fs.existsSync(CA_VSCDB)) {
    caWarmKey();
    caRequestKey()
      .then(() => caSyncStore())
      .then((a) => { if (a && a.uid) log('[client:ca] 已备份当前账号 ' + (a.nickname || a.uid)); })
      .catch((e) => log('[client:ca] 启动备份失败: ' + e.message));
    fs.watchFile(CA_VSCDB, { interval: 5000 }, (cur, prev) => {
      if (!fs.existsSync(CA_VSCDB) || cur.mtimeMs === prev.mtimeMs || caSwitching) return;
      caRequestKey().then(() => caSyncStore()).catch(() => {});
    });
  }
} catch (_) {}


async function rotateAllAccounts({ claim }) {
  // 收集所有客户端登录态 + 备份当前账号，保证账号库完整
  try { collectAllTraeAccounts(); } catch (_) {}
  try { backupCurrentAccount(); } catch (_) {}
  const all = listAccounts();
  // Trae 限制每台设备每日只能一个账号领签到积分 → 按天轮换签到顺序，
  // 多账号隔天轮流领取（今天的 dayIdx 决定谁排在最前）
  const dayIdx = Math.floor(Date.now() / 86400000);
  const accounts = all.length > 1
    ? all.map((_, i) => all[(i + dayIdx) % all.length])
    : all;

  const originSecret = (() => {
    try {
      const json = JSON.parse(fs.readFileSync(storageFile(), 'utf8'));
      return json['iCubeAuthInfo://icube.cloudide'] || null;
    } catch (_) { return null; }
  })();
  // 仅当宿主本来就在运行时才停掉（防其覆盖登录态），结束后按原状恢复
  const hostWasRunning = isProcessRunning();
  if (hostWasRunning) {
    killTraeWork();
    await sleep(1500);
  }

  const results = [];
  for (const a of accounts) {
    const item = {
      uid: a.uid, nickname: a.nickname || a.uid,
      ok: false, already: false, checkedIn: false,
      packs: [], remaining: null, msg: '',
    };
    try {
      const rec = readAccountSecret(a.uid);
      writeAuthSecret(rec.secret);
      statusCache.at = 0; statusCache.data = null;
      entCache.at = 0; entCache.data = null;
      const st = await fetchStatus();
      const body = (st && st.data) || {};
      item.checkedIn = !!(st.ok && body.checked_in === true);

      // 权益包（剩余/总额/到期）→ 面板显示每账号剩余积分与积分点
      const ent = await fetchEntitlements();
      if (ent && ent.ok && ent.data && Array.isArray(ent.data.packs)) {
        item.packs = ent.data.packs.map((p) => ({
          name: p.name, limit: p.limit, remaining: p.remaining, expire_sec: p.expireTime,
        }));
        item.remaining = item.packs.reduce((s, p) => s + (p.remaining || 0), 0);
      }

      if (!claim) {
        item.ok = st.ok;
        item.msg = item.checkedIn ? '今日已签到' : '未签到（仅刷新积分）';
      } else if (item.checkedIn) {
        item.ok = true; item.already = true; item.msg = '今日已签到';
        markDeviceClaimedToday();
      } else {
        // 先尝试直连 HTTP 签到；被服务端拒绝（9074 等）时，自动经宿主官方 IPC
        // 签到（CDP 拉起宿主→走官方「签到按钮」同款通道→退出宿主），全程无需用户操作。
        let r = await doClaim();
        if (!r.ok) {
          await sleep(800);
          const re = await fetchStatus();
          item.checkedIn = !!(re.ok && re.data && re.data.checked_in === true);
        }
        if (item.checkedIn) {
          markDeviceClaimedToday();
          item.ok = true; item.msg = '签到成功';
        } else if (isDeviceClaimedToday()) {
          // 今日设备名额已被其他账号占用：设备已完成签到，不再拉起 TraeWork，
          // 状态按"已签"处理（Trae 按设备计算签到，名额被领 = 本设备今日已签）。
          // r.ok 必须同步置真，否则下方通用收尾会把 ok/msg 覆盖回失败。
          item.ok = true;
          item.already = true;
          item.msg = '本设备已有其他账号签到';
          r = { ok: true };
          log(`[claim_all] ${item.nickname} 跳过宿主 IPC 签到：设备今日名额已用（按已签计）`);
        } else if (r && r.retryable) {
          log(`[claim_all] ${item.nickname} HTTP 签到被服务端拒绝，改走宿主 IPC 签到（自动拉起/关闭 TraeWork）`);
          const viaApp = await claimViaApp();
          if (viaApp.ok) {
            item.checkedIn = true;
            r = { ok: true };
            markDeviceClaimedToday();
            log(`[claim_all] ${item.nickname} 宿主 IPC 签到成功`);
          } else {
            r = { ok: false, error: viaApp.error || '宿主 IPC 签到失败' };
            if (/已经签到/.test(viaApp.error || '')) markDeviceClaimedToday();
            log(`[claim_all] ${item.nickname} 宿主 IPC 签到失败: ${viaApp.error}`);
          }
        }
        if (!item.checkedIn) {
          item.ok = !!(r && r.ok);
          if (!item.ok) {
            item.msg = (r && (r.error || (r.data && (r.data.message || r.data.msg)))) || '签到失败';
          }
        }
      }

      // 签到时同步该账号的最新 Cookie 时限：若宿主在 IPC 签到期间刷新过登录态，
      // storage.json 里的密文会比备份库里的新——连同有效期一并写回账号库，
      // 保证面板上的「Cookie 时限」始终反映签到那一刻的真实有效期。
      try {
        let liveSecret = rec.secret;
        try {
          const cur = JSON.parse(fs.readFileSync(storageFile(), 'utf8'))['iCubeAuthInfo://icube.cloudide'];
          const curInfo = cur ? decodeSecret(cur) : null;
          if (curInfo && String(curInfo.userId) === String(a.uid)) liveSecret = cur;
        } catch (_) {}
        const liveInfo = decodeSecret(liveSecret);
        if (liveInfo && String(liveInfo.userId) === String(a.uid)) {
          const meta = accountMetaFromInfo(liveInfo);
          const store = loadStore();
          const idx = store.traework.accounts.findIndex((x) => String(x.uid) === String(a.uid));
          if (idx >= 0) {
            const prev = store.traework.accounts[idx];
            const secretChanged = prev.secret !== liveSecret;
            const metaChanged = prev.expiredAt !== meta.expiredAt || prev.refreshExpiredAt !== meta.refreshExpiredAt
              || (prev.nickname || '') !== meta.nickname || (prev.mobile || '') !== meta.mobile;
            if (secretChanged || metaChanged) {
              store.traework.accounts[idx] = Object.assign({}, prev, meta, { secret: liveSecret });
              if (secretChanged) store.traework.accounts[idx].backedUpAt = Date.now();
              saveStore(store);
              if (meta.expiredAt !== prev.expiredAt) {
                log(`[rotate] ${item.nickname}: Cookie 时限已同步 -> ${meta.expiredAt || '(无)'}${secretChanged ? '（登录态已刷新）' : ''}`);
              }
            }
          }
        }
      } catch (_) { /* 同步失败不影响签到结果 */ }
    } catch (e) { item.msg = e.message || String(e); }

    results.push(item);
    // 写入每账号积分缓存（含权益包明细），面板据此显示非当前账号的剩余积分
    creditsStore[item.uid] = {
      remaining: item.remaining,
      checkedIn: item.checkedIn,
      packs: item.packs,
      claimedOk: claim ? !!item.ok : (creditsStore[item.uid]?.claimedOk ?? null),
      at: Date.now(),
    };
    saveCreditsStore(creditsStore);
    log(`[rotate] ${item.nickname}: 剩余=${item.remaining ?? '?'} 已签=${item.checkedIn}${claim ? ' claim=' + (item.ok ? '成功' : item.msg) : ''}`);
  }

  // 恢复原账号登录态；宿主只在「轮换前就在运行」时才按原状重启
  if (originSecret) {
    try { writeAuthSecret(originSecret); } catch (e) { log('[rotate] 恢复原账号失败: ' + e.message); }
  }
  if (hostWasRunning) {
    try { await ensureTraeWorkWithCdp(); } catch (_) {}
  }
  statusCache.at = 0; statusCache.data = null;
  entCache.at = 0; entCache.data = null;
  return results;
}

async function runClaimAll() {
  if (claimAllJob.running) return;
  claimAllJob = { running: true, total: 0, done: 0, results: [], startedAt: Date.now(), finishedAt: 0 };
  log('[claim_all] 开始全账号自动签到');
  try {
    const accounts = listAccounts();
    claimAllJob.total = accounts.length;
    const results = await rotateAllAccounts({ claim: true });
    claimAllJob.results = results;
    claimAllJob.done = results.length;
    // AutoClaw：独立账号体系，一并签到（每日 daily_signin 任务，与 Trae 轮换互不影响）；
    // 结果并入 claimAllJob（total/results/done），前端「全部签到」进度和完成提示一起统计
    try {
      const acRes = await clientClaimDailyForAll('ac');
      if (!acRes.skipped) {
        claimAllJob.total += acRes.total || 0;
        claimAllJob.results = claimAllJob.results.concat(acRes.results || []);
        claimAllJob.done = claimAllJob.results.length;
      }
    } catch (e) {
      log('[claim_all] AutoClaw 签到异常: ' + e.message);
    }
  } catch (e) {
    log('[claim_all] 异常: ' + e.message);
  } finally {
    claimAllJob.running = false;
    claimAllJob.finishedAt = Date.now();
    log('[claim_all] 结束，用时 ' + Math.round((claimAllJob.finishedAt - claimAllJob.startedAt) / 1000) + 's');
    scheduleClaimCatchUp();
  }
}

// 有界补签：早高峰 Trae 服务端限流（9074「参与用户太多」）时，每 10 分钟补签一轮，
// 最多 6 轮；全部签成即停。不是常驻循环——当天签完或轮次用尽后不再触发。
let claimCatchUpCount = 0;
function scheduleClaimCatchUp() {
  // 「设备今日已签到」是 Trae 的按设备每日一次限制，无法通过重试解决，不算可补签失败
  const failed = (claimAllJob.results || []).some((r) => !r.ok && !/已经签到|已有其他账号签到/.test(r.msg || ''));
  if (!failed) { claimCatchUpCount = 0; return; }
  if (claimCatchUpCount >= 6) {
    log('[claim_all] 补签轮次已达上限（6 轮），今日停止补签');
    return;
  }
  claimCatchUpCount += 1;
  const n = claimCatchUpCount;
  log(`[claim_all] 有账号未签成，10 分钟后自动补签（第 ${n}/6 轮）`);
  setTimeout(() => {
    log(`[claim_all] 补签第 ${n} 轮开始`);
    runClaimAll();
  }, 10 * 60 * 1000);
}

/// 仅刷新各账号积分/签到状态（不签到）。宿主运行时不轮换（避免打断），直接返回。
async function refreshCreditsOnly() {
  if (claimAllJob.running) return { refreshed: false, reason: '任务进行中' };
  if (isProcessRunning()) return { refreshed: false, reason: 'TraeWork 正在运行' };
  log('[credits] 开始刷新各账号积分');
  const results = await rotateAllAccounts({ claim: false });
  return { refreshed: true, results };
}

// ---------------- 本地 HTTP API（供注入的宠物面板调用） ----------------
const statusCache = { at: 0, data: null };
function cachedStatus() {
  if (statusCache.data && Date.now() - statusCache.at < 30000) return statusCache.data;
  return null;
}

async function fetchStatus() {
  const hit = cachedStatus();
  if (hit) return hit;
  const auth = getAuth();
  if (auth.error) return { ok: false, error: auth.error };
  const r = await checkinRequest('status', auth);
  const out = { ok: r.ok, status: r.status, data: Object.assign({}, r.body), host: r.host, error: r.error };
  if (r.ok) { statusCache.at = Date.now(); statusCache.data = out; }
  return out;
}

/** 判断签到失败是否「临时性、可自动重试」：高峰期限流/5xx/网络抖动都算 */
function isTransientClaimFailure(r, data) {
  const code = data && data.code;
  if (code === 9074) return true;            // 当前参与用户太多，请稍后再试
  if (code === -1 || code === 500 || code === 502 || code === 503) return true; // 服务端限流/繁忙
  if (r.status === 429 || (r.status >= 500 && r.status < 600)) return true;
  if (!r.ok && !r.status) return true;       // 网络错误/超时
  return false;
}

let claimInFlight = false;
async function doClaim() {
  if (claimInFlight) return { ok: false, error: '签到进行中，请稍候' };
  claimInFlight = true;
  try {
    const auth = getAuth();
    if (auth.error) return { ok: false, error: auth.error };
    const r = await checkinRequest('claim', auth);
    const data = r.body || {};
    // claim 请求出错（超时/网络抖动/5xx）时，服务端可能已受理：
    // 回查一次状态，若 checked_in 已为 true，按「已签到成功」处理，避免误报失败。
    let claimedAnyway = false;
    if (!r.ok) {
      try {
        const s = await checkinRequest('status', auth);
        if (s.ok && s.body && s.body.checked_in === true) claimedAnyway = true;
      } catch (_) {}
    }
    // claim 成功后刷新状态缓存，让面板立即反映
    statusCache.at = 0; statusCache.data = null;
    entCache.at = 0; entCache.data = null;
    if (claimedAnyway) {
      log('[claim] 请求报错但状态显示已签到（服务端已受理），按成功处理');
      return { ok: true, status: 200, data: { code: 0, message: '已签到' }, claimedAnyway: true, error: r.error };
    }
    return { ok: r.ok, status: r.status, data, retryable: !r.ok && isTransientClaimFailure(r, data), error: r.error };
  } finally {
    claimInFlight = false;
  }
}

// ---------------- 权益额度（对齐 Trae 用量管理页） ----------------
// 用官方 ide_user_ent_usage 接口返回每个积分额度包（邀请奖励/每月登录赠送/签到奖励等）
// 的 剩余/总额 + 到期时间，供桌面端按用量页样式展示。
const entCache = { at: 0, data: null };
const ENT_USAGE_PATH = '/trae/api/v2/pay/ide_user_ent_usage';
function cachedEntitlements() {
  if (entCache.data && Date.now() - entCache.at < 30000) return entCache.data;
  return null;
}
async function fetchEntitlements() {
  const hit = cachedEntitlements();
  if (hit) return hit;
  const auth = getAuth();
  if (auth.error) return { ok: false, error: auth.error };
  let lastErr = null;
  for (const host of CHECKIN_HOSTS) {
    try {
      const r = await postJson(host + ENT_USAGE_PATH, {}, checkinHeaders(auth));
      const body = r.body || {};
      // 该接口成功码也为 code===0 或缺失 code
      const ok = r.status === 200 && (body.code === 0 || body.code === undefined || body.code === null);
      if (ok) {
        const packs = ((body.user_entitlement_pack_list) || [])
          .filter((p) => p && p.is_hide !== true)
          .map((p) => {
            const base = p.entitlement_base_info || {};
            const pq = (base.product_extra && base.product_extra.package_extra) || {};
            const limit = base.quota && typeof base.quota.credits_limit === 'number' ? base.quota.credits_limit : 0;
            const used = (p.usage && typeof p.usage.credits_amount === 'number')
              ? Math.max(0, p.usage.credits_amount) : 0;
            return {
              name: p.display_desc || p.group_name || '权益',
              groupType: p.group_type != null ? p.group_type : null,
              limit,
              used,
              remaining: limit > 0 ? Math.max(0, limit - used) : null,
              expireTime: (p.expire_time && p.expire_time > 0) ? p.expire_time
                : ((base.end_time && base.end_time > 0) ? base.end_time : 0),
              sourceType: pq.package_source_type != null ? pq.package_source_type : null,
              productType: base.product_type != null ? base.product_type : null,
            };
          })
          .filter((p) => p.limit > 0 && p.remaining !== null); // 只保留有积分配额的奖励桶
        const out = { ok: true, data: { usage_summary: body.usage_summary || null, packs } };
        entCache.at = Date.now(); entCache.data = out;
        return out;
      }
      lastErr = 'HTTP ' + r.status + ' ' + (body.message || body.msg || '');
    } catch (e) { lastErr = e.message; }
  }
  return { ok: false, error: lastErr };
}

/** 仅回显可信来源的 Origin；绝不用 *（避免恶意网页读到账号/会话响应）。
 *  允许：无 Origin（本地 CLI/curl）、'null'（Electron file:// renderer）、
 *  vscode-file://（TraeWork 注入页）、loopback。 */
function isAllowedApiOrigin(origin) {
  if (!origin) return true;
  if (origin === 'null') return true;
  try {
    const u = new URL(origin);
    if (u.protocol === 'vscode-file:') return true; // TraeWork 注入页
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
    const host = String(u.hostname || '').toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '[::1]';
  } catch (_) { return false; }
}

function corsOrigin(req) {
  const origin = String(req.headers.origin || '');
  return isAllowedApiOrigin(origin) ? origin : null;
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let obj = {};
      try { obj = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) {}
      resolve(obj);
    });
    req.on('error', reject);
  });
}

function sendJson(res, code, obj) {
  const text = JSON.stringify(obj);
  const headers = { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' };
  const origin = res.__twCorsOrigin;
  if (origin) { headers['Access-Control-Allow-Origin'] = origin; headers.Vary = 'Origin'; }
  res.writeHead(code, headers);
  res.end(text);
}

// 本地 API 鉴权：桌面端（Rust）会附带 X-WorkPet-Token；浏览器网页无法得知该值，
// 防止恶意页面跨域调用本机 API（切换/删除账号、导入备份等）。
const API_TOKEN = (() => {
  try {
    const t = fs.readFileSync(path.join(DATA_ROOT, '.api-token'), 'utf8').trim();
    if (t) return t;
  } catch (_) {}
  const t = crypto.randomBytes(32).toString('hex');
  try { fs.writeFileSync(path.join(DATA_ROOT, '.api-token'), t, { mode: 0o600 }); } catch (_) {}
  return t;
})();

setInterval(() => {
    re2ClaimAllProfiles().catch((e) => log('[re2] 自动签到轮异常: ' + e.message));
  }, 60 * 60 * 1000).unref?.();
  setTimeout(() => { re2ClaimAllProfiles().catch((e) => log('[re2] 启动签到轮异常: ' + e.message)); }, 90 * 1000).unref?.();
  log('[re2] 全自动签到定时器已启动（启动 90s 后首轮，之后每小时一轮）');

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://' + HOST + ':' + UI_PORT);
  if (url.pathname.startsWith('/api/') && req.headers['x-workpet-token'] !== API_TOKEN) {
    return sendJson(res, 401, { ok: false, error: 'unauthorized' });
  }
  res.__twCorsOrigin = corsOrigin(req); // 传给 sendJson 回显
  // 预检：注入页可能带 CORS preflight
  if (req.method === 'OPTIONS') {
    const origin = res.__twCorsOrigin;
    res.writeHead(204, {
      'Access-Control-Allow-Origin': origin || '',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age': '600',
    });
    return res.end();
  }
  try {
    if (req.method === 'GET' && url.pathname === '/api/health') {
      // 健康检查永远返回 200：桌面端靠 version/fingerprint 判断 daemon 就绪，
      // 此处一旦 500 会被误判为「版本不匹配」，误报「后台服务启动超时」。
      let authed = false;
      try { authed = !getAuth().error; } catch (_) {}
      return sendJson(res, 200, {
        ok: true, app: APP_BRAND, version: DAEMON_VERSION, ts: Date.now(), authed,
        // 脚本指纹 + 运行时 node 版本：桌面端据此识别「同版本号重新构建」导致的旧进程残留
        fingerprint: SELF_FINGERPRINT, node: process.version,
      });
    }
    if (req.method === 'GET' && url.pathname === '/api/checkin/status') {
      const r = await fetchStatus();
      return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, ...r });
    }
    if (req.method === 'GET' && url.pathname === '/api/checkin/entitlements') {
      const r = await fetchEntitlements();
      return sendJson(res, r.ok ? 200 : 502, r);
    }
    if (req.method === 'POST' && url.pathname === '/api/checkin/claim') {
      const r = await doClaim();
      return sendJson(res, r.ok ? 200 : 502, { ok: r.ok, ...r });
    }
    if (req.method === 'POST' && url.pathname === '/api/checkin/claim_all') {
      if (!claimAllJob.running) void runClaimAll();
      return sendJson(res, 200, { ok: true, running: claimAllJob.running, done: claimAllJob.done, total: claimAllJob.total });
    }
    if (req.method === 'GET' && url.pathname === '/api/checkin/claim_all') {
      return sendJson(res, 200, { ok: true, ...claimAllJob });
    }
    if (req.method === 'POST' && url.pathname === '/api/credits/refresh') {
      const r = await refreshCreditsOnly();
      return sendJson(res, 200, { ok: true, ...r });
    }
    if (req.method === 'GET' && url.pathname === '/api/accounts') {
      const current = readCurrentAccount();
      const store = loadCreditsStore();
      const accounts = listAccounts().map((a) => ({
        ...a,
        // 每账号积分缓存（轮换时抓取），供面板显示非当前账号的剩余积分
        credits: store[a.uid]
          ? {
              remaining: store[a.uid].remaining,
              checkedIn: !!store[a.uid].checkedIn,
              claimedOk: store[a.uid].claimedOk ?? null,
              packs: Array.isArray(store[a.uid].packs) ? store[a.uid].packs : [],
              at: store[a.uid].at || 0,
            }
          : null,
      }));
      return sendJson(res, 200, { ok: true, current, accounts, deviceClaimDate: store.deviceClaimDate || null });
    }
    if (req.method === 'GET' && url.pathname.startsWith('/api/client/')) {
      const parts = url.pathname.split('/');
      const pid = parts[3];
      if (!CLIENT_PROFILES[pid]) return sendJson(res, 404, { ok: false, error: 'unknown client' });
      if (parts[4] === 'status') {
        const st = clientCheckinState[pid];
        let cdpConnected = false;
        try {
          const r = await fetch('http://127.0.0.1:' + CLIENT_PROFILES[pid].cdpPort + '/json/version', { signal: AbortSignal.timeout(1500) });
          cdpConnected = r.ok;
        } catch (_) {}
        return sendJson(res, 200, {
          ok: true,
          profile: { id: pid, name: CLIENT_PROFILES[pid].name },
          batch: { running: st.running, total: st.total, done: st.done },
          cdp: { connected: cdpConnected },
        });
      }
      if (parts[4] === 'accounts') {
        clientClaimDailyForAll(pid).catch((e) => log('[client:' + pid + '] 自动签到失败: ' + e.message));
        // AutoClaw 账号列表：macOS 优先经 CDP 从 AutoClaw 应用内读登录态/积分（绕开 auth.json 钥匙串解密坑）；
        // CDP 不可用或读取失败再回退请求密钥做 auth.json 解密。
        if (pid === 'ac') {
          if (isMac) {
            try { await acEnsureAuthViaCdp(); }
            catch (e) { log('[client:ac] CDP 读登录态不可用，回退 auth.json 解密: ' + e.message); try { await acRequestKey(); } catch (_) {} }
          } else {
            try { await acRequestKey(); } catch (_) {}
          }
        }
        // CodeArts：登录态在 SQLite 且需解密，异步同步后返回（拉取同时即完成当前账号备份）
        if (pid === 'ca') {
          try { await caRequestKey(); await caSyncStore(); } catch (e) { log('[client:ca] 同步登录态失败: ' + e.message); }
          const list2 = caListAccounts();
          return sendJson(res, 200, { ok: true, ...list2, batch: clientCheckinState.ca });
        }
        const list = clientListAccounts(pid);
        return sendJson(res, 200, { ok: true, ...list, batch: clientCheckinState[pid] });
      }
      if (parts[4] === 'token-usage') {
        // WorkBuddy / CodeBuddy / AutoClaw Token 用量：扫描本机会话日志统计（60s 缓存）
        if (pid !== 'wb' && pid !== 'cb' && pid !== 'ac') return sendJson(res, 404, { ok: false, error: 'token usage only available for wb/cb/ac' });
        return sendJson(res, 200, { ok: true, ...clientUsageSummary(pid) });
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/client/')) {
      const parts = url.pathname.split('/');
      const pid = parts[3];
      if (!CLIENT_PROFILES[pid]) return sendJson(res, 404, { ok: false, error: 'unknown client' });
      const body = await readBody(req);
      if (parts[4] === 'credits') {
        if (pid === 'ca') return sendJson(res, 400, { ok: false, error: 'CodeArts Agent 额度按官方政策自动发放，无积分查询接口' });
        const uid = (body.uid || '').trim();
        const tk = clientTokenFor(pid, uid);
        if (!tk) return sendJson(res, 404, { ok: false, error: '账号备份不存在或无 accessToken' });
        try {
          const r = await clientFetchCredits(pid, tk);
          return sendJson(res, 200, { ok: true, uid, credits: r.credits, count: r.count, segments: r.segments });
        } catch (e) {
          log('[client:' + pid + '] 积分查询失败 ' + uid + ': ' + e.message);
          return sendJson(res, 500, { ok: false, error: e.message });
        }
      }
      if (parts[4] === 'switch') {
        const uid = (body.uid || '').trim();
        // CodeArts：vscdb 写回 + 客户端重启，专用流程
        if (pid === 'ca') {
          try {
            const r = await caSwitchToAccount(uid);
            return sendJson(res, 200, { ok: true, uid, nickname: r.nickname, hint: r.relaunched ? '已切换并重启 CodeArts Agent' : '已切换；下次启动 CodeArts Agent 时生效' });
          } catch (e) {
            log('[client:ca] 切换失败: ' + e.message);
            return sendJson(res, 500, { ok: false, error: e.message });
          }
        }
        const store = loadStore();
        const sec = store[pid === 'wb' ? 'workbuddy' : pid === 'cb' ? 'codebuddy' : 'ac'];
        if (pid === 'ac') {
          // AutoClaw：登录态只有本机一份（auth.json），无多账号文件可切换；
          // 备份库里的其他账号只有 accessToken，回写会破坏 safeStorage 加密一致性，不支持
          return sendJson(res, 400, { ok: false, error: 'AutoClaw 暂不支持多账号切换（登录态由 AutoClaw 客户端管理）' });
        }
        const raw = sec.accounts.find((a) => a && a.account && String(a.account.uid) === String(uid));
        if (!raw) return sendJson(res, 404, { ok: false, error: '账号备份不存在' });
        try {
          const tmp = CLIENT_PROFILES[pid].authFile + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(raw, null, 2));
          fs.renameSync(tmp, CLIENT_PROFILES[pid].authFile);
          clientSyncStore(pid);
          const reloaded = await clientReloadViaCdp(pid);
          log('[client:' + pid + '] 已切换账号 ' + (raw.account.nickname || uid) + (reloaded ? '（CDP 已刷新）' : ''));
          return sendJson(res, 200, { ok: true, uid, reloaded, hint: reloaded ? '已切换并刷新窗口' : '登录文件已切换，重启客户端后生效' });
        } catch (e) {
          return sendJson(res, 500, { ok: false, error: e.message });
        }
      }
      if (parts[4] === 'delete') {
        const uid = (body.uid || '').trim();
        const store = loadStore();
        const sec = pid === 'ca' ? store.codearts : store[pid === 'wb' ? 'workbuddy' : pid === 'cb' ? 'codebuddy' : 'ac'];
        const before = sec.accounts.length;
        if (pid === 'ac' || pid === 'ca') {
          sec.accounts = sec.accounts.filter((a) => a && String(a.uid) !== String(uid));
        } else {
          sec.accounts = sec.accounts.filter((a) => a && a.account && String(a.account.uid) !== String(uid));
        }
        saveStore(store);
        return sendJson(res, 200, { ok: true, deleted: before - sec.accounts.length });
      }
      return sendJson(res, 404, { ok: false, error: 'not found' });
    }
    if (req.method === 'POST' && url.pathname === '/api/backup/export') {
      try {
        const r = exportBackupFile();
        log('[backup] 已导出全部账号: ' + r.file);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'GET' && url.pathname === '/api/backup/list') {
      return sendJson(res, 200, { ok: true, files: listBackupFiles() });
    }
    if (req.method === 'POST' && url.pathname === '/api/backup/import') {
      const body = await readBody(req);
      try {
        // 支持两种来源：直接传入文件内容 data，或传入导出文件名 name（数据目录内）
        let data = body.data;
        if (!data) {
          if (!/^WorkPet-accounts-\d{8}-\d{6}\.json$/.test(String(body.name || ''))) throw new Error('非法的备份文件名');
          data = readJsonOrNull(path.join(BACKUP_DIR, body.name));
        }
        const counts = await restoreBackupData(data);
        log('[backup] 已恢复账号: ' + JSON.stringify(counts));
        statusCache.at = 0; statusCache.data = null; entCache.at = 0; entCache.data = null;
        return sendJson(res, 200, { ok: true, counts });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts/backup_all') {
      // 备份所有账号：跨客户端收集全部登录 + 备份当前登录（历史备份自动保留）
      try {
        const collected = collectAllTraeAccounts();
        let current = null;
        try { current = backupCurrentAccount(); } catch (_) {}
        const total = listAccounts().length;
        log('[backup_all] 收集 ' + collected.length + ' 个客户端登录，备份当前 ' + (current ? current.nickname : '无') + '，账号库共 ' + total + ' 个');
        return sendJson(res, 200, { ok: true, collected: collected.length, current, total });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts/backup') {
      try {
        const r = backupCurrentAccount();
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts/switch') {
      const body = await readBody(req);
      const uid = String((body && body.uid) || '').trim();
      if (!uid) return sendJson(res, 400, { ok: false, error: '缺少 uid' });
      try {
        const r = await switchToAccount(uid);
        return sendJson(res, 200, { ok: true, ...r });
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: e.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/accounts/delete') {
      const body = await readBody(req);
      const uid = String((body && body.uid) || '').trim();
      if (!uid) return sendJson(res, 400, { ok: false, error: '缺少 uid' });
      const cur = readCurrentAccount();
      if (cur && cur.uid === uid) return sendJson(res, 400, { ok: false, error: '不能删除当前登录账号' });
      const deleted = deleteAccountBackup(uid);
      return sendJson(res, 200, { ok: true, deleted, uid });
    }
    if (req.method === 'GET' && url.pathname === '/api/config') {
      const s = loadSettings();
      return sendJson(res, 200, { ok: true, launchHostOnStart: !!s.launchHostOnStart, wbLaunchOnStart: !!s.wbLaunchOnStart, showPhone: !!s.showPhone, fontScale: Number(s.fontScale ?? 1), cbLaunchOnStart: !!s.cbLaunchOnStart, acLaunchOnStart: !!s.acLaunchOnStart, caLaunchOnStart: !!s.caLaunchOnStart, hidePet: !!s.hidePet, tabShowText: !!s.tabShowText, tabOrder: normalizeTabOrder(s.tabOrder) || ['wb', 'cb', 'ac', 'ca', 'tw'] });
    }
    if (req.method === 'POST' && url.pathname === '/api/config') {
      const body = await readBody(req);
      const patch = {};
      if (typeof body.launchHostOnStart === 'boolean') patch.launchHostOnStart = body.launchHostOnStart;
      if (typeof body.wbLaunchOnStart === 'boolean') patch.wbLaunchOnStart = body.wbLaunchOnStart;
      if (typeof body.showPhone === 'boolean') patch.showPhone = body.showPhone;
      if (typeof body.fontScale === 'number' && body.fontScale >= 0.8 && body.fontScale <= 1.5) patch.fontScale = body.fontScale;
      if (typeof body.cbLaunchOnStart === 'boolean') patch.cbLaunchOnStart = body.cbLaunchOnStart;
      if (typeof body.acLaunchOnStart === 'boolean') patch.acLaunchOnStart = body.acLaunchOnStart;
      if (typeof body.caLaunchOnStart === 'boolean') patch.caLaunchOnStart = body.caLaunchOnStart;
      if (typeof body.hidePet === 'boolean') patch.hidePet = body.hidePet;
      if (typeof body.tabShowText === 'boolean') patch.tabShowText = body.tabShowText;
      if (Array.isArray(body.tabOrder)) {
        const order = normalizeTabOrder(body.tabOrder);
        if (order) patch.tabOrder = order;
      }
      const s = saveSettings(patch);
      log('[config] 已保存设置: ' + JSON.stringify(patch));
      return sendJson(res, 200, { ok: true, launchHostOnStart: !!s.launchHostOnStart, wbLaunchOnStart: !!s.wbLaunchOnStart, showPhone: !!s.showPhone, fontScale: Number(s.fontScale ?? 1), cbLaunchOnStart: !!s.cbLaunchOnStart, acLaunchOnStart: !!s.acLaunchOnStart, caLaunchOnStart: !!s.caLaunchOnStart, hidePet: !!s.hidePet, tabShowText: !!s.tabShowText, tabOrder: normalizeTabOrder(s.tabOrder) || ['wb', 'cb', 'ac', 'ca', 'tw'] });
    }
    if (req.method === 'GET' && url.pathname === '/api/check-update') {
      try {
        const gh = await getJson('https://api.github.com/repos/connoryang331/workpet/releases/latest');
        if (gh.status === 200 && gh.body) {
          const latestTag = String(gh.body.tag_name || '').trim();
          const currentTag = 'v' + APP_VERSION;
          // 仅当远端版本严格大于当前版本时才提示更新，避免本地 dev 版领先于已发布版本时误报
          const hasUpdate = Boolean(latestTag && compareSemver(latestTag, currentTag) > 0);
          return sendJson(res, 200, {
            ok: true,
            hasUpdate,
            currentVersion: currentTag,
            latestVersion: latestTag || currentTag,
            title: gh.body.name || latestTag,
            url: gh.body.html_url || 'https://github.com/connoryang331/workpet/releases/latest',
            publishedAt: gh.body.published_at || '',
          });
        }
        return sendJson(res, 200, { ok: true, hasUpdate: false, currentVersion: 'v' + APP_VERSION, error: 'GitHub API ' + gh.status });
      } catch (err) {
        return sendJson(res, 200, { ok: true, hasUpdate: false, currentVersion: 'v' + APP_VERSION, error: err.message });
      }
    }
    if (req.method === 'POST' && url.pathname === '/api/shutdown') {
      sendJson(res, 200, { ok: true, message: 'shutting down' });
      setTimeout(() => {
        log('[daemon] 收到退出请求，正在终止 daemon 进程');
        process.exit(0);
      }, 300);
      return;
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    log('[api] error ' + url.pathname + ': ' + e.message);
    return sendJson(res, 500, { ok: false, error: e.message });
  }
});

// ---------------- CDP ----------------
const cdp = { port: 0, ws: null, connected: false, error: null, targetUrl: '', id: 0, pending: new Map() };

function cdpSend(method, params = {}) {
  if (!cdp.ws || cdp.ws.readyState !== 1) return Promise.reject(new Error('CDP 未连接'));
  const id = ++cdp.id;
  return new Promise((resolve, reject) => {
    cdp.pending.set(id, { resolve, reject });
    cdp.ws.send(JSON.stringify({ id, method, params }));
  });
}

async function readCdpTargets(port) {
  const r = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1500) });
  const list = await r.json();
  return Array.isArray(list) ? list : [];
}

function isTraeWorkPageTarget(t) {
  if (!t || t.type !== 'page' || !t.webSocketDebuggerUrl) return false;
  const u = String(t.url || '');
  // 主工作台页面：workbench.html；兜底 vscode-file / electron-browser 页面
  if (/workbench(\.html)?/i.test(u)) return true;
  if (/vscode-file:\/\/vscode-app\//i.test(u)) return true;
  if (/out\/vs\/code\/electron-browser\//i.test(u)) return true;
  return false;
}

async function getPageTarget(port) {
  const list = await readCdpTargets(port).catch(() => []);
  return list.find(isTraeWorkPageTarget) || null;
}

async function findCdpEndpoint() {
  try {
    const list = await readCdpTargets(CDP_PORT);
    if (list.some(isTraeWorkPageTarget)) return CDP_PORT;
  } catch (_) {}
  return 0;
}

async function connectCdp() {
  const port = await findCdpEndpoint();
  if (!port) {
    cdp.connected = false;
    cdp.error = '未发现 TraeWork 的 CDP 端口';
    return false;
  }
  const target = await getPageTarget(port).catch(() => null);
  if (!target) {
    cdp.connected = false;
    cdp.error = `端口 ${port} 上没有 TraeWork 页面目标`;
    return false;
  }
  if (cdp.ws) { try { cdp.ws.close(); } catch (_) {} }
  cdp.port = port;
  return new Promise((resolve) => {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    ws.onopen = () => {
      cdp.ws = ws;
      cdp.connected = true;
      cdp.error = null;
      cdp.targetUrl = target.url || '';
      log('[cdp] 已连接: ' + cdp.targetUrl.slice(0, 120));
      // 页面重载后自动补种
      try {
        ws.onmessage = (ev) => {
          try {
            const msg = JSON.parse(ev.data);
            if (msg.id && cdp.pending.has(msg.id)) {
              const p = cdp.pending.get(msg.id);
              cdp.pending.delete(msg.id);
              if (msg.error) p.reject(new Error(msg.error.message || msg.error));
              else p.resolve(msg.result);
            }
          } catch (_) {}
        };
      } catch (_) {}
      resolve(true);
    };
    ws.onerror = () => { cdp.connected = false; cdp.ws = null; resolve(false); };
    ws.onclose = () => { cdp.connected = false; cdp.ws = null; };
  });
}

let lastInjectAt = 0;
async function injectWidget(reason) {
  if (!cdp.connected) return Promise.reject(new Error('CDP 未连接'));
  if (reason !== 'manual' && Date.now() - lastInjectAt < 1000) return;
  lastInjectAt = Date.now();
  let script;
  try { script = fs.readFileSync(path.join(__dirname, 'inject.js'), 'utf8'); }
  catch (e) { return Promise.reject(new Error('读取 inject.js 失败: ' + e.message)); }
  script = script.replace(/__TW_API__/g, `http://${HOST}:${UI_PORT}`);
  script = script.replace(/__TW_VERSION__/g, DAEMON_VERSION);
  log(`[cdp] 注入宠物组件 (${reason})`);
  const cleanup = 'try{if(window.__twPet&&typeof window.__twPet.destroy==="function"){window.__twPet.destroy();}}catch(e){}';
  try { await cdpSend('Runtime.evaluate', { expression: cleanup }); } catch (_) {}
  const r = await cdpSend('Runtime.evaluate', { expression: script }).catch((e) => ({ error: e.message }));
  if (r && r.error) { log('[cdp] 注入失败: ' + r.error); return { mounted: false }; }
  if (r && r.exceptionDetails) {
    const ex = r.exceptionDetails.exception;
    log('[cdp] 注入脚本页面抛错: ' + String((ex && (ex.description || ex.value)) || r.exceptionDetails.text || '').slice(0, 400));
    return { mounted: false };
  }
  // 校验挂载
  for (let i = 0; i < 5; i++) {
    await sleep(i === 0 ? 150 : 300);
    try {
      const check = await cdpSend('Runtime.evaluate', {
        expression: '({root:!!document.querySelector(".tw-pet-root"), widget:!!window.__twPet})',
        returnByValue: true,
      });
      const st = check && check.result && check.result.value;
      if (st && st.root && st.widget) {
        log('[cdp] 注入确认(' + reason + '): root=true widget=true');
        return { mounted: true };
      }
    } catch (_) {}
  }
  log('[cdp] 注入后未检测到组件(' + reason + ')');
  return { mounted: false };
}

// ---------------- 进程管理（确保 TraeWork 以 CDP 模式运行） ----------------
const EXE_NAME = isMac
  ? path.basename(CFG.exe || 'TRAE SOLO CN')
  : path.basename(CFG.exe || 'TRAE SOLO CN.exe');

// pgrep -f 走 ERE 正则，这里有两个必须避开的坑：
//
// 1) 绝不能写成 '(\s|$)' —— JS 单引号字符串里 \s 不是合法转义，会被原样吞成 's'，
//    实际生效的模式是 "(s|$)"；而真实命令行形如
//    /Applications/XXX.app/Contents/MacOS/Electron，应用名后紧跟的是 '.' 而非 's'，
//    于是 pgrep 永远无匹配 → isProcessRunning() 在 macOS 上恒为 false：
//      · ensureTraeWorkWithCdp() 刚 spawn 完就判定「进程已退出」而 break，不再等 CDP 端口就绪
//      · 两轮拉起都秒退 →「等待 TraeWork CDP 端口超时」，宿主 IPC 签到永远走不通。
//
// 2) 不要写死品牌名。安装目录已由 "TRAE SOLO CN" 改为 "TraeWork CN"，任何固定名称都会在
//    下一次改名后再次失效。这里只约束「含 trae 且含 solo/work 的 .app 包内的
//    Contents/MacOS/」——额外要求 solo/work 是为了排除普通版 Trae（"Trae CN" / "Trae"），
//    那是另一个产品，不在本项目适配范围内（见 TRAEWORK_NAME_RE）。
//    匹配：TRAE SOLO CN.app / TraeWork CN.app / TraeWork.app
//    排除：Trae CN.app / Trae.app
//    注意 ERE 不支持 (?i)，用字符类 [Tt][Rr][Aa][Ee] 等代替忽略大小写。
const TRAE_PROCESS_ERE =
  '/[Tt][Rr][Aa][Ee][^/]*([Ss][Oo][Ll][Oo]|[Ww][Oo][Rr][Kk])[^/]*\\.app/Contents/MacOS/';

function isProcessRunning() {
  if (isMac) {
    try {
      const out = execFileSync('pgrep', ['-f', TRAE_PROCESS_ERE], { encoding: 'utf8' });
      return Boolean(out.trim());
    } catch (_) { return false; }
  }
  try {
    const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ' + EXE_NAME, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true });
    return out.includes(EXE_NAME);
  } catch (_) { return false; }
}

function killTraeWork() {
  if (isMac) {
    // 先按已探测到的可执行路径结束，再按通用路径模式兜底。
    // 不再用写死的 app 名列表去 osascript quit：客户端已多次改名
    // （TRAE SOLO CN → Trae CN → TraeWork CN），固定名称撑不过下一次改名。
    if (CFG.exe) {
      try { execFileSync('pkill', ['-f', CFG.exe], { stdio: 'ignore' }); } catch (_) {}
    }
    try { execFileSync('pkill', ['-f', TRAE_PROCESS_ERE], { stdio: 'ignore' }); } catch (_) {}
  } else {
    try { execFileSync('taskkill', ['/IM', EXE_NAME, '/F', '/T'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  }
}

/** 退出 AutoClaw（macOS 与 Windows），用于「签到后自动关闭」的临启即关场景 */
function killAutoClaw() {
  if (isMac) {
    // 先 SIGKILL 强杀（杀主进程与所有子进程），避免 osascript 走优雅退出要等用户确认；
    // 杀完再用 osascript 兜底处理 dock 图标残留。
    try { execFileSync('pkill', ['-9', '-x', 'AutoClaw'], { stdio: 'ignore' }); } catch (_) {}
    try { execFileSync('pkill', ['-9', '-f', 'AutoClaw Helper'], { stdio: 'ignore' }); } catch (_) {}
    try { execFileSync('osascript', ['-e', 'tell application "AutoClaw" to quit'], { stdio: 'ignore' }); } catch (_) {}
  } else {
    try { execFileSync('taskkill', ['/IM', 'AutoClaw.exe', '/F', '/T'], { stdio: 'ignore', windowsHide: true }); } catch (_) {}
  }
}

async function ensureTraeWorkWithCdp() {
  if (await findCdpEndpoint()) return { started: false, reused: true };
  if (!CFG.exe) return { started: false, error: '未找到 TraeWork 安装目录' };
  log('[proc] 需要以 CDP 模式启动 TraeWork');
  if (isProcessRunning()) {
    log('[proc] 正在退出已运行的 TraeWork（需带 --remote-debugging-port 重启）');
    killTraeWork();
    // 等到进程彻底退出：旧实例的单实例锁会让新进程静默退出，导致 CDP 永远不开
    for (let i = 0; i < 10 && isProcessRunning(); i++) await sleep(1000);
    await sleep(800);
  }
  // 最多两轮拉起：进程中途退出（单实例锁残留）时自动重试一次
  for (let attempt = 1; attempt <= 2; attempt++) {
    // 每次拉起前再次确认旧实例已退出（包括上一轮拉起的失败进程）
    killTraeWork();
    for (let i = 0; i < 10 && isProcessRunning(); i++) await sleep(1000);
    await sleep(800);
    log(`[proc] 启动: ${CFG.exe} --remote-debugging-port=${CDP_PORT} (第 ${attempt} 次)`);
    if (isMac) {
      // 直接启动 .app 内真实可执行文件，参数可稳定传给 Electron 主进程。
      spawn(CFG.exe, ['--remote-debugging-port=' + CDP_PORT], { stdio: 'ignore', detached: true });
    } else {
      spawn(CFG.exe, ['--remote-debugging-port=' + CDP_PORT], { stdio: 'ignore', detached: true });
    }
    const deadline = Date.now() + CDP_STARTUP_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const port = await findCdpEndpoint().catch(() => 0);
      if (port) return { started: true, reused: false, port };
      if (!isProcessRunning()) break; // 进程退出了 → 直接重试
      await sleep(1000);
    }
    if (await findCdpEndpoint().catch(() => 0)) return { started: true, reused: false, port };
  }
  return { started: false, error: '等待 TraeWork CDP 端口超时' };
}

// ---------------- 主流程 ----------------
async function main() {
  CFG = detectPaths();
  if (!CFG.dataDir) {
    // WorkPet 还承载 WorkBuddy / CodeBuddy；没有安装或登录 TraeWork 时也必须启动本地 API。
    log('警告：未找到 TraeWork 数据目录，TraeWork 功能暂不可用（WorkBuddy / CodeBuddy 仍可使用）');
  }
  if (!CFG.exe) log('警告：未找到 TraeWork 可执行文件（仅本地 API 和其它客户端功能可用）');
  log('dataDir=' + (CFG.dataDir || '(未找到)') + ' exe=' + (CFG.exe || '(未找到)'));

  if (CFG.dataDir) {
    try {
      const auth = getAuth();
      if (auth.error) log('[auth] ' + auth.error);
      else log('[auth] user=' + auth.userId + ' scope=' + ((auth.account && auth.account.scope) || '?') + ' deviceId=' + auth.deviceId);
    } catch (e) {
      log('[auth] 读取 TraeWork 登录态失败: ' + e.message);
    }
    // 每次启动自动备份当前登录账号，保证多账号列表始终包含正在用的账号
    try {
      const r = backupCurrentAccount();
      log('[accounts] 已备份当前账号 ' + r.nickname + ' (' + r.uid + ')');
    } catch (e) {
      log('[accounts] 备份当前账号失败: ' + e.message);
    }
    try {
      const extra = collectAllTraeAccounts();
      if (extra.length) log('[accounts] 跨客户端收集账号: ' + extra.join(', '));
    } catch (e) {
      log('[accounts] 跨客户端收集失败: ' + e.message);
    }
  }

  server.on('error', (e) => {
    if (e && e.code === 'EADDRINUSE') {
      log('[api] 端口 ' + UI_PORT + ' 已被占用，说明已有 Work Pet daemon 在运行，本实例退出。');
      process.exit(0);
    }
    log('[api] 本地服务启动失败: ' + e.message);
    process.exit(1);
  });
  server.listen(UI_PORT, HOST, () => log('[api] 本地 API 已启动 http://' + HOST + ':' + UI_PORT));

  // 设置项：打开 Pet 时同时启动 TraeWork（默认关闭；签到不需要 TraeWork 运行）
  const settings = loadSettings();
  if (settings.launchHostOnStart) {
    log('[proc] 设置项开启：启动时拉起 TraeWork（CDP 模式）');
    ensureTraeWorkWithCdp()
      .then((r) => { if (r.error) log('[proc] 拉起 TraeWork 失败: ' + r.error); })
      .catch((e) => log('[proc] 拉起 TraeWork 异常: ' + e.message));
  }

  // 每 30 分钟刷新一次各账号积分/签到状态（仅在 TraeWork 未运行时轮换，避免打断）；
  // 轮换时顺带把各账号最新的 Cookie 时限同步进账号库（rotateAllAccounts 内实现）。
  setInterval(() => {
    if (claimAllJob.running || isProcessRunning()) return;
    log('[credits] 定时刷新各账号积分');
    void refreshCreditsOnly().catch((e) => log('[credits] 刷新异常: ' + e.message));
  }, 30 * 60 * 1000).unref();

  // 每 5 分钟把 storage.json 里当前登录的 Cookie 时限同步进账号库（仅更新元数据，
  // 不写登录文件、不碰宿主），让「Cookie 时限」跟随宿主自动续期保持新鲜。
  setInterval(() => {
    if (claimAllJob.running || isProcessRunning()) return; // 宿主运行中不写库，防竞态覆盖
    try {
      const auth = getAuth();
      if (auth.error) return;
      const meta = accountMetaFromInfo(auth.info);
      if (!meta.uid) return;
      const store = loadStore();
      const idx = store.traework.accounts.findIndex((x) => String(x.uid) === String(meta.uid));
      if (idx < 0) return; // 只更新已备份账号，不新增
      const prev = store.traework.accounts[idx];
      const changed = prev.expiredAt !== meta.expiredAt || prev.refreshExpiredAt !== meta.refreshExpiredAt
        || (prev.nickname || '') !== meta.nickname || (prev.mobile || '') !== meta.mobile;
      if (changed) {
        store.traework.accounts[idx] = Object.assign({}, prev, meta);
        saveStore(store);
        log('[accounts] Cookie 时限已同步 ' + (meta.nickname || meta.uid) + ' -> ' + (meta.expiredAt || '(无)'));
      }
    } catch (_) {}
  }, 5 * 60 * 1000).unref();

  // AutoClaw：每 5 分钟把 auth.json 里最新的 JWT exp（Cookie 时限）同步进账号库 ac 段；
  // token 快过期（<2h）时自动 refresh 并回写 auth.json，时限跟随签到/刷新即时续期。
  // 解密走异步 acReadAuthAsync（key 缓存 + 12s 硬超时树杀），不阻塞事件循环。
  setInterval(() => {
    if (claimAllJob.running || clientClaimGlobalLock) return;
    (async () => {
      try {
        const a = await acReadAuthAsync();
        if (!a || a.error || !a.token) return;
        acSyncStore(a);
        const exp = a.jwtExp || acJwtExpMs(a.token);
        if (exp != null && exp - Date.now() < 2 * 3600 * 1000 && a.refreshToken) {
          log('[client:ac] token 快过期，自动 refresh');
          acRefreshToken()
            .then(async (r) => {
              const newExp = acJwtExpMs(r.accessToken);
              await acPersistRefreshedToken(r.accessToken, r.refreshToken);
              acSyncStoreAfterRefresh(r.accessToken, r.refreshToken, newExp);
              log('[client:ac] refresh 完成，新时限 -> ' + (newExp ? new Date(newExp).toISOString() : '(无)'));
            })
            .catch((e) => log('[client:ac] 自动 refresh 失败: ' + e.message));
        }
      } catch (_) {}
    })();
  }, 5 * 60 * 1000).unref();

  // AutoClaw：仅按设置 acLaunchOnStart 拉起（默认关闭，与 Trae 一致）；签到走「临时拉起→签完即关」，
  // 不再启动时常驻，避免 AutoClaw 一直占用资源。macOS 读登录态依赖 AutoClaw 运行时（CDP），
  // 若未运行则账号显示「暂无登录态」。
  if (settings.acLaunchOnStart) {
    log('[proc] 设置项开启：启动时拉起 AutoClaw（供账号显示）');
    acLaunchBinary()
      .then((how) => log('[proc] AutoClaw 拉起结果: ' + how))
      .catch((e) => log('[proc] 拉起 AutoClaw 异常: ' + e.message));
  }

  // 设置项：打开 Pet 时同时启动 CodeArts Agent（默认关闭）
  if (settings.caLaunchOnStart) {
    log('[proc] 设置项开启：启动时拉起 CodeArts Agent');
    try {
      if (caIsIdeRunning()) log('[proc] CodeArts Agent 已在运行，跳过拉起');
      else if (caLaunchIde()) log('[proc] 已拉起 CodeArts Agent');
      else log('[proc] 未找到 CodeArts Agent 可执行文件，跳过拉起');
    } catch (e) {
      log('[proc] 拉起 CodeArts Agent 异常: ' + e.message);
    }
  }

  // 桌面版：宠物/面板由 Rust 桌面客户端承载，不再向 TraeWork 注入 JS。
  // 仅保留 TraeWork 进程管理（账号切换时重启以生效），避免开机自动拉起。
  log('[proc] 桌面版模式：跳过 JS 注入（宠物面板由 Rust 客户端显示）');
}

main().catch((e) => { log('[fatal] ' + e.stack || e.message); process.exit(1); });
