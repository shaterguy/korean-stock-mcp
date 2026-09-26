import { ProviderError, compactDate, numberValue, changeSign } from "../common.mjs";

const UA = "Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 Chrome/149 Safari/537.36";
const ALLOWED_HOSTS = new Set(["m.stock.naver.com", "api.stock.naver.com", "polling.finance.naver.com", "finance.naver.com"]);
const cache = new Map();
let gate = Promise.resolve();
let lastRequestAt = 0;

function sleep(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
async function limited(fn) {
  const run = gate.then(async () => {
    const wait = Math.max(0, 75 - (Date.now() - lastRequestAt));
    if (wait) await sleep(wait);
    try { return await fn(); }
    finally { lastRequestAt = Date.now(); }
  });
  gate = run.catch(() => undefined);
  return run;
}

async function request(url, { ttlMs = 0, accept = "application/json,text/plain,*/*" } = {}) {
  const parsed = new URL(url);
  if (!ALLOWED_HOSTS.has(parsed.hostname)) throw new ProviderError("HOST_NOT_ALLOWED", `Blocked upstream host: ${parsed.hostname}`);
  const key = parsed.toString();
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { ...hit.value, cached: true };
  const value = await limited(async () => {
    const response = await fetch(parsed, {
      headers: { "user-agent": UA, accept, referer: parsed.hostname === "finance.naver.com" ? "https://finance.naver.com/" : "https://m.stock.naver.com/" },
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new ProviderError(`HTTP_${response.status}`, `Naver upstream returned HTTP ${response.status}`);
    const contentType = response.headers.get("content-type") || "";
    const bytes = new Uint8Array(await response.arrayBuffer());
    const decoder = /euc-kr/i.test(contentType) ? new TextDecoder("euc-kr") : new TextDecoder("utf-8");
    const text = decoder.decode(bytes);
    let json;
    try { json = JSON.parse(text); }
    catch { throw new ProviderError("BAD_UPSTREAM_JSON", `Expected JSON from ${parsed.pathname}`); }
    return { json, url: key };
  });
  if (ttlMs > 0) cache.set(key, { expires: Date.now() + ttlMs, value });
  return { ...value, cached: false };
}

function unwrapFront(json) {
  if (json && typeof json === "object" && "isSuccess" in json) {
    if (!json.isSuccess) throw new ProviderError("NAVER_API_ERROR", json.message || json.detailCode || "Naver front-api error");
    return json.result;
  }
  return json;
}

function codeOf(row) { return String(row?.stock_code ?? row?.stockCode ?? row?.itemCode ?? row?.itemcode ?? row?.code ?? row?.cd ?? "").trim(); }
function nameOf(row) { return String(row?.stockName ?? row?.itemName ?? row?.itemname ?? row?.name ?? row?.nm ?? row?.korName ?? "").trim(); }
function marketOf(row) {
  const v = row?.stockExchangeType?.name ?? row?.stockExchangeName ?? row?.market ?? row?.typeCode ?? row?.sosok ?? row?.mt;
  if (v === "0" || v === 0 || /KOSPI/i.test(String(v))) return "KOSPI";
  if (v === "1" || v === 1 || /KOSDAQ/i.test(String(v))) return "KOSDAQ";
  if (/KONEX/i.test(String(v))) return "KONEX";
  return String(v || "");
}

function collectCandidates(node, out = [], depth = 0) {
  if (depth > 6 || node === null || node === undefined) return out;
  if (Array.isArray(node)) {
    for (const v of node) collectCandidates(v, out, depth + 1);
    return out;
  }
  if (typeof node !== "object") return out;
  const code = codeOf(node);
  const name = nameOf(node);
  if (/^[0-9A-Z]{6}$/.test(code) && name) out.push({ stock_code: code, name, market: marketOf(node), raw: node });
  for (const v of Object.values(node)) if (v && typeof v === "object") collectCandidates(v, out, depth + 1);
  return out;
}

export async function resolveStock(query, { market = "ALL", limit = 10 } = {}) {
  const q = encodeURIComponent(query.trim());
  const { json, url, cached } = await request(`https://m.stock.naver.com/front-api/search/autoComplete?query=${q}&target=stock,index,marketindicator,coin,ipo`, { ttlMs: 60000 });
  const rows = collectCandidates(unwrapFront(json));
  const seen = new Set();
  const matches = [];
  for (const row of rows) {
    if (seen.has(row.stock_code)) continue;
    seen.add(row.stock_code);
    if (market !== "ALL" && row.market && row.market !== market) continue;
    matches.push({ stock_code: row.stock_code, name: row.name, market: row.market || undefined, corp_code: null });
    if (matches.length >= limit) break;
  }
  if (!matches.length && /^[0-9A-Z]{6}$/i.test(query)) {
    try {
      const basic = await stockBasic(query.toUpperCase());
      matches.push({ stock_code: basic.data.itemCode, name: basic.data.stockName, market: marketOf(basic.data), corp_code: null });
    } catch {}
  }
  if (!matches.length) throw new ProviderError("NOT_FOUND", `No stock match for '${query}'`);
  return { data: { matches }, sourceApi: "naver-autocomplete", rawRef: url, cached };
}

async function legacyMarket(market) {
  const sosok = market === "KOSDAQ" ? "1" : "0";
  const url = `https://m.stock.naver.com/api/json/sise/siseListJson.nhn?menu=market_sum&sosok=${sosok}&pageSize=5000&page=1`;
  const { json, cached } = await request(url, { ttlMs: 300000 });
  if (json?.resultCode !== "success" || !Array.isArray(json?.result?.itemList)) throw new ProviderError("NAVER_API_ERROR", "Legacy market master response invalid");
  return { rows: json.result.itemList, total: json.result.totCnt, url, cached };
}

async function konexMaster() {
  const url = "https://finance.naver.com/api/sise/konexItemList.nhn";
  const { json, cached } = await request(url, { ttlMs: 300000 });
  const rows = json?.result?.itemList ?? json?.result?.etfItemList ?? json?.result ?? [];
  return { rows: Array.isArray(rows) ? rows : [], url, cached };
}

export async function getStockMaster({ market = "ALL", include_delisted = false, updated_after } = {}) {
  const warnings = [];
  if (include_delisted) warnings.push("Naver public source exposes current listed instruments only; include_delisted=true cannot be honored.");
  if (updated_after) warnings.push("updated_after is not supported by the public source; current snapshot returned.");
  const markets = market === "ALL" ? ["KOSPI", "KOSDAQ", "KONEX"] : [market];
  const records = [];
  const refs = [];
  let anyCached = true;
  for (const m of markets) {
    const got = m === "KONEX" ? await konexMaster() : await legacyMarket(m);
    refs.push(got.url); anyCached = anyCached && got.cached;
    for (const row of got.rows) {
      const code = codeOf(row), name = nameOf(row);
      if (!code || !name) continue;
      if ((m === "KOSPI" || m === "KOSDAQ") && (row.etf === true || row.etn === true)) continue;
      records.push({
        stock_code: code,
        name,
        name_en: row.enNm ?? row.nameEng ?? undefined,
        market: m,
        market_cap: numberValue(row.mks ?? row.marketValue),
      });
    }
  }
  return { data: { total: records.length, records }, sourceApi: "naver-market-master", rawRef: refs.join(" | "), cached: anyCached, warnings };
}

export async function stockBasic(code) {
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/basic`;
  const { json, cached } = await request(url, { ttlMs: 5000 });
  return { data: json, sourceApi: "naver-stock-basic", rawRef: url, cached };
}

export async function stockIntegration(code) {
  const url = `https://m.stock.naver.com/api/stock/${encodeURIComponent(code)}/integration`;
  const { json, cached } = await request(url, { ttlMs: 15000 });
  return { data: json, sourceApi: "naver-stock-integration", rawRef: url, cached };
}

function metricMap(integration) {
  const m = new Map();
  for (const row of integration?.totalInfos || []) {
    m.set(row.code ?? row.key, row.value);
    if (row.key) m.set(row.key, row.value);
  }
  return m;
}

export async function stockQuote(code, { include_extended = true } = {}) {
  const [basic, integ] = await Promise.all([stockBasic(code), include_extended ? stockIntegration(code) : Promise.resolve(null)]);
  const b = basic.data, m = metricMap(integ?.data);
  const get = (...keys) => { for (const k of keys) if (m.has(k)) return m.get(k); return undefined; };
  const data = {
    stock_code: b.itemCode || code,
    price: numberValue(b.closePrice),
    change: numberValue(b.compareToPreviousClosePrice),
    change_sign: changeSign(b.compareToPreviousPrice),
    change_rate: numberValue(b.fluctuationsRatio),
    volume: numberValue(get("accumulatedTradingVolume", "거래량")),
    trading_value: numberValue(get("accumulatedTradingValue", "거래대금")),
    open: numberValue(get("openPrice", "시가")),
    high: numberValue(get("highPrice", "고가")),
    low: numberValue(get("lowPrice", "저가")),
    market_cap: numberValue(get("marketValue", "시가총액")),
    per: numberValue(get("per", "PER")),
    pbr: numberValue(get("pbr", "PBR")),
    week52_high: numberValue(get("highPriceOf52Weeks", "52주최고")),
    week52_low: numberValue(get("lowPriceOf52Weeks", "52주최저")),
    market: b.stockExchangeType?.name || b.stockExchangeName,
    sector: integ?.data?.industryCode || undefined,
  };
  return { data, sourceApi: "naver-basic+integration", rawRef: basic.rawRef, cached: basic.cached && (integ?.cached ?? true) };
}

const periodMap = { D: "dayCandle", W: "weekCandle", M: "monthCandle", Y: "year" };
export async function stockHistory(code, { period = "D", start_date, end_date, limit = 100, adjusted = true } = {}) {
  const p = periodMap[period] || "dayCandle";
  const url = new URL(`https://api.stock.naver.com/chart/domestic/item/${encodeURIComponent(code)}`);
  url.searchParams.set("periodType", p);
  const start = compactDate(start_date), end = compactDate(end_date);
  if (start) url.searchParams.set("startDateTime", `${start}0000`);
  if (end) url.searchParams.set("endDateTime", `${end}2359`);
  const { json, cached } = await request(url.toString(), { ttlMs: 30000 });
  const rows = (json?.priceInfos || []).filter((r) => {
    const d = compactDate(r.localDate);
    return (!start || d >= start) && (!end || d <= end);
  }).slice(-limit).map((r) => ({
    date: compactDate(r.localDate), open: numberValue(r.openPrice), high: numberValue(r.highPrice), low: numberValue(r.lowPrice), close: numberValue(r.closePrice), volume: numberValue(r.accumulatedTradingVolume), trading_value: numberValue(r.accumulatedTradingValue), change: numberValue(r.compareToPreviousClosePrice), change_sign: changeSign(r.compareToPreviousPrice), is_adjusted: false,
  }));
  const warnings = adjusted ? ["Naver public chart does not expose an explicit adjusted-price flag; raw chart values are returned."] : [];
  return { data: { stock_code: code, period, rows }, sourceApi: "naver-chart-domestic-item", rawRef: url.toString(), cached, warnings };
}

export async function resolveEtf(query, { limit = 10 } = {}) {
  const url = "https://finance.naver.com/api/sise/etfItemList.nhn";
  const { json, cached } = await request(url, { ttlMs: 300000 });
  const q = query.toLowerCase().replace(/\s+/g, "");
  const stocks = json?.result?.etfItemList || json?.result?.itemList || [];
  const matches = stocks.filter((r) => codeOf(r) === query || nameOf(r).toLowerCase().replace(/\s+/g, "").includes(q)).slice(0, limit).map((r) => ({ stock_code: codeOf(r), name: nameOf(r) }));
  if (!matches.length) throw new ProviderError("NOT_FOUND", `No ETF match for '${query}'`);
  return { data: { matches }, sourceApi: "naver-etf-universe", rawRef: url, cached };
}

export async function etfQuote(code) {
  const url = `https://m.stock.naver.com/api/etf/${encodeURIComponent(code)}/basic`;
  const { json: b, cached } = await request(url, { ttlMs: 5000 });
  const row = {};
  const data = {
    stock_code: code,
    price: numberValue(b.closePrice ?? row.closePrice),
    change: numberValue(b.compareToPreviousClosePrice ?? row.compareToPreviousClosePrice),
    change_sign: changeSign(b.compareToPreviousPrice ?? row.compareToPreviousPrice),
    change_rate: numberValue(b.fluctuationsRatio ?? row.fluctuationsRatio),
    volume: numberValue(b.accumulatedTradingVolume ?? row.accumulatedTradingVolume),
    trading_value: numberValue(b.accumulatedTradingValue ?? row.accumulatedTradingValueRaw ?? row.accumulatedTradingValue),
    prev_close: numberValue(b.lastClosePrice),
    open: numberValue(b.openPrice),
    high: numberValue(b.highPrice),
    low: numberValue(b.lowPrice),
    nav: numberValue(b.iNav ?? b.nav ?? row.nav),
    premium_discount_rate: numberValue(b.deviationRate),
    total_nav: numberValue(b.totalNav),
    year_high: numberValue(b.highPriceOf52Weeks),
    year_low: numberValue(b.lowPriceOf52Weeks),
    market_cap: numberValue(b.marketValue ?? row.marketValue),
    market: b.stockExchangeType?.name ?? b.stockExchangeName,
    tracking_index: b.etfBaseIndex ?? b.trackingIndexName ?? b.trackingIndex ?? undefined,
    asset_manager: b.issuerName ?? b.assetManagementCompany ?? b.assetManager ?? undefined,
  };
  return { data, sourceApi: "naver-etf-basic", rawRef: url, cached, warnings: ["KIS 전용 괴리율·추적오차·CU 필드는 Naver 공개 응답에 없으면 생략됩니다."] };
}

export async function etfHoldings(code, { limit = 30 } = {}) {
  const url = `https://m.stock.naver.com/api/etf/${encodeURIComponent(code)}/basic`;
  const { json: b, cached } = await request(url, { ttlMs: 15000 });
  const rows = Array.isArray(b?.constituentList) ? b.constituentList : [];
  if (!rows.length) throw new ProviderError("UNSUPPORTED_PUBLIC_SOURCE", "Naver ETF basic response contains no constituentList for this instrument");
  const holdings = rows.slice(0, limit).map((r) => ({
    stock_code: codeOf(r),
    name: nameOf(r),
    weight: numberValue(r.constituentWeight),
    cu_unit_quantity: numberValue(r.cuUnitQuantity),
    cu_unit: r.cuUnit,
  }));
  return {
    data: { stock_code: code, holdings_count: rows.length, holdings },
    sourceApi: "naver-etf-basic:constituentList",
    rawRef: url,
    cached,
    warnings: ["Naver public ETF basic exposes a bounded top-constituent list; full KIS holdings_count/valuation fields are not reproduced in WORK-A."],
  };
}

export async function indexData(index, { mode = "quote", period = "D", date, limit = 30 } = {}) {
  const code = index === "KOSPI200" ? "KPI200" : index;
  if (mode === "quote") {
    const url = `https://m.stock.naver.com/front-api/stock/domestic/basic?code=${encodeURIComponent(code)}&endType=index`;
    const { json, cached } = await request(url, { ttlMs: 5000 });
    const b = unwrapFront(json);
    return { data: { index, mode, price: numberValue(b.closePrice), change: numberValue(b.compareToPreviousClosePrice), change_sign: changeSign(b.compareToPreviousPrice), change_rate: numberValue(b.fluctuationsRatio), open: numberValue(b.openPrice), high: numberValue(b.highPrice), low: numberValue(b.lowPrice), volume: numberValue(b.accumulatedTradingVolume), trading_value: numberValue(b.accumulatedTradingValue) }, sourceApi: "naver-index-basic", rawRef: url, cached };
  }
  const url = `https://m.stock.naver.com/front-api/stock/domestic/index/price/list?code=${encodeURIComponent(code)}&page=1&pageSize=${Math.min(limit, 100)}`;
  const { json, cached } = await request(url, { ttlMs: 30000 });
  let rows = unwrapFront(json) || [];
  const target = compactDate(date);
  rows = rows.filter((r) => !target || compactDate(r.localTradedAt) <= target).slice(0, limit).map((r) => ({ date: compactDate(r.localTradedAt), open: numberValue(r.openPrice), high: numberValue(r.highPrice), low: numberValue(r.lowPrice), close: numberValue(r.closePrice), change: numberValue(r.compareToPreviousClosePrice), change_sign: changeSign(r.compareToPreviousPrice), change_rate: numberValue(r.fluctuationsRatio), volume: numberValue(r.accumulatedTradingVolume), trading_value: numberValue(r.accumulatedTradingValue) }));
  return { data: { index, mode, period, rows }, sourceApi: "naver-index-price-list", rawRef: url, cached, warnings: period !== "D" ? ["Naver verified endpoint is daily; W/M history aggregation is not performed in WORK-A."] : [] };
}

export async function marketSector(sector_code, opts = {}) {
  const alias = { "0001": "KOSPI", "1001": "KOSDAQ", "2001": "KOSPI200" }[sector_code];
  if (!alias) throw new ProviderError("UNSUPPORTED_PUBLIC_SOURCE", `Sector code ${sector_code} has no verified no-secret Naver index mapping in WORK-A`);
  const result = await indexData(alias, { mode: "history", period: opts.period, date: opts.end_date, limit: opts.limit });
  return { ...result, data: { sector_code, rows: result.data.rows }, warnings: [...(result.warnings || []), "Only canonical broad-index aliases are mapped during WORK-A."] };
}

export async function marketNews({ stock_code, date, time, limit = 20 } = {}) {
  const url = stock_code ? `https://m.stock.naver.com/front-api/news/list/integration?itemCode=${encodeURIComponent(stock_code)}&page=1&pageSize=${Math.min(limit, 200)}` : `https://m.stock.naver.com/front-api/news/category?category=mainnews&page=1&pageSize=${Math.min(limit, 200)}`;
  const { json, cached } = await request(url, { ttlMs: 15000 });
  const result = unwrapFront(json);
  const rows = Array.isArray(result) ? result : (result?.stockNewsList || result?.newsList || result?.items || result?.list || result?.news || []);
  const cutoffDate = compactDate(date);
  const cutoffTime = time ? String(time).replace(/[^0-9]/g, "").slice(0, 6) : undefined;
  const items = rows.filter((r) => {
    if (!cutoffDate) return true;
    const dt = String(r.datetime ?? r.date ?? "").replace(/[^0-9]/g, "");
    if (!dt) return true;
    if (dt.slice(0, 8) < cutoffDate) return true;
    if (dt.slice(0, 8) > cutoffDate) return false;
    return !cutoffTime || dt.slice(8, 14) <= cutoffTime;
  }).slice(0, limit).map((r) => ({ title: r.titleFull ?? r.title, datetime: r.datetime, office: r.officeName, article_id: r.articleId ?? r.id, body: r.body, url: r.url ?? r.endUrl }));
  return { data: { stock_code: stock_code || null, items }, sourceApi: stock_code ? "naver-stock-news" : "naver-market-news", rawRef: url, cached };
}

function moverValue(row, ranking) {
  if (ranking === "volume") return numberValue(row.aq ?? row.accumulatedTradingVolume) ?? -Infinity;
  if (ranking === "change_rate") return numberValue(row.cr ?? row.fluctuationsRatio) ?? -Infinity;
  if (ranking === "market_cap") return numberValue(row.mks ?? row.marketValue) ?? -Infinity;
  if (ranking === "trading_value") return numberValue(row.aa ?? row.accumulatedTradingValue) ?? -Infinity;
  return null;
}

export async function marketMovers({ ranking_type, market = "ALL", direction = "top", limit = 30 }) {
  if (!["volume", "change_rate", "market_cap", "trading_value"].includes(ranking_type)) {
    throw new ProviderError("UNSUPPORTED_PUBLIC_SOURCE", `${ranking_type} ranking has no verified structured no-secret source in WORK-A`);
  }
  const markets = market === "ALL" ? ["KOSPI", "KOSDAQ"] : [market];
  if (markets.includes("KONEX")) throw new ProviderError("UNSUPPORTED_PUBLIC_SOURCE", "KONEX ranking aggregation not implemented in WORK-A");
  const all = [];
  const refs = [];
  for (const m of markets) {
    const got = await legacyMarket(m); refs.push(got.url);
    for (const row of got.rows) {
      const code = codeOf(row), name = nameOf(row); if (!code || !name) continue;
      if (row.etf === true || row.etn === true) continue;
      all.push({ row, market: m, value: moverValue(row, ranking_type) });
    }
  }
  all.sort((a,b) => direction === "bottom" ? a.value - b.value : b.value - a.value);
  const items = all.slice(0, limit).map((x,i) => ({ rank:i+1, stock_code:codeOf(x.row), name:nameOf(x.row), market:x.market, price:numberValue(x.row.nv), change:numberValue(x.row.cv), change_sign:String(x.row.rf ?? ""), change_rate:numberValue(x.row.cr), volume:numberValue(x.row.aq), trading_value:(numberValue(x.row.aa) ?? 0) * 1000000, market_cap:numberValue(x.row.mks) }));
  return { data: { ranking_type, market, items }, sourceApi: "naver-legacy-market-list", rawRef: refs.join(" | "), cached: false, warnings: ["랭킹은 공개 market_sum 스냅샷을 정렬해 계산했습니다."] };
}
