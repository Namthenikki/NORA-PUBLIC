// Make the Ed25519 key pair that signs page vouchers.
//
//   npm run keygen
//
// The PRIVATE key goes into the worker as a secret and nowhere else:
//   npx wrangler secret put VOUCHER_PRIVATE_KEY
// The PUBLIC key goes into wrangler.toml (VOUCHER_PUBLIC_KEY) and into the
// Likho app, which uses it to check vouchers. Nothing is written to disk.

const pair = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
const priv = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey)).toString("base64");
const pub = Buffer.from(await crypto.subtle.exportKey("raw", pair.publicKey)).toString("base64");

console.log("VOUCHER_PRIVATE_KEY (secret - paste into `wrangler secret put`, keep nowhere else):");
console.log(priv);
console.log("\nVOUCHER_PUBLIC_KEY (public - wrangler.toml and the Likho app):");
console.log(pub);
