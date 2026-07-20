import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const SYSTEM_PROMPT = `You are reviewing the Toledo Basement Repair employee handbook for INTERNAL conflicts.

You will receive the full handbook text. Your job is to find places where the handbook contradicts itself, is inconsistent, or is ambiguous in a way that could cause confusion. Look specifically for:
- Two different values for the same thing (e.g. PTO stated as 10 days in one place, 12 in another; different notice periods; conflicting dollar amounts or dates).
- Rules that contradict each other (one section allows what another forbids).
- Overlapping policies that could be read as inconsistent.
- Cross-references to sections/policies that don't appear to exist.

Rules for your response:
- Report ONLY genuine conflicts or clear ambiguities you can point to in the text. Quote the conflicting wording from each location and name the section if numbered.
- If something looks like it MIGHT conflict but could be intentional, flag it as "possible — worth a human check" rather than asserting it's wrong.
- Do NOT invent conflicts. If the handbook is internally consistent, say so plainly.
- Be concise: a numbered list of findings, each with the two conflicting bits and where they are. No preamble.
- End with a one-line reminder that a human should verify anything flagged before changing the handbook.`;

export async function scanForConflicts(fullText) {
  if (!fullText || !fullText.trim()) {
    return "I couldn't load the handbook text to scan. Try again in a moment.";
  }

  const resp = await client.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 2000,
    system: SYSTEM_PROMPT,
    messages: [
      {
        role: "user",
        content: `Here is the full employee handbook. Review it for internal conflicts and ambiguities.\n\n---\n\n${fullText}`,
      },
    ],
  });

  return resp.content
    .filter((b) => b.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}
