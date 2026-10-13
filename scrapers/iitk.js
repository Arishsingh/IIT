/**
 * IIT Kanpur: the institute-wide directory (www.iitk.ac.in/iitk-faculty) groups
 * faculty by department, showing 12 per group. The rest load through
 * "Load More", which POSTs to /loadmore-faculty?count=N&taxon=T and returns
 * more card HTML. Each card links to a profile page with the official email,
 * research interests and homepage (filled in by enrich.js).
 *
 * Config: { "scraper": "iitk-directory", "group": "Computer Science" }
 * where "group" is a regex matched against the group's department name
 * (the most common "Department of …" on its cards). Groups made mostly of
 * joint appointees (e.g. Intelligent Systems) are picked by their Drupal
 * taxonomy id instead: "taxons": [376, 377].
 */
const { fetchHtml, politeFetch, makeRecord, cleanText, absUrl, cheerio } = require('./utils');

const DIRECTORY = 'https://www.iitk.ac.in/iitk-faculty';
const PAGE_SIZE = 12;

let directoryMemo = null; // { at, promise } — one directory fetch serves every department

/** Returns [{ label, cards: [cheerio card html...] }] for every department group. */
async function loadGroups() {
  if (directoryMemo && Date.now() - directoryMemo.at < 5 * 60 * 1000) return directoryMemo.promise;
  const promise = (async () => {
    const $ = await fetchHtml(DIRECTORY);
    const groups = [];
    $('.iitk--grid-4').each((_, grid) => {
      const $grid = $(grid);
      const cards = $grid.children('.iitk__faculty-card');
      if (!cards.length) return;
      // The group's department = most common "Department of …" among its cards.
      const counts = {};
      cards.each((_, c) => {
        const m = /Department of ([^,+]+)/.exec($(c).find('p').text());
        if (m) counts[cleanText(m[1])] = (counts[cleanText(m[1])] || 0) + 1;
      });
      const label = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] || '';
      const btn = $grid.next('.text-center').find('.lodeMoreFaculty');
      groups.push({
        label,
        html: cards.map((_, c) => $.html(c)).get(),
        taxon: btn.data('taxon'),
        total: Number(btn.data('totalcount')) || cards.length,
      });
    });
    return groups;
  })();
  promise.catch(() => (directoryMemo = null));
  directoryMemo = { at: Date.now(), promise };
  return promise;
}

async function scrapeDirectory(iit, dept) {
  const re = dept.group ? new RegExp(dept.group, 'i') : null;
  const taxons = (dept.taxons || []).map(String);
  const groups = (await loadGroups()).filter((g) => (re && re.test(g.label)) || taxons.includes(String(g.taxon)));
  if (!groups.length) throw new Error(`no directory group matching "${dept.group || taxons.join(',')}"`);

  const records = [];
  for (const g of groups) {
    const html = [...g.html];
    // Fetch the remaining pages exactly like the "Load More" button does.
    if (g.taxon) {
      for (let page = 1; page * PAGE_SIZE < g.total; page++) {
        const more = await politeFetch(`https://www.iitk.ac.in/loadmore-faculty?count=${page}&taxon=${g.taxon}`, {
          method: 'POST',
          body: 'action=replace',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' },
        });
        html.push(more);
      }
    }
    const $ = cheerio.load(html.join('\n'));
    $('.iitk__faculty-card').each((_, c) => {
      const $c = $(c);
      const designation = cleanText($c.find('p').text());
      if (/emerit|visiting|adjunct|retired/i.test(designation)) return;
      records.push(
        makeRecord({
          name: cleanText($c.find('h4').text()),
          iit: iit.name,
          department: dept.name,
          profileUrl: absUrl($c.find('a').attr('href'), DIRECTORY),
        })
      );
    });
  }
  return records.filter((r) => r.name);
}

module.exports = { scrapers: { 'iitk-directory': scrapeDirectory } };
