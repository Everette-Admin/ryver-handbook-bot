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

    // Strip a leading @botname mention if present.
    const cleaned = question.replace(/^@\S+\s*/, "").trim();
    console.log(`[ryver] Message: ${cleaned}`);

    // --- Intent detection ------------------------------------------------
    // Conflict scan: a deliberate full-document review, not an everyday
    // question. Trigger on a conflict word combined with EITHER an action
    // verb ("scan/check/find for conflicts") OR a reference to the handbook
    // as a whole ("any conflicts in the handbook?").
    const mentionsConflict =
