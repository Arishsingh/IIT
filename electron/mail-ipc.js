/**
 * IPC for the "Email them" section. Everything that touches the network, files or
 * the password happens here in the main process; the UI only gets results.
 *
 *   mail:get-settings / mail:save-settings   SMTP account (password encrypted with
 *                                            the OS keychain via safeStorage, never
 *                                            sent back to the UI), draft, attachments
 *   mail:verify                              test the login
 *   mail:open-csv / mail:parse-list          import recipients
 *   mail:pick-attachments                    choose files (e.g. a CV) to attach
 *   mail:preview                             render the template for one recipient
 *   mail:send-test                           send one rendered email to yourself
 *   mail:send / mail:stop                    run or stop a campaign ('mail:progress' events)
 *   mail:sent-log                            who has already been emailed
 */
const fs = require('fs');
const path = require('path');
const { parseCsv, parseEmailList } = require('../mail/recipients');
const { render, missingFields, unknownTags, PLACEHOLDERS } = require('../mail/template');
const { PRESETS, createTransport, sendCampaign, readLog, explain } = require('../mail/sender');

const MAX_ATTACH_BYTES = 20 * 1024 * 1024; // providers reject ~25 MB after encoding

function registerMailIpc({ app, ipcMain, dialog, safeStorage, getWin }) {
  const dir = app.getPath('userData');
  const settingsFile = path.join(dir, 'mail-settings.json');
  const logFile = path.join(dir, 'sent-log.json');

  // Files the user picked in a dialog; only these may be attached.
  const allowedAttachments = new Set();
  let sessionPass = ''; // used when the OS can't encrypt (password then isn't saved)
  let running = null; // { stop: boolean }

  function loadSettings() {
    try {
      return JSON.parse(fs.readFileSync(settingsFile, 'utf8'));
    } catch {
      return { preset: 'gmail', ...PRESETS.gmail, user: '', fromName: '', delaySec: 30 };
    }
  }
  function password(s) {
    if (sessionPass) return sessionPass;
    if (s.passEnc && safeStorage.isEncryptionAvailable()) {
      try {
        return (sessionPass = safeStorage.decryptString(Buffer.from(s.passEnc, 'base64')));
      } catch {}
    }
    return '';
  }
  /** Settings as the UI sees them: no password, just whether one is stored. */
  function publicSettings() {
    const { passEnc, attachments = [], ...s } = loadSettings();
    const files = attachments.filter((p) => fs.existsSync(p)).map((p) => {
      allowedAttachments.add(p);
      return { path: p, name: path.basename(p), size: fs.statSync(p).size };
    });
    const hasPassword = Boolean(password({ passEnc }));
    // passwordSaved=false: the keychain was unavailable, so it is kept only until the app quits.
    return { ...s, attachments: files, hasPassword, passwordSaved: hasPassword && Boolean(passEnc), placeholders: PLACEHOLDERS };
  }
  function fullSettings() {
    const s = loadSettings();
    return { ...s, pass: password(s) };
  }

  ipcMain.handle('mail:get-settings', () => publicSettings());

  /**
   * Partial update: only the fields present in `input` change, so the account form,
   * the delay box and the draft can each save without touching the others.
   */
  ipcMain.handle('mail:save-settings', (_e, input = {}) => {
    const next = { ...loadSettings() };
    if ('preset' in input) {
      const preset = PRESETS[input.preset];
      next.preset = preset ? input.preset : 'custom';
      next.host = preset ? preset.host : String(input.host || '').trim();
      next.port = preset ? preset.port : Number(input.port) || 465;
      next.secure = preset ? preset.secure : Boolean(input.secure);
    }
    if ('user' in input) next.user = String(input.user || '').trim();
    if ('fromName' in input) next.fromName = String(input.fromName || '').trim();
    if ('delaySec' in input) next.delaySec = Math.max(0, Math.min(600, Number(input.delaySec) || 0));
    if ('draft' in input) next.draft = { subject: String(input.draft?.subject ?? ''), body: String(input.draft?.body ?? '') };
    // Only files the user picked (or saved earlier) can be remembered as attachments.
    if ('attachments' in input) next.attachments = (input.attachments || []).filter((p) => allowedAttachments.has(p));
    if (input.pass) {
      // Gmail shows app passwords in groups of four; spaces aren't part of it.
      const pass = String(input.pass).replace(/\s+/g, '');
      sessionPass = pass;
      try {
        next.passEnc = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(pass).toString('base64') : undefined;
      } catch {
        next.passEnc = undefined; // keychain access refused: keep it for this session only
      }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(settingsFile, JSON.stringify(next, null, 2));
    return publicSettings();
  });

  ipcMain.handle('mail:verify', async () => {
    const s = fullSettings();
    if (!s.user || !s.pass) return { ok: false, error: 'Enter your email address and app password first.' };
    const t = createTransport(s);
    try {
      await t.verify();
      return { ok: true };
    } catch (err) {
      return { ok: false, error: explain(err) };
    } finally {
      t.close();
    }
  });

  ipcMain.handle('mail:open-csv', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
      title: 'Import recipients from CSV',
      properties: ['openFile'],
      filters: [{ name: 'CSV', extensions: ['csv', 'txt'] }],
    });
    if (canceled || !filePaths[0]) return null;
    const text = fs.readFileSync(filePaths[0], 'utf8');
    return { file: path.basename(filePaths[0]), ...parseCsv(text) };
  });

  ipcMain.handle('mail:parse-list', (_e, text) => parseEmailList(text));

  ipcMain.handle('mail:pick-attachments', async () => {
    const { canceled, filePaths } = await dialog.showOpenDialog(getWin(), {
      title: 'Attach files (e.g. your CV)',
      properties: ['openFile', 'multiSelections'],
    });
    if (canceled) return [];
    return filePaths.map((p) => {
      allowedAttachments.add(p);
      return { path: p, name: path.basename(p), size: fs.statSync(p).size };
    });
  });

  ipcMain.handle('mail:preview', (_e, { subject, body, recipient, recipients = [] }) => ({
    subject: render(subject, recipient || {}),
    body: render(body, recipient || {}),
    missing: missingFields([subject, body], recipients),
    unknown: unknownTags([subject, body]),
  }));

  ipcMain.handle('mail:sent-log', () => readLog(logFile));

  /** Shared checks before any send. Returns an error string or ''. */
  function checkJob(s, job) {
    if (!s.user || !s.pass) return 'Set up your email account first.';
    if (!String(job.subject || '').trim()) return 'Write a subject.';
    if (!String(job.body || '').trim()) return 'Write the message.';
    const files = job.attachments || [];
    if (files.some((p) => !allowedAttachments.has(p) || !fs.existsSync(p))) return 'An attachment is missing. Remove it and add it again.';
    const total = files.reduce((n, p) => n + fs.statSync(p).size, 0);
    if (total > MAX_ATTACH_BYTES) return 'Attachments are larger than 20 MB; most mail servers will reject them.';
    return '';
  }

  ipcMain.handle('mail:send-test', async (_e, job) => {
    const s = fullSettings();
    const error = checkJob(s, job);
    if (error) return { ok: false, error };
    // The test is rendered for a real recipient, but delivered to you.
    const sample = job.recipient || {};
    const result = await sendCampaign({
      settings: s,
      recipients: [{ ...sample, email: s.user }],
      subject: '[Test] ' + render(job.subject, sample),
      body: render(job.body, sample),
      attachments: job.attachments,
    });
    return result.sent ? { ok: true, to: s.user } : { ok: false, error: result.aborted || 'Sending failed.' };
  });

  ipcMain.handle('mail:send', async (event, job) => {
    if (running) return { error: 'A send is already running.' };
    const s = fullSettings();
    const error = checkJob(s, job);
    if (error) return { error };
    if (!job.recipients?.length) return { error: 'No recipients selected.' };
    running = { stop: false };
    try {
      return await sendCampaign(
        { settings: s, recipients: job.recipients, subject: job.subject, body: job.body, attachments: job.attachments, delaySec: s.delaySec, logFile },
        {
          onProgress: (p) => !event.sender.isDestroyed() && event.sender.send('mail:progress', p),
          isStopped: () => running.stop,
        }
      );
    } finally {
      running = null;
    }
  });

  ipcMain.handle('mail:stop', () => {
    if (running) running.stop = true;
  });
}

module.exports = { registerMailIpc };
