import type { Company, Factor, FactorHistoryPoint, MarketSnapshot, MoatEvidence, Valuation } from "../shared/market";

export interface MarketEnv {
  AZURE_STORAGE_ACCOUNT?: string;
  AZURE_STORAGE_CONTAINER?: string;
  AZURE_STORAGE_SAS?: string;
  FINMIND_API_TOKEN?: string;
}

export type FundamentalBackfillStatus = {
  status: "not_started" | "running" | "success" | "failed";
  startedAt: string;
  finishedAt: string | null;
  completedCompanies: number;
  totalCompanies: number;
  currentTickers: string[];
  warnings: string[];
  error: string | null;
};

export type SyncStatus = {
  status: "not_started" | "success" | "failed" | "running";
  startedAt: string;
  finishedAt: string | null;
  companyCount: number | null;
  warnings: string[];
  error: string | null;
};

type RecordData = Record<string, string | number | null | undefined>;
type FinMindPerRow = { stock_id: string; PER: number | null; PBR: number | null; dividend_yield: number | null };
type FinMindFundamentalRow = { date: string; stock_id: string; type?: string; value?: number; revenue?: number; origin_name?: string };
type FundamentalMetric = {
  calculationVersion: 4;
  revenueYoY: number | null;
  roeTtm: number | null;
  roeTtmPriorYear: number | null;
  fcfTtm: number | null;
  netIncomeTtm: number | null;
  positiveNetIncomeQuarters: number;
  asOfDate: string | null;
  history: FundamentalHistoryPoint[];
  updatedAt: string;
};
type FundamentalHistoryPoint = {
  period: string;
  revenueYoY: number | null;
  roeTtm: number | null;
  roeTtmPriorYear: number | null;
  fcfTtm: number | null;
};
type FundamentalStore = { version: 1 | 2 | 3 | 4; updatedAt: string; metrics: Record<string, FundamentalMetric> };
type FactorHistoryStore = {
  version: 1;
  updatedAt: string;
  companies: Record<string, Record<string, FactorHistoryPoint[]>>;
};
type WeeklyValuationPoint = {
  week: string;
  capturedAt: string;
  asOfDate: string | null;
  closingPrice: number | null;
  peRatio: number | null;
  pbRatio: number | null;
  dividendYield: number | null;
};
type WeeklyValuationStore = { version: 1; updatedAt: string; companies: Record<string, WeeklyValuationPoint[]> };
const twseApi = "https://openapi.twse.com.tw/v1";
const sp500Constituents = "https://raw.githubusercontent.com/datasets/s-and-p-500-companies/main/data/constituents.csv";
const externalRequestTimeoutMs = 12_000;
const azureRequestTimeoutMs = 10_000;
const finMindApi = "https://api.finmindtrade.com/api/v4/data";
const fundamentalStartDate = "2023-01-01";
const backfillBatchSize = 10;
const backfillConcurrency = 2;
const factorHistoryLimit = 48;
const fundamentalHistoryFactorIds = new Set(["revenue-growth", "roe", "fcf", "roe-trend"]);
const weeklyValuationFactorIds = new Set(["valuation", "pb"]);
const factorNames = [
  ["revenue-growth", "營收成長率"], ["eps-growth", "EPS 成長"], ["roe", "ROE"],
  ["fcf", "自由現金流"], ["gross-margin", "毛利率"], ["operating-margin", "營業利益率"],
  ["financial-safety", "財務安全"], ["roe-trend", "ROE 趨勢"], ["moat", "護城河"],
  ["valuation", "估值（PE）"], ["pb", "P/B 合理性"],
] as const;

function numberOf(value: unknown): number | null {
  const parsed = Number(String(value ?? "").replaceAll(",", ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function median(values: number[]): number | null {
  const ordered = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (ordered.length === 0) return null;
  const middle = Math.floor(ordered.length / 2);
  return ordered.length % 2 === 0 ? (ordered[middle - 1] + ordered[middle]) / 2 : ordered[middle];
}

function percent(value: number | null): string | null {
  return value === null ? null : `${value.toFixed(2)}%`;
}

function multiple(value: number | null): string | null {
  return value === null ? null : `${value.toFixed(2)}x`;
}

function unavailable(id: string, name: string): Factor {
  if (id === "moat") {
    return {
      id, name, state: "unavailable", value: null, benchmark: null, period: null,
      note: "採 5 項可追溯證據：獲利持續性、市占／競爭地位、轉換成本、無形資產、資本效率；至少取得 3 項來源後才評分。",
      source: "待補：年報、法說會、MOPS、專利／商標與產業報告",
    };
  }
  return { id, name, state: "unavailable", value: null, benchmark: null, period: null, note: "尚無可比較的已驗證資料", source: "待補資料來源" };
}

function comparisonState(value: number | null, benchmark: number | null, passes: boolean): Factor["state"] {
  if (value === null || benchmark === null) return "unavailable";
  return passes ? "pass" : "fail";
}

function grade(evaluatedCount: number, passedCount: number): Company["grade"] {
  if (evaluatedCount === 0) return "資料不足";
  if (passedCount >= 8) return "A";
  if (passedCount >= 5) return "B";
  return "C";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知錯誤";
}

async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit,
  source: string,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (controller.signal.aborted) throw new Error(`${source} 請求逾時（${Math.round(timeoutMs / 1000)} 秒）`);
    throw new Error(`${source} 連線失敗：${errorMessage(error).slice(0, 160)}`);
  } finally {
    clearTimeout(timeout);
  }
}

async function getJson<T>(url: string, source: string, headers?: HeadersInit): Promise<T> {
  const response = await fetchWithTimeout(url, { headers }, source, externalRequestTimeoutMs);
  if (!response.ok) throw new Error(`${source} 請求失敗：${response.status}`);
  return response.json() as Promise<T>;
}

type Sp500Constituent = { ticker: string; name: string; sector: string };

function sp500Company(company: Sp500Constituent): Company {
  return {
    ticker: company.ticker,
    name: company.name,
    market: "美股",
    industry: company.sector,
    currency: "USD",
    valuation: null,
    factors: factorNames.map(([id, label]) => unavailable(id, label)),
    evaluatedCount: 0,
    passedCount: 0,
    grade: "資料不足",
  };
}

function parseCsvRows(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quoted) {
      if (character === '"' && text[index + 1] === '"') {
        cell += '"';
        index += 1;
      } else if (character === '"') {
        quoted = false;
      } else {
        cell += character;
      }
    } else if (character === '"') {
      quoted = true;
    } else if (character === ",") {
      row.push(cell);
      cell = "";
    } else if (character === "\n") {
      row.push(cell.replace(/\r$/, ""));
      if (row.some((value) => value.length > 0)) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += character;
    }
  }
  if (quoted) throw new Error("S&P 500 CSV 格式不完整：引號未結束");
  row.push(cell.replace(/\r$/, ""));
  if (row.some((value) => value.length > 0)) rows.push(row);
  return rows;
}

