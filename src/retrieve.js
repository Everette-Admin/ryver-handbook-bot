// Lightweight keyword-overlap retrieval. No embeddings, no vector DB —
// for a single handbook this is plenty and keeps the test build simple.
// If this grows into the multi-drive bot, swap this file for an embedding
// index; nothing else has to change.

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "to", "in", "on", "for",
  "is", "are", "was", "were", "be", "been", "am", "i", "you", "we", "they",
  "it", "this", "that", "what", "how", "do", "does", "can", "my", "our",
  "if", "when", "where", "who", "which", "with", "as", "at", "by", "from",
]);

function tokenize(s) {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

// Split into overlapping chunks by paragraph, capped at ~roughly a page.
export function chunkText(text, targetChars = 1200, overlap = 200) {
  const paras = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);

  const chunks = [];
  let current = "";

  for (const p of paras) {
    if ((current + "\n\n" + p).length > targetChars && current) {
      chunks.push(current.trim());
      // carry an overlap tail so a policy split across a boundary isn't lost
      current = current.slice(-overlap) + "\n\n" + p;
    } else {
      current = current ? current + "\n\n" + p : p;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks;
}

// Score each chunk by how many of the question's terms it contains.
export function retrieve(question, chunks, topK = 4) {
  const qTerms = new Set(tokenize(question));
  if (qTerms.size === 0) return chunks.slice(0, topK);

  const scored = chunks.map((chunk, idx) => {
    const cTerms = tokenize(chunk);
    let hits = 0;
    for (const t of cTerms) if (qTerms.has(t)) hits++;
    // normalize a little so very long chunks don't dominate purely on length
    const score = hits / Math.sqrt(cTerms.length + 1);
    return { idx, chunk, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored
    .filter((s) => s.score > 0)
    .slice(0, topK)
    .map((s) => s.chunk);
}
