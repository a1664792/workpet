//! Work Pet · Tauri 桌面端
//! Work Pet 桌面端：本地 daemon 提供三端签到、账号管理与备份能力。
//! 前端：React + shadcn/ui（透明置顶窗口）；后端：双 daemon HTTP + 托盘 + 窗口几何。

mod api;

#[cfg(target_os = "windows")]
use std::os::windows::process::CommandExt;

use serde_json::Value;
use std::path::PathBuf;
#[cfg(target_os = "windows")]
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, Window};

#[cfg(target_os = "macos")]
const LAUNCHAGENT_PLIST: &str = "com.workpet.pet.plist";

/// 面板开合对应的逻辑窗口尺寸（CSS 像素；与前端布局一致）
const WIN_W: f64 = 480.0;
const WIN_H: f64 = 900.0; // 展开高度：新字号基准(1.15x)下完整显示 WorkBuddy 3 个账号
const CARD_H: f64 = 160.0;

/// daemon 自举状态：None=进行中，Some(Ok/Err)=完成
#[derive(Default)]
struct BootstrapState(Mutex<Option<Result<(), String>>>);

// ---------------- commands ----------------

/// 转发一次 daemon HTTP 请求；阻塞调用放 spawn_blocking，不卡主线程。
#[tauri::command]
async fn daemon_call(method: String, path: String, body: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || api::do_request(&method, &path, body.as_deref()))
        .await
        .map_err(|e| format!("内部错误: {e}"))?
}

/// CodeBuddy 可执行文件定位（常见安装路径）。
#[cfg(target_os = "windows")]
fn resolve_codebuddy_exe() -> Option<PathBuf> {
    if let Ok(v) = std::env::var("WBSWITCH_WORKBUDDY_BIN") {
        let p = PathBuf::from(&v);
        if p.is_file() {
            return Some(p);
        }
    }
    let mut candidates: Vec<PathBuf> = Vec::new();
    for (env, sub) in [
        ("LOCALAPPDATA", r"Programs\CodeBuddy CN\CodeBuddy CN.exe"),
        ("ProgramFiles", r"CodeBuddy CN\CodeBuddy CN.exe"),
        ("ProgramFiles(x86)", r"CodeBuddy CN\CodeBuddy CN.exe"),
        ("LOCALAPPDATA", r"CodeBuddy\CodeBuddy.exe"),
    ] {
        if let Ok(v) = std::env::var(env) {
            candidates.push(Path::new(&v).join(sub));
        }
    }
    candidates.push(PathBuf::from(r"D:\Program Files\CodeBuddy CN\CodeBuddy CN.exe"));
    candidates.into_iter().find(|c| c.is_file())
}

