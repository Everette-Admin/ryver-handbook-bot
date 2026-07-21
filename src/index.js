import express from "express";
import { getHandbookText } from "./drive.js";
import { chunkText, retrieve } from "./retrieve.js";
import { answerFromHandbook } from "./answer.js";
import { scanForConflicts } from "./conflicts.js";

const app = express();
app.use(express.json());

// --- Handbook cache -----------------------------------------------------
// Re-fetch from Drive at most every CACHE_TTL ms so we're not downloading
// the file on every single message, but still pick up edits within the day.
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000); // 30 min
let cache = { chunks: null, text: null, name: null, fetchedAt: 0 };

// --- Duplicate-message guard --------------------------------------------
// Ryver retries the outbound webhook if the bot is slow to respond (the
// conflict scan takes several seconds), and each retry would re-run the
// whole request. We remember message IDs we've already started handling
// and ignore repeats. Bounded so it can't grow forever.
const seenMessageIds = new Set();
const SEEN_MAX = 500;
function alreadyHandled(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
  // Trim oldest entries when the set gets too big.
  if (seenMessageIds.size > SEEN_MAX) {
    const oldest = seenMessageIds.values().next().value;
    seenMessageIds.delete(oldest);
  }
  return false;
}

async function getChunks() {
  const now = Date.now();
  if (cache.chunks && now - cache.fetchedAt < CACHE_TTL) {
    return cache;
  }
  const { name, text } = await getHandbookText();
  const chunks = chunkText(text);
  cache = { chunks, text, name, fetchedAt: now };
  console.log(`[cache] Loaded "${name}" -> ${chunks.length} chunks`);
  return cache;
}

// --- Health check -------------------------------------------------------
app.get("/", (_req, res) => res.send("Ryver handbook bot is running."));

