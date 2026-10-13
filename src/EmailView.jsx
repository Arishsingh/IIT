import React, { useEffect, useMemo, useRef, useState } from 'react';

const mail = window.api.mail;

const DEFAULT_SUBJECT = 'Research internship inquiry';
const DEFAULT_BODY = `Dear Prof. {{lastName}},

I am [Your Name], a [year] [degree] student at [college]. I came across your work at {{iit}} and I am particularly interested in your research on {{research|your area of research}}.

[One or two lines about relevant projects or coursework.]

I would be grateful for the opportunity to work as a research intern in your group this [summer/winter]. I have attached my CV for your reference.

Thank you for your time.

Best regards,
[Your Name]
[Phone] · [LinkedIn / GitHub]`;

const STATUS_LABEL = { queued: 'Queued', sending: 'Sending…', waiting: 'Next', sent: 'Sent', failed: 'Failed', cancelled: 'Not sent' };

function formatSize(bytes) {
  return bytes > 1e6 ? `${(bytes / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}
function formatDuration(sec) {
  if (sec < 90) return `${Math.round(sec)} s`;
  if (sec < 5400) return `${Math.round(sec / 60)} min`;
  return `${(sec / 3600).toFixed(1)} h`;
}

/* ---------------------------------------------------------------- Account */

function AccountCard({ settings, onSaved }) {
  const configured = settings && settings.user && settings.hasPassword;
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(null);
  const [check, setCheck] = useState(null); // { ok, error } | 'checking'

  useEffect(() => {
    if (settings) setForm({ preset: settings.preset || 'gmail', host: settings.host, port: settings.port, secure: settings.secure, user: settings.user, fromName: settings.fromName, pass: '' });
  }, [settings]);

  if (!settings || !form) return null;
  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value }));

  async function save() {
    setCheck('checking');
    const next = await mail.saveSettings({ ...form, delaySec: settings.delaySec });
    onSaved(next);
    const res = await mail.verify();
    setCheck(res);
    if (res.ok) setEditing(false);
  }

  if (configured && !editing) {
    return (
      <section className="card">
        <div className="card-head">
          <h3>Account</h3>
          <button className="link" onClick={() => { setEditing(true); setCheck(null); }}>Change</button>
        </div>
        <p className="account-line">
          Sending as <strong>{settings.fromName || settings.user}</strong>
          {settings.fromName && <span className="muted"> &lt;{settings.user}&gt;</span>}
        </p>
        {check?.ok && <p className="small ok-text">✓ Login works</p>}
        {!settings.passwordSaved && (
          <p className="small warn-text">
            The password couldn't be saved to your keychain (access was denied), so you'll need to enter it again next time you open the app.
          </p>
        )}
      </section>
    );
  }

  return (
    <section className="card">
      <div className="card-head">
        <h3>Account</h3>
        {configured && <button className="link" onClick={() => setEditing(false)}>Cancel</button>}
      </div>
      <div className="form">
        <label>
          <span>Provider</span>
          <select className="input" value={form.preset} onChange={set('preset')}>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook / Office 365</option>
            <option value="custom">Other (SMTP)</option>
          </select>
        </label>
        {form.preset === 'custom' && (
          <div className="row">
            <label className="grow">
              <span>SMTP server</span>
              <input className="input" value={form.host} onChange={set('host')} placeholder="smtp.example.com" />
            </label>
            <label style={{ width: 90 }}>
              <span>Port</span>
              <input className="input" value={form.port} onChange={set('port')} />
            </label>
            <label className="check">
              <input type="checkbox" checked={form.secure} onChange={set('secure')} /> SSL
            </label>
          </div>
        )}
        <label>
          <span>Your name</span>
          <input className="input" value={form.fromName} onChange={set('fromName')} placeholder="Shown as the sender" />
        </label>
        <label>
          <span>Email address</span>
          <input className="input" value={form.user} onChange={set('user')} placeholder="you@gmail.com" />
        </label>
        <label>
          <span>{form.preset === 'gmail' ? 'App password' : 'Password'}</span>
          <input
            className="input"
            type="password"
            value={form.pass}
            onChange={set('pass')}
            placeholder={settings.hasPassword ? '•••••••• (saved, leave blank to keep)' : form.preset === 'gmail' ? '16-letter app password' : ''}
          />
        </label>
        {form.preset === 'gmail' && (
          <p className="small muted">
            Gmail needs an <button className="link" onClick={() => window.api.openExternal('https://myaccount.google.com/apppasswords')}>App Password</button> (turn on
            2-Step Verification first), not your normal password. It is stored encrypted in your system keychain.
          </p>
        )}
        <div className="row">
          <button className="btn primary" onClick={save} disabled={!form.user || (!form.pass && !settings.hasPassword) || check === 'checking'}>
            {check === 'checking' ? 'Checking…' : 'Save & test login'}
          </button>
          {check && check !== 'checking' && (
            <span className={`small ${check.ok ? 'ok-text' : 'error-text'}`}>{check.ok ? '✓ Login works' : check.error}</span>
          )}
        </div>
      </div>
    </section>
  );
}

/* ------------------------------------------------------------- Recipients */

function RecipientsCard({ recipients, setRecipients, selected, setSelected, sentMap, status, previewEmail, setPreviewEmail, busy }) {
  const [notice, setNotice] = useState('');
  const [pasting, setPasting] = useState(false);
  const [pasteText, setPasteText] = useState('');

  function add(result, source) {
    const known = new Set(recipients.map((r) => r.email));
    const fresh = result.recipients.filter((r) => !known.has(r.email));
    setRecipients([...recipients, ...fresh]);
    // New people are selected, except those already emailed.
    setSelected((s) => new Set([...s, ...fresh.filter((r) => !sentMap.has(r.email)).map((r) => r.email)]));
    const parts = [`Added ${fresh.length} from ${source}`];
    if (result.recipients.length - fresh.length) parts.push(`${result.recipients.length - fresh.length} already in the list`);
    if (result.duplicates) parts.push(`${result.duplicates} duplicate${result.duplicates > 1 ? 's' : ''}`);
    if (result.invalid) parts.push(`${result.invalid} row${result.invalid > 1 ? 's' : ''} without a valid email`);
    setNotice(parts.join(' · '));
  }

  async function importCsv() {
    const res = await mail.openCsv();
    if (res) add(res, res.file);
  }
  async function addPasted() {
    add(await mail.parseList(pasteText), 'pasted text');
    setPasteText('');
    setPasting(false);
  }

  const allSelected = recipients.length > 0 && recipients.every((r) => selected.has(r.email));
  const toggle = (email) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(email) ? n.delete(email) : n.add(email);
      return n;
    });
  const alreadySent = recipients.filter((r) => sentMap.has(r.email)).length;

  return (
    <section className="card recipients">
      <div className="card-head">
        <h3>
          Recipients <span className="muted">{selected.size} of {recipients.length} selected</span>
        </h3>
        {recipients.length > 0 && (
          <button className="link small" disabled={busy} onClick={() => { setRecipients([]); setSelected(new Set()); setNotice(''); }}>Clear all</button>
        )}
      </div>
      <div className="row">
        <button className="btn" onClick={importCsv} disabled={busy}>Import CSV</button>
        <button className="btn" onClick={() => setPasting((v) => !v)} disabled={busy}>Paste emails</button>
      </div>

      {pasting && (
        <div className="paste">
          <textarea className="input textarea" rows={3} value={pasteText} onChange={(e) => setPasteText(e.target.value)} placeholder="prof1@iitb.ac.in, prof2@iitd.ac.in …" autoFocus />
          <button className="btn primary" onClick={addPasted} disabled={!pasteText.trim()}>Add</button>
        </div>
      )}
      {notice && <p className="small muted">{notice}</p>}
      {alreadySent > 0 && (
        <p className="small muted">{alreadySent} already emailed before (unticked so they don't get the same email twice).</p>
      )}

      {recipients.length === 0 ? (
        <div className="drop muted">
          Import the CSV you exported from <strong>Contacts</strong> (or any sheet with an Email column), paste addresses, or use
          <strong> Email these</strong> on the Contacts page.
        </div>
      ) : (
        <div className="table-wrap recipients-table">
          <table>
            <thead>
              <tr>
                <th style={{ width: 28 }}>
                  <input type="checkbox" checked={allSelected} disabled={busy} onChange={() => setSelected(allSelected ? new Set() : new Set(recipients.map((r) => r.email)))} />
                </th>
                <th>Professor</th>
                <th>IIT</th>
                <th>Status</th>
                <th style={{ width: 24 }} />
              </tr>
            </thead>
            <tbody>
              {recipients.map((r) => {
                const st = status[r.email];
                const sentAt = sentMap.get(r.email);
                return (
                  <tr key={r.email} className={previewEmail === r.email ? 'previewing' : ''} onClick={() => setPreviewEmail(r.email)}>
                    <td onClick={(e) => e.stopPropagation()}>
                      <input type="checkbox" checked={selected.has(r.email)} disabled={busy} onChange={() => toggle(r.email)} />
                    </td>
                    <td>
                      <div className="strong">{r.name || r.email}</div>
                      {r.name && <div className="mono muted small">{r.email}</div>}
                    </td>
                    <td className="muted nowrap">{r.iit || '—'}</td>
                    <td className="nowrap small">
                      {st ? (
                        <span className={`pill ${st.status}`} title={st.error || ''}>
                          {st.status === 'waiting' ? `Next in ${st.nextInSec}s` : STATUS_LABEL[st.status]}
                        </span>
                      ) : sentAt ? (
                        <span className="pill sent" title={`Last emailed ${new Date(sentAt).toLocaleString()}`}>Emailed {new Date(sentAt).toLocaleDateString()}</span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                      {st?.status === 'failed' && <div className="error-text small wrap">{st.error}</div>}
                    </td>
                    <td onClick={(e) => e.stopPropagation()}>
                      <button
                        className="icon-btn"
                        title="Remove"
                        disabled={busy}
                        onClick={() => {
                          setRecipients(recipients.filter((x) => x.email !== r.email));
                          setSelected((s) => { const n = new Set(s); n.delete(r.email); return n; });
                        }}
                      >×</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- Main view */

export default function EmailView({ recipients, setRecipients, selected, setSelected }) {
  const [settings, setSettings] = useState(null);
  // Draft and attachments are saved in the app's settings (null until loaded).
  const [subject, setSubject] = useState(null);
  const [body, setBody] = useState(null);
  const [attachments, setAttachments] = useState([]);
  const [previewEmail, setPreviewEmail] = useState('');
  const [preview, setPreview] = useState(null);
  const [sentLog, setSentLog] = useState([]);
  const [status, setStatus] = useState({}); // email -> { status, error, nextInSec }
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState(null); // final totals or { error }
  const [testState, setTestState] = useState(null);
  const subjectRef = useRef(null);
  const bodyRef = useRef(null);
  const lastField = useRef('body');

  useEffect(() => {
    mail.getSettings().then((s) => {
      setSettings(s);
      setSubject(s.draft?.subject ?? DEFAULT_SUBJECT);
      setBody(s.draft?.body ?? DEFAULT_BODY);
      setAttachments(s.attachments || []);
    });
    mail.sentLog().then(setSentLog);
    return mail.onProgress((p) => setStatus((s) => ({ ...s, [p.email]: p })));
  }, []);
  // Save the draft half a second after typing stops.
  useEffect(() => {
    if (subject === null) return;
    const t = setTimeout(() => mail.saveSettings({ draft: { subject, body } }), 500);
    return () => clearTimeout(t);
  }, [subject, body]);
  function updateAttachments(next) {
    setAttachments(next);
    mail.saveSettings({ attachments: next.map((a) => a.path) });
  }

  // Last time each address was emailed (from the sent log).
  const sentMap = useMemo(() => new Map(sentLog.map((e) => [e.email.toLowerCase(), e.sentAt])), [sentLog]);
  const chosen = useMemo(() => recipients.filter((r) => selected.has(r.email)), [recipients, selected]);
  const previewRecipient = recipients.find((r) => r.email === previewEmail) || chosen[0] || recipients[0] || null;

  useEffect(() => {
    let live = true;
    if (subject === null) return;
    mail.preview({ subject, body, recipient: previewRecipient || {}, recipients: chosen }).then((p) => live && setPreview(p));
    return () => {
      live = false;
    };
  }, [subject, body, previewRecipient, chosen]);

  /** Insert {{tag}} at the cursor of the subject or message field (whichever was used last). */
  function insertTag(key) {
    const isSubject = lastField.current === 'subject';
    const el = isSubject ? subjectRef.current : bodyRef.current;
    const value = isSubject ? subject : body;
    const tag = key === 'research' ? '{{research|your research}}' : `{{${key}}}`;
    const start = el?.selectionStart ?? value.length;
    const end = el?.selectionEnd ?? value.length;
    const next = value.slice(0, start) + tag + value.slice(end);
    (isSubject ? setSubject : setBody)(next);
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(start + tag.length, start + tag.length);
    });
  }

  async function addAttachments() {
    const files = await mail.pickAttachments();
    updateAttachments([...attachments, ...files.filter((f) => !attachments.some((x) => x.path === f.path))]);
  }

  async function saveDelay(v) {
    setSettings(await mail.saveSettings({ delaySec: v }));
  }

  if (subject === null) return <div className="view" />;
  const configured = settings?.user && settings?.hasPassword;
  const leftover = (subject + '\n' + body).match(/\[[A-Z][^\]\n]{1,40}\]/g) || [];
  const attachBytes = attachments.reduce((n, a) => n + a.size, 0);
  const blocker = !configured
    ? 'Set up your email account first.'
    : !chosen.length
      ? 'Select at least one recipient.'
      : !subject.trim() || !body.trim()
        ? 'Write a subject and a message.'
        : leftover.length
          ? `Fill in ${[...new Set(leftover)].slice(0, 3).join(', ')}${leftover.length > 3 ? '…' : ''} in your message first.`
          : preview?.unknown?.length
            ? `Unknown placeholder ${preview.unknown[0]}.`
            : '';
  const delay = settings?.delaySec ?? 30;
  const progress = chosen.length ? chosen.filter((r) => ['sent', 'failed'].includes(status[r.email]?.status)).length : 0;

  async function sendTest() {
    setTestState('sending');
    const res = await mail.sendTest({ subject, body, attachments: attachments.map((a) => a.path), recipient: previewRecipient || {} });
    setTestState(res);
  }

  async function sendAll() {
    const n = chosen.length;
    if (!window.confirm(`Send ${n} separate email${n > 1 ? 's' : ''} from ${settings.user}?\n\nThis takes about ${formatDuration((n - 1) * delay)}. Keep the app open until it finishes.`)) return;
    const batch = chosen;
    setStatus(Object.fromEntries(batch.map((r) => [r.email, { status: 'queued' }])));
    setResult(null);
    setSending(true);
    try {
      setResult(await mail.send({ subject, body, attachments: attachments.map((a) => a.path), recipients: batch }));
    } finally {
      setSending(false);
      const log = await mail.sentLog();
      setSentLog(log);
      // Untick the people who now have the email, so a second click can't resend.
      const done = new Set(log.map((e) => e.email));
      setSelected((s) => new Set([...s].filter((e) => !done.has(e))));
    }
  }

  return (
    <div className="view">
      <header className="top">
        <div>
          <h2>Email them</h2>
          <p className="muted small">One personal email per professor, sent from your own account.</p>
        </div>
      </header>

      <div className="email-grid">
        <div className="col">
          <AccountCard settings={settings} onSaved={setSettings} />
          <RecipientsCard
            {...{ recipients, setRecipients, selected, setSelected, sentMap, status, previewEmail, setPreviewEmail }}
            busy={sending}
          />
        </div>

        <div className="col">
          <section className="card">
            <div className="card-head">
              <h3>Message</h3>
              <button className="link small" onClick={() => { setSubject(DEFAULT_SUBJECT); setBody(DEFAULT_BODY); }} disabled={sending}>Reset template</button>
            </div>
            <div className="form">
              <label>
                <span>Subject</span>
                <input ref={subjectRef} className="input" value={subject} disabled={sending} onFocus={() => (lastField.current = 'subject')} onChange={(e) => setSubject(e.target.value)} />
              </label>
              <div className="tags">
                <span className="small muted">Insert:</span>
                {(settings?.placeholders || []).map((p) => (
                  <button key={p.key} className="tag" onClick={() => insertTag(p.key)} disabled={sending} title={`e.g. ${p.example}`}>{p.label}</button>
                ))}
              </div>
              <textarea ref={bodyRef} className="input textarea body" value={body} disabled={sending} onFocus={() => (lastField.current = 'body')} onChange={(e) => setBody(e.target.value)} spellCheck />
              <div className="attachments">
                {attachments.map((a) => (
                  <span key={a.path} className="file">
                    📎 {a.name} <span className="muted">{formatSize(a.size)}</span>
                    <button className="icon-btn" onClick={() => updateAttachments(attachments.filter((x) => x.path !== a.path))} disabled={sending} title="Remove">×</button>
                  </span>
                ))}
                <button className="btn" onClick={addAttachments} disabled={sending}>Attach CV…</button>
                {attachBytes > 20e6 && <span className="small error-text">Over 20 MB; most servers will reject this.</span>}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card-head">
              <h3>Preview</h3>
              {previewRecipient && <span className="small muted">for {previewRecipient.name || previewRecipient.email} · click a recipient to switch</span>}
            </div>
            {preview?.missing?.map((m) => (
              <p key={m.key} className="small warn-text">
                {m.count} selected recipient{m.count > 1 ? 's have' : ' has'} no {m.key}, so {'{{' + m.key + '}}'} will be blank. Add a fallback like {'{{' + m.key + '|…}}'}.
              </p>
            ))}
            {preview?.unknown?.length > 0 && <p className="small error-text">Unknown placeholder: {preview.unknown.join(', ')}</p>}
            {previewRecipient ? (
              <div className="preview">
                <div className="preview-meta small muted">
                  To: {previewRecipient.name ? `${previewRecipient.name} <${previewRecipient.email}>` : previewRecipient.email}
                </div>
                <div className="preview-subject">{preview?.subject}</div>
                <div className="preview-body">{preview?.body}</div>
              </div>
            ) : (
              <p className="muted small">Add recipients to see a personalized preview.</p>
            )}
          </section>
        </div>
      </div>

      <footer className="sendbar">
        {sending ? (
          <>
            <div className="progress">
              <div className="progress-bar" style={{ width: `${(progress / Math.max(1, chosen.length)) * 100}%` }} />
            </div>
            <span className="small">Sent {progress} of {chosen.length}</span>
            <button className="btn" onClick={() => mail.stop()}>Stop</button>
          </>
        ) : (
          <>
            <label className="small muted delay">
              Wait
              <input className="input" type="number" min={0} max={600} value={delay} onChange={(e) => saveDelay(Number(e.target.value))} />
              s between emails
            </label>
            {chosen.length > 1 && <span className="small muted">≈ {formatDuration((chosen.length - 1) * delay)} for {chosen.length} emails</span>}
            {chosen.length > 100 && <span className="small warn-text">Gmail allows ~500 a day; batches under 100 are safer.</span>}
            <span className="grow small">
              {result?.error && <span className="error-text">{result.error}</span>}
              {result && !result.error && (
                <span className={result.failed ? 'warn-text' : 'ok-text'}>
                  Sent {result.sent}{result.failed ? `, ${result.failed} failed` : ''}{result.cancelled ? `, ${result.cancelled} not sent` : ''}.
                  {result.aborted && ` Stopped: ${result.aborted}`}
                </span>
              )}
              {!result && blocker && <span className="muted">{blocker}</span>}
              {testState && testState !== 'sending' && (
                <span className={testState.ok ? 'ok-text' : 'error-text'}> {testState.ok ? `Test sent to ${testState.to}.` : testState.error}</span>
              )}
            </span>
            <button className="btn" onClick={sendTest} disabled={!configured || !previewRecipient || testState === 'sending'}>
              {testState === 'sending' ? 'Sending test…' : 'Send test to me'}
            </button>
            <button className="btn primary" onClick={sendAll} disabled={Boolean(blocker)}>
              Send to {chosen.length}
            </button>
          </>
        )}
      </footer>
    </div>
  );
}
