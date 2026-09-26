import { ProviderError, numberValue } from "../common.mjs";
import { resolveStock } from "./naver.mjs";

const ENDPOINT = "https://dart-mcp-self.vercel.app/mcp";

function parseMcpResponse(text) {
  for (const line of text.split(/\r?\n/)) {
    if (line.startsWith("data:")) {
      try { return JSON.parse(line.slice(5).trim()); } catch {}
    }
  }
  try { return JSON.parse(text); } catch { throw new ProviderError("BAD_DART_MCP_RESPONSE", "OpenDART MCP returned an unreadable response"); }
}

async function remoteCall(name, args) {
  const response = await fetch(ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "user-agent": "korean-stock-mcp/0.1" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method: "tools/call", params: { name, arguments: args } }),
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new ProviderError(`HTTP_${response.status}`, `OpenDART MCP returned HTTP ${response.status}`);
  const rpc = parseMcpResponse(await response.text());
  if (rpc.error) throw new ProviderError("DART_MCP_ERROR", rpc.error.message || "OpenDART MCP error");
  const block = rpc?.result?.content?.find((x) => x.type === "text")?.text;
  if (!block) return rpc?.result ?? {};
  try { return JSON.parse(block); } catch { return { text: block }; }
}

async function corpCodeFrom(args) {
  const direct = args.corpCode || args.corp_code;
  if (direct) return String(direct);
  let query = args.companyName;
  const stockCode = args.stockCode || args.stock_code;
  if (!query && stockCode) {
    const resolved = await resolveStock(stockCode, { limit: 1 });
    query = resolved.data.matches[0]?.name;
  }
  if (!query) throw new ProviderError("INVALID_ARGUMENT", "One of corpCode/corp_code, companyName, stockCode/stock_code is required");
  const found = await remoteCall("find_company", { query });
  let companies = found.companies || [];
  if (stockCode) companies = companies.sort((a,b) => (a.stock_code === stockCode ? -1 : 0) - (b.stock_code === stockCode ? -1 : 0));
  if (!companies.length) throw new ProviderError("NOT_FOUND", `No DART company match for '${query}'`);
  return companies[0].corp_code;
}

const CORP_MARKETS = { Y: "KOSPI", K: "KOSDAQ", N: "KONEX" };
const CORP_CLASS_NAMES = { Y: "유가증권시장", K: "코스닥시장", N: "코넥스시장", E: "기타법인" };

function nullable(value) {
  return value === undefined || value === null || value === "" ? null : value;
}

export function normalizeCompanyOverview(raw) {
  return {
    company: {
      company_name: nullable(raw?.stock_name ?? raw?.corp_name),
      stock_code: nullable(raw?.stock_code),
      corp_code: nullable(raw?.corp_code),
      market: CORP_MARKETS[raw?.corp_cls] ?? null,
    },
    overview: {
      official_name: nullable(raw?.corp_name),
      english_name: nullable(raw?.corp_name_eng),
      stock_name: nullable(raw?.stock_name),
      ceo_name: nullable(raw?.ceo_nm),
      corporation_class: nullable(raw?.corp_cls),
      corporation_class_name: CORP_CLASS_NAMES[raw?.corp_cls] ?? null,
      jurir_no: nullable(raw?.jurir_no),
      business_registration_no: nullable(raw?.bizr_no),
      address: nullable(raw?.adres),
      homepage_url: nullable(raw?.hm_url),
      ir_url: nullable(raw?.ir_url),
      phone_number: nullable(raw?.phn_no),
      fax_number: nullable(raw?.fax_no),
      industry_code: nullable(raw?.induty_code),
      established_date: nullable(raw?.est_dt),
      fiscal_month: nullable(raw?.acc_mt),
    },
  };
}

const ACCOUNT_SPECS = {
  revenue: { names: ["매출액"], label: "매출액" },
  operating_income: { names: ["영업이익"], label: "영업이익" },
  net_income: { names: ["당기순이익", "당기순이익(손실)"], label: "당기순이익" },
  total_assets: { names: ["자산총계"], label: "자산총계" },
  total_liabilities: { names: ["부채총계"], label: "부채총계" },
  total_equity: { names: ["자본총계"], label: "자본총계" },
};

function normalizeAccount(rows, spec) {
  const row = rows.find((r) => r.fs_div === "CFS" && spec.names.includes(r.account_nm))
    ?? rows.find((r) => spec.names.includes(r.account_nm));
  if (!row) return null;
  return {
    account_name: spec.label,
    amount_krw: numberValue(row.thstrm_amount),
    raw_amount: nullable(row.thstrm_amount),
    statement_name: nullable(row.sj_nm),
    fs_name: nullable(row.fs_nm),
  };
}

export function normalizeFinancialStatement(companyInfo, raw, args) {
  const rows = raw?.list || [];
  const accounts = {};
  for (const [key, spec] of Object.entries(ACCOUNT_SPECS)) accounts[key] = normalizeAccount(rows, spec);
  return {
    company: normalizeCompanyOverview(companyInfo).company,
    business_year: args.year,
    report_code: args.reportCode || "11011",
    accounts,
  };
}

export function normalizeFilings(raw) {
  const filings = raw?.list || [];
  if (!filings.length) throw new ProviderError("NO_DATA", "OpenDART has no filings for the requested search conditions.");
  return { page: raw.page_no, page_size: raw.page_count, total: raw.total_count, total_page: raw.total_page, filings };
}

export async function searchFilings(args) {
  const corp_code = await corpCodeFrom(args).catch((e) => {
    if (!args.companyName && !args.stockCode && !args.stock_code && !args.corpCode && !args.corp_code) return undefined;
    throw e;
  });
  const raw = await remoteCall("search_disclosures", {
    ...(corp_code ? { corp_code } : {}),
    ...(args.start_date ? { bgn_de: String(args.start_date).replace(/[^0-9]/g, "").slice(0,8) } : {}),
    ...(args.end_date ? { end_de: String(args.end_date).replace(/[^0-9]/g, "").slice(0,8) } : {}),
    page_no: args.page || 1,
    page_count: args.page_size || 20,
  });
  const data = normalizeFilings(raw);
  const warnings = [];
  if (args.disclosure_type && args.disclosure_type !== "ALL") warnings.push("Existing OpenDART MCP proxy does not expose disclosure_type filtering; unfiltered list returned.");
  if (args.final_only === false) warnings.push("Existing OpenDART MCP proxy does not expose final_only filtering.");
  return { data, sourceApi: "opendart-mcp:search_disclosures", rawRef: ENDPOINT, warnings };
}

export async function companyOverview(args) {
  const corp_code = await corpCodeFrom(args);
  const raw = await remoteCall("get_company_info", { corp_code });
  return { data: normalizeCompanyOverview(raw), sourceApi: "opendart-mcp:get_company_info", rawRef: ENDPOINT };
}

export async function financialStatement(args) {
  const corp_code = await corpCodeFrom(args);
  const companyInfo = await remoteCall("get_company_info", { corp_code });
  const raw = await remoteCall("get_financial_account", { corp_code, bsns_year: args.year, reprt_code: args.reportCode || "11011", fs_div: "CFS" });
  return { data: normalizeFinancialStatement(companyInfo, raw, args), sourceApi: "opendart-mcp:get_financial_account", rawRef: ENDPOINT };
}
