import test from "node:test";
import assert from "node:assert/strict";
import { PLAYMCP_TOOL_NAMES, COVERAGE } from "../src/server.mjs";
import { numberValue, changeSign } from "../src/common.mjs";

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
