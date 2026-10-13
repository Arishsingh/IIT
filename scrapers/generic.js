/**
 * Config-driven scrapers shared by many department sites.
 *
 * "cards": a listing page with one repeated element ("card") per professor.
 *   {
 *     "scraper": "cards",
 *     "url": "https://…/faculty",            // listing page (or "urls": [...] for several pages)
 *     "card": ".team-member",                 // CSS selector for one professor
 *     "nameSel": "h3",                        // optional, default: first heading in the card
 *     "research": ".bio",                     // optional, default: text after a "Research…:" label
 *     "email": ".email",                      // optional, default: mailto links / emails in card text
 *     "profile": "a.more@href",               // optional, default: the link on the name
 *     "homepage": "a.web@href",               // optional, default: auto-detected
 *     "include": "Computer Science",          // optional regex: keep only cards whose text matches
 *     "exclude": "Emeritus|Retired",          // optional regex: drop matching cards
 *     "section": "^Faculty$",                 // optional regex: keep cards under a matching heading
 *     "profiles": "missing" | "always" | false // when to open profile pages (see enrich.js)
 *     "post": "query=",                       // optional: fetch the listing with this form POST body
 *     "render": true,                         // optional: load in a real browser (see render.js)
 *     "emailSuffix": "@x.ac.in"               // optional: the "email" selector holds only a username
 *   }
 *   Selector specs may end in "@attr" to read an attribute, and may start with
 *   "closest:" to look at an ancestor of the card (e.g. "closest:a@href").
 *
 * "js-bundle": single-page apps that bake the faculty list into their JS bundle.
 *   We download the bundle, parse it with acorn, and collect object literals
 *   that contain `key`. Field values are mapped with "fields".
 */
const acorn = require('acorn');
const { renderHtml } = require('./render');
const walk = require('acorn-walk');
const {
  fetchHtml, politeFetch, makeRecord, cleanText, absUrl, extractEmails, pickEmail,
  findLabeledText, spacedText, decloakJoomla, cheerio,
} = require('./utils');

// Not useful for internship outreach: retired, emeritus, or external adjunct/visiting faculty.
const DEFAULT_EXCLUDE = /\bemerit|\bretired\b|in memoriam|\(late\)|\b(adjunct|visiting|guest|honorary)\s+((assistant|associate|chair)\s+)?(faculty|professor)/i;

/** Evaluate a selector spec ("sel", "sel@attr", "closest:sel@attr") relative to a card. */
function pick($, $card, spec) {
  if (!spec) return '';
  let [sel, attr] = spec.split('@');
  let $el;
  if (sel.startsWith('closest:')) $el = $card.closest(sel.slice(8));
  else if (sel === ':self') $el = $card;
  else $el = $card.find(sel).first();
  if (!$el.length) return '';
  if (attr === 'own') return cleanText($el.clone().children().remove().end().text());
  return attr ? ($el.attr(attr) || '').trim() : textOf($, $el);
}

/** Element text, with list items / line breaks turned into ", " separators. */
function textOf($, $el) {
  const items = $el.find('li');
  if (items.length) return items.map((_, li) => cleanText($(li).text())).get().filter(Boolean).join(', ');
  const c = $el.clone();
  c.find('br').replaceWith(', ');
  return spacedText(c).replace(/(,\s*)+$/, '');
}

const HOMEPAGE_TEXT = /home\s*page|web\s*(site|page)|personal|lab\s*page|group\s*page|^\s*profile\s*$|^\s*website\s*$/i;
const NOT_HOMEPAGE = /scholar\.google|linkedin\.|mailto:|tel:|orcid\.org|researchgate|dblp|scopus|vidwan|irins|facebook|twitter|x\.com|youtube|\.(jpg|png|pdf)$/i;

/** Best guess at a personal homepage among a card's or profile page's links. */
function findHomepage($, $root, base, excludeUrls = []) {
  let best = '';
  $root.find('a[href]').each((_, a) => {
    if (best) return false;
    const href = absUrl($(a).attr('href'), base);
    if (!href || NOT_HOMEPAGE.test(href) || excludeUrls.includes(href)) return;
    const text = cleanText($(a).text()) + ' ' + ($(a).attr('title') || '');
    if (HOMEPAGE_TEXT.test(text) || /\/~[\w.-]+/.test(href) || /sites\.google\.com|github\.io/.test(href)) best = href;
  });
  return best;
}

