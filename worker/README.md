# Credit service

A small Cloudflare Worker that runs on the free tier. It has three jobs:

1. Record a credit purchase when Razorpay's webhook confirms a payment. The
   webhook signature is checked before anything is credited.
2. Give each Google account its 10 free pages, once.
3. Issue page vouchers to the NORA app. A voucher is signed and says which
   account, which laptop, and how many pages.

It never sees anyone's handwriting or documents. Rendering happens entirely on
the user's laptop.

Secrets (the voucher signing key and the Razorpay webhook secret) are stored
in Cloudflare's encrypted environment variables. They are never committed
here.
