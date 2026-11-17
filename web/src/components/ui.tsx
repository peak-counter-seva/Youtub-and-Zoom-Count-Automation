import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";

/* ---------- Icons (24px grid, stroke) ---------- */
const PATHS = {
  timer: <><path d="M10 2h4" /><path d="M12 14l3-3" /><circle cx="12" cy="14" r="8" /></>,
  activity: <path d="M22 12h-4l-3 9L9 3l-3 9H2" />,
  settings: <><path d="M20 7h-9" /><path d="M14 17H5" /><circle cx="17" cy="17" r="3" /><circle cx="7" cy="7" r="3" /></>,
  play: <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12.5-7.5a1 1 0 0 0 0-1.72L8.5 3.64A1 1 0 0 0 7 4.5z" fill="currentColor" stroke="none" />,
  stop: <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" stroke="none" />,
  plus: <path d="M12 5v14M5 12h14" />,
  pencil: <><path d="M21.17 6.81a2.82 2.82 0 0 0-3.99-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.62l4.35-1.32a2 2 0 0 0 .83-.5z" /><path d="m15 5 4 4" /></>,
  copy: <><rect width="13" height="13" x="9" y="9" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>,
  trash: <><path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" /><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" /></>,
  back: <path d="m15 18-6-6 6-6" />,
  chevron: <path d="m9 18 6-6-6-6" />,
  x: <path d="M18 6 6 18M6 6l12 12" />,
  video: <><path d="m16 13 5.22 3.48a.5.5 0 0 0 .78-.42V7.94a.5.5 0 0 0-.76-.43L16 10.5" /><rect x="2" y="6" width="14" height="12" rx="2" /></>,
  users: <><path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" /><path d="M22 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" /></>,
  message: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  send: <><path d="M14.54 21.69a.5.5 0 0 0 .93-.02l6.5-19a.5.5 0 0 0-.64-.64l-19 6.5a.5.5 0 0 0-.02.93l7.93 3.18a2 2 0 0 1 1.11 1.11z" /><path d="m21.85 2.15-10.94 10.94" /></>,
  phone: <><rect width="14" height="20" x="5" y="2" rx="2" /><path d="M12 18h.01" /></>,
  logout: <><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" /><path d="m16 17 5-5-5-5" /><path d="M21 12H9" /></>,
  clock: <><circle cx="12" cy="12" r="10" /><path d="M12 6v6l4 2" /></>,
  user: <><circle cx="12" cy="8" r="4" /><path d="M20 21a8 8 0 0 0-16 0" /></>,
  key: <><path d="m15.5 7.5 2.3 2.3a1 1 0 0 0 1.4 0l2.1-2.1a1 1 0 0 0 0-1.4L19 4" /><path d="m21 2-9.6 9.6" /><circle cx="7.5" cy="15.5" r="5.5" /></>,
  github: <path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.403 5.403 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4M9 18c-4.51 2-5-2-7-2" />,
  alert: <><circle cx="12" cy="12" r="10" /><path d="M12 8v4M12 16h.01" /></>,
  check: <path d="M20 6 9 17l-5-5" />,
  calendar: <><rect width="18" height="18" x="3" y="4" rx="2" /><path d="M16 2v4M8 2v4M3 10h18" /></>,
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, size = 18, stroke = 1.75 }: { name: IconName; size?: number; stroke?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {PATHS[name]}
    </svg>
  );
}

export function Logo({ className = "brand-mark" }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 32 32" aria-hidden="true">
      <rect width="32" height="32" rx="8" fill="#15171c" />
      <path d="M6 22l5-6 4 3 6-9 5 5" fill="none" stroke="#fff" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="21" cy="10" r="2.6" fill="#3fc19b" />
    </svg>
  );
}

/* ---------- Small controls ---------- */
export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return <button type="button" role="switch" aria-checked={on} aria-label={label} className={`switch ${on ? "on" : ""}`} onClick={() => onChange(!on)} />;
}

export function Segmented<T extends string>({ value, options, onChange }: {
  value: T; options: { value: T; label: string }[]; onChange: (v: T) => void;
}) {
  return (
    <div className="segmented" role="radiogroup">
      {options.map((o) => (
        <button type="button" key={o.value} role="radio" aria-checked={value === o.value}
          className={value === o.value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint && <span className="hint">{hint}</span>}
    </label>
  );
}

export function Notice({ tone, children }: { tone: "warn" | "error" | "info"; children: ReactNode }) {
  return (
    <div className={`notice ${tone}`}>
      <Icon name={tone === "info" ? "check" : "alert"} size={16} />
      <div>{children}</div>
    </div>
  );
}

export function Empty({ icon, title, text, action }: { icon: IconName; title: string; text: string; action?: ReactNode }) {
  return (
    <div className="card empty">
      <div className="row-icon"><Icon name={icon} size={20} /></div>
      <h3>{title}</h3>
      <p>{text}</p>
      {action}
    </div>
  );
}

/* ---------- Confirm dialog + toast ---------- */
interface ConfirmOpts { title: string; body?: string; confirm: string; danger?: boolean }
interface Ctx { confirm: (o: ConfirmOpts) => Promise<boolean>; toast: (msg: string) => void }
const UiCtx = createContext<Ctx>({ confirm: async () => false, toast: () => {} });

export function UiProvider({ children }: { children: ReactNode }) {
  const [dlg, setDlg] = useState<(ConfirmOpts & { resolve: (v: boolean) => void }) | null>(null);
  const [toastMsg, setToastMsg] = useState<string | null>(null);
  const timer = useRef<number | undefined>(undefined);

  const confirm = useCallback((o: ConfirmOpts) => new Promise<boolean>((resolve) => setDlg({ ...o, resolve })), []);
  const toast = useCallback((msg: string) => {
    setToastMsg(msg);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setToastMsg(null), 2600);
  }, []);

  const close = (v: boolean) => { dlg?.resolve(v); setDlg(null); };

  useEffect(() => {
    if (!dlg) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close(false);
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <UiCtx.Provider value={{ confirm, toast }}>
      {children}
      {dlg && (
        <div className="scrim" onClick={() => close(false)}>
          <div className="dialog" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
            <h2>{dlg.title}</h2>
            {dlg.body && <p>{dlg.body}</p>}
            <div className="btn-row">
              <button className="btn" onClick={() => close(false)}>Cancel</button>
              <button className={`btn ${dlg.danger ? "btn-danger-solid" : "btn-primary"}`} autoFocus onClick={() => close(true)}>
                {dlg.confirm}
              </button>
            </div>
          </div>
        </div>
      )}
      {toastMsg && <div className="toast" role="status">{toastMsg}</div>}
    </UiCtx.Provider>
  );
}

export const useUi = () => useContext(UiCtx);
