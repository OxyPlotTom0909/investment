"use client";

import { useEffect, useMemo, useState } from "react";
import type { Company, MarketSnapshot } from "../shared/market";
import { companyKey, filterCompanies, selectedCompany } from "../shared/market-view.mjs";

type MarketFilter = "全部" | "台股" | "美股";
type GradeFilter = "全部" | "A" | "B" | "C" | "資料不足";

function gradeClass(grade: Company["grade"]): string {
  if (grade === "A") return "grade-a";
  if (grade === "B") return "grade-b";
  if (grade === "C") return "grade-c";
  return "grade-pending";
}

function formatTwd(value: number | null): string {
  if (value === null) return "資料待補";
  if (value >= 100_000_000) return `${(value / 100_000_000).toFixed(0)} 億元`;
  return `${value.toLocaleString("zh-TW")} 元`;
}

function formatMultiple(value: number | null): string {
  return value === null ? "資料待補" : `${value.toFixed(2)}x`;
}

function formatPercent(value: number | null): string {
  return value === null ? "資料待補" : `${value.toFixed(2)}%`;
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketFilter>("全部");
  const [grade, setGrade] = useState<GradeFilter>("全部");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);

  useEffect(() => {
    void fetch("/api/market").then(async (response) => {
      if (!response.ok) {
        const body = await response.json() as { error?: string };
        throw new Error(body.error ?? "市場資料讀取失敗");
      }
      return response.json() as Promise<MarketSnapshot>;
    }).then((data) => {
      setSnapshot(data);
      setSelectedKey(data.companies[0] ? companyKey(data.companies[0]) : null);
    }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "市場資料讀取失敗"));
  }, []);

  const companies = useMemo(() => filterCompanies(snapshot?.companies ?? [], market, grade) as Company[], [snapshot, market, grade]);
  const selected = selectedCompany(companies, selectedKey) as Company | null;

  return <main>
    <section className="hero"><div className="eyebrow">Investment Compass · Actual Data</div><h1>以可追溯資料研究台股與美股。</h1><p>11 項品質檢查｜同業中位數比較｜資料不足不強行評分</p><div className="hero-notes"><span>不構成投資建議</span><span>{snapshot ? `資料快照：${new Date(snapshot.generatedAt).toLocaleString("zh-TW")}` : "正在讀取市場快照"}</span></div></section>
    <section className="controls" aria-label="篩選條件"><div><label htmlFor="market">市場</label><select id="market" value={market} onChange={(event) => setMarket(event.target.value as MarketFilter)}><option>全部</option><option>台股</option><option>美股</option></select></div><div><label htmlFor="grade">品質級別</label><select id="grade" value={grade} onChange={(event) => setGrade(event.target.value as GradeFilter)}><option>全部</option><option>A</option><option>B</option><option>C</option><option>資料不足</option></select></div><aside className="rule-card"><strong>分級規則</strong><span>11 項全數可評後：A ≥ 8、B 5–7、C ≤ 4</span></aside></section>
    {error ? <section className="status-card"><strong>市場快照尚未就緒</strong><p>{error}。請確認 Azure SAS 具備讀取、建立與寫入權限，並在 Cloudflare 為 Worker 建立排程後執行第一次同步。</p></section> : null}
    {!snapshot && !error ? <section className="status-card">正在讀取 Azure Blob Storage 的市場快照…</section> : null}
    {snapshot ? <section className="content-grid"><div className="list-card"><div className="section-heading"><div><span className="eyebrow">台股市值前 200 名＋美股實際名單</span><h2>{companies.length.toLocaleString()} 檔</h2></div><span className="live-dot">● Azure Blob</span></div>{companies.length === 0 ? <p className="empty-state">沒有符合目前篩選條件的公司。</p> : <div className="company-list">{companies.slice(0, 200).map((company) => <button className={`company-row ${selected === company ? "selected" : ""}`} key={companyKey(company)} onClick={() => setSelectedKey(companyKey(company))}><span className={`grade ${gradeClass(company.grade)}`}>{company.grade === "資料不足" ? "…" : company.grade}</span><span className="company-name"><strong>{company.name}</strong><small>{company.ticker} · {company.market} · {company.industry}</small></span><span className="pass-count">{company.passedCount}<small>/ {company.evaluatedCount} 已評</small></span></button>)}</div>}</div>
      {selected ? <article className="detail-card"><div className="detail-top"><div><span className="eyebrow">{selected.market} · {selected.industry}</span><h2>{selected.name} <span>{selected.ticker}</span></h2></div><span className={`grade ${gradeClass(selected.grade)} large`}>{selected.grade}</span></div>{selected.valuation ? <div className="price-band"><div><span>收盤價</span><strong>{selected.valuation.closingPrice === null ? "資料待補" : `${selected.valuation.closingPrice.toFixed(2)} 元`}</strong></div><div><span>市值</span><strong>{formatTwd(selected.valuation.marketCapTwd)}</strong></div><div><span>台股市值排名</span><strong>{selected.valuation.marketCapRank === null ? "資料待補" : `#${selected.valuation.marketCapRank}`}</strong></div><div><span>PE</span><strong>{formatMultiple(selected.valuation.peRatio)}</strong></div><div><span>P/B</span><strong>{formatMultiple(selected.valuation.pbRatio)}</strong></div><div><span>現金殖利率</span><strong>{formatPercent(selected.valuation.dividendYield)}</strong></div></div> : null}<div className="explanation"><strong>{selected.evaluatedCount === 11 ? "11 項評分完成" : `目前已完成 ${selected.evaluatedCount} / 11 項可量化評估`}</strong><p>個股數值以最新市場快照呈現；同業基準採相同產業上市公司中位數。未具備經驗證資料的項目保留「資料待補」，不納入 A/B/C 分級。</p></div><div className="factor-grid">{selected.factors.map((factor) => <div className={`factor ${factor.state === "pass" ? "pass" : factor.state === "fail" ? "watch" : "pending"}`} key={factor.id}><span>{factor.state === "pass" ? "✓" : factor.state === "fail" ? "!" : "—"}</span><div><strong>{factor.name}</strong><small>個股：{factor.value ?? "資料待補"}</small><small>{factor.benchmark ?? factor.note}</small><small className="source">{factor.source}{factor.period ? ` · ${factor.period}` : ""}</small></div></div>)}</div><footer className="source-note">來源：{snapshot.sources.join("、")}。數值與同業比較為研究輔助，非買賣建議。</footer></article> : null}
    </section> : null}
  </main>;
}
