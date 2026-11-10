import { expect } from "chai";
import { ethers } from "hardhat";

const ACTION = { TRADE: 0, REFUSED: 1 };
const SIDE = { NONE: 0, LONG: 1, SHORT: 2 };
const REASON = { NONE: 0, MAX_LEVERAGE: 1, MAX_SIZE: 2, MAX_OPEN_POSITIONS: 3, COOLDOWN: 4, MAX_SPREAD: 5 };
const MARKET = ethers.encodeBytes32String("ETH-PERP");
const REF = ethers.id("order-1");
const RULES = JSON.stringify({ market: "ETH-PERP", side: "long", sizing: { maxLeverage: 3 } });

async function setup() {
  const [owner, bot, stranger] = await ethers.getSigners();
  const journal = await ethers.deployContract("DecisionJournal");
  return { journal, owner, bot, stranger };
}

describe("DecisionJournal", () => {
  it("rejects entries before rules are published", async () => {
    const { journal } = await setup();
    await expect(
      journal.log(ACTION.TRADE, SIDE.LONG, REASON.NONE, MARKET, REF, "")
    ).to.be.revertedWithCustomError(journal, "NoActiveRules");
  });

  it("logs a trade stamped with the active rule hash", async () => {
    const { journal } = await setup();
    await journal.publishRules(RULES);
    await journal.log(ACTION.TRADE, SIDE.LONG, REASON.NONE, MARKET, REF, "breakout entry");
    const e = await journal.getEntry(0);
    expect(e.action).to.equal(ACTION.TRADE);
    expect(e.ruleHash).to.equal(ethers.keccak256(ethers.toUtf8Bytes(RULES)));
    expect(e.note).to.equal("breakout entry");
    expect(await journal.entryCount()).to.equal(1);
  });

  it("logs a refusal with a reason and emits an event", async () => {
    const { journal } = await setup();
    await journal.publishRules(RULES);
    await expect(
      journal.log(ACTION.REFUSED, SIDE.LONG, REASON.MAX_SPREAD, MARKET, REF, "spread 18bps > 10bps")
    ).to.emit(journal, "EntryLogged");
    expect((await journal.getEntry(0)).reason).to.equal(REASON.MAX_SPREAD);
  });

  it("enforces reason rules", async () => {
    const { journal } = await setup();
    await journal.publishRules(RULES);
    await expect(
      journal.log(ACTION.REFUSED, SIDE.LONG, REASON.NONE, MARKET, REF, "")
    ).to.be.revertedWithCustomError(journal, "InvalidReason");
    await expect(
      journal.log(ACTION.TRADE, SIDE.LONG, REASON.COOLDOWN, MARKET, REF, "")
    ).to.be.revertedWithCustomError(journal, "InvalidReason");
  });

  it("only authorized writers can write; only owner can authorize", async () => {
    const { journal, bot, stranger } = await setup();
    await expect(journal.connect(stranger).publishRules(RULES)).to.be.revertedWithCustomError(journal, "NotWriter");
    await expect(journal.connect(bot).setWriter(bot.address, true)).to.be.revertedWithCustomError(journal, "NotOwner");
    await journal.setWriter(bot.address, true);
    await journal.connect(bot).publishRules(RULES);
    await journal.connect(bot).log(ACTION.TRADE, SIDE.SHORT, REASON.NONE, MARKET, REF, "");
    expect(await journal.entryCount()).to.equal(1);
  });

  it("paginates entries", async () => {
    const { journal } = await setup();
    await journal.publishRules(RULES);
    for (let i = 0; i < 5; i++) {
      await journal.log(ACTION.TRADE, SIDE.LONG, REASON.NONE, MARKET, ethers.id(`o${i}`), "");
    }
    expect((await journal.getEntries(0, 3)).length).to.equal(3);
    expect((await journal.getEntries(3, 10)).length).to.equal(2);
    expect((await journal.getEntries(9, 10)).length).to.equal(0);
  });
});
