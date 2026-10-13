import React, { useEffect, useMemo, useState } from 'react';
import Papa from 'papaparse';
import CitySearch from './CitySearch.jsx';
import ResultsTable from './ResultsTable.jsx';

const api = window.api;

/** "3 hours ago" style label for the cache timestamp. */
function timeAgo(iso) {
  if (!iso) return '';
  const s = Math.max(0, (Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return 'just now';
  const units = [[86400, 'day'], [3600, 'hour'], [60, 'minute']];
  for (const [sec, name] of units) {
    if (s >= sec) {
      const n = Math.floor(s / sec);
      return `${n} ${name}${n > 1 ? 's' : ''} ago`;
    }
  }
}

/** Turn URLs inside a message into clickable links (opened in the system browser). */
function linkify(text) {
  return text.split(/(https?:\/\/[^\s)]+)/g).map((part, i) =>
    i % 2 ? (
      <button key={i} className="link" onClick={() => api.openExternal(part.replace(/[.,]$/, ''))}>
        {part.replace(/[.,]$/, '')}
      </button>
    ) : (
      part
    )
  );
}

/** The professor finder: city search, results table, filters and CSV export. */
export default function Contacts({ onEmail }) {
  const [suggestions, setSuggestions] = useState([]);
  const [city, setCity] = useState('');
  const [loading, setLoading] = useState(false);
  const [progress, setProgress] = useState('');
  const [result, setResult] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [dept, setDept] = useState('');
  const [showWarnings, setShowWarnings] = useState(false);

  useEffect(() => {
    api.suggestions().then(setSuggestions);
    return api.onProgress(setProgress);
  }, []);

  async function search(query, refresh = false) {
    const q = (query ?? city).trim();
    if (!q || loading) return;
    setLoading(true);
    setProgress(refresh ? 'Refreshing…' : 'Looking up…');
    if (!refresh) {
      setKeyword('');
      setDept('');
    }
    try {
      setResult(await api.search(q, { refresh }));
    } finally {
      setLoading(false);
      setProgress('');
    }
  }

  const professors = result?.professors || [];
  // Professors per department, largest first (shown as the breakdown at the top).
  const deptCounts = useMemo(() => {
    const counts = new Map();
    for (const p of professors) counts.set(p.department, (counts.get(p.department) || 0) + 1);
    return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  }, [professors]);
  const departments = useMemo(() => deptCounts.map(([d]) => d).sort(), [deptCounts]);

  const rows = useMemo(() => {
    // Comma-separated keywords match if ANY of them appears in the research areas.
    const terms = keyword.toLowerCase().split(',').map((t) => t.trim()).filter(Boolean);
    return professors.filter(
      (p) =>
        (!dept || p.department === dept) &&
        (!terms.length || terms.some((t) => p.researchAreas.toLowerCase().includes(t)))
    );
  }, [professors, keyword, dept]);

  async function exportCsv() {
    const csv = Papa.unparse(
      rows.map((p) => ({
        Name: p.name,
        IIT: p.iit,
        Department: p.department,
        'Research Areas': p.researchAreas,
        Email: p.email,
        Homepage: p.homepage,
        'Google Scholar': p.scholar,
        'LinkedIn Search': p.linkedinSearchUrl,
      }))
    );
    const slug = (result.iit?.name || 'iit').toLowerCase().replace(/\W+/g, '-');
    await api.saveCsv(csv, `${slug}-professors${keyword ? '-' + keyword.replace(/\W+/g, '-') : ''}.csv`);
  }

  const withEmail = professors.filter((p) => p.email).length;

  return (
    <div className="view">
      <header className="top">
        <CitySearch
          value={city}
          onChange={setCity}
          suggestions={suggestions}
          onSubmit={(q) => search(q)}
          disabled={loading}
        />
      </header>

      {loading && (
        <div className="status">
          <span className="spinner" aria-hidden />
          <span>{progress}</span>
          <span className="muted small">Pages are fetched politely (1 request/sec per site), so a first search can take a minute or two.</span>
        </div>
      )}

      {!loading && !result && (
        <div className="empty">
          <h1>Find professors for research internships</h1>
          <p className="muted">Type a city with an IIT to list tech-department faculty, with emails and research areas.</p>
          <div className="chips">
            {['Mumbai', 'Delhi', 'Chennai', 'Kanpur', 'Jammu'].map((c) => (
              <button key={c} className="chip" onClick={() => { setCity(c); search(c); }}>{c}</button>
            ))}
          </div>
        </div>
      )}

      {!loading && result?.notFound && (
        <div className="empty">
          <h1>No IIT in “{result.query}”</h1>
          <p className="muted">Try one of the suggestions in the search box, for example Mumbai, Chennai or Guwahati.</p>
        </div>
      )}

      {!loading && result?.iit && professors.length === 0 && (
        <div className="empty">
          <h1>{result.iit.name}</h1>
          {(result.warnings?.length ? result.warnings : ['No professors found.']).map((w) => (
            <p key={w} className="muted">{linkify(w)}</p>
          ))}
          <div className="chips">
            <button className="chip" onClick={() => api.openExternal(result.iit.website)}>Open {result.iit.name} website ↗</button>
            <button className="chip" onClick={() => search(result.iit.city, true)}>Try again</button>
          </div>
        </div>
      )}

      {!loading && result?.iit && professors.length > 0 && (
        <>
          <section className="summary">
            <div>
              <h2>{result.iit.name}</h2>
              <p className="total">
                <strong>{professors.length}</strong> professors in tech departments
              </p>
              <div className="dept-counts">
                {deptCounts.map(([d, n]) => (
                  <button
                    key={d}
                    className={`dept-count ${dept === d ? 'active' : ''}`}
                    onClick={() => setDept(dept === d ? '' : d)}
                    title={dept === d ? 'Show all departments' : `Show only ${d}`}
                  >
                    {d} <span className="n">{n}</span>
                  </button>
                ))}
              </div>
              <p className="muted small">
                {withEmail} with email
                {result.scrapedAt && <> · updated {timeAgo(result.scrapedAt)}{result.fromCache ? ' (cached)' : ''}</>}
                {result.stale && <span className="stale"> · may be out of date</span>}
              </p>
              {result.iit.notes && <p className="muted small note">{result.iit.notes}</p>}
            </div>
            <button className="btn ghost" onClick={() => search(result.iit.city, true)} title="Scrape the department pages again">
              ↻ Refresh
            </button>
          </section>

          {result.warnings?.length > 0 && (
            <div className="warning">
              <button className="link" onClick={() => setShowWarnings((v) => !v)}>
                {result.warnings.length} note{result.warnings.length > 1 ? 's' : ''} about this result
                {showWarnings ? ' ▴' : ' ▾'}
              </button>
              {showWarnings && (
                <ul>{result.warnings.map((w) => <li key={w}>{linkify(w)}</li>)}</ul>
              )}
            </div>
          )}

          <section className="toolbar">
            <input
              className="input"
              placeholder="Filter by research keyword, e.g. machine learning, VLSI"
              value={keyword}
              onChange={(e) => setKeyword(e.target.value)}
            />
            <select className="input select" value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">All departments</option>
              {departments.map((d) => <option key={d}>{d}</option>)}
            </select>
            <span className="muted small count">{rows.length} shown</span>
            <button className="btn" onClick={exportCsv} disabled={!rows.length}>Export CSV</button>
            <button
              className="btn primary"
              onClick={() => onEmail(rows.filter((p) => p.email))}
              disabled={!rows.some((p) => p.email)}
              title="Add the professors shown (with an email) to the Email them list"
            >
              Email these {rows.filter((p) => p.email).length}
            </button>
          </section>

          <ResultsTable rows={rows} keyword={keyword} />
        </>
      )}
    </div>
  );
}
