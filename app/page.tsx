"use client";

import { useMemo, useState } from "react";

type Market = "全部" | "台股" | "美股";
type Grade = "A" | "B" | "C";

type Company = {
  ticker: string;
  name: string;
  market: Exclude<Market, "全部">;
  industry: string;
  price: number;
  currency: string;
  passed: number;
  grade: Grade;
  entry: string;
  timing: "適合分批研究" | "等待回測" | "觀察";
  factors: Array<{ name: string; passed: boolean; note: string }>;
};

const companies: Company[] = [
  {
    ticker: "2330",
    name: "台積電",
    market: "台股",
    industry: "半導體製造",
    price: 1_045,
    currency: "TWD",
    passed: 9,
    grade: "A",
    entry: "NT$ 920–980",
    timing: "等待回測",
    factors: [
      { name: "營收成長", passed: true, note: "近年成長動能維持" },
      { name: "EPS 成長", passed: true, note: "獲利趨勢穩健" },
      { name: "ROE", passed: true, note: "高於品質門檻" },
      { name: "自由現金流", passed: true, note: "長期為正" },
      { name: "毛利率", passed: true, note: "領先同業" },
      { name: "營業利益率", passed: true, note: "維持高檔" },
      { name: "財務安全", passed: true, note: "流動性良好" },
      { name: "ROE 趨勢", passed: true, note: "維持高水準" },
      { name: "護城河", passed: true, note: "先進製程與規模" },
      { name: "估值", passed: false, note: "需等待安全邊際" },
      { name: "P/B 合理性", passed: false, note: "高於歷史中位數" },
    ],
  },
  {
    ticker: "2317",
    name: "鴻海",
    market: "台股",
    industry: "電子製造服務",
    price: 198,
    currency: "TWD",
    passed: 8,
    grade: "A",
    entry: "NT$ 168–182",
    timing: "適合分批研究",
    factors: [
      { name: "營收成長", passed: true, note: "AI 伺服器帶動" },
      { name: "EPS 成長", passed: true, note: "近年趨勢向上" },
      { name: "ROE", passed: false, note: "未達 15% 品質門檻" },
      { name: "自由現金流", passed: true, note: "現金流穩健" },
      { name: "毛利率", passed: false, note: "EMS 產業較低" },
      { name: "營業利益率", passed: true, note: "改善中" },
      { name: "財務安全", passed: false, note: "需搭配營運負債判讀" },
      { name: "ROE 趨勢", passed: true, note: "逐步改善" },
      { name: "護城河", passed: true, note: "規模與供應鏈整合" },
      { name: "估值", passed: true, note: "接近合理區間" },
      { name: "P/B 合理性", passed: true, note: "相對歷史可接受" },
    ],
  },
  {
    ticker: "MSFT",
    name: "Microsoft",
    market: "美股",
    industry: "軟體與雲端",
    price: 512,
    currency: "USD",
    passed: 9,
    grade: "A",
    entry: "US$ 430–465",
    timing: "等待回測",
    factors: [
      { name: "營收成長", passed: true, note: "雲端與訂閱收入" },
      { name: "EPS 成長", passed: true, note: "獲利持續成長" },
      { name: "ROE", passed: true, note: "資本效率佳" },
      { name: "自由現金流", passed: true, note: "強勁且穩定" },
      { name: "毛利率", passed: true, note: "高毛利商業模式" },
      { name: "營業利益率", passed: true, note: "高於同業" },
      { name: "財務安全", passed: true, note: "資產負債表健康" },
      { name: "ROE 趨勢", passed: true, note: "維持高水準" },
      { name: "護城河", passed: true, note: "生態系與轉換成本" },
      { name: "估值", passed: false, note: "成長預期已反映" },
      { name: "P/B 合理性", passed: false, note: "高於歷史中位數" },
    ],
  },
  {
    ticker: "INTC",
    name: "Intel",
    market: "美股",
    industry: "半導體",
    price: 24,
    currency: "USD",
    passed: 4,
    grade: "C",
    entry: "暫不提供",
    timing: "觀察",
    factors: [
      { name: "營收成長", passed: false, note: "尚待驗證復甦" },
      { name: "EPS 成長", passed: false, note: "獲利波動大" },
      { name: "ROE", passed: false, note: "未達門檻" },
      { name: "自由現金流", passed: false, note: "資本支出壓力" },
      { name: "毛利率", passed: true, note: "仍具產業基礎" },
      { name: "營業利益率", passed: false, note: "需持續改善" },
      { name: "財務安全", passed: true, note: "持續監控" },
      { name: "ROE 趨勢", passed: false, note: "尚未回升" },
      { name: "護城河", passed: true, note: "技術與客戶基礎" },
      { name: "估值", passed: true, note: "需與風險一起看" },
      { name: "P/B 合理性", passed: false, note: "不單獨構成理由" },
    ],
  },
];

