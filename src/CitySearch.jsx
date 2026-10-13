import React, { useMemo, useRef, useState } from 'react';

/**
 * City input with autocomplete from iits.json (cities + aliases).
 * Arrow keys move through suggestions, Enter searches, Escape closes.
 */
export default function CitySearch({ value, onChange, suggestions, onSubmit, disabled }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const inputRef = useRef(null);

  const matches = useMemo(() => {
    const q = value.trim().toLowerCase();
    const list = q
      ? suggestions.filter((s) => s.label.toLowerCase().startsWith(q) || s.iit.toLowerCase().includes(q))
      : suggestions;
    return list.slice(0, 8);
  }, [value, suggestions]);

  function choose(s) {
    onChange(s.label);
    setOpen(false);
    onSubmit(s.label);
    inputRef.current?.blur();
  }

  function onKeyDown(e) {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((a) => Math.min(a + 1, matches.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (open && matches[active] && value.trim()) choose(matches[active]);
      else {
        setOpen(false);
        onSubmit(value);
      }
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <form className="city" onSubmit={(e) => e.preventDefault()} role="search">
      <div className="combo">
        <input
          ref={inputRef}
          className="input"
          placeholder="City, e.g. Mumbai"
          value={value}
          disabled={disabled}
          onChange={(e) => {
            onChange(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 120)}
          onKeyDown={onKeyDown}
          aria-autocomplete="list"
          aria-expanded={open}
        />
        {open && matches.length > 0 && (
          <ul className="suggest" role="listbox">
            {matches.map((s, i) => (
              <li
                key={s.label + s.id}
                role="option"
                aria-selected={i === active}
                className={i === active ? 'active' : ''}
                onMouseDown={(e) => { e.preventDefault(); choose(s); }}
                onMouseEnter={() => setActive(i)}
              >
                <span>{s.label}</span>
                <span className="muted small">{s.iit}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <button className="btn primary" disabled={disabled || !value.trim()} onClick={() => { setOpen(false); onSubmit(value); }}>
        Search
      </button>
    </form>
  );
}
