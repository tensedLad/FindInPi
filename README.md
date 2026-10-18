# Find in π

**Live at https://pi.gokrypt.in**

Type a birthday or phone number (up to 10 digits) and see where it first
appears in the first 100 billion digits of π:

> Your number **06062006** is in π from digit **58,911,856** to digit **58,911,863**.

## How it works

Nothing is searched when someone presses the button. Every possible answer is
worked out once, ahead of time:

- There are only 10¹⁰ ten-digit numbers. `builder/` reads Google's published
  digits of π once and records, for each number, the position where it first
  starts. That gives a 50 GB table: 10¹⁰ entries of 5 bytes each.
- The table lives in Cloudflare R2. A Cloudflare Worker serves the page, and
  each search reads **5 bytes** from the table with a byte-range request, so every answer comes back in milliseconds and costs
  one R2 read.
- Shorter numbers use the same table: every 10-digit extension of a 7-digit
  number sits in 1,000 consecutive slots, and the answer is the smallest one.
  Numbers of 1–5 digits get their own tiny tables (0.5 MB in total).
- The digits shown around the match come from Google's public
  [pi.delivery](https://pi.delivery/) API. They are checked against the query
  before they're shown.

With 100 billion digits, a 10-digit number has a 99.995% chance of being
found: 1 − e^(−10¹¹ / 10¹⁰). Only about 1 in 22,000 ten-digit numbers is
missing, and for those the site says so.

Positions count digits after the decimal point: in 3.14159…, the `1` is digit 1.

```
wrangler.toml     Cloudflare Worker config: R2 binding, settings
builder/          Rust tool that builds the tables (no dependencies)
site/
  public/         the website (plain HTML/CSS/JS)
  worker.js       Cloudflare Worker: POST /api/find
  lib/lookup.js   table lookup shared by the Worker and the dev server
  dev-server.mjs  local server that reads tables from disk
  test/           lookup tests
```

## Monthly cost

| Item | Usage | Free each month | Cost |
|---|---|---|---|
| R2 storage | 50 GB | 10 GB | 40 GB × $0.015 = **$0.60** |
| R2 reads | 1 per search | 10 million | $0 (then $0.36 per million) |
| Worker | 1 request per search (page files are free) | 100,000 a day | $0 |
| Bandwidth | | always free on R2 | $0 |

That's about **$0.60 a month**. Above 100,000 searches a day the free plan
starts refusing searches; it does not charge you.

**The bill can't go above about $0.60** while the account is on the free
Workers plan. That plan allows at most 100,000 searches a day, about 3.1
million a month, which is well under R2's 10 million free reads. When the
daily limit is hit, the site shows a "π is taking a coffee break" message
with the time searches resume (midnight UTC). Set `SUPPORT_URL` in
`site/public/app.js` to add a "Buy me a coffee" button to that message and
the footer.

## 1. Build the tables (once, on your own computer)

You need about **100 GB of free disk** and **5 GB of RAM per thread**.

1. Install Rust from <https://rustup.rs>.
2. Download the first 100 billion digits (42 GB) from Google's
   [π download page](https://storage.googleapis.com/pi100t/index.html):

   ```sh
   curl -L -o pi0.ycd "https://storage.googleapis.com/pi100t/Pi%20-%20Dec%20-%20Chudnovsky/Pi%20-%20Dec%20-%20Chudnovsky%20-%200.ycd"
   ```

3. Build:

   ```sh
   cd builder
   cargo run --release -- --out ../tables --threads 2 ../pi0.ycd
   ```

   Pick `--threads` so that threads × 5 GB fits in your RAM, and don't go
   above your number of CPU cores. The tool writes `tables/short/`,
   `tables/len10/0.bin` … `9.bin` (5 GB each) and `tables/meta.json`.

   On the machine this was tested on, each of the ten 5 GB files took about
   half an hour. That works out to roughly 2½ hours with `--threads 2`, or
   about 1¼ hours with `--threads 4`. Your machine may be faster or slower.
   If the build stops, run the same command again: finished files are
   skipped.

4. Try it locally before uploading:

   ```sh
   cd site
   node dev-server.mjs --tables ../tables
   # open http://localhost:8787
   ```

## 2. Upload to Cloudflare R2

1. Create a Cloudflare account, open **R2**, and enable it. This needs a
   payment card even on the free tier.
2. Create a bucket named `find-in-pi-tables`.
3. Under **R2 → Manage API tokens**, create a token with *Object Read & Write*
   on that bucket. Note the access key ID, secret, and the S3 endpoint
   `https://<account-id>.r2.cloudflarestorage.com`.
4. Upload with [rclone](https://rclone.org/install/):

   ```sh
   rclone config create r2 s3 provider=Cloudflare \
     access_key_id=<KEY_ID> secret_access_key=<SECRET> \
     endpoint=https://<ACCOUNT_ID>.r2.cloudflarestorage.com
   rclone copy tables r2:find-in-pi-tables --s3-chunk-size 100M --transfers 4 --progress
   ```

   Check that the bucket has `short/len1.bin` … `short/len5.bin`,
   `len10/0.bin` … `len10/9.bin` and `meta.json`.

The bucket stays private. Only the site's Worker reads it.

## 3. Deploy the website

The R2 bucket must exist before the first deploy, because the Worker is bound
to it. The tables can be uploaded later; until then searches return an error.

**From GitHub (recommended):** in Cloudflare, go to **Workers & Pages → Create
→ Import a repository** and pick this repo. Keep the defaults: root directory
`/` and deploy command `npx wrangler deploy`. The Worker name must be
`findinpi`, matching `name` in `wrangler.toml`. Every push to `main` (the
production branch) redeploys.

**From your computer:**

```sh
npx wrangler login
npx wrangler deploy
```

The site is served at **https://pi.gokrypt.in** (set by `routes` in
`wrangler.toml`) and at `https://findinpi.<your-subdomain>.workers.dev`.

## Development

```sh
cd builder && cargo test                # table builder
cd site && npm test                     # lookup logic
```

You can test against real tables without the 100-billion-digit download. Any
text file of digits works as input, and a smaller `--width` keeps the tables
small. For example, 8-digit tables from 200 million digits take about 30
seconds and 500 MB:

```sh
cargo run --release -- --out ../tables --width 8 --threads 4 pi-200m.txt
TABLES=../tables PI_TEXT=pi-200m.txt npm test   # checks tables against the digits
```

## Privacy

Numbers are sent in a POST body, not the URL, and nothing is logged or
stored by the site. Cloudflare can still see the requests it handles.
