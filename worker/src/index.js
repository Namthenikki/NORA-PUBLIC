/**
 * Likho page-credit service — a Cloudflare Worker on the free tier.
 *
 * It never sees handwriting or documents (Likho renders on the user's laptop).
 * It only keeps the page balance honest:
 *
 *   POST /v1/session      sign-in; grants the free pages once per account
 *                         AND once per laptop
 *   GET  /v1/balance      pages left
 *   POST /v1/buy          a Razorpay payment link for a page pack
 *   POST /v1/voucher      takes pages off the balance and returns a signed
 *                         voucher for one laptop
 *   POST /webhooks/razorpay   credits a paid pack, exactly once
 *   GET  /v1/public-key   the key the app checks vouchers with
 *
 * Every /v1 call carries the user's Google ID token as a Bearer token.
 * Vouchers are Ed25519-signed; the app holds only the public key, so a
 * voucher can't be forged or edited.
 */

const PACKS = { p10: 10, p25: 25, p50: 50, p100: 100 };
const MAX_VOUCHER_PAGES = 100;
const GOOGLE_CERTS = "https://www.googleapis.com/oauth2/v3/certs";
const GOOGLE_ISSUERS = ["accounts.google.com", "https://accounts.google.com"];

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export default {
  async fetch(request, env) {
    try {
      return await route(request, env);
    } catch (err) {
      if (err instanceof HttpError) return json({ error: err.message }, err.status);
      console.error(err);
      return json({ error: "internal error" }, 500);
    }
  },
};

async function route(req, env) {
  const path = new URL(req.url).pathname;
  if (req.method === "GET" && path === "/") return json({ ok: true, service: "likho-credits" });
  if (req.method === "GET" && path === "/v1/public-key") {
    return json({ public_key: env.VOUCHER_PUBLIC_KEY });
  }
  if (req.method === "POST" && path === "/webhooks/razorpay") return razorpayWebhook(req, env);
  if (path.startsWith("/v1/")) {
    const user = await authenticate(req, env);
    if (req.method === "POST" && path === "/v1/session") return session(req, env, user);
    if (req.method === "GET" && path === "/v1/balance") return balance(env, user);
    if (req.method === "POST" && path === "/v1/buy") return buy(req, env, user);
    if (req.method === "POST" && path === "/v1/voucher") return voucher(req, env, user);
  }
  throw new HttpError(404, "not found");
}

// ---------------------------------------------------------------- handlers --

async function session(req, env, user) {
  const { machine } = await readJson(req);
  checkMachine(machine);
  const now = Date.now();
  await env.DB.prepare(
    "INSERT OR IGNORE INTO accounts (sub, email, balance, free_granted, created_at) " +
      "VALUES (?, ?, 0, 0, ?)",
  ).bind(user.sub, user.email, now).run();

  let freeNow = 0;
  const account = await getAccount(env, user.sub);
  if (!account.free_granted) {
    // The laptop is claimed first: a machine that has already given out
    // free pages (to any account) gives none again.
    const free = parseInt(env.FREE_PAGES || "10", 10);
    const [claim] = await env.DB.batch([
      env.DB.prepare(
        "INSERT OR IGNORE INTO machines (machine, free_sub, first_seen) VALUES (?, ?, ?)",
      ).bind(machine, user.sub, now),
    ]);
    if (claim.meta.changes === 1) {
      const res = await env.DB.prepare(
        "UPDATE accounts SET balance = balance + ?, free_granted = 1 " +
          "WHERE sub = ? AND free_granted = 0",
      ).bind(free, user.sub).run();
      if (res.meta.changes === 1) {
        freeNow = free;
      } else {
        // the account got its free pages on another laptop at the same
        // moment: give this laptop's claim back
        await env.DB.prepare("DELETE FROM machines WHERE machine = ? AND free_sub = ?")
          .bind(machine, user.sub).run();
      }
    }
  }
  const after = await getAccount(env, user.sub);
  return json({ email: user.email, balance: after.balance, free_pages_granted: freeNow });
}

async function balance(env, user) {
  const account = await getAccount(env, user.sub);
  return json({ balance: account ? account.balance : 0 });
}

