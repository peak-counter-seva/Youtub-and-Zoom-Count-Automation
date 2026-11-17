import { useEffect, useState } from "react";
import { deleteDoc, doc, getDoc, setDoc } from "firebase/firestore";
import { EmailAuthProvider, linkWithCredential, updatePassword } from "firebase/auth";
import { auth, db } from "../lib/firebase";
import { useCollection } from "../lib/hooks";
import { fmtIST } from "../lib/time";
import type { Device } from "../lib/types";

interface AllowedUser { id: string; role: "admin" | "member"; name?: string }

export default function Settings({ isAdmin }: { isAdmin: boolean }) {
  const { items: users } = useCollection<AllowedUser>("allowedUsers");
  const { items: devices } = useCollection<Device>("devices");
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"admin" | "member">("member");

  return (
    <div>
      <h2>Phones</h2>
      <div className="card">
        {devices.length === 0 && <p className="muted">No phones registered. Install the phone app and sign in on it.</p>}
        {devices.map((d) => {
          const online = d.lastSeen && Date.now() - d.lastSeen.toMillis() < 10 * 60000;
          return (
            <div className="row between" key={d.id}>
              <span>{d.label} <span className="muted small">{d.ownerEmail}</span></span>
              <span className={`badge ${online ? "running" : "stopped"}`}>{online ? "Online" : `Last seen ${fmtIST(d.lastSeen?.toDate())}`}</span>
            </div>
          );
        })}
      </div>

      <h2>Approved people</h2>
      <div className="card">
        {users.map((u) => (
          <div className="row between" key={u.id}>
            <span>{u.id} <span className="muted small">{u.role}</span></span>
            {isAdmin && <button className="link danger" onClick={() => confirm(`Remove ${u.id}?`) && deleteDoc(doc(db, "allowedUsers", u.id))}>Remove</button>}
          </div>
        ))}
        {isAdmin && (
          <div className="row">
            <input type="email" placeholder="name@gmail.com" value={email} onChange={(e) => setEmail(e.target.value)} />
            <select value={role} onChange={(e) => setRole(e.target.value as "admin" | "member")}>
              <option value="member">Member</option>
              <option value="admin">Admin</option>
            </select>
            <button className="primary" onClick={async () => {
              if (!email.includes("@")) return;
              await setDoc(doc(db, "allowedUsers", email.trim().toLowerCase()), { role });
              setEmail("");
            }}>Add</button>
          </div>
        )}
      </div>

      <PhonePassword />

      {isAdmin && <SecretSettings />}
    </div>
  );
}

function SecretSettings() {
  const [gh, setGh] = useState({ token: "", owner: "HilKalathiya", repo: "Youtub-and-Zoom-Count-Automation", workflow: "counter.yml", ref: "main" });
  const [yt, setYt] = useState({ apiKey: "" });
  const [saved, setSaved] = useState("");

  useEffect(() => {
    getDoc(doc(db, "config", "github")).then((s) => s.exists() && setGh((g) => ({ ...g, ...s.data() })));
    getDoc(doc(db, "config", "youtube")).then((s) => s.exists() && setYt((y) => ({ ...y, ...s.data() })));
  }, []);

  return (
    <>
      <h2>Counter settings (admin)</h2>
      <div className="card">
        <label>GitHub token (fine-grained, this repository only, “Actions: read and write”)
          <input type="password" value={gh.token} onChange={(e) => setGh({ ...gh, token: e.target.value })} />
        </label>
        <div className="row">
          <label>Owner<input value={gh.owner} onChange={(e) => setGh({ ...gh, owner: e.target.value })} /></label>
          <label>Repository<input value={gh.repo} onChange={(e) => setGh({ ...gh, repo: e.target.value })} /></label>
        </div>
        <label>YouTube Data API key (used by the phone backup)
          <input type="password" value={yt.apiKey} onChange={(e) => setYt({ apiKey: e.target.value })} />
        </label>
        <button className="primary" onClick={async () => {
          await setDoc(doc(db, "config", "github"), gh);
          await setDoc(doc(db, "config", "youtube"), yt);
          setSaved("Saved.");
        }}>Save</button> <span className="muted small">{saved}</span>
      </div>
    </>
  );
}

function PhonePassword() {
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const user = auth.currentUser!;
  const hasPw = user.providerData.some((p) => p.providerId === "password");
  return (
    <>
      <h2>Phone app password</h2>
      <div className="card">
        <p className="muted small">
          The phone app signs in with your email <b>{user.email}</b> and this password.
          {hasPw ? " You already have one; enter a new one to change it." : ""}
        </p>
        <div className="row">
          <input type="password" placeholder="At least 8 characters" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="primary" onClick={async () => {
            if (pw.length < 8) return setMsg("Use at least 8 characters.");
            try {
              if (hasPw) await updatePassword(user, pw);
              else await linkWithCredential(user, EmailAuthProvider.credential(user.email!, pw));
              setPw(""); setMsg("Password set. Use it in the phone app.");
            } catch (e) {
              setMsg((e as Error).message.includes("recent") ? "Please sign out and in again, then retry." : (e as Error).message);
            }
          }}>Set</button>
        </div>
        {msg && <p className="small">{msg}</p>}
      </div>
    </>
  );
}
