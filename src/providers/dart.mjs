import { ProviderError } from "../common.mjs";
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
  const warnings = [];
  if (args.disclosure_type && args.disclosure_type !== "ALL") warnings.push("Existing OpenDART MCP proxy does not expose disclosure_type filtering; unfiltered list returned.");
  if (args.final_only === false) warnings.push("Existing OpenDART MCP proxy does not expose final_only filtering.");
  return { data: { page: raw.page_no, page_size: raw.page_count, total: raw.total_count, total_page: raw.total_page, filings: raw.list || [] }, sourceApi: "opendart-mcp:search_disclosures", rawRef: ENDPOINT, warnings };
}

export async function companyOverview(args) {
  const corp_code = await corpCodeFrom(args);
  const raw = await remoteCall("get_company_info", { corp_code });
  return { data: raw, sourceApi: "opendart-mcp:get_company_info", rawRef: ENDPOINT };
}

export async function financialStatement(args) {
  const corp_code = await corpCodeFrom(args);
  const raw = await remoteCall("get_financial_account", { corp_code, bsns_year: args.year, reprt_code: args.reportCode || "11011", fs_div: "CFS" });
  const rows = raw.list || [];
  const keyNames = new Set(["매출액", "영업이익", "당기순이익(손실)", "자산총계", "부채총계", "자본총계"]);
  const key_accounts = rows.filter((r) => r.fs_div === "CFS" && keyNames.has(r.account_nm));
  return { data: { corp_code, year: args.year, report_code: args.reportCode || "11011", key_accounts, rows }, sourceApi: "opendart-mcp:get_financial_account", rawRef: ENDPOINT };
}
