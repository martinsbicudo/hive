import { useEffect, useRef, useState, type KeyboardEvent } from "react";

interface Props {
  roles: readonly string[];
  onPick: (role: string) => void;
}

export function RolePicker({ roles, onPick }: Props) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const root = useRef<HTMLDivElement>(null);

  const needle = query.trim().toLowerCase();
  const matches = roles.filter((role) => role.toLowerCase().includes(needle));

  useEffect(() => {
    if (!open) return;
    const onDown = (event: MouseEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [open]);

  const toggle = () => {
    setQuery("");
    setActive(0);
    setOpen((current) => !current);
  };

  const pick = (role: string) => {
    onPick(role);
    setOpen(false);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      setOpen(false);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      setActive((current) => Math.min(current + 1, matches.length - 1));
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      setActive((current) => Math.max(current - 1, 0));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const role = matches[active];
      if (role) pick(role);
    }
  };

  return (
    <div className="picker" ref={root}>
      <button type="button" className="ghost icon" title="Choose a role" aria-label="Choose a role" aria-haspopup="listbox" aria-expanded={open} onClick={toggle}>
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" aria-hidden="true"><path d="M2.5 4h11M2.5 8h11M2.5 12h7" /></svg>
      </button>
      {open && (
        <div className="picker-pop">
          <input autoFocus value={query} placeholder="Search roles…" aria-label="Search roles" onChange={(event) => { setQuery(event.target.value); setActive(0); }} onKeyDown={onKeyDown} />
          <ul className="picker-list" role="listbox" aria-label="Roles">
            {matches.map((role, index) => (
              <li key={role} role="presentation">
                <button type="button" role="option" aria-selected={index === active} className={`picker-option ${index === active ? "active" : ""}`} onMouseEnter={() => setActive(index)} onClick={() => pick(role)}>{role}</button>
              </li>
            ))}
            {matches.length === 0 && <li className="hint picker-empty">No match. Type your own role in the field.</li>}
          </ul>
        </div>
      )}
    </div>
  );
}
