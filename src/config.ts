import "dotenv/config";
import { Wallet, JsonRpcProvider } from "ethers";

/** Adresse native ETH pour l'API Uniswap */
export const NATIVE_ETH = "0x0000000000000000000000000000000000000000";

/** Robinhood Chain mainnet */
export const ROBINHOOD_CHAIN_ID = 4663;

/** Robinhood Chain testnet */
export const ROBINHOOD_TESTNET_CHAIN_ID = 46630;

export const UNISWAP_API_URL =
  process.env.UNISWAP_API_URL ?? "https://trade-api.gateway.uniswap.org/v1";

export interface BotConfig {
  apiKey: string;
  privateKey: string;
  rpcUrl: string;
  chainId: number;
  slippageTolerance: number;
  routingPreference: string;
  dryRun: boolean;
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v || v.includes("your_") || v.includes("_here")) {
    throw new Error(
      `Variable d'environnement manquante ou placeholder: ${name}. ` +
        `Copie .env.example vers .env et renseigne les valeurs.`
    );
  }
  return v;
}

export function loadConfig(opts?: {
  requireWallet?: boolean;
}): BotConfig {
  const requireWallet = opts?.requireWallet ?? true;
  const apiKey = requireEnv("UNISWAP_API_KEY");

  let privateKey = process.env.PRIVATE_KEY ?? "";
  if (requireWallet) {
    privateKey = requireEnv("PRIVATE_KEY");
    if (!privateKey.startsWith("0x")) {
      privateKey = `0x${privateKey}`;
    }
  }

  const rpcUrl =
    process.env.RPC_URL ?? "https://rpc.mainnet.chain.robinhood.com";
  const chainId = Number(process.env.CHAIN_ID ?? ROBINHOOD_CHAIN_ID);
  const slippageTolerance = Number(process.env.SLIPPAGE_TOLERANCE ?? "1.0");
  const routingPreference =
    process.env.ROUTING_PREFERENCE ?? "BEST_PRICE";
  const dryRun = (process.env.DRY_RUN ?? "false").toLowerCase() === "true";

  return {
    apiKey,
    privateKey,
    rpcUrl,
    chainId,
    slippageTolerance,
    routingPreference,
    dryRun,
  };
}

export function createProvider(config: BotConfig): JsonRpcProvider {
  return new JsonRpcProvider(config.rpcUrl, config.chainId);
}

export function createWallet(
  config: BotConfig,
  provider: JsonRpcProvider
): Wallet {
  return new Wallet(config.privateKey, provider);
}
