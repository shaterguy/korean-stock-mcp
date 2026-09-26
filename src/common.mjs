import { randomUUID } from "node:crypto";

export class ProviderError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "ProviderError";
    this.code = code;
    Object.assign(this, extra);
  }
}

export function numberValue(value) {
  if (value === null || value === undefined || value === "" || value === "-") return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const cleaned = String(value).replaceAll(",", "").replace(/[^0-9+\-.]/g, "");
  if (!cleaned || cleaned === "." || cleaned === "-" || cleaned === "+") return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

export function changeSign(value) {
  const name = typeof value === "object" && value ? value.name : String(value || "");
  if (name === "RISING" || name === "2" || name === "+") return "2";
  if (name === "FALLING" || name === "5" || name === "-") return "5";
  return "3";
}

export function compactDate(value) {
  if (!value) return undefined;
  return String(value).replace(/[^0-9]/g, "").slice(0, 8) || undefined;
}

export function success(data, { source = "COMPUTED", sourceApi, warnings = [], cached = false, rawRef } = {}) {
  const payload = {
    ok: true,
    data,
    meta: {
      source,
      source_api: sourceApi,
      as_of: new Date().toISOString(),
      cached,
      request_id: `req_${randomUUID()}`,
      ...(rawRef ? { raw_ref: rawRef } : {}),
    },
    warnings,
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload };
}

export function failure(error, { source = "COMPUTED", sourceApi, warnings = [] } = {}) {
  const code = error?.code || "UPSTREAM_ERROR";
  const message = error instanceof Error ? error.message : String(error);
  const payload = {
    ok: false,
    error: {
      code,
      message,
      ...(error?.retry_after_sec ? { retry_after_sec: error.retry_after_sec } : {}),
      ...(error?.candidates ? { candidates: error.candidates } : {}),
    },
    meta: {
      source,
      source_api: sourceApi,
      as_of: new Date().toISOString(),
      cached: false,
      request_id: `req_${randomUUID()}`,
    },
    warnings,
  };
  return { content: [{ type: "text", text: JSON.stringify(payload) }], structuredContent: payload, isError: false };
}

export const NAVER_SOURCE_WARNING = "NAVER_PUBLIC 데이터를 PlayMCP 호환 meta.source enum에 맞춰 COMPUTED로 표기했습니다.";