async function getSp500Constituents(): Promise<Sp500Constituent[]> {
  const response = await fetchWithTimeout(sp500Constituents, {}, "S&P 500 成份股名單", externalRequestTimeoutMs);
  if (!response.ok) throw new Error(`S&P 500 成份股名單請求失敗：${response.status}`);
  const rows = parseCsvRows(await response.text());
  const [header, ...dataRows] = rows;
  const symbolIndex = header?.indexOf("Symbol") ?? -1;
  const securityIndex = header?.indexOf("Security") ?? -1;
  const sectorIndex = header?.indexOf("GICS Sector") ?? -1;
  if (symbolIndex < 0 || securityIndex < 0 || sectorIndex < 0) throw new Error("S&P 500 CSV 欄位不符預期格式");
  const constituents = dataRows.map((row) => ({
    ticker: (row[symbolIndex] ?? "").trim(),
    name: (row[securityIndex] ?? "").trim(),
    sector: (row[sectorIndex] ?? "").trim(),
  }));
  const validTicker = /^[A-Z][A-Z0-9.-]*$/;
  if (constituents.some((company) => !validTicker.test(company.ticker) || company.name.length === 0 || company.sector.length === 0)) {
    throw new Error("S&P 500 CSV 包含無效代號、公司名稱或產業欄位");
  }
  if (new Set(constituents.map((company) => company.ticker)).size !== constituents.length) throw new Error("S&P 500 CSV 包含重複代號");
  if (constituents.length < 500 || constituents.length > 505) throw new Error(`S&P 500 成份股筆數異常：${constituents.length}`);
  return constituents;
}

