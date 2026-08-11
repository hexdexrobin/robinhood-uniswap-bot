import {
  Contract,
  formatUnits,
  parseUnits,
  type JsonRpcProvider,
  type Wallet,
} from "ethers";
import { NATIVE_ETH, UNISWAP_API_URL, type BotConfig } from "./config.js";
import type { SwapArgs, TransactionRequest } from "./types.js";
import { UniswapClient, UniswapApiError } from "./uniswap-client.js";

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function symbol() view returns (string)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;

function isNative(token: string): boolean {
  return (
    token.toLowerCase() === NATIVE_ETH.toLowerCase() ||
    token.toLowerCase() === "eth" ||
    token.toLowerCase() === "native"
  );
}

function normalizeToken(token: string): string {
  if (isNative(token)) return NATIVE_ETH;
  if (!/^0x[a-fA-F0-9]{40}$/.test(token)) {
    throw new Error(
      `Adresse token invalide: ${token}. Utilise 0x... ou "ETH" pour le natif.`
    );
  }
  return token;
}

function validateTx(tx: TransactionRequest): void {
  if (!tx.data || tx.data === "" || tx.data === "0x") {
    throw new Error("Transaction invalide: champ data vide (ne pas modifier le calldata API).");
  }
  if (!tx.to) {
    throw new Error("Transaction invalide: destinataire manquant.");
  }
}

async function resolveDecimals(
  provider: JsonRpcProvider,
  token: string,
  fallback?: number
): Promise<number> {
  if (isNative(token)) return 18;
  if (fallback !== undefined) return fallback;
  const c = new Contract(token, ERC20_ABI, provider);
  return Number(await c.decimals());
}

async function resolveSymbol(
  provider: JsonRpcProvider,
  token: string
): Promise<string> {
  if (isNative(token)) return "ETH";
  try {
    const c = new Contract(token, ERC20_ABI, provider);
    return String(await c.symbol());
  } catch {
    return token.slice(0, 10) + "…";
  }
}

export async function getBalance(
  provider: JsonRpcProvider,
  wallet: string,
  token: string
): Promise<{ raw: bigint; formatted: string; symbol: string; decimals: number }> {
  const t = normalizeToken(token);
  if (isNative(t)) {
    const raw = await provider.getBalance(wallet);
    return { raw, formatted: formatUnits(raw, 18), symbol: "ETH", decimals: 18 };
  }
  const c = new Contract(t, ERC20_ABI, provider);
  const [raw, decimals, symbol] = await Promise.all([
    c.balanceOf(wallet) as Promise<bigint>,
    c.decimals() as Promise<number | bigint>,
    c.symbol() as Promise<string>,
  ]);
  const d = Number(decimals);
  return { raw, formatted: formatUnits(raw, d), symbol: String(symbol), decimals: d };
}

/**
 * Flow complet de swap sur Robinhood Chain via Uniswap API:
 * check_approval → quote → sign permit → /swap ou /order → broadcast
 */
