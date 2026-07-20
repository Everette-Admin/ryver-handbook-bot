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
    // TEMP: dump the raw payload so we can see exactly where Ryver puts the text.
    console.log("[ryver] RAW PAYLOAD: " + JSON.stringify(body));
    const question =
      (body.data && body.data.entity && body.data.entity.message) ||
      body.message ||
      body.text ||
      (body.data && (body.data.message || body.data.text)) ||
      (body.data && body.data.body) ||
      body.body ||
      "";

    // Ignore messages the bot itself posted, or we'll loop forever
    // (bot answers -> that answer fires this webhook -> bot answers again).
    const senderName =
      (body.user && body.user.__descriptor) ||
      (body.data && body.data.entity && body.data.entity.__createUser) ||
      "";
    const botName = process.env.BOT_DISPLAY_NAME || "Digby";
    if (senderName && botName && senderName.toLowerCase() === botName.toLowerCase()) {
      console.log(`[ryver] Ignoring message from the bot itself (${senderName}).`);
      return;
    }

    if (!question.trim()) {
      console.log("[ryver] No message text found in payload; skipping.");
      return;
    }

    // Strip a leading @botname mention if present.
    const cleaned = question.replace(/^@\S+\s*/, "").trim();
    console.log(`[ryver] Message: ${cleaned}`);

    // --- Intent detection ------------------------------------------------
    // Conflict scan: a deliberate maintenance operation, not an everyday
    // question. Triggered by phrases like "scan for conflicts", "check the
    // handbook for conflicts", "find contradictions".
    const isConflictScan =
      /\b(conflict|contradict|inconsisten|discrepan)/i.test(cleaned) &&
      /\b(scan|check|find|review|look)/i.test(cleaned);

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
