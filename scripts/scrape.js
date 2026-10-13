#!/usr/bin/env node
/**
 * Terminal runner. Prints scraped professors as JSON so data quality can be checked.
 *
 *   node scripts/scrape.js Mumbai            # every tech department at the city's IIT
 *   node scripts/scrape.js Mumbai cse        # only departments whose name/id matches "cse"
 *   node scripts/scrape.js Mumbai --summary  # counts per department instead of full JSON
 *   node scripts/scrape.js Mumbai --refresh  # ignore the cache and scrape again
 *
 * Departments marked "render": true need a real browser. Either install
 * puppeteer, or run through Electron:  npx electron scripts/scrape.js Indore
 */
const { scrapeCity } = require('../scrapers');
const { closeRenderer } = require('../scrapers/render');

// When launched with `electron scripts/scrape.js …`, rendering uses Electron's
// Chromium; hide the dock icon and quit when done.
const electron = typeof require('electron') === 'object' ? require('electron') : null;
electron?.app?.dock?.hide();
// Electron quits when its last window closes; the hidden render windows would
// otherwise end the run early. We quit explicitly when scraping is finished.
electron?.app?.on('window-all-closed', () => {});

(async () => {
  const args = process.argv.slice(2);
  const summary = args.includes('--summary');
  const refresh = args.includes('--refresh');
  const [city, deptFilter] = args.filter((a) => !a.startsWith('--'));
  if (!city) {
    console.error('Usage: node scripts/scrape.js <city> [departmentFilter] [--summary]');
    process.exit(1);
  }
  const result = await scrapeCity(city, {
    deptFilter,
    refresh,
    onProgress: (msg) => process.stderr.write(`· ${msg}\n`),
  });
  if (summary) {
    const counts = {};
    for (const p of result.professors) {
      counts[p.department] ??= { total: 0, withEmail: 0, withResearch: 0 };
      counts[p.department].total++;
      if (p.email) counts[p.department].withEmail++;
      if (p.researchAreas) counts[p.department].withResearch++;
    }
    console.log(JSON.stringify({ iit: result.iit?.name, counts, warnings: result.warnings }, null, 2));
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  await closeRenderer();
  electron ? electron.app.quit() : process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