export async function executeSwap(
  config: BotConfig,
  provider: JsonRpcProvider,
  wallet: Wallet,
  args: SwapArgs
): Promise<{
  routing: string;
  txHash?: string;
  orderId?: string;
  quoteSummary: Record<string, unknown>;
  dryRun: boolean;
}> {
  const client = new UniswapClient(config.apiKey, UNISWAP_API_URL);
  const swapper = await wallet.getAddress();
  const tokenIn = normalizeToken(args.tokenIn);
  const tokenOut = normalizeToken(args.tokenOut);
  const chainId = config.chainId;
  const dryRun = args.dryRun ?? config.dryRun;
  const slippage = args.slippage ?? config.slippageTolerance;

  const decimalsIn = await resolveDecimals(provider, tokenIn, args.decimalsIn);
  const amount = parseUnits(args.amountHuman, decimalsIn).toString();

  const [symIn, symOut, balIn] = await Promise.all([
    resolveSymbol(provider, tokenIn),
    resolveSymbol(provider, tokenOut),
    getBalance(provider, swapper, tokenIn),
  ]);

  console.log("────────────────────────────────────────");
  console.log(` Réseau      : Robinhood Chain (${chainId})`);
  console.log(` Wallet     : ${swapper}`);
  console.log(` Swap       : ${args.amountHuman} ${symIn} → ${symOut}`);
  console.log(` TokenIn    : ${tokenIn}`);
  console.log(` TokenOut   : ${tokenOut}`);
  console.log(` Balance    : ${balIn.formatted} ${balIn.symbol}`);
  console.log(` Slippage   : ${slippage}%`);
  console.log(` Dry-run    : ${dryRun}`);
  console.log("────────────────────────────────────────");

  if (balIn.raw < BigInt(amount)) {
    throw new Error(
      `Balance insuffisante: ${balIn.formatted} ${balIn.symbol} < ${args.amountHuman}`
    );
  }

  // ── 1. Check approval (ERC20 seulement) ──────────────────────────
  if (!isNative(tokenIn)) {
    console.log("→ Vérification approval Permit2…");
    // Demander un peu plus pour éviter re-approval immédiate
    const approvalAmount = (BigInt(amount) * 2n).toString();
    const approvalRes = await client.checkApproval({
      walletAddress: swapper,
      token: tokenIn,
      amount: approvalAmount,
      chainId,
      tokenOut,
      tokenOutChainId: chainId,
    });

    if (approvalRes.approval) {
      validateTx(approvalRes.approval);
      if (dryRun) {
        console.log("  [dry-run] Approval requise, tx non envoyée:", {
          to: approvalRes.approval.to,
          value: approvalRes.approval.value,
        });
      } else {
        console.log("  Envoi de l'approval…");
        const tx = await wallet.sendTransaction({
          to: approvalRes.approval.to,
          data: approvalRes.approval.data,
          value: approvalRes.approval.value
            ? BigInt(approvalRes.approval.value)
            : 0n,
          gasLimit: approvalRes.approval.gasLimit
            ? BigInt(approvalRes.approval.gasLimit)
            : undefined,
          maxFeePerGas: approvalRes.approval.maxFeePerGas
            ? BigInt(approvalRes.approval.maxFeePerGas)
            : undefined,
          maxPriorityFeePerGas: approvalRes.approval.maxPriorityFeePerGas
            ? BigInt(approvalRes.approval.maxPriorityFeePerGas)
            : undefined,
        });
        console.log(`  Approval tx: ${tx.hash}`);
        await tx.wait();
        console.log("  Approval confirmée.");
      }
    } else {
      console.log("  Approval déjà en place.");
    }
  }

  // ── 2. Quote ─────────────────────────────────────────────────────
  console.log("→ Demande de quote Uniswap…");

  // Nouveaux tokens pools.trade: souvent mieux de forcer AMM (V2/V3/V4)
  // car UniswapX a un minimum ~300 USDC et peu de fillers sur micro-caps.
  const protocols = args.ammOnly
    ? ["V2", "V3", "V4"]
    : undefined;

  const enableErc20Eth = isNative(tokenIn);

  let quoteRes;
  try {
    quoteRes = await client.quote(
      {
        tokenIn,
        tokenOut,
        tokenInChainId: chainId,
        tokenOutChainId: chainId,
        type: "EXACT_INPUT",
        amount,
        swapper,
        slippageTolerance: slippage,
        routingPreference: config.routingPreference,
        protocols,
        permitAmount: "EXACT",
      },
      { enableErc20Eth }
    );
  } catch (e) {
    if (e instanceof UniswapApiError) {
      console.error("Erreur quote:", e.message);
      console.error("Détails:", JSON.stringify(e.body, null, 2));
      if (!args.ammOnly) {
        console.log("→ Retry en mode AMM only (V2/V3/V4)…");
        quoteRes = await client.quote(
          {
            tokenIn,
            tokenOut,
            tokenInChainId: chainId,
            tokenOutChainId: chainId,
            type: "EXACT_INPUT",
            amount,
            swapper,
            slippageTolerance: slippage,
            routingPreference: config.routingPreference,
            protocols: ["V2", "V3", "V4"],
            permitAmount: "EXACT",
          },
          { enableErc20Eth }
        );
      } else {
        throw e;
      }
    } else {
      throw e;
    }
  }

  const { quote, permitData, routing } = quoteRes;
  console.log(`  Routing: ${routing}`);

  // Affiche un résumé lisible si l'API expose ces champs
  const q = quote as Record<string, unknown>;
  const quoteSummary: Record<string, unknown> = {
    routing,
    amountIn: amount,
    tokenIn: symIn,
    tokenOut: symOut,
  };
  for (const key of [
    "amountOut",
    "amountDecimals",
    "quoteDecimals",
    "priceImpact",
    "gasUseEstimate",
    "gasFeeUSD",
    "routeString",
  ]) {
    if (q[key] !== undefined) quoteSummary[key] = q[key];
    // parfois imbriqué sous quote.quote
    const nested = q.quote as Record<string, unknown> | undefined;
    if (nested && nested[key] !== undefined) quoteSummary[key] = nested[key];
  }
  console.log("  Quote summary:", JSON.stringify(quoteSummary, null, 2));

  // ── 3. Sign Permit2 si nécessaire ────────────────────────────────
  let signature: string | undefined;
  if (permitData) {
    console.log("→ Signature EIP-712 Permit2…");
    // ethers gère EIP712Domain via `domain` — le retirer de types si présent
    const types = { ...permitData.types } as Record<
      string,
      Array<{ name: string; type: string }>
    >;
    delete types.EIP712Domain;
    signature = await wallet.signTypedData(
      permitData.domain as Parameters<Wallet["signTypedData"]>[0],
      types as Parameters<Wallet["signTypedData"]>[1],
      permitData.values as Parameters<Wallet["signTypedData"]>[2]
    );
    console.log("  Permit signé.");
  } else {
    console.log("→ Pas de permit requis.");
  }

  // ── 4. Exécution selon routing ───────────────────────────────────
  const classicRoutes = new Set([
    "CLASSIC",
    "WRAP",
    "UNWRAP",
    "BRIDGE",
  ]);
  const uniswapXRoutes = new Set(["DUTCH_V2", "DUTCH_V3", "PRIORITY"]);

  if (classicRoutes.has(routing)) {
    console.log("→ Construction tx /swap…");
    const swapBody: {
      quote: Record<string, unknown>;
      signature?: string;
      permitData?: typeof permitData;
      refreshGasPrice?: boolean;
    } = {
      quote,
      refreshGasPrice: true,
    };
    // Ne passer signature/permitData que s'ils existent (sinon validation API échoue)
    if (signature && permitData) {
      swapBody.signature = signature;
      swapBody.permitData = permitData;
    }

    const swapRes = await client.createSwap(swapBody);
    validateTx(swapRes.swap);

    if (dryRun) {
      console.log("[dry-run] Transaction prête (non broadcast):");
      console.log({
        to: swapRes.swap.to,
        value: swapRes.swap.value,
        chainId: swapRes.swap.chainId,
        dataLen: swapRes.swap.data?.length,
      });
      return { routing, quoteSummary, dryRun: true };
    }

    console.log("→ Broadcast du swap…");
    const txReq: {
      to: string;
      data: string;
      value: bigint;
      gasLimit?: bigint;
      maxFeePerGas?: bigint;
      maxPriorityFeePerGas?: bigint;
      gasPrice?: bigint;
    } = {
      to: swapRes.swap.to,
      data: swapRes.swap.data,
      value: swapRes.swap.value ? BigInt(swapRes.swap.value) : 0n,
    };
    // Buffer gas: l'estim API est parfois juste → revert on-chain (OOG)
    if (swapRes.swap.gasLimit) {
      txReq.gasLimit = (BigInt(swapRes.swap.gasLimit) * 150n) / 100n;
    } else {
      txReq.gasLimit = 500_000n;
    }
    if (swapRes.swap.maxFeePerGas)
      txReq.maxFeePerGas = (BigInt(swapRes.swap.maxFeePerGas) * 120n) / 100n;
    if (swapRes.swap.maxPriorityFeePerGas)
      txReq.maxPriorityFeePerGas =
        (BigInt(swapRes.swap.maxPriorityFeePerGas) * 120n) / 100n;
    if (swapRes.swap.gasPrice)
      txReq.gasPrice = (BigInt(swapRes.swap.gasPrice) * 120n) / 100n;

    // Simulation optionnelle
    try {
      await provider.call({
        to: txReq.to,
        data: txReq.data,
        from: swapper,
        value: txReq.value,
      });
      console.log("  Simulation OK.");
    } catch (simErr) {
      const msg = simErr instanceof Error ? simErr.message : String(simErr);
      console.warn("  ⚠ Simulation a échoué (peut encore passer on-chain):", msg);
    }

    const sent = await wallet.sendTransaction(txReq);
    console.log(`  Tx hash: ${sent.hash}`);
    console.log(
      `  Explorer: https://robinhoodchain.blockscout.com/tx/${sent.hash}`
    );
    const receipt = await sent.wait();
    console.log(`  Confirmé dans le block ${receipt?.blockNumber}`);
    return {
      routing,
      txHash: sent.hash,
      quoteSummary,
      dryRun: false,
    };
  }

  if (uniswapXRoutes.has(routing)) {
    console.log("→ Soumission ordre UniswapX /order…");
    if (dryRun) {
      console.log("[dry-run] Ordre UniswapX non soumis.");
      return { routing, quoteSummary, dryRun: true };
    }
    const orderRes = await client.createOrder(
      {
        quote,
        signature,
      },
      { enableErc20Eth }
    );
    const orderId =
      (orderRes.orderId as string | undefined) ??
      (orderRes.orderHash as string | undefined);
    console.log("  Ordre soumis:", JSON.stringify(orderRes, null, 2));
    return {
      routing,
      orderId,
      quoteSummary,
      dryRun: false,
    };
  }

  throw new Error(
    `Routing non géré: ${routing}. Pour CHAINED, utiliser les endpoints /plan (voir doc Uniswap).`
  );
}

