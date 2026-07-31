import express from "express";
import { getHandbookText } from "./drive.js";
import { chunkText, retrieve } from "./retrieve.js";
import { answerFromHandbook } from "./answer.js";
import { scanForConflicts } from "./conflicts.js";
import { isEditProposal, parseProposal, findSection } from "./propose.js";

const app = express();
app.use(express.json());

// --- Handbook cache -----------------------------------------------------
const CACHE_TTL = Number(process.env.CACHE_TTL_MS || 30 * 60 * 1000); // 30 min
let cache = { chunks: null, text: null, name: null, fetchedAt: 0 };

// --- Duplicate-message guard --------------------------------------------
const seenMessageIds = new Set();
const SEEN_MAX = 500;
function alreadyHandled(id) {
  if (!id) return false;
  if (seenMessageIds.has(id)) return true;
  seenMessageIds.add(id);
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

// Google Docs deep link (doc-level). We keep the handbook's file id here so
// the Strategy Team message can link straight to the doc.
function handbookLink() {
  const id = process.env.HANDBOOK_FILE_ID || "";
  return id ? `https://docs.google.com/document/d/${id}/edit` : "(handbook link not configured)";
}

// --- Health check -------------------------------------------------------
app.get("/", (_req, res) => res.send("Ryver handbook bot is running."));

// --- Ryver outgoing webhook endpoint ------------------------------------
app.post("/ryver", async (req, res) => {
  // 1. Verify the request came from your Ryver webhook (shared token).
  const token = req.get("x-ryver-token") || req.query.token;
  if (process.env.RYVER_WEBHOOK_TOKEN && token !== process.env.RYVER_WEBHOOK_TOKEN) {
    console.warn("[ryver] Rejected request: bad or missing token.");
    return res.status(401).send("unauthorized");
  }

  // 2. Second layer: reject anything that isn't a well-formed Ryver
  // chat_created payload (Ryver doesn't sign outbound webhooks).
  const vb = req.body || {};
  const looksLikeRyver =
    vb.type === "chat_created" &&
    vb.data &&
    vb.data.entity &&
    typeof vb.data.entity.message === "string" &&
    vb.user &&
    vb.user.id !== undefined;
  if (!looksLikeRyver) {
    console.warn("[ryver] Rejected request: not a valid Ryver chat_created payload.");
    return res.status(400).send("bad request");
  }

  // Ack immediately so Ryver doesn't time out; we reply asynchronously.
  res.status(200).send("ok");

  try {
    const body = req.body || {};
    const question =
      (body.data && body.data.entity && body.data.entity.message) || "";

    // Drop duplicate deliveries (Ryver retries slow requests).
    const messageId =
      (body.data && body.data.entity && body.data.entity.id) || "";
    if (alreadyHandled(messageId)) {
      console.log(`[ryver] Duplicate delivery of message ${messageId}; ignoring.`);
      return;
    }

    // Ignore the bot's own posts (loop guard), matched on numeric user id.
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

    // Only respond when Digby is @-mentioned (forum-only; no private DMs).
    const botHandle = (process.env.BOT_MENTION || "digby").toLowerCase();
    const mentionRe = new RegExp("@" + botHandle + "\\b", "i");
    if (!mentionRe.test(question)) {
      console.log("[ryver] Message did not mention the bot; ignoring.");
      return;
    }
    const cleaned = question.replace(new RegExp("@" + botHandle + "\\s*", "ig"), "").trim();
    console.log(`[ryver] Message: ${cleaned}`);

    // Admin allowlist (Ryver user IDs) — used for both conflict scan and
    // edit proposals.
    const allowRaw = (process.env.HANDBOOK_ADMIN_IDS || "").trim();
    const allowlist = allowRaw ? allowRaw.split(",").map((s) => s.trim()) : [];
    const isAdmin = allowlist.length === 0 || allowlist.includes(senderId);

    // --- Intent: edit proposal ------------------------------------------
    if (isEditProposal(cleaned)) {
      // Only the four admins may propose edits.
      if (!isAdmin) {
        console.log(`[ryver] Edit proposal denied for user id ${senderId}.`);
        await postToRyver(
          "Only the admin team can propose handbook edits. Ask Kevin, Josh, Joe, or Everette to submit it."
        );
        return;
      }

      const parsed = parseProposal(cleaned);
      if (!parsed) {
        await postToRyver(
          'To propose an edit, quote the before and after text, e.g.\n`@digby update: replace "old wording" with "new wording"`'
        );
        return;
      }

      // Confirm in the originating forum.
      await postToRyver("Requested edit forwarded to the admin team.");

      // Locate the section (best-effort) and build the Strategy Team message.
      let sectionNote;
      try {
        const { text } = await getChunks();
        const loc = findSection(text, parsed.oldText);
        if (loc.found && loc.section) sectionNote = `Section: ${loc.section}`;
        else if (loc.found) sectionNote = "Section: (found in handbook, heading not identified)";
        else sectionNote = "Section: (exact text not found in handbook — please verify wording)";
      } catch (e) {
        sectionNote = "Section: (could not load handbook to locate section)";
      }

      const requester = (body.user && body.user.__descriptor) || `user ${senderId}`;
      const strategyMsg =
        `**Handbook edit requested** by ${requester}\n\n` +
        `Please replace:\n> ${parsed.oldText}\n\n` +
        `With:\n> ${parsed.newText}\n\n` +
        `${sectionNote}\n\n` +
        `Handbook: ${handbookLink()}\n\n` +
        `_Reminder: review before applying._`;

      await postToStrategy(strategyMsg);
      console.log(`[ryver] Edit proposal forwarded to Strategy Team (by ${requester}).`);
      return;
    }

    // --- Intent: conflict scan ------------------------------------------
    const mentionsConflict = /\b(conflict|contradict|inconsisten|discrepan)/i.test(cleaned);
    const hasActionVerb = /\b(scan|check|find|review|look|audit)\b/i.test(cleaned);
    const refersToWholeDoc = /\b(handbook|document|policies|whole|entire|anywhere)\b/i.test(cleaned);
    const isPolicyQuestion = /\bconflict resolution\b/i.test(cleaned);
    const isConflictScan =
      mentionsConflict && !isPolicyQuestion && (hasActionVerb || refersToWholeDoc);

    if (isConflictScan) {
      if (!isAdmin) {
        console.log(`[ryver] Conflict scan denied for user id ${senderId}.`);
        await postToRyver(
          "Sorry — the conflict scan is limited to handbook admins (Kevin, Josh, Joe, or Everette)."
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

    // --- Default: answer the question -----------------------------------
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

// --- Post a reply back into the ORIGINATING forum (Test Team) -----------
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

// --- Post to the STRATEGY TEAM forum (separate incoming webhook) --------
async function postToStrategy(text) {
  const url = process.env.RYVER_STRATEGY_INBOUND_URL;
  if (!url) {
    console.warn("[ryver] RYVER_STRATEGY_INBOUND_URL not set; would have posted to Strategy Team:\n" + text);
    return;
  }
  const resp = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ body: text }),
  });
  if (!resp.ok) {
    console.error(`[ryver] Strategy post failed: ${resp.status} ${await resp.text()}`);
  }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Listening on ${PORT}`));
