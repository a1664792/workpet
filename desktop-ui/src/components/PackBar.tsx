import { Zap } from "lucide-react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { Entitlement } from "@/types";
import { fmtCredits } from "@/api";
import { cn } from "@/lib/utils";

/// Asia/Shanghai 日界（unix 秒 → 天序号）
const dayIndex = (sec: number) => Math.floor((sec + 8 * 3600) / 86400);

/// 剩余天数（向上取整）
export function packDaysLeft(expireSec: number): number {
  if (expireSec <= 0) return 0;
  return Math.max(0, Math.ceil((expireSec * 1000 - Date.now()) / 86_400_000));
}

/// "9/7" 形式的月/日
export function fmtMonthDay(sec: number): string {
  const d = new Date((sec + 8 * 3600) * 1000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}`;
}

export interface ExpiryItem {
  remaining: number;
  expire_sec: number;
}

/// 最近一次积分过期：返回最早到期的日期与该日过期的积分总额
export function nextExpiry(items: ExpiryItem[]): { sec: number; amount: number } | null {
  const groups = groupByExpiry(items);
  if (groups.length === 0) return null;
  const first = groups[0];
  return { sec: first.expire_sec, amount: first.remaining };
}

/// 按到期日期归类：同一天到期的积分合并为一段，按日期升序
function groupByExpiry(items: ExpiryItem[]): { expire_sec: number; remaining: number }[] {
  const valid = items.filter((e) => e.remaining > 0 && e.expire_sec > 0);
  const map = new Map<number, { expire_sec: number; remaining: number }>();
  for (const e of valid) {
    const d = dayIndex(e.expire_sec);
    const g = map.get(d);
    if (g) {
      g.remaining += e.remaining;
      g.expire_sec = Math.max(g.expire_sec, e.expire_sec);
    } else {
      map.set(d, { expire_sec: e.expire_sec, remaining: e.remaining });
    }
  }
  return [...map.values()].sort((a, b) => a.expire_sec - b.expire_sec);
}

/// 积分条：按到期时间归类分段，段长度与该段积分数量成正比
/// （1500 积分的段远长于 100 积分的段），hover 显示 「9/7 到期 · 1500 积分（剩余 N 天）」。
export function ExpiryBar({ items, color = "bg-success" }: { items: ExpiryItem[]; color?: string }) {
  const groups = groupByExpiry(items);
  if (groups.length === 0) return null;
  const total = groups.reduce((s, g) => s + g.remaining, 0);
  const TOTAL_DOTS = 40;
  const dots = groups.map((g) => Math.max(1, Math.round((g.remaining / total) * TOTAL_DOTS)));
  const drift = TOTAL_DOTS - dots.reduce((s, n) => s + n, 0);
  if (drift !== 0) {
    const biggest = dots.indexOf(Math.max(...dots));
    dots[biggest] = Math.max(1, dots[biggest] + drift);
  }
  return (
    <TooltipProvider delayDuration={120}>
      <div className="flex h-1.5 w-full items-stretch gap-[3px]">
        {groups.map((g, i) => {
          const days = packDaysLeft(g.expire_sec);
          return (
            <Tooltip key={i}>
              <TooltipTrigger asChild>
                <div
                  style={{ width: `${(dots[i] / TOTAL_DOTS) * 100}%` }}
                  className={cn("h-full min-w-[4px] cursor-default rounded-full transition-opacity hover:opacity-75", color)}
                />
              </TooltipTrigger>
              <TooltipContent side="bottom" className="rounded-lg px-3 py-2 text-left">
                <p className="text-[11px] font-semibold">{fmtMonthDay(g.expire_sec)} 到期</p>
                <p className="text-[11px]">{fmtCredits(g.remaining)} 积分</p>
                {days > 0 && <p className="text-[11px]">剩余 {days} 天</p>}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

/// TraeWork 权益包积分条（按到期时间归类）
export function PackBar({ packs }: { packs: Entitlement[] }) {
  return <ExpiryBar items={packs} />;
}

/// WorkBuddy/CodeBuddy 积分分段积分条（按到期时间归类）
export function ClientSegmentBar({
  segments,
}: {
  segments: { remaining: number; total: number; expiresAt: number; source: string }[];
}) {
  const items: ExpiryItem[] = segments.map((s) => ({
    remaining: s.remaining,
    expire_sec: Math.round(s.expiresAt / 1000),
  }));
  return <ExpiryBar items={items} color="bg-primary" />;
}

export function CreditsValue({ value, className }: { value: number; className?: string }) {
  return (
    <span className={cn("flex shrink-0 items-center gap-1 font-semibold", className)}>
      <Zap className="h-3.5 w-3.5 text-success" />
      {fmtCredits(value)}
    </span>
  );
}
