import { useState } from "react";
import { ArrowLeftRight, ChevronDown, ExternalLink, Loader2, Trash2, Zap } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ExpiryBar, fmtMonthDay, nextExpiry } from "@/components/PackBar";
import { fmtCredits } from "@/api";
import { cn } from "@/lib/utils";

/// 手机号打码：前 3 位 + 星号 + 后 4 位
export function maskPhone(phone?: string): string {
  const p = phone || "-";
  if (p.length <= 7) return p;
  return p.slice(0, 3) + "*".repeat(p.length - 7) + p.slice(-4);
}

function displayPhone(phone: string | undefined, full?: boolean): string {
  const src = phone || "-";
  return full ? src : maskPhone(src);
}

export interface DetailItem {
  name: string;
  remaining: number;
  limit: number;
  expire_sec: number;
}

export interface SharedCardProps {
  name: string;
  phone?: string;
  /// 显示完整手机号（false=打码：前3位+星号+后4位；TraeWork 源数据仅有打码号）
  showFullPhone?: boolean;
  /// Cookie/登录态有效期（unix 秒）
  cookieExpireSec?: number | null;
  isCurrent: boolean;
  /// 签到徽标；null 不显示。tone: success=已签 / warning=签到中 / muted=未签
  badge?: { text: string; tone: "success" | "warning" | "muted" | "danger" } | null;
  signing?: boolean;
  /// 剩余积分合计（null 不显示数值）
  credits: number | null;
  /// 积分明细（积分条 + 下拉），同时用于最近过期计算
  packs: DetailItem[];
  barColor?: string; // TraeWork=绿 bg-success；WorkBuddy=天蓝 bg-sky-400
  /// 外链按钮（如 WorkBuddy 成长中心）：有 onOpenProfile 才显示
  profileLabel?: string;
  onOpenProfile?: () => void;
  switchArmed?: boolean;
  switchBusy?: boolean;
  launchLabel?: string;
  deleteArmed?: boolean;
  onSwitch?: () => void;
  onDelete?: () => void;
}

