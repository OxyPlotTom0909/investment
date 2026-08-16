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
