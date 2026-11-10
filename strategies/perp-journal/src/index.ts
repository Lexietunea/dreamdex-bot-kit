/**
 * perp-journal: a rule-guarded perp bot that writes every decision to an onchain journal.
 *
 * Based on the DreamDEX bot kit's perp-starter (MIT, DreamDEX S.A.). What this adds:
 *   1. The strategy comes from a rules.json file (validated, with hard safety caps).
 *   2. Every entry signal passes through pre-trade checks (spread, cooldown, size,
 *      leverage, risk per trade, daily loss, open positions, stale data).
 *   3. TRADES and REFUSALS (with a reason code) are written to the DecisionJournal
 *      contract on Somnia, stamped with the hash of the rule set in force.
 *
 * Needs trading-key mode (OWNER_ADDRESS set). Run:  npm run dev -w perp-journal
 */
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ORDER_TYPE,
  closePosition,
  createExchange,
  ensureLeverage,
  envNum,
  loadEnv,
  liveMark,
  markOf,
  onStop,
  placePerp,
  positionIn,
  preflight,
  requireMarket,
  shutdown,
  sizeForNotional,
  sizeOrder,
  sleep,
  tradingKeyCheck,
  type Side,
} from "@dreamdex-bot-kit/perp-core";
import { Journal } from "./journal.js";
import { checkTrade, computeSizeUsd, parseRuleSet, type ReasonName, type RuleSet } from "./rules.js";

loadEnv();

// ---- rules ------------------------------------------------------------------
const RULES_PATH = path.resolve(process.cwd(), process.env.RULES_FILE ?? "rules.json");
let rulesRaw: string;
let rules: RuleSet;
try {
  rulesRaw = JSON.stringify(JSON.parse(fs.readFileSync(RULES_PATH, "utf8"))); // normalised, so the hash is stable
  rules = parseRuleSet(rulesRaw);
} catch (e) {
  console.error(`Cannot load rules from ${RULES_PATH}: ${e instanceof Error ? e.message : e}`);
  console.error("Copy rules.example.json to rules.json and edit it.");
  process.exit(1);
}

const SIDE: Side = rules.side;
const LEVERAGE = rules.sizing.maxLeverage;
const TAKE_PROFIT_PCT = rules.exits.takeProfitPct;
const STOP_LOSS_PCT = rules.exits.stopLossPct;
const TICK_MS = envNum("PERP_TICK_MS", 10_000);
// Equity used for sizing and risk checks. The doctor prints your real number; default matches the Arena grant.
const EQUITY_USDSO = envNum("PERP_EQUITY_USDSO", 3000);
const REFUSAL_THROTTLE_MS = envNum("JOURNAL_REFUSAL_THROTTLE_MS", 300_000);

// ---- journal ------------------------------------------------------------------
function makeJournal(): Journal | undefined {
  const address = process.env.JOURNAL_ADDRESS;
  const rpc = process.env.JOURNAL_RPC_URL ?? process.env.RPC_URL;
  const key = process.env.PRIVATE_KEY;
  if (!address || !rpc || !key) return undefined;
  return new Journal(rpc, key, address);
}

// ---- signals ------------------------------------------------------------------
function signalFor(type: RuleSet["entry"]["type"], marks: number[], live: number, lookback: number): Side | undefined {
  if (type === "manual") return SIDE; // open as soon as checks pass
  if (marks.length < lookback) return undefined; // still collecting samples
  const window = marks.slice(-lookback);
  let signal: Side | undefined;
  if (type === "breakout") {
    if (live > Math.max(...window)) signal = "long";
    else if (live < Math.min(...window)) signal = "short";
  } else {
    const mean = window.reduce((a, b) => a + b, 0) / window.length;
    const sd = Math.sqrt(window.reduce((a, b) => a + (b - mean) ** 2, 0) / window.length);
    if (sd > 0) {
      const z = (live - mean) / sd;
      if (z < -1) signal = "long";
      else if (z > 1) signal = "short";
    }
  }
  return signal === SIDE ? signal : undefined; // the rule set fixes the side
}

