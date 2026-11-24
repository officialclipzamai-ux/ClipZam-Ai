import { getDailyUsage, getSubscriptionState, jsonResponse, normalizeEmail } from "../_sub.js";

export async function onRequestGet(context) {
  try {
    const url = new URL(context.request.url);
    const email = normalizeEmail(url.searchParams.get("email") || "");
    const sub = await getSubscriptionState(context.env, email);
    const usage = await getDailyUsage(context.env, email, sub.dailyLimit);

    return jsonResponse({
      status: true,
      subscription: sub,
      usage,
    });
  } catch (err) {
    return jsonResponse({ error: err?.message || "Failed to fetch subscription status." }, 500);
  }
}

export async function onRequestPost(context) {
  try {
    const body = await context.request.json().catch(() => ({}));
    const email = normalizeEmail(body?.email || "");
    const sub = await getSubscriptionState(context.env, email);
    const usage = await getDailyUsage(context.env, email, sub.dailyLimit);

    return jsonResponse({
      status: true,
      subscription: sub,
      usage,
    });
  } catch (err) {
    return jsonResponse({ error: err?.message || "Failed to fetch subscription status." }, 500);
  }
}
