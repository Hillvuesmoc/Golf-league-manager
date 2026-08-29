import React, { useState, useEffect, useMemo, useRef } from "react";
import { doc, getDoc, setDoc } from "firebase/firestore";
import { db } from "./firebase";
import { UserPlus, Trash2, Shuffle, Lock, Unlock, Copy, Check, Star, Info, Settings2, LogOut } from "lucide-react";

// ---------- Design tokens ----------
const T = {
  bg: "#F5F1E6",
  surface: "#FFFFFF",
  fairway: "#1F3D2E",
  fairwayLight: "#2F5540",
  gold: "#B8912E",
  flag: "#A83B2A",
  text: "#1E2B24",
  muted: "#6C7A70",
  line: "#DCD5C2",
  displayFont: "'Iowan Old Style','Palatino Linotype',Georgia,serif",
  bodyFont: "system-ui,-apple-system,'Segoe UI',sans-serif",
};

const CATEGORIES = [
  { key: "driving", label: "Driving", short: "DRV", hint: "Distance & accuracy off the tee" },
  { key: "approach", label: "Approach", short: "APP", hint: "Long irons / second-shot strength" },
  { key: "short", label: "Short Game", short: "SHG", hint: "Chipping & putting" },
  { key: "consistency", label: "Contact", short: "CON", hint: "Consistently makes solid contact in the intended direction" },
];

const DEFAULT_WEIGHTS = { driving: 20, approach: 20, short: 35, consistency: 25 };

const TEE_BOX_COLORS = {
  Yellow: { bg: "#E8C94A", text: "#3A2E00" },
  Green: { bg: "#3F7D4E", text: "#FFFFFF" },
  Red: { bg: "#A83B2A", text: "#FFFFFF" },
};

function teeBoxForAge(age) {
  if (age === null || age === undefined || age === "") return null;
  const n = Number(age);
  if (Number.isNaN(n)) return null;
  if (n >= 80) return "Red";
  if (n >= 65) return "Green";
  return "Yellow";
}

// ---------- Helpers ----------
const uid = () => Math.random().toString(36).slice(2, 10);
const avg = (arr) => (arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 5);
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

function overallRating(ratings, weights) {
  const totalWeight = CATEGORIES.reduce((s, c) => s + (weights[c.key] || 0), 0) || 1;
  const sum = CATEGORIES.reduce((s, c) => s + (ratings[c.key] ?? 5) * (weights[c.key] || 0), 0);
  return sum / totalWeight;
}

function computeTeamSizes(n) {
  if (n < 3) return { sizes: [], warning: n > 0 ? `Only ${n} player(s) — need at least 3.` : null };
  for (let fours = Math.floor(n / 4); fours >= 0; fours--) {
    const rem = n - fours * 4;
    if (rem % 3 === 0) {
      const threes = rem / 3;
      const sizes = [...Array(fours).fill(4), ...Array(threes).fill(3)];
      return { sizes, warning: null };
    }
  }
  const fours = Math.floor((n - 3) / 4);
  const sizes = [...Array(fours).fill(4), 3];
  const leftover = n - sizes.reduce((a, b) => a + b, 0);
  if (leftover > 0) sizes[sizes.length - 1] += leftover;
  return { sizes, warning: `${n} players doesn't split evenly into 3s/4s — one team is unbalanced. Consider a bench player or manual fix.` };
}

function scoreArrangement(teams, ratingLookup, pairHistory, topIds, weekCounter) {
  const strengths = teams.map((t) => {
    const sum = t.playerIds.reduce((a, id) => a + (ratingLookup[id] ?? 5), 0);
    return t.playerIds.length === 3 ? sum * 1.15 : sum;
  });
  const mean = avg(strengths);
  const variance = avg(strengths.map((s) => (s - mean) ** 2));

  let topPenalty = 0;
  teams.forEach((t) => {
    const count = t.playerIds.filter((id) => topIds.has(id)).length;
    if (count > 1) topPenalty += (count - 1) * 50;
  });

  let pairPenalty = 0;
  teams.forEach((t) => {
    const ids = t.playerIds;
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const hist = pairHistory[pairKey(ids[i], ids[j])];
        if (hist) {
          const weeksAgo = Math.max(0, weekCounter - hist.lastWeek);
          pairPenalty += hist.count * Math.pow(0.8, weeksAgo);
        }
      }
    }
  });

  return variance * 1.0 + topPenalty + pairPenalty * 30;
}

