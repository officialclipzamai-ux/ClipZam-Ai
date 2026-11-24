import { getLimits, jsonResponse, normalizeEmail } from "../_sub.js";

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const secretKey = env.PAYSTACK_SECRET_KEY;

    if (!secretKey) {
      return jsonResponse({ error: "Server missing PAYSTACK_SECRET_KEY secret." }, 500);
    }

    const body = await request.json().catch(() => ({}));
    const email = normalizeEmail(body?.email);

    if (!email) {
      return jsonResponse({ error: "Please enter a valid email address." }, 400);
    }

    const { proMonthlyNgn } = getLimits(env);
    const amountKobo = Math.round(proMonthlyNgn * 100);
    const origin = new URL(request.url).origin;
    const callbackUrl =
      typeof body?.callbackUrl === "string" && body.callbackUrl.startsWith("https://")
        ? body.callbackUrl
        : `${origin}/?paystack_verify=1`;

    const paystackRes = await fetch("https://api.paystack.co/transaction/initialize", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secretKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        amount: amountKobo,
        currency: "NGN",
        callback_url: callbackUrl,
        metadata: {
          app: "ClipZam",
          plan: "pro_monthly",
          duration_days: 30,
          email,
        },
      }),
    });

    const data = await paystackRes.json().catch(() => null);

    if (!paystackRes.ok || !data?.status || !data?.data?.authorization_url) {
      return jsonResponse(
        { error: data?.message || "Failed to initialize Paystack checkout." },
        502
      );
    }

    return jsonResponse({
      status: true,
      reference: data.data.reference,
      access_code: data.data.access_code,
      authorization_url: data.data.authorization_url,
      amount_ngn: proMonthlyNgn,
      duration_days: 30,
    });
  } catch (err) {
    return jsonResponse({ error: err?.message || "Payment initialization failed." }, 500);
  }
}
