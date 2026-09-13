import { useCallback, useEffect, useRef, useState } from "react";
import { Loader2, RefreshCw } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import SharedAccountCard, { toExpireSec } from "@/components/AccountCardShared";
import type { ClientAccount, ClientCredits, WbTokenUsage } from "@/types";
import { fmtCredits, fmtTokens, clientTokenUsage, openExternal, clientAccounts, clientAccountsClaim, clientCredits, clientDelete, clientStatus, clientSwitch, type ClientKind } from "@/api";

// 支持 Token 用量统计的客户端（本机会话日志扫描，daemon 60s 缓存）
const TOKEN_USAGE_KINDS = new Set<ClientKind>(["wb", "cb", "ac"]);

/// 签到徽标：兼容对象/字符串两种形态
function checkinBadge(a: ClientAccount): { text: string; tone: "success" | "warning" | "muted" } | null {
  const c = a.checkin;
  if (!c) return null;
  if (typeof c === "string") {
    if (/签到中|进行中/.test(c)) return { text: "签到中", tone: "warning" };
    if (/失败|未/.test(c)) return { text: "未签", tone: "muted" };
    if (/签|已/.test(c)) return { text: "已签", tone: "success" };
    return null;
  }
  if (c.ok === true) return { text: "已签", tone: "success" };
  if (c.ok === false) return { text: "未签", tone: "muted" };
  return null;
}