async function buy(req, env, user) {
  const { pack } = await readJson(req);
  const pages = PACKS[pack];
  if (!pages) throw new HttpError(400, `unknown pack; choose one of ${Object.keys(PACKS).join(", ")}`);
  const amount = pages * pricePaise(env);
  const res = await fetch("https://api.razorpay.com/v1/payment_links", {
    method: "POST",
    headers: {
      authorization: "Basic " + btoa(`${env.RAZORPAY_KEY_ID}:${env.RAZORPAY_KEY_SECRET}`),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      amount,
      currency: "INR",
      accept_partial: false,
      description: `Likho - ${pages} pages`,
      customer: { email: user.email },
      notify: { sms: false, email: false },
      reminder_enable: false,
      // the webhook credits whoever is named here — set server-side only
      notes: { sub: user.sub, pages: String(pages) },
    }),
  });
  if (!res.ok) {
    console.error("razorpay payment link failed", res.status, await res.text());
    throw new HttpError(502, "payment provider unavailable, try again");
  }
  const link = await res.json();
  return json({ url: link.short_url, link_id: link.id, pages, amount_paise: amount });
}

async function voucher(req, env, user) {
  const { machine, pages } = await readJson(req);
  checkMachine(machine);
  const n = Number(pages);
  if (!Number.isInteger(n) || n < 1 || n > MAX_VOUCHER_PAGES) {
    throw new HttpError(400, `pages must be a whole number from 1 to ${MAX_VOUCHER_PAGES}`);
  }
  const id = crypto.randomUUID();
  const now = Date.now();
  // One transaction: the voucher is recorded only if the balance covers it,
  // and the balance drops only if the voucher was recorded.
  const [ins] = await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO vouchers (id, sub, machine, pages, created_at) " +
        "SELECT ?, ?, ?, ?, ? WHERE (SELECT balance FROM accounts WHERE sub = ?) >= ?",
    ).bind(id, user.sub, machine, n, now, user.sub, n),
    env.DB.prepare(
      "UPDATE accounts SET balance = balance - ? " +
        "WHERE sub = ? AND EXISTS (SELECT 1 FROM vouchers WHERE id = ?)",
    ).bind(n, user.sub, id),
  ]);
  if (ins.meta.changes !== 1) throw new HttpError(402, "not enough pages");
  const token = await signVoucher(env, {
    v: 1, id, sub: user.sub, machine, pages: n, iat: Math.floor(now / 1000),
  });
  const account = await getAccount(env, user.sub);
  return json({ voucher: token, balance: account.balance });
}

async function razorpayWebhook(req, env) {
  const raw = await req.text();
  const given = req.headers.get("x-razorpay-signature") || "";
  const expected = await hmacHex(env.RAZORPAY_WEBHOOK_SECRET, raw);
  if (!timingSafeEqual(given, expected)) throw new HttpError(401, "bad signature");

  const event = JSON.parse(raw);
  if (event.event !== "payment_link.paid") return json({ ok: true, ignored: event.event });
  const link = event.payload?.payment_link?.entity || {};
  const payment = event.payload?.payment?.entity || {};
  const sub = link.notes?.sub;
  const pages = parseInt(link.notes?.pages, 10);
  if (!sub || !(pages > 0) || !(link.amount_paid >= pages * pricePaise(env))) {
    console.warn("payment does not match a pack", link.id, link.amount_paid, link.notes);
    return json({ ok: true, ignored: "amount or notes mismatch" });
  }
  // One transaction, keyed on the payment link: a retried or replayed webhook
  // finds the link already recorded and credits nothing.
  const now = Date.now();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT OR IGNORE INTO accounts (sub, email, balance, free_granted, created_at) " +
        "VALUES (?, '', 0, 0, ?)",
    ).bind(sub, now),
    env.DB.prepare(
      "UPDATE accounts SET balance = balance + ? WHERE sub = ? " +
        "AND NOT EXISTS (SELECT 1 FROM payments WHERE link_id = ?)",
    ).bind(pages, sub, link.id),
    env.DB.prepare(
      "INSERT OR IGNORE INTO payments (link_id, payment_id, sub, pages, amount, created_at) " +
        "VALUES (?, ?, ?, ?, ?, ?)",
    ).bind(link.id, payment.id || null, sub, pages, link.amount_paid, now),
  ]);
  return json({ ok: true });
}

