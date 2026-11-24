import { activateThirtyDayPro, getLimits, jsonResponse, normalizeEmail } from "../_sub.js";

function timingSafeEqualHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const cleanA = a.trim().toLowerCase();
  const cleanB = b.trim().toLowerCase();
  if (cleanA.length !== cleanB.length || cleanA.length === 0) return false;

  let diff = 0;
  for (let i = 0; i < cleanA.length; i++) {
    diff |= cleanA.charCodeAt(i) ^ cleanB.charCodeAt(i);
  }
  return diff === 0;
}

async function computeHmacSha512Hex(secret, rawBody) {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-512" },
    false,
    ["sign"]
  );
  const sigBuffer = await crypto.subtle.sign("HMAC", key, enc.encode(rawBody));
  return Array.from(new Uint8Array(sigBuffer))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const secretKey = env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
      return jsonResponse({ error: "Missing PAYSTACK_SECRET_KEY" }, 500);
    }

    const signature = request.headers.get("x-paystack-signature") || "";
    const rawBody = await request.text();
    const expectedSig = await computeHmacSha512Hex(secretKey, rawBody);

    if (!timingSafeEqualHex(signature, expectedSig)) {
      return jsonResponse({ error: "Invalid Paystack signature" }, 401);
    }

    const event = JSON.parse(rawBody || "{}");

    if (event?.event === "charge.success" && event?.data?.status === "success") {
      const tx = event.data;
      const email = normalizeEmail(tx.customer?.email) || normalizeEmail(tx.metadata?.email);
      const { proMonthlyNgn } = getLimits(env);
      const expectedKobo = Math.round(proMonthlyNgn * 100);
      const paidKobo = Number(tx.amount || 0);

      if (email && tx.currency === "NGN" && paidKobo >= expectedKobo) {
        await activateThirtyDayPro(env, email, tx.reference || null, {
          amountNgn: Math.round(paidKobo / 100),
          channel: tx.channel || null,
        });
      }
    }

    return jsonResponse({ received: true }, 200);
  } catch (err) {
    return jsonResponse({ error: err?.message || "Webhook error" }, 500);
  }
}
