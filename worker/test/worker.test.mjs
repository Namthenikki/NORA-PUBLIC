// Tests for the credit service, run with plain Node (`npm test`):
// D1 is stood in for by an in-memory SQLite database, Google sign-in by a
// locally generated RSA key, and Razorpay by a stubbed fetch.
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import worker from "../src/index.js";

// ---- a D1-shaped wrapper around node:sqlite ------------------------------ //
function d1(db) {
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    run: async () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    _exec: () => ({ meta: { changes: Number(db.prepare(sql).run(...args).changes) } }),
  });
  return {
    prepare: (sql) => stmt(sql),
    batch: async (stmts) => {
      db.exec("BEGIN");
      try {
        const out = stmts.map((s) => s._exec());
        db.exec("COMMIT");
        return out;
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
    },
  };
}

// ---- fake Google sign-in --------------------------------------------------- //
const CLIENT_ID = "likho-test.apps.googleusercontent.com";
const googleKey = await crypto.subtle.generateKey(
  { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
  true, ["sign", "verify"],
);
const googleJwk = { ...(await crypto.subtle.exportKey("jwk", googleKey.publicKey)), kid: "k1", alg: "RS256", use: "sig" };

const b64url = (buf) => Buffer.from(buf).toString("base64url");
async function idToken(claims) {
  const head = b64url(JSON.stringify({ alg: "RS256", kid: "k1", typ: "JWT" }));
  const body = b64url(JSON.stringify({
    iss: "https://accounts.google.com", aud: CLIENT_ID, email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600, ...claims,
  }));
  const sig = await crypto.subtle.sign("RSASSA-PKCS1-v1_5", googleKey.privateKey, new TextEncoder().encode(`${head}.${body}`));
  return `${head}.${body}.${b64url(sig)}`;
}

// ---- voucher keys ------------------------------------------------------------ //
const voucherKey = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const PRIVATE = Buffer.from(await crypto.subtle.exportKey("pkcs8", voucherKey.privateKey)).toString("base64");
const PUBLIC = Buffer.from(await crypto.subtle.exportKey("raw", voucherKey.publicKey)).toString("base64");

// ---- fetch stub: Google certs and Razorpay ---------------------------------- //
let razorpayCalls = [];
globalThis.fetch = async (url, init = {}) => {
  if (String(url).startsWith("https://www.googleapis.com/")) {
    return new Response(JSON.stringify({ keys: [googleJwk] }), {
      headers: { "cache-control": "public, max-age=3600" },
    });
  }
  if (String(url) === "https://api.razorpay.com/v1/payment_links") {
    razorpayCalls.push(JSON.parse(init.body));
    return new Response(JSON.stringify({ id: `plink_${razorpayCalls.length}`, short_url: "https://rzp.io/i/test" }));
  }
  throw new Error(`unexpected fetch ${url}`);
};

const WEBHOOK_SECRET = "whsec_test";
let env;
beforeEach(() => {
  const db = new DatabaseSync(":memory:");
  db.exec(readFileSync(new URL("../migrations/0001_init.sql", import.meta.url), "utf8"));
  env = {
    DB: d1(db), GOOGLE_CLIENT_ID: CLIENT_ID, VOUCHER_PRIVATE_KEY: PRIVATE,
    VOUCHER_PUBLIC_KEY: PUBLIC, FREE_PAGES: "10", PRICE_PAISE_PER_PAGE: "200",
    RAZORPAY_KEY_ID: "rzp_test", RAZORPAY_KEY_SECRET: "secret", RAZORPAY_WEBHOOK_SECRET: WEBHOOK_SECRET,
  };
  razorpayCalls = [];
});

const LAPTOP_A = "a".repeat(64);
const LAPTOP_B = "b".repeat(64);

async function call(method, path, { token, body, headers = {} } = {}) {
  const res = await worker.fetch(new Request(`https://credits.test${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : (typeof body === "string" ? body : JSON.stringify(body)),
  }), env);
  return { status: res.status, data: await res.json() };
}

async function webhook(payload, secret = WEBHOOK_SECRET) {
  const raw = JSON.stringify(payload);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = Buffer.from(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(raw))).toString("hex");
  return call("POST", "/webhooks/razorpay", { body: raw, headers: { "x-razorpay-signature": sig } });
}

const paid = (linkId, sub, pages, amount) => ({
  event: "payment_link.paid",
  payload: {
    payment_link: { entity: { id: linkId, amount_paid: amount, notes: { sub, pages: String(pages) } } },
    payment: { entity: { id: `pay_${linkId}` } },
  },
});

// ---- tests ----------------------------------------------------------------- //

test("every /v1 call needs a valid Google sign-in", async () => {
  assert.equal((await call("GET", "/v1/balance")).status, 401);
  assert.equal((await call("GET", "/v1/balance", { token: "not.a.token" })).status, 401);
  const wrongApp = await idToken({ sub: "u1", aud: "someone-else" });
  assert.equal((await call("GET", "/v1/balance", { token: wrongApp })).status, 401);
  const expired = await idToken({ sub: "u1", exp: Math.floor(Date.now() / 1000) - 10 });
  assert.equal((await call("GET", "/v1/balance", { token: expired })).status, 401);
  const tampered = (await idToken({ sub: "u1" })).replace(/\.[^.]+\./, "." + b64url(JSON.stringify({
    iss: "https://accounts.google.com", aud: CLIENT_ID, sub: "admin", exp: 9999999999,
  })) + ".");
  assert.equal((await call("GET", "/v1/balance", { token: tampered })).status, 401);
});

test("free pages: once per account and once per laptop", async () => {
  const alice = await idToken({ sub: "alice", email: "a@x.in" });
  const bob = await idToken({ sub: "bob", email: "b@x.in" });

  let r = await call("POST", "/v1/session", { token: alice, body: { machine: LAPTOP_A } });
  assert.deepEqual([r.status, r.data.balance, r.data.free_pages_granted], [200, 10, 10]);
  r = await call("POST", "/v1/session", { token: alice, body: { machine: LAPTOP_A } });
  assert.deepEqual([r.data.balance, r.data.free_pages_granted], [10, 0]);
  r = await call("POST", "/v1/session", { token: alice, body: { machine: LAPTOP_B } });
  assert.deepEqual([r.data.balance, r.data.free_pages_granted], [10, 0], "same account, new laptop");
  r = await call("POST", "/v1/session", { token: bob, body: { machine: LAPTOP_A } });
  assert.deepEqual([r.data.balance, r.data.free_pages_granted], [0, 0], "new account, used laptop");
  r = await call("POST", "/v1/session", { token: bob, body: { machine: "c".repeat(64) } });
  assert.deepEqual([r.data.balance, r.data.free_pages_granted], [10, 10], "new account, new laptop");
});

test("vouchers take pages off the balance and are signed", async () => {
  const alice = await idToken({ sub: "alice", email: "a@x.in" });
  await call("POST", "/v1/session", { token: alice, body: { machine: LAPTOP_A } });

  let r = await call("POST", "/v1/voucher", { token: alice, body: { machine: LAPTOP_A, pages: 4 } });
  assert.equal(r.status, 200);
  assert.equal(r.data.balance, 6);
  const [body, sig] = r.data.voucher.split(".");
  const payload = JSON.parse(Buffer.from(body, "base64url").toString());
  assert.deepEqual([payload.sub, payload.machine, payload.pages], ["alice", LAPTOP_A, 4]);
  const pub = await crypto.subtle.importKey("raw", Buffer.from(PUBLIC, "base64"), { name: "Ed25519" }, false, ["verify"]);
  assert.ok(await crypto.subtle.verify({ name: "Ed25519" }, pub, Buffer.from(sig, "base64url"), new TextEncoder().encode(body)));
  // a voucher edited to more pages no longer verifies
  const forged = Buffer.from(JSON.stringify({ ...payload, pages: 100 })).toString("base64url");
  assert.ok(!(await crypto.subtle.verify({ name: "Ed25519" }, pub, Buffer.from(sig, "base64url"), new TextEncoder().encode(forged))));

  r = await call("POST", "/v1/voucher", { token: alice, body: { machine: LAPTOP_A, pages: 7 } });
  assert.equal(r.status, 402);
  assert.equal((await call("GET", "/v1/balance", { token: alice })).data.balance, 6, "failed voucher costs nothing");
  assert.equal((await call("POST", "/v1/voucher", { token: alice, body: { machine: LAPTOP_A, pages: 0 } })).status, 400);
  assert.equal((await call("POST", "/v1/voucher", { token: alice, body: { machine: "nope", pages: 1 } })).status, 400);
});

test("buying: payment link names the buyer; webhook credits exactly once", async () => {
  const alice = await idToken({ sub: "alice", email: "a@x.in" });
  await call("POST", "/v1/session", { token: alice, body: { machine: LAPTOP_A } });

  const r = await call("POST", "/v1/buy", { token: alice, body: { pack: "p25" } });
  assert.deepEqual([r.status, r.data.url, r.data.amount_paise], [200, "https://rzp.io/i/test", 5000]);
  assert.deepEqual(razorpayCalls[0].notes, { sub: "alice", pages: "25" });
  assert.equal((await call("POST", "/v1/buy", { token: alice, body: { pack: "free" } })).status, 400);

  assert.equal((await webhook(paid("plink_1", "alice", 25, 5000), "wrong-secret")).status, 401);
  assert.equal((await call("GET", "/v1/balance", { token: alice })).data.balance, 10);

  assert.equal((await webhook(paid("plink_1", "alice", 25, 5000))).status, 200);
  assert.equal((await call("GET", "/v1/balance", { token: alice })).data.balance, 35);
  await webhook(paid("plink_1", "alice", 25, 5000));            // Razorpay retry
  assert.equal((await call("GET", "/v1/balance", { token: alice })).data.balance, 35, "replay credits nothing");

  await webhook(paid("plink_2", "alice", 25, 1000));            // underpaid
  assert.equal((await call("GET", "/v1/balance", { token: alice })).data.balance, 35);
});
