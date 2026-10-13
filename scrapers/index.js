/**
 * Scraper registry + orchestration.
 *
 * data/iits.json lists each IIT and its tech departments. Every department
 * names a `scraper` id; the matching function (exported by one of the modules
 * below) returns an array of standardized professor records.
 */
const path = require('path');
const fs = require('fs');
const { mapLimit } = require('./utils');
const enrich = require('./enrich');
const cache = require('./cache');

const SCRAPER_MODULES = [
  './generic',
  './iitb',
  './iitk',
];

const registry = {};
for (const mod of SCRAPER_MODULES) Object.assign(registry, require(mod).scrapers);

const IITS_PATH = path.join(__dirname, '..', 'data', 'iits.json');
let iitsCache;
function loadIits() {
  iitsCache ??= JSON.parse(fs.readFileSync(IITS_PATH, 'utf8')).iits;
  return iitsCache;
}

const norm = (s) => (s || '').toLowerCase().replace(/[^a-z]/g, '');

/** Map a city (or alias, or IIT name like "IIT Bombay") to an IIT entry, or null. */
function resolveCity(input) {
  const q = norm(input).replace(/^iit/, '');
  if (!q) return null;
  for (const iit of loadIits()) {
    const keys = [iit.city, iit.id, iit.name.replace(/^IIT\s*/i, ''), ...(iit.aliases || [])].map(norm);
    if (keys.includes(q)) return iit;
  }
  return null;
}

/** Suggestions for the autocomplete box: every city + alias, mapped to its IIT. */
function citySuggestions() {
  const out = [];
  for (const iit of loadIits()) {
    for (const label of [iit.city, ...(iit.aliases || [])]) out.push({ label, iit: iit.name, id: iit.id });
  }
  return out.sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Scrape all tech departments of one IIT. A failing department becomes a
 * warning; the others are still returned.
 */
async function scrapeIit(iit, { deptFilter, onProgress = () => {}, enrichProfiles = true } = {}) {
  const depts = iit.departments.filter(
    (d) => !deptFilter || norm(d.name).includes(norm(deptFilter)) || norm(d.id) === norm(deptFilter)
  );
  const warnings = [];
  if (!iit.departments.length) warnings.push(iit.notes || 'No department pages are configured for this IIT.');
  const results = await mapLimit(depts, 4, async (dept) => {
    const fn = registry[dept.scraper];
    if (!fn) {
      warnings.push(`${dept.name}: no scraper "${dept.scraper}" registered`);
      return [];
    }
    onProgress(`Fetching ${iit.name} — ${dept.name}`);
    try {
      let profs = await fn(iit, dept);
      if (!profs.length) warnings.push(`${dept.name}: page loaded but no professors were found (layout may have changed)`);
      if (enrichProfiles) profs = await enrich.fillFromProfiles(profs, { onProgress, iit, dept, warnings });
      return profs;
    } catch (err) {
      warnings.push(`${dept.name}: ${err.message}`);
      return [];
    }
  });

  // The same person can appear in several departments/centres (e.g. a CSE
  // professor who is also in the AI centre). Merge by name, keeping the record
  // that has an email as the base and filling its blanks from the others.
  const byKey = new Map();
  const all = results.flat().sort((a, b) => Boolean(b.email) - Boolean(a.email));
  for (const p of all) {
    const key = norm(p.name);
    const existing = byKey.get(key);
    if (!existing) byKey.set(key, p);
    else for (const k of Object.keys(p)) if (!existing[k] && p[k]) existing[k] = p[k];
  }
  // A "homepage" or Scholar link shared by several professors is a site-wide link
  // (navigation, department page), not a personal one. Drop those.
  for (const field of ['homepage', 'scholar']) {
    const counts = {};
    for (const p of byKey.values()) if (p[field]) counts[p[field]] = (counts[p[field]] || 0) + 1;
    for (const p of byKey.values()) if (counts[p[field]] >= 3) p[field] = '';
  }

  const professors = [...byKey.values()].sort((a, b) =>
    a.department.localeCompare(b.department) || a.name.localeCompare(b.name)
  );
  return { iit: publicIit(iit), professors, warnings, scrapedAt: new Date().toISOString() };
}

function publicIit(iit) {
  return { id: iit.id, name: iit.name, city: iit.city, website: iit.website, emailDomain: iit.emailDomain, notes: iit.notes || '' };
}

/**
 * Main entry point. Uses the cache unless `refresh` is set (or nothing is cached).
 * Partial scrapes (department filter) are never cached.
 */
async function scrapeCity(city, { refresh = false, useCache = true, ...opts } = {}) {
  const iit = resolveCity(city);
  if (!iit) return { iit: null, professors: [], warnings: [`No IIT found for "${city}"`] };
  if (useCache && !refresh && !opts.deptFilter) {
    const cached = cache.read(iit.id);
    if (cached) return cached;
  }
  const result = await scrapeIit(iit, opts);
  // A refresh should never lose data: if a site was slow or refused some profile
  // pages this time, keep the values we already had for the same professor.
  const previous = useCache ? cache.read(iit.id) : null;
  if (previous && !opts.deptFilter) {
    const old = new Map(previous.professors.map((p) => [norm(p.name), p]));
    for (const p of result.professors) {
      const before = old.get(norm(p.name));
      if (before) for (const k of Object.keys(p)) if (!p[k] && before[k]) p[k] = before[k];
    }
  }
  // Don't overwrite a good cache with an empty result from a temporary outage.
  if (useCache && !opts.deptFilter && result.professors.length) cache.write(iit.id, result);
  if (!result.professors.length && useCache) {
    const cached = cache.read(iit.id);
    if (cached) return { ...cached, warnings: [...result.warnings, 'Live scrape returned nothing; showing cached data.'] };
  }
  return { ...result, fromCache: false };
}

module.exports = { loadIits, resolveCity, citySuggestions, scrapeIit, scrapeCity, registry, publicIit, cache };