async function getFinMindPer(env: MarketEnv, date: string): Promise<Map<string, FinMindPerRow>> {
  if (!env.FINMIND_API_TOKEN) throw new Error("FinMind Token 尚未設定");
  const url = new URL("https://api.finmindtrade.com/api/v4/data");
  url.search = new URLSearchParams({ dataset: "TaiwanStockPER", start_date: date, end_date: date }).toString();
  const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${env.FINMIND_API_TOKEN}` } }, "FinMind 估值資料", externalRequestTimeoutMs);
  if (!response.ok) throw new Error(`FinMind 估值資料請求失敗：${response.status}`);
  const payload = await response.json() as { status: number; msg: string; data?: FinMindPerRow[] };
  if (payload.status !== 200 || !payload.data) throw new Error(`FinMind 估值資料不可用：${payload.msg}`);
  return new Map(payload.data.map((row) => [row.stock_id, row]));
}

async function getFinMindFundamental(
  env: MarketEnv,
  dataset: "TaiwanStockMonthRevenue" | "TaiwanStockFinancialStatements" | "TaiwanStockBalanceSheet" | "TaiwanStockCashFlowsStatement",
  ticker: string,
): Promise<FinMindFundamentalRow[]> {
  if (!env.FINMIND_API_TOKEN) throw new Error("FinMind Token 尚未設定");
  const url = new URL(finMindApi);
  url.search = new URLSearchParams({ dataset, data_id: ticker, start_date: fundamentalStartDate }).toString();
  const response = await fetchWithTimeout(url, { headers: { Authorization: `Bearer ${env.FINMIND_API_TOKEN}` } }, `FinMind ${dataset} ${ticker}`, externalRequestTimeoutMs);
  if (!response.ok) throw new Error(`FinMind ${dataset} ${ticker} 請求失敗：${response.status}`);
  const payload = await response.json() as { status: number; msg: string; data?: FinMindFundamentalRow[] };
  if (payload.status !== 200 || !payload.data) throw new Error(`FinMind ${dataset} ${ticker} 不可用：${payload.msg}`);
  return payload.data;
}

function metricValue(rows: FinMindFundamentalRow[], date: string, types: string[]): number | null {
  const matched = rows.find((row) => row.date === date && row.type !== undefined && types.includes(row.type));
  return matched?.value ?? null;
}

function quarterValues(rows: FinMindFundamentalRow[], types: string[]): Array<{ date: string; value: number }> {
  const byDate = new Map<string, number>();
  for (const row of rows) if (row.type !== undefined && row.value !== undefined && types.includes(row.type)) byDate.set(row.date, row.value);
  const dates = [...byDate.keys()].sort();
  const previousYtd = new Map<string, number>();
  return dates.map((date) => {
    const year = date.slice(0, 4);
    const value = byDate.get(date) ?? 0;
    const previous = previousYtd.get(year) ?? 0;
    previousYtd.set(year, value);
    return { date, value: value - previous };
  });
}

function trailingSum(values: Array<{ date: string; value: number }>, endIndex: number): number | null {
  if (endIndex < 3) return null;
  return values.slice(endIndex - 3, endIndex + 1).reduce((total, item) => total + item.value, 0);
}

function priorYearPeriod(date: string): string | null {
  const matched = date.match(/^(\d{4})(-\d{2}-\d{2})$/);
  return matched ? `${Number(matched[1]) - 1}${matched[2]}` : null;
}

function calculateFundamentalMetric(
  revenueRows: FinMindFundamentalRow[],
  incomeRows: FinMindFundamentalRow[],
  balanceRows: FinMindFundamentalRow[],
  cashRows: FinMindFundamentalRow[],
): FundamentalMetric {
  const revenueByMonth = new Map<string, number>();
  for (const row of revenueRows) {
    const revenue = row.revenue ?? row.value;
    if (revenue !== undefined) revenueByMonth.set(row.date.slice(0, 7), revenue);
  }
  const latestMonth = [...revenueByMonth.keys()].sort().at(-1) ?? null;
  const priorMonth = latestMonth ? `${Number(latestMonth.slice(0, 4)) - 1}${latestMonth.slice(4)}` : null;
  const currentRevenue = latestMonth ? revenueByMonth.get(latestMonth) ?? null : null;
  const priorRevenue = priorMonth ? revenueByMonth.get(priorMonth) ?? null : null;
  const revenueYoY = currentRevenue !== null && priorRevenue !== null && priorRevenue !== 0 ? (currentRevenue - priorRevenue) / Math.abs(priorRevenue) * 100 : null;

  const income = quarterValues(incomeRows, ["IncomeAfterTaxes"]);
  const operatingCash = quarterValues(cashRows, ["CashFlowsFromOperatingActivities"]);
  const capitalExpense = quarterValues(cashRows, ["PropertyAndPlantAndEquipment", "AcquisitionOfPropertyPlantAndEquipment"]);
  const dateSet = new Set([...income.map((item) => item.date), ...operatingCash.map((item) => item.date)]);
  const dates = [...dateSet].sort();
  const roeSeries: Array<{ date: string; value: number }> = [];
  const fcfSeries: Array<{ date: string; value: number }> = [];
  for (const date of dates) {
    const incomeIndex = income.findIndex((item) => item.date === date);
    const cashIndex = operatingCash.findIndex((item) => item.date === date);
    const capexIndex = capitalExpense.findIndex((item) => item.date === date);
    const netIncomeTtm = trailingSum(income, incomeIndex);
    const cashFlowTtm = trailingSum(operatingCash, cashIndex);
    const capexTtm = trailingSum(capitalExpense, capexIndex);
    // A balance sheet has many rows for every reporting date.  De-duplicate
    // first; otherwise `length - 5` points to another field from the latest
    // quarter rather than the equity balance one year earlier.
    const balanceDates = [...new Set(balanceRows.filter((row) => row.date <= date).map((row) => row.date))].sort();
    const currentEquityDate = balanceDates.at(-1) ?? null;
    const firstEquityDate = currentEquityDate ? priorYearPeriod(currentEquityDate) : null;
    const equityTypes = ["TotalEquity", "Equity", "EquityAttributableToOwnersOfParent"];
    const currentEquity = currentEquityDate ? metricValue(balanceRows, currentEquityDate, equityTypes) : null;
    const firstEquity = firstEquityDate ? metricValue(balanceRows, firstEquityDate, equityTypes) : null;
    if (netIncomeTtm !== null && currentEquity !== null && firstEquity !== null && currentEquity + firstEquity !== 0) roeSeries.push({ date, value: netIncomeTtm / ((currentEquity + firstEquity) / 2) * 100 });
    if (cashFlowTtm !== null && capexTtm !== null) fcfSeries.push({ date, value: cashFlowTtm - Math.abs(capexTtm) });
  }
  const latestRoe = roeSeries.at(-1) ?? null;
  const priorRoeDate = latestRoe ? priorYearPeriod(latestRoe.date) : null;
  const priorRoe = priorRoeDate ? roeSeries.find((item) => item.date === priorRoeDate) ?? null : null;
  const latestFcf = fcfSeries.at(-1) ?? null;
  const latestIncomeIndex = income.length - 1;
  const latestIncomeTtm = trailingSum(income, latestIncomeIndex);
  const latestIncomeQuarters = income.slice(-4);
  const positiveNetIncomeQuarters = latestIncomeQuarters.length === 4
    ? latestIncomeQuarters.filter((item) => item.value > 0).length
    : 0;
  const historyByPeriod = new Map<string, FundamentalHistoryPoint>();
  const historyEntry = (period: string): FundamentalHistoryPoint => {
    const existing = historyByPeriod.get(period);
    if (existing) return existing;
    const created: FundamentalHistoryPoint = { period, revenueYoY: null, roeTtm: null, roeTtmPriorYear: null, fcfTtm: null };
    historyByPeriod.set(period, created);
    return created;
  };
  for (const month of [...revenueByMonth.keys()].sort()) {
    if (month < "2024-01") continue;
    const previousMonth = `${Number(month.slice(0, 4)) - 1}${month.slice(4)}`;
    const current = revenueByMonth.get(month) ?? null;
    const previous = revenueByMonth.get(previousMonth) ?? null;
    historyEntry(`${month}-01`).revenueYoY = current !== null && previous !== null && previous !== 0
      ? (current - previous) / Math.abs(previous) * 100
      : null;
  }
  for (const point of roeSeries) {
    if (point.date < "2024-01-01") continue;
    const entry = historyEntry(point.date);
    entry.roeTtm = point.value;
    entry.roeTtmPriorYear = roeSeries.find((candidate) => candidate.date === priorYearPeriod(point.date))?.value ?? null;
  }
  for (const point of fcfSeries) if (point.date >= "2024-01-01") historyEntry(point.date).fcfTtm = point.value;
  return {
    calculationVersion: 4,
    revenueYoY,
    roeTtm: latestRoe?.value ?? null,
    roeTtmPriorYear: priorRoe?.value ?? null,
    fcfTtm: latestFcf?.value ?? null,
    netIncomeTtm: latestIncomeTtm,
    positiveNetIncomeQuarters,
    asOfDate: latestRoe?.date ?? latestFcf?.date ?? income.at(-1)?.date ?? latestMonth,
    history: [...historyByPeriod.values()].sort((left, right) => left.period.localeCompare(right.period)),
    updatedAt: new Date().toISOString(),
  };
}

function buildMoatFactor(
  fundamental: FundamentalMetric | undefined,
  peerRoeTtm: number | null | undefined,
): Factor {
  const asOfDate = fundamental?.asOfDate;
  const evidence: MoatEvidence[] = [];

  if (asOfDate && fundamental?.netIncomeTtm !== null && fundamental?.netIncomeTtm !== undefined && fundamental.positiveNetIncomeQuarters === 4) {
    evidence.push({
      criterion: "獲利持續性",
      result: "supported",
      observation: "最近四季稅後淨利皆為正數。",
      source: "FinMind TaiwanStockFinancialStatements（公開財報資料）",
      sourceUrl: "https://finmind.github.io/taiwan_stock.html#taiwanstockfinancialstatements",
      asOfDate,
      confidence: "high",
    });
  }

  if (asOfDate && fundamental?.roeTtm !== null && fundamental?.roeTtm !== undefined && peerRoeTtm !== null && peerRoeTtm !== undefined) {
    const supported = fundamental.roeTtm >= peerRoeTtm && fundamental.roeTtm > 0;
    evidence.push({
      criterion: "資本效率",
      result: supported ? "supported" : "not_supported",
      observation: supported
        ? `最近四季 ROE ${fundamental.roeTtm.toFixed(2)}%，不低於同業中位數 ${peerRoeTtm.toFixed(2)}%。`
        : `最近四季 ROE ${fundamental.roeTtm.toFixed(2)}%，未達同業中位數 ${peerRoeTtm.toFixed(2)}%。`,
      source: "FinMind TaiwanStockFinancialStatements、TaiwanStockBalanceSheet（公開財報資料）",
      sourceUrl: "https://finmind.github.io/taiwan_stock.html#taiwanstockbalancesheet",
      asOfDate,
      confidence: "high",
    });
  }

  const supportedCount = evidence.filter((item) => item.result === "supported").length;
  const evidenceCount = evidence.length;
  return {
    id: "moat",
    name: "護城河",
    // Structured financial data can only validate two of the five criteria.
    // Keep the outcome unavailable until public evidence for the remaining
    // qualitative criteria is acquired; this avoids presenting an inference as fact.
    state: "unavailable",
    value: evidenceCount === 0 ? null : `${supportedCount}/${evidenceCount} 項量化佐證`,
    benchmark: null,
    period: asOfDate ?? null,
    note: evidenceCount === 0
      ? "尚無足夠的四季公開財報資料可驗證獲利持續性與資本效率。"
      : `已取得 ${evidenceCount} 項可追溯量化佐證；競爭地位、轉換成本與無形資產尚缺官方結構化證據。依規則暫不判定護城河強弱。`,
    source: evidenceCount === 0 ? "待補：公開年報、法說會、專利／商標與產業市占資料" : "FinMind 公開財報資料（詳見佐證）",
    evidence,
  };
}

function fundamentalFactorHistory(fundamental: FundamentalMetric | undefined, factorId: "revenue-growth" | "roe" | "fcf" | "roe-trend"): FactorHistoryPoint[] {
  if (!fundamental) return [];
  return (fundamental.history ?? []).flatMap((point) => {
    const value = factorId === "revenue-growth" ? percent(point.revenueYoY)
      : factorId === "roe" ? percent(point.roeTtm)
        : factorId === "fcf" ? point.fcfTtm === null ? null : `${(point.fcfTtm / 100_000_000).toFixed(0)} 億元`
          : point.roeTtm === null || point.roeTtmPriorYear === null ? null : `${point.roeTtm - point.roeTtmPriorYear >= 0 ? "+" : ""}${(point.roeTtm - point.roeTtmPriorYear).toFixed(2)} 個百分點`;
    if (value === null) return [];
    return [{ capturedAt: fundamental.updatedAt, state: "unavailable", value, benchmark: null, period: point.period }];
  });
}

function gregorianDate(rocDate: unknown): string | null {
  const matched = String(rocDate ?? "").match(/^(\d{3})(\d{2})(\d{2})$/);
  if (!matched) return null;
  return `${Number(matched[1]) + 1911}-${matched[2]}-${matched[3]}`;
}

function blobUrl(env: MarketEnv, name: string): URL {
  const account = env.AZURE_STORAGE_ACCOUNT;
  const container = env.AZURE_STORAGE_CONTAINER;
  const rawSas = env.AZURE_STORAGE_SAS?.trim();
  const extractedSas = rawSas?.match(/(?:^|;)SharedAccessSignature=([^;]+)/i)?.[1]
    ?? rawSas?.split("?").at(-1)?.replace(/^\?/, "");
  let sas = extractedSas;
  try {
    const decoded = extractedSas ? decodeURIComponent(extractedSas) : undefined;
    if (decoded && new URLSearchParams(decoded).has("sv")) sas = decoded;
  } catch {
    // Keep the original value; the format validation below produces a safe error.
  }
  if (!account || !container || !sas) throw new Error("Azure Blob Storage 環境變數尚未完整設定");
  if (!new URLSearchParams(sas).has("sv")) throw new Error("Azure SAS 格式無效");
  return new URL(`https://${account}.blob.core.windows.net/${container}/${name}?${sas}`);
}

