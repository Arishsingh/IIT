/**
 * Shared scraping helpers:
 *  - politeFetch(): per-host rate limiting (1 req/sec), robots.txt checks, retries, a clear User-Agent
 *  - deobfuscateEmail() / extractEmails(): turn "prof [at] cse (dot) iitb ..." into real addresses
 *  - makeRecord(): build the standard professor record every scraper returns
 */
const cheerio = require('cheerio');
const tls = require('tls');
const { X509Certificate } = require('crypto');
const { fetch, Agent } = require('undici');

// Identifies the tool honestly; "Mozilla/5.0 (compatible; …)" is the standard bot format
// and avoids firewalls that reject unusual User-Agent strings outright.
const USER_AGENT = 'Mozilla/5.0 (compatible; IITProfessorFinder/1.0; student research-internship tool)';

const MIN_INTERVAL_MS = 1000; // at most 1 request per second per host
const TIMEOUT_MS = 30000;

// ---------------------------------------------------------------------------
// Rate limiting: one promise chain per host so requests to the same site are
// spaced out, while different sites can be fetched in parallel.
// ---------------------------------------------------------------------------
const hostQueues = new Map(); // host -> Promise of the last scheduled slot

function waitForSlot(host) {
  const prev = hostQueues.get(host) || Promise.resolve(0);
  const next = prev.then(async (lastTime) => {
    const wait = lastTime + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    return Date.now();
  });
  hostQueues.set(host, next);
  return next;
}

// ---------------------------------------------------------------------------
// robots.txt: fetched once per host and cached. Only the rules for "*" (or our
// own agent name) are applied. Missing/invalid robots.txt means "allowed".
// ---------------------------------------------------------------------------
const robotsCache = new Map(); // origin -> Promise<{ disallow: string[], allow: string[] }>

function parseRobots(text) {
  const rules = { allow: [], disallow: [] };
  // Many SPAs answer /robots.txt with their index.html; treat that as no rules.
  if (/<html/i.test(text)) return rules;
  let applies = false;
  let sawRuleSinceAgent = false;
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*/, '').trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === 'user-agent') {
      // Consecutive User-agent lines form one group.
      if (sawRuleSinceAgent) applies = false;
      sawRuleSinceAgent = false;
      if (value === '*' || /iitprofessorfinder/i.test(value)) applies = true;
    } else if (key === 'allow' || key === 'disallow') {
      sawRuleSinceAgent = true;
      if (applies && value) rules[key].push(value);
    }
  }
  return rules;
}

function robotsPatternMatches(pattern, path) {
  // Supports the common "*" wildcard and "$" end anchor.
  const re = new RegExp(
    '^' + pattern.replace(/[.+?^${}()|[\]\\]/g, (c) => (c === '$' ? '$' : '\\' + c)).replace(/\*/g, '.*')
  );
  return re.test(path);
}

async function isAllowedByRobots(url) {
  const u = new URL(url);
  if (!robotsCache.has(u.origin)) {
    robotsCache.set(
      u.origin,
      (async () => {
        for (let attempt = 0; attempt < 2; attempt++) {
          try {
            await waitForSlot(u.host);
            const res = await fetch(u.origin + '/robots.txt', {
              headers: { 'User-Agent': USER_AGENT },
              signal: AbortSignal.timeout(10000),
              dispatcher,
            });
            if (!res.ok) return { allow: [], disallow: [] };
            return parseRobots(await res.text());
          } catch (err) {
            const fixed = CHAIN_ERRORS.has(err.cause?.code) && (await learnIntermediate(u.host).catch(() => false));
            if (!fixed) break;
          }
        }
        return { allow: [], disallow: [] }; // unreachable robots.txt = no restrictions
      })()
    );
  }
  const rules = await robotsCache.get(u.origin);
  const path = u.pathname + u.search;
  // Longest matching rule wins (Google's interpretation).
  let verdict = true;
  let best = -1;
  for (const p of rules.disallow) if (robotsPatternMatches(p, path) && p.length > best) { best = p.length; verdict = false; }
  for (const p of rules.allow) if (robotsPatternMatches(p, path) && p.length >= best) { best = p.length; verdict = true; }
  return verdict;
}

