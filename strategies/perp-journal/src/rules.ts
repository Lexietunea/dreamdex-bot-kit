// Rule set format + pre-trade safety checks. Pure functions, no network.
// Reason codes match the Reason enum order in DecisionJournal.sol.

export type ReasonName =
  | "MAX_LEVERAGE" | "MAX_SIZE" | "MAX_OPEN_POSITIONS" | "COOLDOWN"
  | "MAX_SPREAD" | "RISK_PER_TRADE" | "DAILY_LOSS" | "STALE_DATA" | "OTHER";

export const REASON_CODE: Record<ReasonName, number> = {
  MAX_LEVERAGE: 1, MAX_SIZE: 2, MAX_OPEN_POSITIONS: 3, COOLDOWN: 4,
  MAX_SPREAD: 5, RISK_PER_TRADE: 6, DAILY_LOSS: 7, STALE_DATA: 8, OTHER: 9,
};

export interface RuleSet {
  market: string;                 // e.g. "ETH-PERP"
  side: "long" | "short";
  entry: { type: "breakout" | "meanReversion" | "manual"; timeframe: string; lookback: number };
  sizing: { riskPctPerTrade: number; maxLeverage: number; maxPositionUsd: number };
  exits: { stopLossPct: number; takeProfitPct: number };
  limits: {
    maxOpenPositions: number; cooldownMinutes: number; maxSpreadBps: number;
    maxDailyLossPct: number; maxDataAgeSec: number;
  };
}

// Hard caps: even if the AI parser (or a typo) asks for more, we refuse the rule set.
export const HARD_CAPS = { maxLeverage: 10, riskPctPerTrade: 5, maxDailyLossPct: 20 };

const num = (v: unknown, name: string, min: number, max: number): number => {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new Error(`Invalid ${name}: must be a number between ${min} and ${max}`);
  }
  return v;
};

/** Parse and validate a rule-set JSON string (e.g. produced by the AI parser). */
export function parseRuleSet(json: string): RuleSet {
  let r: any;
  try { r = JSON.parse(json); } catch { throw new Error("Rule set is not valid JSON"); }
  if (typeof r.market !== "string" || !r.market) throw new Error("Invalid market");
  if (r.side !== "long" && r.side !== "short") throw new Error("side must be long or short");
  if (!["breakout", "meanReversion", "manual"].includes(r.entry?.type)) throw new Error("Invalid entry.type");
  if (typeof r.entry?.timeframe !== "string") throw new Error("Invalid entry.timeframe");
  const rules: RuleSet = {
    market: r.market,
    side: r.side,
    entry: { type: r.entry.type, timeframe: r.entry.timeframe, lookback: num(r.entry.lookback, "entry.lookback", 1, 500) },
    sizing: {
      riskPctPerTrade: num(r.sizing?.riskPctPerTrade, "sizing.riskPctPerTrade", 0.01, HARD_CAPS.riskPctPerTrade),
      maxLeverage: num(r.sizing?.maxLeverage, "sizing.maxLeverage", 1, HARD_CAPS.maxLeverage),
      maxPositionUsd: num(r.sizing?.maxPositionUsd, "sizing.maxPositionUsd", 1, 1_000_000),
    },
    exits: {
      stopLossPct: num(r.exits?.stopLossPct, "exits.stopLossPct", 0.05, 50),
      takeProfitPct: num(r.exits?.takeProfitPct, "exits.takeProfitPct", 0.05, 500),
    },
    limits: {
      maxOpenPositions: num(r.limits?.maxOpenPositions, "limits.maxOpenPositions", 1, 20),
      cooldownMinutes: num(r.limits?.cooldownMinutes, "limits.cooldownMinutes", 0, 10_080),
      maxSpreadBps: num(r.limits?.maxSpreadBps, "limits.maxSpreadBps", 0.1, 1000),
      maxDailyLossPct: num(r.limits?.maxDailyLossPct, "limits.maxDailyLossPct", 0.1, HARD_CAPS.maxDailyLossPct),
      maxDataAgeSec: num(r.limits?.maxDataAgeSec, "limits.maxDataAgeSec", 1, 3600),
    },
  };
  return rules;
}

