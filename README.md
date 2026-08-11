# Robinhood Chain × Uniswap Swap Bot

Bot CLI pour **swapper des tokens sur Robinhood Chain** (chain ID `4663`) via l’**API Trading Uniswap**.

Cible typique : tokens lancés sur **[pools.trade](https://pools.trade)** (launchpad Uniswap Labs) — liquidité déposée en **Uniswap v4** verrouillée, tradable via l’API dès qu’il y a de la liquidité.

---

## Analyse de la doc Uniswap (Quickstart)

La [Quickstart Uniswap](https://developers.uniswap.org/docs/get-started/quickstart) propose 4 chemins d’intégration :

| Méthode | Complexité | Cas d’usage |
|--------|------------|-------------|
| **Custom Linking** | Très bas | Rediriger l’utilisateur vers l’UI Uniswap |
| **Uniswap API** | Bas | DApps, wallets, **bots / agents** ← ce bot |
| **SDK v4** | Moyen | Contrôle local des routes / quotes |
| **Solidity** | Haut | Logique on-chain (arbitrage, protocoles) |

### Flow API (utilisé ici)

```
1. POST /check_approval   → approval ERC20 → Permit2 si besoin
2. POST /quote            → meilleure route (AMM v2/v3/v4 ou UniswapX)
3. Sign EIP-712 Permit2   → si permitData présent
4a. POST /swap + broadcast → routing CLASSIC / WRAP / UNWRAP
4b. POST /order            → routing DUTCH_V2 / DUTCH_V3 / PRIORITY (UniswapX)
```

### Robinhood Chain

| Propriété | Valeur |
|-----------|--------|
| Chain ID | **4663** (mainnet) / 46630 (testnet) |
| Gas token | ETH |
| RPC public | `https://rpc.mainnet.chain.robinhood.com` |
| Explorer | https://robinhoodchain.blockscout.com |
| Universal Router | `0x8876789976decbfcbbbe364623c63652db8c0904` (v2.1.1 only) |
| Uniswap | v2, v3, v4 + UniswapX V3 |
| ETH natif (API) | `0x0000000000000000000000000000000000000000` |

Uniswap est l’AMM public principal sur Robinhood Chain. Les tokens **pools.trade** graduent dans des pools **v4** à liquidité lockée — le bot interroge l’API qui route automatiquement vers ces pools.

---

## Lancer sur Termux (Android)

Guide complet : **[docs/TERMUX.md](./docs/TERMUX.md)**

```bash
pkg update -y && pkg install -y nodejs git nano
cd ~ && git clone https://github.com/hexdexrobin/robinhood-uniswap-bot.git
cd robinhood-uniswap-bot && npm install
cp .env.example .env && nano .env   # remplir API key + PRIVATE_KEY
# DRY_RUN=true pour tester sans vraie tx
npm start -- balance
npm start -- quote --in ETH --out 0xTOKEN --amount 0.0001 --amm-only
npm start -- swap --in ETH --out 0xTOKEN --amount 0.0001 --amm-only --dry-run
npm start -- watch-pnl --take-profit 100 --interval 10
```

---

## Prérequis

1. **Clé API Uniswap** gratuite : [developers.uniswap.org/dashboard](https://developers.uniswap.org/dashboard)
2. **Wallet** avec un peu d’**ETH** sur Robinhood Chain (gas + montant à swapper)
3. **Node.js ≥ 18** (PC, VPS, ou **Termux**)

> ⚠️ Ne jamais committer `.env` ni exposer `PRIVATE_KEY`.

---

## Installation

```bash
cd robinhood-uniswap-bot
cp .env.example .env
# Éditer .env : UNISWAP_API_KEY + PRIVATE_KEY

npm install
```

### `.env`

```env
UNISWAP_API_KEY=...
PRIVATE_KEY=0x...
RPC_URL=https://rpc.mainnet.chain.robinhood.com
CHAIN_ID=4663
SLIPPAGE_TOLERANCE=1.0
ROUTING_PREFERENCE=BEST_PRICE
DRY_RUN=false
```

---

## PnL & take-profit auto (+100% = x2)

À chaque **achat ETH → token**, le bot enregistre une position dans `data/positions.json` avec le coût d’entrée.

| Commande | Rôle |
|----------|------|
| `positions` | Liste open / closed |
| `pnl` | PnL live (quote token → ETH) |
| `watch-pnl` | Boucle : si PnL ≥ seuil → **vend tout** auto |

```bash
# Acheter (position trackée, TP 100% par défaut)
npm start -- swap --in ETH --out 0xTOKEN --amount 0.0005 --amm-only --take-profit 100

# Surveiller en continu et vendre tout à +100%
npm start -- watch-pnl --take-profit 100 --interval 10

# Acheter + lancer le watch tout de suite
npm start -- swap --in ETH --out 0xTOKEN --amount 0.0005 --amm-only --auto-watch --interval 10

# Importer une position déjà en wallet (si achetée avant)
npm start -- watch-pnl --token 0xTOKEN --cost 0.0007 --take-profit 100 --interval 10
```

**Formule PnL** :  
`pnl% = (valeur_actuelle_ETH − coût_ETH) / coût_ETH × 100`  
→ **+100%** = la valeur a doublé (x2).

`.env` :
```env
TAKE_PROFIT_PCT=100
PNL_POLL_INTERVAL=10
```

> Laisse `watch-pnl` tourner (terminal / screen / tmux). Sans process actif, pas de vente auto.

---

## Utilisation

### 1. Voir le solde

```bash
npm start -- balance
npm start -- balance --token 0xAdresseDuToken
```

### 2. Quote (prix sans exécuter)

```bash
# ETH → token pools.trade (adresse du token après launch)
npm start -- quote \
  --in ETH \
  --out 0xTokenPoolsTrade... \
  --amount 0.01 \
  --amm-only
```

`--amm-only` force les protocoles **V2 / V3 / V4**. Recommandé pour les **nouveaux tokens** pools.trade :
- UniswapX exige souvent ~300 USDC équivalent
- Peu de fillers RFQ sur micro-caps / tokens tout juste lancés

### 3. Swap réel

```bash
# Toujours tester en dry-run d'abord
npm start -- swap \
  --in ETH \
  --out 0xTokenPoolsTrade... \
  --amount 0.01 \
  --amm-only \
  --dry-run

# Puis exécuter
npm start -- swap \
  --in ETH \
  --out 0xTokenPoolsTrade... \
  --amount 0.01 \
  --amm-only \
  --slippage 2
```

### 4. Token ERC20 → ETH

```bash
npm start -- swap \
  --in 0xToken... \
  --out ETH \
  --amount 1000 \
  --amm-only
```

### 5. Monitoring de prix (boucle)

```bash
npm start -- watch-quote \
  --in ETH \
  --out 0xToken... \
  --amount 0.01 \
  --amm-only \
  --interval 10
```

---

## Options CLI

| Flag | Description |
|------|-------------|
| `--in` | Token entrée (`ETH` ou `0x…`) |
| `--out` | Token sortie |
| `--amount` | Montant humain (ex. `0.01`) |
| `--slippage` | Slippage en % (défaut env) |
| `--amm-only` | Routes AMM only (idéal pools.trade) |
| `--dry-run` | Construit la tx sans broadcast |
| `--decimals` | Force les décimales tokenIn |
| `--interval` | Secondes pour `watch-quote` |

---

## Architecture du code

```
src/
  index.ts           CLI (quote / swap / balance / watch-quote)
  config.ts          Env, chain 4663, wallet, provider
  uniswap-client.ts  Client HTTP Trading API
  swap.ts            Flow complet approval → quote → permit → swap
  types.ts           Types TypeScript
```

---

## Tokens pools.trade

1. Va sur [pools.trade](https://pools.trade) et récupère l’**adresse du token** (après Instant Launch ou Crowd Launch gradué).
2. La liquidité est en pool **Uniswap v4** lockée sur Robinhood Chain.
3. Passe cette adresse en `--out` (achat) ou `--in` (vente).
4. Utilise **`--amm-only`** + slippage un peu large (`1–3%`) car ces paires sont volatiles.

Exemple :

```bash
npm start -- swap --in ETH --out 0xTON_TOKEN --amount 0.05 --amm-only --slippage 2.5
```

---

## Erreurs fréquentes

| Problème | Cause / solution |
|----------|------------------|
| `No quotes available` | Pas de liquidité, mauvais chainId, ou UniswapX min non atteint → `--amm-only` |
| `401` | Mauvaise / absente `UNISWAP_API_KEY` |
| Balance insuffisante | Manque ETH ou tokenIn |
| Tx revert | Slippage trop serré, quote périmé (>30s), balance changée |
| Simulation fail | Prix a bougé — relancer le quote |

---

## Sécurité

- Utilise un **wallet dédié** avec un budget limité (jamais ton cold wallet principal).
- Les memecoins / tokens pools.trade sont **extrêmement risqués** (scams, rugs, impôts illiquides malgré lock LP).
- Ce bot **ne** fait **pas** de sniping mempool, frontrunning, ou MEV offensif.
- Tu restes responsable des txs signées avec ta clé privée.

---

## Ressources

- [Quickstart Uniswap](https://developers.uniswap.org/docs/get-started/quickstart)
- [Swapping API – Getting Started](https://developers.uniswap.org/docs/trading/swapping-api/getting-started)
- [Integration Guide](https://developers.uniswap.org/docs/trading/swapping-api/integration-guide)
- [Supported Chains (Robinhood 4663)](https://developers.uniswap.org/docs/trading/swapping-api/supported-chains)
- [Uniswap live on Robinhood Chain](https://blog.uniswap.org/robinhood-chain-is-live)
- [pools.trade announcement](https://blog.uniswap.org/pools-trade-a-new-way-to-launch-on-robinhood-chain)
- [Robinhood Chain docs](https://docs.robinhood.com/chain/connecting/)

---

## Licence

MIT — usage à tes propres risques.
