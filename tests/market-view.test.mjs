import assert from "node:assert/strict";
import test from "node:test";
import { companyKey, filterCompanies, selectedCompany } from "../shared/market-view.mjs";

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
