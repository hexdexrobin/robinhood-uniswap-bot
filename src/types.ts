/** Transaction prête à signer (retournée par /check_approval et /swap) */
export interface TransactionRequest {
  to: string;
  from: string;
  data: string;
  value: string;
  chainId: number;
  gasLimit?: string;
  maxFeePerGas?: string;
  maxPriorityFeePerGas?: string;
  gasPrice?: string;
}

export interface PermitData {
  domain: Record<string, unknown>;
  types: Record<string, Array<{ name: string; type: string }>>;
  values: Record<string, unknown>;
}

export type RoutingType =
  | "CLASSIC"
  | "DUTCH_V2"
  | "DUTCH_V3"
  | "PRIORITY"
  | "WRAP"
  | "UNWRAP"
  | "BRIDGE"
  | "CHAINED"
  | string;

export interface QuoteResponse {
  quote: Record<string, unknown>;
  permitData: PermitData | null;
  routing: RoutingType;
  requestId?: string;
}

export interface CheckApprovalResponse {
  approval: TransactionRequest | null;
  cancel?: TransactionRequest | null;
  requestId?: string;
}

export interface SwapResponse {
  swap: TransactionRequest;
  requestId?: string;
}

export interface OrderResponse {
  orderId?: string;
  orderHash?: string;
  requestId?: string;
  [key: string]: unknown;
}

export interface QuoteParams {
  tokenIn: string;
  tokenOut: string;
  amount: string;
  swapper: string;
  tokenInChainId: number;
  tokenOutChainId: number;
  type?: "EXACT_INPUT" | "EXACT_OUTPUT";
  slippageTolerance?: number;
  routingPreference?: string;
  /** Protocols optionnels: V2, V3, V4, UNISWAPX_V3… */
  protocols?: string[];
  permitAmount?: "FULL" | "EXACT";
}

export interface SwapArgs {
  tokenIn: string;
  tokenOut: string;
  /** Montant humain (ex: "0.01") — converti via decimals */
  amountHuman: string;
  /** Décimales tokenIn (18 pour ETH) */
  decimalsIn?: number;
  slippage?: number;
  dryRun?: boolean;
  /** Forcer uniquement les pools AMM (pas UniswapX) — utile pour petits montants / nouveaux tokens pools.trade */
  ammOnly?: boolean;
}
