import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are the Toledo Basement Repair employee handbook assistant.

Answer the employee's question using ONLY the handbook excerpts provided below. Rules:
- If the excerpts contain the answer, give it directly and concisely. Quote or cite the relevant policy wording where it helps.
- If the excerpts do NOT contain enough information to answer, say so plainly: "I couldn't find that in the handbook — you may want to check with Everette or HR." Do NOT guess or fill in from general knowledge.
- Never invent policy, numbers, dates, or procedures that aren't in the excerpts.
- Keep it short and direct. No preamble like "Great question." Just answer.`;

export async function answerFromHandbook(question, chunks) {
  if (!chunks || chunks.length === 0) {
    return "I couldn't find anything relevant in the handbook for that. You may want to rephrase, or check with Everette or HR.";
  }

  const context = chunks
    .map((c, i) => `--- Handbook excerpt ${i + 1} ---\n${c}`)
    .join("\n\n");

  const userMessage = `Handbook excerpts:\n\n${context}\n\n---\n\nEmployee question: ${question}`;

  const resp = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 700,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: userMessage }],
  });

  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
