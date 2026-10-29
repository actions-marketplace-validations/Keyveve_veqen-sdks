export interface Usage {
  /** Uncached input tokens. */
  inputTokens?: number;
  /** Output tokens, including reasoning tokens. */
  outputTokens?: number;
  cacheReadTokens?: number;
  /** 5-minute cache writes. */
  cacheWriteTokens?: number;
  cacheWrite1hTokens?: number;
  audioInputTokens?: number;
  audioOutputTokens?: number;
  /** Images for image models, seconds for video and transcription, characters for speech, queries for rerank, pages for OCR. */
  units?: number;
}
export interface CostOptions {
  provider?: string;
  batch?: boolean;
  serviceTier?: "standard" | "priority" | "flex" | string;
  residency?: "us" | string;
  /** An image size and quality ("hd/1024x1792") or a video resolution ("1080p"). */
  variant?: string;
}
export type Tags = { customer?: string; feature?: string; user?: string; project?: string; environment?: string; run?: string } & Record<string, string>;
export interface Price {
  key: string;
  provider: string;
  model: string;
  kind: "text" | "embedding" | "realtime" | "image" | "video" | "speech" | "transcription" | "rerank" | "ocr";
  unit?: "image" | "second" | "character" | "query" | "page";
  rates: Record<string, Record<string, number>>;
  context?: number;
  retires?: string;
  replacement?: string;
}
export interface LedgerEvent {
  id: string;
  ts: string;
  provider: string;
  model: string;
  cost_usd: number | null;
  [key: string]: unknown;
}
export declare class BudgetExceeded extends Error {
  scope: string;
  value: string;
  limitUsd: number;
}
export declare function init(options?: {
  apiKey?: string;
  endpoint?: string;
  environment?: string;
  ledgerFile?: string;
  flushIntervalMs?: number;
  budgetPollMs?: number;
}): void;
export declare function wrap<T>(client: T, defaults?: Tags & { residency?: string; provider?: string }): T;
export declare function withTags<R>(tags: Tags, fn: () => R): R;
export declare function currentTags(): Tags;
export declare function budget(
  limitUsd: number,
  scope?: { customer?: string; feature?: string; user?: string; project?: string; period?: "month" | "day"; mode?: "block" | "warn" },
): void;
export declare function record(
  provider: string | null,
  model: string,
  usage: Usage,
  options?: CostOptions & { tags?: Tags; latencyMs?: number; costUsd?: number; /** the provider key the call used: only its last four characters are sent */ providerKey?: string },
): LedgerEvent;
export declare function flush(): Promise<boolean>;
export interface SpendAction {
  agent: string;
  amount: number;
  currency?: string;
  payee?: string;
  purpose?: string;
  rail?: "card" | "ach" | "wire" | "stablecoin" | "invoice" | "other";
  kind?: "purchase" | "payment" | "transfer" | "subscription" | "refund" | "other";
  card?: string;
  run?: string;
}
export interface SpendDecision {
  decision: "allow" | "approval" | "deny";
  actionId: string;
  reasons: string[];
  approval?: { id: number; state: string; expires_at: string; note?: string | null } | null;
  remainingMonthUsd?: number | null;
  allowed: boolean;
}
export declare function checkSpend(action: SpendAction & { actionId?: string; onError?: "allow" | "deny" }): Promise<SpendDecision>;
export declare function recordAction(action: SpendAction & { action_id?: string; at?: string }): Promise<boolean>;
export declare function cost(model: string, usage: Usage, options?: CostOptions): number | null;
export declare function lookup(model: string, provider?: string): Price | null;
export declare function priceCall(price: Price, usage: Usage, options?: CostOptions): number | null;
export declare function unitRate(price: Price, variant?: string): number | null;
export declare function providerForUrl(url: string): string | null;
export declare const priceBook: { version: string; providers: Record<string, { name: string; group: string; pricing_url: string }>; models: Record<string, Omit<Price, "key" | "provider" | "model">> };
/** Vercel AI SDK middleware (import from "@veqen/sdk/ai-sdk"). */
export declare function veqen(defaults?: Tags): { wrapGenerate: (...args: any[]) => Promise<any>; wrapStream: (...args: any[]) => Promise<any> };
/** LangChain.js callback handler (import from "@veqen/sdk/langchain"). */
export declare class VeqenCallbackHandler { constructor(tags?: Tags); }