export async function readSnapshot(env: MarketEnv): Promise<MarketSnapshot> {
  const response = await fetchWithTimeout(blobUrl(env, "current/market.json"), {
    headers: { "x-ms-version": "2023-11-03" },
  }, "Azure Blob 市場快照", azureRequestTimeoutMs);
  if (!response.ok) {
    const azureError = response.headers.get("x-ms-error-code");
    if (response.status === 404) throw new Error("市場快照尚未建立");
    throw new Error(`Azure Blob 讀取失敗：${response.status}${azureError ? ` (${azureError})` : ""}`);
  }
  const snapshot = await response.json() as MarketSnapshot;
  const usCompanies = snapshot.companies.filter((company) => company.market === "美股");
  if (usCompanies.length <= 505) return snapshot;

  const taiwanCompanies = snapshot.companies.filter((company) => company.market !== "美股");
  let constituents: Sp500Constituent[];
  try {
    constituents = await getSp500Constituents();
  } catch {
    return { ...snapshot, sources: snapshot.sources.filter((source) => !source.includes("SEC EDGAR")), companies: taiwanCompanies };
  }
  const migratedSnapshot: MarketSnapshot = {
    ...snapshot,
    sources: [...new Set([...snapshot.sources.filter((source) => !source.includes("SEC EDGAR")), "S&P 500 成份股開放資料（datasets/s-and-p-500-companies）"])],
    companies: [...taiwanCompanies, ...constituents.map(sp500Company)],
  };
  const usCount = migratedSnapshot.companies.filter((company) => company.market === "美股").length;
  if (taiwanCompanies.length !== 200 || usCount < 500 || usCount > 505) throw new Error("市場快照遷移驗證失敗");
  const backupName = `archive/current-market-before-sp500-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  await writeJsonBlob(env, backupName, snapshot);
  await writeSnapshot(env, migratedSnapshot);
  return migratedSnapshot;
}

async function writeSnapshot(env: MarketEnv, snapshot: MarketSnapshot): Promise<void> {
  await writeJsonBlob(env, "current/market.json", snapshot);
}

async function writeJsonBlob(env: MarketEnv, name: string, body: unknown): Promise<void> {
  const response = await fetchWithTimeout(blobUrl(env, name), {
    method: "PUT",
    headers: { "x-ms-blob-type": "BlockBlob", "x-ms-version": "2023-11-03", "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
  }, `Azure Blob 寫入 ${name}`, azureRequestTimeoutMs);
  if (!response.ok) {
    const azureError = response.headers.get("x-ms-error-code");
    throw new Error(`Azure Blob 寫入失敗：${response.status}${azureError ? ` (${azureError})` : ""}`);
  }
}

async function writeSyncStatus(env: MarketEnv, status: SyncStatus): Promise<string | null> {
  try {
    await writeJsonBlob(env, "status/market-sync.json", status);
    return null;
  } catch (error) {
    const message = `同步狀態寫入失敗：${errorMessage(error).slice(0, 180)}`;
    // Keep the cause in Worker logs when Azure is unavailable. Never log secrets.
    console.error(message);
    return message;
  }
}

async function readJsonBlob<T>(env: MarketEnv, name: string): Promise<T | null> {
  const response = await fetchWithTimeout(blobUrl(env, name), { headers: { "x-ms-version": "2023-11-03" } }, `Azure Blob 讀取 ${name}`, azureRequestTimeoutMs);
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Azure Blob 讀取失敗：${response.status}`);
  return response.json() as Promise<T>;
}

