import express from "express";
import { getHandbookText } from "./drive.js";
import { chunkText, retrieve } from "./retrieve.js";
import { answerFromHandbook } from "./answer.js";

const app = express();
app.use(express.json());

// --- Handbook cache -----------------------------------------------------
// Re-fetch from Drive at most every CACHE_TTL ms so we're not downloading
// the file on every single message, but still pick up edits within the day.
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000); // 30 min
let cache = { chunks: null, name: null, fetchedAt: 0 };

async function getChunks() {
  const now = Date.now();
  if (cache.chunks && now - cache.fetchedAt < CACHE_TTL) {
    return cache;
  }
  const { name, text } = await getHandbookText();
  const chunks = chunkText(text);
  cache = { chunks, name, fetchedAt: now };
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
    const question =
      body.message ||
      body.text ||
      (body.data && (body.data.message || body.data.text)) ||
      "";

    if (!question.trim()) {
      console.log("[ryver] No message text found in payload; skipping.");
      return;
    }

    // Strip a leading @botname mention if present.
    const cleaned = question.replace(/^@\S+\s*/, "").trim();
    console.log(`[ryver] Question: ${cleaned}`);

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
