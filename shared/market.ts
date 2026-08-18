export type FactorState = "pass" | "fail" | "unavailable";

export type EvidenceConfidence = "high" | "medium" | "low";

/**
 * A factual, traceable observation used by a qualitative assessment.  An
 * observation is deliberately not a conclusion that a company has a moat.
 */
export type MoatEvidence = {
  criterion: "獲利持續性" | "競爭地位" | "轉換成本" | "無形資產" | "資本效率";
  result: "supported" | "not_supported";
  observation: string;
  source: string;
  sourceUrl: string;
  asOfDate: string;
  confidence: EvidenceConfidence;
};

export type Factor = {
  id: string;
  name: string;
  state: FactorState;
  value: string | null;
  benchmark: string | null;
  period: string | null;
  note: string;
  source: string;
  evidence?: MoatEvidence[];
};

export type Valuation = {
  asOfDate: string | null;
  closingPrice: number | null;
  marketCapTwd: number | null;
  marketCapRank: number | null;
  sharesOutstanding: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  dividendYield: number | null;
};

export type Company = {
  ticker: string;
  name: string;
  market: "台股" | "美股";
  industry: string;
  currency: "TWD" | "USD";
  valuation: Valuation | null;
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
