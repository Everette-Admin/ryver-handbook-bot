import { google } from "googleapis";
import mammoth from "mammoth";
import { createRequire } from "module";

// pdf-parse ships as CommonJS; load it this way under ESM.
const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse");

// --- Auth ---------------------------------------------------------------
// The service account JSON key is passed as a single env var (stringified
// JSON) so we never commit a key file to the repo.
function getDriveClient() {
  const raw = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (!raw) {
    throw new Error("GOOGLE_SERVICE_ACCOUNT_JSON env var is not set.");
  }
  let creds;
  try {
    creds = JSON.parse(raw);
  } catch {
    throw new Error(
      "GOOGLE_SERVICE_ACCOUNT_JSON is not valid JSON. Paste the full key file contents."
    );
  }

  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  return google.drive({ version: "v3", auth });
}

// --- Find the handbook by name -----------------------------------------
// Searches across Shared Drives. Matches the configured name (partial,
// case-insensitive on the Drive side via `contains`). Returns the first
// match, preferring .docx then .pdf.
export async function findHandbookFile() {
  const drive = getDriveClient();
  const namePart = (process.env.HANDBOOK_NAME || "handbook").replace(/'/g, "\\'");

  const res = await drive.files.list({
    q: `name contains '${namePart}' and trashed = false and (mimeType = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' or mimeType = 'application/pdf' or mimeType = 'application/vnd.google-apps.document')`,
    fields: "files(id, name, mimeType, modifiedTime)",
    // These three flags are REQUIRED to search inside Shared Drives:
    supportsAllDrives: true,
    includeItemsFromAllDrives: true,
    corpora: "allDrives",
    orderBy: "modifiedTime desc",
    pageSize: 10,
  });

  const files = res.data.files || [];
  if (files.length === 0) return null;

  // Prefer a native Word doc, then Google Doc, then PDF.
  const rank = (m) =>
    m === "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
      ? 0
      : m === "application/vnd.google-apps.document"
      ? 1
      : 2;
  files.sort((a, b) => rank(a.mimeType) - rank(b.mimeType));
  return files[0];
}

// --- Download + extract text -------------------------------------------
export async function getHandbookText() {
  const drive = getDriveClient();
  const file = await findHandbookFile();
  if (!file) {
    throw new Error(
      `No handbook found. Looked for files containing "${process.env.HANDBOOK_NAME || "handbook"}" in the shared drives the service account can see.`
    );
  }

  console.log(`[drive] Using handbook: "${file.name}" (${file.mimeType}, id=${file.id})`);

  let buffer;
  let mime = file.mimeType;

  if (mime === "application/vnd.google-apps.document") {
    // Google Docs must be exported, not downloaded directly.
    const res = await drive.files.export(
      { fileId: file.id, mimeType: "text/plain" },
      { responseType: "arraybuffer", supportsAllDrives: true }
    );
    return { name: file.name, text: Buffer.from(res.data).toString("utf-8") };
  }

  const res = await drive.files.get(
    { fileId: file.id, alt: "media", supportsAllDrives: true },
    { responseType: "arraybuffer" }
  );
  buffer = Buffer.from(res.data);

  let text;
  if (mime === "application/pdf") {
    const parsed = await pdfParse(buffer);
    text = parsed.text;
  } else {
    // .docx
    const result = await mammoth.extractRawText({ buffer });
    text = result.value;
  }

  return { name: file.name, text };
}
