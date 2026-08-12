import OpenAI from "openai";

/**
 * Works with any OpenAI-compatible chat completions endpoint —
 * Groq, Mistral, Together, local Ollama (via its OpenAI-compat API), etc.
 * Requires LLM_BASE_URL and LLM_MODEL to be set since defaults don't apply generically.
 */
export async function reviewWithCompatible({ apiKey, model, baseURL, systemPrompt, diffText }) {
  if (!baseURL) {
    throw new Error("LLM_BASE_URL is required when LLM_PROVIDER=compatible");
  }
  if (!model) {
    throw new Error("LLM_MODEL is required when LLM_PROVIDER=compatible");
  }

  const client = new OpenAI({ apiKey: apiKey || "unused", baseURL });

  const response = await client.chat.completions.create({
    model,
    max_tokens: 4000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Here is the pull request diff:\n\n${diffText}` },
    ],
  });

  return response.choices[0]?.message?.content ?? "[]";
}