/// 双端共用的账号卡片：布局与文本完全一致
export default function SharedAccountCard(p: SharedCardProps) {
  const [expanded, setExpanded] = useState(false);
  const expiry = nextExpiry(p.packs);
  // Cookie 时限：已过期（早于当前时刻）→ 红色提示重新登录；未过期显示到期日
  const cookieSec = p.cookieExpireSec != null && p.cookieExpireSec > 0 ? p.cookieExpireSec : null;
  const cookieExpired = cookieSec != null && cookieSec * 1000 <= Date.now();
  const cookieTag =
    cookieSec == null ? null : cookieExpired ? (
      <span
        className="ml-auto shrink-0 rounded-md bg-destructive/10 px-1.5 py-0.5 font-medium text-destructive"
        title={`Cookie 已于 ${fmtDateSec(cookieSec)} 过期，请在客户端重新登录`}
      >
        登录已过期 · 请重新登录
      </span>
    ) : (
      <span className="ml-auto shrink-0" title={`Cookie 时限 ${fmtDateSec(cookieSec)}`}>
        Cookie 时限 {fmtShortDate(cookieSec)}
      </span>
    );

  return (
    <div className={cn("rounded-xl p-3", p.isCurrent ? "bg-card shadow-sm ring-1 ring-border" : "bg-muted/60")}>
      <div className="flex items-center gap-2">
        <span className="truncate text-sm font-bold">{p.name}</span>
        {p.isCurrent && (
          <Badge className="h-5 shrink-0 rounded-md bg-primary px-1.5 text-[10px] text-primary-foreground">
            当前
          </Badge>
        )}
        {p.badge?.tone === "success" ? (
          <Badge className="h-5 shrink-0 cursor-default rounded-md border-0 bg-success px-1.5 text-[10px] text-white">
            {p.badge.text}
          </Badge>
        ) : p.signing ? (
          <Badge className="h-5 shrink-0 cursor-default rounded-md border-0 bg-warning px-1.5 text-[10px] text-white">
            <Loader2 className="mr-0.5 h-3 w-3 animate-spin" /> 签到中
          </Badge>
        ) : p.badge?.tone === "warning" ? (
          <Badge className="h-5 shrink-0 cursor-default rounded-md border-0 bg-warning px-1.5 text-[10px] text-white">
            {p.badge.text}
          </Badge>
        ) : p.badge?.tone === "danger" ? (
          <Badge className="h-5 shrink-0 cursor-default rounded-md border-0 bg-destructive px-1.5 text-[10px] text-white">
            {p.badge.text}
          </Badge>
        ) : p.badge ? (
          <Badge className="h-5 shrink-0 cursor-default rounded-md border border-border bg-muted px-1.5 text-[10px] text-muted-foreground">
            {p.badge.text}
          </Badge>
        ) : null}
        <div className="ml-auto flex shrink-0 items-center gap-0.5">
          {p.onOpenProfile && (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 text-foreground/60 hover:text-foreground"
              title={`打开${p.profileLabel ?? "主页"}（浏览器）`}
              onClick={() => p.onOpenProfile?.()}
            >
              <ExternalLink className="h-3.5 w-3.5" />
            </Button>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "h-6 w-6",
              p.isCurrent
                ? "text-foreground/60 hover:text-foreground"
                : p.switchArmed
                  ? "bg-primary text-primary-foreground hover:bg-primary"
                  : "text-foreground/60 hover:text-foreground"
            )}
            title={
              p.isCurrent
                ? `启动${p.launchLabel ?? "客户端"}`
                : p.switchArmed
                  ? "再点一次确认切换"
                  : "切换到此账号"
            }
            onClick={() => p.onSwitch?.()}
          >
            {p.switchBusy ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <ArrowLeftRight className="h-3.5 w-3.5" />
            )}
          </Button>
          {p.onDelete && (
            <Button
              variant="ghost"
              size="icon"
              disabled={p.isCurrent}
              className={cn(
                "h-6 w-6",
                p.isCurrent
                  ? "cursor-default text-foreground/30"
                  : p.deleteArmed
                    ? "bg-destructive text-white hover:bg-destructive"
                    : "text-destructive"
              )}
              title={
                p.isCurrent
                  ? "当前登录账号不能删除"
                  : p.deleteArmed
                    ? "再点一次确认删除"
                    : "删除备份"
              }
              onClick={() => { if (!p.isCurrent) p.onDelete?.(); }}
            >
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
        </div>
      </div>

      {/* 手机号（恒显示；完整/打码由开关决定） + 积分数值（同行，右侧） */}
      <div className="mt-1.5 flex items-center text-[11px]">
        <span className="truncate text-muted-foreground">[{displayPhone(p.phone, p.showFullPhone)}]</span>
        {p.credits != null && (
          <span className="ml-auto flex shrink-0 items-center gap-1 font-semibold">
            <Zap className="h-3.5 w-3.5 text-success" />
            {fmtCredits(p.credits)}
          </span>
        )}
      </div>

      {/* 积分条 */}
      <div className="mt-2">
        {p.packs.length > 0 ? (
          <ExpiryBar items={p.packs} color={p.barColor ?? "bg-success"} />
        ) : (
          <div className="h-1.5 w-full rounded-full bg-border/70" />
        )}
      </div>

      {/* 积分明细下拉：最近过期摘要 + Cookie 有效期同行 */}
      {p.packs.length > 0 && (
        <>
          <button
            className="mt-1 flex w-full flex-wrap items-center gap-x-1.5 gap-y-1 text-[10px] leading-4 text-muted-foreground hover:text-foreground"
            onClick={() => setExpanded((v) => !v)}
          >
            <span className="flex shrink-0 items-center gap-1">
              积分明细（{p.packs.length} 项）
              <ChevronDown className={cn("h-3 w-3 transition-transform", expanded && "rotate-180")} />
            </span>
            {expiry && (
              <span className="shrink-0 rounded-md bg-warning/15 px-1 py-0.5 font-medium text-warning">
                最近过期 {fmtMonthDay(expiry.sec)}（{fmtCredits(expiry.amount)} 积分）
              </span>
            )}
            {cookieTag}
          </button>
          {expanded && (
            <div className="mt-1 flex flex-col gap-1 rounded-lg bg-muted/60 p-2">
              {p.packs.map((e, i) => {
                const isEarliest =
                  expiry != null && e.remaining > 0 && fmtMonthDay(e.expire_sec) === fmtMonthDay(expiry.sec);
                return (
                <div
                  key={`${e.name}-${i}`}
                  className={cn(
                    "flex items-center gap-2 rounded-md px-1.5 py-0.5 text-[10px]",
                    isEarliest && "bg-warning/15 font-medium text-warning",
                    !isEarliest && e.remaining <= 0 && "text-muted-foreground/60"
                  )}
                >
                  <span className="truncate">{e.name}</span>
                  <span
                    className={cn(
                      "ml-auto shrink-0 font-mono tabular-nums",
                      e.remaining > 0 ? "text-foreground" : "text-muted-foreground/60"
                    )}
                  >
                    {fmtCredits(e.remaining)}/{fmtCredits(e.limit)}
                  </span>
                  <span className="shrink-0 text-muted-foreground">
                    {fmtMonthDay(e.expire_sec)} 过期
                  </span>
                </div>
                );
              })}
            </div>
          )}
        </>
      )}
      {p.packs.length === 0 && cookieTag && (
        <div className="mt-1.5 flex items-center text-[10px] text-muted-foreground">{cookieTag}</div>
      )}
    </div>
  );
}

/// unix 秒 → 短日期：同年 "MM-DD"，跨年 "YY-MM-DD"（Asia/Shanghai）
export function fmtShortDate(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  const now = new Date(Date.now() + 8 * 3600);
  const pad = (n: number) => String(n).padStart(2, "0");
  const md = `${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return d.getUTCFullYear() === now.getUTCFullYear() ? md : `${String(d.getUTCFullYear()).slice(2)}-${md}`;
}

/// unix 秒 → "YYYY-MM-DD"（Asia/Shanghai）
export function fmtDateSec(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/// 各种形态的有效期 → unix 秒（ISO 字符串 / 毫秒 / 秒）
export function toExpireSec(v: string | number | null | undefined): number | null {
  if (v == null || v === "") return null;
  if (typeof v === "number") return v > 1e12 ? Math.round(v / 1000) : Math.round(v);
  const ms = Date.parse(v);
  return Number.isFinite(ms) ? Math.round(ms / 1000) : null;
}
