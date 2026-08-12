import OpenAI from "openai";

const DEFAULT_MODEL = "gpt-4o";

export async function reviewWithOpenAI({ apiKey, model, systemPrompt, diffText }) {
  const openai = new OpenAI({ apiKey });

  const response = await openai.chat.completions.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 4000,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: `Here is the pull request diff:\n\n${diffText}` },
    ],
  });

  return response.choices[0]?.message?.content ?? "[]";
}
