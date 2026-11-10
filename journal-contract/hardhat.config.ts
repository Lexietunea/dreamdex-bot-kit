import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import * as dotenv from "dotenv";
dotenv.config();

const { SOMNIA_RPC_URL, SOMNIA_CHAIN_ID, DEPLOYER_PRIVATE_KEY } = process.env;

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.24",
    // "paris" avoids opcodes (PUSH0 etc. are fine, but cancun-only ones may not be) a new chain might lack
    settings: { optimizer: { enabled: true, runs: 200 }, evmVersion: "paris" },
  },
  networks: {
    somnia: {
      url: SOMNIA_RPC_URL || "",
      chainId: SOMNIA_CHAIN_ID ? Number(SOMNIA_CHAIN_ID) : undefined,
      accounts: DEPLOYER_PRIVATE_KEY ? [DEPLOYER_PRIVATE_KEY] : [],
    },
  },
};

export default config;
