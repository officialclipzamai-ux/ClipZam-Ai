import { onRequestPost } from "../functions/api/identify.js";

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === "/api/identify") {
      if (request.method === "POST" && typeof onRequestPost === "function") {
        return onRequestPost({ request, env, ctx });
      }
      return new Response("Method Not Allowed", { status: 405 });
    }

    if (env.ASSETS) {
      const assetRes = await env.ASSETS.fetch(request);
      if (assetRes.status !== 404) {
        return assetRes;
      }
    }

    return new Response("Not Found", { status: 404 });
  },
};
      