/** Google Scholar *profile* link (not a search for one paper). */
function findScholar($, $root, base) {
  const a = $root.find('a[href*="scholar.google"][href*="user="]').first();
  return a.length ? absUrl(a.attr('href'), base) : '';
}

/** Email from a card: explicit selector, then mailto links, then any (obfuscated) text. */
function findEmail($, $card, spec, name, domain) {
  const cands = [];
  if (spec) cands.push(...extractEmails(pick($, $card, spec)));
  $card.find('a[href^="mailto:" i]').each((_, a) => cands.push(...extractEmails(decodeURIComponent($(a).attr('href') || ''))));
  cands.push(...extractEmails(spacedText($card)));
  return pickEmail(cands, name, domain);
}

// Several departments can share one listing page (e.g. a central faculty
// directory filtered by department), so listing pages are memoized briefly.
const pageMemo = new Map();
function fetchListing(url, post, render, waitFor) {
  const key = url + (post != null ? ' POST ' + post : '') + (render ? ' RENDER' : '');
  const hit = pageMemo.get(key);
  if (hit && Date.now() - hit.at < 5 * 60 * 1000) return hit.promise;
  // Some listings are loaded by the page with a form POST (e.g. "fetch.php").
  const opts = post != null
    ? { method: 'POST', body: post, headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'X-Requested-With': 'XMLHttpRequest' } }
    : undefined;
  const promise = render
    ? renderHtml(url, { waitFor }).then((html) => cheerio.load(decloakJoomla(html)))
    : fetchHtml(url, opts);
  promise.catch(() => pageMemo.delete(key));
  pageMemo.set(key, { at: Date.now(), promise });
  return promise;
}

