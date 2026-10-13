import React, { useState } from 'react';
import Contacts from './Contacts.jsx';
import EmailView from './EmailView.jsx';

const ContactsIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
    <path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
  </svg>
);
const MailIcon = () => (
  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <rect x="2" y="4" width="20" height="16" rx="2" /><path d="m22 7-10 6L2 7" />
  </svg>
);

/**
 * App shell: a sidebar with the two sections. Both views stay mounted so search
 * results and the email draft survive switching between them.
 */
export default function App() {
  const [view, setView] = useState('contacts');
  // The email list lives here so "Email these" on Contacts can fill it.
  const [recipients, setRecipients] = useState([]);
  const [selected, setSelected] = useState(new Set());

  function emailThese(rows) {
    const known = new Set(recipients.map((r) => r.email));
    const fresh = rows
      .map((p) => ({ email: p.email.toLowerCase(), name: p.name, iit: p.iit, department: p.department, research: p.researchAreas }))
      .filter((r) => !known.has(r.email) && known.add(r.email));
    setRecipients([...recipients, ...fresh]);
    setSelected((s) => new Set([...s, ...fresh.map((r) => r.email)]));
    setView('email');
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <span className="logo" aria-hidden>◆</span>
          <span>Professor Finder</span>
        </div>
        <nav>
          <button className={`nav-item ${view === 'contacts' ? 'active' : ''}`} onClick={() => setView('contacts')}>
            <ContactsIcon /> Contacts
          </button>
          <button className={`nav-item ${view === 'email' ? 'active' : ''}`} onClick={() => setView('email')}>
            <MailIcon /> Email them
            {recipients.length > 0 && <span className="badge">{recipients.length}</span>}
          </button>
        </nav>
      </aside>
      <main className="main">
        <div className="pane" hidden={view !== 'contacts'}>
          <Contacts onEmail={emailThese} />
        </div>
        <div className="pane" hidden={view !== 'email'}>
          <EmailView {...{ recipients, setRecipients, selected, setSelected }} />
        </div>
      </main>
    </div>
  );
}
