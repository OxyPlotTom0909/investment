import type { Company, Factor, MarketSnapshot, Valuation } from "../shared/market";

export interface MarketEnv {
  AZURE_STORAGE_ACCOUNT?: string;
  AZURE_STORAGE_CONTAINER?: string;
  AZURE_STORAGE_SAS?: string;
  FINMIND_API_TOKEN?: string;
}

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
const twseApi = "https://openapi.twse.com.tw/v1";
const secTickers = "https://www.sec.gov/files/company_tickers_exchange.json";
const externalRequestTimeoutMs = 12_000;
const azureRequestTimeoutMs = 10_000;
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
  return { id, name, state: "unavailable", value: null, benchmark: null, period: null, note: "尚無可比較的已驗證資料", source: "待補資料來源" };
}

function comparisonState(value: number | null, benchmark: number | null, passes: boolean): Factor["state"] {
  if (value === null || benchmark === null) return "unavailable";
  return passes ? "pass" : "fail";
}

function grade(evaluatedCount: number, passedCount: number): Company["grade"] {
  if (evaluatedCount < 11) return "資料不足";
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

async function getFinMindPer(env: MarketEnv, date: string): Promise<Map<string, FinMindPerRow>> {
  if (!env.FINMIND_API_TOKEN) throw new Error("FinMind Token 尚未設定");
  const url = new URL("https://api.finmindtrade.com/api/v4/data");
  url.search = new URLSearchParams({ dataset: "TaiwanStockPER", start_date: date, end_date: date, token: env.FINMIND_API_TOKEN }).toString();
  const response = await fetchWithTimeout(url, {}, "FinMind 估值資料", externalRequestTimeoutMs);
  if (!response.ok) throw new Error(`FinMind 估值資料請求失敗：${response.status}`);
  const payload = await response.json() as { status: number; msg: string; data?: FinMindPerRow[] };
  if (payload.status !== 200 || !payload.data) throw new Error(`FinMind 估值資料不可用：${payload.msg}`);
  return new Map(payload.data.map((row) => [row.stock_id, row]));
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
  return response.json() as Promise<MarketSnapshot>;
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

  let usTickerData: { data: Array<[string, string, string, string]> } = { data: [] };
  try {
    usTickerData = await getJson<{ data: Array<[string, string, string, string]> }>(secTickers, "SEC 美股名單", { "User-Agent": "InvestmentCompass contact@bezierline.workers.dev" });
  } catch (error) {
    warnings.push(`SEC 美股名單暫時不可用，本次快照不含美股名單（${errorMessage(error).slice(0, 160)}）。`);
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

  const benchmarks = new Map<string, Record<string, number | null>>();
  for (const industry of new Set(topTwCompanies.map((company) => company.industry))) {
    const peers = topTwCompanies.filter((company) => company.industry === industry);
    benchmarks.set(industry, {
      grossMargin: median(peers.map((company) => company.grossMargin ?? Number.NaN)),
      operatingMargin: median(peers.map((company) => company.operatingMargin ?? Number.NaN)),
      debtRatio: median(peers.map((company) => company.debtRatio ?? Number.NaN)),
      pe: median(peers.map((company) => company.pe ?? Number.NaN)),
      pb: median(peers.map((company) => company.pb ?? Number.NaN)),
    });
  }

  const twCompanies: Company[] = topTwCompanies.map((company) => {
    const peer = benchmarks.get(company.industry) ?? {};
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
      { id: "eps-growth", name: "EPS 成長", state: company.eps === null ? "unavailable" : company.eps > 0 ? "pass" : "fail", value: company.eps === null ? null : `${company.eps.toFixed(2)} 元`, benchmark: null, period: company.period, note: "目前季累計 EPS；成長趨勢需待歷史資料補齊", source: "TWSE 綜合損益表" },
      { id: "gross-margin", name: "毛利率", state: comparisonState(company.grossMargin, peer.grossMargin ?? null, company.grossMargin !== null && peer.grossMargin !== null && company.grossMargin >= peer.grossMargin), value: percent(company.grossMargin), benchmark: peer.grossMargin === null ? null : `同業中位數 ${percent(peer.grossMargin)}`, period: company.period, note: "與同產業上市公司中位數比較", source: "TWSE 綜合損益表" },
      { id: "operating-margin", name: "營業利益率", state: comparisonState(company.operatingMargin, peer.operatingMargin ?? null, company.operatingMargin !== null && peer.operatingMargin !== null && company.operatingMargin >= peer.operatingMargin), value: percent(company.operatingMargin), benchmark: peer.operatingMargin === null ? null : `同業中位數 ${percent(peer.operatingMargin)}`, period: company.period, note: "與同產業上市公司中位數比較", source: "TWSE 綜合損益表" },
      { id: "financial-safety", name: "財務安全", state: comparisonState(company.debtRatio, peer.debtRatio ?? null, company.debtRatio !== null && peer.debtRatio !== null && company.debtRatio <= peer.debtRatio), value: company.debtRatio === null ? null : `負債比 ${percent(company.debtRatio)}`, benchmark: peer.debtRatio === null ? null : `同業中位數 ${percent(peer.debtRatio)}`, period: company.period, note: "目前以負債比作初步比較；金融業另行處理", source: "TWSE 資產負債表" },
      { id: "valuation", name: "估值（PE）", state: comparisonState(company.pe, peer.pe ?? null, company.pe !== null && company.pe > 0 && peer.pe !== null && company.pe <= peer.pe), value: multiple(company.pe), benchmark: peer.pe === null ? null : `同業中位數 ${multiple(peer.pe)}`, period: String(company.row.Date ?? ""), note: "正本益比且不高於同業中位數為初步通過", source: "TWSE 本益比、殖利率及股價淨值比" },
      { id: "pb", name: "P/B 合理性", state: comparisonState(company.pb, peer.pb ?? null, company.pb !== null && peer.pb !== null && company.pb <= peer.pb), value: multiple(company.pb), benchmark: peer.pb === null ? null : `同業中位數 ${multiple(peer.pb)}`, period: String(company.row.Date ?? ""), note: "目前以同業中位數比較；歷史分位數待補", source: "TWSE 本益比、殖利率及股價淨值比" },
    ];
    const factors = factorNames.map(([id, name]) => measured.find((factor) => factor.id === id) ?? unavailable(id, name));
    const evaluatedCount = factors.filter((factor) => factor.state !== "unavailable").length;
    const passedCount = factors.filter((factor) => factor.state === "pass").length;
    return { ticker: company.ticker, name: company.name, market: "台股", industry: company.industry, currency: "TWD", valuation, factors, evaluatedCount, passedCount, grade: grade(evaluatedCount, passedCount) };
  });

  const usCompanies: Company[] = usTickerData.data
    .filter(([, , , exchange]) => ["Nasdaq", "NYSE", "NYSE American"].includes(exchange))
    .map(([ticker, name, , exchange]) => ({ ticker, name, market: "美股", industry: exchange, currency: "USD", valuation: null, factors: factorNames.map(([id, label]) => unavailable(id, label)), evaluatedCount: 0, passedCount: 0, grade: "資料不足" }));

  const sources = ["臺灣證券交易所 OpenAPI（收盤價、基本資料與財報）"];
  if (finMindPerByTicker.size > 0) sources.push("FinMind（PE、P/B、殖利率）");
  if (usTickerData.data.length > 0) sources.push("SEC EDGAR company_tickers_exchange.json");
  const snapshot: MarketSnapshot = { generatedAt: new Date().toISOString(), sources, companies: [...twCompanies, ...usCompanies] };
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
