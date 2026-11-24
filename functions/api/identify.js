const IMG = "https://image.tmdb.org/t/p/w500";
const MIME_FIX = {
  "video/quicktime": "video/mov",
  "audio/mpeg": "audio/mp3",
  "audio/x-m4a": "audio/aac",
  "audio/mp4": "audio/aac",
  "audio/x-wav": "audio/wav",
};

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

function parseJSON(text) {
  try {
    return JSON.parse(text);
  } catch (_) {}
  const match = (text || "").match(/\{[\s\S]*\}/);
  if (match) {
    try {
      return JSON.parse(match[0]);
    } catch (_) {}
  }
  return null;
}

async function callGemini(apiKey, model, body) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent( model )}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      body: JSON.stringify(body),
    }
  );

  if (res.status === 429) {
    throw new Error("The AI quota is used up for now. Please try again later.");
  }
    if (!res.ok) {
    const errBody = await res.text().catch(() => "");
    throw new Error(
      `Gemini ${res.status} (${model}): ${errBody.slice(0, 220)}`
    );
    }
  const json = await res.json();
  const parts = json?.candidates?.[0]?.content?.parts || [];
  return parts.map((p) => p.text || "").join("");
}

async function verifyWithWebSearch(apiKey, model, guessObj, clue) {
  const lines = (guessObj.dialogue || []).map((l) => `"${l}"`).join(" / ");
  const prompt = `A short clip contains these spoken lines: ${lines} ${clue ? `Additional user clues: ${clue}\n` : ""}Initial guess: ${ guessObj.title ? `${guessObj.title} (${guessObj.type || "?"})` : "none" }. Use web search to find which movie or TV episode these lines come from. Reply with ONLY JSON: {"title":"official English title or null","year":number or null,"type":"movie" or "tv","season":number or null,"episode":number or null,"confidence":number 0-1} Do not guess. If the search does not confirm it, set title to null.`;

  const rawText = await callGemini(apiKey, model, {
    contents: [{ parts: [{ text: prompt }] }],
    tools: [{ google_search: {} }],
  });

  const verified = parseJSON(rawText);
  if (!verified || !verified.title) return guessObj;

  const sameTitle =
    guessObj.title &&
    verified.title.toLowerCase() === guessObj.title.toLowerCase();

  if (sameTitle) {
    return {
      ...guessObj,
      season: verified.season ?? guessObj.season,
      episode: verified.episode ?? guessObj.episode,
      confidence: Math.max(guessObj.confidence || 0, verified.confidence || 0),
      evidence: `${guessObj.evidence || ""} Confirmed by web search.`.trim(),
    };
  }

  if ((verified.confidence || 0) > (guessObj.confidence || 0)) {
    return {
      ...guessObj,
      title: verified.title,
      year: verified.year ?? guessObj.year,
      type: verified.type || guessObj.type,
      season: verified.season,
      episode: verified.episode,
      confidence: verified.confidence,
      evidence: "Found by searching the spoken lines.",
    };
  }

  return guessObj;
}

async function callTmdb(token, path, params = {}) {
  const qs = new URLSearchParams(params).toString();
  const res = await fetch(
    `https://api.themoviedb.org/3${path}${qs ? `?${qs}` : ""}`,
    {
      headers: { Authorization: `Bearer ${token}` },
    }
  );
  return res.ok ? res.json() : null;
}

function toCard(item) {
  return {
    title: item.title || item.name,
    year: (item.release_date || item.first_air_date || "").slice(0, 4),
    poster: item.poster_path ? IMG + item.poster_path : null,
  };
}

