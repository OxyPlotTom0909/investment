import assert from "node:assert/strict";
import test from "node:test";

async function loadWorker() {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  return (await import(workerUrl.href)).default;
}

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
  assert.equal(status.status, "success");
  assert.match(status.warnings.join(" "), /FinMind/);
  assert.match(status.warnings.join(" "), /SEC/);
});