/** Quote seul (sans exécution) — utile pour sniper / monitoring pools.trade */
export async function fetchQuoteOnly(
  config: BotConfig,
  provider: JsonRpcProvider,
  swapper: string,
  args: Omit<SwapArgs, "dryRun">
): Promise<Record<string, unknown>> {
  const client = new UniswapClient(config.apiKey, UNISWAP_API_URL);
  const tokenIn = normalizeToken(args.tokenIn);
  const tokenOut = normalizeToken(args.tokenOut);
  const decimalsIn = await resolveDecimals(provider, tokenIn, args.decimalsIn);
  const amount = parseUnits(args.amountHuman, decimalsIn).toString();
  const slippage = args.slippage ?? config.slippageTolerance;

  const quoteRes = await client.quote(
    {
      tokenIn,
      tokenOut,
      tokenInChainId: config.chainId,
      tokenOutChainId: config.chainId,
      type: "EXACT_INPUT",
      amount,
      swapper,
      slippageTolerance: slippage,
      routingPreference: config.routingPreference,
      protocols: args.ammOnly ? ["V2", "V3", "V4"] : undefined,
      permitAmount: "EXACT",
    },
    { enableErc20Eth: isNative(tokenIn) }
  );

  return {
    routing: quoteRes.routing,
    quote: quoteRes.quote,
    hasPermit: !!quoteRes.permitData,
  };
}
