/**
 * Sanitize free-text that users type into forms before it is stored or shown.
 *
 * What this defends against, and what it deliberately does not:
 *  - XSS: HTML tags are stripped, and every render path in the app prints these
 *    values as text (React escapes by default) — never via dangerouslySetInnerHTML.
 *  - Garbage / spoofing: control characters and zero-width / bidi characters are
 *    removed (they hide content and can spoof how text reads), and length is
 *    capped to the DB CHECK-constraint limits.
 *  - "Prompt injection": there is no reliable way to strip a phrase like
 *    "ignore previous instructions" without mangling legitimate text, so we do
 *    NOT try. The real defense is usage: these fields are shown to admins as
 *    plain text and are never concatenated into an LLM prompt. If that ever
 *    changes, the untrusted value MUST be passed as clearly delimited data.
 */

const TAB = 0x09;
const LF = 0x0a;

/** True for characters that hide, spoof, or corrupt text (kept: tab, newline). */
function isDangerousCodePoint(c: number): boolean {
  if (c === TAB || c === LF) return false;
  if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true; // C0 / C1 controls + DEL
  if (c >= 0x200b && c <= 0x200f) return true; // zero-width + LTR/RTL marks
  if (c >= 0x202a && c <= 0x202e) return true; // bidi embedding/override
  if (c >= 0x2066 && c <= 0x2069) return true; // bidi isolates
  if (c === 0x2060 || c === 0xfeff) return true; // word joiner / BOM
  return false;
}

function stripDangerous(input: string): string {
  let out = '';
  for (const ch of input) {
    const c = ch.codePointAt(0);
    if (c === undefined || !isDangerousCodePoint(c)) out += ch;
  }
  return out;
}

export function sanitizeText(input: string, maxLen = 2000): string {
  return stripDangerous(input.normalize('NFKC'))
    .replace(/<[^>]*>/g, '') // strip HTML tags
    .replace(/\r\n?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/[ \t]{2,}/g, ' ')
    .trim()
    .slice(0, maxLen);
}

/** Single-line variant (names, addresses, URLs): also collapses newlines. */
export function sanitizeLine(input: string, maxLen = 300): string {
  return sanitizeText(input, maxLen).replace(/\s*\n\s*/g, ' ');
}

/** Sanitize an optional field, mapping blank/whitespace-only to null. */
export function sanitizeOptional(
  input: string | null | undefined,
  maxLen = 2000,
): string | null {
  if (input == null) return null;
  const cleaned = sanitizeText(input, maxLen);
  return cleaned === '' ? null : cleaned;
}
