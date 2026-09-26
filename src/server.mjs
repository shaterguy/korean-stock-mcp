import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { failure, success, NAVER_SOURCE_WARNING, ProviderError } from "./common.mjs";
import * as naver from "./providers/naver.mjs";
import * as dart from "./providers/dart.mjs";

const annotations = Object.freeze({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true });
const errorSchema = z.object({ code: z.string(), message: z.string(), retry_after_sec: z.number().optional(), candidates: z.array(z.object({ stock_code: z.string(), name: z.string() })).optional() });
const metaSchema = z.object({ source: z.enum(["KIS","DART","CACHE","COMPUTED"]), source_api: z.string().optional(), as_of: z.string().optional(), cached: z.boolean().optional(), cache_ttl_sec: z.number().optional(), request_id: z.string().optional(), raw_ref: z.string().optional() });
const outputSchema = { ok: z.boolean(), data: z.unknown().optional(), error: errorSchema.optional(), meta: metaSchema, warnings: z.array(z.string()).optional() };

export const PLAYMCP_TOOL_NAMES = Object.freeze([
  "resolve_stock", "get_stock_master", "stock_get_quote", "stock_get_orderbook", "stock_get_price_history",
  "resolve_etf", "etf_get_quote", "etf_get_holdings", "market_get_index", "market_get_sector", "market_get_news", "market_get_movers",
  "dart_search_filings", "dart_get_company_overview", "dart_get_financial_statement", "system_health",
]);

export const COVERAGE = Object.freeze({
  resolve_stock: "full", get_stock_master: "partial", stock_get_quote: "partial", stock_get_orderbook: "unsupported",
  stock_get_price_history: "partial", resolve_etf: "full", etf_get_quote: "partial", etf_get_holdings: "partial",
  market_get_index: "partial", market_get_sector: "partial", market_get_news: "full", market_get_movers: "partial",
  dart_search_filings: "partial", dart_get_company_overview: "full", dart_get_financial_statement: "partial", system_health: "full",
});

function register(server, name, description, inputSchema, handler, source = "COMPUTED") {
  server.registerTool(name, { title: name, description, inputSchema, outputSchema, annotations }, async (args) => {
    try {
      const r = await handler(args);
      const effectiveSource = r.source || source;
      const warnings = [...(effectiveSource === "COMPUTED" && r.sourceApi?.startsWith("naver") ? [NAVER_SOURCE_WARNING] : []), ...(r.warnings || [])];
      return success(r.data, { source: effectiveSource, sourceApi: r.sourceApi, warnings, cached: r.cached, rawRef: r.rawRef });
    } catch (e) {
      const warnings = source === "COMPUTED" ? [NAVER_SOURCE_WARNING] : [];
      return failure(e, { source, sourceApi: e?.sourceApi, warnings });
    }
  });
}

async function resolveCode(value) {
  if (/^[0-9A-Z]{6}$/i.test(value)) return value.toUpperCase();
  const r = await naver.resolveStock(value, { limit: 2 });
  if (r.data.matches.length > 1 && r.data.matches[0].name !== value) {
    const e = new ProviderError("AMBIGUOUS_STOCK", `Ambiguous stock query: ${value}`);
    e.candidates = r.data.matches.map(({stock_code,name}) => ({stock_code,name}));
    throw e;
  }
  return r.data.matches[0].stock_code;
}

