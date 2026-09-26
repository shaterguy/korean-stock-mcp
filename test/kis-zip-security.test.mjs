import test from "node:test";
import assert from "node:assert/strict";
import { deflateRawSync } from "node:zlib";

function makeZip({ body, method = 8, declaredSize = body.length }) {
  const name = Buffer.from("idxcode.mst");
  const compressed = method === 8 ? deflateRawSync(body) : Buffer.from(body);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(method, 8);
  local.writeUInt32LE(compressed.length, 18);
  local.writeUInt32LE(declaredSize, 22);
  local.writeUInt16LE(name.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(method, 10);
  central.writeUInt32LE(compressed.length, 20);
  central.writeUInt32LE(declaredSize, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt32LE(0, 42);

  const localRecord = Buffer.concat([local, name, compressed]);
  const centralRecord = Buffer.concat([central, name]);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(centralRecord.length, 12);
  eocd.writeUInt32LE(localRecord.length, 16);
  return Buffer.concat([localRecord, centralRecord, eocd]);
}

function responseFor(bytes, { chunkSize = bytes.length, contentLength } = {}) {
  const source = Buffer.from(bytes);
  const body = new ReadableStream({
    start(controller) {
      for (let offset = 0; offset < source.length; offset += chunkSize) {
        controller.enqueue(source.subarray(offset, Math.min(source.length, offset + chunkSize)));
      }
      controller.close();
    },
  });
  const headers = { "content-type": "application/zip" };
  if (contentLength !== undefined) headers["content-length"] = String(contentLength);
  return new Response(body, { status: 200, headers });
}

async function withProvider(bytes, fn, options = {}) {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => responseFor(bytes, options);
  try {
    const mod = await import(`../src/providers/naver.mjs?kis-security=${Date.now()}-${Math.random()}`);
    return await fn(mod);
  } finally {
    globalThis.fetch = originalFetch;
  }
}

function isBadKisMaster(error) {
  return error?.code === "BAD_KIS_MASTER";
}

test("valid small KIS deflate ZIP succeeds", async () => {
  const zip = makeZip({ body: Buffer.from("A1234Test Sector\n") });
  const result = await withProvider(zip, (mod) => mod.marketSector("1234"), { chunkSize: 7 });
  assert.equal(result.data.sector_code, "1234");
  assert.equal(result.data.sector_name, "Test Sector");
});

test("dishonest ZIP header cannot expand deflate output past 2 MiB", async () => {
  const oversized = Buffer.alloc(2_000_001, 0x41);
  const zip = makeZip({ body: oversized, declaredSize: 64 });
  await assert.rejects(
    withProvider(zip, (mod) => mod.marketSector("1234"), { chunkSize: 257 }),
    isBadKisMaster,
  );
});

test("oversized KIS ZIP response is rejected by the streaming body cap", async () => {
  const tooLarge = Buffer.alloc(2_100_001, 0);
  await assert.rejects(
    withProvider(tooLarge, (mod) => mod.marketSector("1234"), { chunkSize: 131_071, contentLength: 16 }),
    isBadKisMaster,
  );
});

test("unsupported ZIP compression method returns controlled BAD_KIS_MASTER", async () => {
  const zip = makeZip({ body: Buffer.from("A1234Test Sector\n"), method: 99 });
  await assert.rejects(
    withProvider(zip, (mod) => mod.marketSector("1234")),
    isBadKisMaster,
  );
});

test("malformed ZIP returns controlled BAD_KIS_MASTER", async () => {
  await assert.rejects(
    withProvider(Buffer.from("not-a-zip"), (mod) => mod.marketSector("1234")),
    isBadKisMaster,
  );
});
