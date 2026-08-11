#!/usr/bin/env node
/**
 * Bot de swap Uniswap sur Robinhood Chain (chainId 4663)
 * + suivi PnL et take-profit auto (vente à +100% par défaut)
 *
 * Usage:
 *   npm start -- swap --in ETH --out 0xToken --amount 0.01 --amm-only
 *   npm start -- positions
 *   npm start -- pnl [--token 0x…]
 *   npm start -- watch-pnl [--take-profit 100] [--interval 10]
 */

import { parseUnits } from "ethers";
import {
  createProvider,
  createWallet,
  loadConfig,
  NATIVE_ETH,
} from "./config.js";
import {
  closePosition,
  listAllPositions,
  recordBuy,
  getOpenPositions,
} from "./positions.js";
import {
  computePnl,
  ethToWeiString,
  formatPnlLine,
  watchPnlLoop,
} from "./pnl.js";
import {
  executeSwap,
  fetchQuoteOnly,
  getBalance,
} from "./swap.js";

function printHelp(): void {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║  Robinhood Chain × Uniswap Swap Bot + PnL / Take-Profit      ║
║  Chain ID 4663 · pools.trade / Uniswap v2/v3/v4              ║
╚══════════════════════════════════════════════════════════════╝

Commandes:
  quote        Prix sans exécuter
  swap         Swap (ETH→token enregistre la position auto)
  balance      Solde ETH / token
  positions    Liste des positions (open + closed)
  pnl          PnL live des positions open
  watch-pnl    Surveille et VEND TOUT auto au take-profit
  watch-quote  Quote en boucle

Options swap / quote:
  --in <ETH|0x…>       Token d'entrée (défaut: ETH)
  --out <0x…>          Token de sortie
  --amount <n>         Montant humain
  --slippage <n>       Slippage %
  --amm-only           Forcer V2/V3/V4
  --dry-run            Pas de broadcast
  --take-profit <n>    % PnL pour vente auto (défaut: 100 = x2)
  --no-track           Ne pas enregistrer la position après achat
  --interval <sec>     Intervalle watch (défaut: 10)
  --token <0x…>        Filtrer une position / balance
  -h, --help

Exemples:
  # Acheter + tracker (TP 100% par défaut)
  npm start -- swap --in ETH --out 0xToken --amount 0.0005 --amm-only

  # Surveiller et vendre auto à +100% (x2)
  npm start -- watch-pnl --take-profit 100 --interval 10

  # PnL une fois
  npm start -- pnl

  # TP à +50% seulement
  npm start -- watch-pnl --take-profit 50 --interval 5

Config .env:
  UNISWAP_API_KEY, PRIVATE_KEY, RPC_URL, CHAIN_ID=4663
  TAKE_PROFIT_PCT=100
  PNL_POLL_INTERVAL=10
`);
}

function parseArgs(argv: string[]): {
  command: string;
  flags: Record<string, string | boolean>;
} {
  const args = argv.slice(2);
  if (args.length === 0 || args[0] === "-h" || args[0] === "--help") {
    return { command: "help", flags: {} };
  }
  const command = args[0];
  const flags: Record<string, string | boolean> = {};
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (
      a === "--amm-only" ||
      a === "--dry-run" ||
      a === "--no-track"
    ) {
      flags[a.slice(2)] = true;
    } else if (a.startsWith("--") && i + 1 < args.length) {
      flags[a.slice(2)] = args[++i];
    } else if (a === "-h" || a === "--help") {
      flags.help = true;
    }
  }
  return { command, flags };
}

function flagStr(
  flags: Record<string, string | boolean>,
  key: string,
  fallback?: string
): string | undefined {
  const v = flags[key];
  if (typeof v === "string") return v;
  return fallback;
}

function isEth(token: string): boolean {
  return (
    token.toUpperCase() === "ETH" ||
    token.toLowerCase() === NATIVE_ETH.toLowerCase() ||
    token.toLowerCase() === "native"
  );
}

async function main(): Promise<void> {
  const { command, flags } = parseArgs(process.argv);

  if (command === "help" || flags.help) {
    printHelp();
    process.exit(0);
  }

  if (command === "balance") {
    const config = loadConfig({ requireWallet: true });
    const provider = createProvider(config);
    const wallet = createWallet(config, provider);
    const address = await wallet.getAddress();
    const token = flagStr(flags, "token", "ETH") ?? "ETH";

    const eth = await getBalance(provider, address, NATIVE_ETH);
    console.log(`Wallet : ${address}`);
    console.log(`ETH    : ${eth.formatted}`);

    if (token.toUpperCase() !== "ETH") {
      const t = await getBalance(provider, address, token);
      console.log(`${t.symbol.padEnd(7)}: ${t.formatted}`);
    }
    return;
  }

  if (command === "positions") {
    const all = listAllPositions();
    if (all.length === 0) {
      console.log("Aucune position enregistrée.");
      console.log("(Les achats ETH→token via `swap` créent une position auto.)");
      return;
    }
    for (const p of all) {
      const tag = p.status === "open" ? "🟢 OPEN " : "⚫ CLOSED";
      console.log(
        `${tag} | ${p.symbol} ${p.token}\n` +
          `  cost=${p.costEth} ETH | tokens=${p.tokenAmount} | TP=+${p.takeProfitPct}%\n` +
          `  opened=${p.openedAt}` +
          (p.entryTxHash ? ` | entry=${p.entryTxHash}` : "") +
          (p.status === "closed"
            ? `\n  exit=${p.exitEth} ETH | PnL=${p.realizedPnlPct}% | closed=${p.closedAt}` +
              (p.exitTxHash ? ` | tx=${p.exitTxHash}` : "")
            : "")
      );
      console.log("");
    }
    return;
  }

  if (command === "pnl") {
    const config = loadConfig({ requireWallet: true });
    const provider = createProvider(config);
    const wallet = createWallet(config, provider);
    const swapper = await wallet.getAddress();
    const tokenFilter = flagStr(flags, "token");
    const tp = Number(
      flagStr(flags, "take-profit", process.env.TAKE_PROFIT_PCT ?? "100")
    );

    const opens = getOpenPositions(tokenFilter);
    if (opens.length === 0) {
      console.log("Aucune position open.");
      return;
    }

    for (const pos of opens) {
      const snap = await computePnl(config, provider, swapper, pos, tp);
      console.log(formatPnlLine(snap));
    }
    return;
  }

  if (command === "watch-pnl") {
    const config = loadConfig({ requireWallet: true });
    const provider = createProvider(config);
    const wallet = createWallet(config, provider);
    const takeProfitPct = Number(
      flagStr(flags, "take-profit", process.env.TAKE_PROFIT_PCT ?? "100")
    );
    const intervalSec = Number(
      flagStr(flags, "interval", process.env.PNL_POLL_INTERVAL ?? "10")
    );
    const tokenFilter = flagStr(flags, "token");
    const dryRun = Boolean(flags["dry-run"]) || config.dryRun;
    const slippage = flagStr(flags, "slippage");

    // Option: enregistrer une position manuelle si --token + balance > 0 + --cost
    const cost = flagStr(flags, "cost");
    if (tokenFilter && cost) {
      const address = await wallet.getAddress();
      const bal = await getBalance(provider, address, tokenFilter);
      if (bal.raw > 0n) {
        const existing = getOpenPositions(tokenFilter);
        if (existing.length === 0) {
          const pos = recordBuy({
            token: tokenFilter,
            symbol: bal.symbol,
            costEth: cost,
            costEthWei: ethToWeiString(cost),
            tokenAmount: bal.formatted,
            tokenAmountRaw: bal.raw.toString(),
            takeProfitPct,
          });
          console.log(
            `Position importée: ${pos.symbol} cost=${cost} ETH TP=+${takeProfitPct}%`
          );
        }
      }
    }

    await watchPnlLoop(config, provider, wallet, {
      intervalSec,
      takeProfitPct,
      tokenFilter,
      dryRun,
      slippage: slippage ? Number(slippage) : undefined,
    });
    return;
  }

  if (command === "quote" || command === "watch-quote") {
    const config = loadConfig({ requireWallet: true });
    const provider = createProvider(config);
    const wallet = createWallet(config, provider);
    const swapper = await wallet.getAddress();

    const tokenIn = flagStr(flags, "in", "ETH") ?? "ETH";
    const tokenOut = flagStr(flags, "out");
    const amount = flagStr(flags, "amount");
    if (!tokenOut || !amount) {
      console.error("quote/watch-quote requiert --out et --amount");
      process.exit(1);
    }

    const slippage = flagStr(flags, "slippage");
    const decimals = flagStr(flags, "decimals");
    const ammOnly = Boolean(flags["amm-only"]);

    const run = async () => {
      try {
        const result = await fetchQuoteOnly(config, provider, swapper, {
          tokenIn,
          tokenOut,
          amountHuman: amount,
          slippage: slippage ? Number(slippage) : undefined,
          decimalsIn: decimals ? Number(decimals) : undefined,
          ammOnly,
        });
        console.log(`[${new Date().toISOString()}]`);
        console.log(JSON.stringify(result, null, 2));
      } catch (e) {
        console.error("Erreur quote:", e instanceof Error ? e.message : e);
      }
    };

    if (command === "watch-quote") {
      const intervalSec = Number(flagStr(flags, "interval", "15"));
      console.log(
        `Watch quote toutes les ${intervalSec}s (Ctrl+C pour arrêter)…`
      );
      await run();
      setInterval(run, intervalSec * 1000);
      return;
    }

    await run();
    return;
  }

  if (command === "swap") {
    const config = loadConfig({ requireWallet: true });
    const provider = createProvider(config);
    const wallet = createWallet(config, provider);

    const tokenIn = flagStr(flags, "in", "ETH") ?? "ETH";
    const tokenOut = flagStr(flags, "out");
    const amount = flagStr(flags, "amount");
    if (!tokenOut || !amount) {
      console.error("swap requiert --out et --amount");
      process.exit(1);
    }

    const slippage = flagStr(flags, "slippage");
    const decimals = flagStr(flags, "decimals");
    const dryRun = Boolean(flags["dry-run"]) || config.dryRun;
    const ammOnly = Boolean(flags["amm-only"]);
    const noTrack = Boolean(flags["no-track"]);
    const takeProfitPct = Number(
      flagStr(flags, "take-profit", process.env.TAKE_PROFIT_PCT ?? "100")
    );
    const autoWatch = Boolean(flags["auto-watch"]);

    const network = await provider.getNetwork();
    if (Number(network.chainId) !== config.chainId) {
      console.warn(
        `⚠ RPC chainId=${network.chainId} ≠ config CHAIN_ID=${config.chainId}`
      );
    }

    const address = await wallet.getAddress();
    const balBeforeOut = !isEth(tokenOut)
      ? await getBalance(provider, address, tokenOut)
      : null;

    const result = await executeSwap(config, provider, wallet, {
      tokenIn,
      tokenOut,
      amountHuman: amount,
      slippage: slippage ? Number(slippage) : undefined,
      decimalsIn: decimals ? Number(decimals) : undefined,
      dryRun,
      ammOnly,
    });

    console.log("\n=== Résultat ===");
    console.log(JSON.stringify(result, null, 2));

    if (!result.dryRun && result.txHash) {
      const [ethBal, outBal] = await Promise.all([
        getBalance(provider, address, "ETH"),
        getBalance(provider, address, tokenOut),
      ]);
      console.log(
        `Balances après: ${ethBal.formatted} ETH | ${outBal.formatted} ${outBal.symbol}`
      );

      // Achat ETH → token : enregistrer position pour PnL / TP
      if (isEth(tokenIn) && !isEth(tokenOut) && !noTrack) {
        const received =
          balBeforeOut !== null
            ? outBal.raw - balBeforeOut.raw
            : outBal.raw;
        if (received > 0n) {
          const pos = recordBuy({
            token: tokenOut,
            symbol: outBal.symbol,
            costEth: amount,
            costEthWei: parseUnits(amount, 18).toString(),
            tokenAmount: formatRaw(received, outBal.decimals),
            tokenAmountRaw: received.toString(),
            entryTxHash: result.txHash,
            takeProfitPct,
          });
          console.log(
            `\n📊 Position ouverte: ${pos.symbol} | cost=${pos.costEth} ETH | ` +
              `tokens=${pos.tokenAmount} | take-profit=+${pos.takeProfitPct}%`
          );
          console.log(
            `   Lance: npm start -- watch-pnl --take-profit ${takeProfitPct} --interval 10`
          );
        }
      }

      // Vente token → ETH : clôturer position
      if (!isEth(tokenIn) && isEth(tokenOut) && !noTrack) {
        const closed = closePosition({
          token: tokenIn,
          exitEth: "see-tx",
          exitTxHash: result.txHash,
        });
        if (closed) {
          console.log(
            `\n📊 Position clôturée: ${closed.symbol} | PnL réalisé=${closed.realizedPnlPct}%`
          );
        }
      }

      // Option: démarrer watch immédiatement après achat
      if (
        autoWatch &&
        isEth(tokenIn) &&
        !isEth(tokenOut) &&
        !noTrack
      ) {
        const intervalSec = Number(
          flagStr(flags, "interval", process.env.PNL_POLL_INTERVAL ?? "10")
        );
        console.log("\n→ Démarrage watch-pnl…");
        await watchPnlLoop(config, provider, wallet, {
          intervalSec,
          takeProfitPct,
          tokenFilter: tokenOut,
          dryRun: false,
          slippage: slippage ? Number(slippage) : undefined,
        });
      }
    }
    return;
  }

  console.error(`Commande inconnue: ${command}`);
  printHelp();
  process.exit(1);
}

function formatRaw(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base)
    .toString()
    .padStart(decimals, "0")
    .replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

main().catch((err) => {
  console.error("\n✗ Erreur fatale:", err instanceof Error ? err.message : err);
  if (err && typeof err === "object" && "body" in err) {
    console.error(JSON.stringify((err as { body: unknown }).body, null, 2));
  }
  process.exit(1);
});
