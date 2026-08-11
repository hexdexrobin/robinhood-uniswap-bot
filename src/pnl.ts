import { formatUnits, parseUnits, type JsonRpcProvider, type Wallet } from "ethers";
import type { BotConfig } from "./config.js";
import { NATIVE_ETH } from "./config.js";
import {
  closePosition,
  getOpenPositions,
  type Position,
} from "./positions.js";
import { executeSwap, fetchQuoteOnly, getBalance } from "./swap.js";

export interface PnlSnapshot {
  position: Position;
  /** Balance réelle on-chain (peut différer du snapshot d'entrée) */
  balanceRaw: bigint;
  balanceHuman: string;
  /** Valeur actuelle en ETH si on vend toute la balance */
  valueEth: number;
  valueEthWei: bigint;
  costEth: number;
  pnlEth: number;
  /** PnL en % : 100 = x2 */
  pnlPct: number;
  hitTakeProfit: boolean;
  takeProfitPct: number;
  error?: string;
}

function extractAmountOutWei(quotePayload: Record<string, unknown>): bigint {
  const q = (quotePayload.quote ?? quotePayload) as Record<string, unknown>;
  const output = q.output as { amount?: string } | undefined;
  if (output?.amount) return BigInt(output.amount);
  const agg = q.aggregatedOutputs as Array<{ amount?: string }> | undefined;
  if (agg?.[0]?.amount) return BigInt(agg[0].amount);
  // fallback route
  const route = q.route as Array<Array<{ amountOut?: string }>> | undefined;
  if (route?.[0]?.[0]?.amountOut) return BigInt(route[0][0].amountOut);
  throw new Error("Impossible d'extraire amountOut du quote");
}

/**
 * Calcule le PnL d'une position open en quotant token → ETH pour la balance réelle.
 */
export async function computePnl(
  config: BotConfig,
  provider: JsonRpcProvider,
  swapper: string,
  position: Position,
  takeProfitOverride?: number
): Promise<PnlSnapshot> {
  const takeProfitPct = takeProfitOverride ?? position.takeProfitPct ?? 100;
  const bal = await getBalance(provider, swapper, position.token);

  if (bal.raw === 0n) {
    return {
      position,
      balanceRaw: 0n,
      balanceHuman: "0",
      valueEth: 0,
      valueEthWei: 0n,
      costEth: Number(position.costEth),
      pnlEth: -Number(position.costEth),
      pnlPct: -100,
      hitTakeProfit: false,
      takeProfitPct,
      error: "Balance token = 0 (déjà vendu ?)",
    };
  }

  try {
    const quoteRes = await fetchQuoteOnly(config, provider, swapper, {
      tokenIn: position.token,
      tokenOut: "ETH",
      amountHuman: bal.formatted,
      ammOnly: true,
      slippage: config.slippageTolerance,
    });

    const valueEthWei = extractAmountOutWei(quoteRes);
    const valueEth = Number(formatUnits(valueEthWei, 18));
    const costEth = Number(position.costEth);
    const pnlEth = valueEth - costEth;
    const pnlPct = costEth > 0 ? (pnlEth / costEth) * 100 : 0;

    return {
      position,
      balanceRaw: bal.raw,
      balanceHuman: bal.formatted,
      valueEth,
      valueEthWei,
      costEth,
      pnlEth,
      pnlPct,
      hitTakeProfit: pnlPct >= takeProfitPct,
      takeProfitPct,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      position,
      balanceRaw: bal.raw,
      balanceHuman: bal.formatted,
      valueEth: 0,
      valueEthWei: 0n,
      costEth: Number(position.costEth),
      pnlEth: 0,
      pnlPct: 0,
      hitTakeProfit: false,
      takeProfitPct,
      error: msg,
    };
  }
}