export function createMcpServer() {
  const server = new McpServer({ name: "korean-stock-mcp", version: "0.1.0-dev3" });
  register(server, "resolve_stock", "Resolve a Korean listed stock name, abbreviation, or code.", { query:z.string().min(1), market:z.enum(["KOSPI","KOSDAQ","KONEX","ALL"]).default("ALL"), limit:z.number().int().min(1).max(50).default(10) }, (a)=>naver.resolveStock(a.query,a));
  register(server, "get_stock_master", "Return the current Korean listed-instrument master snapshot from public Naver sources.", { market:z.enum(["KOSPI","KOSDAQ","KONEX","ALL"]).default("ALL"), include_delisted:z.boolean().default(false), updated_after:z.string().optional() }, naver.getStockMaster);
  register(server, "stock_get_quote", "Get a Korean stock quote and common valuation fields.", { stock_code:z.string().min(1), market_div_code:z.string().default("J"), include_extended:z.boolean().default(true) }, async (a)=>naver.stockQuote(await resolveCode(a.stock_code),a));
  register(server, "stock_get_orderbook", "Get Korean stock orderbook. Returns an explicit compatibility error unless a stable no-secret ladder source is currently verified.", { stock_code:z.string().min(1), market_div_code:z.string().default("J"), depth:z.number().int().min(1).max(10).default(10) }, async ()=>{ throw new ProviderError("UNSUPPORTED_PUBLIC_SOURCE","Current no-secret Naver page did not expose a stable orderbook ladder during WORK-B proof"); });
  register(server, "stock_get_price_history", "Get daily/weekly/monthly/year price history.", { stock_code:z.string().min(1), period:z.enum(["D","W","M","Y"]).default("D"), start_date:z.string().optional(), end_date:z.string().optional(), adjusted:z.boolean().default(true), limit:z.number().int().min(1).max(100).default(100) }, async(a)=>naver.stockHistory(await resolveCode(a.stock_code),a));
  register(server, "resolve_etf", "Resolve a Korean ETF by name or code.", { query:z.string().min(1), limit:z.number().int().min(1).max(50).default(10) }, (a)=>naver.resolveEtf(a.query,a));
  register(server, "etf_get_quote", "Get Korean ETF quote/NAV fields available from public Naver data.", { stock_code:z.string().min(1), market_div_code:z.string().default("J") }, async(a)=>naver.etfQuote((await naver.resolveEtf(a.stock_code,{limit:1})).data.matches[0].stock_code));
  register(server, "etf_get_holdings", "Get Korean ETF constituent holdings when a verified public constituent structure is available.", { stock_code:z.string().min(1), market_div_code:z.string().default("J"), limit:z.number().int().min(1).max(200).default(30) }, async(a)=>naver.etfHoldings((await naver.resolveEtf(a.stock_code,{limit:1})).data.matches[0].stock_code,a));
  register(server, "market_get_index", "Get KOSPI/KOSDAQ/KOSPI200 quote or price history.", { index:z.enum(["KOSPI","KOSDAQ","KOSPI200"]).default("KOSPI"), mode:z.enum(["quote","history"]).default("quote"), period:z.enum(["D","W","M"]).default("D"), date:z.string().optional(), limit:z.number().int().min(1).max(100).default(30) }, (a)=>naver.indexData(a.index,a));
  register(server, "market_get_sector", "Get KIS sector metadata plus market data only where an exact no-secret public index mapping is verified.", { sector_code:z.string().min(1), period:z.enum(["D","W","M","Y"]).default("D"), start_date:z.string().optional(), end_date:z.string().optional(), limit:z.number().int().min(1).max(50).default(30) }, (a)=>naver.marketSector(a.sector_code,a));
  register(server, "market_get_news", "Get Korean stock or market news titles from public Naver news JSON.", { stock_code:z.string().optional(), date:z.string().optional(), time:z.string().optional(), limit:z.number().int().min(1).max(200).default(20) }, naver.marketNews);
  register(server, "market_get_movers", "Rank Korean market instruments by supported public snapshot fields.", { ranking_type:z.enum(["volume","change_rate","market_cap","trading_value","dividend_yield","short_sale","credit_balance","new_high_low"]), market:z.enum(["KOSPI","KOSDAQ","ALL"]).default("ALL"), direction:z.enum(["top","bottom"]).default("top"), limit:z.number().int().min(1).max(30).default(30) }, naver.marketMovers);
  register(server, "dart_search_filings", "Search OpenDART disclosures through the existing no-secret OpenDART MCP.", { companyName:z.string().min(1).optional(), stockCode:z.string().regex(/^\d{6}$/).optional(), corpCode:z.string().min(1).optional(), corp_code:z.string().min(1).optional(), stock_code:z.string().regex(/^\d{6}$/).optional(), start_date:z.string().optional(), end_date:z.string().optional(), disclosure_type:z.enum(["A","B","C","D","E","F","G","H","I","J","ALL"]).default("ALL"), final_only:z.boolean().default(true), page:z.number().int().min(1).default(1), page_size:z.number().int().min(1).max(100).default(20) }, dart.searchFilings, "DART");
  register(server, "dart_get_company_overview", "Get OpenDART company overview.", { companyName:z.string().min(1).optional(), stockCode:z.string().regex(/^\d{6}$/).optional() }, dart.companyOverview, "DART");
  register(server, "dart_get_financial_statement", "Get OpenDART primary financial accounts and rows.", { companyName:z.string().min(1).optional(), stockCode:z.string().regex(/^\d{6}$/).optional(), year:z.string().regex(/^\d{4}$/), reportCode:z.enum(["11013","11012","11014","11011"]).default("11011") }, dart.financialStatement, "DART");
  register(server, "system_health", "Report Korean stock compatibility MCP status and current coverage.", {}, async()=>({ data:{ status:"ok", server:"korean-stock-mcp", version:"0.1.0-dev3", endpoint:"/mcp", read_only:true, tools_implemented:PLAYMCP_TOOL_NAMES, tools_stubbed:Object.entries(COVERAGE).filter(([,v])=>v==="unsupported").map(([k])=>k), required_secrets:[], personal_auth_used:false, coverage:COVERAGE }, sourceApi:"mcp-skeleton", warnings:[] }));
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  return { server, transport };
}