/** "category-x tag-machine-learning tag-computer-vision" -> "Machine learning, Computer vision" */
function researchFromTags($card, prefix) {
  return ($card.attr('class') || '')
    .split(/\s+/)
    .filter((c) => c.startsWith(prefix))
    .map((c) => c.slice(prefix.length).replace(/[-_]+/g, ' ').replace(/\//g, ' / ').trim())
    .map((t) => t.charAt(0).toUpperCase() + t.slice(1))
    .join(', ');
}

/**
 * Text of the nearest heading before an element (looking at preceding siblings
 * of the element and of each ancestor). Used to tell "Faculty" sections apart
 * from "Adjunct" / "Former Faculty" sections on the same page.
 */
function sectionHeading($, el, cardSel) {
  const H = 'h1,h2,h3,h4,h5';
  // Headings inside cards are professor names, not section titles.
  const outsideCards = (h) => !$(h).closest(cardSel).length;
  for (let node = $(el); node.length && node[0].name !== 'body'; node = node.parent()) {
    for (let sib = node.prev(); sib.length; sib = sib.prev()) {
      if (sib.is(cardSel)) continue;
      if (sib.is(H)) return cleanText(sib.text());
      const inner = sib.find(H).filter((_, h) => outsideCards(h)).last();
      if (inner.length) return cleanText(inner.text());
    }
  }
  return '';
}

/** Sites that show only a username next to an "Email" heading: "padman" -> "padman@iitmandi.ac.in". */
function emailFromUsername(text, suffix) {
  const t = cleanText(text).toLowerCase();
  if (!t) return '';
  if (t.includes('@') || /\[at\]|\(at\)/.test(t)) return extractEmails(t)[0] || '';
  return /^[a-z0-9._-]+$/.test(t) ? t + suffix : '';
}

async function scrapeCards(iit, dept) {
  const urls = dept.urls || [dept.url];
  const include = dept.include ? new RegExp(dept.include, 'i') : null;
  const exclude = dept.exclude ? new RegExp(dept.exclude, 'i') : DEFAULT_EXCLUDE;
  const section = dept.section ? new RegExp(dept.section, 'i') : null;
  const domain = dept.emailDomain || iit.emailDomain;
  const records = [];

  for (const url of urls) {
    const $ = await fetchListing(url, dept.post, dept.render, dept.card);
    $(dept.card).each((_, el) => {
      const $card = $(el);
      const text = spacedText($card);
      if (include && !include.test(text)) return;
      if (exclude.test(text)) return;
      if (section && !section.test(sectionHeading($, el, dept.card))) return;

      let name = pick($, $card, dept.nameSel || 'h1,h2,h3,h4,h5,.name,[class*="name"]');
      name ||= $card.find('img[alt]').attr('alt') || '';
      name = cleanText(name.split(/\n|\||,\s*(?:Professor|Assistant|Associate)/)[0]);
      if (!name || name.length > 80) return;

      const profileHref = dept.profile
        ? pick($, $card, dept.profile)
        : $card.find('a[href]').filter((_, a) => cleanText($(a).text()).includes(name.split(' ')[0])).first().attr('href') ||
          $card.find('h1 a,h2 a,h3 a,h4 a,h5 a').first().attr('href');
      const profileUrl = absUrl(profileHref, url);

      // "research": false = the listing has none; profile pages fill it in (enrich.js).
      const research = dept.research === false
        ? ''
        : dept.researchTags
        ? researchFromTags($card, dept.researchTags)
        : dept.research
          ? pick($, $card, dept.research)
          : findLabeledText($, $card);
      const homepage = dept.homepage ? absUrl(pick($, $card, dept.homepage), url) : findHomepage($, $card, url, [profileUrl]);

      records.push(
        makeRecord({
          name,
          iit: iit.name,
          department: dept.name,
          researchAreas: research,
          email: dept.emailSuffix
            ? emailFromUsername(pick($, $card, dept.email), dept.emailSuffix)
            : findEmail($, $card, dept.email, name, domain),
          homepage,
          scholar: findScholar($, $card, url),
          profileUrl: profileUrl && profileUrl !== url ? profileUrl : '',
        })
      );
    });
  }
  return records;
}

// ---------------------------------------------------------------------------
// js-bundle
// ---------------------------------------------------------------------------

/** Convert a literal AST node into a plain JS value (strings, numbers, arrays, nested objects). */
function literalValue(node) {
  if (!node) return undefined;
  switch (node.type) {
    case 'Literal':
      return node.value;
    case 'TemplateLiteral':
      return node.quasis.map((q) => q.value.cooked).join('');
    case 'ArrayExpression':
      return node.elements.map(literalValue);
    case 'ObjectExpression': {
      const o = {};
      for (const p of node.properties) if (p.key) o[p.key.name ?? p.key.value] = literalValue(p.value);
      return o;
    }
    case 'UnaryExpression': // !0 / !1 used by minifiers for booleans
      return node.operator === '!' ? !literalValue(node.argument) : undefined;
    default:
      return undefined;
  }
}

/**
 * Download a page's main JS bundle and return every object literal containing `key`.
 * With `arrayMatch` (a regex), only objects from the single array whose text best
 * matches it are returned. Used when a bundle holds one unlabeled array per
 * department, e.g. CSE vs EE told apart by their research vocabulary.
 */
async function objectsFromBundle(pageUrl, scriptPattern, key, arrayMatch, arrayMin = 3) {
  const html = await politeFetch(pageUrl);
  const $ = cheerio.load(html);
  const re = new RegExp(scriptPattern);
  const srcs = $('script[src]').map((_, s) => $(s).attr('src')).get().filter((s) => re.test(s));
  if (!srcs.length) throw new Error(`could not find the site's JS bundle (${scriptPattern})`);
  const objects = [];
  for (const src of srcs) {
    const js = await politeFetch(absUrl(src, pageUrl), { timeout: 180000 });
    const ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' });
    const hasKey = (node) =>
      node?.type === 'ObjectExpression' && node.properties.some((p) => p.key && (p.key.name ?? p.key.value) === key);
    if (!arrayMatch) {
      walk.simple(ast, { ObjectExpression: (node) => hasKey(node) && objects.push(literalValue(node)) });
      continue;
    }
    const re = new RegExp(arrayMatch, 'gi');
    let best = null;
    let bestScore = 0;
    walk.simple(ast, {
      ArrayExpression(node) {
        const items = node.elements.filter(hasKey).map(literalValue);
        if (items.length < arrayMin) return;
        const text = JSON.stringify(items);
        const score = (text.match(re) || []).length / items.length;
        if (score > bestScore) [best, bestScore] = [items, score];
      },
    });
    if (best) objects.push(...best);
  }
  return objects;
}

/** "a|b" -> first non-empty of obj.a, obj.b. HTML is converted to text. */
function field(obj, spec) {
  if (!spec) return '';
  for (const k of spec.split('|')) {
    let v = obj[k];
    if (Array.isArray(v)) v = v.join(', ');
    if (v == null || v === '') continue;
    v = String(v);
    if (/<[a-z][\s\S]*>/i.test(v)) v = cheerio.load(v.replace(/<\/(p|li|div)>/gi, '$&, ')).text();
    v = cleanText(v).replace(/^(,\s*)+|(,\s*)+$/g, '').replace(/(,\s*){2,}/g, ', ');
    if (v) return v;
  }
  return '';
}

/** First link inside an HTML/text field: <a href="…">, or the text itself if it looks like a URL. */
function linkFrom(obj, spec) {
  for (const k of (spec || '').split('|').filter(Boolean)) {
    const raw = obj[k];
    if (!raw || typeof raw !== 'string') continue;
    const href = /href\s*=\s*["']([^"']+)["']/i.exec(raw)?.[1];
    if (href) return href.trim();
    const url = /(https?:\/\/[^\s<>"']+|www\.[^\s<>"']+)/i.exec(raw)?.[1];
    if (url) return url.startsWith('www.') ? 'https://' + url : url;
  }
  return '';
}

/** Free-text research fields: keep what follows a "Research interests:" label, and keep it short. */
function tidyResearch(text) {
  let t = text || '';
  const m = /research\s+(interests?|areas?)\s*[:\-–,]?\s*/i.exec(t);
  if (m) t = t.slice(m.index + m[0].length);
  if (t.length > 300) {
    const cut = t.slice(0, 300);
    t = cut.slice(0, Math.max(cut.lastIndexOf('. '), cut.lastIndexOf(', '), 150)).trim();
  }
  return t.replace(/^[,\s]+|[,\s]+$/g, '');
}

/** When only "academic/teaching interests" exist: use any research part, else label it as teaching. */
function teachingFallback(text) {
  if (!text) return '';
  if (/research\s+(interests?|areas?)/i.test(text)) return tidyResearch(text);
  return 'Teaching: ' + tidyResearch(text.replace(/^teaching\s+interests?\s*:?\s*/i, ''));
}

/** Map plain objects (from a JS bundle or JSON API) to records using dept.fields / dept.match. */
function recordsFromObjects(iit, dept, objs) {
  const f = dept.fields;
  const out = [];
  const seen = new Set();
  for (const o of objs) {
    // "match": { "department": "Computer Science", "lang": "^EN$" } — all must match.
    if (dept.match && !Object.entries(dept.match).every(([k, re]) => new RegExp(re, 'i').test(field(o, k)))) continue;
    if (DEFAULT_EXCLUDE.test(field(o, f.designation))) continue;
    const name = field(o, f.name);
    if (!name || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const profile = field(o, f.profile);
    out.push(
      makeRecord({
        name,
        iit: iit.name,
        department: dept.name,
        researchAreas:
          tidyResearch(field(o, f.research)) ||
          teachingFallback(field(o, f.teaching)),
        email: field(o, f.email),
        homepage: absUrl(linkFrom(o, f.homepage), dept.url),
        scholar: absUrl(linkFrom(o, f.scholar), dept.url),
        profileUrl: profile ? absUrl((dept.profileBase || '') + profile, dept.url) : '',
      })
    );
  }
  return out;
}

async function scrapeJsBundle(iit, dept) {
  return recordsFromObjects(iit, dept, await objectsFromBundle(dept.url, dept.script, dept.key, dept.arrayMatch, dept.arrayMin));
}

/**
 * "json-api": { "api": "https://…/faculty.json", "dataPath": "data", "fields": {…}, "match": {…} }
 */
async function scrapeJsonApi(iit, dept) {
  // Departments that share one API (filtered by "match") reuse a single download.
  let hit = pageMemo.get(dept.api);
  if (!hit || Date.now() - hit.at > 5 * 60 * 1000) {
    hit = { at: Date.now(), promise: politeFetch(dept.api, { json: true, timeout: 90000 }) };
    hit.promise.catch(() => pageMemo.delete(dept.api));
    pageMemo.set(dept.api, hit);
  }
  let data = await hit.promise;
  for (const k of (dept.dataPath || '').split('.').filter(Boolean)) data = data?.[k];
  if (!Array.isArray(data)) throw new Error('unexpected API response shape');
  return recordsFromObjects(iit, dept, data);
}

/**
 * "next-data": Next.js pages ship their data inside the HTML, either as
 * <script id="__NEXT_DATA__"> JSON or as App-Router "flight" chunks
 * (self.__next_f.push([1, "…"])). We decode that payload and pull out every
 * JSON object that has `key`, then map fields as for json-api.
 */
function jsonObjectsWithKey(text, key) {
  const out = [];
  const needle = JSON.stringify(key) + ':';
  let from = 0;
  for (let i = text.indexOf(needle, from); i !== -1; i = text.indexOf(needle, from)) {
    // Walk back to the "{" that opens this object, then forward to its matching "}".
    const start = text.lastIndexOf('{', i);
    let depth = 0;
    let inStr = false;
    let end = -1;
    for (let j = start; j < text.length; j++) {
      const c = text[j];
      if (inStr) {
        if (c === '\\') j++;
        else if (c === '"') inStr = false;
      } else if (c === '"') inStr = true;
      else if (c === '{') depth++;
      else if (c === '}' && --depth === 0) {
        end = j;
        break;
      }
    }
    from = i + needle.length;
    if (end === -1) continue;
    try {
      out.push(JSON.parse(text.slice(start, end + 1)));
      from = end;
    } catch {
      // Not a complete object at this level; keep scanning.
    }
  }
  return out;
}

/** Parse the JSON value (object or array) that follows the first `"key":` in text. */
function jsonValueAfterKey(text, key) {
  const needle = JSON.stringify(key) + ':';
  const at = text.indexOf(needle);
  if (at === -1) return undefined;
  const start = at + needle.length;
  const open = text[start];
  if (open !== '{' && open !== '[') return undefined;
  let depth = 0;
  let inStr = false;
  for (let j = start; j < text.length; j++) {
    const c = text[j];
    if (inStr) {
      if (c === '\\') j++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{' || c === '[') depth++;
    else if ((c === '}' || c === ']') && --depth === 0) {
      try {
        return JSON.parse(text.slice(start, j + 1));
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

async function scrapeNextData(iit, dept) {
  const html = await politeFetch(dept.url, { timeout: 90000 });
  const $ = cheerio.load(html);
  let payload = $('#__NEXT_DATA__').html() || '';
  $('script').each((_, el) => {
    const js = $(el).html() || '';
    for (const m of js.matchAll(/self\.__next_f\.push\(\[1,\s*("(?:[^"\\]|\\.)*")\]\)/g)) {
      try {
        payload += JSON.parse(m[1]);
      } catch {}
    }
  });
  let objs;
  if (dept.dataPath) {
    // e.g. "facultyData.computer-science-engineering.en": find the object holding the
    // first key, then walk the rest of the path to the department's array.
    const [first, ...rest] = dept.dataPath.split('.');
    let node = jsonValueAfterKey(payload, first);
    for (const k of rest) node = node?.[k];
    objs = Array.isArray(node) ? node : [];
  } else {
    objs = jsonObjectsWithKey(payload, dept.key);
  }
  if (!objs.length) throw new Error('no embedded faculty data found (site may have changed)');
  return recordsFromObjects(iit, dept, objs);
}

module.exports = {
  scrapers: { cards: scrapeCards, 'js-bundle': scrapeJsBundle, 'json-api': scrapeJsonApi, 'next-data': scrapeNextData },
  findHomepage,
  findScholar,
  pick,
  objectsFromBundle,
};