async function enrichWithTmdb(token, guessObj) {
  const result = {
    identified: !!guessObj.title,
    confidence: guessObj.confidence || 0,
    evidence: guessObj.evidence,
    scene_context: guessObj.scene_context,
    characters: Array.isArray(guessObj.characters)
      ? guessObj.characters.slice(0, 3)
      : [],
    dialogue: Array.isArray(guessObj.dialogue)
      ? guessObj.dialogue.slice(0, 3)
      : [],
    season: guessObj.season,
    episode: guessObj.episode,
  };

  if (!guessObj.title) return result;

  const kind = guessObj.type === "tv" ? "tv" : "movie";
  Object.assign(result, {
    title: guessObj.title,
    type: kind,
    year: guessObj.year,
  });

  const fallbackSimilar = (guessObj.similar || []).map((t) => ({ title: t }));
  if (!token) {
    result.similar = fallbackSimilar;
    return result;
  }

  try {
    const searchParams = { query: guessObj.title };
    if (guessObj.year) {
      searchParams[kind === "movie" ? "year" : "first_air_date_year"] =
        guessObj.year;
    }

    let found = await callTmdb(token, `/search/${kind}`, searchParams);
    if (!found?.results?.length) {
      found = await callTmdb(token, `/search/${kind}`, {
        query: guessObj.title,
      });
    }

    const hit = found?.results?.[0];
    if (!hit) {
      result.similar = fallbackSimilar;
      return result;
    }

    Object.assign(result, {
      title: hit.title || hit.name,
      year: toCard(hit).year,
      poster: toCard(hit).poster,
      backdrop: hit.backdrop_path
        ? `https://image.tmdb.org/t/p/w780${hit.backdrop_path}`
        : null,
      overview: hit.overview,
      rating: Math.round((hit.vote_average || 0) * 10) / 10,
      tmdb_url: `https://www.themoviedb.org/${kind}/${hit.id}`,
    });

    const [ep, sim, providers, videos] = await Promise.all([
      kind === "tv" && guessObj.season && guessObj.episode
        ? callTmdb(
            token,
            `/tv/${hit.id}/season/${guessObj.season}/episode/${guessObj.episode}`
          )
        : Promise.resolve(null),
      callTmdb(token, `/${kind}/${hit.id}/recommendations`),
      callTmdb(token, `/${kind}/${hit.id}/watch/providers`),
      callTmdb(token, `/${kind}/${hit.id}/videos`),
    ]);

    if (ep) {
      result.episode_title = ep.name;
      result.episode_overview = ep.overview;
      if (ep.still_path) {
        result.episode_still = `https://image.tmdb.org/t/p/w780${ep.still_path}`;
      }
    }

    const items = (sim?.results || []).slice(0, 8).map(toCard);
    result.similar = items.length ? items : fallbackSimilar;

    const wpResults = providers?.results || {};
    const region =
      wpResults.NG ||
      wpResults.US ||
      wpResults.GB ||
      Object.values(wpResults)[0];
    if (region) {
      const list = region.flatrate || region.rent || region.buy || [];
      result.providers = list.slice(0, 4).map((p) => ({
        name: p.provider_name,
        logo: p.logo_path
          ? `https://image.tmdb.org/t/p/w92${p.logo_path}`
          : null,
      }));
    }

    const vids = videos?.results || [];
    const trailer =
      vids.find(
        (v) => v.site === "YouTube" && v.type === "Trailer" && v.official
      ) ||
      vids.find((v) => v.site === "YouTube" && v.type === "Trailer") ||
      vids.find((v) => v.site === "YouTube");

    if (trailer) {
      result.trailer_key = trailer.key;
    }
  } catch (_) {
    result.similar = result.similar || fallbackSimilar;
  }

  return result;
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const apiKey = env.GEMINI_API_KEY;
    const tmdbToken = env.TMDB_TOKEN;
    const model = env.GEMINI_MODEL || "gemini-3.8-flash";

    if (!apiKey) {
      return jsonResponse(
        { error: "Server missing GEMINI_API_KEY secret." },
        500
      );
    }

    const body = await request.json();
    const mediaBase64 = body?.mediaBase64;
    const clue = typeof body?.clue === "string" ? body.clue.trim() : "";

    if (!mediaBase64) {
      return jsonResponse({ error: "No clip data received." }, 400);
    }

    const rawMime = String(body?.mimeType || "video/mp4").split(";")[0];
    const mimeType = MIME_FIX[rawMime] || rawMime;

    const basePrompt =
      typeof body?.prompt === "string" && body.prompt.trim()
        ? body.prompt.trim()
        : `You are a movie and TV identification expert. Watch and listen to this short clip (max 15s). Use ALL clues: spoken dialogue, accents, music, on-screen text, actors, costumes, locations, cinematography. Return ONLY JSON with: {"title":"official title in English","year":2010 or null,"type":"movie" or "tv","season":number or null,"episode":number or null,"confidence":number 0-1,"evidence":"one short sentence","scene_context":"short 3-6 word scene description","characters":["up to 3 characters or actors"],"dialogue":["up to 3 short spoken lines"],"similar":["up to 5 similar titles"]} If you cannot identify it, set title to null and confidence to 0. Never invent a title.`;

    const fullPrompt = clue
      ? `${basePrompt}\nAdditional user clues (dialogue, scene details, or actors): ${clue}`
      : basePrompt;

    const rawGeminiText = await callGemini(apiKey, model, {
      contents: [
        {
          parts: [
            { inline_data: { mime_type: mimeType, data: mediaBase64 } },
            { text: fullPrompt },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        temperature: 0.2,
      },
    });

    let guessObj = parseJSON(rawGeminiText);
    if (!guessObj) {
      return jsonResponse(
        { error: "Could not read the AI answer. Please try again." },
        502
      );
    }

    if (
      Array.isArray(guessObj.dialogue) &&
      guessObj.dialogue.length &&
      (guessObj.confidence || 0) < 0.8
    ) {
      try {
        guessObj = await verifyWithWebSearch(apiKey, model, guessObj, clue);
      } catch (_) {}
    }

    const enriched = await enrichWithTmdb(tmdbToken, guessObj);
    return jsonResponse(enriched, 200);
  } catch (err) {
    return jsonResponse(
      { error: err?.message || "Identification failed." },
      500
    );
  }
}
