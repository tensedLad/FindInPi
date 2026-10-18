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
  lastDigits = digits;
  count.textContent = `${digits.length}/${MAX_DIGITS}`;
  count.classList.toggle("full", digits.length === MAX_DIGITS);
  go.disabled = busy || digits.length === 0;
}

const digitCount = (text) => text.replace(/\D/g, "").length;

// Typing stops at MAX_DIGITS: refuse keystrokes that would add an extra digit.
input.addEventListener("beforeinput", (event) => {
  if (event.inputType !== "insertText" || !event.data) return;
  const { selectionStart: from, selectionEnd: to, value } = input;
  const after = digitCount(value) - digitCount(value.slice(from, to)) + digitCount(event.data);
  if (after > MAX_DIGITS) event.preventDefault();
});

let lastDigits = "";
let minusTyped = false;

input.addEventListener("input", (event) => {
  const digits = input.value.replace(/\D/g, "");
  const pasted = event.inputType === "insertFromPaste" || event.inputType === "insertFromDrop";
  // A minus in front of the number (not a dash inside a phone number).
  if (/^\s*[-−–]/.test(input.value)) minusTyped = true;
  else if (!digits) minusTyped = false;

  if (digits.length > MAX_DIGITS && pasted) {
    // Usually a phone number with a country code: keep the local part.
    hint.textContent = `Kept the last ${MAX_DIGITS} digits (${digits.slice(0, -MAX_DIGITS)} dropped).`;
    setDigits(digits.slice(-MAX_DIGITS));
  } else if (digits.length > MAX_DIGITS) {
    // A keyboard that ignored beforeinput: undo the extra digit.
    setDigits(lastDigits);
  } else {
    hint.textContent = minusTyped
      ? `π has no minus sign, so this searches ${digits || "just the digits"}.`
      : defaultHint;
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
    const out = reduceMotion ? await answer : await animate(q, answer);
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

const randomDigits = (n) => Array.from({ length: n }, () => Math.floor(Math.random() * 10)).join("");

function resetStage(q) {
  stage.hidden = false;
  stage.classList.remove("done", "landed");
  result.replaceChildren();
  context.replaceChildren();
  label.textContent = "Searching π";
  counter.textContent = "…";
  tape.style.setProperty("--n", q.length);
  document.body.classList.add("searched");
  track.style.transform = "";
  track.style.filter = "";
  track.textContent = "";
  if (!reduceMotion) {
    const strip = randomDigits(160);
    track.textContent = strip + strip; // two copies so the loop is seamless
  }
}

// Lays the real digits of pi out on the tape: `lead` filler digits to scroll
// through, then the digits before the match, the match itself (in its box,
// unlit until it lands) and the digits after it.
function layOutLanding(q, ctx, lead) {
  const hits = [...q].map((d) => el("span", { className: "hit" }, d));
  const match = el("span", { className: "match" }, ...hits);
  const before = ctx ? ctx.before : " ".repeat(CONTEXT);
  const after = ctx ? ctx.after : " ".repeat(CONTEXT);
  track.replaceChildren(randomDigits(lead) + before, match, after + randomDigits(CONTEXT));
  // Track position that puts the middle of the match in the middle of the tape.
  const centre = tape.clientWidth / 2 - (match.offsetLeft + match.offsetWidth / 2);
  return { match, hits, centre };
}

const easeOutCubic = (t) => 1 - (1 - t) ** 3;

// Spins the tape until `answer` settles. Then the counter counts up from 1 to
// the real position (in log space, so every order of magnitude gets screen
// time) while the tape slides through the digits of pi and stops exactly on
// the match. Nothing ever runs backwards.
function animate(q, answer) {
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
    let glide = null; // { t0, duration, to, fromX, distance }

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
        const { r, ctx } = settled.value;
        const to = r.found ? r.start : r.digitsSearched;
        const duration = Math.min(3200, Math.max(1300, 1100 + 260 * Math.log10(to)));
        // Starting at full speed, an ease-out over `duration` covers a third of
        // speed × time, so that is how far back the tape has to start.
        const distance = (TOP_SPEED * duration) / 1000 / 3;
        glide = { t0: now, duration, to, distance };
        label.textContent = "Scanning digit";
        if (r.found) {
          const charWidth = loopWidth / 160;
          const lead = Math.ceil((distance + tape.clientWidth) / charWidth);
          glide.landing = layOutLanding(q, ctx, lead);
          glide.fromX = glide.landing.centre + distance;
        } else {
          glide.fromX = -offset;
        }
      }

      if (glide) {
        const t = Math.min(1, (now - glide.t0) / glide.duration);
        const eased = easeOutCubic(t);
        speed = TOP_SPEED * (1 - t) ** 2;
        counter.textContent = fmt.format(Math.max(1, Math.round(glide.to ** eased)));
        track.style.transform = `translateX(${glide.fromX - glide.distance * eased}px)`;
        track.style.filter = speed > 40 ? `blur(${(speed / TOP_SPEED) * 2.5}px)` : "";
        if (t === 1) return resolve({ ...settled.value, landing: glide.landing });
      } else {
        speed = TOP_SPEED * Math.min(1, elapsed / 600);
        offset = (offset + speed * dt) % loopWidth;
        track.style.transform = `translateX(${-offset}px)`;
        track.style.filter = `blur(${(speed / TOP_SPEED) * 2.5}px)`;
      }
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

function reveal(q, { r, ctx, landing }) {
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

  // The tape has already stopped on the match; without motion, put it there now.
  if (!landing) {
    landing = layOutLanding(q, ctx, 0);
    track.style.transform = `translateX(${landing.centre}px)`;
  }
  stage.classList.add("landed");
  landing.match.classList.add("lit");
  landing.hits.forEach((h, i) => {
    if (reduceMotion) h.classList.add("on");
    else setTimeout(() => h.classList.add("on"), 120 + i * 70);
  });

  result.replaceChildren(
    el("p", { className: "range" }, num(q), " is in π from digit ",
      num(fmt.format(r.start)), " to ", num(fmt.format(r.end)), "."),
    actions(
      `My number ${q} is in π, from digit ${fmt.format(r.start)} to digit ${fmt.format(r.end)}! Find yours: ${location.origin}`,
      drawStory(q, r, ctx) // start drawing now so sharing is instant on tap
    )
  );
}

function actions(shareText, story) {
  const again = el("button", { type: "button", className: "ghost", textContent: "Search another" });
  again.addEventListener("click", () => {
    window.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
    input.focus();
    input.select();
  });
  if (!shareText) return el("div", { className: "actions" }, again);

  // wa.me opens the WhatsApp app on phones and WhatsApp Web on computers,
  // with the message filled in and a chat picker.
  const whatsapp = el("a", {
    className: "button whatsapp",
    href: `https://wa.me/?text=${encodeURIComponent(shareText)}`,
    target: "_blank",
    rel: "noopener",
    ariaLabel: "Share on WhatsApp",
  });
  whatsapp.innerHTML = WHATSAPP_ICON;
  whatsapp.append("WhatsApp");

  const copy = el("button", { type: "button", className: "ghost", textContent: "Copy" });
  copy.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(shareText);
      copy.textContent = "Copied!";
    } catch {
      copy.textContent = "Couldn't copy";
    }
    setTimeout(() => (copy.textContent = "Copy"), 1800);
  });
  const buttons = [whatsapp];
  if (story) buttons.push(storyButton(story));
  return el("div", { className: "actions" }, ...buttons, copy, again);
}

