const PSI_API = "https://www.googleapis.com/pagespeedonline/v5/runPagespeed";

function getApiKey(): string {
  const key = process.env.PAGESPEED_API_KEY;
  if (!key) {
    throw new Error(
      "PAGESPEED_API_KEY environment variable is required for PageSpeed Insights tools. " +
      "Get a free key at https://developers.google.com/speed/docs/insights/v5/get-started"
    );
  }
  return key;
}

interface CoreWebVital {
  displayValue: string;
  score: number | null;
  numericValue: number;
}

interface FieldMetric {
  category: string;
  percentile: number;
  distributions: Array<{ min: number; max?: number; proportion: number }>;
}

interface Opportunity {
  id: string;
  title: string;
  description: string;
  savings_ms: number | null;
}

interface PageSpeedResult {
  url: string;
  strategy: string;
  score: number | null;
  grade: string;
  core_web_vitals: {
    fcp: CoreWebVital | null;
    lcp: CoreWebVital | null;
    tbt: CoreWebVital | null;
    cls: CoreWebVital | null;
    si: CoreWebVital | null;
    tti: CoreWebVital | null;
    ttfb: CoreWebVital | null;
  };
  field_data: Record<string, FieldMetric> | null;
  opportunities: Opportunity[];
  passed_audits: number;
  failed_audits: number;
}

function scoreToGrade(score: number | null): string {
  if (score === null) return "N/A";
  if (score >= 90) return "Good";
  if (score >= 50) return "Needs Improvement";
  return "Poor";
}

function extractAudit(audits: Record<string, unknown>, id: string): CoreWebVital | null {
  const audit = audits[id] as Record<string, unknown> | undefined;
  if (!audit) return null;
  return {
    displayValue: (audit.displayValue as string) ?? "N/A",
    score: audit.score !== undefined ? Math.round((audit.score as number) * 100) : null,
    numericValue: Math.round((audit.numericValue as number) ?? 0),
  };
}

function extractOpportunities(audits: Record<string, unknown>): Opportunity[] {
  const opps: Opportunity[] = [];
  for (const [id, audit] of Object.entries(audits)) {
    const a = audit as Record<string, unknown>;
    if (a.details && (a.details as Record<string, unknown>).type === "opportunity") {
      const savings = (a.details as Record<string, unknown>).overallSavingsMs;
      opps.push({
        id,
        title: (a.title as string) ?? id,
        description: (a.description as string) ?? "",
        savings_ms: typeof savings === "number" ? Math.round(savings) : null,
      });
    }
  }
  return opps.sort((a, b) => (b.savings_ms ?? 0) - (a.savings_ms ?? 0));
}

async function runPsi(url: string, strategy: "mobile" | "desktop"): Promise<PageSpeedResult> {
  const apiKey = getApiKey();
  const endpoint = `${PSI_API}?url=${encodeURIComponent(url)}&strategy=${strategy}&category=performance&key=${apiKey}`;
  const res = await fetch(endpoint);

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`PageSpeed API error (${res.status}): ${err}`);
  }

  const json = await res.json() as Record<string, unknown>;
  const lr = json.lighthouseResult as Record<string, unknown> | undefined;
  const audits = (lr?.audits ?? {}) as Record<string, unknown>;
  const categories = (lr?.categories ?? {}) as Record<string, unknown>;
  const perfScore = (categories.performance as Record<string, unknown>)?.score;
  const score = typeof perfScore === "number" ? Math.round(perfScore * 100) : null;

  // Field data (CrUX real-world data)
  const ole = json.originLoadingExperience as Record<string, unknown> | undefined;
  const fieldData: Record<string, FieldMetric> | null = ole?.metrics
    ? Object.fromEntries(
        Object.entries(ole.metrics as Record<string, Record<string, unknown>>).map(([k, v]) => [
          k,
          {
            category: v.category as string,
            percentile: v.percentile as number,
            distributions: v.distributions as FieldMetric["distributions"],
          },
        ])
      )
    : null;

  // Count passed vs failed audits
  let passed = 0;
  let failed = 0;
  for (const audit of Object.values(audits)) {
    const a = audit as Record<string, unknown>;
    if (a.score === 1) passed++;
    else if (typeof a.score === "number" && a.score < 1) failed++;
  }

  return {
    url,
    strategy,
    score,
    grade: scoreToGrade(score),
    core_web_vitals: {
      fcp: extractAudit(audits, "first-contentful-paint"),
      lcp: extractAudit(audits, "largest-contentful-paint"),
      tbt: extractAudit(audits, "total-blocking-time"),
      cls: extractAudit(audits, "cumulative-layout-shift"),
      si: extractAudit(audits, "speed-index"),
      tti: extractAudit(audits, "interactive"),
      ttfb: extractAudit(audits, "time-to-first-byte"),
    },
    field_data: fieldData,
    opportunities: extractOpportunities(audits),
    passed_audits: passed,
    failed_audits: failed,
  };
}

