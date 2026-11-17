import { useState } from "react";
import { signInWithPopup, signOut } from "firebase/auth";
import { auth, googleProvider } from "./lib/firebase";
import { useDocument, useUser } from "./lib/hooks";
import Automations from "./pages/Automations";
import Runs from "./pages/Runs";
import Settings from "./pages/Settings";

type Tab = "automations" | "runs" | "settings";

interface Allowed { id: string; role: "admin" | "member" }

export default function App() {
  const user = useUser();
  const allowed = useDocument<Allowed>("allowedUsers", user?.email?.toLowerCase() ?? null);
  const [tab, setTab] = useState<Tab>("automations");

  if (user === undefined) return <div className="center">Loading…</div>;

  if (!user)
    return (
      <div className="center card login">
        <h1>Peak Counter</h1>
        <p>Counts the highest YouTube and Zoom viewers and sends them by SMS.</p>
        <button className="primary" onClick={() => signInWithPopup(auth, googleProvider)}>
          Sign in with Google
        </button>
      </div>
    );

  if (allowed === undefined) return <div className="center">Checking access…</div>;

  if (!allowed)
    return (
      <div className="center card login">
        <h1>Not approved yet</h1>
        <p>
          <b>{user.email}</b> is not on the approved list. Ask the admin to add this email in
          Settings.
        </p>
        <button onClick={() => signOut(auth)}>Sign out</button>
      </div>
    );

  const isAdmin = allowed.role === "admin";

  return (
    <div className="app">
      <header>
        <strong>Peak Counter</strong>
        <span className="muted small">{user.email}</span>
        <button className="link" onClick={() => signOut(auth)}>Sign out</button>
      </header>
      <nav>
        {(["automations", "runs", "settings"] as Tab[]).map((t) => (
          <button key={t} className={tab === t ? "active" : ""} onClick={() => setTab(t)}>
            {t === "automations" ? "Automations" : t === "runs" ? "Runs" : "Settings"}
          </button>
        ))}
      </nav>
      <main>
        {tab === "automations" && <Automations email={user.email!} onStarted={() => setTab("runs")} />}
        {tab === "runs" && <Runs />}
        {tab === "settings" && <Settings isAdmin={isAdmin} />}
      </main>
    </div>
  );
}
