"use client";

import { useEffect, useMemo, useState } from "react";
import type { Company, Factor, MarketSnapshot } from "../shared/market";
import { companiesForDisplay, companyKey, filterCompanies, selectedCompany } from "../shared/market-view.mjs";

type MarketFilter = "全部" | "台股" | "美股";
type GradeFilter = "全部" | "A" | "B" | "C" | "資料不足";

function gradeClass(grade: Company["grade"]): string {
  if (grade === "A") return "grade-a";
  if (grade === "B") return "grade-b";
  if (grade === "C") return "grade-c";
  return "grade-pending";
}

function formatTwd(value: number | null): string { if (value === null) return "資料待補"; return value >= 100_000_000 ? `${(value / 100_000_000).toFixed(0)} 億元` : `${value.toLocaleString("zh-TW")} 元`; }
function formatMultiple(value: number | null): string { return value === null ? "資料待補" : `${value.toFixed(2)}x`; }
function formatPercent(value: number | null): string { return value === null ? "資料待補" : `${value.toFixed(2)}%`; }
function factorStatus(factor: Pick<Factor, "state">): string { return factor.state === "pass" ? "符合" : factor.state === "fail" ? "留意" : "資料待補"; }

type TrendPoint = { label: string; value: number; display: string };

function numericValue(value: string | null): number | null {
  if (value === null) return null;
  const matched = value.replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return matched ? Number(matched[0]) : null;
}

function trendPoints(factor: Factor): TrendPoint[] {
  return (factor.history ?? []).flatMap((point) => {
    const value = numericValue(point.value);
    return value === null ? [] : [{ label: point.period ?? new Date(point.capturedAt).toLocaleDateString("zh-TW"), value, display: point.value ?? "資料待補" }];
  });
}

function TrendChart({ factor }: { factor: Factor }) {
  const points = trendPoints(factor);
  const width = 320;
  const height = 132;
  const padding = 20;
  const values = points.map((point) => point.value);
  const minimum = values.length ? Math.min(...values) : 0;
  const maximum = values.length ? Math.max(...values) : 1;
  const range = maximum === minimum ? Math.max(Math.abs(maximum) * 0.12, 1) : maximum - minimum;
  const toX = (index: number): number => points.length < 2 ? width / 2 : padding + (index * (width - padding * 2)) / (points.length - 1);
  const toY = (value: number): number => height - padding - ((value - minimum + range * 0.08) / (range * 1.16)) * (height - padding * 2);
  const polyline = points.map((point, index) => `${toX(index)},${toY(point.value)}`).join(" ");

  return <figure className="trend-chart" aria-label={`${factor.name}數據變化圖`}>
    <svg viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`${factor.name}數據變化`}>
      {[0.2, 0.5, 0.8].map((offset) => <line key={offset} x1={padding} x2={width - padding} y1={height * offset} y2={height * offset} />)}
      {points.length > 1 ? <polyline points={polyline} /> : null}
      {points.map((point, index) => <g key={`${point.label}-${point.value}`}><circle cx={toX(index)} cy={toY(point.value)} r="4" /><text x={toX(index)} y={height - 4} textAnchor="middle">{point.label}</text></g>)}
      {points.length === 0 ? <text className="chart-empty" x={width / 2} y={height / 2} textAnchor="middle">尚無可繪製的歷史數值</text> : null}
    </svg>
    <figcaption>{points.length ? `最新：${points.at(-1)?.display ?? "資料待補"}` : "每日同步後會開始累積趨勢"}</figcaption>
  </figure>;
}

function FactorCard({ factor }: { factor: Factor }) {
  return <div className={`factor ${factor.state === "pass" ? "pass" : factor.state === "fail" ? "watch" : "pending"}`}>
    <span>{factor.state === "pass" ? "✓" : factor.state === "fail" ? "!" : "—"}</span><div><strong>{factor.name}</strong><small>個股：{factor.value ?? "資料待補"}</small><small>{factor.benchmark ?? factor.note}</small><small className="source">{factor.source}{factor.period ? ` · ${factor.period}` : ""}</small>{factor.evidence?.map((evidence) => <small className="evidence" key={`${evidence.criterion}:${evidence.sourceUrl}`}><a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.criterion}</a>：{evidence.observation}（{evidence.asOfDate}、{evidence.confidence === "high" ? "高信心" : evidence.confidence === "medium" ? "中信心" : "低信心"}）</small>)}</div>
  </div>;
}

function CompanyRow({ company, onSelect }: { company: Company; onSelect: (company: Company) => void }) {
  const passedFactors = company.factors.filter((factor) => factor.state === "pass");
  return <button className="company-row" onClick={() => onSelect(company)}>
    <span className="company-row-top">
      <span className={`grade ${gradeClass(company.grade)}`}>{company.grade === "資料不足" ? "…" : company.grade}</span>
      <span className="company-name"><strong>{company.name}</strong><small>{company.ticker} · {company.market} · {company.industry}</small></span>
      <span className="pass-count">{company.passedCount}<small>/ {company.evaluatedCount} 已評</small></span>
    </span>
    <span className="company-row-bottom">
      {passedFactors.length ? passedFactors.map((factor) => <span className="passed-factor" key={factor.id}>{factor.name}</span>) : <span className="no-passed-factor">目前無合格評比</span>}
    </span>
  </button>;
}

