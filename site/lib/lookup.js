// Answers "where does this number first appear in pi?" from the tables built
// by builder/ (see builder/src/build.rs for the file layout).
//
// Every table entry is 5 bytes, little-endian: the 1-based position of the
// first digit counted after "3.", or 0 when not found.
//   short/len{k}.bin     one entry per k-digit number, k <= SHORT_MAX
//   len{W}/{d}.bin       one entry per W-digit number starting with d
// A query of SHORT_MAX+1..W digits is the smallest entry over all of its
// W-digit extensions, which sit next to each other in one file: a 10-digit
// query reads 5 bytes, a 6-digit one reads 50 KB.

export const ENTRY = 5;
export const SHORT_MAX = 5;

function entryAt(bytes, i) {
  const o = i * ENTRY;
  return (
    bytes[o] +
    bytes[o + 1] * 2 ** 8 +
    bytes[o + 2] * 2 ** 16 +
    bytes[o + 3] * 2 ** 24 +
    bytes[o + 4] * 2 ** 32
  );
}

// readRange(key, offset, length) resolves to a Uint8Array of exactly length bytes.
export async function findFirst(query, { width, readRange }) {
  const k = query.length;
  if (k <= SHORT_MAX) {
    const bytes = await readRange(`short/len${k}.bin`, Number(query) * ENTRY, ENTRY);
    return entryAt(bytes, 0) || null;
  }
  const count = 10 ** (width - k);
  const first = Number(query.slice(1)) * count;
  const bytes = await readRange(`len${width}/${query[0]}.bin`, first * ENTRY, count * ENTRY);
  let best = 0;
  for (let i = 0; i < count; i++) {
    const p = entryAt(bytes, i);
    if (p && (!best || p < best)) best = p;
  }
  return best || null;
}

// Shared request handling for the Cloudflare function and the dev server.
// Returns { status, body } where body is JSON-serialisable.
export async function handleFind(rawQuery, { width, digits, readRange }) {
  const query = typeof rawQuery === "string" ? rawQuery.replace(/[\s\-+().]/g, "") : "";
  if (!/^\d+$/.test(query)) {
    return { status: 400, body: { error: "Type a number using digits only." } };
  }
  if (query.length > width) {
    return { status: 400, body: { error: `Numbers can be at most ${width} digits long.` } };
  }
  const start = await findFirst(query, { width, readRange });
  return {
    status: 200,
    body: {
      query,
      found: start !== null,
      start,
      end: start === null ? null : start + query.length - 1,
      digitsSearched: digits,
    },
  };
}
