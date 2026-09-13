#!/usr/bin/env node
/**
 * sync-release-assets.cjs —— 把指定构建（默认最新成功构建）的双平台安装包
 * 同步到指定 tag 的 Release（删除旧资产 → 上传新资产）。
 *
 * 背景：正式版 tag 发布后协作者又合并了修复 PR，需要把 release 页的两个包
 * 替换成含最新修复的构建产物，保证「源码 = 安装包」一致。
 *
 * 用法：
 *   GH_TOKEN=xxx node scripts/sync-release-assets.cjs v1.0.3 [run_id]
 *   - 第一个参数：目标 tag（必填）
 *   - 第二个参数：Actions run id（可选，默认取 main 最新 success 的 run）
 *
 * 认证：环境变量 GH_TOKEN（需要 repo 权限的 classic token 或 fine-grained
 * Actions+Contents 读写权限）。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

const REPO = 'connoryang331/workpet';
const TOKEN = process.env.GH_TOKEN;
const UA = 'workpet-release-sync';

// ---------- 参数 ----------
const TAG = process.argv[2];
if (!TAG) {
  console.error('用法: GH_TOKEN=xxx node scripts/sync-release-assets.cjs <tag> [run_id]');
  process.exit(1);
}
const RUN_ID = process.argv[3];

if (!TOKEN) {
  console.error('缺少 GH_TOKEN 环境变量');
  process.exit(1);
}

const H = { 'User-Agent': UA, Authorization: `Bearer ${TOKEN}`, Accept: 'application/vnd.github+json' };

async function api(url, opts = {}) {
  return fetch(url, { headers: { ...H, ...(opts.headers || {}) }, ...opts });
}

// 递归找文件
function findAll(dir, pred) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(e => {
    const p = path.join(dir, e.name);
    return e.isDirectory() ? findAll(p, pred) : (pred(p) ? [p] : []);
  });
}

(async () => {
  // ---------- 1. 定位构建 run ----------
  let runId = RUN_ID;
  let run;
  if (runId) {
    const r = await api(`https://api.github.com/repos/${REPO}/actions/runs/${runId}`);
    if (r.status !== 200) throw new Error(`run ${runId} 查询失败: ${r.status}`);
    run = await r.json();
  } else {
    const r = await api(`https://api.github.com/repos/${REPO}/actions/runs?branch=main&status=success&per_page=1`);
    const j = await r.json();
    if (!j.workflow_runs?.length) throw new Error('找不到 main 上成功的构建');
    run = j.workflow_runs[0];
    runId = run.id;
  }
  const sha = run.head_sha.slice(0, 7);
  console.log(`[1/5] 使用构建 run ${runId}（commit ${sha}: ${(run.head_commit?.message || '').split('\n')[0]}）`);

  // ---------- 2. 下载双平台 artifacts ----------
  const arts = await (await api(`https://api.github.com/repos/${REPO}/actions/runs/${runId}/artifacts`)).json();
  const win = arts.artifacts.find(a => a.name === 'workpet-windows');
  const mac = arts.artifacts.find(a => a.name === 'workpet-macos');
  if (!win || !mac) throw new Error(`构建缺少 artifact（windows=${!!win}, macos=${!!mac}）`);

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'workpet-rel-'));
  const files = {};
  for (const art of [win, mac]) {
    console.log(`[2/5] 下载 ${art.name} (${Math.round(art.size_in_bytes / 1048576)}MB)...`);
    const r = await api(`https://api.github.com/repos/${REPO}/actions/artifacts/${art.id}/zip`, { redirect: 'follow' });
    if (r.status !== 200) throw new Error(`下载 ${art.name} 失败: ${r.status}`);
    const zipPath = path.join(tmp, `${art.name}.zip`);
    fs.writeFileSync(zipPath, Buffer.from(await r.arrayBuffer()));
    const extractDir = path.join(tmp, art.name);
    fs.mkdirSync(extractDir, { recursive: true });
    if (process.platform === 'win32') {
      execSync(`powershell -NoProfile -Command "Expand-Archive -LiteralPath '${zipPath}' -DestinationPath '${extractDir}' -Force"`, { stdio: 'inherit' });
    } else {
      execSync(`unzip -q "${zipPath}" -d "${extractDir}"`, { stdio: 'inherit' });
    }
    const setup = findAll(extractDir, p => /-setup\.exe$/.test(p))[0];
    const dmg = findAll(extractDir, p => /\.dmg$/.test(p))[0];
    if (art === win && !setup) throw new Error('windows artifact 里没有 *-setup.exe');
    if (art === mac && !dmg) throw new Error('macos artifact 里没有 *.dmg');
    if (setup) files.setup = { path: setup, type: 'application/octet-stream' };
    if (dmg) files.dmg = { path: dmg, type: 'application/x-apple-diskimage' };
  }

  // ---------- 3. 定位 release ----------
  const relRes = await api(`https://api.github.com/repos/${REPO}/releases/tags/${TAG}`);
  if (relRes.status !== 200) throw new Error(`tag ${TAG} 没有 release: ${relRes.status}`);
  const rel = await relRes.json();
  console.log(`[3/5] 目标 release: ${rel.name} (id=${rel.id})，现有资产: ${rel.assets.map(a => a.name).join(', ') || '无'}`);

  // ---------- 4. 删除旧资产 ----------
  for (const a of rel.assets) {
    const del = await api(`https://api.github.com/repos/${REPO}/releases/assets/${a.id}`, { method: 'DELETE' });
    if (del.status !== 204) throw new Error(`删除 ${a.name} 失败: ${del.status}`);
    console.log(`[4/5] 已删除旧资产 ${a.name}`);
  }

  // ---------- 5. 上传新资产 ----------
  for (const [kind, f] of Object.entries(files)) {
    const name = path.basename(f.path);
    const buf = fs.readFileSync(f.path);
    console.log(`[5/5] 上传 ${name} (${Math.round(buf.length / 1048576)}MB)...`);
    const up = await api(
      `https://uploads.github.com/repos/${REPO}/releases/${rel.id}/assets?name=${encodeURIComponent(name)}`,
      { method: 'POST', headers: { 'Content-Type': f.type, 'Content-Length': buf.length }, body: buf }
    );
    if (up.status !== 201) throw new Error(`上传 ${name} 失败: ${up.status} ${(await up.text()).slice(0, 200)}`);
    console.log(`      OK → https://github.com/${REPO}/releases/download/${TAG}/${name}`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n完成：${TAG} 的资产已替换为 run ${runId}（${sha}）的构建产物。`);
})().catch(e => { console.error('失败:', e.message); process.exit(1); });
