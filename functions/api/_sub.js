const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...extraHeaders,
    },
  });
}

export function normalizeEmail(raw) {
  if (typeof raw !== "string") return "";
  const cleaned = raw.trim().toLowerCase();
  if (!cleaned || cleaned.length > 254) return "";
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleaned)) return "";
  return cleaned;
}

export function getTodayKey() {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD (UTC)
}

export function getLimits(env) {
  const freeDailyLimit = Math.max(1, Number(env.FREE_DAILY_LIMIT || 3) || 3);
  const proDailyLimit = Math.max(freeDailyLimit, Number(env.PRO_DAILY_FAIR_USE || 150) || 150);
  const proMonthlyNgn = Math.max(100, Number(env.PRO_MONTHLY_NGN || 2500) || 2500);
  return { freeDailyLimit, proDailyLimit, proMonthlyNgn };
}

function subKey(email) {
  return `sub:${email}`;
}

function usageKey(email, dayKey) {
  return `usage:${email}:${dayKey}`;
}

function txKey(reference) {
  return `tx:${reference}`;
}

export async function getSubscriptionState(env, email) {
  const kv = env.CLIPZAM_KV;
  const { freeDailyLimit, proDailyLimit, proMonthlyNgn } = getLimits(env);

  if (!kv || !email) {
    return {
      email: email || null,
      plan: "free",
      isPro: false,
      expiresAt: null,
      daysRemaining: 0,
      dailyLimit: freeDailyLimit,
      proMonthlyNgn,
    };
  }

  const raw = await kv.get(subKey(email), { type: "json" });
  const now = Date.now();

  if (raw && raw.plan === "pro" && typeof raw.expiresAt === "number" && raw.expiresAt > now) {
    const daysRemaining = Math.max(1, Math.ceil((raw.expiresAt - now) / (24 * 60 * 60 * 1000)));
    return {
      email,
      plan: "pro",
      isPro: true,
      expiresAt: raw.expiresAt,
      expiresAtIso: new Date(raw.expiresAt).toISOString(),
      daysRemaining,
      dailyLimit: proDailyLimit,
      lastReference: raw.lastReference || null,
      proMonthlyNgn,
    };
  }

  // If expired, normalize back to free in KV
  if (raw && raw.plan === "pro") {
    await kv.put(
      subKey(email),
      JSON.stringify({
        plan: "free",
        expiredAt: raw.expiresAt,
        revertedAt: now,
        lastReference: raw.lastReference || null,
      })
    );
  }

  return {
    email,
    plan: "free",
    isPro: false,
    expiresAt: raw?.expiresAt || null,
    expiresAtIso: raw?.expiresAt ? new Date(raw.expiresAt).toISOString() : null,
    daysRemaining: 0,
    dailyLimit: freeDailyLimit,
    lastReference: raw?.lastReference || null,
    proMonthlyNgn,
  };
}

export async function activateThirtyDayPro(env, email, reference, meta = {}) {
  const kv = env.CLIPZAM_KV;
  if (!kv) {
    throw new Error("Missing CLIPZAM_KV binding.");
  }

  const normalizedEmail = normalizeEmail(email);
  if (!normalizedEmail) {
    throw new Error("Valid customer email is required.");
  }

  // Idempotency check so webhook + verify cannot double-grant for the same reference
  if (reference) {
    const existingTx = await kv.get(txKey(reference), { type: "json" });
    if (existingTx && existingTx.applied) {
      const current = await getSubscriptionState(env, normalizedEmail);
      return { ...current, alreadyApplied: true };
    }
  }

  const currentState = await getSubscriptionState(env, normalizedEmail);
  const now = Date.now();
  // Extend from current expiry if already active, otherwise start a fresh 30-day window
  const baseTime = currentState.isPro && currentState.expiresAt > now ? currentState.expiresAt : now;
  const expiresAt = baseTime + THIRTY_DAYS_MS;

  const record = {
    plan: "pro",
    email: normalizedEmail,
    activatedAt: now,
    expiresAt,
    lastReference: reference || currentState.lastReference || null,
    amountNgn: meta.amountNgn || getLimits(env).proMonthlyNgn,
    channel: meta.channel || null,
  };

  await kv.put(subKey(normalizedEmail), JSON.stringify(record));

  if (reference) {
    await kv.put(
      txKey(reference),
      JSON.stringify({
        applied: true,
        email: normalizedEmail,
        expiresAt,
        processedAt: now,
      }),
      { expirationTtl: 60 * 60 * 24 * 90 }
    );
  }

  return getSubscriptionState(env, normalizedEmail);
}

export async function getDailyUsage(env, email, dailyLimit) {
  const kv = env.CLIPZAM_KV;
  const day = getTodayKey();
  if (!kv || !email) {
    return { day, used: 0, remaining: dailyLimit, limit: dailyLimit };
  }

  const raw = await kv.get(usageKey(email, day), { type: "json" });
  const used = Number(raw?.count || 0) || 0;
  return {
    day,
    used,
    remaining: Math.max(0, dailyLimit - used),
    limit: dailyLimit,
  };
}

export async function consumeDailyScan(env, email, dailyLimit) {
  const kv = env.CLIPZAM_KV;
  const day = getTodayKey();

  if (!kv || !email) {
    return { allowed: true, day, used: 0, remaining: dailyLimit, limit: dailyLimit };
  }

  const key = usageKey(email, day);
  const raw = await kv.get(key, { type: "json" });
  const currentCount = Number(raw?.count || 0) || 0;

  if (currentCount >= dailyLimit) {
    return {
      allowed: false,
      day,
      used: currentCount,
      remaining: 0,
      limit: dailyLimit,
    };
  }

  const nextCount = currentCount + 1;
  await kv.put(
    key,
    JSON.stringify({ count: nextCount, day, updatedAt: Date.now() }),
    { expirationTtl: 60 * 60 * 48 }
  );

  return {
    allowed: true,
    day,
    used: nextCount,
    remaining: Math.max(0, dailyLimit - nextCount),
    limit: dailyLimit,
  };
      }
    