export function formatPnlLine(s: PnlSnapshot): string {
  const sym = s.position.symbol || s.position.token.slice(0, 10);
  if (s.error) {
    return `⚠ ${sym}: ${s.error}`;
  }
  const sign = s.pnlPct >= 0 ? "+" : "";
  const flag = s.hitTakeProfit ? " 🎯 TAKE-PROFIT" : "";
  return (
    `${sym} | bal=${s.balanceHuman} | cost=${s.costEth.toFixed(6)} ETH | ` +
    `now=${s.valueEth.toFixed(6)} ETH | PnL=${sign}${s.pnlPct.toFixed(2)}% ` +
    `(${sign}${s.pnlEth.toFixed(6)} ETH) | TP=${s.takeProfitPct}%${flag}`
  );
}

/**
 * Vend 100% de la balance token → ETH et clôture la position.
 */
export async function sellAllForPosition(
  config: BotConfig,
  provider: JsonRpcProvider,
  wallet: Wallet,
  position: Position,
  opts?: { dryRun?: boolean; slippage?: number }
): Promise<{ txHash?: string; exitEth?: string; closed: Position | null }> {
  const swapper = await wallet.getAddress();
  const bal = await getBalance(provider, swapper, position.token);
  if (bal.raw === 0n) {
    console.log(`Rien à vendre pour ${position.symbol} (balance 0).`);
    const closed = closePosition({
      token: position.token,
      exitEth: "0",
    });
    return { closed };
  }

  console.log(
    `\n🚀 TAKE-PROFIT: vente auto de ${bal.formatted} ${position.symbol} → ETH`
  );

  const result = await executeSwap(config, provider, wallet, {
    tokenIn: position.token,
    tokenOut: "ETH",
    amountHuman: bal.formatted,
    ammOnly: true,
    dryRun: opts?.dryRun ?? false,
    slippage: opts?.slippage ?? Math.max(config.slippageTolerance, 3),
  });

  if (result.dryRun) {
    return { closed: null };
  }

  // Valeur de sortie: re-quote n'est plus possible avec bal 0;
  // on estime via delta ETH wallet si possible, sinon via quote avant vente.
  const ethAfter = await getBalance(provider, swapper, NATIVE_ETH);
  // Approximation: exit ≈ cost * (1 + pnl/100) — mieux: stocker value au moment du trigger
  let exitEth = "";
  if (result.quoteSummary) {
    // amountOut pas toujours dans summary; recompute from last known
  }

  // Récupérer exit depuis le quote summary si présent, sinon balance ETH delta n/a
  // On utilise une estimation depuis un quote frais juste avant si pas de tx
  try {
    // Si tokens restants minimes
    const left = await getBalance(provider, swapper, position.token);
    if (left.raw === 0n) {
      // exitEth: on ne connaît pas exact sans parse receipt — quote pré-vente stocké
      exitEth = ""; // rempli par caller si fourni
    }
  } catch {
    /* ignore */
  }

  void ethAfter;

  const closed = closePosition({
    token: position.token,
    exitEth: exitEth || "unknown",
    exitTxHash: result.txHash,
  });

  return { txHash: result.txHash, exitEth: exitEth || undefined, closed };
}

/**
 * Vend tout avec valeur de sortie connue (calculée au tick PnL).
 */
export async function takeProfitSell(
  config: BotConfig,
  provider: JsonRpcProvider,
  wallet: Wallet,
  snapshot: PnlSnapshot,
  opts?: { dryRun?: boolean; slippage?: number }
): Promise<{ txHash?: string; closed: Position | null }> {
  const pos = snapshot.position;
  const bal = snapshot.balanceHuman;

  if (snapshot.balanceRaw === 0n) {
    return { closed: closePosition({ token: pos.token, exitEth: "0" }) };
  }

  console.log("\n════════════════════════════════════════");
  console.log(`🎯 TAKE-PROFIT ATTEINT (+${snapshot.pnlPct.toFixed(2)}%)`);
  console.log(`   ${pos.symbol} ${bal} → ETH`);
  console.log(
    `   cost=${snapshot.costEth.toFixed(6)} ETH → value=${snapshot.valueEth.toFixed(6)} ETH`
  );
  console.log("════════════════════════════════════════\n");

  const result = await executeSwap(config, provider, wallet, {
    tokenIn: pos.token,
    tokenOut: "ETH",
    amountHuman: bal,
    ammOnly: true,
    dryRun: opts?.dryRun ?? false,
    slippage: opts?.slippage ?? Math.max(config.slippageTolerance, 5),
  });

  if (result.dryRun || !result.txHash) {
    return { closed: null };
  }

  const closed = closePosition({
    token: pos.token,
    exitEth: snapshot.valueEth.toFixed(18),
    exitTxHash: result.txHash,
  });

  console.log(
    `✅ Position clôturée | PnL réalisé ≈ +${snapshot.pnlPct.toFixed(2)}% ` +
      `(~${snapshot.pnlEth.toFixed(6)} ETH) | tx=${result.txHash}`
  );

  return { txHash: result.txHash, closed };
}

