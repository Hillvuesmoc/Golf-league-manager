import { useEffect, useState } from "react";
import { onAuthStateChanged, signInWithEmailAndPassword, signOut } from "firebase/auth";
import { auth } from "./firebase";
import GolfLeagueApp from "./GolfLeagueApp";

const T = { bg: "#F5F1E6", fairway: "#1F3D2E", flag: "#A83B2A", line: "#DCD5C2", muted: "#6C7A70" };

export default function App() {
  const [user, setUser] = useState(undefined); // undefined = checking, null = logged out
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => onAuthStateChanged(auth, setUser), []);

  const handleLogin = async (e) => {
    e.preventDefault();
    setError("");
    setSubmitting(true);
    try {
      await signInWithEmailAndPassword(auth, email, password);
    } catch (err) {
      setError("Incorrect email or password.");
    } finally {
      setSubmitting(false);
    }
  };

  if (user === undefined) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", color: T.muted, fontFamily: "system-ui" }}>
        Loading…
      </div>
    );
  }

  if (!user) {
    return (
      <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: T.bg, fontFamily: "system-ui" }}>
        <form
          onSubmit={handleLogin}
          style={{ background: "#fff", padding: 28, borderRadius: 12, width: "min(320px, 90vw)", boxShadow: "0 4px 20px rgba(0,0,0,0.08)", boxSizing: "border-box" }}
        >
          <div style={{ fontFamily: "'Iowan Old Style',Georgia,serif", fontSize: 20, color: T.fairway, marginBottom: 4 }}>Commissioner Login</div>
          <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 16 }}>This tool is for league admin use only.</div>
          <input
            type="email"
            placeholder="Email"
            autoComplete="username"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            style={inputStyle}
            required
          />
          <input
            type="password"
            placeholder="Password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            style={inputStyle}
            required
          />
          {error && <div style={{ color: T.flag, fontSize: 13, marginBottom: 10 }}>{error}</div>}
          <button type="submit" disabled={submitting} style={btnStyle}>
            {submitting ? "Logging in…" : "Log In"}
          </button>
        </form>
      </div>
    );
  }

  return <GolfLeagueApp onSignOut={() => signOut(auth)} />;
}

const inputStyle = {
  display: "block",
  width: "100%",
  padding: 10,
  marginBottom: 10,
  border: `1px solid ${T.line}`,
  borderRadius: 7,
  fontSize: 14,
  boxSizing: "border-box",
  fontFamily: "system-ui",
};

const btnStyle = {
  width: "100%",
  padding: 11,
  background: T.fairway,
  color: "#fff",
  border: "none",
  borderRadius: 8,
  fontWeight: 600,
  fontSize: 14,
  cursor: "pointer",
};
