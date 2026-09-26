import test from "node:test";
import assert from "node:assert/strict";
import { PLAYMCP_TOOL_NAMES, COVERAGE } from "../src/server.mjs";
import { numberValue, changeSign, koreanWonValue } from "../src/common.mjs";
import { normalizeNewsItem } from "../src/providers/naver.mjs";
import { normalizeCompanyOverview, normalizeFinancialStatement, normalizeFilings } from "../src/providers/dart.mjs";

test("exposes exactly the 16 PlayMCP compatibility tool names",()=>{
  assert.equal(PLAYMCP_TOOL_NAMES.length,16);
  assert.equal(new Set(PLAYMCP_TOOL_NAMES).size,16);
  for(const name of PLAYMCP_TOOL_NAMES) assert.ok(Object.hasOwn(COVERAGE,name));
});
test("numeric normalization preserves market numbers",()=>{
  assert.equal(numberValue("286,500"),286500);
  assert.equal(numberValue("-1.13%"),-1.13);
  assert.equal(numberValue("-"),null);
});
test("change signs map to KIS-compatible codes",()=>{
  assert.equal(changeSign({name:"RISING"}),"2");
  assert.equal(changeSign({name:"FALLING"}),"5");
  assert.equal(changeSign({name:"UNCHANGED"}),"3");
});

test("Korean-formatted trading amounts normalize to KRW",()=>{
  assert.equal(koreanWonValue("8조 6,782억"),8_678_200_000_000);
  assert.equal(koreanWonValue("2조 2,754억"),2_275_400_000_000);
  assert.equal(koreanWonValue("5,504,265"),5_504_265);
});

test("news items expose PlayMCP-compatible major fields without inventing category",()=>{
  assert.deepEqual(normalizeNewsItem({
    id:"0500000111334", articleId:"0000111334", officeId:"050",
    datetime:"202609270721", titleFull:"headline",
  }), {
    id:"0500000111334", provider:"050", date:"20260927", time:"0721",
    title:"headline", category:null,
  });
});

const companyFixture = {
  corp_code:"00126380", corp_name:"삼성전자(주)", corp_name_eng:"SAMSUNG ELECTRONICS CO,.LTD",
  stock_name:"삼성전자", stock_code:"005930", ceo_nm:"전영현, 노태문", corp_cls:"Y",
  jurir_no:"1301110006246", bizr_no:"1248100998", adres:"수원시", hm_url:"www.samsung.com/sec",
  ir_url:"", phn_no:"02-2255-0114", fax_no:"031-200-7538", induty_code:"264", est_dt:"19690113", acc_mt:"12",
};

test("DART company overview maps to PlayMCP company/overview shape",()=>{
  const data = normalizeCompanyOverview(companyFixture);
  assert.deepEqual(data.company,{company_name:"삼성전자",stock_code:"005930",corp_code:"00126380",market:"KOSPI"});
  assert.equal(data.overview.official_name,"삼성전자(주)");
  assert.equal(data.overview.corporation_class_name,"유가증권시장");
  assert.equal(data.overview.ir_url,null);
});

test("DART financial rows map to normalized major accounts",()=>{
  const row=(account_nm,thstrm_amount,sj_nm)=>({account_nm,thstrm_amount,sj_nm,fs_div:"CFS",fs_nm:"연결재무제표"});
  const data=normalizeFinancialStatement(companyFixture,{list:[
    row("매출액","333,605,938,000,000","손익계산서"),
    row("영업이익","43,601,051,000,000","손익계산서"),
    row("당기순이익(손실)","45,206,805,000,000","손익계산서"),
    row("자산총계","566,942,110,000,000","재무상태표"),
    row("부채총계","130,621,773,000,000","재무상태표"),
    row("자본총계","436,320,337,000,000","재무상태표"),
  ]},{year:"2025",reportCode:"11011"});
  assert.equal(data.business_year,"2025");
  assert.equal(data.accounts.revenue.amount_krw,333_605_938_000_000);
  assert.equal(data.accounts.net_income.account_name,"당기순이익");
  assert.equal(data.accounts.total_equity.amount_krw,436_320_337_000_000);
});

test("DART populated filing list maps to PlayMCP contract",()=>{
  const data=normalizeFilings({
    page_no:1,page_count:5,total_count:2727,total_page:546,
    list:[{
      corp_code:"00126380",corp_name:" 삼성전자 ",stock_code:"005930",corp_cls:"Y",
      report_nm:" 임원ㆍ주요주주특정증권등소유상황보고서 ",rcept_no:"20260922000524",
      flr_nm:" 허은녕 ",rcept_dt:"20260922",rm:"",
    }],
  },companyFixture);
  assert.deepEqual(data.company,{company_name:"삼성전자",stock_code:"005930",corp_code:"00126380",market:"KOSPI"});
  assert.deepEqual(data.filings[0],{
    receipt_no:"20260922000524",corp_code:"00126380",corp_name:"삼성전자",stock_code:"005930",
    report_name:"임원ㆍ주요주주특정증권등소유상황보고서",filer_name:"허은녕",submitted_at:"20260922",
    disclosure_type:null,remark:null,url:"https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260922000524",
  });
  assert.equal(data.page,1);
  assert.equal(data.page_size,5);
  assert.equal(data.total_count,2727);
  assert.equal(data.total_page,546);
  assert.equal(Object.hasOwn(data,"total"),false);
});

test("DART empty filing list keeps PlayMCP NO_DATA behavior",()=>{
  assert.throws(()=>normalizeFilings({list:[]}), (error)=>error.code==="NO_DATA");
});
