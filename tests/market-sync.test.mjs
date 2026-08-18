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
  const blobs = new Map();
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
    if (url.hostname === "www.sec.gov") return new Response("unavailable", { status: 503 });
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
  assert.equal(snapshot.companies[0].grade, "B");
  assert.equal(status.status, "success");
  assert.match(status.warnings.join(" "), /FinMind/);
  assert.match(status.warnings.join(" "), /SEC/);
});

test("SEC 美股名單暫時失敗時保留前次快照的美股資料", async () => {
  const worker = await loadWorker();
  const originalFetch = globalThis.fetch;
  const previousUsCompany = {
    ticker: "MSFT", name: "Microsoft Corp.", market: "美股", industry: "Nasdaq", currency: "USD", valuation: null,
    factors: [], evaluatedCount: 0, passedCount: 0, grade: "資料不足",
  };
  const blobs = new Map([["current/market.json", {
    generatedAt: "2026-08-17T00:00:00.000Z", sources: ["SEC EDGAR company_tickers_exchange.json"], companies: [previousUsCompany],
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
    if (url.hostname === "www.sec.gov") return new Response("rate limited", { status: 429 });
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
  assert.deepEqual(snapshot.companies.map((company) => company.ticker).sort(), ["2330", "MSFT"]);
  assert.match(status.warnings.join(" "), /保留前次快照的 1 檔美股名單/);
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
