// Propose-a-change (free-form). An admin describes a desired handbook change
// in plain language; the bot reads the handbook, finds the current wording,
// and drafts a before/after proposal for the Strategy Team to review.
// The bot NEVER edits the handbook itself — service account stays read-only.

import Anthropic from "@anthropic-ai/sdk";

const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

// Detect whether a message is an edit proposal. Must START with "update" or
// "edit" (after the mention is stripped) so those words mid-sentence don't
// trigger it.
export function isEditProposal(cleaned) {
  return /^(update|edit)\b/i.test(cleaned.trim());
}

const SYSTEM_PROMPT = `You help route proposed edits to the Toledo Basement Repair employee handbook. You do NOT edit anything — you produce a clear change proposal for a human reviewer.

You are given (1) the full handbook text and (2) an admin's free-form request to change something. Your job:
1. Find the CURRENT handbook wording that the request would change. Quote it exactly as it appears.
2. Draft the NEW wording that reflects what the requester wants, matching the handbook's style.
3. Identify the section/heading where the change belongs.

Respond ONLY with a JSON object, no markdown, no preamble, in exactly this shape:
{
  "found": true or false,
  "section": "the section name/heading, or null",
  "current": "the exact current wording to be replaced, or null if not found",
  "proposed": "the suggested new wording",
  "note": "a short note for the reviewer"
}

Rules:
- If you cannot find current wording that matches the request, set found=false and current=null, but still provide your best "proposed" wording and a "note" explaining the target wasn't located so the reviewer can place it manually.
- If the request is ambiguous or could apply to multiple places, still pick your best guess but say so in "note".
- Never invent policy detail beyond what the request states. Keep "proposed" faithful to the request.
- Output valid JSON only.`;

// Ask Claude to turn a free-form request into a structured before/after.
// Returns the parsed object, or a fallback object on error.
export async function draftProposal(handbookText, requestText) {
  const userMsg = `Handbook:\n\n${handbookText}\n\n---\n\nAdmin's change request: ${requestText}`;

  try {
    const resp = await client.messages.create({
      model: "claude-sonnet-4-6",
      max_tokens: 1000,
      system: SYSTEM_PROMPT,
      messages: [{ role: "user", content: userMsg }],
    });

    const rawText = resp.content
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("")
      .trim();

    const clean = rawText
      .replace(/^```json\s*|\s*```$/g, "")
      .replace(/^```\s*|\s*```$/g, "")
      .trim();
    const parsed = JSON.parse(clean);
    return {
      found: !!parsed.found,
      section: parsed.section || null,
      current: parsed.current || null,
      proposed: parsed.proposed || "(no proposed wording generated)",
      note: parsed.note || "",
    };
  } catch (err) {
    console.error("[propose] draftProposal failed:", err);
    return {
      found: false,
      section: null,
      current: null,
      proposed: requestText,
      note: "Could not auto-draft this change (interpretation error). Forwarding the raw request for manual handling.",
    };
  }
}