export default function WorkBuddyTab({
  showPhone,
  kind = "wb",
  label = "WorkBuddy",
  onLaunch,
  onLaunchCli,
  refreshTick = 0,
  active = false,
}: {
  showPhone: boolean;
  kind?: ClientKind;
  label?: string;
  onLaunch?: (force?: boolean) => Promise<string | void> | string | void;
  onLaunchCli?: () => Promise<void> | void;
  refreshTick?: number;
  /// 当前 Tab 是否被选中：切到时静默刷新积分（不清空页面、不显示加载态）
  active?: boolean;
}) {
  const [accounts, setAccounts] = useState<ClientAccount[] | null>(null);
  const [currentUid, setCurrentUid] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [credits, setCredits] = useState<Record<string, ClientCredits | "loading" | "error">>({});
  const [busyUid, setBusyUid] = useState<string | null>(null);
  const [batchRunning, setBatchRunning] = useState(false);
  const [switchedMsg, setSwitchedMsg] = useState<string | null>(null);
  const [armed, setArmed] = useState<Record<string, boolean>>({});
  const [launchMsg, setLaunchMsg] = useState<string | null>(null);
  const [restartArmed, setRestartArmed] = useState(false);
  // Token 用量统计（仅 WorkBuddy 有数据）
  const [usage, setUsage] = useState<WbTokenUsage | null>(null);
  const accountsRef = useRef<ClientAccount[] | null>(null);
  // 积分缓存镜像（ref 便于轮询时判断哪些 uid 还没加载/失败需重试）
  const creditsRef = useRef<Record<string, ClientCredits | "loading" | "error">>({});
  const setOneCredit = useCallback((uid: string, v: ClientCredits | "loading" | "error") => {
    creditsRef.current = { ...creditsRef.current, [uid]: v };
    setCredits(creditsRef.current);
  }, []);
  // 每账号积分懒加载（串行，避免瞬时请求过密）；失败保留 error 位 → 轮询自动重试
  const loadCredits = useCallback(async (list: ClientAccount[]) => {
    for (const a of list) {
      const cur = creditsRef.current[a.uid];
      if (cur !== undefined && cur !== "error") continue;
      if (cur === undefined) setOneCredit(a.uid, "loading");
      try {
        setOneCredit(a.uid, await clientCredits(kind, a.uid));
      } catch {
        setOneCredit(a.uid, "error");
      }
    }
  }, [kind, setOneCredit]);

  const load = useCallback(async (withClaim: boolean) => {
    try {
      const v = await (withClaim ? clientAccountsClaim(kind) : clientAccounts(kind));
      setAccounts(v.accounts);
      setCurrentUid(v.currentUid ?? null);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, []);

  useEffect(() => {
    accountsRef.current = accounts;
  }, [accounts]);

  // 手动刷新（⚡ 刷新数据）：清空积分缓存并重拉账号
  useEffect(() => {
    if (refreshTick > 0) {
      creditsRef.current = {};
      setCredits({});
      void load(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshTick]);

  const runLaunch = async (force = false) => {
    if (!onLaunch) return;
    try {
      const res = await onLaunch(force);
      if (res === "AC_REUSED") {
        setLaunchMsg("已复用 AutoClaw 调试实例（CDP 已就绪）。");
      } else if (res === "AC_LAUNCHED") {
        setLaunchMsg(force ? "已重启 AutoClaw（CDP 调试模式）。" : "已以 CDP 调试模式启动 AutoClaw。");
      } else {
        setLaunchMsg(null);
      }
      setRestartArmed(false);
      await load(true);
    } catch (e) {
      const msg = String(e);
      if (msg.includes("CB_RUNNING_NO_CDP")) {
        setRestartArmed(true);
        setLaunchMsg("CodeBuddy 正在运行（未开调试端口）。再点一次「确认重启」将关闭它并以注入模式重启。");
      } else if (msg.includes("AC_RUNNING_NO_CDP")) {
        setRestartArmed(true);
        setLaunchMsg("AutoClaw 正在运行（未开调试端口）。再点一次「确认重启」将关闭它并以注入模式重启。");
      } else {
        setLaunchMsg(msg);
      }
    }
  };

  const runLaunchCli = async () => {
    if (!onLaunchCli) return;
    try {
      await onLaunchCli();
      setLaunchMsg(null);
    } catch (e) {
      setLaunchMsg(String(e));
    }
  };

  // 批量签到进行中时每 3 秒跟进（签到完成后立刻刷新账号状态），
  // 空闲时每 2 分钟静默轮询。启动时先立即执行一次，避免长时间显示 0/3。
  useEffect(() => {
    let stop = false;
    const tick = async () => {
      if (stop) return;
      try {
        const st = await clientStatus(kind);
        const running = !!st.batch?.running;
        setBatchRunning(running);
        // 批量进行中、或签到状态还没拿到（批量期间接口返回 null）时，立即刷新
        const missing = accountsRef.current?.some((a) => a.checkin == null);
        if (running || missing) await load(false);
        // 积分加载失败/缺失的账号自动重试（daemon 瞬时不可用后自愈，无需手动刷新）
        if (accountsRef.current) void loadCredits(accountsRef.current);
      } catch {
        // daemon 可能刚被 ensure 拉起：静默重读一次，成功即自动恢复显示
        // （/api/client/:id/accounts 本身会触发自动签到，带每日缓存幂等）
        try { await load(false); } catch {}
      }
    };
    void tick();
    const fast = window.setInterval(() => void tick(), 3_000);
    return () => {
      stop = true;
      window.clearInterval(fast);
    };
  }, [load]);

  // 首次打开即触发全量自动签到（每日缓存幂等），空闲期轮询跟进
  useEffect(() => {
    void load(true);
    const t = window.setInterval(() => void load(false), 120_000);
    return () => window.clearInterval(t);
  }, [load]);

  // Token 用量统计（WorkBuddy / CodeBuddy / AutoClaw）：daemon 扫描本机会话日志（60s 缓存），失败静默不影响主流程
  const loadUsage = useCallback(async () => {
    if (!TOKEN_USAGE_KINDS.has(kind)) return;
    try {
      setUsage(await clientTokenUsage(kind));
    } catch {
      // 用量统计失败静默：下个周期自动重试
    }
  }, [kind]);

  // 本 Tab 可见时拉取并每 60s 刷新（与 daemon 缓存周期对齐）；不可见时不请求
  useEffect(() => {
    if (!active) return;
    void loadUsage();
    const t = window.setInterval(() => void loadUsage(), 60_000);
    return () => window.clearInterval(t);
  }, [active, loadUsage]);

  // 手动刷新（⚡）时立即更新用量
  useEffect(() => {
    if (refreshTick > 0 && TOKEN_USAGE_KINDS.has(kind)) void loadUsage();
  }, [refreshTick, loadUsage]);

  // 每账号积分懒加载（串行，避免瞬时请求过密）
  const accountsKey = accounts?.map((a) => a.uid).join(",") ?? "";
  useEffect(() => {
    if (!accounts) return;
    void loadCredits(accounts);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accountsKey]);

  // 切到本 Tab 时静默刷新积分：不重新拉账号列表、不显示加载态，旧积分先保持显示，新的到了直接替换
  useEffect(() => {
    if (active && accountsRef.current) void loadCredits(accountsRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active]);

  const doDelete = async (uid: string) => {
    const key = `del:${uid}`;
    if (!armed[key]) {
      setArmed((p) => ({ ...p, [key]: true }));
      window.setTimeout(
        () =>
          setArmed((p) => {
            const n = { ...p };
            delete n[key];
            return n;
          }),
        2000
      );
      return;
    }
    setArmed((p) => {
      const n = { ...p };
      delete n[key];
      return n;
    });
    try {
      await clientDelete(kind, uid);
      const after = { ...creditsRef.current };
      delete after[uid];
      creditsRef.current = after;
      setCredits(after);
      await load(false);
    } catch {
      setSwitchedMsg("删除失败，当前登录账号不能删除");
    }
  };

  const doSwitch = async (uid: string, isCurrent: boolean) => {
    // 单击即生效：
    //  - 点其他账号 → 立即切换登录态（不自动拉客户端）
    //  - 点当前账号 → 启动客户端（再点一次刚切换的账号按钮即可启动）
    setBusyUid(uid);
    setSwitchedMsg(null);
    try {
      if (isCurrent) {
        if (onLaunch) {
          setSwitchedMsg(`正在用当前账号重启 ${label}…`);
          try {
            await onLaunch(true);
            setSwitchedMsg(`${label} 已用当前账号重启，新登录已生效`);
          } catch (e) {
            setSwitchedMsg(`启动 ${label} 失败：${String(e).slice(0, 80)}`);
          }
        } else {
          setSwitchedMsg("后台服务未运行，无法启动客户端");
        }
      } else {
        await clientSwitch(kind, uid);
        const st = await clientStatus(kind).catch(() => null);
        const cdpUp = !!(st && (st as { cdp?: { connected?: boolean } }).cdp?.connected);
        if (cdpUp) {
          setSwitchedMsg(`已切换到该账号，窗口已刷新生效；再点一次其按钮可启动 ${label}`);
        } else {
          setSwitchedMsg(`已切换到该账号；再点一次其按钮即可启动 ${label}`);
        }
        await load(false);
      }
    } catch {
      setSwitchedMsg("切换失败，请确认 Work Pet 后台服务正常");
    } finally {
      setBusyUid(null);
    }
  };

  if (error && !accounts) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-6 text-center">
        <p className="text-xs text-muted-foreground">
          {"后台服务未运行。请重启 Work Pet。"}
        </p>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={() => void load(true)}>
            <RefreshCw className="h-3 w-3" /> 重试
          </Button>
          {onLaunch && (
            <Button
              variant={restartArmed ? "destructive" : "default"}
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => void runLaunch(restartArmed)}
            >
              {restartArmed ? "确认重启 CodeBuddy" : `启动 ${label}（CDP 注入）`}
            </Button>
          )}
          {onLaunchCli && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => void runLaunchCli()}
            >
              启动 CLI
            </Button>
          )}
        </div>
        {launchMsg && <p className="px-1 text-[10px] text-muted-foreground">{launchMsg}</p>}
      </div>
    );
  }

  if (!accounts) {
    return (
      <div className="flex items-center gap-2 px-1 py-2 text-xs text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" /> 读取 {label} 账号…
      </div>
    );
  }

  const totalCredits = accounts.reduce((s, a) => {
    const c = credits[a.uid];
    return s + (typeof c === "object" ? c.credits : 0);
  }, 0);
  const signedCount = accounts.filter((a) => checkinBadge(a)?.tone === "success").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-2">
      {/* 统计行 */}
      <div className="flex items-center gap-3 rounded-lg bg-muted/60 px-3 py-2 text-xs">
        <span className="text-muted-foreground">
          账号数 <span className="font-semibold text-foreground">{accounts.length}</span>
        </span>
        <span className="h-3 w-px bg-border" />
        {batchRunning ? (
          <Badge className="h-5 rounded-full border-0 bg-warning px-2 text-[10px] text-white">
            <Loader2 className="mr-0.5 h-3 w-3 animate-spin" /> 签到中…
          </Badge>
        ) : (
          <span className="text-muted-foreground">
            已签 <span className="font-semibold text-foreground">{signedCount}</span>/{accounts.length}
          </span>
        )}
        <span className="h-3 w-px bg-border" />
        <span className="text-muted-foreground">
          总积分 <span className="font-semibold text-foreground">{fmtCredits(totalCredits)}</span>
        </span>
        <span className="ml-auto" />
        {onLaunchCli && (
          <Button
            variant="ghost"
            size="sm"
            className="h-6 rounded-full px-2.5 text-[10px] text-muted-foreground hover:text-foreground"
            onClick={() => void runLaunchCli()}
          >
            启动 CLI
          </Button>
        )}
      </div>

      {/* Token 用量行（WorkBuddy / CodeBuddy / AutoClaw；本机会话日志统计，不上传） */}
      {TOKEN_USAGE_KINDS.has(kind) && usage && (
        <div
          className="flex items-center gap-3 rounded-lg bg-muted/40 px-3 py-1.5 text-[11px]"
          title={`今日 ${usage.today.requests} 次请求 · 输入 ${fmtTokens(usage.today.input)}（含缓存命中 ${fmtTokens(usage.today.cached)}）· 输出 ${fmtTokens(usage.today.output)}`}
        >
          <span className="text-muted-foreground">
            Token 今日 <span className="font-semibold text-foreground">{fmtTokens(usage.today.total)}</span>
          </span>
          <span className="h-3 w-px bg-border" />
          <span className="text-muted-foreground">
            7日 <span className="font-semibold text-foreground">{fmtTokens(usage.days7.total)}</span>
          </span>
          <span className="h-3 w-px bg-border" />
          <span className="text-muted-foreground">
            累计 <span className="font-semibold text-foreground">{fmtTokens(usage.all.total)}</span>
            <span className="text-muted-foreground/70"> · {usage.allSessions} 会话</span>
          </span>
        </div>
      )}

      {accounts.length === 0 ? (
        <div className="flex flex-col items-start gap-2 px-1">
          <p className="text-[11px] text-muted-foreground">
            暂无 {label} 账号。启动 {label}（CDP 注入）后登录，账号会自动备份到这里。
          </p>
          {onLaunch && (
            <Button
              variant={restartArmed ? "destructive" : "outline"}
              size="sm"
              className="h-7 rounded-full px-3 text-xs"
              onClick={() => void runLaunch(restartArmed)}
            >
              {restartArmed ? "确认重启 CodeBuddy" : `启动 ${label}（CDP 注入）`}
            </Button>
          )}
          {onLaunchCli && (
            <Button variant="outline" size="sm" className="h-7 rounded-full px-3 text-xs" onClick={() => void runLaunchCli()}>
              启动 CLI
            </Button>
          )}
          {launchMsg && <p className="px-1 text-[10px] text-muted-foreground">{launchMsg}</p>}
        </div>
      ) : (
        <ScrollArea className="min-h-0 flex-1">
          <div className="flex flex-col gap-2 pr-2">
            {accounts.map((a) => {
              const c = credits[a.uid];
              const badge = checkinBadge(a);
              const isCurrent = currentUid === a.uid;
              const segs = typeof c === "object" ? c.segments : [];
              return (
                <SharedAccountCard
                  key={a.uid}
                  name={a.nickname || "(未命名)"}
                  phone={a.phone}
                  showFullPhone={showPhone}
                  cookieExpireSec={toExpireSec(a.tokenExpiresAt ?? null)}
                  isCurrent={isCurrent}
                  badge={badge}
                  signing={badge?.tone !== "success" && batchRunning}
                  credits={typeof c === "object" ? c.credits : null}
                  packs={segs.map((s) => ({
                    name: s.source || "积分包",
                    limit: s.total,
                    remaining: s.remaining,
                    expire_sec: Math.round(s.expiresAt / 1000),
                  }))}
                  barColor="bg-sky-400"
                  profileLabel={kind === "wb" ? "成长中心" : undefined}
                  onOpenProfile={
                    kind === "wb"
                      ? () => void openExternal("https://www.workbuddy.cn/profile/growth-center").catch(() => {})
                      : undefined
                  }
                  switchArmed={false}
                  launchLabel={label}
                  switchBusy={busyUid === a.uid}
                  onSwitch={() => void doSwitch(a.uid, isCurrent)}
                  deleteArmed={!!armed[`del:${a.uid}`]}
                  onDelete={() => void doDelete(a.uid)}
                />
              );
            })}
          </div>
        </ScrollArea>
      )}

      {switchedMsg && (
        <p className="px-1 text-center text-[10px] text-muted-foreground">{switchedMsg}</p>
      )}
    </div>
  );
}
