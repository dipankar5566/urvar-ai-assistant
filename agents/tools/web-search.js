import dotenv from "dotenv";
dotenv.config();

const TAVILY_API_KEY = process.env.TAVILY_API_KEY;
const RETRYABLE = new Set([429, 500, 502, 503, 504]);
const MAX_RETRIES = 3;
const MAX_CONTENT_CHARS = 500;

export async function webSearch({ query, search_depth = "basic", max_results = 5 }) {
  if (!TAVILY_API_KEY) throw new Error("Missing TAVILY_API_KEY in environment");

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let response;
    try {
      response = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          api_key: TAVILY_API_KEY,
          query,
          search_depth,
          max_results,
          include_answer: true,
        }),
      });
    } catch (err) {
      if (err.name === "AbortError") throw new Error("Tavily search timed out after 15 seconds");
      throw err;
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      const data = await response.json();
      const results = (data.results || []).map((r) => ({
        title: r.title,
        url: r.url,
        content: r.content?.length > MAX_CONTENT_CHARS
          ? r.content.slice(0, MAX_CONTENT_CHARS) + "…"
          : r.content,
        score: r.score,
      }));
      return { answer: data.answer || null, results };
    }

    if (!RETRYABLE.has(response.status) || attempt === MAX_RETRIES) {
      const text = await response.text();
      throw new Error(`Tavily API error ${response.status}: ${text}`);
    }

    await new Promise((r) => setTimeout(r, 1000 * Math.pow(2, attempt)));
  }
}

export const webSearchToolDefinition = {
  name: "web_search",
  description:
    "Search the web for current information about markets, competitors, industry trends, pricing, and news. Use this for any real-time data that is not in the company knowledge base.",
  input_schema: {
    type: "object",
    properties: {
      query: {
        type: "string",
        description: "The search query. Be specific and include relevant keywords.",
      },
      search_depth: {
        type: "string",
        enum: ["basic", "advanced"],
        description: "Use 'advanced' for deeper research; 'basic' for quick lookups.",
      },
      max_results: {
        type: "number",
        description: "Number of results to return (1-10). Default is 5.",
      },
    },
    required: ["query"],
  },
};