// ---------------------------------------------------------------------------
// Incomplete certificate chains. Some institute servers forget to send their
// intermediate certificate. Browsers quietly download it (AIA fetching); Node
// doesn't, so the request fails with UNABLE_TO_VERIFY_LEAF_SIGNATURE. We do
// what browsers do: download the issuer named in the server's certificate,
// check that it really signed it, and add it to the CA list. Verification
// still requires a chain to a trusted root, so security is unchanged.
// ---------------------------------------------------------------------------
const extraCAs = [];
let dispatcher = new Agent({ connect: { timeout: 15000 } });
const learnedHosts = new Set();

function peerCertificate(host) {
  return new Promise((resolve, reject) => {
    // rejectUnauthorized:false only to *read* the certificate; no data is exchanged.
    const sock = tls.connect({ host, port: 443, servername: host, rejectUnauthorized: false }, () => {
      const cert = sock.getPeerX509Certificate();
      sock.end();
      resolve(cert);
    });
    sock.setTimeout(10000, () => sock.destroy(new Error('TLS timeout')));
    sock.on('error', reject);
  });
}

async function learnIntermediate(host) {
  if (learnedHosts.has(host)) return false;
  learnedHosts.add(host);
  const leaf = await peerCertificate(host);
  const m = /CA Issuers - URI:(\S+)/.exec(leaf.infoAccess || '');
  if (!m) return false;
  const der = Buffer.from(await (await fetch(m[1], { signal: AbortSignal.timeout(10000) })).arrayBuffer());
  const issuer = new X509Certificate(der);
  if (!leaf.checkIssued(issuer) || !leaf.verify(issuer.publicKey)) return false;
  extraCAs.push(issuer.toString());
  dispatcher = new Agent({ connect: { timeout: 15000, ca: [...tls.rootCertificates, ...extraCAs] } });
  return true;
}

const CHAIN_ERRORS = new Set(['UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY']);

/**
 * Fetch a URL politely. Returns the response body as text (or parsed JSON when
 * { json: true }). Throws on robots.txt disallow, HTTP errors, or timeouts.
 */
async function politeFetch(url, { json = false, retries = 2, headers = {}, method = 'GET', body, timeout = TIMEOUT_MS } = {}) {
  if (!(await isAllowedByRobots(url))) {
    throw new Error(`Blocked by robots.txt: ${url}`);
  }
  const host = new URL(url).host;
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt++) {
    await waitForSlot(host);
    try {
      const res = await fetch(url, {
        method,
        body,
        redirect: 'follow',
        headers: { 'User-Agent': USER_AGENT, Accept: json ? 'application/json' : 'text/html,*/*', ...headers },
        signal: AbortSignal.timeout(timeout),
        dispatcher,
      });
      if (!res.ok) {
        // 4xx (other than 429) won't fix themselves; don't retry.
        const err = new Error(`HTTP ${res.status} for ${url}`);
        if (res.status < 500 && res.status !== 429) throw Object.assign(err, { fatal: true });
        throw err;
      }
      if (json) return await res.json();
      const text = await res.text();
      if (looksLikeBlockPage(text)) {
        // The site is challenging us (CAPTCHA / "verify you are human"). Retrying would
        // only make it worse, so stop and report it.
        throw Object.assign(new Error(`${host} is asking for a CAPTCHA (too many requests); try again later`), {
          fatal: true,
          blocked: true,
        });
      }
      return text;
    } catch (err) {
      lastErr = err;
      if (err.fatal) break;
      if (CHAIN_ERRORS.has(err.cause?.code) && (await learnIntermediate(host).catch(() => false))) {
        attempt--; // retry immediately with the completed chain; doesn't count as a failure
        continue;
      }
      await new Promise((r) => setTimeout(r, 1500 * (attempt + 1)));
    }
  }
  throw lastErr;
}

/**
 * Joomla's "email cloaking" writes addresses with document.write() from string
 * fragments: var addy123 = 'pr&#111;f' + '&#64;'; addy123 = addy123 + 'iitk' + '&#46;' ...
 * Rebuild those addresses and put a plain mailto link where the script was.
 */
