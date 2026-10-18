const MAX_DIGITS = 10;
const CONTEXT = 24; // digits of pi shown on each side of the match
const TOP_SPEED = 2600; // tape speed in px/s
const MIN_SPIN_MS = 700;
// Your "Buy me a coffee" page, e.g. "https://buymeacoffee.com/yourname".
// Leave empty to hide the coffee links.
const SUPPORT_URL = "https://buymeacoffee.com/tensedlad";

const fmt = new Intl.NumberFormat();
const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;

const $ = (id) => document.getElementById(id);
const form = $("search");
const input = $("q");
const count = $("count");
const go = $("go");
const hint = document.querySelector(".hint");
const stage = $("stage");
const counter = $("counter");
const label = $("odometer-label");
const tape = $("tape");
const track = $("track");
const context = $("context");
const result = $("result");

const defaultHint = hint.textContent;
let busy = false;

// ---------- input ----------

function setDigits(digits) {
  input.value = digits;
  count.textContent = `${digits.length}/${MAX_DIGITS}`;
  count.classList.toggle("full", digits.length === MAX_DIGITS);
  go.disabled = busy || digits.length === 0;
}

input.addEventListener("input", () => {
  const digits = input.value.replace(/\D/g, "");
  if (digits.length > MAX_DIGITS) {
    // Usually a pasted number with a country code: keep the local part.
    hint.textContent = `Kept the last ${MAX_DIGITS} digits (${digits.slice(0, -MAX_DIGITS)} dropped).`;
    setDigits(digits.slice(-MAX_DIGITS));
  } else {
    hint.textContent = defaultHint;
    setDigits(digits);
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  const q = input.value;
  if (!q || busy) return;
  busy = true;
  input.blur(); // closes the phone keyboard so the result has the whole screen
  setDigits(q);
  try {
    await search(q);
  } finally {
    busy = false;
    setDigits(input.value);
  }
});

// ---------- search ----------

// Cloudflare's free plan allows 100,000 searches a day. Past that it answers
// with its own error page (429 / error 1027) instead of our JSON, which is
// what keeps the monthly bill capped.
class DailyLimitError extends Error {}

async function search(q) {
  resetStage(q);
  const answer = postJSON("/api/find", { q }).then(async (r) => ({
    r,
    ctx: r.found ? await fetchContext(r.start, q).catch(() => null) : null,
  }));
  try {
    const out = reduceMotion ? await answer : await animate(answer);
    reveal(q, out);
  } catch (err) {
    if (err instanceof DailyLimitError) showDailyLimit();
    else showError(err.message || "Something went wrong. Try again?");
  }
}

async function postJSON(url, body) {
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("Couldn't reach the server. Check your connection and try again.");
  }
  if (res.status === 429) throw new DailyLimitError();
  if (!(res.headers.get("content-type") || "").includes("application/json")) {
    const page = await res.text().catch(() => "");
    if (page.includes("1027")) throw new DailyLimitError();
    throw new Error("The site is having trouble right now. Try again in a minute.");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `The server answered ${res.status}.`);
  return data;
}

// The digits around the match come from Google's public pi API, where
// start=0 is the "3" and start=p is digit p after the decimal point.
async function fetchContext(start, q) {
  const from = Math.max(0, start - CONTEXT);
  const n = start - from + q.length + CONTEXT;
  const res = await fetch(`https://api.pi.delivery/v1/pi?start=${from}&numberOfDigits=${n}`, {
    signal: AbortSignal.timeout(5000),
  });
  const { content } = await res.json();
  const at = start - from;
  if (content.slice(at, at + q.length) !== q) return null; // never show digits that disagree
  let before = content.slice(0, at);
  if (from === 0) before = `${before[0]}.${before.slice(1)}`;
  return { before: before.padStart(CONTEXT, " "), after: content.slice(at + q.length) };
}

// ---------- animation ----------

function resetStage(q) {
  stage.hidden = false;
  stage.classList.remove("done");
  result.replaceChildren();
  context.replaceChildren();
  label.textContent = "Scanning digit";
  counter.textContent = "1";
  tape.style.setProperty("--n", q.length);
  document.body.classList.add("searched");
  track.style.transform = "";
  track.style.filter = "";
  if (!reduceMotion) {
    const strip = Array.from({ length: 160 }, () => Math.floor(Math.random() * 10)).join("");
    track.textContent = strip + strip; // two copies so the loop is seamless
  }
}

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

