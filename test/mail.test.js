const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { parseCsv, parseEmailList } = require('../mail/recipients');
const { render, fieldsFor, missingFields, unknownTags } = require('../mail/template');
const { sendCampaign, readLog } = require('../mail/sender');

test('parseCsv reads the app\'s own export (BOM, quoted commas)', () => {
  const csv =
    '﻿Name,IIT,Department,Research Areas,Email,Homepage,Google Scholar,LinkedIn Search\n' +
    'Abhay Karandikar,IIT Bombay,Electrical Engineering,"Wireless networks, 5G",karandi@ee.iitb.ac.in,,,\n' +
    'No Mail,IIT Bombay,EE,,,,,\n' +
    'Dup,IIT Bombay,EE,,KARANDI@ee.iitb.ac.in,,,\n';
  const r = parseCsv(csv);
  assert.equal(r.recipients.length, 1);
  assert.deepEqual(r.recipients[0], { email: 'karandi@ee.iitb.ac.in', name: 'Abhay Karandikar', iit: 'IIT Bombay', department: 'Electrical Engineering', research: 'Wireless networks, 5G' });
  assert.equal(r.invalid, 1);
  assert.equal(r.duplicates, 1);
});

test('parseCsv handles other headers, obfuscated emails and header-less files', () => {
  const r = parseCsv('Professor,E-mail\nA Rao,arao [at] iitm (dot) ac (dot) in\n');
  assert.equal(r.recipients[0].email, 'arao@iitm.ac.in');
  assert.equal(r.recipients[0].name, 'A Rao');
  const bare = parseCsv('x@iitd.ac.in\ny@iitk.ac.in\n');
  assert.deepEqual(bare.recipients.map((x) => x.email), ['x@iitd.ac.in', 'y@iitk.ac.in']);
});

test('parseEmailList splits pasted text and drops junk', () => {
  const r = parseEmailList('a@iitb.ac.in, b@iitd.ac.in;\n<c@iitk.ac.in> nonsense a@iitb.ac.in');
  assert.deepEqual(r.recipients.map((x) => x.email), ['a@iitb.ac.in', 'b@iitd.ac.in', 'c@iitk.ac.in']);
  assert.equal(r.invalid, 1);
  assert.equal(r.duplicates, 1);
});

test('template fills fields, fallbacks, and research summary', () => {
  const r = { name: 'Prof. Abhay Karandikar', iit: 'IIT Bombay', research: 'Wireless networks, 5G, Policy' };
  assert.equal(render('Dear Prof. {{lastName}} ({{firstName}}) at {{ iit }}', r), 'Dear Prof. Karandikar (Abhay) at IIT Bombay');
  assert.equal(render('on {{research}}', r), 'on Wireless networks and 5G');
  assert.equal(render('on {{research|your research}}', { name: 'X' }), 'on your research');
  assert.equal(render('{{unknown}} stays', r), '{{unknown}} stays');
  assert.equal(fieldsFor({ name: 'Madhu' }).lastName, 'Madhu');
});

test('surname skips trailing initials but keeps short real surnames', () => {
  const last = (name) => fieldsFor({ name }).lastName;
  assert.equal(last('Akshay S'), 'Akshay');
  assert.equal(last('Sreejith AV'), 'Sreejith');
  assert.equal(last('Chinmaya K A'), 'Chinmaya');
  assert.equal(last('Krishna Nandivada V'), 'Nandivada');
  assert.equal(last('Arun S.'), 'Arun');
  assert.equal(last('Abir De'), 'De');
  assert.equal(last('B. Kalyan Kumar'), 'Kumar');
});

test('research phrase reads naturally', () => {
  const { researchPhrase } = require('../mail/template');
  assert.equal(researchPhrase('Compilers, Program Analysis, Parallel computing'), 'Compilers and Program Analysis');
  assert.equal(researchPhrase('Power Systems and Power Electronics, High Voltage'), 'Power Systems and Power Electronics');
  assert.equal(researchPhrase('Formal verification: building model checkers for software, Modelling'), 'Formal verification and Modelling');
  assert.equal(researchPhrase('Protection of microgrid integrating renewable energy sources (solar power and wind power'), 'Protection of microgrid integrating renewable energy sources');
  assert.equal(researchPhrase(''), '');
});

test('missingFields and unknownTags warn before sending', () => {
  const people = [{ name: 'A B', research: 'ML' }, { name: 'C D', research: '' }];
  assert.deepEqual(missingFields(['{{research}} {{research|x}} {{lastName}}'], people), [{ key: 'research', count: 1 }]);
  assert.deepEqual(missingFields(['{{research|x}}'], people), []);
  assert.deepEqual(unknownTags(['{{lastname}} {{lastName}}']), ['{{lastname}}']);
});