const WHATSAPP_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true" fill="currentColor"><path d="M12 2a10 10 0 0 0-8.6 15.1L2 22l5-1.3A10 10 0 1 0 12 2Zm0 18.2a8.2 8.2 0 0 1-4.2-1.2l-.3-.2-3 .8.8-2.9-.2-.3A8.2 8.2 0 1 1 12 20.2Zm4.5-6.1c-.2-.1-1.5-.7-1.7-.8-.2-.1-.4-.1-.6.1l-.8 1c-.1.2-.3.2-.5.1a6.7 6.7 0 0 1-3.3-2.9c-.3-.4.2-.4.7-1.3.1-.2 0-.3 0-.4l-.8-1.8c-.2-.5-.4-.4-.6-.4h-.5a1 1 0 0 0-.7.3 3 3 0 0 0-.9 2.2 5.2 5.2 0 0 0 1.1 2.8 11.9 11.9 0 0 0 4.6 4c1.7.7 2.3.8 3.2.6.5-.1 1.5-.6 1.7-1.2.2-.6.2-1.1.2-1.2l-.4-.3Z"/></svg>';

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
  context.replaceChildren(el("span", { className: "match lit" },
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

// ---------- story image ----------

const STORY_W = 1080;
const STORY_H = 1920;
const SANS = '"Space Grotesk", system-ui, sans-serif';
const MONO = '"JetBrains Mono", ui-monospace, monospace';

// Draws a 1080×1920 Instagram Story card for the result; resolves to a PNG.
async function drawStory(q, r, ctx) {
  await Promise.all(
    [`700 100px ${MONO}`, `400 40px ${SANS}`, `600 40px ${SANS}`, `700 40px ${SANS}`].map((f) =>
      document.fonts.load(f).catch(() => {})
    )
  );
  const canvas = document.createElement("canvas");
  canvas.width = STORY_W;
  canvas.height = STORY_H;
  const g = canvas.getContext("2d");
  const css = getComputedStyle(document.documentElement);
  const color = (name) => css.getPropertyValue(name).trim();

  g.fillStyle = color("--bg");
  g.fillRect(0, 0, STORY_W, STORY_H);
  const glow = g.createRadialGradient(STORY_W / 2, 880, 0, STORY_W / 2, 880, 620);
  glow.addColorStop(0, "rgba(255, 181, 71, 0.10)");
  glow.addColorStop(1, "rgba(255, 181, 71, 0)");
  g.fillStyle = glow;
  g.fillRect(0, 0, STORY_W, STORY_H);

  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  const text = (str, y, font, fill) => {
    g.font = font;
    g.fillStyle = fill;
    g.fillText(str, STORY_W / 2, y);
  };

  // Header, kept below Instagram's top bar.
  g.font = `600 44px ${SANS}`;
  const head = "Find in ";
  const headW = g.measureText(head).width;
  g.font = "400 52px Georgia, serif";
  const piW = g.measureText("π").width;
  const headX = (STORY_W - headW - piW) / 2;
  g.textAlign = "left";
  g.font = `600 44px ${SANS}`;
  g.fillStyle = color("--muted");
  g.fillText(head, headX, 300);
  g.font = "400 52px Georgia, serif";
  g.fillStyle = color("--accent");
  g.fillText("π", headX + headW, 300);
  g.textAlign = "center";

  text("MY NUMBER IS IN π", 690, `600 32px ${SANS}`, color("--faint"));

  // The tape: real digits of pi around the number, the number boxed.
  const size = Math.min(92, 880 / (q.length * 0.68 + 0.9));
  const gap = size * 0.08;
  const y = 880;
  g.font = `700 ${size}px ${MONO}`;
  g.textAlign = "left";
  g.textBaseline = "middle";
  const advance = g.measureText("0").width + gap;
  const pad = size * 0.3;
  const boxW = q.length * advance + gap + pad * 2;
  const boxH = size * 1.45;
  const boxX = (STORY_W - boxW) / 2;

  const before = ctx ? ctx.before : "";
  const after = ctx ? ctx.after : "";
  // Real digits of pi either side of the box, fading out towards the edges.
  const margin = size * 0.3;
  const side = (chars, startX, step) => {
    chars.forEach((ch, i) => {
      const x = startX + i * step;
      const room = step < 0 ? x : STORY_W - x - advance;
      if (room < 0) return;
      g.globalAlpha = Math.min(1, room / (STORY_W / 2 - boxW / 2)) * 0.9;
      g.fillText(ch, x, y);
    });
    g.globalAlpha = 1;
  };
  g.fillStyle = color("--faint");
  side([...before].reverse(), boxX - margin - advance, -advance);
  side([...after], boxX + boxW + margin + gap, advance);

  g.beginPath();
  g.roundRect(boxX, y - boxH / 2, boxW, boxH, size * 0.2);
  g.fillStyle = "rgba(255, 181, 71, 0.12)";
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = "rgba(255, 181, 71, 0.6)";
  g.stroke();
  g.fillStyle = color("--accent");
  g.shadowColor = "rgba(255, 181, 71, 0.45)";
  g.shadowBlur = 24;
  [...q].forEach((ch, i) => g.fillText(ch, boxX + pad + gap + i * advance, y));
  g.shadowBlur = 0;

  g.textAlign = "center";
  g.textBaseline = "alphabetic";
  text("starting at digit", 1110, `400 42px ${SANS}`, color("--muted"));
  text(fmt.format(r.start), 1240, `700 ${Math.min(116, 1500 / fmt.format(r.start).length)}px ${MONO}`, color("--accent"));
  if (r.end > r.start) text(`through digit ${fmt.format(r.end)}`, 1320, `400 38px ${SANS}`, color("--muted"));

  // Footer, kept above Instagram's reply bar.
  text("Find yours at", 1600, `400 36px ${SANS}`, color("--faint"));
  text(location.host, 1670, `700 54px ${SANS}`, color("--text"));

  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("Couldn't draw the image"))), "image/png")
  );
}

function storyButton(story) {
  const button = el("button", { type: "button", className: "ghost", textContent: "Story" });
  button.ariaLabel = "Share as an Instagram Story image";
  let blob = null;
  story.then((b) => (blob = b), () => (button.hidden = true));

  button.addEventListener("click", async () => {
    // Phones get the share sheet (pick Instagram → Story); computers download.
    const file = new File([blob ?? (await story)], "find-in-pi.png", { type: "image/png" });
    const touch = matchMedia("(pointer: coarse)").matches;
    if (touch && navigator.canShare?.({ files: [file] })) {
      try {
        await navigator.share({ files: [file] });
        return;
      } catch (err) {
        if (err.name === "AbortError") return;
      }
    }
    const link = el("a", { href: URL.createObjectURL(file), download: file.name });
    link.click();
    setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    button.textContent = "Saved!";
    setTimeout(() => (button.textContent = "Story"), 1800);
  });
  return button;
}