export interface MarketContext {
  nowMs: number;
  lastTradeMs?: number;
  openPositions: number;
  spreadBps: number;
  equityUsd: number;
  dailyPnlUsd: number;        // negative = loss today
  dataAgeSec: number;
}

export interface ProposedTrade {
  side: "long" | "short";
  sizeUsd: number;            // notional
  entryPrice: number;
  stopPrice: number;
}

export type CheckResult = { ok: true } | { ok: false; reason: ReasonName; note: string };

/** Size a trade so that hitting the stop loses exactly the risk budget, then cap it. */
export function computeSizeUsd(rules: RuleSet, equityUsd: number): number {
  const riskBudget = (equityUsd * rules.sizing.riskPctPerTrade) / 100;
  const bySizing = riskBudget / (rules.exits.stopLossPct / 100);
  const byLeverage = equityUsd * rules.sizing.maxLeverage;
  return Math.max(0, Math.min(bySizing, byLeverage, rules.sizing.maxPositionUsd));
}

/** Run every safety rule. First failure wins; the reason goes into the journal. */
export function checkTrade(rules: RuleSet, ctx: MarketContext, t: ProposedTrade): CheckResult {
  const fail = (reason: ReasonName, note: string): CheckResult => ({ ok: false, reason, note });
  const L = rules.limits;

  if (ctx.dataAgeSec > L.maxDataAgeSec)
    return fail("STALE_DATA", `data ${ctx.dataAgeSec}s old > ${L.maxDataAgeSec}s`);

  if (ctx.equityUsd > 0 && ctx.dailyPnlUsd < 0 &&
      (-ctx.dailyPnlUsd / ctx.equityUsd) * 100 >= L.maxDailyLossPct)
    return fail("DAILY_LOSS", `daily loss limit ${L.maxDailyLossPct}% reached`);

  if (ctx.openPositions >= L.maxOpenPositions)
    return fail("MAX_OPEN_POSITIONS", `${ctx.openPositions} open >= max ${L.maxOpenPositions}`);

  if (ctx.lastTradeMs !== undefined) {
    const mins = (ctx.nowMs - ctx.lastTradeMs) / 60_000;
    if (mins < L.cooldownMinutes)
      return fail("COOLDOWN", `${mins.toFixed(1)}min since last trade < ${L.cooldownMinutes}min`);
  }

  if (ctx.spreadBps > L.maxSpreadBps)
    return fail("MAX_SPREAD", `spread ${ctx.spreadBps.toFixed(1)}bps > ${L.maxSpreadBps}bps`);

  const leverage = ctx.equityUsd > 0 ? t.sizeUsd / ctx.equityUsd : Infinity;
  if (leverage > rules.sizing.maxLeverage + 1e-9)
    return fail("MAX_LEVERAGE", `leverage ${leverage.toFixed(2)}x > ${rules.sizing.maxLeverage}x`);

  if (t.sizeUsd > rules.sizing.maxPositionUsd + 1e-9)
    return fail("MAX_SIZE", `size $${t.sizeUsd.toFixed(2)} > $${rules.sizing.maxPositionUsd}`);

  const lossAtStopUsd = (t.sizeUsd * Math.abs(t.entryPrice - t.stopPrice)) / t.entryPrice;
  const budget = (ctx.equityUsd * rules.sizing.riskPctPerTrade) / 100;
  if (lossAtStopUsd > budget + 1e-9)
    return fail("RISK_PER_TRADE", `loss at stop $${lossAtStopUsd.toFixed(2)} > budget $${budget.toFixed(2)}`);

  return { ok: true };
}