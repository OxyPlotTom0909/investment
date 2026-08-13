export type FactorState = "pass" | "fail" | "unavailable";

export type Factor = {
  id: string;
  name: string;
  state: FactorState;
  value: string | null;
  benchmark: string | null;
  period: string | null;
  note: string;
  source: string;
};

export type Company = {
  ticker: string;
  name: string;
  market: "台股" | "美股";
  industry: string;
  currency: "TWD" | "USD";
  factors: Factor[];
  evaluatedCount: number;
  passedCount: number;
  grade: "A" | "B" | "C" | "資料不足";
};

export type MarketSnapshot = {
  generatedAt: string;
  sources: string[];
  companies: Company[];
};
