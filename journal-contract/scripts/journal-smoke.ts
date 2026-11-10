// Writes a rule set + one refusal to the deployed journal. Proves the journal path works.
// Run:  npx ts-node scripts/journal-smoke.ts
import * as dotenv from "dotenv";
import * as fs from "fs";
import { Journal } from "../src/journal";
import { parseRuleSet, checkTrade, computeSizeUsd } from "../src/rules";
dotenv.config();

async function main() {
  const { address } = JSON.parse(fs.readFileSync("deployment.json", "utf8"));
  const journal = new Journal(process.env.SOMNIA_RPC_URL!, process.env.DEPLOYER_PRIVATE_KEY!, address);

  const rulesJson = JSON.stringify({
    market: "ETH-PERP", side: "long",
    entry: { type: "breakout", timeframe: "4h", lookback: 20 },
    sizing: { riskPctPerTrade: 2, maxLeverage: 3, maxPositionUsd: 500 },
    exits: { stopLossPct: 1.5, takeProfitPct: 3 },
    limits: { maxOpenPositions: 1, cooldownMinutes: 30, maxSpreadBps: 10, maxDailyLossPct: 5, maxDataAgeSec: 30 },
  });
  const rules = parseRuleSet(rulesJson);

  console.log("publishRules tx:", await journal.publishRules(rulesJson));

  // Simulate a signal arriving while the spread is too wide -> must be refused and journaled.
  const equity = 1000;
  const size = computeSizeUsd(rules, equity);
  const res = checkTrade(rules,
    { nowMs: Date.now(), openPositions: 0, spreadBps: 18, equityUsd: equity, dailyPnlUsd: 0, dataAgeSec: 2 },
    { side: "long", sizeUsd: size, entryPrice: 2500, stopPrice: 2500 * 0.985 });
  if (!res.ok) {
    console.log(`REFUSED (${res.reason}): ${res.note}`);
    console.log("logRefusal tx:", await journal.logRefusal(rules.market, rules.side, res.reason, res.note));
  }
  console.log("journal entries:", await journal.count());
}
main().catch((e) => { console.error(e); process.exitCode = 1; });