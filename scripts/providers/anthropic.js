import Anthropic from "@anthropic-ai/sdk";

const DEFAULT_MODEL = "claude-sonnet-5";

export async function reviewWithAnthropic({ apiKey, model, systemPrompt, diffText }) {
  const anthropic = new Anthropic({ apiKey });

  const response = await anthropic.messages.create({
    model: model || DEFAULT_MODEL,
    max_tokens: 4000,
    system: systemPrompt,
    messages: [
      { role: "user", content: `Here is the pull request diff:\n\n${diffText}` },
    ],
  });

  const textBlock = response.content.find((b) => b.type === "text");
  return textBlock?.text ?? "[]";
}
