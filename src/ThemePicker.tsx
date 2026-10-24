import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Check, Monitor, Moon, Sun } from 'lucide-react';

type Theme = 'light' | 'dark' | 'system';
const options = [
  { value: 'light', label: 'Light', Icon: Sun },
  { value: 'dark', label: 'Dark', Icon: Moon },
  { value: 'system', label: 'System', Icon: Monitor },
] as const;
const isTheme = (value: unknown): value is Theme => options.some((option) => option.value === value);

export function ThemePicker() {
  const [preference, setPreference] = useState<Theme>(() => {
    const initial = document.documentElement.dataset.themePreference;
    return isTheme(initial) ? initial : 'system';
  });
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  const [open, setOpen] = useState(false);
  const picker = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const resolved = preference === 'system' ? (systemDark ? 'dark' : 'light') : preference;
  const AppearanceIcon = resolved === 'dark' ? Moon : Sun;

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const change = () => setSystemDark(media.matches);
    change();
    media.addEventListener('change', change);
    const storage = (event: StorageEvent) => {
      if (event.key === 'onmyway-theme' || event.key === null) setPreference(isTheme(event.newValue) ? event.newValue : 'system');
    };
    window.addEventListener('storage', storage);
    return () => { media.removeEventListener('change', change); window.removeEventListener('storage', storage); };
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
    document.documentElement.dataset.themePreference = preference;
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', resolved === 'dark' ? '#17231d' : '#f7f8f2');
  }, [preference, resolved]);

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
    const dismiss = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', dismiss);
    return () => document.removeEventListener('pointerdown', dismiss);
  }, [open]);

  function close() { setOpen(false); trigger.current?.focus(); }
  function handleKeys(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
    const buttons = Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('button') ?? []);
    const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? (index - 1 + buttons.length) % buttons.length : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
  }

  return <div className="theme-picker" ref={picker} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} className="theme-trigger" type="button" aria-label={`Appearance: ${preference}${preference === 'system' ? ` (${resolved})` : ''}`} title="Change appearance" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? 'theme-menu' : undefined} onClick={() => setOpen(!open)} onKeyDown={(event) => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
      {preference === 'system' ? <span className="system-theme-icon"><Monitor size={20} /><AppearanceIcon className="system-theme-badge" size={12} /></span> : <AppearanceIcon size={20} />}
    </button>
    {open && <div ref={menu} id="theme-menu" className="theme-menu" role="menu" aria-label="Appearance" onKeyDown={handleKeys}>
      {options.map(({ value, label, Icon }) => <button key={value} type="button" role="menuitemradio" aria-checked={preference === value} tabIndex={-1} onClick={() => {
        setPreference(value);
        try { localStorage.setItem('onmyway-theme', value); } catch { /* Keep the selection for this visit. */ }
        close();
      }}><Icon size={17} /><span>{label}</span>{preference === value && <Check size={16} />}</button>)}
    </div>}
  </div>;
}
