// Propose-a-change: parse an admin's edit request and locate the section
// the change affects. The bot NEVER edits the handbook itself — it routes a
// well-formed request to the Strategy Team forum for a human to action.
// (Service account stays read-only on the handbook.)

// Detect whether a message is an edit proposal. Must START with "update" or
// "edit" (after the mention has been stripped) so common uses of those words
// mid-sentence don't trigger it.
export function isEditProposal(cleaned) {
  return /^(update|edit)\b/i.test(cleaned.trim());
}

// Parse the before/after text out of the request. Accepts:
//   replace "OLD" with "NEW"
//   change "OLD" to "NEW"
// Quotes can be straight or curly. Returns { old, new } or null if it can't
// find two quoted strings.
export function parseProposal(cleaned) {
  // Grab all quoted spans (straight or curly quotes).
  const quoted = [...cleaned.matchAll(/[""']([^""']+)[""']/g)].map((m) => m[1]);
  if (quoted.length >= 2) {
    return { oldText: quoted[0].trim(), newText: quoted[1].trim() };
  }
  return null;
}

// Find which section the old text lives in. Splits the handbook into lines,
// finds the line containing the old text, then walks backward to the nearest
// heading-looking line. Returns the section label or null if not found.
export function findSection(handbookText, oldText) {
  if (!handbookText || !oldText) return { found: false, section: null };

  const lines = handbookText.split(/\r?\n/);
  const needle = oldText.toLowerCase();

  let hitLine = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].toLowerCase().includes(needle)) {
      hitLine = i;
      break;
    }
  }
  if (hitLine === -1) return { found: false, section: null };

  // Walk backward to find the nearest heading. Heuristics for what a heading
  // looks like in the extracted text: a line starting with "Section",
  // a numbered heading like "6.10 ...", or a short Title-ish line.
  for (let i = hitLine; i >= 0 && i > hitLine - 60; i--) {
    const line = lines[i].trim();
    if (!line) continue;
    if (/^section\b/i.test(line) || /^\d+(\.\d+)*\s+\S/.test(line)) {
      return { found: true, section: line };
    }
    // A standalone short line in title case, not ending in a period, is
    // likely a heading.
    if (
      line.length <= 60 &&
      !line.endsWith(".") &&
      /^[A-Z]/.test(line) &&
      line.split(/\s+/).length <= 8
    ) {
      return { found: true, section: line };
    }
  }
  // Found the text but couldn't identify a heading above it.
  return { found: true, section: null };
}
