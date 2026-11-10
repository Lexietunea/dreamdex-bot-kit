import { ethers, network } from "hardhat";
import * as fs from "fs";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log(`Network: ${network.name} | deployer: ${deployer.address}`);

  const journal = await ethers.deployContract("DecisionJournal");
  await journal.waitForDeployment();
  const address = await journal.getAddress();
  console.log(`DecisionJournal deployed at ${address}`);

  const bot = process.env.BOT_ADDRESS;
  if (bot && bot.toLowerCase() !== deployer.address.toLowerCase()) {
    const tx = await journal.setWriter(bot, true);
    await tx.wait();
    console.log(`Authorized bot writer: ${bot}`);
  }

  fs.writeFileSync(
    "deployment.json",
    JSON.stringify({ network: network.name, address, deployer: deployer.address }, null, 2)
  );
  console.log("Saved deployment.json");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