function decloakJoomla(html) {
  return html.replace(/<script[^>]*>((?:(?!<\/script>)[\s\S])*?var addy\w*\s*=[\s\S]*?)<\/script>/gi, (whole, js) => {
    const parts = [];
    // One statement per line (splitting on ";" would cut entities like "&#64;").
    for (const line of js.split(/\n/)) {
      if (!/^\s*(var\s+)?addy\w*\s*=/.test(line)) continue;
      for (const m of line.matchAll(/'((?:[^'\\]|\\.)*)'/g)) parts.push(m[1]);
    }
    const email = cheerio.load(`<p>${parts.join('')}</p>`)('p').text().trim();
    return isValidEmail(email) ? `<a href="mailto:${email}">${email}</a>` : whole;
  });
}

/** Small pages that are really a CAPTCHA / bot challenge rather than content. */
function looksLikeBlockPage(text) {
  return (
    text.length < 20000 &&
    /captcha|validation request|user validation required|verify you are (a )?human|are you a robot|attention required/i.test(text)
  );
}

/** Fetch a page and return a cheerio instance (with Joomla-cloaked emails restored). */
async function fetchHtml(url, opts) {
  return cheerio.load(decloakJoomla(await politeFetch(url, opts)));
}

// ---------------------------------------------------------------------------
// Email de-obfuscation
// ---------------------------------------------------------------------------
const EMAIL_RE = /^[a-z0-9._%+-]+@[a-z0-9-]+(\.[a-z0-9-]+)*\.[a-z]{2,}$/i;

function isValidEmail(s) {
  return typeof s === 'string' && EMAIL_RE.test(s) && !s.includes('..');
}

/**
 * Normalize an obfuscated email string to a real address, or return null.
 * Handles: "prof [at] cse.iitb.ac.in", "prof (at) iitd (dot) ac (dot) in",
 * "prof AT cse DOT iitm DOT ac DOT in", "prof{at}x[dot]in", "prof @ x . in",
 * "mailto:" prefixes, HTML entities, and stray whitespace.
 */
function deobfuscateEmail(input) {
  if (!input) return null;
  // "<at>"/"<dot>" would be parsed as HTML tags, so swap them out before decoding entities.
  let s = String(input).replace(/<\s*(at|dot)\s*>/gi, '[$1]');
  s = cheerio.load(`<p>${s}</p>`)('p').text(); // decode &#64; etc.
  s = s.replace(/^mailto:/i, '').replace(/\?.*$/, '').trim();

  // Bracketed forms: [at] (at) {at} <at> [@] , any case, optional inner spaces.
  s = s.replace(/\s*[[({<]\s*\*?\s*(?:at|@)\s*\*?\s*[\])}>]\s*/gi, '@');
  s = s.replace(/\s*[[({<]\s*\*?\s*(?:dot|\.)\s*\*?\s*[\])}>]\s*/gi, '.');
  // Bare uppercase/word forms: " AT ", " DOT " (require surrounding spaces so
  // names like "datta" or "dotson" are untouched).
  s = s.replace(/\s+at\s+/gi, '@');
  s = s.replace(/\s+dot\s+/gi, '.');
  // Spaces around real symbols: "prof @ iitd . ac . in"
  s = s.replace(/\s*@\s*/g, '@').replace(/\s*\.\s*/g, '.');
  s = s.replace(/\s+/g, '').toLowerCase();
  // Trim punctuation that often trails emails in prose.
  s = s.replace(/^[^a-z0-9]+|[^a-z0-9]+$/g, '');

  return isValidEmail(s) ? s : null;
}

/**
 * Find every email (plain or obfuscated) inside a block of text. The
 * obfuscated pattern is anchored on a domain that looks like an Indian
 * academic/known domain, to avoid false positives in ordinary prose.
 */