async function writeFundamentalBackfillStatus(env: MarketEnv, status: FundamentalBackfillStatus): Promise<void> {
  await writeJsonBlob(env, "status/fundamentals-backfill.json", status);
}

function calendarDay(isoDate: string): string {
  return isoDate.slice(0, 10);
}

function taiwanWeekKey(isoDate: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Taipei", year: "numeric", month: "2-digit", day: "2-digit" })
    .formatToParts(new Date(isoDate));
  const part = (type: Intl.DateTimeFormatPartTypes): string => parts.find((item) => item.type === type)?.value ?? "";
  const date = new Date(`${part("year")}-${part("month")}-${part("day")}T00:00:00Z`);
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + 3 - ((date.getUTCDay() + 6) % 7));
  const firstThursday = new Date(Date.UTC(thursday.getUTCFullYear(), 0, 4));
  const week = 1 + Math.round((thursday.getTime() - firstThursday.getTime()) / 604_800_000);
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

function isTaiwanWeeklyCloseCapture(isoDate: string): boolean {
  return new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Taipei", weekday: "short" }).format(new Date(isoDate)) === "Sat";
}

function hasHistoricalFundamentals(metric: FundamentalMetric | undefined): boolean {
  if (!metric?.history?.length) return false;
  return metric.history.some((point) => point.period >= "2024-01-01"
    && (point.revenueYoY !== null || point.roeTtm !== null || point.fcfTtm !== null));
}

function historyPoint(factor: Factor, capturedAt: string): FactorHistoryPoint {
  return {
    capturedAt,
    state: factor.state,
    value: factor.value,
    benchmark: factor.benchmark,
    period: factor.period,
  };
}

async function appendFactorHistory(env: MarketEnv, companies: Company[], capturedAt: string): Promise<Company[]> {
  const store = await readJsonBlob<FactorHistoryStore>(env, "history/factors/taiwan.json")
    ?? { version: 1, updatedAt: "", companies: {} };
  const captureDay = calendarDay(capturedAt);
  const companiesWithHistory = companies.map((company) => {
    const factorHistory = store.companies[company.ticker] ?? {};
    store.companies[company.ticker] = factorHistory;
    const factors = company.factors.map((factor) => {
      // Fundamental metrics already carry their own source-period history
      // (monthly revenue and quarterly TTM figures).  They must never be
      // replaced with repeated daily snapshots of the same fiscal period.
      if (fundamentalHistoryFactorIds.has(factor.id) && (factor.history?.length ?? 0) > 0) return factor;
      const points = factorHistory[factor.id] ?? [];
      if (weeklyValuationFactorIds.has(factor.id) && !isTaiwanWeeklyCloseCapture(capturedAt)) return { ...factor, history: points };
      const point = historyPoint({ ...factor, period: weeklyValuationFactorIds.has(factor.id) ? taiwanWeekKey(capturedAt) : factor.period }, capturedAt);
      const lastPoint = points.at(-1);
      const captureKey = weeklyValuationFactorIds.has(factor.id) ? taiwanWeekKey(capturedAt) : captureDay;
      const lastCaptureKey = lastPoint && (weeklyValuationFactorIds.has(factor.id) ? taiwanWeekKey(lastPoint.capturedAt) : calendarDay(lastPoint.capturedAt));
      const nextPoints = lastPoint && lastCaptureKey === captureKey
        ? [...points.slice(0, -1), point]
        : [...points, point].slice(-(weeklyValuationFactorIds.has(factor.id) ? 260 : factorHistoryLimit));
      factorHistory[factor.id] = nextPoints;
      return { ...factor, history: nextPoints };
    });
    return { ...company, factors };
  });
  store.updatedAt = capturedAt;
  await writeJsonBlob(env, "history/factors/taiwan.json", store);
  return companiesWithHistory;
}

async function appendWeeklyValuationHistory(env: MarketEnv, companies: Company[], capturedAt: string): Promise<void> {
  if (!isTaiwanWeeklyCloseCapture(capturedAt)) return;
  const store = await readJsonBlob<WeeklyValuationStore>(env, "history/valuations/taiwan.json")
    ?? { version: 1, updatedAt: "", companies: {} };
  const week = taiwanWeekKey(capturedAt);
  for (const company of companies) {
    if (company.market !== "台股" || !company.valuation) continue;
    const points = store.companies[company.ticker] ?? [];
    const nextPoint: WeeklyValuationPoint = {
      week, capturedAt, asOfDate: company.valuation.asOfDate, closingPrice: company.valuation.closingPrice,
      peRatio: company.valuation.peRatio, pbRatio: company.valuation.pbRatio, dividendYield: company.valuation.dividendYield,
    };
    store.companies[company.ticker] = points.at(-1)?.week === week
      ? [...points.slice(0, -1), nextPoint]
      : [...points, nextPoint].slice(-260);
  }
  store.updatedAt = capturedAt;
  await writeJsonBlob(env, "history/valuations/taiwan.json", store);
}

export async function readFundamentalBackfillStatus(env: MarketEnv): Promise<FundamentalBackfillStatus> {
  return await readJsonBlob<FundamentalBackfillStatus>(env, "status/fundamentals-backfill.json")
    ?? { status: "not_started", startedAt: "", finishedAt: null, completedCompanies: 0, totalCompanies: 0, currentTickers: [], warnings: [], error: null };
}

