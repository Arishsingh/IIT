/**
 * Turn an imported CSV (or pasted text) into a clean recipient list.
 *
 * Works with the app's own "Export CSV" file, and with any spreadsheet that has an
 * email column. Column names are matched loosely ("Email", "E-mail", "mail id"…).
 * A file with no recognizable header is scanned cell by cell for email addresses.
 *
 * Recipient: { email, name, iit, department, research }
 */
const Papa = require('papaparse');
const { deobfuscateEmail } = require('../scrapers/utils');

// Header name patterns for each field, checked in order.
const COLUMNS = {
  email: /^(e-?mail|mail|email ?(id|address)|mail ?id)$/i,
  name: /^(name|full ?name|professor|prof(essor)? ?name|faculty( name)?)$/i,
  iit: /^(iit|institute|institution|college|university)$/i,
  department: /^(dep(artmen)?t\.?|department name|school)$/i,
  research: /^(research( areas?| interests?)?|interests?|areas?)$/i,
};

/** Normalize one cell into a valid email, or ''. */
function toEmail(cell) {
  return deobfuscateEmail(String(cell || '').trim()) || '';
}

/** Map header names to fields. Returns { email: 'Email', name: 'Name', … }. */
function detectColumns(headers) {
  const found = {};
  for (const [field, re] of Object.entries(COLUMNS)) {
    const h = headers.find((x) => re.test(String(x).trim()));
    if (h !== undefined) found[field] = h;
  }
  return found;
}

/**
 * Parse CSV text. Returns { recipients, invalid, duplicates, columns }.
 *   invalid     rows that had no usable email
 *   duplicates  rows whose email was already in the list
 */
function parseCsv(text) {
  const clean = String(text || '').replace(/^﻿/, ''); // Excel BOM
  const withHeader = Papa.parse(clean, { header: true, skipEmptyLines: 'greedy' });
  const columns = detectColumns(withHeader.meta.fields || []);

  let rows;
  if (columns.email) {
    rows = withHeader.data.map((r) => ({
      email: toEmail(r[columns.email]),
      name: columns.name ? String(r[columns.name] || '').trim() : '',
      iit: columns.iit ? String(r[columns.iit] || '').trim() : '',
      department: columns.department ? String(r[columns.department] || '').trim() : '',
      research: columns.research ? String(r[columns.research] || '').trim() : '',
    }));
  } else {
    // No email header: treat every row as data and take the first email-looking cell.
    const raw = Papa.parse(clean, { header: false, skipEmptyLines: 'greedy' }).data;
    rows = raw.map((cells) => ({ email: cells.map(toEmail).find(Boolean) || '', name: '', iit: '', department: '', research: '' }));
  }
  return { ...dedupe(rows), columns };
}

/** Parse pasted addresses separated by commas, semicolons, spaces or new lines. */
function parseEmailList(text) {
  const rows = String(text || '')
    .split(/[\s,;]+/)
    .filter(Boolean)
    .map((t) => ({ email: toEmail(t.replace(/^<|>$/g, '')), name: '', iit: '', department: '', research: '' }));
  return dedupe(rows);
}

/** Drop rows without an email and repeated emails (case-insensitive). */
function dedupe(rows) {
  const seen = new Set();
  const recipients = [];
  let invalid = 0;
  let duplicates = 0;
  for (const r of rows) {
    if (!r.email) {
      invalid++;
      continue;
    }
    const key = r.email.toLowerCase();
    if (seen.has(key)) {
      duplicates++;
      continue;
    }
    seen.add(key);
    recipients.push({ ...r, email: key });
  }
  return { recipients, invalid, duplicates };
}

module.exports = { parseCsv, parseEmailList, detectColumns, dedupe };
