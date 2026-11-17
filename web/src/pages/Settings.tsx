import { useEffect, useState } from "react";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { EmailAuthProvider, linkWithCredential, updatePassword } from "firebase/auth";
import { auth, db } from "../lib/firebase";
import { useCollection } from "../lib/hooks";
import { fmtDayIST, fmtTimeIST } from "../lib/time";
import type { Device } from "../lib/types";
import { Field, Icon, useUi } from "../components/ui";

interface AllowedUser { id: string; role: "admin" | "member"; name?: string }

export default function Settings({ isAdmin }: { isAdmin: boolean }) {
  const { items: users } = useCollection<AllowedUser>("allowedUsers");
  const { items: devices } = useCollection<Device>("devices");
  const { confirm, toast } = useUi();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");
  const me = auth.currentUser?.email?.toLowerCase();

  async function addUser() {
    const e = email.trim().toLowerCase();
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) return toast("Enter a valid email address");
    await setDoc(doc(db, "allowedUsers", e), { role });
    setEmail("");
    toast(`${e} added`);
  }

  async function removeUser(id: string) {
    if (await confirm({ title: "Remove member?", body: `${id} will no longer be able to sign in.`, confirm: "Remove", danger: true })) {
      await deleteDoc(doc(db, "allowedUsers", id));
      toast("Member removed");
    }
  }

  return (
    <div>
      <div className="page-head">
        <div>
          <h1>Settings</h1>
          <p>Phones, members and connections.</p>
        </div>
      </div>

      <div className="section-title">Sender phones <span className="count">{devices.length}</span></div>
      <div className="card list">
        {devices.length === 0 && (
          <div className="list-row"><div className="grow"><div className="secondary-text" style={{ whiteSpace: "normal" }}>No phones yet. Install the Peak Counter phone app and sign in on it.</div></div></div>
        )}
        {devices.map((d) => {
          const seen = d.lastSeen?.toDate();
          const online = seen && Date.now() - seen.getTime() < 10 * 60000;
          return (
            <div className="list-row" key={d.id}>
              <div className="row-icon"><Icon name="phone" size={17} /></div>
              <div className="grow">
                <div className="primary-text">{d.label}</div>
                <div className="secondary-text">{d.ownerEmail}</div>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: online ? "var(--live)" : "var(--muted)", whiteSpace: "nowrap" }}>
                <span className={`dot ${online ? "on" : ""}`} />
                {online ? "Online" : seen ? `${fmtDayIST(seen)} ${fmtTimeIST(seen)}` : "Never"}
              </div>
            </div>
          );
        })}
      </div>

      <div className="section-title">Members <span className="count">{users.length}</span></div>
      <div className="card list">
        {users.map((u) => (
          <div className="list-row" key={u.id}>
            <div className="row-icon" style={{ borderRadius: "50%", fontWeight: 600, fontSize: 13 }}>{u.id[0]?.toUpperCase()}</div>
            <div className="grow">
              <div className="primary-text">{u.id}{u.id === me && <span className="muted" style={{ fontWeight: 400 }}> (you)</span>}</div>
              <div className="secondary-text">{u.role === "admin" ? "Admin" : "Member"}</div>
            </div>
            {isAdmin && u.id !== me && (
              <button className="btn btn-ghost btn-sm btn-icon" aria-label={`Remove ${u.id}`} onClick={() => removeUser(u.id)}>
                <Icon name="x" size={16} />
              </button>
            )}
          </div>
        ))}
        {isAdmin && (
          <div className="list-row" style={{ flexWrap: "wrap" }}>
            <input className="input" style={{ flex: "1 1 220px" }} type="email" placeholder="name@gmail.com" value={email}
              onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addUser()} />
            <div style={{ display: "flex", gap: 8, flex: "1 1 200px" }}>
              <select className="input" style={{ flex: 1 }} value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")}>
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
              <button className="btn btn-primary" style={{ height: 44 }} onClick={addUser}>Add</button>
            </div>
          </div>
        )}
      </div>

      <PhonePassword />

      {isAdmin && <SecretSettings />}
    </div>
  );
}

function SecretSettings() {
  const [gh, setGh] = useState({ token: "", owner: "peak-counter-seva", repo: "Youtub-and-Zoom-Count-Automation", workflow: "counter.yml", ref: "main" });
  const [yt, setYt] = useState({ apiKey: "" });
  const [saving, setSaving] = useState(false);
  const { toast } = useUi();

  useEffect(() => {
    getDoc(doc(db, "config", "github")).then((s) => s.exists() && setGh((g) => ({ ...g, ...s.data() })));
    getDoc(doc(db, "config", "youtube")).then((s) => s.exists() && setYt((y) => ({ ...y, ...s.data() })));
  }, []);

  return (
    <>
      <div className="section-title">Connections <span className="count">Admin only</span></div>
      <div className="card card-pad">
        <Field label="GitHub token" hint="Fine-grained token for this repository only, with Actions: read and write.">
          <input className="input" type="password" autoComplete="off" value={gh.token} onChange={(e) => setGh({ ...gh, token: e.target.value })} />
        </Field>
        <div className="field-grid stack-sm" style={{ ["--cols" as string]: 2 }}>
          <Field label="Repository owner"><input className="input" value={gh.owner} onChange={(e) => setGh({ ...gh, owner: e.target.value })} /></Field>
          <Field label="Repository name"><input className="input" value={gh.repo} onChange={(e) => setGh({ ...gh, repo: e.target.value })} /></Field>
        </div>
        <Field label="YouTube Data API key" hint="Used by the phone backup counter.">
          <input className="input" type="password" autoComplete="off" value={yt.apiKey} onChange={(e) => setYt({ apiKey: e.target.value })} />
        </Field>
        <div style={{ marginTop: 20 }}>
          <button className="btn btn-primary" disabled={saving} onClick={async () => {
            setSaving(true);
            try {
              await setDoc(doc(db, "config", "github"), gh);
              await setDoc(doc(db, "config", "youtube"), yt);
              toast("Connections saved");
            } finally { setSaving(false); }
          }}>{saving ? "Saving…" : "Save"}</button>
        </div>
      </div>
    </>
  );
}

function PhonePassword() {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const user = auth.currentUser!;
  const hasPw = user.providerData.some((p) => p.providerId === "password");

  async function submit() {
    if (pw.length < 8) return setMsg({ ok: false, text: "Use at least 8 characters." });
    try {
      if (hasPw) await updatePassword(user, pw);
      else await linkWithCredential(user, EmailAuthProvider.credential(user.email!, pw));
      setPw("");
      setMsg({ ok: true, text: "Password set. Use it to sign in on the phone app." });
    } catch (e) {
      const m = (e as Error).message;
      setMsg({ ok: false, text: m.includes("recent") ? "For safety, sign out and in again, then retry." : m });
    }
  }

  return (
    <>
      <div className="section-title">Phone app password</div>
      <div className="card card-pad">
        <p className="small" style={{ color: "var(--ink-2)", lineHeight: 1.5 }}>
          The phone app signs in with <b>{user.email}</b> and this password.{hasPw ? " You already have one; enter a new one to change it." : ""}
        </p>
        <div style={{ display: "flex", gap: 8, marginTop: 14 }}>
          <input className="input" type="password" autoComplete="new-password" placeholder="At least 8 characters" value={pw}
            onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submit()} />
          <button className="btn btn-primary" style={{ height: 44 }} onClick={submit}>{hasPw ? "Change" : "Set"}</button>
        </div>
        {msg && <p className={`inline-msg ${msg.ok ? "ok" : "err"}`}>{msg.text}</p>}
      </div>
    </>
  );
}
