/**
 * IIT Bombay scrapers.
 *
 * CSE (www.cse.iitb.ac.in/people/faculty.php) is an Angular SPA: the HTML is
 * empty and the faculty list comes from a JSON API. The site builds emails as
 * `<userid>@cse.iitb.ac.in` (see "To contact a faculty member append
 * @cse.iitb.ac.in to their username" on the page), so we do the same.
 */
const { politeFetch, makeRecord } = require('./utils');

const CSE_API = 'https://www.cse.iitb.ac.in/~internal-live/api/faculty/';

// Exceptions hard-coded by the site itself (encryptEmail() in its JS bundle).
const CSE_EMAIL_OVERRIDES = { sbagchi: 'bagchis@acm.org' };

async function scrapeCse(iit, dept) {
  const list = await politeFetch(dept.api || CSE_API, { json: true });
  return list
    .filter((p) => p.retired === 'n') // skip retired / emeritus faculty
    .map((p) =>
      makeRecord({
        name: `${p.firstname} ${p.lastname}`,
        iit: iit.name,
        department: dept.name,
        researchAreas: p.interests || p.interest,
        email: CSE_EMAIL_OVERRIDES[p.userid] || `${p.userid}@cse.iitb.ac.in`,
        homepage: `https://www.cse.iitb.ac.in/~${p.userid}/`,
        scholar: p.google_scholar,
        profileUrl: `https://www.cse.iitb.ac.in/people/faculty/${p.userid}`,
      })
    );
}

module.exports = { scrapers: { 'iitb-cse': scrapeCse } };