// ------------------------------------------------------------------ auth --

let googleKeyCache = null;

async function googleKeys() {
  if (googleKeyCache && googleKeyCache.expires > Date.now()) return googleKeyCache.keys;
  const res = await fetch(GOOGLE_CERTS);
  if (!res.ok) throw new HttpError(503, "cannot reach Google to check sign-in");
  const { keys } = await res.json();
  const maxAge = /max-age=(\d+)/.exec(res.headers.get("cache-control") || "");
  googleKeyCache = { keys, expires: Date.now() + (maxAge ? Number(maxAge[1]) : 3600) * 1000 };
  return keys;
}

async function authenticate(req, env) {
  const m = /^Bearer (.+)$/.exec(req.headers.get("authorization") || "");
  if (!m) throw new HttpError(401, "sign in required");
  const parts = m[1].split(".");
  if (parts.length !== 3) throw new HttpError(401, "invalid sign-in token");
  let header, claims;
  try {
    header = JSON.parse(utf8(b64urlDecode(parts[0])));
    claims = JSON.parse(utf8(b64urlDecode(parts[1])));
  } catch {
    throw new HttpError(401, "invalid sign-in token");
  }
  if (header.alg !== "RS256") throw new HttpError(401, "invalid sign-in token");
  const jwk = (await googleKeys()).find((k) => k.kid === header.kid);
  if (!jwk) throw new HttpError(401, "invalid sign-in token");
  const key = await crypto.subtle.importKey(
    "jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"],
  );
  const ok = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5", key, b64urlDecode(parts[2]), bytes(`${parts[0]}.${parts[1]}`),
  );
  if (!ok) throw new HttpError(401, "invalid sign-in token");
  if (!GOOGLE_ISSUERS.includes(claims.iss)) throw new HttpError(401, "invalid sign-in token");
  if (claims.aud !== env.GOOGLE_CLIENT_ID) throw new HttpError(401, "sign-in is not for Likho");
  if (!(claims.exp > Date.now() / 1000)) throw new HttpError(401, "sign-in expired, sign in again");
  if (claims.email_verified === false) throw new HttpError(401, "Google email not verified");
  return { sub: String(claims.sub), email: claims.email || "" };
}

// ------------------------------------------------------------- vouchers --

let signingKey = null;

async function signVoucher(env, payload) {
  if (!signingKey) {
    signingKey = await crypto.subtle.importKey(
      "pkcs8", b64Decode(env.VOUCHER_PRIVATE_KEY), { name: "Ed25519" }, false, ["sign"],
    );
  }
  const body = b64urlEncode(bytes(JSON.stringify(payload)));
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "Ed25519" }, signingKey, bytes(body)));
  return `${body}.${b64urlEncode(sig)}`;
}

// --------------------------------------------------------------- helpers --

async function getAccount(env, sub) {
  return env.DB.prepare("SELECT sub, email, balance, free_granted FROM accounts WHERE sub = ?")
    .bind(sub).first();
}

function checkMachine(machine) {
  // the app sends a SHA-256 of the laptop's hardware ID, never the ID itself
  if (typeof machine !== "string" || !/^[0-9a-f]{64}$/.test(machine)) {
    throw new HttpError(400, "machine must be a 64-character hex SHA-256");
  }
}

function pricePaise(env) {
  return parseInt(env.PRICE_PAISE_PER_PAGE || "200", 10);
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    throw new HttpError(400, "body must be JSON");
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
}

async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey(
    "raw", bytes(secret || ""), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, bytes(message)));
  return [...mac].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const bytes = (s) => new TextEncoder().encode(s);
const utf8 = (b) => new TextDecoder().decode(b);

function b64Decode(s) {
  return Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
}

function b64urlDecode(s) {
  const pad = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return b64Decode(pad);
}

function b64urlEncode(buf) {
  let s = "";
  for (const b of buf) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
