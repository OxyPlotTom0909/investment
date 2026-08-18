"use client";

import { useEffect, useMemo, useState } from "react";
import type { Company, MarketSnapshot } from "../shared/market";
import { companiesForDisplay, companyKey, filterCompanies, selectedCompany } from "../shared/market-view.mjs";

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

  const filteredCompanies = useMemo(() => filterCompanies(snapshot?.companies ?? [], market, grade) as Company[], [snapshot, market, grade]);
  const hasActiveFilter = market !== "全部" || grade !== "全部";
  const companies = useMemo(() => companiesForDisplay(filteredCompanies, hasActiveFilter) as Company[], [filteredCompanies, hasActiveFilter]);
  const gradeCounts = useMemo(() => {
    const companiesInMarket = (snapshot?.companies ?? []).filter((company) => market === "全部" || company.market === market);
    return new Map<GradeFilter, number>([
      ["全部", companiesInMarket.length],
      ["A", companiesInMarket.filter((company) => company.grade === "A").length],
      ["B", companiesInMarket.filter((company) => company.grade === "B").length],
      ["C", companiesInMarket.filter((company) => company.grade === "C").length],
      ["資料不足", companiesInMarket.filter((company) => company.grade === "資料不足").length],
    ]);
  }, [snapshot, market]);
  const isUnratedUsSelection = market === "美股" && grade !== "全部" && grade !== "資料不足" && companies.length === 0;
  const selected = selectedCompany(companies, selectedKey) as Company | null;

  return <main>
    <section className="hero"><h1>台股與美股風險評估</h1><div className="hero-notes"><span>不構成投資建議</span><span>{snapshot ? `資料快照：${new Date(snapshot.generatedAt).toLocaleString("zh-TW")}` : "正在讀取市場快照"}</span></div></section>
    <section className="controls" aria-label="篩選條件"><div><label htmlFor="market">市場</label><select id="market" value={market} onChange={(event) => setMarket(event.target.value as MarketFilter)}><option>全部</option><option>台股</option><option>美股</option></select></div><div><label htmlFor="grade">品質級別</label><select id="grade" value={grade} onChange={(event) => setGrade(event.target.value as GradeFilter)}><option value="全部">全部（{gradeCounts.get("全部") ?? 0}）</option><option value="A">A（{gradeCounts.get("A") ?? 0}）</option><option value="B">B（{gradeCounts.get("B") ?? 0}）</option><option value="C">C（{gradeCounts.get("C") ?? 0}）</option><option value="資料不足">資料不足（{gradeCounts.get("資料不足") ?? 0}）</option></select></div><aside className="rule-card"><strong>分級規則</strong><span>A ≥ 8、B 5–7、C ≤ 4；未具可評資料則標示資料不足</span></aside></section>
    <section className="moat-standard" aria-label="護城河評分標準"><div><span className="eyebrow">護城河評估標準</span><h2>以 5 項可追溯證據評分</h2><p>每項證據均需保留來源、資料日期與信心等級；確認 4–5 項為強、2–3 項為中、0–1 項為弱，少於 3 項可驗證來源則維持資料不足。</p></div><ol><li><strong>獲利持續性</strong><span>近 3 年至少 2 年營業利益率不低於同業中位數。</span></li><li><strong>競爭地位</strong><span>市占前 3 名或具可查證的領先地位。</span></li><li><strong>轉換成本</strong><span>續約／留存率、長約或認證機制具公開佐證。</span></li><li><strong>無形資產</strong><span>有效專利、商標、牌照或關鍵認證具公開紀錄。</span></li><li><strong>資本效率</strong><span>近 3 年 ROE／ROIC 持續不低於同業中位數。</span></li></ol></section>
    {error ? <section className="status-card"><strong>市場快照尚未就緒</strong><p>{error}。請確認 Azure SAS 具備讀取、建立與寫入權限，並在 Cloudflare 為 Worker 建立排程後執行第一次同步。</p></section> : null}
    {!snapshot && !error ? <section className="status-card">資料讀取中</section> : null}
    {snapshot ? <section className="content-grid"><div className="list-card"><div className="section-heading"><span className="eyebrow">{hasActiveFilter ? `符合條件的公司（${companies.length} 家）` : "台股市值前 10 名"}</span></div>{companies.length === 0 ? <p className="empty-state">{isUnratedUsSelection ? "美股尚未完成品質評分，因此目前沒有 A／B／C 級結果；可選擇「資料不足」查看已收錄名單。" : "沒有符合目前篩選條件的公司。"}</p> : <div className="company-list">{companies.map((company) => <button className={`company-row ${selected === company ? "selected" : ""}`} key={companyKey(company)} onClick={() => setSelectedKey(companyKey(company))}><span className={`grade ${gradeClass(company.grade)}`}>{company.grade === "資料不足" ? "…" : company.grade}</span><span className="company-name"><strong>{company.name}</strong><small>{company.ticker} · {company.market} · {company.industry}</small></span><span className="pass-count">{company.passedCount}<small>/ {company.evaluatedCount} 已評</small></span></button>)}</div>}</div>
      {selected ? <article className="detail-card"><div className="detail-top"><div><span className="eyebrow">{selected.market} · {selected.industry}</span><h2>{selected.name} <span>{selected.ticker}</span></h2></div><span className={`grade ${gradeClass(selected.grade)} large`}>{selected.grade}</span></div>{selected.valuation ? <div className="price-band"><div><span>收盤價</span><strong>{selected.valuation.closingPrice === null ? "資料待補" : `${selected.valuation.closingPrice.toFixed(2)} 元`}</strong></div><div><span>市值</span><strong>{formatTwd(selected.valuation.marketCapTwd)}</strong></div><div><span>台股市值排名</span><strong>{selected.valuation.marketCapRank === null ? "資料待補" : `#${selected.valuation.marketCapRank}`}</strong></div><div><span>PE</span><strong>{formatMultiple(selected.valuation.peRatio)}</strong></div><div><span>P/B</span><strong>{formatMultiple(selected.valuation.pbRatio)}</strong></div><div><span>現金殖利率</span><strong>{formatPercent(selected.valuation.dividendYield)}</strong></div></div> : null}<div className="explanation"><strong>{selected.evaluatedCount === 11 ? "11 項評分完成" : `目前已完成 ${selected.evaluatedCount} / 11 項可量化評估`}</strong><p>個股數值以最新市場快照呈現；同業基準採相同產業上市公司中位數。未具備經驗證資料的項目保留「資料待補」，不納入 A/B/C 分級。</p></div><div className="factor-grid">{selected.factors.map((factor) => <div className={`factor ${factor.state === "pass" ? "pass" : factor.state === "fail" ? "watch" : "pending"}`} key={factor.id}><span>{factor.state === "pass" ? "✓" : factor.state === "fail" ? "!" : "—"}</span><div><strong>{factor.name}</strong><small>個股：{factor.value ?? "資料待補"}</small><small>{factor.benchmark ?? factor.note}</small><small className="source">{factor.source}{factor.period ? ` · ${factor.period}` : ""}</small>{factor.evidence?.map((evidence) => <small className="evidence" key={`${evidence.criterion}:${evidence.sourceUrl}`}><a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.criterion}</a>：{evidence.observation}（{evidence.asOfDate}、{evidence.confidence === "high" ? "高信心" : evidence.confidence === "medium" ? "中信心" : "低信心"}）</small>)}</div></div>)}</div><footer className="source-note">來源：{snapshot.sources.join("、")}。數值與同業比較為研究輔助，非買賣建議。</footer></article> : null}
    </section> : null}
  </main>;
}
