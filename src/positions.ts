import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { dirname, join } from "path";
import { fileURLToPath } from "url";
import { randomUUID } from "crypto";

const __dirname = dirname(fileURLToPath(import.meta.url));
export const POSITIONS_PATH =
  process.env.POSITIONS_PATH ?? join(__dirname, "..", "data", "positions.json");

export type PositionStatus = "open" | "closed";

export interface Position {
  id: string;
  token: string;
  symbol: string;
  /** Coût d'entrée en ETH (string décimal) */
  costEth: string;
  costEthWei: string;
  /** Quantité de tokens à l'ouverture / cumulée */
  tokenAmount: string;
  tokenAmountRaw: string;
  entryTxHash?: string;
  openedAt: string;
  status: PositionStatus;
  /** Seuil de take-profit en % de PnL (100 = x2) */
  takeProfitPct: number;
  closedAt?: string;
  exitTxHash?: string;
  exitEth?: string;
  realizedPnlPct?: number;
  realizedPnlEth?: string;
  notes?: string;
}

export interface PositionStore {
  updatedAt: string;
  positions: Position[];
}

function emptyStore(): PositionStore {
  return { updatedAt: new Date().toISOString(), positions: [] };
}

export function loadPositions(): PositionStore {
  try {
    if (!existsSync(POSITIONS_PATH)) return emptyStore();
    const raw = readFileSync(POSITIONS_PATH, "utf8");
    const data = JSON.parse(raw) as PositionStore;
    if (!Array.isArray(data.positions)) return emptyStore();
    return data;
  } catch {
    return emptyStore();
  }
}

export function savePositions(store: PositionStore): void {
  mkdirSync(dirname(POSITIONS_PATH), { recursive: true });
  store.updatedAt = new Date().toISOString();
  writeFileSync(POSITIONS_PATH, JSON.stringify(store, null, 2), "utf8");
}

function norm(addr: string): string {
  return addr.toLowerCase();
}

/**
 * Enregistre un achat ETH → token.
 * Si une position open existe déjà sur le même token, moyenne le coût (cumul).
 */
export function recordBuy(params: {
  token: string;
  symbol: string;
  costEth: string;
  costEthWei: string;
  tokenAmount: string;
  tokenAmountRaw: string;
  entryTxHash?: string;
  takeProfitPct?: number;
}): Position {
  const store = loadPositions();
  const token = norm(params.token);
  const existing = store.positions.find(
    (p) => p.status === "open" && norm(p.token) === token
  );

  if (existing) {
    const costWei =
      BigInt(existing.costEthWei) + BigInt(params.costEthWei);
    const tokRaw =
      BigInt(existing.tokenAmountRaw) + BigInt(params.tokenAmountRaw);
    existing.costEthWei = costWei.toString();
    existing.costEth = formatEthFromWei(costWei);
    existing.tokenAmountRaw = tokRaw.toString();
    existing.tokenAmount = formatTokenFromRaw(tokRaw, 18);
    existing.symbol = params.symbol || existing.symbol;
    if (params.entryTxHash) {
      existing.entryTxHash = params.entryTxHash;
    }
    if (params.takeProfitPct !== undefined) {
      existing.takeProfitPct = params.takeProfitPct;
    }
    existing.notes = `Averaged at ${new Date().toISOString()}`;
    savePositions(store);
    return existing;
  }

  const pos: Position = {
    id: randomUUID(),
    token: params.token,
    symbol: params.symbol,
    costEth: params.costEth,
    costEthWei: params.costEthWei,
    tokenAmount: params.tokenAmount,
    tokenAmountRaw: params.tokenAmountRaw,
    entryTxHash: params.entryTxHash,
    openedAt: new Date().toISOString(),
    status: "open",
    takeProfitPct: params.takeProfitPct ?? 100,
  };
  store.positions.push(pos);
  savePositions(store);
  return pos;
}

export function closePosition(params: {
  token: string;
  exitEth: string;
  exitTxHash?: string;
}): Position | null {
  const store = loadPositions();
  const token = norm(params.token);
  const pos = store.positions.find(
    (p) => p.status === "open" && norm(p.token) === token
  );
  if (!pos) return null;

  const cost = Number(pos.costEth);
  const exit = Number(params.exitEth);
  const pnlEth = exit - cost;
  const pnlPct = cost > 0 ? (pnlEth / cost) * 100 : 0;

  pos.status = "closed";
  pos.closedAt = new Date().toISOString();
  pos.exitEth = params.exitEth;
  pos.exitTxHash = params.exitTxHash;
  pos.realizedPnlEth = pnlEth.toFixed(18);
  pos.realizedPnlPct = Math.round(pnlPct * 100) / 100;
  savePositions(store);
  return pos;
}

export function getOpenPositions(tokenFilter?: string): Position[] {
  const store = loadPositions();
  return store.positions.filter((p) => {
    if (p.status !== "open") return false;
    if (tokenFilter) return norm(p.token) === norm(tokenFilter);
    return true;
  });
}

export function listAllPositions(): Position[] {
  return loadPositions().positions;
}

function formatEthFromWei(wei: bigint): string {
  const neg = wei < 0n;
  const v = neg ? -wei : wei;
  const whole = v / 10n ** 18n;
  const frac = (v % 10n ** 18n).toString().padStart(18, "0").replace(/0+$/, "");
  const s = frac ? `${whole}.${frac}` : whole.toString();
  return neg ? `-${s}` : s;
}

function formatTokenFromRaw(raw: bigint, decimals: number): string {
  const base = 10n ** BigInt(decimals);
  const whole = raw / base;
  const frac = (raw % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}
