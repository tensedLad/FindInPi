import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, openSync, readSync, closeSync, existsSync } from "node:fs";
import { join } from "node:path";
import { ENTRY, SHORT_MAX, findFirst, handleFind } from "../lib/lookup.js";

// Pseudo-random digits; the lookup doesn't care whether they are pi.
function testDigits(n, seed = 12345) {
  let x = seed;
  let s = "";
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) % 2 ** 31;
    s += Math.floor((x / 2 ** 31) * 10);
  }
  return s;
}

function put(bytes, i, pos) {
  for (let b = 0; b < ENTRY; b++) bytes[i * ENTRY + b] = Math.floor(pos / 2 ** (8 * b)) % 256;
}

// Same layout builder/src/build.rs writes, built the slow, obvious way.
function buildTables(digits, width) {
  const files = new Map();
  for (let k = 1; k <= Math.min(SHORT_MAX, width); k++) {
    const t = new Uint8Array(10 ** k * ENTRY);
    for (let n = 0; n < 10 ** k; n++) {
      const i = digits.indexOf(String(n).padStart(k, "0"));
      if (i >= 0) put(t, n, i + 1);
    }
    files.set(`short/len${k}.bin`, t);
  }
  for (let d = 0; d < 10; d++) files.set(`len${width}/${d}.bin`, new Uint8Array(10 ** (width - 1) * ENTRY));
  for (let i = 0; i + width <= digits.length; i++) {
    const t = files.get(`len${width}/${digits[i]}.bin`);
    const idx = Number(digits.slice(i + 1, i + width));
    if (t.subarray(idx * ENTRY, (idx + 1) * ENTRY).every((b) => b === 0)) put(t, idx, i + 1);
  }
  const readRange = async (key, offset, length) => {
    const t = files.get(key);
    assert.ok(t, `unexpected table ${key}`);
    assert.ok(offset + length <= t.length, `read past end of ${key}`);
    return t.subarray(offset, offset + length);
  };
  return readRange;
}

const brute = (digits, q) => {
  const i = digits.indexOf(q);
  return i < 0 ? null : i + 1;
};

test("every query of every length matches a brute-force search", async () => {
  const width = 7;
  const digits = testDigits(30000);
  const readRange = buildTables(digits, width);
  for (let k = 1; k <= width; k++) {
    for (let trial = 0; trial < 300; trial++) {
      // Half the queries are taken from the digits so plenty are found.
      const q = trial % 2
        ? digits.substr(Math.floor(Math.random() * (digits.length - width)), k)
        : String(Math.floor(Math.random() * 10 ** k)).padStart(k, "0");
      assert.equal(await findFirst(q, { width, readRange }), brute(digits, q), `query ${q}`);
    }
  }
});

test("handleFind cleans input and reports the digit range", async () => {
  const digits = "1415926535897932384626433832795028841971";
  const readRange = buildTables(digits, 4);
  const opts = { width: 4, digits: digits.length, readRange };

  assert.deepEqual((await handleFind("26-53", opts)).body, {
    query: "2653", found: true, start: 6, end: 9, digitsSearched: 40,
  });
  assert.equal((await handleFind("0000", opts)).body.found, false);
  assert.equal((await handleFind("12345", opts)).status, 400);
  assert.equal((await handleFind("12a", opts)).status, 400);
  assert.equal((await handleFind("", opts)).status, 400);
  assert.equal((await handleFind(undefined, opts)).status, 400);
});

// Optional: check tables made by the Rust builder against the digits they
// were built from.  TABLES=dir PI_TEXT=digits.txt node --test
const { TABLES, PI_TEXT } = process.env;
test("Rust-built tables agree with the digit file", { skip: !(TABLES && PI_TEXT) && "set TABLES and PI_TEXT" }, async () => {
  const meta = JSON.parse(readFileSync(join(TABLES, "meta.json"), "utf8"));
  const digits = readFileSync(PI_TEXT, "latin1").replace(/^3\./, "").replace(/\D/g, "").slice(0, meta.digits);
  const readRange = async (key, offset, length) => {
    const fd = openSync(join(TABLES, key), "r");
    try {
      const buf = Buffer.alloc(length);
      readSync(fd, buf, 0, length, offset);
      return buf;
    } finally {
      closeSync(fd);
    }
  };
  for (let k = 1; k <= meta.width; k++) {
    for (let trial = 0; trial < 40; trial++) {
      const q = String(Math.floor(Math.random() * 10 ** k)).padStart(k, "0");
      assert.equal(await findFirst(q, { width: meta.width, readRange }), brute(digits, q), `query ${q}`);
    }
  }
  if (existsSync(PI_TEXT) && meta.digits >= 58911863) {
    assert.equal(await findFirst("06062006", { width: meta.width, readRange }), 58911856);
  }
});
