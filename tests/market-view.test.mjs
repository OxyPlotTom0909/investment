import assert from "node:assert/strict";
import test from "node:test";
import { companiesForDisplay, companyKey, filterCompanies, selectedCompany } from "../shared/market-view.mjs";

const companies = [
  { ticker: "2330", name: "台積電", market: "台股", grade: "A" },
  { ticker: "2317", name: "鴻海", market: "台股", grade: "B" },
  { ticker: "MSFT", name: "Microsoft", market: "美股", grade: "C" },
  { ticker: "TSLA", name: "Tesla", market: "美股", grade: "資料不足" },
];

test("市場與品質級別篩選會同時生效", () => {
  assert.deepEqual(filterCompanies(companies, "台股", "A").map((company) => company.ticker), ["2330"]);
  assert.deepEqual(filterCompanies(companies, "美股", "全部").map((company) => company.ticker), ["MSFT", "TSLA"]);
  assert.deepEqual(filterCompanies(companies, "全部", "資料不足").map((company) => company.ticker), ["TSLA"]);
});

test("切換篩選後保留可見選取項目，否則安全回退第一檔", () => {
  const taiwan = filterCompanies(companies, "台股", "全部");
  assert.equal(selectedCompany(taiwan, "台股:2317")?.ticker, "2317");
  assert.equal(selectedCompany(taiwan, "美股:MSFT")?.ticker, "2330");
  assert.equal(selectedCompany([], "台股:2330"), null);
});

test("不同市場的同代號使用市場前綴，避免選取衝突", () => {
  assert.equal(companyKey({ market: "台股", ticker: "1234" }), "台股:1234");
  assert.equal(companyKey({ market: "美股", ticker: "1234" }), "美股:1234");
});

test("初始畫面僅顯示台股市值前十名，套用篩選後保留所有結果", () => {
  const rankedCompanies = Array.from({ length: 12 }, (_, index) => ({
    ticker: `${index + 1}`,
    market: "台股",
    valuation: { marketCapRank: 12 - index },
  }));
  rankedCompanies.push({ ticker: "US1", market: "美股", valuation: { marketCapRank: null } });

  assert.deepEqual(
    companiesForDisplay(rankedCompanies, false).map((company) => company.valuation.marketCapRank),
    [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
  );
  assert.equal(companiesForDisplay(rankedCompanies, true).length, 13);
});
