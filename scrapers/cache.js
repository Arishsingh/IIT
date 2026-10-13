/**
 * Local JSON cache: one file per IIT, so searches don't re-scrape every time.
 *
 *   <cacheDir>/<iitId>.json  ->  { scrapedAt, iit, professors, warnings }
 *
 * The Electron app points cacheDir at its userData folder; the CLI uses ./cache.
 * Entries older than MAX_AGE are still returned (marked stale) so the UI can show
 * them instantly while the user decides whether to hit "Refresh".
 */
const fs = require('fs');
const path = require('path');
const { cleanLinks } = require('./utils');

const MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // a week; faculty lists change slowly

let cacheDir = path.join(__dirname, '..', 'cache');
// Optional read-only fallback (the app uses the project's ./cache, filled by the
// CLI, so a first search can show results instantly; Refresh re-scrapes).
let seedDir = null;

function setCacheDir(dir, { seed } = {}) {
  cacheDir = dir;
  seedDir = seed || null;
}

function fileFor(iitId, dir = cacheDir) {
  return path.join(dir, `${iitId.replace(/[^a-z0-9_-]/gi, '')}.json`);
}

/** Returns the cached result with { stale, ageMs } added, or null. */
function read(iitId) {
  try {
    let file = fileFor(iitId);
    if (!fs.existsSync(file) && seedDir) file = fileFor(iitId, seedDir);
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    data.professors = (data.professors || []).map(cleanLinks);
    const ageMs = Date.now() - new Date(data.scrapedAt).getTime();
    return { ...data, fromCache: true, ageMs, stale: ageMs > MAX_AGE_MS };
  } catch {
    return null;
  }
}

function write(iitId, result) {
  fs.mkdirSync(cacheDir, { recursive: true });
  // Write to a temp file then rename, so a crash never leaves a half-written cache.
  const tmp = fileFor(iitId) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(result, null, 2));
  fs.renameSync(tmp, fileFor(iitId));
}

function clear(iitId) {
  try {
    fs.unlinkSync(fileFor(iitId));
  } catch {}
}

module.exports = { read, write, clear, setCacheDir, MAX_AGE_MS };