/// macOS 上查找客户端应用 bundle（如有安装）。
///
/// 注意：`.app` 是 bundle **目录**，必须用 `is_dir()` 判断。
/// 早期版本这里写成了 `is_file()`，对目录恒为 `false`，于是即使应用就装在
/// `/Applications` 也会被判为「未找到」——表现为点击 WorkBuddy 时提示
/// 「未找到 WorkBuddy 应用」。`is_dir()` 在符号链接上也会跟随解析，符合预期。
#[cfg(target_os = "macos")]
fn resolve_client_exe(name: &str) -> Option<PathBuf> {
    let mut roots = vec![PathBuf::from("/Applications")];
    if let Ok(home) = std::env::var("HOME") {
        roots.push(PathBuf::from(&home).join("Applications"));
    }
    let mut tried: Vec<PathBuf> = Vec::new();
    for root in roots {
        let candidate = root.join(format!("{}.app", name));
        if candidate.is_dir() {
            return Some(candidate);
        }
        tried.push(candidate);
    }
    // 找不到时把尝试过的路径打到 stderr，便于从日志直接看出是「没装」还是「装在了别处」
    eprintln!(
        "[workpet] 未找到 {} 应用，已尝试: {}",
        name,
        tried
            .iter()
            .map(|p| p.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    );
    None
}

/// 以 CDP 模式拉起 CodeBuddy（端口 9224）。
/// 已开调试端口 → 直接返回；正在运行但没开端口 → 返回 CB_RUNNING_NO_CDP，
/// 由前端二次确认后以 force=true 优雅关闭再重启（绝不静默强杀，避免 EPIPE 弹窗）。
#[tauri::command]
#[allow(unused_variables)]
async fn launch_codebuddy(force: Option<bool>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe = resolve_codebuddy_exe().ok_or("未找到 CodeBuddy CN.exe")?;
        let cdp_ok = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:9224/json/version).StatusCode -eq 200 } catch { $false }",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("True"))
            .unwrap_or(false);
        if cdp_ok {
            return Ok(());
        }
        let running = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq CodeBuddy CN.exe", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("CodeBuddy CN.exe"))
            .unwrap_or(false);
        if running && !force.unwrap_or(false) {
            return Err("CB_RUNNING_NO_CDP".to_string());
        }
        if running {
            // 优雅关闭（不发 /F），给 Electron 存盘与收尾的时间
            let _ = std::process::Command::new("taskkill")
                .args(["/IM", "CodeBuddy CN.exe"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            std::thread::sleep(std::time::Duration::from_millis(2500));
            let still = std::process::Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq CodeBuddy CN.exe", "/FO", "CSV"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("CodeBuddy CN.exe"))
                .unwrap_or(false);
            if still {
                let _ = std::process::Command::new("taskkill")
                    .args(["/IM", "CodeBuddy CN.exe", "/F", "/T"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                std::thread::sleep(std::time::Duration::from_millis(1000));
            }
        }
        std::process::Command::new(&exe)
            .arg("--remote-debugging-port=9224")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动 CodeBuddy 失败: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    Err("仅支持 Windows".to_string())
}

/// 在新控制台窗口启动 CodeBuddy CLI（与 IDE 共用 CodeBuddyExtension 认证体系）。
#[tauri::command]
fn launch_codebuddy_cli() -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let probe = std::process::Command::new("cmd")
            .args(["/C", "where codebuddy"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        let found = probe
            .lines()
            .any(|l| {
                let t = l.trim().to_lowercase();
                t.ends_with("codebuddy.cmd") || t.ends_with("\\codebuddy") || t.ends_with("codebuddy.exe")
            });
        if !found {
            return Err("未找到 CodeBuddy CLI，请先安装：npm install -g @tencent-ai/codebuddy-code".to_string());
        }
        let home = std::env::var("USERPROFILE").unwrap_or_else(|_| ".".to_string());
        // 外层 cmd 用 CREATE_NO_WINDOW 隐藏；`start` 会另开一个可见的新控制台窗口跑 CLI
        std::process::Command::new("cmd")
            .args(["/C", "start", "CodeBuddy CLI", "cmd", "/K", "codebuddy"])
            .current_dir(&home)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动 CLI 失败: {e}"))?;
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        let probe = std::process::Command::new("sh")
            .args(["-c", "command -v codebuddy"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).to_string())
            .unwrap_or_default();
        if probe.trim().is_empty() {
            return Err("未找到 CodeBuddy CLI，请先安装：npm install -g @tencent-ai/codebuddy-code".to_string());
        }
        // macOS：在 Terminal 中打开 CLI
        std::process::Command::new("open")
            .args(["-a", "Terminal", "--args", "bash", "-c", "codebuddy; exec bash"])
            .spawn()
            .map_err(|e| format!("启动 CLI 失败: {e}"))?;
        return Ok(());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    Err("仅支持 Windows / macOS".to_string())
}

/// 以 CDP 模式拉起 AutoClaw 客户端（端口 9226）。
/// 已开 CDP 端口 → 直接返回；正在运行但没开端口 → 优雅关闭后带 CDP 重启；
/// 未安装 → 返回错误。AutoClaw 是 Electron，`--remote-debugging-port` 原生支持。
#[tauri::command]
async fn launch_autoclaw(force: Option<bool>) -> Result<String, String> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        for (env, sub) in [
            ("LOCALAPPDATA", r"Programs\AutoClaw\AutoClaw.exe"),
            ("ProgramFiles", r"AutoClaw\AutoClaw.exe"),
            ("ProgramFiles(x86)", r"AutoClaw\AutoClaw.exe"),
            ("APPDATA", r"AutoClaw\AutoClaw.exe"),
        ] {
            if let Ok(v) = std::env::var(env) {
                candidates.push(Path::new(&v).join(sub));
            }
        }
        candidates.push(PathBuf::from(r"D:\Program Files\AutoClaw\AutoClaw.exe"));
        let exe = candidates.into_iter().find(|c| c.is_file()).ok_or("未找到 AutoClaw.exe")?;

        let cdp_ok = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:9226/json/version).StatusCode -eq 200 } catch { $false }",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("True"))
            .unwrap_or(false);
        if cdp_ok {
            return Ok("AC_REUSED".into());
        }

        let running = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq AutoClaw.exe", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("AutoClaw.exe"))
            .unwrap_or(false);
        if running && !force.unwrap_or(false) {
            return Err("AC_RUNNING_NO_CDP".to_string());
        }
        if running {
            let _ = std::process::Command::new("taskkill")
                .args(["/IM", "AutoClaw.exe"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            std::thread::sleep(std::time::Duration::from_millis(2500));
            let still = std::process::Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq AutoClaw.exe", "/FO", "CSV"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("AutoClaw.exe"))
                .unwrap_or(false);
            if still {
                let _ = std::process::Command::new("taskkill")
                    .args(["/IM", "AutoClaw.exe", "/F", "/T"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                std::thread::sleep(std::time::Duration::from_millis(1000));
            }
        }
        std::process::Command::new(&exe)
            .arg("--remote-debugging-port=9226")
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动 AutoClaw 失败: {e}"))?;
        Ok("AC_LAUNCHED".into())
    }
    #[cfg(target_os = "macos")]
    {
        // CDP 调试端口是否已监听（复用现有调试实例）
        let cdp_ok = std::process::Command::new("sh")
            .args(["-c", "curl -s --max-time 2 http://127.0.0.1:9226/json/version | grep -q webSocketDebuggerUrl"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if cdp_ok {
            return Ok("AC_REUSED".into());
        }
        // AutoClaw 主进程是否在运行
        let running = std::process::Command::new("pgrep")
            .args(["-f", "AutoClaw.app/Contents/MacOS/AutoClaw"])
            .output()
            .map(|o| o.status.success())
            .unwrap_or(false);
        if running && !force.unwrap_or(false) {
            // 运行中但未开调试端口 → 前端转成「确认重启」二次点击
            return Err("AC_RUNNING_NO_CDP".into());
        }
        if running {
            // force 重启：先退出，避免单实例锁拒绝新实例
            let _ = std::process::Command::new("pkill")
                .args(["-f", "AutoClaw.app/Contents/MacOS/AutoClaw"])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(2000));
        }
        // 与 WorkBuddy 统一走 resolve_client_exe：原来硬编码 /Applications/AutoClaw.app，
        // 未安装时只会抛「启动失败」，且装在 ~/Applications 时找不到。
        let app = resolve_client_exe("AutoClaw").ok_or("未找到 AutoClaw 应用")?;
        std::process::Command::new("open")
            .args([
                "-n",
                &app.display().to_string(),
                "--args",
                "--remote-debugging-port=9226",
            ])
            .spawn()
            .map_err(|e| format!("启动 AutoClaw 失败: {e}"))?;
        return Ok("AC_LAUNCHED".into());
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    Err("仅支持 Windows / macOS".to_string())
}

/// 拉起 CodeArts Agent（华为云 CodeArts IDE 客户端）。
/// CodeArts 无需 CDP 注入：切换账号由 daemon 直接写 vscdb 后重启客户端，
/// 因此已运行且未要求 force 时直接返回，不折腾运行中的窗口。
#[tauri::command]
#[allow(unused_variables)]
async fn launch_codearts(force: Option<bool>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if let Ok(v) = std::env::var("WORKPET_CODEARTS_BIN") {
            candidates.push(PathBuf::from(v));
        }
        for (env, sub) in [
            ("ProgramFiles", r"CodeArts Agent\codearts-agent.exe"),
            ("ProgramFiles(x86)", r"CodeArts Agent\codearts-agent.exe"),
            ("LOCALAPPDATA", r"Programs\CodeArts Agent\codearts-agent.exe"),
        ] {
            if let Ok(v) = std::env::var(env) {
                candidates.push(Path::new(&v).join(sub));
            }
        }
        candidates.push(PathBuf::from(r"D:\Program Files\CodeArts Agent\codearts-agent.exe"));
        let exe = candidates.into_iter().find(|c| c.is_file()).ok_or("未找到 codearts-agent.exe")?;

        let running = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq codearts-agent.exe", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("codearts-agent.exe"))
            .unwrap_or(false);
        if running && !force.unwrap_or(false) {
            return Ok(());
        }
        if running {
            // 优雅关闭再拉起：切换账号后需重启客户端才会读到新登录态
            let _ = std::process::Command::new("taskkill")
                .args(["/IM", "codearts-agent.exe"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            std::thread::sleep(std::time::Duration::from_millis(2500));
            let still = std::process::Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq codearts-agent.exe", "/FO", "CSV"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("codearts-agent.exe"))
                .unwrap_or(false);
            if still {
                let _ = std::process::Command::new("taskkill")
                    .args(["/IM", "codearts-agent.exe", "/F", "/T"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                std::thread::sleep(std::time::Duration::from_millis(1000));
            }
        }
        std::process::Command::new(&exe)
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| format!("启动 CodeArts Agent 失败: {e}"))?;
        return Ok(());
    }
    #[cfg(not(target_os = "windows"))]
    Err("仅支持 Windows".to_string())
}

/// 查询 daemon 自举是否完成（前端启动时轮询，避免错过一次性事件）。
#[tauri::command]
fn daemon_ready(state: tauri::State<BootstrapState>) -> Option<Result<(), String>> {
    state.0.lock().unwrap().clone()
}

/// 用系统默认浏览器打开外部链接（仅允许 https）
///
/// 平台分支必须齐：macOS 上原本只有 Windows 分支，函数会直接走到末尾的 `Ok(())`
/// 而什么都不做 —— 表现为点了「成长中心」等外链毫无反应（且不报错，很难察觉）。
#[tauri::command]
fn open_external(url: String) -> Result<(), String> {
    if !url.starts_with("https://") {
        return Err("仅允许 https 链接".to_string());
    }
    #[cfg(target_os = "windows")]
    {
        std::process::Command::new("cmd")
            .args(["/C", "start", "", &url])
            .creation_flags(CREATE_NO_WINDOW)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        std::process::Command::new("open")
            .arg(&url)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 面板开合：展开=固定 WIN_H，收起=宠物卡片高度 CARD_H。
/// 宽度保留用户缩放后的值，保持窗口下缘稳定。积分明细等长内容在列表内部滚动。
#[tauri::command]
fn set_panel_open(window: Window, open: bool, hide_pet: Option<bool>) -> Result<(), String> {
    // hidePet 模式：宠物卡片不渲染，面板高度去掉卡片区域
    let target_h = if open {
        if hide_pet.unwrap_or(false) { WIN_H - CARD_H } else { WIN_H }
    } else {
        CARD_H
    };
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let new_h = (target_h * scale).round() as i32;
    if size.height == new_h as u32 {
        return Ok(());
    }
    // 下缘固定：new_y = old_bottom - new_h
    let new_y = pos.y + size.height as i32 - new_h;
    window
        .set_size(PhysicalSize::new(size.width, new_h as u32))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(pos.x, new_y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 窗口显隐（隐藏宠物模式下收起面板 → 整窗隐藏，仅留托盘）
#[tauri::command]
fn set_window_visible(window: Window, visible: bool) -> Result<(), String> {
    if visible {
        window.show().map_err(|e| e.to_string())?;
        let _ = window.set_focus();
    } else {
        window.hide().map_err(|e| e.to_string())?;
    }
    Ok(())
}

/// 面板内容自适应：按内容高度调整窗口高度（下缘固定，宽度不变）。
#[tauri::command]
fn set_panel_height(window: Window, height: f64) -> Result<(), String> {
    let scale = window.scale_factor().map_err(|e| e.to_string())?;
    let size = window.outer_size().map_err(|e| e.to_string())?;
    let pos = window.outer_position().map_err(|e| e.to_string())?;
    let clamped = height.clamp(420.0, 900.0);
    let new_h = (clamped * scale).round() as i32;
    if size.height == new_h as u32 {
        return Ok(());
    }
    let new_y = pos.y + size.height as i32 - new_h;
    window
        .set_size(PhysicalSize::new(size.width, new_h as u32))
        .map_err(|e| e.to_string())?;
    window
        .set_position(PhysicalPosition::new(pos.x, new_y))
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// 从前端发起原生窗口拖拽（宠物卡片按住移动时调用）。
#[tauri::command]
fn start_window_drag(window: Window) -> Result<(), String> {
    window.start_dragging().map_err(|e| e.to_string())
}

/// 退出应用（托盘菜单）：先终止后台 daemon，隐藏托盘图标再退出，避免任务栏残留或进程独占。
#[tauri::command]
fn quit_app(app: AppHandle) {
    api::stop_daemon();
    if let Some(tray) = app.tray_by_id("main") {
        let _ = tray.set_visible(false);
    }
    app.exit(0);
}

// ---------------- 随系统启动（HKCU Run 注册表 / LaunchAgents plist） ----------------

#[cfg(target_os = "windows")]
const RUN_KEY: &str = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
#[cfg(target_os = "windows")]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// 查询是否已启用随系统启动。
#[tauri::command]
fn is_autostart_enabled() -> Result<bool, String> {
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("reg")
            .args(["query", RUN_KEY, "/v", "WorkPet"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|e| e.to_string())?;
        Ok(String::from_utf8_lossy(&out.stdout).contains("WorkPet"))
    }
    #[cfg(target_os = "macos")]
    {
        let la_dir = match std::env::var("HOME") {
            Ok(h) => PathBuf::from(h).join("Library/LaunchAgents"),
            Err(_) => return Ok(false),
        };
        let plist = la_dir.join(LAUNCHAGENT_PLIST);
        Ok(plist.exists())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    Ok(false)
}

/// 开/关随系统启动（写入当前用户注册表 / LaunchAgents plist，不需要管理员权限）。
#[tauri::command]
fn set_autostart(enable: bool) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let exe = std::env::current_exe().map_err(|e| e.to_string())?;
        if enable {
            std::process::Command::new("reg")
                .args([
                    "add",
                    RUN_KEY,
                    "/v",
                    "WorkPet",
                    "/t",
                    "REG_SZ",
                    "/d",
                    &format!("\"{}\"", exe.display()),
                    "/f",
                ])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map_err(|e| e.to_string())?;
        } else {
            let _ = std::process::Command::new("reg")
                .args(["delete", RUN_KEY, "/v", "WorkPet", "/f"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
        }
    }
    #[cfg(target_os = "macos")]
    {
        let la_dir = match std::env::var("HOME") {
            Ok(h) => PathBuf::from(h).join("Library/LaunchAgents"),
            Err(_) => return Err("无法获取 HOME 目录".to_string()),
        };
        std::fs::create_dir_all(&la_dir).map_err(|e| e.to_string())?;
        let plist = la_dir.join(LAUNCHAGENT_PLIST);
        if enable {
            let exe = std::env::current_exe().map_err(|e| e.to_string())?;
            let plist_content = format!(
                "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
                 <!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
                 <plist version=\"1.0\">\n\
                 <dict>\n\
                 \t<key>Label</key>\n\
                 \t<string>{}</string>\n\
                 \t<key>ProgramArguments</key>\n\
                 \t<array>\n\
                 \t\t<string>{}</string>\n\
                 \t</array>\n\
                 \t<key>RunAtLoad</key>\n\
                 \t<true/>\n\
                 \t<key>KeepAlive</key>\n\
                 \t<true/>\n\
                 \t<key>StandardErrorPath</key>\n\
                 \t<string>/tmp/workpet.log</string>\n\
                 \t<key>StandardOutPath</key>\n\
                 \t<string>/tmp/workpet.log</string>\n\
                 </dict>\n\
                 </plist>",
                LAUNCHAGENT_PLIST,
                exe.display()
            );
            std::fs::write(&plist, plist_content).map_err(|e| e.to_string())?;
        } else if plist.exists() {
            std::fs::remove_file(&plist).map_err(|e| e.to_string())?;
        }
    }
    Ok(())
}

/// 以 CDP 模式拉起 WorkBuddy 客户端（已运行则跳过）。
#[tauri::command]
async fn launch_workbuddy(force: Option<bool>) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        let force = force.unwrap_or(false);
        if force {
            let running = std::process::Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq WorkBuddy.exe", "/FO", "CSV"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("WorkBuddy.exe"))
                .unwrap_or(false);
            if running {
                let _ = std::process::Command::new("taskkill")
                    .args(["/IM", "WorkBuddy.exe"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                std::thread::sleep(std::time::Duration::from_millis(2000));
                let still = std::process::Command::new("tasklist")
                    .args(["/FI", "IMAGENAME eq WorkBuddy.exe", "/FO", "CSV"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output()
                    .map(|o| String::from_utf8_lossy(&o.stdout).contains("WorkBuddy.exe"))
                    .unwrap_or(false);
                if still {
                    let _ = std::process::Command::new("taskkill")
                        .args(["/IM", "WorkBuddy.exe", "/F", "/T"])
                        .creation_flags(CREATE_NO_WINDOW)
                        .output();
                    std::thread::sleep(std::time::Duration::from_millis(1000));
                }
            }
            return spawn_workbuddy_with_cdp();
        }
        let cdp_ok = std::process::Command::new("powershell")
            .args([
                "-NoProfile",
                "-Command",
                "try { (Invoke-WebRequest -UseBasicParsing -TimeoutSec 2 http://127.0.0.1:9222/json/version).StatusCode -eq 200 } catch { $false }",
            ])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("True"))
            .unwrap_or(false);
        if cdp_ok {
            return Ok(());
        }
        let running = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq WorkBuddy.exe", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("WorkBuddy.exe"))
            .unwrap_or(false);
        if running {
            let _ = std::process::Command::new("taskkill")
                .args(["/IM", "WorkBuddy.exe"])
                .creation_flags(CREATE_NO_WINDOW)
                .output();
            std::thread::sleep(std::time::Duration::from_millis(2000));
            let still = std::process::Command::new("tasklist")
                .args(["/FI", "IMAGENAME eq WorkBuddy.exe", "/FO", "CSV"])
                .creation_flags(CREATE_NO_WINDOW)
                .output()
                .map(|o| String::from_utf8_lossy(&o.stdout).contains("WorkBuddy.exe"))
                .unwrap_or(false);
            if still {
                let _ = std::process::Command::new("taskkill")
                    .args(["/IM", "WorkBuddy.exe", "/F", "/T"])
                    .creation_flags(CREATE_NO_WINDOW)
                    .output();
                std::thread::sleep(std::time::Duration::from_millis(1000));
            }
        }
        spawn_workbuddy_with_cdp()
    }
    #[cfg(target_os = "macos")]
    {
        let force = force.unwrap_or(false);
        let exe = resolve_client_exe("WorkBuddy").ok_or("未找到 WorkBuddy 应用")?;
        let app_name = exe.file_stem().and_then(|s| s.to_str()).unwrap_or("WorkBuddy");
        // 检查 CDP 是否已开
        let cdp_ok = std::process::Command::new("curl")
            .args(["-s", "--connect-timeout", "2", "http://127.0.0.1:9222/json/version"])
            .output()
            .map(|o| String::from_utf8_lossy(&o.stdout).contains("200"))
            .unwrap_or(false);
        if cdp_ok {
            return Ok(());
        }
        let running = std::process::Command::new("pgrep")
            .args(["-x", "Electron"])
            .output()
            .map(|o| {
                String::from_utf8_lossy(&o.stdout).lines().any(|pid| {
                    if let Ok(args) = std::process::Command::new("ps")
                        .args(["-p", pid.trim(), "-o", "command="])
                        .output()
                    {
                        String::from_utf8_lossy(&args.stdout).contains(app_name)
                    } else { false }
                })
            })
            .unwrap_or(false);
        if force && running {
            let _ = std::process::Command::new("osascript")
                .args(["-e", &format!("quit app \"{}\"", app_name)])
                .output();
            std::thread::sleep(std::time::Duration::from_millis(2000));
        } else if running {
            return Err("CB_RUNNING_NO_CDP".to_string());
        }
        std::process::Command::new("open")
            .args(["-g", "-a", &exe.display().to_string(), "--args", "--remote-debugging-port=9222"])
            .spawn()
            .map_err(|e| format!("启动 WorkBuddy 失败: {e}"))?;
        Ok(())
    }
    #[cfg(not(any(target_os = "windows", target_os = "macos")))]
    Err("仅支持 Windows / macOS".to_string())
}

#[cfg(target_os = "windows")]
fn spawn_workbuddy_with_cdp() -> Result<(), String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(v) = std::env::var("WBSWITCH_WORKBUDDY_BIN") {
        candidates.push(std::path::PathBuf::from(v));
    }
    for (env, sub) in [
        ("LOCALAPPDATA", r"Programs\WorkBuddy\WorkBuddy.exe"),
        ("ProgramFiles", r"WorkBuddy\WorkBuddy.exe"),
        ("ProgramFiles(x86)", r"WorkBuddy\WorkBuddy.exe"),
        ("LOCALAPPDATA", r"WorkBuddy\WorkBuddy.exe"),
        ("APPDATA", r"WorkBuddy\WorkBuddy.exe"),
        ("LOCALAPPDATA", r"Programs\CodeBuddy\CodeBuddy.exe"),
    ] {
        if let Ok(v) = std::env::var(env) {
            candidates.push(Path::new(&v).join(sub));
        }
    }
    for c in candidates {
        if c.is_file() {
            std::process::Command::new(&c)
                .arg("--remote-debugging-port=9222")
                .creation_flags(CREATE_NO_WINDOW)
                .spawn()
                .map_err(|e| format!("启动 WorkBuddy 失败: {e}"))?;
            return Ok(());
        }
    }
    Err("未找到 WorkBuddy.exe".to_string())
}

// ---------------- 托盘 ----------------

fn setup_tray(app: &AppHandle) -> Result<(), String> {
    use tauri::menu::{Menu, MenuItem};
    use tauri::tray::TrayIconBuilder;

    let toggle = MenuItem::with_id(app, "toggle", "显示/隐藏宠物", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let open =
        MenuItem::with_id(app, "open", "打开签到面板", true, None::<&str>).map_err(|e| e.to_string())?;
    let claim = MenuItem::with_id(app, "claim", "全部签到", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let theme = MenuItem::with_id(app, "theme", "切换浅色/深色主题", true, None::<&str>)
        .map_err(|e| e.to_string())?;
    let quit =
        MenuItem::with_id(app, "quit", "退出", true, None::<&str>).map_err(|e| e.to_string())?;
    let menu = Menu::with_items(app, &[&toggle, &open, &claim, &theme, &quit])
        .map_err(|e| e.to_string())?;

    let icon = tauri::image::Image::from_bytes(include_bytes!("../icons/tray-robot.png"))
        .map_err(|e| e.to_string())?;
    TrayIconBuilder::with_id("main")
        .menu(&menu)
        // 左键单击不弹菜单（默认会弹），改为触发 Click 事件打开窗口；菜单仅右键出现
        .show_menu_on_left_click(false)
        .tooltip("Work Pet")
        .icon(icon)
        .on_menu_event(|app, ev| {
            let action = match ev.id().as_ref() {
                "toggle" => "toggle",
                "open" => "open-panel",
                "claim" => "claim",
                "theme" => "theme",
                "quit" => {
                    api::stop_daemon();
                    if let Some(tray) = app.tray_by_id("main") {
                        let _ = tray.set_visible(false);
                    }
                    app.exit(0);
                    return;
                }
                _ => return,
            };
            let _ = app.emit("tray-event", action);
        })
        .on_tray_icon_event(|tray, ev| {
            // 左键单击 → 整窗显隐开关（开着隐藏 / 隐藏时打开）
            if let tauri::tray::TrayIconEvent::Click {
                button: tauri::tray::MouseButton::Left,
                button_state: tauri::tray::MouseButtonState::Up,
                ..
            } = ev
            {
                let _ = tray.app_handle().emit("tray-event", "toggle");
            }
        })
        .build(app)
        .map_err(|e| e.to_string())?;
    Ok(())
}

// ---------------- 入口 ----------------

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // 单实例保护：已有 work-pet 在运行则直接退出
    #[cfg(target_os = "windows")]
    {
        if let Ok(out) = std::process::Command::new("tasklist")
            .args(["/FI", "IMAGENAME eq workpet.exe", "/FO", "CSV"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
        {
            if String::from_utf8_lossy(&out.stdout).matches("workpet.exe").count() > 1 {
                eprintln!("[single-instance] 已有实例在运行，退出");
                std::process::exit(0);
            }
        }
    }
    #[cfg(target_os = "macos")]
    {
        let lock_path = std::env::temp_dir().join("work-pet.lock");
        if lock_path.exists() {
            if let Ok(contents) = std::fs::read_to_string(&lock_path) {
                let other_pid: u32 = contents.trim().parse().unwrap_or(0);
                if other_pid != 0 {
                    if std::process::Command::new("kill")
                        .args(["-0", &other_pid.to_string()])
                        .output()
                        .map(|o| o.status.success())
                        .unwrap_or(false)
                    {
                        eprintln!("[single-instance] 已有实例在运行，退出");
                        std::process::exit(0);
                    }
                }
            }
        }
        let _ = std::fs::write(&lock_path, std::process::id().to_string());
    }

    let app = tauri::Builder::default()
        .manage(BootstrapState::default())
        .setup(|app| {
            let handle = app.handle().clone();

            // 主窗口初始定位：右下角（与旧版一致）
            if let Some(win) = handle.get_webview_window("pet") {
                let scale = win.scale_factor().unwrap_or(1.0);
                if let Some(monitor) = win.current_monitor().ok().flatten() {
                    let ms = monitor.size();
                    let x = ms.width as f64 / scale - WIN_W - 40.0;
                    let y = ms.height as f64 / scale - WIN_H - 60.0;
                    let _ = win.set_position(tauri::LogicalPosition::new(x.max(0.0), y.max(0.0)));
                }
            }

            // 后台自举 daemon：确保 127.0.0.1:47919 在跑；不在则拉起 node daemon.js（常驻）
            let boot_handle = handle.clone();
            std::thread::Builder::new()
                .name("bootstrap".into())
                .spawn(move || {
                    let result = api::ensure_daemon();
                    {
                        let state = boot_handle.state::<BootstrapState>();
                        let mut st = state.0.lock().unwrap();
                        *st = Some(result);
                    }
                    let _ = boot_handle.emit("daemon-ready", ());
                })
                .expect("spawn bootstrap");

            // 托盘；失败仅无托盘，不影响主体
            if let Err(e) = setup_tray(&handle) {
                eprintln!("[tray] {e}");
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            daemon_call,
            is_autostart_enabled,
            set_autostart,
            launch_workbuddy,
            launch_codebuddy,
            launch_codebuddy_cli,
            launch_autoclaw,
            launch_codearts,
            daemon_ready,
            set_panel_open,
            set_window_visible,
            set_panel_height,
            start_window_drag,
            quit_app,
            open_external
        ])
        .build(tauri::generate_context!())
        .expect("failed to build WorkPet");

    // macOS：点击 dock 图标（reopen）时恢复隐藏的宠物窗口
    // 注意：Reopen 变体仅存在于 macOS，其他平台用 cfg 跳过以避免编译错误
    app.run(|app_handle, event| {
        #[cfg(target_os = "macos")]
        if let tauri::RunEvent::Reopen { .. } = event {
            if let Some(win) = app_handle.get_webview_window("pet") {
                let _ = win.show();
                let _ = win.set_focus();
                // 通知前端：保持面板展开（否则 hidePet 的 effect 会再次隐藏窗口）
                let _ = app_handle.emit("tray-event", "open-panel");
            }
        }
        #[cfg(not(target_os = "macos"))]
        let _ = event;
    });
}