function TeeBadge({ age }) {
  const box = teeBoxForAge(age);
  if (!box) return null;
  const c = TEE_BOX_COLORS[box];
  return (
    <span style={{ fontSize: 10.5, fontWeight: 700, background: c.bg, color: c.text, borderRadius: 4, padding: "1px 6px", letterSpacing: 0.3 }}>
      {box.toUpperCase()}
    </span>
  );
}

function ruleNotesForTeam(team, playersById) {
  const notes = [];
  if (team.playerIds.length === 3) {
    notes.push("3-player team: one player hits twice on each hole. Rotate so every player doubles-up on every third hole, and each player's double-hit shot is used at least twice across the 9.");
  }
  const hasRedTee = team.playerIds.some((id) => teeBoxForAge(playersById[id]?.age) === "Red");
  if (hasRedTee) {
    notes.push("Red-tee player on this team: red tee shot can't count on hole 2 — use a teammate's tee shot there instead.");
  }
  return notes;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function generateTeams({ poolIds, sizes, ratingLookup, pairHistory, topIds, weekCounter }) {
  let best = null;
  let bestScore = Infinity;
  const iterations = 400;
  for (let iter = 0; iter < iterations; iter++) {
    const shuffled = shuffle(poolIds);
    let cursor = 0;
    let candidate = sizes.map((size) => {
      const playerIds = shuffled.slice(cursor, cursor + size);
      cursor += size;
      return { id: uid(), playerIds, locked: false };
    });
    for (let s = 0; s < 25; s++) {
      const ti = Math.floor(Math.random() * candidate.length);
      const tj = Math.floor(Math.random() * candidate.length);
      if (ti === tj) continue;
      const pi = Math.floor(Math.random() * candidate[ti].playerIds.length);
      const pj = Math.floor(Math.random() * candidate[tj].playerIds.length);
      const before = scoreArrangement(candidate, ratingLookup, pairHistory, topIds, weekCounter);
      const next = candidate.map((t) => ({ ...t, playerIds: [...t.playerIds] }));
      const tmp = next[ti].playerIds[pi];
      next[ti].playerIds[pi] = next[tj].playerIds[pj];
      next[tj].playerIds[pj] = tmp;
      const after = scoreArrangement(next, ratingLookup, pairHistory, topIds, weekCounter);
      if (after < before) candidate = next;
    }
    const score = scoreArrangement(candidate, ratingLookup, pairHistory, topIds, weekCounter);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }
  return best;
}

const DEFAULT_STATE = {
  players: [],
  weights: DEFAULT_WEIGHTS,
  days: {
    monday: { signups: {}, teams: null, published: false },
    tuesday: { signups: {}, teams: null, published: false },
  },
  pairHistory: {},
  weekCounter: 0,
};

// Single shared document — this app has exactly one commissioner and one league.
const STATE_DOC = doc(db, "golfLeague", "state");

const emptyRatings = () => ({ driving: 5, approach: 5, short: 5, consistency: 5 });

export default function GolfLeagueApp({ onSignOut }) {
  const [state, setState] = useState(DEFAULT_STATE);
  const [loaded, setLoaded] = useState(false);
  const [tab, setTab] = useState("roster");
  const [copyStatus, setCopyStatus] = useState("");
  const [newPlayer, setNewPlayer] = useState({ name: "", age: "", ratings: emptyRatings(), isGuest: false });
  const [saveError, setSaveError] = useState(false);
  const skipNextSave = useRef(false);

  // Load once on mount
  useEffect(() => {
    (async () => {
      try {
        const snap = await getDoc(STATE_DOC);
        if (snap.exists()) {
          const parsed = snap.data();
          skipNextSave.current = true;
          setState({ ...DEFAULT_STATE, ...parsed, weights: { ...DEFAULT_WEIGHTS, ...(parsed.weights || {}) } });
        }
      } catch (e) {
        // no existing document yet — defaults are fine, first save will create it
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  // Save on every change, after initial load
  useEffect(() => {
    if (!loaded) return;
    if (skipNextSave.current) {
      skipNextSave.current = false;
      return;
    }
    setDoc(STATE_DOC, state)
      .then(() => setSaveError(false))
      .catch(() => setSaveError(true));
  }, [state, loaded]);

  const ratingLookup = useMemo(() => {
    const map = {};
    state.players.forEach((p) => (map[p.id] = overallRating(p.ratings, state.weights)));
    return map;
  }, [state.players, state.weights]);

  const playersById = useMemo(() => {
    const map = {};
    state.players.forEach((p) => (map[p.id] = p));
    return map;
  }, [state.players]);

  const topIds = useMemo(() => new Set(state.players.filter((p) => p.isTop).map((p) => p.id)), [state.players]);

  const avgRatingsAcrossRoster = () => {
    const out = emptyRatings();
    if (state.players.length === 0) return out;
    CATEGORIES.forEach((c) => {
      out[c.key] = Math.round(avg(state.players.map((p) => p.ratings[c.key] ?? 5)));
    });
    return out;
  };

  const addPlayer = () => {
    if (!newPlayer.name.trim()) return;
    const ratings = newPlayer.isGuest ? avgRatingsAcrossRoster() : newPlayer.ratings;
    setState((s) => ({
      ...s,
      players: [...s.players, { id: uid(), name: newPlayer.name.trim(), age: newPlayer.age === "" ? null : Number(newPlayer.age), ratings, isGuest: newPlayer.isGuest, isTop: false }],
    }));
    setNewPlayer({ name: "", age: "", ratings: emptyRatings(), isGuest: false });
  };

  const removePlayer = (id) => {
    setState((s) => ({
      ...s,
      players: s.players.filter((p) => p.id !== id),
      days: Object.fromEntries(
        Object.entries(s.days).map(([k, d]) => [k, { ...d, signups: Object.fromEntries(Object.entries(d.signups).filter(([pid]) => pid !== id)) }])
      ),
    }));
  };

  const updatePlayerRating = (id, categoryKey, value) => {
    setState((s) => ({
      ...s,
      players: s.players.map((p) => (p.id === id ? { ...p, ratings: { ...p.ratings, [categoryKey]: Number(value) } } : p)),
    }));
  };

  const updatePlayer = (id, patch) => {
    setState((s) => ({ ...s, players: s.players.map((p) => (p.id === id ? { ...p, ...patch } : p)) }));
  };

  const updateWeight = (key, value) => {
    setState((s) => ({ ...s, weights: { ...s.weights, [key]: Number(value) } }));
  };

  const toggleSignup = (day, playerId) => {
    setState((s) => ({
      ...s,
      days: { ...s.days, [day]: { ...s.days[day], signups: { ...s.days[day].signups, [playerId]: !s.days[day].signups[playerId] } } },
    }));
  };

  const playingIds = (day) => Object.entries(state.days[day].signups).filter(([, v]) => v).map(([k]) => k);

  const runGenerate = (day) => {
    const dayState = state.days[day];
    const lockedTeams = (dayState.teams || []).filter((t) => t.locked);
    const lockedPlayerIds = new Set(lockedTeams.flatMap((t) => t.playerIds));
    const pool = playingIds(day).filter((id) => !lockedPlayerIds.has(id));
    const { sizes, warning } = computeTeamSizes(pool.length);
    const generated = pool.length > 0 ? generateTeams({ poolIds: pool, sizes, ratingLookup, pairHistory: state.pairHistory, topIds, weekCounter: state.weekCounter }) : [];
    const newTeams = [...lockedTeams, ...(generated || [])];
    setState((s) => ({ ...s, days: { ...s.days, [day]: { ...s.days[day], teams: newTeams, published: false, warning } } }));
  };

  const toggleLock = (day, teamId) => {
    setState((s) => ({
      ...s,
      days: { ...s.days, [day]: { ...s.days[day], teams: s.days[day].teams.map((t) => (t.id === teamId ? { ...t, locked: !t.locked } : t)) } },
    }));
  };

  const movePlayer = (day, playerId, fromTeamId, toTeamId) => {
    if (fromTeamId === toTeamId) return;
    setState((s) => {
      const teams = s.days[day].teams.map((t) => ({ ...t, playerIds: [...t.playerIds] }));
      const from = teams.find((t) => t.id === fromTeamId);
      const to = teams.find((t) => t.id === toTeamId);
      from.playerIds = from.playerIds.filter((id) => id !== playerId);
      to.playerIds.push(playerId);
      return { ...s, days: { ...s.days, [day]: { ...s.days[day], teams } } };
    });
  };

  const publish = (day) => {
    setState((s) => {
      const teams = s.days[day].teams || [];
      const pairHistory = { ...s.pairHistory };
      teams.forEach((t) => {
        for (let i = 0; i < t.playerIds.length; i++) {
          for (let j = i + 1; j < t.playerIds.length; j++) {
            const key = pairKey(t.playerIds[i], t.playerIds[j]);
            const existing = pairHistory[key];
            pairHistory[key] = { count: (existing?.count || 0) + 1, lastWeek: s.weekCounter };
          }
        }
      });
      return { ...s, pairHistory, weekCounter: s.weekCounter + 1, days: { ...s.days, [day]: { ...s.days[day], published: true } } };
    });
  };

  const teamStrength = (team) => {
    const sum = team.playerIds.reduce((a, id) => a + (ratingLookup[id] ?? 5), 0);
    return Math.round(sum * 10) / 10;
  };

  const teamWarnings = (team, allTeams) => {
    const warnings = [];
    const topCount = team.playerIds.filter((id) => topIds.has(id)).length;
    if (topCount > 1) warnings.push(`Contains ${topCount} of your flagged top players`);
    for (let i = 0; i < team.playerIds.length; i++) {
      for (let j = i + 1; j < team.playerIds.length; j++) {
        const hist = state.pairHistory[pairKey(team.playerIds[i], team.playerIds[j])];
        if (hist && hist.count >= 3) {
          const a = playersById[team.playerIds[i]]?.name;
          const b = playersById[team.playerIds[j]]?.name;
          warnings.push(`${a} & ${b} have played together ${hist.count}x this season`);
        }
      }
    }
    if (allTeams.length > 1) {
      const strengths = allTeams.map(teamStrength);
      const mean = avg(strengths);
      const s = teamStrength(team);
      if (Math.abs(s - mean) > mean * 0.18) warnings.push("Noticeably off from average team strength");
    }
    return warnings;
  };

  const formatTeamsText = (day) => {
    const label = day[0].toUpperCase() + day.slice(1);
    const teams = state.days[day].teams || [];
    let out = `${label.toUpperCase()} SCRAMBLE\n\n`;
    teams.forEach((t, idx) => {
      out += `TEAM ${idx + 1}${t.playerIds.length === 3 ? " (3-player — rotate double-hit each hole)" : ""}\n`;
      t.playerIds.forEach((id) => {
        const box = teeBoxForAge(playersById[id]?.age);
        out += `${playersById[id]?.name || "?"}${box ? ` (${box})` : ""}\n`;
      });
      out += "\n";
    });
    return out.trim();
  };

  const copyTeams = async (day) => {
    const text = formatTeamsText(day);
    try {
      await navigator.clipboard.writeText(text);
      setCopyStatus(day);
      setTimeout(() => setCopyStatus(""), 1800);
    } catch (e) {
      setCopyStatus("error");
    }
  };

  return (
    <div style={{ fontFamily: T.bodyFont, background: T.bg, minHeight: "100vh", color: T.text, padding: "0 0 32px" }}>
      <style>{`
        * { box-sizing: border-box; }
        .glm-btn { cursor:pointer; border:none; border-radius:8px; padding:9px 14px; font-family:${T.bodyFont}; font-size:14px; font-weight:600; display:inline-flex; align-items:center; gap:6px; transition: transform .1s ease, opacity .15s ease; }
        .glm-btn:active { transform: scale(0.97); }
        .glm-btn:disabled { opacity:.45; cursor:not-allowed; }
        .glm-input { font-family:${T.bodyFont}; border:1px solid ${T.line}; border-radius:7px; padding:8px 10px; font-size:14px; background:${T.surface}; color:${T.text}; }
        .glm-input:focus { outline:2px solid ${T.gold}; outline-offset:1px; }
        .glm-tab { cursor:pointer; padding:10px 14px; border:none; background:none; font-family:${T.bodyFont}; font-size:13.5px; font-weight:600; color:${T.muted}; border-bottom:2px solid transparent; }
        .glm-tab.active { color:${T.fairway}; border-bottom:2px solid ${T.gold}; }
        .glm-card { background:${T.surface}; border:1px solid ${T.line}; border-radius:10px; }
        select.glm-input { -webkit-appearance:none; appearance:none; }
        .cat-slider { width:100%; accent-color:${T.fairway}; }
      `}</style>

      <div style={{ background: T.fairway, color: "#fff", padding: "22px 20px 20px", display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div>
          <div style={{ fontFamily: T.displayFont, fontSize: 22, letterSpacing: 0.3 }}>Fair Teams. New Partners. Every Week.</div>
          <div style={{ fontSize: 12.5, color: "#CBD9CF", marginTop: 3 }}>Golf League Team Manager</div>
        </div>
        <button className="glm-btn" style={{ background: "rgba(255,255,255,0.12)", color: "#fff", padding: "6px 10px", fontSize: 12.5 }} onClick={onSignOut}>
          <LogOut size={13} /> Sign out
        </button>
      </div>

      {saveError && (
        <div style={{ background: "#FBEFEA", color: T.flag, padding: "8px 20px", fontSize: 12.5 }}>
          Couldn't save your last change — check your connection. Your data hasn't synced yet.
        </div>
      )}

      <div style={{ display: "flex", borderBottom: `1px solid ${T.line}`, background: T.surface, position: "sticky", top: 0, zIndex: 5, overflowX: "auto" }}>
        {[
          ["roster", "Roster"],
          ["monday", "Monday"],
          ["tuesday", "Tuesday"],
          ["history", "History"],
          ["rules", "Rules"],
        ].map(([key, label]) => (
          <button key={key} className={`glm-tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
            {label}
          </button>
        ))}
      </div>

      <div style={{ padding: 16 }}>
        {tab === "roster" && (
          <RosterTab
            players={state.players}
            weights={state.weights}
            updateWeight={updateWeight}
            addPlayer={addPlayer}
            removePlayer={removePlayer}
            updatePlayer={updatePlayer}
            updatePlayerRating={updatePlayerRating}
            newPlayer={newPlayer}
            setNewPlayer={setNewPlayer}
            ratingLookup={ratingLookup}
          />
        )}
        {(tab === "monday" || tab === "tuesday") && (
          <DayTab
            day={tab}
            state={state}
            playersById={playersById}
            ratingLookup={ratingLookup}
            topIds={topIds}
            toggleSignup={toggleSignup}
            runGenerate={runGenerate}
            toggleLock={toggleLock}
            movePlayer={movePlayer}
            publish={publish}
            teamStrength={teamStrength}
            teamWarnings={teamWarnings}
            copyTeams={copyTeams}
            copyStatus={copyStatus}
            formatTeamsText={formatTeamsText}
          />
        )}
        {tab === "history" && <HistoryTab pairHistory={state.pairHistory} playersById={playersById} />}
        {tab === "rules" && <RulesTab />}
      </div>
    </div>
  );
}

function WeightSettings({ weights, updateWeight }) {
  const [open, setOpen] = useState(false);
  const total = CATEGORIES.reduce((s, c) => s + (weights[c.key] || 0), 0) || 1;
  return (
    <div className="glm-card" style={{ padding: 14, marginBottom: 16 }}>
      <button className="glm-btn" style={{ background: "none", padding: 0, color: T.fairway, fontSize: 14 }} onClick={() => setOpen((o) => !o)}>
        <Settings2 size={15} /> How much each skill counts {open ? "▲" : "▼"}
      </button>
      {open && (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          {CATEGORIES.map((c) => (
            <div key={c.key}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12.5, marginBottom: 3 }}>
                <span style={{ fontWeight: 600 }}>{c.label}</span>
                <span style={{ color: T.muted }}>{Math.round(((weights[c.key] || 0) / total) * 100)}%</span>
              </div>
              <input className="cat-slider" type="range" min={0} max={100} value={weights[c.key] || 0} onChange={(e) => updateWeight(c.key, e.target.value)} />
            </div>
          ))}
          <div style={{ fontSize: 11.5, color: T.muted }}>Percentages are relative to each other — they don't need to add to 100.</div>
        </div>
      )}
    </div>
  );
}

function RosterTab({ players, weights, updateWeight, addPlayer, removePlayer, updatePlayer, updatePlayerRating, newPlayer, setNewPlayer, ratingLookup }) {
  const [expandedId, setExpandedId] = useState(null);

  return (
    <div>
      <WeightSettings weights={weights} updateWeight={updateWeight} />

      <div className="glm-card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: T.fairway }}>Add a player</div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: newPlayer.isGuest ? 0 : 10 }}>
          <input
            className="glm-input"
            placeholder="Name"
            value={newPlayer.name}
            onChange={(e) => setNewPlayer((n) => ({ ...n, name: e.target.value }))}
            style={{ flex: "1 1 140px" }}
          />
          <input
            className="glm-input"
            type="number"
            placeholder="Age"
            min={1}
            max={110}
            value={newPlayer.age}
            onChange={(e) => setNewPlayer((n) => ({ ...n, age: e.target.value }))}
            style={{ width: 64 }}
          />
          <label style={{ fontSize: 13, display: "flex", alignItems: "center", gap: 5, color: T.muted }}>
            <input type="checkbox" checked={newPlayer.isGuest} onChange={(e) => setNewPlayer((n) => ({ ...n, isGuest: e.target.checked }))} />
            Guest (auto-rated to roster average)
          </label>
        </div>
        {newPlayer.age !== "" && (
          <div style={{ fontSize: 11.5, color: T.muted, marginBottom: 10, display: "flex", alignItems: "center", gap: 6 }}>
            Tee box: <TeeBadge age={newPlayer.age} />
          </div>
        )}
        {!newPlayer.isGuest && (
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10 }}>
            {CATEGORIES.map((c) => (
              <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span style={{ fontSize: 11.5, width: 34, color: T.muted, fontWeight: 700 }}>{c.short}</span>
                <input
                  className="glm-input"
                  type="number"
                  min={1}
                  max={10}
                  value={newPlayer.ratings[c.key]}
                  onChange={(e) => setNewPlayer((n) => ({ ...n, ratings: { ...n.ratings, [c.key]: Number(e.target.value) } }))}
                  style={{ width: 54 }}
                />
              </div>
            ))}
          </div>
        )}
        <button className="glm-btn" style={{ background: T.fairway, color: "#fff" }} onClick={addPlayer}>
          <UserPlus size={15} /> Add player
        </button>
      </div>

      <div style={{ fontSize: 12.5, color: T.muted, marginBottom: 8 }}>{players.length} players · tap a name to edit their skills · star flags a top player to separate</div>

      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {players
          .slice()
          .sort((a, b) => (ratingLookup[b.id] ?? 5) - (ratingLookup[a.id] ?? 5))
          .map((p) => (
            <div key={p.id} className="glm-card" style={{ padding: "9px 12px" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                <button
                  className="glm-btn"
                  style={{ background: "none", padding: 4, color: p.isTop ? T.gold : "#D8D2C0" }}
                  onClick={() => updatePlayer(p.id, { isTop: !p.isTop })}
                  title="Flag as top player"
                >
                  <Star size={16} fill={p.isTop ? T.gold : "none"} />
                </button>
                <div style={{ flex: 1, fontWeight: 600, fontSize: 14, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }} onClick={() => setExpandedId(expandedId === p.id ? null : p.id)}>
                  {p.name} {p.isGuest && <span style={{ fontSize: 11, color: T.muted, fontWeight: 500 }}>(guest)</span>}
                  <TeeBadge age={p.age} />
                </div>
                <div style={{ fontSize: 13, fontWeight: 700, color: T.fairway }}>{(ratingLookup[p.id] ?? 5).toFixed(1)}</div>
                <button className="glm-btn" style={{ background: "none", color: T.flag, padding: 4 }} onClick={() => removePlayer(p.id)}>
                  <Trash2 size={15} />
                </button>
              </div>
              {expandedId === p.id && (
                <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginTop: 10, paddingTop: 10, borderTop: `1px solid ${T.line}` }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, gridColumn: "1 / -1" }}>
                    <span style={{ fontSize: 11.5, width: 34, color: T.muted, fontWeight: 700 }}>AGE</span>
                    <input
                      className="glm-input"
                      type="number"
                      min={1}
                      max={110}
                      value={p.age ?? ""}
                      onChange={(e) => updatePlayer(p.id, { age: e.target.value === "" ? null : Number(e.target.value) })}
                      style={{ width: 64 }}
                    />
                    <span style={{ fontSize: 11, color: T.muted }}>sets tee box automatically</span>
                  </div>
                  {CATEGORIES.map((c) => (
                    <div key={c.key} style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 11.5, width: 34, color: T.muted, fontWeight: 700 }} title={c.hint}>
                        {c.short}
                      </span>
                      <input
                        className="glm-input"
                        type="number"
                        min={1}
                        max={10}
                        value={p.ratings[c.key] ?? 5}
                        onChange={(e) => updatePlayerRating(p.id, c.key, e.target.value)}
                        style={{ width: 54 }}
                      />
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        {players.length === 0 && <div style={{ color: T.muted, fontSize: 13.5, padding: 8 }}>No players yet — add your regulars above.</div>}
      </div>
    </div>
  );
}

function DayTab({ day, state, playersById, ratingLookup, topIds, toggleSignup, runGenerate, toggleLock, movePlayer, publish, teamStrength, teamWarnings, copyTeams, copyStatus, formatTeamsText }) {
  const dayState = state.days[day];
  const teams = dayState.teams || [];
  const playingCount = Object.values(dayState.signups).filter(Boolean).length;

  return (
    <div>
      <div className="glm-card" style={{ padding: 14, marginBottom: 16 }}>
        <div style={{ fontWeight: 700, fontSize: 14, marginBottom: 10, color: T.fairway, display: "flex", justifyContent: "space-between" }}>
          <span>Who's playing {day[0].toUpperCase() + day.slice(1)}?</span>
          <span style={{ color: T.muted, fontWeight: 500 }}>{playingCount} confirmed</span>
        </div>
        <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
          {state.players.map((p) => {
            const checked = !!dayState.signups[p.id];
            return (
              <label
                key={p.id}
                style={{
                  fontSize: 13,
                  padding: "6px 10px",
                  borderRadius: 20,
                  border: `1px solid ${checked ? T.fairway : T.line}`,
                  background: checked ? T.fairway : T.surface,
                  color: checked ? "#fff" : T.text,
                  display: "flex",
                  alignItems: "center",
                  gap: 6,
                  cursor: "pointer",
                }}
              >
                <input type="checkbox" checked={checked} onChange={() => toggleSignup(day, p.id)} style={{ display: "none" }} />
                {p.name}
              </label>
            );
          })}
          {state.players.length === 0 && <div style={{ color: T.muted, fontSize: 13 }}>Add players in the Roster tab first.</div>}
        </div>
      </div>

      <button className="glm-btn" style={{ background: T.gold, color: "#fff", width: "100%", justifyContent: "center", padding: "11px 14px", fontSize: 15, marginBottom: 14 }} onClick={() => runGenerate(day)} disabled={playingCount < 3}>
        <Shuffle size={16} /> {teams.length ? "Regenerate unlocked teams" : "Generate Teams"}
      </button>

      {dayState.warning && (
        <div style={{ background: "#FBEFEA", border: `1px solid ${T.flag}33`, color: T.flag, padding: "8px 12px", borderRadius: 8, fontSize: 13, marginBottom: 12, display: "flex", gap: 6 }}>
          <Info size={15} style={{ flexShrink: 0, marginTop: 1 }} /> {dayState.warning}
        </div>
      )}

      {teams.length > 0 && (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {teams.map((t, idx) => {
            const warnings = teamWarnings(t, teams);
            return (
              <div key={t.id} className="glm-card" style={{ padding: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ fontFamily: T.displayFont, fontSize: 16, color: T.fairway }}>
                    Team {idx + 1} {t.playerIds.length === 3 && <span style={{ fontSize: 11, background: T.gold, color: "#fff", borderRadius: 5, padding: "2px 6px", marginLeft: 6, fontFamily: T.bodyFont, fontWeight: 700 }}>3-PLAYER · ROTATE SHOT</span>}
                  </div>
                  <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                    <span style={{ fontSize: 12.5, color: T.muted }}>Strength {teamStrength(t)}</span>
                    <button className="glm-btn" style={{ background: t.locked ? T.fairway : "#EFEAD8", color: t.locked ? "#fff" : T.muted, padding: "5px 8px" }} onClick={() => toggleLock(day, t.id)}>
                      {t.locked ? <Lock size={13} /> : <Unlock size={13} />}
                    </button>
                  </div>
                </div>
                {t.playerIds.map((pid) => (
                  <div key={pid} style={{ display: "flex", alignItems: "center", gap: 8, padding: "4px 0" }}>
                    {topIds.has(pid) && <Star size={12} fill={T.gold} color={T.gold} />}
                    <span style={{ flex: 1, fontSize: 14, display: "flex", alignItems: "center", gap: 6 }}>
                      {playersById[pid]?.name}
                      <TeeBadge age={playersById[pid]?.age} />
                    </span>
                    <select
                      className="glm-input"
                      style={{ fontSize: 12, padding: "3px 6px" }}
                      value={t.id}
                      disabled={t.locked}
                      onChange={(e) => movePlayer(day, pid, t.id, e.target.value)}
                    >
                      {teams.map((tt, i) => (
                        <option key={tt.id} value={tt.id} disabled={tt.locked && tt.id !== t.id}>
                          Team {i + 1}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
                {ruleNotesForTeam(t, playersById).map((note, i) => (
                  <div key={`note-${i}`} style={{ marginTop: i === 0 ? 8 : 4, fontSize: 12, color: T.fairwayLight, display: "flex", gap: 5, alignItems: "flex-start", borderTop: i === 0 ? `1px solid ${T.line}` : "none", paddingTop: i === 0 ? 6 : 0 }}>
                    <Info size={12} style={{ marginTop: 2, flexShrink: 0 }} /> {note}
                  </div>
                ))}
                {warnings.length > 0 && (
                  <div style={{ marginTop: 8, borderTop: `1px solid ${T.line}`, paddingTop: 6 }}>
                    {warnings.map((w, i) => (
                      <div key={i} style={{ fontSize: 12, color: T.flag, display: "flex", gap: 5, alignItems: "flex-start" }}>
                        <Info size={12} style={{ marginTop: 2, flexShrink: 0 }} /> {w}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}

      {teams.length > 0 && (
        <div style={{ display: "flex", gap: 8, marginTop: 14, flexWrap: "wrap" }}>
          <button className="glm-btn" style={{ background: T.fairway, color: "#fff", flex: 1, justifyContent: "center" }} onClick={() => publish(day)}>
            <Check size={15} /> {dayState.published ? "Published" : "Publish Teams"}
          </button>
          <button className="glm-btn" style={{ background: "#EFEAD8", color: T.fairway, flex: 1, justifyContent: "center" }} onClick={() => copyTeams(day)}>
            <Copy size={15} /> {copyStatus === day ? "Copied!" : "Copy for GroupMe"}
          </button>
        </div>
      )}

      {teams.length > 0 && (
        <pre style={{ marginTop: 12, background: "#FCFAF3", border: `1px dashed ${T.line}`, borderRadius: 8, padding: 12, fontSize: 12.5, whiteSpace: "pre-wrap", color: T.text, fontFamily: T.bodyFont }}>
          {formatTeamsText(day)}
        </pre>
      )}
    </div>
  );
}

function RuleSection({ title, children }) {
  return (
    <div className="glm-card" style={{ padding: 12, marginBottom: 10 }}>
      <div style={{ fontWeight: 700, fontSize: 13.5, color: T.fairway, marginBottom: 6 }}>{title}</div>
      <div style={{ fontSize: 13, color: T.text, lineHeight: 1.5 }}>{children}</div>
    </div>
  );
}

function RulesTab() {
  return (
    <div>
      <div style={{ fontSize: 13, color: T.muted, marginBottom: 10 }}>League scramble rules — reference for you and your players.</div>

      <RuleSection title="Tee box by age">
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TeeBadge age={40} /> <span>Men 64 and younger</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TeeBadge age={70} /> <span>Men 65–79</span>
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <TeeBadge age={85} /> <span>Men 80 and older — cannot use the red tee shot on hole 2</span>
          </div>
        </div>
      </RuleSection>

      <RuleSection title="Tee shots">
        Every team must use at least one tee shot from each player, including on par 3s.
      </RuleSection>

      <RuleSection title="3-player teams">
        One player hits twice on each hole, rotating so every player doubles up on every third hole. Each player's double-hit shot must be used at least twice across the 9 holes.
      </RuleSection>

      <RuleSection title="Gimmes">
        Any putt inside the length of a standard putter's grip is a gimme.
      </RuleSection>

      <RuleSection title="Improving lie">
        Teams may improve their lie one club-length, no closer to the pin. Lies cannot be improved from rough into fairway.
      </RuleSection>

      <RuleSection title="Bunkers">
        Teams must play out of freshly-raked bunkers. If a bunker hasn't been raked, the ball may be moved out and placed behind the bunker.
      </RuleSection>

      <RuleSection title="Tiebreakers">
        Ties are broken by a scorecard playoff, starting with the best score on hole 9 and working backward.
      </RuleSection>
    </div>
  );
}

function HistoryTab({ pairHistory, playersById }) {
  const rows = Object.entries(pairHistory)
    .map(([key, v]) => {
      const [a, b] = key.split("|");
      return { a: playersById[a]?.name || "?", b: playersById[b]?.name || "?", ...v };
    })
    .sort((x, y) => y.count - x.count);

  return (
    <div>
      <div style={{ fontSize: 13, color: T.muted, marginBottom: 10 }}>Pairing history builds up each time you publish teams.</div>
      {rows.length === 0 && <div style={{ color: T.muted, fontSize: 13.5 }}>No published weeks yet.</div>}
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {rows.map((r, i) => (
          <div key={i} className="glm-card" style={{ padding: "9px 12px", display: "flex", justifyContent: "space-between", fontSize: 13.5 }}>
            <span>
              {r.a} + {r.b}
            </span>
            <span style={{ color: T.muted }}>{r.count}×</span>
          </div>
        ))}
      </div>
    </div>
  );
}
