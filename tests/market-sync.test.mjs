import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

test("尚未建立同步狀態檔時回傳 not_started，而非 running", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (input) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "testaccount.blob.core.windows.net") return new Response(null, { status: 404 });
    throw new Error(`Unexpected test request: ${url.hostname}`);
  };

  try {
    const response = await worker.fetch(new Request("https://example.test/api/market/status"), {
      AZURE_STORAGE_ACCOUNT: "testaccount",
      AZURE_STORAGE_CONTAINER: "market-data",
      AZURE_STORAGE_SAS: "sv=test&sig=not-a-secret",
    }, { waitUntil() {}, passThroughOnException() {} });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "not_started");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("排程在補充來源失敗時仍寫入台股快照與同步狀態", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const blobs = new Map([["history/fundamentals/metrics.json", {
    version: 2,
    updatedAt: "2026-08-18T00:00:00.000Z",
    metrics: {
      2330: {
        calculationVersion: 3,
        revenueYoY: 12,
        roeTtm: 20,
        roeTtmPriorYear: 18,
        fcfTtm: 100000000,
        netIncomeTtm: 120000000,
        positiveNetIncomeQuarters: 4,
        asOfDate: "2026-06-30",
        updatedAt: "2026-08-18T00:00:00.000Z",
      },
    },
  }]]);
  let scheduledPromise;
  const twsePayloads = {
    BWIBBU_ALL: [{ Code: "2330", Name: "台積電", Date: "1150814", PEratio: "20", PBratio: "5", DividendYield: "1.2" }],
    STOCK_DAY_ALL: [{ Code: "2330", ClosingPrice: "1000", Date: "1150814" }],
    t187ap06_L_ci: [{ 公司代號: "2330", 營業收入: "1000", "營業毛利（毛損）淨額": "500", "營業利益（損失）": "300", "基本每股盈餘（元）": "20", 年度: "115", 季別: "2" }],
    t187ap07_L_ci: [{ 公司代號: "2330", 資產總計: "1000", 負債總計: "300" }],
    t187ap03_L: [{ 公司代號: "2330", 產業別: "半導體業", "已發行普通股數或TDR原股發行股數": "1000000" }],
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "openapi.twse.com.tw") {
      const key = url.pathname.split("/").at(-1);
      return Response.json(twsePayloads[key]);
    }
    if (url.hostname === "raw.githubusercontent.com") return new Response("unavailable", { status: 503 });
    if (url.hostname === "api.finmindtrade.com") return new Response("unavailable", { status: 503 });
    if (url.hostname === "testaccount.blob.core.windows.net") {
      const key = url.pathname.replace("/market-data/", "");
      if ((init.method ?? "GET") === "PUT") {
        blobs.set(key, JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      const body = blobs.get(key);
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected test request: ${url.hostname}`);
  };

  try {
    await worker.scheduled({}, {
      AZURE_STORAGE_ACCOUNT: "testaccount",
      AZURE_STORAGE_CONTAINER: "market-data",
      AZURE_STORAGE_SAS: "sv=test&sig=not-a-secret",
      FINMIND_API_TOKEN: "test-token",
    }, {
      waitUntil(promise) { scheduledPromise = promise; },
      passThroughOnException() {},
    });
    await scheduledPromise;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const snapshot = blobs.get("current/market.json");
  const status = blobs.get("status/market-sync.json");
  assert.equal(snapshot.companies.length, 1);
  assert.equal(snapshot.companies[0].ticker, "2330");
  assert.ok(snapshot.companies[0].evaluatedCount > 0);
  assert.equal(snapshot.companies[0].grade, "A");
  const moat = snapshot.companies[0].factors.find((factor) => factor.id === "moat");
  const roe = snapshot.companies[0].factors.find((factor) => factor.id === "roe");
  assert.equal(moat.state, "unavailable");
  assert.equal(moat.value, "2/2 項量化佐證");
  assert.deepEqual(moat.evidence.map((item) => item.criterion), ["獲利持續性", "資本效率"]);
  assert.ok(moat.evidence.every((item) => item.asOfDate === "2026-06-30" && item.confidence === "high" && item.sourceUrl.startsWith("https://")));
  assert.deepEqual(roe.history, [{ capturedAt: snapshot.generatedAt, state: "pass", value: "20.00%", benchmark: "同業中位數 20.00%", period: "2026-06-30" }]);
  assert.equal(blobs.get("history/factors/taiwan.json").companies[2330].roe.length, 1);
  assert.equal(status.status, "success");
  assert.match(status.warnings.join(" "), /FinMind/);
  assert.match(status.warnings.join(" "), /S&P 500/);
});

test("ROE 以去年同期的平均權益計算，並略過同季重複欄位日期", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const blobs = new Map([["current/market.json", {
    generatedAt: "2026-08-01T00:00:00.000Z", sources: [], companies: [{ ticker: "2330", name: "台積電", market: "台股" }],
  }]]);
  let scheduledPromise;
  const income = [
    ["2025-09-30", 30], ["2025-12-31", 40], ["2026-03-31", 10], ["2026-06-30", 25],
  ].map(([date, value]) => ({ date, stock_id: "2330", type: "IncomeAfterTaxes", value }));
  const balance = [
    ["2025-06-30", 100], ["2025-09-30", 130], ["2025-12-31", 150], ["2026-03-31", 170], ["2026-06-30", 200],
  ].flatMap(([date, value]) => [
    { date, stock_id: "2330", type: "TotalEquity", value },
    { date, stock_id: "2330", type: "UnrelatedBalanceItem", value: 1 },
    { date, stock_id: "2330", type: "AnotherBalanceItem", value: 1 },
  ]);
  const cash = income.flatMap((row) => [
    { ...row, type: "CashFlowsFromOperatingActivities" },
    { ...row, type: "PropertyAndPlantAndEquipment", value: -1 },
  ]);
  const csvRows = ["Symbol,Security,GICS Sector"];
  for (let index = 0; index < 500; index += 1) csvRows.push(`SP${String(index).padStart(3, "0")},S&P Company ${index},Industrials`);
  const twsePayloads = {
    BWIBBU_ALL: [{ Code: "2330", Name: "台積電", Date: "1150814", PEratio: "20", PBratio: "5", DividendYield: "1.2" }],
    STOCK_DAY_ALL: [{ Code: "2330", ClosingPrice: "1000", Date: "1150814" }],
    t187ap06_L_ci: [{ 公司代號: "2330", 營業收入: "1000", "營業毛利（毛損）淨額": "500", "營業利益（損失）": "300", "基本每股盈餘（元）": "20", 年度: "115", 季別: "2" }],
    t187ap07_L_ci: [{ 公司代號: "2330", 資產總計: "1000", 負債總計: "300" }],
    t187ap03_L: [{ 公司代號: "2330", 產業別: "半導體業", "已發行普通股數或TDR原股發行股數": "1000000" }],
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "api.finmindtrade.com") {
      const dataset = url.searchParams.get("dataset");
      if (dataset === "TaiwanStockMonthRevenue") return Response.json({ status: 200, msg: "", data: [{ date: "2025-06-01", stock_id: "2330", revenue: 100 }, { date: "2026-06-01", stock_id: "2330", revenue: 120 }] });
      if (dataset === "TaiwanStockFinancialStatements") return Response.json({ status: 200, msg: "", data: income });
      if (dataset === "TaiwanStockBalanceSheet") return Response.json({ status: 200, msg: "", data: balance });
      if (dataset === "TaiwanStockCashFlowsStatement") return Response.json({ status: 200, msg: "", data: cash });
      return new Response("unavailable", { status: 503 });
    }
    if (url.hostname === "openapi.twse.com.tw") return Response.json(twsePayloads[url.pathname.split("/").at(-1)]);
    if (url.hostname === "raw.githubusercontent.com") return new Response(csvRows.join("\n"));
    if (url.hostname === "testaccount.blob.core.windows.net") {
      const key = url.pathname.replace("/market-data/", "");
      if ((init.method ?? "GET") === "PUT") {
        blobs.set(key, JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      const body = blobs.get(key);
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected test request: ${url.hostname}`);
  };
  try {
    await worker.scheduled({ cron: "*/10 * * * *" }, {
      AZURE_STORAGE_ACCOUNT: "testaccount", AZURE_STORAGE_CONTAINER: "market-data", AZURE_STORAGE_SAS: "sv=test&sig=not-a-secret", FINMIND_API_TOKEN: "test-token",
    }, { waitUntil(promise) { scheduledPromise = promise; }, passThroughOnException() {} });
    await scheduledPromise;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const metric = blobs.get("history/fundamentals/metrics.json").metrics[2330];
  assert.equal(metric.calculationVersion, 4);
  assert.equal(metric.roeTtm, 65 / 150 * 100);
  assert.ok(metric.history.some((point) => point.period === "2026-06-30" && point.roeTtm === 65 / 150 * 100));
});

test("S&P 500 成份股來源只保留已驗證的 S&P 500 名單，且失敗時使用前次已驗證名單", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const previousUsCompanies = Array.from({ length: 500 }, (_, index) => ({
    ticker: `SP${String(index).padStart(3, "0")}`, name: `S&P Company ${index}`, market: "美股", industry: "Industrials", currency: "USD", valuation: null,
    factors: [], evaluatedCount: 0, passedCount: 0, grade: "資料不足",
  }));
  const blobs = new Map([["current/market.json", {
    generatedAt: "2026-08-17T00:00:00.000Z", sources: ["S&P 500 成份股開放資料"], companies: previousUsCompanies,
  }]]);
  let scheduledPromise;
  const twsePayloads = {
    BWIBBU_ALL: [{ Code: "2330", Name: "台積電", Date: "1150814", PEratio: "20", PBratio: "5", DividendYield: "1.2" }],
    STOCK_DAY_ALL: [{ Code: "2330", ClosingPrice: "1000", Date: "1150814" }],
    t187ap06_L_ci: [{ 公司代號: "2330", 營業收入: "1000", "營業毛利（毛損）淨額": "500", "營業利益（損失）": "300", "基本每股盈餘（元）": "20", 年度: "115", 季別: "2" }],
    t187ap07_L_ci: [{ 公司代號: "2330", 資產總計: "1000", 負債總計: "300" }],
    t187ap03_L: [{ 公司代號: "2330", 產業別: "半導體業", "已發行普通股數或TDR原股發行股數": "1000000" }],
  };

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "openapi.twse.com.tw") return Response.json(twsePayloads[url.pathname.split("/").at(-1)]);
    if (url.hostname === "raw.githubusercontent.com") return new Response("rate limited", { status: 429 });
    if (url.hostname === "api.finmindtrade.com") return new Response("unavailable", { status: 503 });
    if (url.hostname === "testaccount.blob.core.windows.net") {
      const key = url.pathname.replace("/market-data/", "");
      if ((init.method ?? "GET") === "PUT") {
        blobs.set(key, JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      const body = blobs.get(key);
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected test request: ${url.hostname}`);
  };

  try {
    await worker.scheduled({}, {
      AZURE_STORAGE_ACCOUNT: "testaccount", AZURE_STORAGE_CONTAINER: "market-data", AZURE_STORAGE_SAS: "sv=test&sig=not-a-secret", FINMIND_API_TOKEN: "test-token",
    }, { waitUntil(promise) { scheduledPromise = promise; }, passThroughOnException() {} });
    await scheduledPromise;
  } finally {
    globalThis.fetch = originalFetch;
  }

  const snapshot = blobs.get("current/market.json");
  const status = blobs.get("status/market-sync.json");
  assert.equal(snapshot.companies.length, 501);
  assert.ok(snapshot.companies.some((company) => company.ticker === "SP000"));
  assert.match(status.warnings.join(" "), /保留前次已驗證的 500 檔美股名單/);
});

test("S&P 500 成份股來源會以產業欄位建立美股清單", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const blobs = new Map();
  let scheduledPromise;
  const csvRows = ["Symbol,Security,GICS Sector"];
  for (let index = 0; index < 500; index += 1) csvRows.push(`SP${String(index).padStart(3, "0")},S&P Company ${index},Industrials`);
  const twsePayloads = {
    BWIBBU_ALL: [{ Code: "2330", Name: "台積電", Date: "1150814", PEratio: "20", PBratio: "5", DividendYield: "1.2" }],
    STOCK_DAY_ALL: [{ Code: "2330", ClosingPrice: "1000", Date: "1150814" }],
    t187ap06_L_ci: [{ 公司代號: "2330", 營業收入: "1000", "營業毛利（毛損）淨額": "500", "營業利益（損失）": "300", "基本每股盈餘（元）": "20", 年度: "115", 季別: "2" }],
    t187ap07_L_ci: [{ 公司代號: "2330", 資產總計: "1000", 負債總計: "300" }],
    t187ap03_L: [{ 公司代號: "2330", 產業別: "半導體業", "已發行普通股數或TDR原股發行股數": "1000000" }],
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "openapi.twse.com.tw") return Response.json(twsePayloads[url.pathname.split("/").at(-1)]);
    if (url.hostname === "raw.githubusercontent.com") return new Response(csvRows.join("\n"));
    if (url.hostname === "api.finmindtrade.com") return new Response("unavailable", { status: 503 });
    if (url.hostname === "testaccount.blob.core.windows.net") {
      const key = url.pathname.replace("/market-data/", "");
      if ((init.method ?? "GET") === "PUT") {
        blobs.set(key, JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      const body = blobs.get(key);
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected test request: ${url.hostname}`);
  };
  try {
    await worker.scheduled({}, {
      AZURE_STORAGE_ACCOUNT: "testaccount", AZURE_STORAGE_CONTAINER: "market-data", AZURE_STORAGE_SAS: "sv=test&sig=not-a-secret", FINMIND_API_TOKEN: "test-token",
    }, { waitUntil(promise) { scheduledPromise = promise; }, passThroughOnException() {} });
    await scheduledPromise;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const snapshot = blobs.get("current/market.json");
  const usCompanies = snapshot.companies.filter((company) => company.market === "美股");
  assert.equal(usCompanies.length, 500);
  assert.equal(usCompanies[0].ticker, "SP000");
  assert.equal(usCompanies[0].name, "S&P Company 0");
  assert.equal(usCompanies[0].industry, "Industrials");
  assert.match(snapshot.sources.join(" "), /S&P 500 成份股開放資料/);
});

test("S&P 500 成份股來源筆數異常時不會混入舊的全美股清單", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const blobs = new Map();
  let scheduledPromise;
  const csvRows = ["Symbol,Security,GICS Sector"];
  for (let index = 0; index < 499; index += 1) csvRows.push(`SP${String(index).padStart(3, "0")},S&P Company ${index},Industrials`);
  const twsePayloads = {
    BWIBBU_ALL: [{ Code: "2330", Name: "台積電", Date: "1150814", PEratio: "20", PBratio: "5", DividendYield: "1.2" }],
    STOCK_DAY_ALL: [{ Code: "2330", ClosingPrice: "1000", Date: "1150814" }],
    t187ap06_L_ci: [{ 公司代號: "2330", 營業收入: "1000", "營業毛利（毛損）淨額": "500", "營業利益（損失）": "300", "基本每股盈餘（元）": "20", 年度: "115", 季別: "2" }],
    t187ap07_L_ci: [{ 公司代號: "2330", 資產總計: "1000", 負債總計: "300" }],
    t187ap03_L: [{ 公司代號: "2330", 產業別: "半導體業", "已發行普通股數或TDR原股發行股數": "1000000" }],
  };
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "openapi.twse.com.tw") return Response.json(twsePayloads[url.pathname.split("/").at(-1)]);
    if (url.hostname === "raw.githubusercontent.com") return new Response(csvRows.join("\n"));
    if (url.hostname === "api.finmindtrade.com") return new Response("unavailable", { status: 503 });
    if (url.hostname === "testaccount.blob.core.windows.net") {
      const key = url.pathname.replace("/market-data/", "");
      if ((init.method ?? "GET") === "PUT") {
        blobs.set(key, JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      const body = blobs.get(key);
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected test request: ${url.hostname}`);
  };
  try {
    await worker.scheduled({}, {
      AZURE_STORAGE_ACCOUNT: "testaccount", AZURE_STORAGE_CONTAINER: "market-data", AZURE_STORAGE_SAS: "sv=test&sig=not-a-secret", FINMIND_API_TOKEN: "test-token",
    }, { waitUntil(promise) { scheduledPromise = promise; }, passThroughOnException() {} });
    await scheduledPromise;
  } finally {
    globalThis.fetch = originalFetch;
  }
  const snapshot = blobs.get("current/market.json");
  const status = blobs.get("status/market-sync.json");
  assert.equal(snapshot.companies.filter((company) => company.market === "美股").length, 0);
  assert.match(status.warnings.join(" "), /筆數異常：499/);
});

test("讀取舊全美股快照時會先備份，再原子遷移成台股 200 檔與 S&P 500", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const taiwan = Array.from({ length: 200 }, (_, index) => ({ ticker: `${1000 + index}`, name: `台股 ${index}`, market: "台股", industry: "測試", currency: "TWD", factors: [], evaluatedCount: 0, passedCount: 0, grade: "資料不足" }));
  const legacyUs = Array.from({ length: 6000 }, (_, index) => ({ ticker: `US${index}`, name: `Legacy US ${index}`, market: "美股", industry: "Legacy", currency: "USD", factors: [], evaluatedCount: 0, passedCount: 0, grade: "資料不足" }));
  const blobs = new Map([["current/market.json", { generatedAt: "2026-08-01T00:00:00.000Z", sources: ["SEC EDGAR"], companies: [...taiwan, ...legacyUs] }]]);
  const csvRows = ["Symbol,Security,GICS Sector"];
  for (let index = 0; index < 500; index += 1) csvRows.push(`SP${String(index).padStart(3, "0")},S&P Company ${index},Industrials`);
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "raw.githubusercontent.com") return new Response(csvRows.join("\n"));
    if (url.hostname === "testaccount.blob.core.windows.net") {
      const key = url.pathname.replace("/market-data/", "");
      if ((init.method ?? "GET") === "PUT") { blobs.set(key, JSON.parse(String(init.body))); return new Response(null, { status: 201 }); }
      const body = blobs.get(key);
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected test request: ${url.hostname}`);
  };
  try {
    const response = await worker.fetch(new Request("https://example.test/api/market"), { AZURE_STORAGE_ACCOUNT: "testaccount", AZURE_STORAGE_CONTAINER: "market-data", AZURE_STORAGE_SAS: "sv=test&sig=not-a-secret" }, { waitUntil() {}, passThroughOnException() {} });
    const snapshot = await response.json();
    assert.equal(snapshot.companies.length, 700);
    assert.equal(snapshot.companies.filter((company) => company.market === "美股").length, 500);
    assert.equal(blobs.get("current/market.json").companies.length, 700);
    assert.ok([...blobs.keys()].some((key) => key.startsWith("archive/current-market-before-sp500-")));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("TWSE 請求逾時會結束同步並記錄可診斷失敗狀態", { timeout: 15_000 }, async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const blobs = new Map();
  let scheduledPromise;

  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname === "openapi.twse.com.tw") {
      return new Promise((_, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    }
    if (url.hostname === "testaccount.blob.core.windows.net") {
      const key = url.pathname.replace("/market-data/", "");
      if ((init.method ?? "GET") === "PUT") {
        blobs.set(key, JSON.parse(String(init.body)));
        return new Response(null, { status: 201 });
      }
      const body = blobs.get(key);
      return body ? Response.json(body) : new Response(null, { status: 404 });
    }
    throw new Error(`Unexpected test request: ${url.hostname}`);
  };

  try {
    await worker.scheduled({}, {
      AZURE_STORAGE_ACCOUNT: "testaccount",
      AZURE_STORAGE_CONTAINER: "market-data",
      AZURE_STORAGE_SAS: "sv=test&sig=not-a-secret",
    }, {
      waitUntil(promise) { scheduledPromise = promise; },
      passThroughOnException() {},
    });
    await assert.rejects(scheduledPromise, /TWSE.*請求逾時/);
  } finally {
    globalThis.fetch = originalFetch;
  }

  const status = blobs.get("status/market-sync.json");
  assert.equal(status.status, "failed");
  assert.match(status.error, /TWSE.*請求逾時/);
});
