import { APP, draft, type DraftEvent } from '../../shared/events';
import type { SessionUsage, State, UsageWindow } from '../../shared/types';

/** Live (unthrottled) per-session usage for the UI; events are throttled (SPEC §6.10, §4.3). */
export class UsageMonitor {
  readonly live: Record<string, SessionUsage> = {};
  private lastSampleAt: Record<string, number> = {};
  private lastPlanAt = 0;

  /** Parse one statusLine JSON post. Returns events worth persisting. */
  ingest(session: string, j: Record<string, unknown>, state: State, now = Date.now(), force = false): DraftEvent[] {
    const out: DraftEvent[] = [];
    const cost = (j.cost ?? {}) as Record<string, number>;
    const cw = (j.context_window ?? {}) as Record<string, unknown>;
    const cur = cw.current_usage as Record<string, number> | null | undefined;
    const model = (j.model ?? {}) as Record<string, string>;
    const sample = {
      session,
      model: model.display_name ?? model.id,
      costUsd: num(cost.total_cost_usd),
      durationMs: num(cost.total_duration_ms),
      apiMs: num(cost.total_api_duration_ms),
      linesAdded: num(cost.total_lines_added),
      linesRemoved: num(cost.total_lines_removed),
      ctxUsedPct: cw.used_percentage === null ? null : num(cw.used_percentage as number),
      ctxSize: num(cw.context_window_size as number),
      inTok: num(cw.total_input_tokens as number),
      outTok: num(cw.total_output_tokens as number),
      cur: cur
        ? { in: num(cur.input_tokens), out: num(cur.output_tokens), cacheCreate: num(cur.cache_creation_input_tokens), cacheRead: num(cur.cache_read_input_tokens) }
        : null,
    };
    const prev = state.usage.perSession[session];
    this.live[session] = { ...sample, updatedAt: new Date(now).toISOString(), priorCostUsd: prev?.priorCostUsd, priorInTok: prev?.priorInTok, priorOutTok: prev?.priorOutTok };
    const last = this.lastSampleAt[session] ?? 0;
    const ctxDelta = Math.abs((sample.ctxUsedPct ?? 0) - (prev?.ctxUsedPct ?? 0));
    if (force || now - last >= 60_000 || ctxDelta >= 2 || !prev) {
      this.lastSampleAt[session] = now;
      out.push(draft('usage.sample', APP, sample));
    }
    const rl = j.rate_limits as Record<string, { used_percentage?: number; resets_at?: number }> | null | undefined;
    if (rl) {
      const win = (w?: { used_percentage?: number; resets_at?: number }): UsageWindow | undefined =>
        w && typeof w.used_percentage === 'number' ? { usedPct: w.used_percentage, resetsAt: w.resets_at ?? 0 } : undefined;
      const fiveHour = win(rl.five_hour);
      const sevenDay = win(rl.seven_day);
      const p = state.usage.plan;
      const changed = Math.abs((fiveHour?.usedPct ?? 0) - (p.fiveHour?.usedPct ?? 0)) >= 1 || Math.abs((sevenDay?.usedPct ?? 0) - (p.sevenDay?.usedPct ?? 0)) >= 1;
      if (changed || now - this.lastPlanAt >= 60_000) {
        this.lastPlanAt = now;
        out.push(draft('usage.plan_sample', APP, { fiveHour, sevenDay }));
      }
      out.push(...this.thresholds(state, fiveHour, sevenDay, now));
    }
    return out;
  }

  thresholds(state: State, fiveHour: UsageWindow | undefined, sevenDay: UsageWindow | undefined, now = Date.now()): DraftEvent[] {
    const cfg = state.config;
    const worst = [fiveHour && { w: 'five_hour', ...fiveHour }, sevenDay && { w: 'seven_day', ...sevenDay }]
      .filter(Boolean)
      .sort((a, b) => b!.usedPct - a!.usedPct)[0] as { w: string; usedPct: number; resetsAt: number } | undefined;
    if (!worst) return [];
    const out: DraftEvent[] = [];
    if (!state.usage.paused && worst.usedPct >= cfg.usagePausePct) {
      out.push(draft('usage.limit_hit', APP, { source: 'statusline', resetsAt: worst.resetsAt || undefined }));
    } else if (!state.usage.paused && !state.usage.warned && worst.usedPct >= cfg.usageWarnPct) {
      out.push(draft('usage.warning', APP, { pct: worst.usedPct, window: worst.w }));
    } else if (state.usage.paused && worst.usedPct < cfg.usagePausePct && (!state.usage.resumesAt || state.usage.resumesAt * 1000 <= now)) {
      out.push(draft('usage.limit_cleared', APP, {}));
    }
    return out;
  }

  /** Clear the pause when the reset time passed (no fresh statusLine needed to unblock). */
  tick(state: State, now = Date.now()): DraftEvent[] {
    if (state.usage.paused && state.usage.resumesAt && state.usage.resumesAt * 1000 <= now) {
      const f = state.usage.plan.fiveHour;
      if (!f || f.resetsAt * 1000 <= now || f.usedPct < state.config.usagePausePct) return [draft('usage.limit_cleared', APP, {})];
    }
    return [];
  }
}

function num(v: unknown): number | undefined {
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function totalCost(u: SessionUsage | undefined): number | undefined {
  if (!u || u.costUsd === undefined) return undefined;
  return u.costUsd + (u.priorCostUsd ?? 0);
}
export function totalTokens(u: SessionUsage | undefined): number | undefined {
  if (!u || (u.inTok === undefined && u.outTok === undefined)) return undefined;
  return (u.inTok ?? 0) + (u.outTok ?? 0) + (u.priorInTok ?? 0) + (u.priorOutTok ?? 0);
}