function extractEmails(text) {
  if (!text) return [];
  const found = new Set();
  const plain = text.match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,}/gi) || [];
  for (const p of plain) {
    const e = deobfuscateEmail(p);
    if (e) found.add(e);
  }
  const AT = String.raw`(?:\s*[[({<]\s*\*?\s*(?:at|@)\s*\*?\s*[\])}>]\s*|\s+at\s+|\s*@\s*)`;
  const DOT = String.raw`(?:\s*[[({<]\s*\*?\s*(?:dot|\.)\s*\*?\s*[\])}>]\s*|\s+dot\s+|\s*\.\s*)`;
  const obf = new RegExp(String.raw`[a-z0-9._%+-]+${AT}[a-z0-9-]+(?:${DOT}[a-z0-9-]+)*${DOT}(?:in|com|org|edu|net)\b`, 'gi');
  for (const m of text.match(obf) || []) {
    const e = deobfuscateEmail(m);
    if (e) found.add(e);
  }
  return [...found];
}

// Mailboxes that belong to an office rather than a person.
const GENERIC_MAILBOX = /^(.*office|.*admin|hod|head|admin|webmaster|web|info|dept|secretary|chair(man|person)?|registrar|dean|director|faculty|staff|support|help|contact|enquir\w*|pa2\w*|ug|pg|phd|placement|tpc|library|noreply|no-reply|it|cc|sysadmin|cseoffice|eeoffice)$/i;

/**
 * Choose the professor's own address from candidate emails: drop office
 * mailboxes, prefer one whose local part overlaps with their name, and prefer
 * the institute domain.
 */
function pickEmail(emails, name = '', domain = '') {
  const cands = [...new Set(emails.filter(Boolean).map((e) => e.toLowerCase()))].filter(
    (e) => !GENERIC_MAILBOX.test(e.split('@')[0])
  );
  if (!cands.length) return '';
  const tokens = cleanName(name).toLowerCase().split(/[^a-z]+/).filter((t) => t.length >= 3);
  const score = (e) => {
    const local = e.split('@')[0].replace(/[^a-z]/g, '');
    let s = 0;
    if (tokens.some((t) => local.includes(t) || (local.length >= 4 && t.includes(local)))) s += 2;
    if (domain && e.endsWith(domain)) s += 1;
    return s;
  };
  return cands.sort((a, b) => score(b) - score(a))[0];
}

const RESEARCH_LABEL = /^(research\s*:|research\s*(interests?|areas?|focus|keywords?|expertise)|areas?\s+of\s+(research|interest|speciali[sz]ation)|speciali[sz]ation|expertise|interests?)\s*[:\-–]?\s*$/i;

/**
 * Find text that follows a label such as "Research Interests:" inside `$root`.
 * Works for "<b>Research Areas:</b> foo", "<h4>Research Interests</h4><p>foo</p>",
 * and "<dt>Research</dt><dd>foo</dd>" style markup.
 */
