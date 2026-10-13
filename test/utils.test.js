const test = require('node:test');
const assert = require('node:assert/strict');
const { deobfuscateEmail, extractEmails, isValidEmail, parseRobots, cleanName, linkedinSearchUrl } = require('../scrapers/utils');

test('deobfuscateEmail: formats from the spec', () => {
  assert.equal(deobfuscateEmail('prof [at] cse.iitb.ac.in'), 'prof@cse.iitb.ac.in');
  assert.equal(deobfuscateEmail('prof (at) iitd (dot) ac (dot) in'), 'prof@iitd.ac.in');
  assert.equal(deobfuscateEmail('prof AT cse DOT iitm DOT ac DOT in'), 'prof@cse.iitm.ac.in');
});

test('deobfuscateEmail: other common variants', () => {
  assert.equal(deobfuscateEmail('prof{at}ee[dot]iitk[dot]ac[dot]in'), 'prof@ee.iitk.ac.in');
  assert.equal(deobfuscateEmail('prof [AT] iitj [DOT] ac [DOT] in'), 'prof@iitj.ac.in');
  assert.equal(deobfuscateEmail('prof @ iitd . ac . in'), 'prof@iitd.ac.in');
  assert.equal(deobfuscateEmail('prof[@]iith.ac.in'), 'prof@iith.ac.in');
  assert.equal(deobfuscateEmail('prof<at>iitg.ac.in'), 'prof@iitg.ac.in');
  assert.equal(deobfuscateEmail('rajivm[*AT]iitp.ac.in'), 'rajivm@iitp.ac.in');
  assert.equal(deobfuscateEmail('Aarti[at]iitism[dot]ac[dot]in'), 'aarti@iitism.ac.in');
  assert.equal(deobfuscateEmail('pbhaduri @ iitg.ac.in'), 'pbhaduri@iitg.ac.in');
  assert.equal(deobfuscateEmail('mailto:Prof@IITKGP.ac.in?subject=hi'), 'prof@iitkgp.ac.in');
  assert.equal(deobfuscateEmail('prof&#64;iitr.ac.in'), 'prof@iitr.ac.in');
  assert.equal(deobfuscateEmail('  first.last [at] iitjammu [dot] ac [dot] in. '), 'first.last@iitjammu.ac.in');
});

test('deobfuscateEmail: does not mangle names containing "at"/"dot"', () => {
  assert.equal(deobfuscateEmail('datta [at] iitb.ac.in'), 'datta@iitb.ac.in');
  assert.equal(deobfuscateEmail('dotson(at)iitm(dot)ac(dot)in'), 'dotson@iitm.ac.in');
});

test('deobfuscateEmail: rejects invalid input', () => {
  assert.equal(deobfuscateEmail(''), null);
  assert.equal(deobfuscateEmail(null), null);
  assert.equal(deobfuscateEmail('not an email'), null);
  assert.equal(deobfuscateEmail('prof [at] nowhere'), null);
  assert.equal(deobfuscateEmail('a@@b.com'), null);
});

test('extractEmails finds plain and obfuscated addresses in prose', () => {
  const text = 'Contact: alice@cse.iitd.ac.in or bob [at] ee [dot] iitd [dot] ac [dot] in. Office at Block 2.';
  assert.deepEqual(extractEmails(text).sort(), ['alice@cse.iitd.ac.in', 'bob@ee.iitd.ac.in']);
  assert.deepEqual(extractEmails('Meet me at noon. See you at the lab.'), []);
});

test('isValidEmail', () => {
  assert.ok(isValidEmail('a.b@iitm.ac.in'));
  assert.ok(!isValidEmail('a..b@iitm.ac.in'));
  assert.ok(!isValidEmail('a@iitm'));
});

test('parseRobots applies only the * group and ignores HTML responses', () => {
  const r = parseRobots('User-agent: Googlebot\nDisallow: /x\n\nUser-agent: *\nDisallow: /private\nAllow: /private/ok');
  assert.deepEqual(r, { allow: ['/private/ok'], disallow: ['/private'] });
  assert.deepEqual(parseRobots('<!doctype html><html></html>'), { allow: [], disallow: [] });
});

test('cleanName and linkedinSearchUrl', () => {
  assert.equal(cleanName('Prof. Dr. Jane  Doe'), 'Jane Doe');
  assert.equal(cleanName('Prof [Ms] Aikta Arya'), 'Aikta Arya');
  assert.equal(cleanName('Mrinmoy Bhattacharjee'), 'Mrinmoy Bhattacharjee');
  assert.equal(cleanName('INDRA NARAYAN KAR'), 'Indra Narayan Kar');
  assert.equal(
    linkedinSearchUrl('Jane Doe', 'IIT Bombay'),
    'https://www.linkedin.com/search/results/people/?keywords=Jane%20Doe%20IIT%20Bombay'
  );
});

const { pickEmail, decloakJoomla, spacedText, cheerio } = require('../scrapers/utils');

test('pickEmail skips office mailboxes and prefers the professor\'s own address', () => {
  assert.equal(pickEmail(['csoffice@cse.iitm.ac.in', 'skrishnam@cse.iitm.ac.in'], 'Krishna M Sivalingam', 'iitm.ac.in'), 'skrishnam@cse.iitm.ac.in');
  assert.equal(pickEmail(['hod@ee.iitb.ac.in', 'office@ee.iitb.ac.in', 'netadmin@iitpkd.ac.in']), '');
  assert.equal(pickEmail(['someone@gmail.com', 'rpiyush@iitk.ac.in'], 'Piyush Rai', 'iitk.ac.in'), 'rpiyush@iitk.ac.in');
});

test('decloakJoomla rebuilds addresses hidden by Joomla email cloaking', () => {
  const html = `<p><script type='text/javascript'>
 var prefix = '&#109;a' + 'i&#108;' + '&#116;o';
 var addy45202 = 'lb&#101;h&#101;r&#97;' + '&#64;';
 addy45202 = addy45202 + '&#105;&#105;tk' + '&#46;' + '&#97;c' + '&#46;' + '&#105;n';
 document.write(addy45202);
 </script></p>`;
  assert.match(decloakJoomla(html), /mailto:lbehera@iitk\.ac\.in/);
});

test('spacedText keeps adjacent elements apart (no "…ac.inRead more")', () => {
  const $ = cheerio.load('<div><span>prof@iitd.ac.in</span><a>Read more</a></div>');
  assert.equal(spacedText($('div')), 'prof@iitd.ac.in Read more');
});

const { looksLikeBlockPage } = require('../scrapers/utils');
test('looksLikeBlockPage spots CAPTCHA / validation pages', () => {
  assert.ok(looksLikeBlockPage('<title>Validation request</title><h3>User validation required to continue..</h3><img src="/captcha.gif">'));
  assert.ok(!looksLikeBlockPage('<h1>Faculty</h1><p>Research: captcha-resistant authentication schemes</p>'.repeat(400)));
});

const { makeRecord } = require('../scrapers/utils');
test('makeRecord drops placeholder links ("#", non-Scholar URLs)', () => {
  const r = makeRecord({ name: 'A B', iit: 'IIT X', department: 'CSE', homepage: '#', scholar: 'https://example.com/me' });
  assert.equal(r.homepage, '');
  assert.equal(r.scholar, '');
  const ok = makeRecord({ name: 'A B', iit: 'IIT X', department: 'CSE', homepage: 'https://x.ac.in/~ab', scholar: 'https://scholar.google.com/citations?user=abc' });
  assert.equal(ok.homepage, 'https://x.ac.in/~ab');
  assert.equal(ok.scholar, 'https://scholar.google.com/citations?user=abc');
});
