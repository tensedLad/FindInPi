// Cloudflare Pages Function: POST /api/find  {"q": "9876543210"}
// Reads a few bytes from the R2 bucket bound as PI_TABLES (see wrangler.toml).
// The number is sent in the body rather than the URL so phone numbers don't
// end up in URL logs.

import { handleFind } from "../../lib/lookup.js";

export async function onRequestPost({ request, env }) {
  let q;
  try {
    ({ q } = await request.json());
  } catch {
    return Response.json({ error: "Expected a JSON body like {\"q\": \"123\"}." }, { status: 400 });
  }

  const readRange = async (key, offset, length) => {
    const obj = await env.PI_TABLES.get(key, { range: { offset, length } });
    if (!obj) throw new Error(`table ${key} is missing from the bucket`);
    return new Uint8Array(await obj.arrayBuffer());
  };

  try {
    const { status, body } = await handleFind(q, {
      width: Number(env.PI_WIDTH ?? 10),
      digits: Number(env.PI_DIGITS ?? 100_000_000_000),
      readRange,
    });
    return Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error(err);
    return Response.json({ error: "The search tables are not reachable right now." }, { status: 500 });
  }
}