async function main(): Promise<void> {
  const ctx = createExchange({ withSigner: process.env.DRY_RUN === "false" });
  const stopped = onStop();
  const market = await requireMarket(ctx.exchange, rules.market);
  const me = ctx.exchange.walletAddress as `0x${string}` | undefined;

  if (!ctx.config.owner) {
    console.error("perp-journal needs trading-key mode: set OWNER_ADDRESS and link your bot key in the app.");
    process.exit(1);
  }

  const journal = makeJournal();
  const journalOn = Boolean(journal) && (!ctx.config.dryRun || process.env.JOURNAL_IN_DRY_RUN === "true");
  const jlog = async (label: string, fn: () => Promise<string>) => {
    if (!journalOn) {
      console.log(`[journal off] ${label}`);
      return;
    }
    try {
      console.log(`journal: ${label} | tx ${await fn()}`);
    } catch (e) {
      console.log(`journal write failed (${label}): ${e instanceof Error ? e.message : e}`);
    }
  };
  const lastRefusalAt = new Map<ReasonName, number>();

  const notional = computeSizeUsd(rules, EQUITY_USDSO);
  console.log(
    `perp-journal on ${market.display} | rules ${RULES_PATH} | ${SIDE} ~${notional.toFixed(2)} USDso at ${LEVERAGE}x | ` +
      `entry ${rules.entry.type} | take-profit ${TAKE_PROFIT_PCT}% stop-loss ${STOP_LOSS_PCT}% | dry-run ${ctx.config.dryRun} | journal ${journalOn ? "ON" : "off"}`,
  );

  if (!me) {
    console.log("read-only: no PRIVATE_KEY, nothing will be sent.");
    await shutdown(ctx);
    return;
  }

  const link = await tradingKeyCheck(ctx, market);
  if (link.message) console.log(link.message);
  if (!link.ok && !ctx.config.dryRun) process.exit(1);

  const check = await preflight(ctx.exchange, market, me, {
    requiredUsdso: notional / Math.max(1, LEVERAGE),
    linkedAccount: true,
  });
  console.log(check.message);
  if (!check.ok) process.exit(1);

  const lev = await ensureLeverage(ctx, market, me, LEVERAGE);
  if (!lev.dryRun && lev.ownerOnly) {
    console.log(`leverage on ${market.display} is ${lev.from ? `${lev.from}x` : "unset"}; set ${LEVERAGE}x in the app, sizing follows it.`);
  }

  // Publish the rules (their hash stamps every later entry).
  await jlog("publishRules", () => journal!.publishRules(rulesRaw));

  let dailyPnlUsd = 0;
  let lastTradeMs: number | undefined;
  const existing = await positionIn(ctx.exchange, market);

  if (existing) {
    console.log(`already ${existing.side} ${existing.contracts} ${market.info.baseSymbol}, managing it instead of opening another`);
  } else {
    const marks: number[] = [];
    let opened = false;
    while (!stopped() && !opened) {
      const live = await liveMark(ctx.exchange, market);
      if (live === undefined) {
        console.log("mark is un-priceable, waiting");
        await sleep(TICK_MS, stopped);
        continue;
      }
      const signal = signalFor(rules.entry.type, marks, live, rules.entry.lookback);
      marks.push(live);
      if (marks.length > rules.entry.lookback * 2) marks.shift();
      if (!signal) {
        console.log(`waiting for ${rules.entry.type} signal | mark ${live.toFixed(2)} | samples ${Math.min(marks.length, rules.entry.lookback)}/${rules.entry.lookback}`);
        await sleep(TICK_MS, stopped);
        continue;
      }

      // ---- pre-trade checks -------------------------------------------------
      const book = await ctx.exchange.fetchOrderBook(market.symbol, 1);
      const bid = book.bids[0]?.[0];
      const ask = book.asks[0]?.[0];
      if (bid === undefined || ask === undefined) {
        console.log("book has no two-sided quote, waiting");
        await sleep(TICK_MS, stopped);
        continue;
      }
      const touch = SIDE === "long" ? ask : bid;
      const spreadBps = ((ask - bid) / ((ask + bid) / 2)) * 10_000;
      const bookTs = (book as { timestamp?: number }).timestamp;
      const verdict = checkTrade(
        rules,
        {
          nowMs: Date.now(),
          lastTradeMs,
          openPositions: 0,
          spreadBps,
          equityUsd: EQUITY_USDSO,
          dailyPnlUsd,
          dataAgeSec: bookTs ? Math.max(0, (Date.now() - bookTs) / 1000) : 0,
        },
        { side: SIDE, sizeUsd: notional, entryPrice: touch, stopPrice: touch * (SIDE === "long" ? 1 - STOP_LOSS_PCT / 100 : 1 + STOP_LOSS_PCT / 100) },
      );

      if (!verdict.ok) {
        console.log(`REFUSED (${verdict.reason}): ${verdict.note}`);
        const last = lastRefusalAt.get(verdict.reason) ?? 0;
        if (Date.now() - last >= REFUSAL_THROTTLE_MS) {
          lastRefusalAt.set(verdict.reason, Date.now());
          await jlog(`REFUSED ${verdict.reason}`, () => journal!.logRefusal(rules.market, SIDE, verdict.reason, verdict.note));
        }
        await sleep(TICK_MS, stopped);
        continue;
      }

      // ---- place the order (same flow as perp-starter) ----------------------
      const price = BigInt(Math.round(touch * 1e18));
      const wanted = sizeForNotional(notional, market.info, live);
      const sized = await sizeOrder(ctx.exchange, { market, account: me, side: SIDE, price, wanted, autoPull: true, tradingKey: ctx.tradingKey });
      if (!sized.ok) {
        console.log(`cannot open: ${sized.reason}`);
        await shutdown(ctx);
        return;
      }
      if (ctx.config.dryRun) {
        console.log(`[dry-run] checks passed: would open ${SIDE} ${sized.quantity} ${market.info.baseSymbol} @ ~${touch}`);
      }
      const result = await placePerp({ ctx, market, side: SIDE, price, quantity: sized.quantity, orderType: ORDER_TYPE.MARKET, label: "open" });
      if (result.sent && result.filled === 0n) {
        console.log("nothing crossed, the price moved. Exiting rather than resting an unintended maker order.");
        await shutdown(ctx);
        return;
      }
      opened = true;
      lastTradeMs = Date.now();
      if (result.sent) {
        const r = result as unknown as Record<string, unknown>;
        const ref = String(r.orderId ?? r.orderIdRaw ?? r.hash ?? r.txHash ?? `open-${Date.now()}`);
        await jlog("TRADE open", () => journal!.logTrade(rules.market, SIDE, ref, `open ${SIDE} ${market.info.baseSymbol} @ ${touch} spread ${spreadBps.toFixed(2)}bps`));
      }
    }
    if (stopped() || ctx.config.dryRun) {
      await shutdown(ctx);
      return;
    }
  }
  if (ctx.config.dryRun) {
    await shutdown(ctx);
    return;
  }
  // ---- watch the exits (bot-side, trading-key mode) ---------------------------
  const mark = (await liveMark(ctx.exchange, market)) ?? markOf(market.info);
  const up = BigInt(Math.round(mark * (1 + TAKE_PROFIT_PCT / 100) * 1e18));
  const down = BigInt(Math.round(mark * (1 - STOP_LOSS_PCT / 100) * 1e18));
  const takeProfit = SIDE === "long" ? up : down;
  const stopLoss = SIDE === "long" ? down : up;
  const px = (v: bigint) => (Number(v) / 1e18).toFixed(2);
  console.log(`watching take-profit ${px(takeProfit)} and stop-loss ${px(stopLoss)} (only while this bot runs)`);

  while (!stopped()) {
    await sleep(TICK_MS, stopped);
    const fresh = await requireMarket(ctx.exchange, market.symbol, { reload: true });
    const position = await positionIn(ctx.exchange, fresh);
    if (!position) {
      console.log("position is closed");
      break;
    }
    const live = await liveMark(ctx.exchange, fresh);
    console.log(
      `${position.side} ${position.contracts} ${fresh.info.baseSymbol} | uPnL ${position.unrealizedPnl?.toFixed(4) ?? "?"} | exits watched | mark ${live?.toFixed(2) ?? "un-priceable"}`,
    );
    if (live !== undefined) {
      const liveRaw = BigInt(Math.round(live * 1e18));
      const hitTp = SIDE === "long" ? liveRaw >= takeProfit : liveRaw <= takeProfit;
      const hitSl = SIDE === "long" ? liveRaw <= stopLoss : liveRaw >= stopLoss;
      if (hitTp || hitSl) {
        const label = hitTp ? "take-profit" : "stop-loss";
        dailyPnlUsd += position.unrealizedPnl ?? 0;
        await closePosition(ctx, fresh, me, { label });
        await jlog(`TRADE close (${label})`, () =>
          journal!.logTrade(rules.market, SIDE, `close-${label}-${Date.now()}`, `closed by ${label}, uPnL ${position.unrealizedPnl?.toFixed(4) ?? "?"}`),
        );
        break;
      }
    }
  }

  if (stopped()) console.log("the bot is stopping: its take-profit and stop-loss stop with it, the position stays open.");
  console.log("done");
  await shutdown(ctx);
}

main().then(
  () => process.exit(0),
  (err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exit(1);
  },
);