// Tool 1: Analyze a single URL for mobile and/or desktop
export async function pagespeedAnalyze(
  url: string,
  strategy: "mobile" | "desktop" | "both" = "both"
): Promise<{ mobile?: PageSpeedResult; desktop?: PageSpeedResult }> {
  if (strategy === "both") {
    const [mobile, desktop] = await Promise.all([
      runPsi(url, "mobile"),
      runPsi(url, "desktop"),
    ]);
    return { mobile, desktop };
  }
  const result = await runPsi(url, strategy);
  return strategy === "mobile" ? { mobile: result } : { desktop: result };
}

// Tool 2: Bulk-check multiple URLs (one strategy, parallel)
export async function pagespeedBulkCheck(
  urls: string[],
  strategy: "mobile" | "desktop" = "mobile"
): Promise<Array<{ url: string; score: number | null; grade: string; lcp: string | null; cls: string | null; tbt: string | null; error?: string }>> {
  const results = await Promise.allSettled(urls.map((u) => runPsi(u, strategy)));
  return results.map((r, i) => {
    if (r.status === "fulfilled") {
      const d = r.value;
      return {
        url: urls[i],
        score: d.score,
        grade: d.grade,
        lcp: d.core_web_vitals.lcp?.displayValue ?? null,
        cls: d.core_web_vitals.cls?.displayValue ?? null,
        tbt: d.core_web_vitals.tbt?.displayValue ?? null,
      };
    }
    return { url: urls[i], score: null, grade: "Error", lcp: null, cls: null, tbt: null, error: r.reason?.message };
  });
}

// Tool 3: Core Web Vitals deep-dive with field data and top opportunities
export async function pagespeedCoreWebVitals(
  url: string
): Promise<{ mobile: PageSpeedResult; desktop: PageSpeedResult; summary: string }> {
  const [mobile, desktop] = await Promise.all([
    runPsi(url, "mobile"),
    runPsi(url, "desktop"),
  ]);

  const lines: string[] = [
    `## Core Web Vitals for ${url}`,
    "",
    `| Metric | Mobile | Desktop |`,
    `|--------|--------|---------|`,
    `| Score | ${mobile.score ?? "N/A"} (${mobile.grade}) | ${desktop.score ?? "N/A"} (${desktop.grade}) |`,
    `| LCP | ${mobile.core_web_vitals.lcp?.displayValue ?? "N/A"} | ${desktop.core_web_vitals.lcp?.displayValue ?? "N/A"} |`,
    `| TBT | ${mobile.core_web_vitals.tbt?.displayValue ?? "N/A"} | ${desktop.core_web_vitals.tbt?.displayValue ?? "N/A"} |`,
    `| CLS | ${mobile.core_web_vitals.cls?.displayValue ?? "N/A"} | ${desktop.core_web_vitals.cls?.displayValue ?? "N/A"} |`,
    `| FCP | ${mobile.core_web_vitals.fcp?.displayValue ?? "N/A"} | ${desktop.core_web_vitals.fcp?.displayValue ?? "N/A"} |`,
    `| TTFB | ${mobile.core_web_vitals.ttfb?.displayValue ?? "N/A"} | ${desktop.core_web_vitals.ttfb?.displayValue ?? "N/A"} |`,
  ];

  if (mobile.opportunities.length > 0) {
    lines.push("", "### Top Mobile Opportunities");
    for (const opp of mobile.opportunities.slice(0, 5)) {
      const savings = opp.savings_ms ? ` (saves ~${opp.savings_ms}ms)` : "";
      lines.push(`- **${opp.title}**${savings}`);
    }
  }

  return { mobile, desktop, summary: lines.join("\n") };
}
