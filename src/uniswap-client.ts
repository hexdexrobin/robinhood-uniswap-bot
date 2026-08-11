import type {
  CheckApprovalResponse,
  OrderResponse,
  QuoteParams,
  QuoteResponse,
  SwapResponse,
} from "./types.js";

export class UniswapApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public body: unknown
  ) {
    super(message);
    this.name = "UniswapApiError";
  }
}

/**
 * Client HTTP pour Uniswap Trading API
 * Base: https://trade-api.gateway.uniswap.org/v1
 *
 * Flow standard:
 *  1. POST /check_approval
 *  2. POST /quote
 *  3. POST /swap  (CLASSIC/WRAP/UNWRAP/BRIDGE)  ou  POST /order (UniswapX)
 */
export class UniswapClient {
  constructor(
    private readonly apiKey: string,
    private readonly baseUrl: string
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      "x-api-key": this.apiKey,
      "Content-Type": "application/json",
      Accept: "application/json",
      // Robinhood Chain n'a que Universal Router 2.1.1 (défaut auto sur cette chain)
      "x-universal-router-version": "2.1.1",
      ...extra,
    };
  }

  private async post<T>(
    path: string,
    body: unknown,
    extraHeaders?: Record<string, string>
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const res = await fetch(url, {
      method: "POST",
      headers: this.headers(extraHeaders),
      body: JSON.stringify(body),
    });

    let data: unknown;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      const msg =
        typeof data === "object" &&
        data !== null &&
        "message" in data &&
        typeof (data as { message: unknown }).message === "string"
          ? (data as { message: string }).message
          : `HTTP ${res.status} on ${path}`;
      throw new UniswapApiError(msg, res.status, data);
    }

    return data as T;
  }

  private async get<T>(
    path: string,
    query?: Record<string, string>
  ): Promise<T> {
    const qs = query
      ? "?" + new URLSearchParams(query).toString()
      : "";
    const url = `${this.baseUrl}${path}${qs}`;
    const res = await fetch(url, {
      method: "GET",
      headers: this.headers(),
    });

    let data: unknown;
    const text = await res.text();
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw: text };
    }

    if (!res.ok) {
      throw new UniswapApiError(
        `HTTP ${res.status} on ${path}`,
        res.status,
        data
      );
    }
    return data as T;
  }

  /**
   * Vérifie si une approval ERC20 → Permit2 / router est nécessaire.
   * Si oui, retourne une tx prête à signer.
   */
  async checkApproval(params: {
    walletAddress: string;
    token: string;
    amount: string;
    chainId: number;
    tokenOut?: string;
    tokenOutChainId?: number;
  }): Promise<CheckApprovalResponse> {
    return this.post<CheckApprovalResponse>("/check_approval", params);
  }

  /**
   * Obtient le meilleur quote (route AMM ou UniswapX).
   * Pour ETH natif en entrée + UniswapX: passer enableErc20Eth=true.
   */
  async quote(
    params: QuoteParams,
    opts?: { enableErc20Eth?: boolean }
  ): Promise<QuoteResponse> {
    const extra = opts?.enableErc20Eth
      ? { "x-erc20eth-enabled": "true" }
      : undefined;
    return this.post<QuoteResponse>("/quote", params, extra);
  }

  /**
   * Construit la transaction AMM classic à partir du quote (+ permit optionnel).
   */
  async createSwap(params: {
    quote: Record<string, unknown>;
    signature?: string;
    permitData?: QuoteResponse["permitData"];
    refreshGasPrice?: boolean;
  }): Promise<SwapResponse> {
    const body: Record<string, unknown> = { quote: params.quote };
    if (params.signature !== undefined) {
      body.signature = params.signature;
    }
    if (params.permitData != null) {
      body.permitData = params.permitData;
    }
    if (params.refreshGasPrice) {
      body.refreshGasPrice = true;
    }
    return this.post<SwapResponse>("/swap", body);
  }

  /**
   * Soumet un ordre UniswapX (gasless, filled par market makers).
   */
  async createOrder(params: {
    quote: Record<string, unknown>;
    signature?: string;
  }, opts?: { enableErc20Eth?: boolean }): Promise<OrderResponse> {
    const extra = opts?.enableErc20Eth
      ? { "x-erc20eth-enabled": "true" }
      : undefined;
    return this.post<OrderResponse>("/order", params, extra);
  }

  /** Statut d'un swap AMM */
  async getSwaps(params: {
    txHashes?: string;
    swapper?: string;
    chainId?: string;
  }): Promise<unknown> {
    return this.get("/swaps", params as Record<string, string>);
  }

  /** Statut d'un ordre UniswapX */
  async getOrders(params: {
    orderHash?: string;
    swapper?: string;
    chainId?: string;
  }): Promise<unknown> {
    return this.get("/orders", params as Record<string, string>);
  }
}