export interface WatchPnlOptions {
  intervalSec: number;
  takeProfitPct: number;
  tokenFilter?: string;
  dryRun?: boolean;
  slippage?: number;
  /** Max ticks (undefined = infini) */
  maxTicks?: number;
}

/**
 * Boucle de monitoring PnL + vente auto au take-profit.
 */
export async function watchPnlLoop(
  config: BotConfig,
  provider: JsonRpcProvider,
  wallet: Wallet,
  opts: WatchPnlOptions
): Promise<void> {
  const swapper = await wallet.getAddress();
  let tick = 0;
  const selling = new Set<string>();

  console.log("╔══════════════════════════════════════════════════╗");
  console.log("║  WATCH PnL — vente auto au take-profit           ║");
  console.log("╚══════════════════════════════════════════════════╝");
  console.log(`Wallet       : ${swapper}`);
  console.log(`Take-profit  : +${opts.takeProfitPct}% (100% = x2)`);
  console.log(`Intervalle   : ${opts.intervalSec}s`);
  console.log(`Dry-run      : ${opts.dryRun ?? false}`);
  console.log(`Filtre token : ${opts.tokenFilter ?? "toutes positions open"}`);
  console.log("Ctrl+C pour arrêter.\n");

  const runOnce = async () => {
    tick += 1;
    const opens = getOpenPositions(opts.tokenFilter);
    const ts = new Date().toISOString();

    if (opens.length === 0) {
      console.log(`[${ts}] tick#${tick} — aucune position open.`);
      return;
    }

    console.log(`[${ts}] tick#${tick} — ${opens.length} position(s)`);

    for (const pos of opens) {
      const key = pos.token.toLowerCase();
      if (selling.has(key)) {
        console.log(`  … ${pos.symbol} déjà en cours de vente, skip`);
        continue;
      }

      const snap = await computePnl(
        config,
        provider,
        swapper,
        pos,
        opts.takeProfitPct
      );
      console.log(`  ${formatPnlLine(snap)}`);

      if (snap.hitTakeProfit && !snap.error) {
        selling.add(key);
        try {
          await takeProfitSell(config, provider, wallet, snap, {
            dryRun: opts.dryRun,
            slippage: opts.slippage,
          });
        } catch (e) {
          console.error(
            `  ✗ Échec vente auto ${pos.symbol}:`,
            e instanceof Error ? e.message : e
          );
        } finally {
          selling.delete(key);
        }
      }
    }
  };

  await runOnce();

  if (opts.maxTicks === 1) return;

  await new Promise<void>((resolve) => {
    const handle = setInterval(async () => {
      try {
        await runOnce();
        if (opts.maxTicks && tick >= opts.maxTicks) {
          clearInterval(handle);
          resolve();
        }
        // Stop si plus de positions
        if (getOpenPositions(opts.tokenFilter).length === 0) {
          console.log("\n✓ Plus de positions open — arrêt du watch PnL.");
          clearInterval(handle);
          resolve();
        }
      } catch (e) {
        console.error("Erreur tick:", e instanceof Error ? e.message : e);
      }
    }, opts.intervalSec * 1000);

    // keep alive
    process.on("SIGINT", () => {
      clearInterval(handle);
      console.log("\nWatch PnL arrêté.");
      resolve();
    });
  });
}

/** Utilitaire: parse amount human en wei ETH */
export function ethToWeiString(amountHuman: string): string {
  return parseUnits(amountHuman, 18).toString();
}
