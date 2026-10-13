import React, { useState } from 'react';

const open = (url) => window.api.openExternal(url);

/** Wrap occurrences of the filter keywords in <mark>. */
function highlight(text, keyword) {
  const terms = keyword.split(',').map((t) => t.trim()).filter(Boolean);
  if (!terms.length || !text) return text;
  const re = new RegExp(`(${terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})`, 'gi');
  return text.split(re).map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : part));
}

function LinkCell({ url, label }) {
  if (!url) return <span className="muted">—</span>;
  return (
    <button className="link" onClick={() => open(url)} title={url}>
      {label} ↗
    </button>
  );
}

function EmailCell({ email }) {
  const [copied, setCopied] = useState(false);
  if (!email) return <span className="muted">—</span>;
  async function copy() {
    await window.api.copy(email);
    setCopied(true);
    setTimeout(() => setCopied(false), 1200);
  }
  return (
    <button className={`copy ${copied ? 'done' : ''}`} onClick={copy} title="Click to copy">
      <span className="mono">{email}</span>
      <span className="copy-hint">{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

export default function ResultsTable({ rows, keyword }) {
  if (!rows.length) {
    return <div className="empty small-empty muted">No professors match these filters.</div>;
  }
  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Name</th>
            <th>IIT</th>
            <th>Department</th>
            <th className="wide">Research Areas</th>
            <th>Email</th>
            <th>Homepage</th>
            <th>Scholar</th>
            <th>LinkedIn</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((p) => (
            <tr key={p.name + p.department}>
              <td className="name">
                {p.profileUrl ? (
                  <button className="link strong" onClick={() => open(p.profileUrl)} title="Open faculty profile">
                    {p.name}
                  </button>
                ) : (
                  <strong>{p.name}</strong>
                )}
              </td>
              <td className="nowrap muted">{p.iit}</td>
              <td className="dept">{p.department}</td>
              <td className="research" title={p.researchAreas}>
                {p.researchAreas ? <div className="clamp">{highlight(p.researchAreas, keyword)}</div> : <span className="muted">—</span>}
              </td>
              <td className="links"><EmailCell email={p.email} /></td>
              <td className="links"><LinkCell url={p.homepage} label="Site" /></td>
              <td className="links"><LinkCell url={p.scholar} label="Scholar" /></td>
              <td className="links"><LinkCell url={p.linkedinSearchUrl} label="Search" /></td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
