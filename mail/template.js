/**
 * Mail-merge templates: one personalized email per professor.
 *
 *   Dear Prof. {{lastName}},  I read about your work on {{research|your research}} …
 *
 * {{field}} is replaced by the recipient's value. {{field|fallback}} uses the
 * fallback when the value is empty (many sites publish no research areas).
 */

const PLACEHOLDERS = [
  { key: 'lastName', label: 'Last name', example: 'Karandikar' },
  { key: 'name', label: 'Full name', example: 'Abhay Karandikar' },
  { key: 'firstName', label: 'First name', example: 'Abhay' },
  { key: 'iit', label: 'IIT', example: 'IIT Bombay' },
  { key: 'department', label: 'Department', example: 'Electrical Engineering' },
  { key: 'research', label: 'Research (first 2 areas)', example: 'wireless networks, 5G' },
];

const TAG = /\{\{\s*(\w+)\s*(?:\|([^}]*))?\}\}/g;

// Trailing initials in Indian names ("Akshay S", "Sreejith AV", "Chinmaya K A") aren't surnames.
const INITIAL = /^([A-Z]\.?){1,3}$/;

/** The surname to use in "Dear Prof. …": last word that isn't an initial. */
function surname(parts) {
  const words = [...parts];
  while (words.length > 1 && INITIAL.test(words[words.length - 1])) words.pop();
  return words[words.length - 1] || '';
}

/**
 * A short, natural phrase for "your research on …" from a long research list:
 * the first two areas ("compilers and program analysis"), or just the first when
 * that's already a mouthful. Returns '' when nothing reads well (the template's
 * fallback is used then).
 */
function researchPhrase(text) {
  const areas = String(text || '')
    .split(/[,;]|\s\|\s|\n/)
    .map((a) =>
      a
        .replace(/\s*\([^)]*$/, '') // unbalanced "(FACTS" at a cut-off
        .replace(/\s*[:–-]\s.*$/, '') // "Formal verification: building model checkers…"
        .replace(/[.\s]+$/, '')
        .trim()
    )
    .filter((a) => a.length >= 2);
  if (!areas.length) return '';
  const [a, b] = areas;
  if (b && !/ and /i.test(a) && !/ and /i.test(b) && a.length + b.length <= 70) return `${a} and ${b}`;
  return a.length <= 80 ? a : '';
}

/** The values a template can use for one recipient. */
function fieldsFor(r) {
  const name = String(r.name || '').replace(/^(prof(essor)?|dr)\.?\s+/i, '').trim();
  const parts = name.split(/\s+/).filter(Boolean);
  return {
    name,
    firstName: parts[0] || '',
    lastName: surname(parts),
    iit: r.iit || '',
    department: r.department || '',
    research: researchPhrase(r.research),
    email: r.email || '',
  };
}

/** Fill a template for one recipient. Unknown tags are left as they are. */
function render(template, recipient) {
  const f = fieldsFor(recipient);
  return String(template || '').replace(TAG, (tag, key, fallback) => {
    if (!(key in f)) return tag;
    return f[key] || (fallback !== undefined ? fallback.trim() : '');
  });
}

/**
 * Tags (without a fallback) that are empty for some recipients, e.g.
 * [{ key: 'research', count: 12 }]. Shown as a warning before sending.
 */
function missingFields(templates, recipients) {
  const keys = new Set();
  for (const t of templates) for (const m of String(t || '').matchAll(TAG)) if (m[2] === undefined) keys.add(m[1]);
  const out = [];
  for (const key of keys) {
    const count = recipients.filter((r) => key in fieldsFor(r) && !fieldsFor(r)[key]).length;
    if (count) out.push({ key, count });
  }
  return out;
}

/** Tags that aren't known placeholders (likely typos such as {{lastname}}). */
function unknownTags(templates) {
  const known = new Set([...PLACEHOLDERS.map((p) => p.key), 'email']);
  const bad = new Set();
  for (const t of templates) for (const m of String(t || '').matchAll(TAG)) if (!known.has(m[1])) bad.add(m[0]);
  return [...bad];
}

module.exports = { PLACEHOLDERS, fieldsFor, researchPhrase, render, missingFields, unknownTags };
