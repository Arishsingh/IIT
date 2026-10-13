/**
 * Sends a mail-merge campaign over SMTP (Gmail, Outlook, or any provider).
 *
 * One separate email per professor (never CC/BCC), sent one at a time with a
 * pause in between. Slow sending looks like a person writing emails rather than
 * a bulk sender, which keeps the account out of spam filters and under Gmail's
 * daily limits. Every successful send is recorded in a sent log, so re-running a
 * campaign skips professors who were already emailed.
 */
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { render } = require('./template');

/** Common providers, so the user only has to type an address and app password. */
const PRESETS = {
  gmail: { host: 'smtp.gmail.com', port: 465, secure: true },
  outlook: { host: 'smtp.office365.com', port: 587, secure: false },
};

function createTransport(s) {
  return nodemailer.createTransport({
    host: s.host,
    port: Number(s.port),
    secure: Boolean(s.secure),
    auth: s.user ? { user: s.user, pass: s.pass } : undefined,
    pool: true, // reuse one connection for the whole campaign
    maxConnections: 1,
    connectionTimeout: 20000,
    greetingTimeout: 20000,
    socketTimeout: 60000,
  });
}

/** Errors after which sending more emails is pointless (bad login, quota hit). */
function isFatal(err) {
  const msg = `${err.code || ''} ${err.responseCode || ''} ${err.message || ''}`;
  return /EAUTH|ECONNECTION|ESOCKET|ETIMEDOUT|ENOTFOUND|5\.4\.5|quota|limit exceeded|too many/i.test(msg);
}

/** Make SMTP errors readable ("535 5.7.8 Username and Password not accepted…"). */
function explain(err) {
  const m = String(err.response || err.message || err);
  if (err.code === 'EAUTH' && /gmail|5\.7\.[89]/i.test(m)) {
    return 'Gmail rejected the login. Use an App Password (Google Account → Security → App passwords), not your normal password.';
  }
  if (err.code === 'EAUTH') return `Login failed: ${m}`;
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|ECONNECTION/.test(err.code || m)) return `Couldn't reach the mail server (${err.code || m}). Check the host, port and your internet connection.`;
  if (/5\.4\.5|quota/i.test(m)) return 'The mail provider says the daily sending limit is reached. Try again tomorrow.';
  return m;
}

/** Sent log: [{ email, subject, sentAt, messageId }] stored as JSON. */
function readLog(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
}
function appendLog(file, entry) {
  const log = readLog(file);
  log.push(entry);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file + '.tmp', JSON.stringify(log, null, 2));
  fs.renameSync(file + '.tmp', file);
}

/** Build the message for one recipient. */
function buildMessage(s, r, { subject, body, attachments }) {
  return {
    from: s.fromName ? { name: s.fromName, address: s.user } : s.user,
    to: r.name ? { name: r.name, address: r.email } : r.email,
    subject: render(subject, r),
    text: render(body, r), // plain text: personal, readable, least likely to be filtered
    attachments: (attachments || []).map((p) => ({ filename: path.basename(p), path: p })),
  };
}

const sleep = (ms) => new Promise((res) => setTimeout(res, ms));

/**
 * Send to each recipient in turn.
 *   job: { settings, recipients, subject, body, attachments, delaySec, logFile }
 *   hooks.onProgress({ index, email, status: 'sending'|'sent'|'failed'|'cancelled'|'waiting', error, nextInSec })
 *   hooks.isStopped() -> true to stop after the current email
 * Returns { sent, failed, cancelled, aborted }.
 */
async function sendCampaign(job, { onProgress = () => {}, isStopped = () => false } = {}) {
  const transport = job.transport || createTransport(job.settings);
  const delayMs = Math.max(0, Number(job.delaySec) || 0) * 1000;
  const totals = { sent: 0, failed: 0, cancelled: 0, aborted: '' };
  try {
    for (let i = 0; i < job.recipients.length; i++) {
      const r = job.recipients[i];
      if (isStopped() || totals.aborted) {
        totals.cancelled++;
        onProgress({ index: i, email: r.email, status: 'cancelled' });
        continue;
      }
      onProgress({ index: i, email: r.email, status: 'sending' });
      try {
        const msg = buildMessage(job.settings, r, job);
        const info = await transport.sendMail(msg);
        totals.sent++;
        if (job.logFile) appendLog(job.logFile, { email: r.email, name: r.name || '', subject: msg.subject, sentAt: new Date().toISOString(), messageId: info.messageId });
        onProgress({ index: i, email: r.email, status: 'sent' });
      } catch (err) {
        totals.failed++;
        onProgress({ index: i, email: r.email, status: 'failed', error: explain(err) });
        if (isFatal(err)) totals.aborted = explain(err);
      }
      // Pause before the next email, with a little jitter, checking for Stop.
      if (i < job.recipients.length - 1 && delayMs && !totals.aborted) {
        const wait = delayMs * (0.8 + Math.random() * 0.4);
        const until = Date.now() + wait;
        while (Date.now() < until && !isStopped()) {
          onProgress({ index: i + 1, email: job.recipients[i + 1].email, status: 'waiting', nextInSec: Math.ceil((until - Date.now()) / 1000) });
          await sleep(Math.min(1000, until - Date.now()));
        }
      }
    }
  } finally {
    if (!job.transport) transport.close();
  }
  return totals;
}

module.exports = { PRESETS, createTransport, sendCampaign, buildMessage, readLog, appendLog, explain };
