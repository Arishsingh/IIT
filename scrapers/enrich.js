/**
 * Optional enrichment from individual profile pages.
 *
 * Listing pages often lack research areas, emails, or Scholar links. When a
 * record has a profileUrl, we open it (rate-limited) and fill in blanks.
 *
 * Department config in iits.json controls this:
 *   "profiles": "missing"  (default) open a profile only if email or research is missing
 *   "profiles": "always"   also open it to pick up Scholar / homepage links
 *   "profiles": false      never open profile pages
 *   "profileResearch": ".research"  CSS selector for research text on profile pages
 *   "profileEmail": ".email"        CSS selector for the email on profile pages
 */
const { fetchHtml, extractEmails, pickEmail, findLabeledText, spacedText, cleanResearch, mapLimit, cleanLinks } = require('./utils');

const { findHomepage, findScholar } = require('./generic');

async function fillFromProfiles(profs, { onProgress = () => {}, dept = {}, iit = {}, warnings = [] } = {}) {
  const mode = dept.profiles ?? 'missing';
  if (mode === false) return profs;
  const todo = profs.filter(
    (p) => p.profileUrl && (mode === 'always' || !p.researchAreas || !p.email)
  );
  if (!todo.length) return profs;
  onProgress(`${iit.name} — ${dept.name}: reading ${todo.length} profile pages (~1/sec)`);
  const domain = dept.emailDomain || iit.emailDomain;

  let blocked = null;
  await mapLimit(todo, 3, async (p) => {
    if (blocked) return; // the site started refusing us; don't keep knocking
    try {
      const $ = await fetchHtml(p.profileUrl, { retries: 1 });
      $('script,style,noscript,header,footer,nav').remove();
      const $main = $(dept.profileRoot || 'body');

      if (!p.researchAreas) {
        const found = dept.profileResearch
          ? spacedText($main.find(dept.profileResearch).first()).slice(0, 600)
          : findLabeledText($, $main);
        if (found) p.researchAreas = cleanResearch(found);
      }
      if (!p.email) {
        const cands = [];
        if (dept.profileEmail) cands.push(...extractEmails($main.find(dept.profileEmail).text()));
        $main.find('a[href^="mailto:" i]').each((_, a) => cands.push(...extractEmails(decodeURIComponent($(a).attr('href')))));
        cands.push(...extractEmails(spacedText($main)));
        p.email = pickEmail(cands, p.name, domain);
      }
      if (!p.scholar) p.scholar = findScholar($, $main, p.profileUrl);
      if (!p.homepage) p.homepage = findHomepage($, $main, p.profileUrl, [p.profileUrl]);
      cleanLinks(p);
    } catch (err) {
      // One broken profile page is not worth a warning; the row just keeps its blanks.
      if (err.blocked) blocked = err;
    }
  });
  if (blocked) warnings.push(`${dept.name}: stopped reading profile pages because ${blocked.message}`);
  return profs;
}

module.exports = { fillFromProfiles };