function findLabeledText($, $root, label = RESEARCH_LABEL, maxLen = 600) {
  let found = '';
  $root.find('*').each((_, el) => {
    if (found) return false;
    const $el = $(el);
    const own = cleanText($el.clone().children().remove().end().text());
    const full = spacedText($el);
    const labelText = label.test(own) ? own : label.test(full) && full.length < 60 ? full : '';
    if (!labelText) return;
    // 1) Text after the label inside the parent, e.g. <p><b>Research:</b> foo</p>
    const parentText = spacedText($el.parent());
    const idx = parentText.indexOf(labelText);
    let candidate = idx >= 0 ? cleanText(parentText.slice(idx + labelText.length).replace(/^[\s:\-–]+/, '')) : '';
    // 2) Otherwise the next sibling element, e.g. <h4>Research</h4><p>foo</p>
    if (!candidate || candidate.length < 3) candidate = spacedText($el.next());
    if (candidate && candidate.length >= 3) found = candidate;
  });
  return found.slice(0, maxLen);
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------
function cleanText(s) {
  return (s || '').replace(/\s+/g, ' ').trim();
}

/**
 * Text of a cheerio selection with a space between every text node. cheerio's
 * .text() glues adjacent elements together ("prof@iitd.ac.in" + "Read more"
 * becomes "prof@iitd.ac.inRead more"), which corrupts emails.
 */
function spacedText($el) {
  const parts = [];
  const visit = (nodes) => {
    for (const n of nodes) {
      if (n.type === 'text') parts.push(n.data);
      else if (n.children && !['script', 'style', 'noscript'].includes(n.name)) visit(n.children);
    }
  };
  $el.each((_, el) => visit(el.children || []));
  return cleanText(parts.join(' '));
}

function linkedinSearchUrl(name, iit) {
  return `https://www.linkedin.com/search/results/people/?keywords=${encodeURIComponent(`${name} ${iit}`)}`;
}

/** Strip honorifics so names read well in emails and LinkedIn searches. */
function cleanName(name) {
  let n = cleanText(name)
    .replace(/[[(](mr|ms|mrs|dr)\.?[\])]/gi, ' ') // "Prof [Ms] Jane Doe"
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^((prof|dr|mr|mrs|ms|shri|smt)(\.\s*|\s+))+/i, '')
    .replace(/\s*,\s*(ph\.?\s*d|fna[es]?|fnae)\.?$/i, '')
    .trim();
  // "INDRA NARAYAN KAR" -> "Indra Narayan Kar" (leave mixed-case names alone)
  if (n === n.toUpperCase() && /[A-Z]{3}/.test(n)) n = n.toLowerCase().replace(/(^|[\s.'-])([a-z])/g, (m, p, c) => p + c.toUpperCase());
  return n;
}

function absUrl(href, base) {
  if (!href) return '';
  try {
    const u = new URL(href.trim(), base);
    return /^https?:$/.test(u.protocol) ? u.href : '';
  } catch {
    return '';
  }
}

/** Normalize research text: join lists, drop HTML and leading "Research Areas:" labels. */
function cleanResearch(value) {
  return cleanText(
    (Array.isArray(value) ? value.join(', ') : value || '')
      .replace(/<[^>]+>/g, ' ') // some sites show raw HTML as text
      .replace(/&nbsp;/g, ' ')
  )
    .replace(/^((research|teaching|academic)\s+(interests?|areas?)|interests?|areas?|speciali[sz]ation)\s*[:\-–]\s*/i, '')
    .replace(/\s*(\.\.\.|…)$/, '');
}

/** Keep only real http(s) links (sources sometimes use "#" or "N/A" as placeholders). */
function httpUrl(url) {
  const u = String(url || '').trim();
  return /^https?:\/\/[^\s/]+\.[^\s]+$/i.test(u) ? u : '';
}

/** Drop placeholder links from a record in place (also used on older cache files). */
function cleanLinks(p) {
  p.homepage = httpUrl(p.homepage);
  p.scholar = /scholar\.google\./i.test(p.scholar) ? httpUrl(p.scholar) : '';
  p.profileUrl = httpUrl(p.profileUrl);
  return p;
}

/** Build a standardized professor record. */
function makeRecord({ name, iit, department, researchAreas, email, homepage, scholar, profileUrl }) {
  const n = cleanName(name);
  const em = email ? deobfuscateEmail(email) : null;
  return {
    name: n,
    iit,
    department,
    researchAreas: cleanResearch(researchAreas),
    email: em || '',
    homepage: httpUrl(homepage),
    scholar: /scholar\.google\./i.test(scholar) ? httpUrl(scholar) : '',
    profileUrl: httpUrl(profileUrl),
    linkedinSearchUrl: linkedinSearchUrl(n, iit),
  };
}

/** Run async fn over items with limited concurrency (rate limit still applies per host). */
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

module.exports = {
  USER_AGENT,
  waitForSlot,
  politeFetch,
  fetchHtml,
  looksLikeBlockPage,
  isAllowedByRobots,
  parseRobots,
  deobfuscateEmail,
  extractEmails,
  isValidEmail,
  makeRecord,
  httpUrl,
  cleanLinks,
  cleanResearch,
  pickEmail,
  findLabeledText,
  decloakJoomla,
  RESEARCH_LABEL,
  cleanText,
  spacedText,
  cleanName,
  absUrl,
  linkedinSearchUrl,
  mapLimit,
  cheerio,
};