function gradeFor(passed: number): Grade {
  if (passed >= 8) return "A";
  if (passed >= 5) return "B";
  return "C";
}

export default function Home() {
  const [market, setMarket] = useState<Market>("全部");
  const [minimumGrade, setMinimumGrade] = useState<Grade>("C");
  const [selectedTicker, setSelectedTicker] = useState("2317");

  const selected = companies.find((company) => company.ticker === selectedTicker) ?? companies[0];
  const visibleCompanies = useMemo(
    () =>
      companies.filter((company) => {
        const marketMatch = market === "全部" || company.market === market;
        const gradeMatch = company.passed >= (minimumGrade === "A" ? 8 : minimumGrade === "B" ? 5 : 0);
        return marketMatch && gradeMatch;
      }),
    [market, minimumGrade],
  );

  return (
    <main>
      <section className="hero">
        <div className="eyebrow">Investment Compass · MVP</div>
        <h1>用一致的框架，找出值得長期研究的上市公司。</h1>
        <p>台股上市與美國主要交易所｜11 項品質檢查｜波段時機獨立判讀</p>
        <div className="hero-notes">
          <span>資料範例模式</span>
          <span>不構成投資建議</span>
          <span>最後同步：MVP 示範資料</span>
        </div>
      </section>

      <section className="controls" aria-label="篩選條件">
        <div>
          <label htmlFor="market">市場</label>
          <select id="market" value={market} onChange={(event) => setMarket(event.target.value as Market)}>
            <option>全部</option>
            <option>台股</option>
            <option>美股</option>
          </select>
        </div>
        <div>
          <label htmlFor="grade">最低品質級別</label>
          <select id="grade" value={minimumGrade} onChange={(event) => setMinimumGrade(event.target.value as Grade)}>
            <option value="A">A 級（至少 8 項符合）</option>
            <option value="B">B 級（至少 5 項符合）</option>
            <option value="C">全部級別</option>
          </select>
        </div>
        <aside className="rule-card">
          <strong>分級規則</strong>
          <span>A：≥ 8 項　B：5–7 項　C：≤ 4 項</span>
        </aside>
      </section>

      <section className="content-grid">
        <div className="list-card">
          <div className="section-heading">
            <div>
              <span className="eyebrow">投資候選清單</span>
              <h2>{visibleCompanies.length} 檔可檢視標的</h2>
            </div>
            <span className="live-dot">● MVP</span>
          </div>
          <div className="company-list">
            {visibleCompanies.map((company) => (
              <button
                className={`company-row ${selected.ticker === company.ticker ? "selected" : ""}`}
                key={company.ticker}
                onClick={() => setSelectedTicker(company.ticker)}
              >
                <span className={`grade grade-${gradeFor(company.passed).toLowerCase()}`}>{company.grade}</span>
                <span className="company-name"><strong>{company.name}</strong><small>{company.ticker} · {company.market}</small></span>
                <span className="pass-count">{company.passed}<small>/ 11 符合</small></span>
                <span className="entry-label">{company.timing}</span>
              </button>
            ))}
          </div>
        </div>

        <article className="detail-card">
          <div className="detail-top">
            <div>
              <span className="eyebrow">{selected.market} · {selected.industry}</span>
              <h2>{selected.name} <span>{selected.ticker}</span></h2>
            </div>
            <span className={`grade grade-${selected.grade.toLowerCase()} large`}>{selected.grade} 級</span>
          </div>
          <div className="price-band">
            <div><span>示範現價</span><strong>{selected.currency === "TWD" ? "NT$" : "US$"} {selected.price.toLocaleString()}</strong></div>
            <div><span>合理研究區間</span><strong>{selected.entry}</strong></div>
            <div><span>波段判讀</span><strong>{selected.timing}</strong></div>
          </div>
          <div className="explanation">
            <strong>怎麼讀這個頁面？</strong>
            <p>品質等級只看 11 項基本面與估值是否達標；合理研究區間會在正式版由歷史估值、同業比較、現金流估值與安全邊際交叉計算。波段訊號不會改變 A/B/C 分級。</p>
          </div>
          <div className="factor-grid">
            {selected.factors.map((factor) => (
              <div className={`factor ${factor.passed ? "pass" : "watch"}`} key={factor.name}>
                <span>{factor.passed ? "✓" : "!"}</span>
                <div><strong>{factor.name}</strong><small>{factor.note}</small></div>
              </div>
            ))}
          </div>
          <footer className="source-note">正式版將顯示每一項的資料日、公式與官方來源。資料不足時，系統會標示「無法評估」，不會誤判為不符合。</footer>
        </article>
      </section>
    </main>
  );
}