export async function runFundamentalBackfill(env: MarketEnv): Promise<void> {
  const snapshot = await readSnapshot(env);
  const tickers = snapshot.companies.filter((company) => company.market === "台股").map((company) => company.ticker).sort();
  const existing = await readJsonBlob<FundamentalStore>(env, "history/fundamentals/metrics.json")
    ?? { version: 4, updatedAt: "", metrics: {} };
  // Version 4 retains the 2024-onward financial history used by detail charts.
  // Re-fetch prior versions so snapshots never mix latest-only and historical metrics.
  const pending = tickers.filter((ticker) => {
    const metric = existing.metrics[ticker];
    return metric === undefined
      || metric.calculationVersion !== 4
      || metric.netIncomeTtm === undefined
      || metric.positiveNetIncomeQuarters === undefined
      || !hasHistoricalFundamentals(metric);
  });
  if (pending.length === 0) {
    await writeFundamentalBackfillStatus(env, { status: "success", startedAt: existing.updatedAt, finishedAt: new Date().toISOString(), completedCompanies: tickers.length, totalCompanies: tickers.length, currentTickers: [], warnings: [], error: null });
    return;
  }
  const batch = pending.slice(0, backfillBatchSize);
  const startedAt = new Date().toISOString();
  await writeFundamentalBackfillStatus(env, { status: "running", startedAt, finishedAt: null, completedCompanies: tickers.length - pending.length, totalCompanies: tickers.length, currentTickers: batch, warnings: [], error: null });
  const warnings: string[] = [];
  for (let offset = 0; offset < batch.length; offset += backfillConcurrency) {
    await Promise.all(batch.slice(offset, offset + backfillConcurrency).map(async (ticker) => {
      try {
        const [revenue, income, balance, cash] = await Promise.all([
          getFinMindFundamental(env, "TaiwanStockMonthRevenue", ticker),
          getFinMindFundamental(env, "TaiwanStockFinancialStatements", ticker),
          getFinMindFundamental(env, "TaiwanStockBalanceSheet", ticker),
          getFinMindFundamental(env, "TaiwanStockCashFlowsStatement", ticker),
        ]);
        existing.metrics[ticker] = calculateFundamentalMetric(revenue, income, balance, cash);
      } catch (error) {
        warnings.push(`${ticker}：${errorMessage(error).slice(0, 120)}`);
      }
    }));
  }
  existing.version = 4;
  existing.updatedAt = new Date().toISOString();
  await writeJsonBlob(env, "history/fundamentals/metrics.json", existing);
  const completedCompanies = tickers.filter((ticker) => {
    const metric = existing.metrics[ticker];
    return metric !== undefined
      && metric.calculationVersion === 4
      && metric.netIncomeTtm !== undefined
      && metric.positiveNetIncomeQuarters !== undefined
      && hasHistoricalFundamentals(metric);
  }).length;
  const remainingTickers = tickers.filter((ticker) => {
    const metric = existing.metrics[ticker];
    return metric === undefined
      || metric.calculationVersion !== 4
      || metric.netIncomeTtm === undefined
      || metric.positiveNetIncomeQuarters === undefined
      || !hasHistoricalFundamentals(metric);
  });
  await writeFundamentalBackfillStatus(env, {
    status: completedCompanies === tickers.length ? "success" : "running",
    startedAt,
    finishedAt: completedCompanies === tickers.length ? new Date().toISOString() : null,
    completedCompanies,
    totalCompanies: tickers.length,
    currentTickers: completedCompanies === tickers.length ? [] : remainingTickers.slice(0, backfillBatchSize),
    warnings,
    error: null,
  });
}

export async function readSyncStatus(env: MarketEnv): Promise<SyncStatus> {
  const response = await fetchWithTimeout(blobUrl(env, "status/market-sync.json"), {
    headers: { "x-ms-version": "2023-11-03" },
  }, "Azure Blob 同步狀態", azureRequestTimeoutMs);
  if (response.status === 404) {
    return { status: "not_started", startedAt: "", finishedAt: null, companyCount: null, warnings: [], error: null };
  }
  if (!response.ok) throw new Error(`同步狀態讀取失敗：${response.status}`);
  return response.json() as Promise<SyncStatus>;
}

