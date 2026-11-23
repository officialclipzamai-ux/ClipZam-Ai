export async function onRequestPost(context) {
  const { request, env } = context;

  try {
    if (!env.GEMINI_API_KEY) {
      return json({ error: "Server missing GEMINI_API_KEY." }, 500);
    }

    const body = await request.json();
    const { action, payload } = body || {};

    if (action === "gemini") {
      const model = env.GEMINI_MODEL || "gemini-2.5-flash";
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-goog-api-key": env.GEMINI_API_KEY,
          },
          body: JSON.stringify(payload),
        }
      );

      const data = await res.json().catch(() => ({}));
      return json(data, res.status);
    }

    if (action === "tmdb") {
      if (!env.TMDB_TOKEN) {
        return json({ error: "Server missing TMDB_TOKEN." }, 500);
      }
      const { path, params = {} } = payload || {};
      if (!path || !path.startsWith("/")) {
        return json({ error: "Invalid TMDB path." }, 400);
      }

      const qs = new URLSearchParams(params).toString();
      const url = `https://api.themoviedb.org/3${path}${qs ? `?${qs}` : ""}`;
      const res = await fetch(url, {
        headers: {
          Authorization: `Bearer ${env.TMDB_TOKEN}`,
          Accept: "application/json",
        },
      });

      const data = await res.json().catch(() => ({}));
      return json(data, res.status);
    }

    return json({ error: "Unsupported action." }, 400);
  } catch (err) {
    return json({ error: "Proxy error while processing request." }, 500);
  }
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
