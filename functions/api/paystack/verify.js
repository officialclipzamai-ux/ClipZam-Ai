import { activateThirtyDayPro, getLimits, jsonResponse, normalizeEmail } from "../_sub.js";

async function handleVerify(request, env, referenceInput, emailInput) {
  const secretKey = env.PAYSTACK_SECRET_KEY;
  if (!secretKey) {
    return jsonResponse({ error: "Server missing PAYSTACK_SECRET_KEY secret." }, 500);
  }

  const reference = typeof referenceInput === "string" ? referenceInput.trim() : "";
  if (!reference || reference.length > 120) {
    return jsonResponse({ error: "Valid Paystack reference is required." }, 400);
  }

  const verifyRes = await fetch(
    `https://api.paystack.co/transaction/verify/${encodeURIComponent(reference)}`,
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
    }
  );

  const payload = await verifyRes.json().catch(() => null);
  const tx = payload?.data;

  if (!verifyRes.ok || !payload?.status || !tx) {
    return jsonResponse(
      { error: payload?.message || "Unable to verify transaction with Paystack." },
      502
    );
  }

  if (tx.status !== "success") {
    return jsonResponse(
      {
        status: false,
        txStatus: tx.status,
        error: `Transaction is not successful (status: ${tx.status}).`,
      },
      400
    );
  }

  const email =
    normalizeEmail(tx.customer?.email) ||
    normalizeEmail(tx.metadata?.email) ||
    normalizeEmail(emailInput);

  if (!email) {
    return jsonResponse({ error: "Could not determine customer email from transaction." }, 400);
  }

  const { proMonthlyNgn } = getLimits(env);
  const expectedKobo = Math.round(proMonthlyNgn * 100);
  const paidKobo = Number(tx.amount || 0);

  if (tx.currency !== "NGN" || paidKobo < expectedKobo) {
    return jsonResponse(
      {
        status: false,
        error: `Paid amount does not match required ₦${proMonthlyNgn} monthly Pro plan.`,
      },
      400
    );
  }

  const sub = await activateThirtyDayPro(env, email, tx.reference || reference, {
    amountNgn: Math.round(paidKobo / 100),
    channel: tx.channel || null,
  });

  return jsonResponse({
    status: true,
    verified: true,
    reference: tx.reference || reference,
    subscription: sub,
  });
}

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const reference = url.searchParams.get("reference") || url.searchParams.get("trxref") || "";
    const email = url.searchParams.get("email") || "";
    return await handleVerify(context.request, context.env, reference, email);
  } catch (err) {
    return jsonResponse({ error: err?.message || "Verification failed." }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const reference = body?.reference || body?.trxref || "";
    const email = body?.email || "";
    return await handleVerify(context.request, context.env, reference, email);
  } catch (err) {
    return jsonResponse({ error: err?.message || "Verification failed." }, 500);
  }
}
