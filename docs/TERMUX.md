# Lancer le bot sur Termux (Android)

Guide pour installer, configurer et **tester** le bot sur [Termux](https://termux.dev).

---

## 1. Préparer Termux

```bash
pkg update -y
pkg install -y nodejs git nano
node -v
# besoin de Node ≥ 18
```

Si `node -v` est trop vieux :

```bash
pkg install -y nodejs-lts
```

---

## 2. Récupérer le code

```bash
cd ~
git clone https://github.com/hexdexrobin/robinhood-uniswap-bot.git
cd robinhood-uniswap-bot
npm install
```

Mise à jour plus tard :

```bash
cd ~/robinhood-uniswap-bot
git pull
npm install
```

---

## 3. Configurer le `.env` (secrets en local uniquement)

```bash
cp .env.example .env
nano .env
```

Remplis au minimum :

```env
UNISWAP_API_KEY=ta_cle_uniswap
PRIVATE_KEY=0xta_cle_privee
RPC_URL=https://rpc.mainnet.chain.robinhood.com
CHAIN_ID=4663
SLIPPAGE_TOLERANCE=2.0
DRY_RUN=true
TAKE_PROFIT_PCT=100
PNL_POLL_INTERVAL=10
```

Dans `nano` :

1. Colle tes valeurs  
2. `Ctrl+O` puis `Entrée` pour sauvegarder  
3. `Ctrl+X` pour quitter  

| Variable | Description |
|----------|-------------|
| `UNISWAP_API_KEY` | [Dashboard Uniswap](https://developers.uniswap.org/dashboard) |
| `PRIVATE_KEY` | Wallet **dédié** (pas ton cold wallet) |
| `DRY_RUN=true` | Test **sans** broadcaster de vraies txs |

> Envoie un peu d’**ETH sur Robinhood Chain** (chain ID **4663**), pas sur Ethereum mainnet.

---

## 4. Tests (sans risque si `DRY_RUN=true`)

```bash
cd ~/robinhood-uniswap-bot

# Aide
npm start -- --help

# Solde
npm start -- balance

# Quote (remplace par un vrai token)
npm start -- quote --in ETH --out 0xADRESSE_TOKEN --amount 0.0001 --amm-only

# Dry-run swap (ne broadcast pas)
npm start -- swap --in ETH --out 0xADRESSE_TOKEN --amount 0.0001 --amm-only --dry-run
```

---

## 5. Vrai swap (quand tu es prêt)

Dans `.env` :

```env
DRY_RUN=false
```

Puis :

```bash
npm start -- swap \
  --in ETH \
  --out 0xADRESSE_TOKEN \
  --amount 0.0001 \
  --amm-only \
  --slippage 2
```

---

## 6. PnL + vente auto à +100% (x2)

```bash
# Après un achat (position enregistrée auto)
npm start -- positions
npm start -- pnl

# Laisser tourner (ne ferme pas Termux)
npm start -- watch-pnl --take-profit 100 --interval 10
```

### Tourner en arrière-plan

```bash
cd ~/robinhood-uniswap-bot
nohup npm start -- watch-pnl --take-profit 100 --interval 10 > bot.log 2>&1 &
tail -f bot.log
```

Arrêter le process :

```bash
# trouver le PID
ps aux | grep watch-pnl
kill <PID>
```

---

## 7. Commandes utiles

| Action | Commande |
|--------|----------|
| Solde | `npm start -- balance` |
| Quote | `npm start -- quote --in ETH --out 0x… --amount 0.0001 --amm-only` |
| Achat | `npm start -- swap --in ETH --out 0x… --amount 0.0001 --amm-only` |
| Vente tout | `npm start -- swap --in 0x… --out ETH --amount MONTANT --amm-only` |
| Positions | `npm start -- positions` |
| PnL | `npm start -- pnl` |
| Auto TP x2 | `npm start -- watch-pnl --take-profit 100 --interval 10` |

---

## 8. Checklist test rapide

```bash
cd ~/robinhood-uniswap-bot
npm install
cp .env.example .env   # puis nano .env
npm start -- balance
npm start -- quote --in ETH --out 0xTOKEN --amount 0.0001 --amm-only
npm start -- swap --in ETH --out 0xTOKEN --amount 0.0001 --amm-only --dry-run
```

---

## 9. Problèmes fréquents sur Termux

| Problème | Solution |
|----------|----------|
| `npm: not found` | `pkg install nodejs` |
| Node trop vieux | `pkg install nodejs-lts` |
| Erreur réseau / fetch | Active données / Wi‑Fi ; parfois VPN |
| `401` Uniswap | Mauvaise ou absente `UNISWAP_API_KEY` |
| Balance 0 ETH | ETH sur **Robinhood Chain (4663)**, pas mainnet |
| `No quotes available` | Token sans liquidité, ou ajouter `--amm-only` |
| Termux tué en arrière-plan | Désactive l’optimisation batterie pour Termux |
| `EACCES` / permissions | Relance dans le home Termux `~/` |

---

## 10. Sécurité

- Ne **jamais** committer ni coller ta `PRIVATE_KEY` / token GitHub en public  
- Utilise un wallet de test avec un **petit** budget  
- Les tokens pools.trade / memecoins sont **très risqués**  
- Avec `watch-pnl`, le process doit **rester actif** pour vendre auto  

---

## Liens

- Repo : https://github.com/hexdexrobin/robinhood-uniswap-bot  
- Clé API Uniswap : https://developers.uniswap.org/dashboard  
- Explorer Robinhood Chain : https://robinhoodchain.blockscout.com  