export default function Home() {
  const [snapshot, setSnapshot] = useState<MarketSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [market, setMarket] = useState<MarketFilter>("全部");
  const [grade, setGrade] = useState<GradeFilter>("全部");
  const [query, setQuery] = useState("");
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [view, setView] = useState<"list" | "detail">("list");

  useEffect(() => { void fetch("/api/market").then(async (response) => { if (!response.ok) { const body = await response.json() as { error?: string }; throw new Error(body.error ?? "市場資料讀取失敗"); } return response.json() as Promise<MarketSnapshot>; }).then((data) => { setSnapshot(data); setSelectedKey(null); setView("list"); }).catch((reason: unknown) => setError(reason instanceof Error ? reason.message : "市場資料讀取失敗")); }, []);

  const marketCompanies = useMemo(() => (snapshot?.companies ?? []).filter((company) => market === "全部" || company.market === market), [snapshot, market]);
  const searchSuggestions = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return [];
    return marketCompanies.filter((company) => `${company.name} ${company.ticker}`.toLocaleLowerCase().includes(normalized)).slice(0, 8);
  }, [marketCompanies, query]);
  const filteredCompanies = useMemo(() => filterCompanies(marketCompanies, "全部", grade).filter((company) => {
    const normalized = query.trim().toLocaleLowerCase();
    return !normalized || `${company.name} ${company.ticker}`.toLocaleLowerCase().includes(normalized);
  }) as Company[], [marketCompanies, grade, query]);
  const hasActiveFilter = market !== "全部" || grade !== "全部";
  const companies = useMemo(() => companiesForDisplay(filteredCompanies, hasActiveFilter) as Company[], [filteredCompanies, hasActiveFilter]);
  const gradeCounts = useMemo(() => { const inMarket = (snapshot?.companies ?? []).filter((company) => market === "全部" || company.market === market); return new Map<GradeFilter, number>([["全部", inMarket.length], ["A", inMarket.filter((company) => company.grade === "A").length], ["B", inMarket.filter((company) => company.grade === "B").length], ["C", inMarket.filter((company) => company.grade === "C").length], ["資料不足", inMarket.filter((company) => company.grade === "資料不足").length]]); }, [snapshot, market]);
  const selected = selectedCompany(snapshot?.companies ?? [], selectedKey) as Company | null;
  const isUnratedUsSelection = market === "美股" && grade !== "全部" && grade !== "資料不足" && companies.length === 0;
  const selectCompany = (company: Company): void => { setSelectedKey(companyKey(company)); setQuery(""); setView("detail"); };
  const showList = (): void => { setSelectedKey(null); setView("list"); };

  return <main>
    <section className="hero"><h1>台股與美股風險評估</h1><div className="hero-notes"><span>不構成投資建議</span><span>{snapshot ? `資料快照：${new Date(snapshot.generatedAt).toLocaleString("zh-TW")}` : "正在讀取市場快照"}</span></div></section>
    <section className="controls" aria-label="篩選條件"><div><label htmlFor="market">市場</label><select id="market" value={market} onChange={(event) => setMarket(event.target.value as MarketFilter)}><option>全部</option><option>台股</option><option>美股</option></select></div><div><label htmlFor="grade">品質級別</label><select id="grade" value={grade} onChange={(event) => setGrade(event.target.value as GradeFilter)}><option value="全部">全部（{gradeCounts.get("全部") ?? 0}）</option><option value="A">A（{gradeCounts.get("A") ?? 0}）</option><option value="B">B（{gradeCounts.get("B") ?? 0}）</option><option value="C">C（{gradeCounts.get("C") ?? 0}）</option><option value="資料不足">資料不足（{gradeCounts.get("資料不足") ?? 0}）</option></select></div><div className="company-search"><label htmlFor="company-search">搜尋公司</label><input id="company-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="名稱或代號" autoComplete="off" />{searchSuggestions.length ? <ul role="listbox" aria-label="公司搜尋建議">{searchSuggestions.map((company) => <li key={companyKey(company)}><button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => selectCompany(company)}><strong>{company.name}</strong><span>{company.ticker} · {company.market}</span></button></li>)}</ul> : null}{query.trim() && !searchSuggestions.length ? <small>找不到符合的公司</small> : null}</div><aside className="rule-card"><strong>分級規則</strong><span>A ≥ 8、B 5–7、C ≤ 4；未具可評資料則標示資料不足</span></aside></section>
    <section className="moat-standard" aria-label="護城河評分標準"><div><span className="eyebrow">護城河評估標準</span><h2>以 5 項可追溯證據評分</h2><p>每項證據均需保留來源、資料日期與信心等級；確認 4–5 項為強、2–3 項為中、0–1 項為弱，少於 3 項可驗證來源則維持資料不足。</p></div><ol><li><strong>獲利持續性</strong><span>近 3 年至少 2 年營業利益率不低於同業中位數。</span></li><li><strong>競爭地位</strong><span>市占前 3 名或具可查證的領先地位。</span></li><li><strong>轉換成本</strong><span>續約／留存率、長約或認證機制具公開佐證。</span></li><li><strong>無形資產</strong><span>有效專利、商標、牌照或關鍵認證具公開紀錄。</span></li><li><strong>資本效率</strong><span>近 3 年 ROE／ROIC 持續不低於同業中位數。</span></li></ol></section>
    {error ? <section className="status-card"><strong>市場快照尚未就緒</strong><p>{error}。請確認 Azure SAS 具備讀取、建立與寫入權限。</p></section> : null}{!snapshot && !error ? <section className="status-card">資料讀取中</section> : null}
    {snapshot && view === "list" ? <section className="company-overview" aria-label="全部公司清單"><div className="overview-top list-card"><div className="section-heading"><span className="eyebrow">{hasActiveFilter ? `符合條件的公司（${companies.length} 家）` : `全部公司（${companies.length} 家）`}</span></div>{companies.length === 0 ? <p className="empty-state">{isUnratedUsSelection ? "美股尚未完成品質評分，因此目前沒有 A／B／C 級結果；可選擇「資料不足」查看已收錄名單。" : "沒有符合目前篩選條件的公司。"}</p> : <div className="company-list">{companies.map((company) => <CompanyRow company={company} key={companyKey(company)} onSelect={selectCompany} />)}</div>}</div></section> : null}
    {snapshot && view === "detail" && selected ? <article className="detail-card detail-view"><div className="detail-top"><div><button className="back-button" onClick={showList}>← 回全部公司</button><span className="eyebrow">{selected.market} · {selected.industry}</span><h2>{selected.name} <span>{selected.ticker}</span></h2></div><span className={`grade ${gradeClass(selected.grade)} large`}>{selected.grade}</span></div>{selected.valuation ? <div className="price-band"><div><span>收盤價</span><strong>{selected.valuation.closingPrice === null ? "資料待補" : `${selected.valuation.closingPrice.toFixed(2)} 元`}</strong></div><div><span>市值</span><strong>{formatTwd(selected.valuation.marketCapTwd)}</strong></div><div><span>台股市值排名</span><strong>{selected.valuation.marketCapRank === null ? "資料待補" : `#${selected.valuation.marketCapRank}`}</strong></div><div><span>PE</span><strong>{formatMultiple(selected.valuation.peRatio)}</strong></div><div><span>P/B</span><strong>{formatMultiple(selected.valuation.pbRatio)}</strong></div><div><span>現金殖利率</span><strong>{formatPercent(selected.valuation.dividendYield)}</strong></div></div> : null}<section className="detail-scores"><div className="explanation"><strong>{selected.evaluatedCount === 11 ? "11 項評分完成" : `目前已完成 ${selected.evaluatedCount} / 11 項可量化評估`}</strong><p>個股數值以最新市場快照呈現；同業基準採相同產業上市公司中位數。未具備經驗證資料的項目保留「資料待補」，不納入 A/B/C 分級。</p></div><div className="factor-grid">{selected.factors.map((factor) => <FactorCard factor={factor} key={factor.id} />)}</div></section><section className="recorded-data" aria-label="各項評比已記錄數據"><div className="section-heading"><div><span className="eyebrow">評比資料明細</span><h2>各項評比數據變化</h2></div></div><p>依各項評比顯示歷次快照；圖表會隨每日快照累積。</p><div className="record-grid">{selected.factors.map((factor) => <section className="record-card" key={factor.id}><div><strong>{factor.name}</strong><span className={`record-state ${factor.state}`}>{factorStatus(factor)}</span></div><TrendChart factor={factor} /><dl><div><dt>最新數值</dt><dd>{factor.value ?? "資料待補"}</dd></div><div><dt>比較基準</dt><dd>{factor.benchmark ?? "尚無可比較基準"}</dd></div><div><dt>資料期間</dt><dd>{factor.period ?? "尚未記錄"}</dd></div><div><dt>資料來源</dt><dd>{factor.source}</dd></div></dl><p>{factor.note}</p>{factor.evidence?.length ? <ul>{factor.evidence.map((evidence) => <li key={`${evidence.criterion}:${evidence.sourceUrl}`}><a href={evidence.sourceUrl} target="_blank" rel="noreferrer">{evidence.criterion}</a>：{evidence.observation}</li>)}</ul> : null}</section>)}</div></section><footer className="source-note">來源：{snapshot.sources.join("、")}。數值與同業比較為研究輔助，非買賣建議。</footer></article> : null}
  </main>;
}
