// Thin client for the DecisionJournal contract.
import { Contract, JsonRpcProvider, Wallet, encodeBytes32String, ethers } from "ethers";
import { REASON_CODE, ReasonName } from "./rules";

const ABI = [
  "function publishRules(string rulesJson) returns (bytes32)",
  "function log(uint8 action, uint8 side, uint8 reason, bytes32 market, bytes32 ref, string note) returns (uint256)",
  "function entryCount() view returns (uint256)",
  "function activeRuleHash() view returns (bytes32)",
];

const ACTION = { TRADE: 0, REFUSED: 1 } as const;
const SIDE = { none: 0, long: 1, short: 2 } as const;

export class Journal {
  private contract: Contract;

  constructor(rpcUrl: string, privateKey: string, address: string) {
    const signer = new Wallet(privateKey, new JsonRpcProvider(rpcUrl));
    this.contract = new Contract(address, ABI, signer);
  }

  async publishRules(rulesJson: string): Promise<string> {
    const tx = await this.contract.publishRules(rulesJson);
    await tx.wait();
    return tx.hash;
  }

  /** ref: the order id or tx hash of the exchange order (any string; hashed to 32 bytes). */
  async logTrade(market: string, side: "long" | "short", ref: string, note = ""): Promise<string> {
    const tx = await this.contract.log(
      ACTION.TRADE, SIDE[side], 0, encodeBytes32String(market), ethers.id(ref), note);
    await tx.wait();
    return tx.hash;
  }

  async logRefusal(market: string, side: "long" | "short", reason: ReasonName, note: string): Promise<string> {
    const tx = await this.contract.log(
      ACTION.REFUSED, SIDE[side], REASON_CODE[reason], encodeBytes32String(market),
      ethers.id(`refusal-${Date.now()}`), note);
    await tx.wait();
    return tx.hash;
  }

  async count(): Promise<number> {
    return Number(await this.contract.entryCount());
  }
}