export async function syncMarketSnapshot(env: MarketEnv): Promise<MarketSnapshot> {
  const [valuations, prices, income, balance, basics] = await Promise.all([
    getJson<RecordData[]>(`${twseApi}/exchangeReport/BWIBBU_ALL`, "TWSE 本益比、殖利率及股價淨值比"),
    getJson<RecordData[]>(`${twseApi}/exchangeReport/STOCK_DAY_ALL`, "TWSE 每日收盤價"),
    getJson<RecordData[]>(`${twseApi}/opendata/t187ap06_L_ci`, "TWSE 綜合損益表"),
    getJson<RecordData[]>(`${twseApi}/opendata/t187ap07_L_ci`, "TWSE 資產負債表"),
    getJson<RecordData[]>(`${twseApi}/opendata/t187ap03_L`, "TWSE 上市公司基本資料"),
  ]);

  const priceByTicker = new Map(prices.map((row) => [String(row.Code), row]));
  const incomeByTicker = new Map(income.map((row) => [String(row["公司代號"]), row]));
  const balanceByTicker = new Map(balance.map((row) => [String(row["公司代號"]), row]));
  const basicByTicker = new Map(basics.map((row) => [String(row["公司代號"]), row]));
  const warnings: string[] = [];
  const finMindDate = gregorianDate(valuations[0]?.Date);
  let finMindPerByTicker = new Map<string, FinMindPerRow>();
  if (finMindDate) {
    try {
      finMindPerByTicker = await getFinMindPer(env, finMindDate);
    } catch (error) {
      warnings.push(`FinMind 估值資料暫時不可用，已改用 TWSE 估值欄位（${errorMessage(error).slice(0, 160)}）。`);
    }
  } else {
    warnings.push("無法辨識 TWSE 資料日期，未取得 FinMind 估值資料。");
  }

  let sp500Companies: Sp500Constituent[] = [];
  let fallbackUsCompanies: Company[] = [];
  try {
    sp500Companies = await getSp500Constituents();
  } catch (error) {
    try {
      const existingSnapshot = await readSnapshot(env);
      const existingUsCompanies = existingSnapshot.companies.filter((company) => company.market === "美股");
      if (existingUsCompanies.length >= 500 && existingUsCompanies.length <= 505) fallbackUsCompanies = existingUsCompanies;
      if (fallbackUsCompanies.length > 0) {
        warnings.push(`S&P 500 成份股名單暫時不可用，已保留前次已驗證的 ${fallbackUsCompanies.length} 檔美股名單（${errorMessage(error).slice(0, 160)}）。`);
      } else {
        warnings.push(`S&P 500 成份股名單暫時不可用，且前次快照沒有 500 至 505 檔的已驗證美股名單（${errorMessage(error).slice(0, 160)}）。`);
      }
    } catch (fallbackError) {
      warnings.push(`S&P 500 成份股名單暫時不可用，且無法讀取前次快照作為備援（來源：${errorMessage(error).slice(0, 120)}；備援：${errorMessage(fallbackError).slice(0, 120)}）。`);
    }
  }

  const rawTwCompanies = valuations.map((row) => {
    const ticker = String(row.Code);
    const statement = incomeByTicker.get(ticker);
    const sheet = balanceByTicker.get(ticker);
    const basic = basicByTicker.get(ticker);
    const price = priceByTicker.get(ticker);
    const finMindPer = finMindPerByTicker.get(ticker);
    const revenue = numberOf(statement?.["營業收入"]);
    const grossProfit = numberOf(statement?.["營業毛利（毛損）淨額"]);
    const operatingProfit = numberOf(statement?.["營業利益（損失）"]);
    const liabilities = numberOf(sheet?.["負債總計"]);
    const assets = numberOf(sheet?.["資產總計"]);
    const closingPrice = numberOf(price?.ClosingPrice);
    const sharesOutstanding = numberOf(basic?.["已發行普通股數或TDR原股發行股數"]);
    const marketCapTwd = closingPrice !== null && sharesOutstanding !== null ? closingPrice * sharesOutstanding : null;
    return {
      ticker, name: String(row.Name), industry: String(basic?.["產業別"] ?? "未分類"), row, statement, sheet,
      grossMargin: revenue && grossProfit !== null ? grossProfit / revenue * 100 : null,
      operatingMargin: revenue && operatingProfit !== null ? operatingProfit / revenue * 100 : null,
      debtRatio: assets && liabilities !== null ? liabilities / assets * 100 : null,
      eps: numberOf(statement?.["基本每股盈餘（元）"]), pe: finMindPer?.PER ?? numberOf(row.PEratio), pb: finMindPer?.PBR ?? numberOf(row.PBratio),
      dividendYield: finMindPer?.dividend_yield ?? numberOf(row.DividendYield), closingPrice, sharesOutstanding, marketCapTwd,
      priceDate: price ? String(price.Date ?? "") : null, period: statement ? `${statement.年度 ?? ""} 年第 ${statement.季別 ?? ""} 季` : null,
    };
  });

  const topTwCompanies = rawTwCompanies
    .filter((company) => company.marketCapTwd !== null)
    .sort((left, right) => (right.marketCapTwd ?? 0) - (left.marketCapTwd ?? 0))
    .slice(0, 200)
    .map((company, index) => ({ ...company, marketCapRank: index + 1 }));

  const fundamentalStore = await readJsonBlob<FundamentalStore>(env, "history/fundamentals/metrics.json")
    ?? { version: 4, updatedAt: "", metrics: {} };

  const benchmarks = new Map<string, Record<string, number | null>>();
  for (const industry of new Set(topTwCompanies.map((company) => company.industry))) {
    const peers = topTwCompanies.filter((company) => company.industry === industry);
    benchmarks.set(industry, {
      grossMargin: median(peers.map((company) => company.grossMargin ?? Number.NaN)),
      operatingMargin: median(peers.map((company) => company.operatingMargin ?? Number.NaN)),
      debtRatio: median(peers.map((company) => company.debtRatio ?? Number.NaN)),
      pe: median(peers.map((company) => company.pe ?? Number.NaN)),
      pb: median(peers.map((company) => company.pb ?? Number.NaN)),
      revenueYoY: median(peers.map((company) => fundamentalStore.metrics[company.ticker]?.revenueYoY ?? Number.NaN)),
      roeTtm: median(peers.map((company) => fundamentalStore.metrics[company.ticker]?.roeTtm ?? Number.NaN)),
      fcfTtm: median(peers.map((company) => fundamentalStore.metrics[company.ticker]?.fcfTtm ?? Number.NaN)),
    });
  }

  const twCompanies: Company[] = topTwCompanies.map((company) => {
    const peer = benchmarks.get(company.industry) ?? {};
    const fundamental = fundamentalStore.metrics[company.ticker];
    const requiresFinancialModel = company.industry === "17";
    const valuation: Valuation = {
      asOfDate: company.priceDate,
      closingPrice: company.closingPrice,
      marketCapTwd: company.marketCapTwd,
      marketCapRank: company.marketCapRank,
      sharesOutstanding: company.sharesOutstanding,
      peRatio: company.pe,
      pbRatio: company.pb,
      dividendYield: company.dividendYield,
    };
    const measured: Factor[] = [
      { id: "revenue-growth", name: "營收成長率", state: comparisonState(fundamental?.revenueYoY ?? null, peer.revenueYoY ?? null, fundamental?.revenueYoY !== undefined && peer.revenueYoY !== undefined && fundamental.revenueYoY >= peer.revenueYoY), value: percent(fundamental?.revenueYoY ?? null), benchmark: peer.revenueYoY === null || peer.revenueYoY === undefined ? null : `同業中位數 ${percent(peer.revenueYoY)}`, period: fundamental?.asOfDate ?? null, note: "最新單月營收相較去年同月", source: "FinMind 月營收表", history: fundamentalFactorHistory(fundamental, "revenue-growth") },
      { id: "eps-growth", name: "EPS 成長", state: company.eps === null ? "unavailable" : company.eps > 0 ? "pass" : "fail", value: company.eps === null ? null : `${company.eps.toFixed(2)} 元`, benchmark: null, period: company.period, note: "目前季累計 EPS；成長趨勢需待歷史資料補齊", source: "TWSE 綜合損益表" },
      { id: "roe", name: "ROE", state: comparisonState(fundamental?.roeTtm ?? null, peer.roeTtm ?? null, fundamental?.roeTtm !== undefined && peer.roeTtm !== undefined && fundamental.roeTtm >= peer.roeTtm), value: percent(fundamental?.roeTtm ?? null), benchmark: peer.roeTtm === null || peer.roeTtm === undefined ? null : `同業中位數 ${percent(peer.roeTtm)}`, period: fundamental?.asOfDate ?? null, note: "最近四季稅後淨利 ÷ 平均股東權益", source: "FinMind 損益表、資產負債表", history: fundamentalFactorHistory(fundamental, "roe") },
      { id: "fcf", name: "自由現金流", state: comparisonState(fundamental?.fcfTtm ?? null, peer.fcfTtm ?? null, fundamental?.fcfTtm !== undefined && peer.fcfTtm !== undefined && fundamental.fcfTtm >= peer.fcfTtm), value: fundamental?.fcfTtm === null || fundamental?.fcfTtm === undefined ? null : `${(fundamental.fcfTtm / 100_000_000).toFixed(0)} 億元`, benchmark: peer.fcfTtm === null || peer.fcfTtm === undefined ? null : `同業中位數 ${(peer.fcfTtm / 100_000_000).toFixed(0)} 億元`, period: fundamental?.asOfDate ?? null, note: "最近四季營業現金流減資本支出", source: "FinMind 現金流量表", history: fundamentalFactorHistory(fundamental, "fcf") },
      { id: "gross-margin", name: "毛利率", state: comparisonState(company.grossMargin, peer.grossMargin ?? null, company.grossMargin !== null && peer.grossMargin !== null && company.grossMargin >= peer.grossMargin), value: percent(company.grossMargin), benchmark: peer.grossMargin === null ? null : `同業中位數 ${percent(peer.grossMargin)}`, period: company.period, note: "與同產業上市公司中位數比較", source: "TWSE 綜合損益表" },
      { id: "operating-margin", name: "營業利益率", state: comparisonState(company.operatingMargin, peer.operatingMargin ?? null, company.operatingMargin !== null && peer.operatingMargin !== null && company.operatingMargin >= peer.operatingMargin), value: percent(company.operatingMargin), benchmark: peer.operatingMargin === null ? null : `同業中位數 ${percent(peer.operatingMargin)}`, period: company.period, note: "與同產業上市公司中位數比較", source: "TWSE 綜合損益表" },
      { id: "financial-safety", name: "財務安全", state: comparisonState(company.debtRatio, peer.debtRatio ?? null, company.debtRatio !== null && peer.debtRatio !== null && company.debtRatio <= peer.debtRatio), value: company.debtRatio === null ? null : `負債比 ${percent(company.debtRatio)}`, benchmark: peer.debtRatio === null ? null : `同業中位數 ${percent(peer.debtRatio)}`, period: company.period, note: "目前以負債比作初步比較；金融業另行處理", source: "TWSE 資產負債表" },
      { id: "roe-trend", name: "ROE 趨勢", state: fundamental?.roeTtm === null || fundamental?.roeTtm === undefined || fundamental.roeTtmPriorYear === null || fundamental.roeTtmPriorYear === undefined ? "unavailable" : fundamental.roeTtm >= fundamental.roeTtmPriorYear ? "pass" : "fail", value: fundamental?.roeTtm === null || fundamental?.roeTtm === undefined || fundamental.roeTtmPriorYear === null || fundamental.roeTtmPriorYear === undefined ? null : `${fundamental.roeTtm - fundamental.roeTtmPriorYear >= 0 ? "+" : ""}${(fundamental.roeTtm - fundamental.roeTtmPriorYear).toFixed(2)} 個百分點`, benchmark: fundamental?.roeTtmPriorYear === null || fundamental?.roeTtmPriorYear === undefined ? null : `前一年 TTM ROE ${percent(fundamental.roeTtmPriorYear)}`, period: fundamental?.asOfDate ?? null, note: "最近四季 ROE 與前一年同期間比較", source: "FinMind 損益表、資產負債表", history: fundamentalFactorHistory(fundamental, "roe-trend") },
      buildMoatFactor(fundamental, peer.roeTtm),
      { id: "valuation", name: "估值（PE）", state: comparisonState(company.pe, peer.pe ?? null, company.pe !== null && company.pe > 0 && peer.pe !== null && company.pe <= peer.pe), value: multiple(company.pe), benchmark: peer.pe === null ? null : `同業中位數 ${multiple(peer.pe)}`, period: String(company.row.Date ?? ""), note: "正本益比且不高於同業中位數為初步通過", source: "TWSE 本益比、殖利率及股價淨值比" },
      { id: "pb", name: "P/B 合理性", state: comparisonState(company.pb, peer.pb ?? null, company.pb !== null && peer.pb !== null && company.pb <= peer.pb), value: multiple(company.pb), benchmark: peer.pb === null ? null : `同業中位數 ${multiple(peer.pb)}`, period: String(company.row.Date ?? ""), note: "目前以同業中位數比較；歷史分位數待補", source: "TWSE 本益比、殖利率及股價淨值比" },
    ];
    const factors = factorNames.map(([id, name]) => measured.find((factor) => factor.id === id) ?? unavailable(id, name));
    const evaluatedCount = factors.filter((factor) => factor.state !== "unavailable").length;
    const passedCount = factors.filter((factor) => factor.state === "pass").length;
    // Financial companies require a separate model (bank, insurance, broker,
    // and financial holding). Until that model and the matching official data
    // are available, do not turn an incomplete general-industry score into C.
    return {
      ticker: company.ticker, name: company.name, market: "台股", industry: company.industry, currency: "TWD", valuation, factors,
      evaluatedCount, passedCount, grade: requiresFinancialModel ? "資料不足" : grade(evaluatedCount, passedCount),
    };
  });

  const fetchedUsCompanies: Company[] = sp500Companies.map(sp500Company);
  const usCompanies = fetchedUsCompanies.length > 0 ? fetchedUsCompanies : fallbackUsCompanies;

  const sources = ["臺灣證券交易所 OpenAPI（收盤價、基本資料與財報）"];
  if (finMindPerByTicker.size > 0) sources.push("FinMind（PE、P/B、殖利率）");
  if (Object.keys(fundamentalStore.metrics).length > 0) sources.push("FinMind（公開月營收與財務報表；護城河量化佐證）");
  if (fetchedUsCompanies.length > 0) sources.push("S&P 500 成份股開放資料（datasets/s-and-p-500-companies）");
  if (fallbackUsCompanies.length > 0) sources.push("前次市場快照（已驗證 S&P 500 名單備援）");
  const generatedAt = new Date().toISOString();
  const twCompaniesWithHistory = await appendFactorHistory(env, twCompanies, generatedAt);
  await appendWeeklyValuationHistory(env, twCompaniesWithHistory, generatedAt);
  const snapshot: MarketSnapshot = { generatedAt, sources, companies: [...twCompaniesWithHistory, ...usCompanies] };
  await writeSnapshot(env, snapshot);
  if (warnings.length > 0) {
    await writeSyncStatus(env, { status: "success", startedAt: snapshot.generatedAt, finishedAt: new Date().toISOString(), companyCount: snapshot.companies.length, warnings, error: null });
  }
  return snapshot;
}

export async function runMarketSync(env: MarketEnv): Promise<void> {
  const startedAt = new Date().toISOString();
  await writeSyncStatus(env, { status: "running", startedAt, finishedAt: null, companyCount: null, warnings: [], error: null });
  try {
    const snapshot = await syncMarketSnapshot(env);
    const currentStatus = await readSyncStatus(env).catch(() => null);
    await writeSyncStatus(env, {
      status: "success",
      startedAt,
      finishedAt: new Date().toISOString(),
      companyCount: snapshot.companies.length,
      warnings: currentStatus?.status === "success" ? currentStatus.warnings : [],
      error: null,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "未知同步錯誤";
    await writeSyncStatus(env, { status: "failed", startedAt, finishedAt: new Date().toISOString(), companyCount: null, warnings: [], error: message.slice(0, 240) });
    throw error;
  }
}