/** Minimal SMTP server that accepts everything and keeps the messages. */
function fakeSmtp({ rejectAuth = false, rejectRcpt = '' } = {}) {
  const messages = [];
  const server = net.createServer((sock) => {
    let data = null;
    let msg = { rcpt: [] };
    sock.write('220 localhost ESMTP test\r\n');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (data !== null) {
          if (line === '.') {
            messages.push({ ...msg, raw: data.join('\r\n') });
            msg = { rcpt: [] };
            data = null;
            sock.write('250 OK queued\r\n');
          } else data.push(line.replace(/^\.\./, '.'));
          continue;
        }
        const cmd = line.slice(0, 4).toUpperCase();
        if (cmd === 'EHLO') sock.write('250-localhost\r\n250 AUTH PLAIN LOGIN\r\n');
        else if (cmd === 'HELO') sock.write('250 localhost\r\n');
        else if (cmd === 'AUTH') sock.write(rejectAuth ? '535 5.7.8 Username and Password not accepted\r\n' : '235 2.7.0 Accepted\r\n');
        else if (cmd === 'MAIL') sock.write('250 OK\r\n');
        else if (cmd === 'RCPT') {
          if (rejectRcpt && line.includes(rejectRcpt)) sock.write('550 5.1.1 No such user\r\n');
          else {
            msg.rcpt.push(line);
            sock.write('250 OK\r\n');
          }
        } else if (cmd === 'DATA') {
          data = [];
          sock.write('354 Go ahead\r\n');
        } else if (cmd === 'RSET' || cmd === 'NOOP') sock.write('250 OK\r\n');
        else if (cmd === 'QUIT') sock.end('221 Bye\r\n');
        else sock.write('502 Not implemented\r\n');
      }
    });
    sock.on('error', () => {});
  });
  return new Promise((res) => server.listen(0, '127.0.0.1', () => res({ server, messages, port: server.address().port })));
}

const settingsFor = (port) => ({ host: '127.0.0.1', port, secure: false, user: 'me@example.com', pass: 'x', fromName: 'Test Student' });

test('sendCampaign sends one personalized email each, with attachment, and logs them', async () => {
  const { server, messages, port } = await fakeSmtp({ rejectRcpt: 'bounce@' });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mailtest-'));
  const cv = path.join(dir, 'CV.pdf');
  fs.writeFileSync(cv, '%PDF-1.4 fake');
  const logFile = path.join(dir, 'sent-log.json');
  const events = [];
  try {
    const totals = await sendCampaign(
      {
        settings: settingsFor(port),
        recipients: [
          { email: 'a@iitb.ac.in', name: 'Abhay Karandikar', iit: 'IIT Bombay', research: 'Wireless networks, 5G' },
          { email: 'bounce@iitd.ac.in', name: 'Nobody Here', iit: 'IIT Delhi' },
          { email: 'c@iitk.ac.in', name: 'Chitra Rao', iit: 'IIT Kanpur', research: '' },
        ],
        subject: 'Internship – {{iit}}',
        body: 'Dear Prof. {{lastName}},\nYour work on {{research|your research}}.',
        attachments: [cv],
        delaySec: 0,
        logFile,
      },
      { onProgress: (p) => events.push(p) }
    );
    assert.deepEqual(totals, { sent: 2, failed: 1, cancelled: 0, aborted: '' });
    assert.equal(messages.length, 2);
    assert.match(messages[0].rcpt[0], /a@iitb\.ac\.in/);
    assert.equal(messages[0].rcpt.length, 1, 'one recipient per email (no CC/BCC)');
    assert.match(messages[0].raw, /Subject: =\?UTF-8\?Q\?Internship_=E2=80=93_IIT_Bombay\?=/); // "Internship – IIT Bombay"
    assert.match(messages[0].raw, /Dear Prof\. Karandikar/);
    assert.match(messages[0].raw, /Wireless networks and 5G/);
    assert.match(messages[0].raw, /filename=CV\.pdf/);
    assert.match(messages[1].raw, /Dear Prof\. Rao,[\s\S]*your research/);
    assert.ok(events.some((e) => e.status === 'failed' && e.email === 'bounce@iitd.ac.in'));
    assert.deepEqual(readLog(logFile).map((e) => e.email), ['a@iitb.ac.in', 'c@iitk.ac.in']);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('sendCampaign stops on a bad login and on Stop', async () => {
  const bad = await fakeSmtp({ rejectAuth: true });
  try {
    const t = await sendCampaign({ settings: settingsFor(bad.port), recipients: [{ email: 'a@x.in' }, { email: 'b@x.in' }], subject: 's', body: 'b', delaySec: 0 });
    assert.equal(t.sent, 0);
    assert.equal(t.cancelled, 1, 'does not keep trying after the login fails');
    assert.match(t.aborted, /Login failed|Gmail rejected/);
  } finally {
    bad.server.close();
  }

  const ok = await fakeSmtp();
  try {
    let stop = false;
    const t = await sendCampaign(
      { settings: settingsFor(ok.port), recipients: [{ email: 'a@x.in' }, { email: 'b@x.in' }, { email: 'c@x.in' }], subject: 's', body: 'b', delaySec: 5 },
      { onProgress: (p) => p.status === 'waiting' && (stop = true), isStopped: () => stop }
    );
    assert.deepEqual([t.sent, t.cancelled], [1, 2]);
  } finally {
    ok.server.close();
  }
});