// --- Ryver outgoing webhook endpoint ------------------------------------
// Ryver POSTs here when someone messages the bot. We verify a shared token,
// pull the message text, answer it, and post the reply back.
app.post("/ryver", async (req, res) => {
  // 1. Verify the request actually came from your Ryver webhook.
  const token = req.get("x-ryver-token") || req.query.token;
  if (process.env.RYVER_WEBHOOK_TOKEN && token !== process.env.RYVER_WEBHOOK_TOKEN) {
    console.warn("[ryver] Rejected request: bad or missing token.");
    return res.status(401).send("unauthorized");
  }

  // Ack immediately so Ryver doesn't time out; we reply asynchronously.
  res.status(200).send("ok");

  try {
    // Ryver's outgoing webhook payload shape can vary by trigger type.
    // Pull the message text defensively.
    const body = req.body || {};
    // TEMP: dump the raw payload so we can see how Ryver encodes mentions.
    console.log("[ryver] RAW PAYLOAD: " + JSON.stringify(body));
    const question =
      (body.data && body.data.entity && body.data.entity.message) ||
      body.message ||
      body.text ||
      (body.data && (body.data.message || body.data.text)) ||
      (body.data && body.data.body) ||
      body.body ||
      "";

    // Drop duplicate deliveries (Ryver retries slow requests). Keyed on the
    // message's unique id so a retry of the SAME message is ignored.
    const messageId =
      (body.data && body.data.entity && body.data.entity.id) || "";
    if (alreadyHandled(messageId)) {
      console.log(`[ryver] Duplicate delivery of message ${messageId}; ignoring.`);
      return;
    }

    // Ignore messages the bot itself posted, or we'll loop forever
    // (bot posts -> that post fires this webhook -> bot responds again).
    // Match on the bot's numeric Ryver user ID — stable, unlike a display
    // name. Digby's ID is 3045971; override via BOT_USER_ID if it changes.
    const botUserId = process.env.BOT_USER_ID || "3045971";
    const senderId = String((body.user && body.user.id) || "");
    if (senderId && senderId === botUserId) {
      console.log(`[ryver] Ignoring message from the bot itself (id ${senderId}).`);
      return;
    }

    if (!question.trim()) {
      console.log("[ryver] No message text found in payload; skipping.");
      return;
    }

    // Only respond when Digby is actually addressed (@-mentioned). Keeps the
    // bot quiet unless spoken to, and ensures every answer is posted publicly
    // where a human can catch a mistake. (Private DMs intentionally unsupported:
    // a wrong answer in a private chat is the one nobody catches.)
    const botHandle = (process.env.BOT_MENTION || "digby").toLowerCase();
    const mentionRe = new RegExp("@" + botHandle + "\\b", "i");
    if (!mentionRe.test(question)) {
      console.log("[ryver] Message did not mention the bot; ignoring.");
      return;
    }
    const cleaned = question.replace(new RegExp("@" + botHandle + "\\s*", "ig"), "").trim();
    console.log(`[ryver] Message: ${cleaned}`);

    // --- Intent detection ------------------------------------------------
    // Conflict scan: a deliberate full-document review, not an everyday
    // question. Trigger on a conflict word combined with EITHER an action
    // verb ("scan/check/find for conflicts") OR a reference to the handbook
    // as a whole ("any conflicts in the handbook?").
    const mentionsConflict = /\b(conflict|contradict|inconsisten|discrepan)/i.test(cleaned);
    const hasActionVerb = /\b(scan|check|find|review|look|audit)\b/i.test(cleaned);
    const refersToWholeDoc = /\b(handbook|document|policies|whole|entire|anywhere)\b/i.test(cleaned);
    // Avoid false-positives where "conflict" is the topic of a normal policy
    // question (e.g. "what's the conflict resolution policy?").
    const isPolicyQuestion = /\bconflict resolution\b/i.test(cleaned);
    const isConflictScan =
      mentionsConflict && !isPolicyQuestion && (hasActionVerb || refersToWholeDoc);

    if (isConflictScan) {
      // Gate behind an allowlist of Ryver user IDs (maintenance tool, not
      // for every employee). Set HANDBOOK_ADMIN_IDS in Railway to a
      // comma-separated list of Ryver numeric user IDs (Kevin, Josh, Joe).
      // NOTE: while HANDBOOK_ADMIN_IDS is empty, the scan is open to anyone
      // so it can be tested — LOCK THIS DOWN before widening access.
      const allowRaw = (process.env.HANDBOOK_ADMIN_IDS || "").trim();
      const allowlist = allowRaw ? allowRaw.split(",").map((s) => s.trim()) : [];
      const senderId = String(
        (body.user && body.user.id) ||
          (body.data && body.data.entity && body.data.entity.__author) ||
          ""
      );

      if (allowlist.length > 0 && !allowlist.includes(senderId)) {
        console.log(`[ryver] Conflict scan denied for user id ${senderId}.`);
        await postToRyver(
          "Sorry — the conflict scan is limited to handbook admins (Kevin, Josh, or Joe)."
        );
        return;
      }

      console.log(`[ryver] Running conflict scan (requested by id ${senderId}).`);
      await postToRyver("Scanning the handbook for conflicts — give me a moment...");
      const { text } = await getChunks();
      const report = await scanForConflicts(text);
      await postToRyver(report);
      return;
    }

    // --- Default: answer the question ------------------------------------
    const { chunks } = await getChunks();
    const top = retrieve(cleaned, chunks, 4);
    const answer = await answerFromHandbook(cleaned, top);

    await postToRyver(answer);
  } catch (err) {
    console.error("[ryver] Error handling message:", err);
    await postToRyver(
      "Something went wrong reaching the handbook. Ping Everette if this keeps happening."
    ).catch(() => {});
  }
});

// --- Post a reply back into Ryver --------------------------------------
// Uses an INCOMING webhook URL (created in Ryver, points at a specific
// channel/forum). Set RYVER_INBOUND_URL to that URL.
async function postToRyver(text) {
  const url = process.env.RYVER_INBOUND_URL;
  if (!url) {
    console.warn("[ryver] RYVER_INBOUND_URL not set; would have posted:\n" + text);
    return;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: text }),
  });
  if (!resp.ok) {
    console.error(`[ryver] Inbound post failed: ${resp.status} ${await resp.text()}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
