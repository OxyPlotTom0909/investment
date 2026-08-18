/**
 * @param {{ market: string, grade: string }[]} companies
 * @param {"全部" | "台股" | "美股"} market
 * @param {"全部" | "A" | "B" | "C" | "資料不足"} grade
 */
export function filterCompanies(companies, market, grade) {
  return companies.filter((company) =>
    (market === "全部" || company.market === market)
    && (grade === "全部" || company.grade === grade),
  );
}

/**
 * 初始畫面只顯示可比較的台股市值前十名；一旦使用者套用市場或級別篩選，
 * 則完整保留所有符合條件的公司，避免篩選結果被任意截斷。
 *
 * @param {{ market: string, valuation?: { marketCapRank?: number | null } | null }[]} companies
 * @param {boolean} hasActiveFilter
 */
export function companiesForDisplay(companies, hasActiveFilter) {
  if (hasActiveFilter) return companies;

  return companies
    .filter((company) => company.market === "台股")
    .slice()
    .sort((left, right) => (left.valuation?.marketCapRank ?? Number.MAX_SAFE_INTEGER) - (right.valuation?.marketCapRank ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 10);
}

/** @param {{ market: string, ticker: string }} company */
export function companyKey(company) {
  return `${company.market}:${company.ticker}`;
}

/**
 * @param {{ market: string, ticker: string }[]} companies
 * @param {string | null} selectedKey
 */
export function selectedCompany(companies, selectedKey) {
  return companies.find((company) => companyKey(company) === selectedKey) ?? companies[0] ?? null;
}
