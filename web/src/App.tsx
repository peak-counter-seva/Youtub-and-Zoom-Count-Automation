import { useEffect, useState } from "react";
import { signInWithPopup, signOut } from "firebase/auth";
import { auth, googleProvider } from "./lib/firebase";
import { useDocument, useUser } from "./lib/hooks";
import { Icon, Logo, UiProvider, type IconName } from "./components/ui";
import Automations from "./pages/Automations";
import Runs from "./pages/Runs";
import Settings from "./pages/Settings";

type Tab = "automations" | "runs" | "settings";
const TABS: { id: Tab; label: string; icon: IconName }[] = [
  { id: "automations", label: "Automations", icon: "timer" },
  { id: "runs", label: "Runs", icon: "activity" },
  { id: "settings", label: "Settings", icon: "settings" },
];

interface Allowed { id: string; role: "admin" | "member" }

function GoogleG() {
  return (
    <svg width="18" height="18" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.2 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z" />
      <path fill="#FF3D00" d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z" />
      <path fill="#4CAF50" d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.2 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z" />
      <path fill="#1976D2" d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z" />
    </svg>
  );
}

function Splash() {
  return <div className="splash"><div className="spinner" /></div>;
}

export default function App() {
  return (
    <UiProvider>
      <Shell />
    </UiProvider>
  );
}

function Shell() {
  const user = useUser();
  const allowed = useDocument<Allowed>("allowedUsers", user?.email?.toLowerCase() ?? null);
  const [tab, setTab] = useState<Tab>("automations");
  const [editId, setEditId] = useState<string | null>(null);
  const [menu, setMenu] = useState(false);
  const [signInErr, setSignInErr] = useState<string | null>(null);

  useEffect(() => { window.scrollTo(0, 0); }, [tab]);

  if (user === undefined) return <Splash />;

  if (!user)
    return (
      <div className="auth">
        <div className="auth-card">
          <Logo />
          <h1>Peak Counter</h1>
          <p className="lead">Tracks the highest live viewers on YouTube and participants on Zoom, then sends the totals by SMS.</p>
          <button className="btn google-btn" onClick={() => signInWithPopup(auth, googleProvider).catch((e) => setSignInErr(e.message))}>
            <GoogleG /> Continue with Google
          </button>
          {signInErr && <p className="inline-msg err">{signInErr}</p>}
          <p className="foot">Only approved members can sign in. Ask your admin to add your Gmail address.</p>
        </div>
      </div>
    );

  if (allowed === undefined) return <Splash />;

  if (!allowed)
    return (
      <div className="auth">
        <div className="auth-card">
          <Logo />
          <h1>Waiting for approval</h1>
          <p className="lead"><b>{user.email}</b> isn’t on the approved list yet. Ask the admin to add it under Settings → Members, then sign in again.</p>
          <button className="btn btn-block btn-lg" onClick={() => signOut(auth)}>Use a different account</button>
        </div>
      </div>
    );

  const isAdmin = allowed.role === "admin";
  const initial = (user.displayName || user.email || "?").trim()[0]?.toUpperCase();

  return (
    <>
      <header className="topbar">
        <div className="topbar-inner">
          <div className="brand"><Logo /> Peak Counter</div>
          <nav className="tabs">
            {TABS.map((t) => (
              <button key={t.id} className={`tab ${tab === t.id ? "active" : ""}`} onClick={() => setTab(t.id)}>
                <Icon name={t.icon} size={16} /> {t.label}
              </button>
            ))}
          </nav>
          <div className="topbar-spacer" />
          <button className="avatar" aria-label="Account" onClick={() => setMenu((m) => !m)}>
            {user.photoURL ? <img src={user.photoURL} alt="" referrerPolicy="no-referrer" /> : initial}
          </button>
        </div>
      </header>

      {menu && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 25 }} onClick={() => setMenu(false)} />
          <div className="menu">
            <div className="menu-head">
              <div className="name">{user.displayName || "Signed in"}</div>
              <div className="email">{user.email} · {isAdmin ? "Admin" : "Member"}</div>
            </div>
            <button className="btn btn-ghost btn-block" style={{ justifyContent: "flex-start" }} onClick={() => signOut(auth)}>
              <Icon name="logout" size={16} /> Sign out
            </button>
          </div>
        </>
      )}

      <main className="page">
        {tab === "automations" && <Automations email={user.email!} onStarted={() => setTab("runs")} editId={editId} onEditOpened={() => setEditId(null)} />}
        {tab === "runs" && <Runs onEdit={(id) => { setEditId(id); setTab("automations"); }} />}
        {tab === "settings" && <Settings isAdmin={isAdmin} />}
      </main>

      <nav className="bottomnav">
        {TABS.map((t) => (
          <button key={t.id} className={tab === t.id ? "active" : ""} onClick={() => setTab(t.id)}>
            <span className="ico-wrap"><Icon name={t.icon} size={20} /></span>
            {t.label}
          </button>
        ))}
      </nav>
    </>
  );
}