// Spins the tape and odometer until `answer` settles, then glides the
// odometer to the real position (in log space, so every order of magnitude
// gets screen time) while the tape slows to a stop.
function animate(answer) {
  return new Promise((resolve, reject) => {
    let settled = null;
    answer.then(
      (value) => (settled = { value }),
      (error) => (settled = { error })
    );

    const loopWidth = track.scrollWidth / 2;
    const t0 = performance.now();
    let last = t0;
    let offset = 0;
    let value = 1;
    let glide = null; // { t0, duration, from, to }

    const frame = (now) => {
      const dt = (now - last) / 1000;
      last = now;
      const elapsed = now - t0;
      let speed;

      if (settled?.error) {
        track.style.filter = "";
        return reject(settled.error);
      }
      if (!glide && settled && elapsed >= MIN_SPIN_MS) {
        const r = settled.value.r;
        const to = r.found ? r.start : r.digitsSearched;
        glide = {
          t0: now,
          duration: Math.min(3400, Math.max(1600, 1300 + 180 * Math.log10(to))),
          from: Math.log(value),
          to: Math.log(to),
        };
      }

      if (glide) {
        const t = Math.min(1, (now - glide.t0) / glide.duration);
        value = Math.exp(glide.from + (glide.to - glide.from) * easeOutCubic(t));
        speed = TOP_SPEED * (1 - t) ** 2;
        if (t === 1) {
          counter.textContent = fmt.format(Math.round(value));
          track.style.filter = "";
          return resolve(settled.value);
        }
      } else {
        speed = TOP_SPEED * Math.min(1, elapsed / 600);
        value = Math.max(value, 10 ** (elapsed / 400)); // climbs while we wait
      }

      offset = (offset + speed * dt) % loopWidth;
      track.style.transform = `translateX(${-offset}px)`;
      track.style.filter = `blur(${(speed / TOP_SPEED) * 2.5}px)`;
      counter.textContent = fmt.format(Math.round(value));
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  });
}

// ---------- result ----------

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  Object.assign(node, attrs);
  node.append(...children);
  return node;
}

const num = (text) => el("span", { className: "num" }, text);

function reveal(q, { r, ctx }) {
  stage.classList.add("done");
  const k = q.length;

  if (!r.found) {
    label.textContent = "Digits searched";
    counter.textContent = fmt.format(r.digitsSearched);
    const oneIn = Math.round(Math.exp(r.digitsSearched / 10 ** k));
    result.replaceChildren(
      el("h2", {}, `Not in the first ${fmt.format(r.digitsSearched)} digits`),
      el("p", {}, "Your number ", num(q), " hasn't shown up yet. ",
        `Only about 1 in ${fmt.format(oneIn)} ${k}-digit numbers is still missing this far in`,
        oneIn >= 100 ? ", so yours is genuinely rare." : "."),
      actions(null)
    );
    return;
  }

  label.textContent = "Starts at digit";
  counter.textContent = fmt.format(r.start);

  const hits = [...q].map((d) => el("span", { className: "hit" }, d));
  const match = el("span", { className: "match" }, ...hits);
  if (ctx) context.replaceChildren(ctx.before, match, ctx.after);
  else context.replaceChildren(match);
  hits.forEach((h, i) => {
    if (reduceMotion) h.classList.add("on");
    else setTimeout(() => h.classList.add("on"), 250 + i * 80);
  });

  result.replaceChildren(
    el("p", { className: "range" }, num(q), " is in π from digit ",
      num(fmt.format(r.start)), " to ", num(fmt.format(r.end)), "."),
    actions(`My number ${q} is in π, from digit ${fmt.format(r.start)} to digit ${fmt.format(r.end)}! Find yours: ${location.origin}`)
  );
}

function actions(shareText) {
  const again = el("button", { type: "button", className: "ghost", textContent: "Search another" });
  again.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    input.focus();
    input.select();
  });
  if (!shareText) return el("div", { className: "actions" }, again);

  const copy = el("button", { type: "button", textContent: "Copy result" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      copy.textContent = "Copied!";
    } catch {
      copy.textContent = "Couldn't copy";
    }
    setTimeout(() => (copy.textContent = "Copy result"), 1800);
  });
  return el("div", { className: "actions" }, copy, again);
}

function coffeeLink(text) {
  return el("a", { className: "button coffee", href: SUPPORT_URL, target: "_blank", rel: "noopener", textContent: text });
}

function showDailyLimit() {
  track.style.filter = "";
  stage.classList.add("done");
  label.textContent = "Back at";
  // The free plan's counter resets at midnight UTC; show that in local time.
  const reset = new Date();
  reset.setUTCHours(24, 0, 0, 0);
  const at = reset.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  counter.textContent = at;
  context.replaceChildren(el("span", { className: "match" },
    ..."π☕".split("").map((c) => el("span", { className: "hit on" }, c))));

  const ok = el("button", { type: "button", className: "ghost", textContent: "OK" });
  ok.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
  });
  result.replaceChildren(
    el("h2", {}, "π is taking a coffee break"),
    el("p", {}, `So many people searched today that the free daily searches are used up. `,
      `This site runs on free hosting to keep it online for almost nothing, and searches start again at ${at}.`),
    SUPPORT_URL ? el("p", {}, "If you'd like to help keep it running, a coffee goes a long way.") : "",
    el("div", { className: "actions" }, ...(SUPPORT_URL ? [coffeeLink("☕ Buy me a coffee")] : []), ok)
  );
}

function showError(message) {
  track.style.filter = "";
  label.textContent = "Search stopped";
  result.replaceChildren(el("p", { className: "error", textContent: message }), actions(null));
}

if (SUPPORT_URL) {
  document.querySelector("footer").append(
    " · ", el("a", { href: SUPPORT_URL, target: "_blank", rel: "noopener" }, "Buy me a coffee ☕")
  );
}

setDigits(input.value.replace(/\D/g, "").slice(0, MAX_DIGITS));
