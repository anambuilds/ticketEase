import { AnimatePresence, motion } from "framer-motion";
import {
  Bell,
  Bus,
  Car,
  CalendarClock,
  Check,
  ChevronLeft,
  CircleDot,
  LayoutDashboard,
  LogOut,
  Moon,
  Route,
  Search,
  ShieldCheck,
  Sun,
  Ticket,
  Users,
  WalletCards
} from "lucide-react";
import React, { useEffect, useState } from "react";
import { io } from "socket.io-client";
import { api, getAccessToken, setTokens, SOCKET_URL } from "./api";

const DEMO_ACCOUNTS = [
  ["Student", "student@amity.edu"],
  ["Female student", "female@amity.edu"],
  ["Admin", "admin@amity.edu"]
];

function formatTime(value) {
  return new Intl.DateTimeFormat("en-IN", { hour: "2-digit", minute: "2-digit", hour12: true }).format(new Date(value));
}

function formatDate(value) {
  return new Intl.DateTimeFormat("en-IN", { weekday: "short", day: "numeric", month: "short" }).format(new Date(value));
}

function countdownTo(value) {
  const diff = new Date(value).getTime() - Date.now();
  if (diff <= 0) return "open now";
  const minutes = Math.floor(diff / 60_000);
  const seconds = Math.floor((diff % 60_000) / 1000);
  if (minutes >= 60) return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
  return `${minutes}m ${seconds.toString().padStart(2, "0")}s`;
}

function bookingState(schedule) {
  const now = Date.now();
  if (now < new Date(schedule.bookingOpenAt).getTime()) return "locked";
  if (now >= new Date(schedule.departureAt).getTime()) return "departed";
  return "open";
}

function adjacentFemaleSeatIds(seats) {
  const femaleNumbers = new Set(seats.filter((seat) => seat.status === "booked" && seat.passengerGender === "female").map((seat) => seat.number));
  const neighborNumbers = (seat) => {
    if (seat.col === 0) return [seat.number + 1];
    if (seat.col === 1) return [seat.number - 1];
    if (seat.col === 2) return [seat.number + 1];
    return [seat.number - 1];
  };
  return new Set(
    seats
      .filter((seat) => seat.status === "available")
      .filter((seat) => neighborNumbers(seat).some((number) => femaleNumbers.has(number)))
      .map((seat) => seat.id)
  );
}

export default function App() {
  const [dark, setDark] = useState(() => localStorage.getItem("theme") === "dark");
  const [user, setUser] = useState(null);
  const [notifications, setNotifications] = useState([]);
  const [locations, setLocations] = useState([]);
  const [schedules, setSchedules] = useState([]);
  const [selectedScheduleId, setSelectedScheduleId] = useState(null);
  const [view, setView] = useState("buses");
  const [toast, setToast] = useState("");
  const [socket, setSocket] = useState(null);
  const [profileOpen, setProfileOpen] = useState(false);

  useEffect(() => {
    document.documentElement.dataset.theme = dark ? "dark" : "light";
    localStorage.setItem("theme", dark ? "dark" : "light");
  }, [dark]);

  useEffect(() => {
    api("/locations").then((data) => setLocations(data.locations)).catch(showToast);
    api("/schedules").then((data) => setSchedules(data.schedules)).catch(showToast);
    if (getAccessToken()) {
      api("/me")
        .then((data) => {
          setUser(data.user);
          setNotifications(data.notifications || []);
        })
        .catch(() => setTokens(null));
    }
  }, []);

  useEffect(() => {
    const nextSocket = io(SOCKET_URL, { auth: { token: getAccessToken() } });
    nextSocket.on("schedule:update", (schedule) => {
      setSchedules((items) => items.map((item) => (item.id === schedule.id ? schedule : item)));
    });
    nextSocket.on("notifications:update", setNotifications);
    setSocket(nextSocket);
    return () => nextSocket.close();
  }, [user?.id]);

  function showToast(errorOrMessage) {
    const message = errorOrMessage instanceof Error ? errorOrMessage.message : errorOrMessage;
    setToast(message);
    window.setTimeout(() => setToast(""), 3200);
  }

  function handleAuth(data) {
    setTokens(data);
    setUser(data.user);
    setView("buses");
    showToast(`Welcome, ${data.user.name}.`);
  }

  function logout() {
    setTokens(null);
    setUser(null);
    setNotifications([]);
    setSelectedScheduleId(null);
    setView("landing");
  }

  return (
    <div className="app-shell">
      {!user ? (
        <PublicExperience
          view={view}
          setView={setView}
          dark={dark}
          setDark={setDark}
          onAuth={handleAuth}
          showToast={showToast}
        />
      ) : (
        <DashboardExperience
          user={user}
          view={view}
          setView={setView}
          dark={dark}
          setDark={setDark}
          notifications={notifications}
          profileOpen={profileOpen}
          setProfileOpen={setProfileOpen}
          logout={logout}
          locations={locations}
          schedules={schedules}
          setSchedules={setSchedules}
          selectedScheduleId={selectedScheduleId}
          setSelectedScheduleId={setSelectedScheduleId}
          socket={socket}
          showToast={showToast}
        />
      )}

      <AnimatePresence>
        {toast && (
          <motion.div className="toast" initial={{ opacity: 0, y: 20 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
            {toast}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function PublicExperience({ view, setView, dark, setDark, onAuth, showToast }) {
  return (
    <>
      <header className="topbar public-topbar">
        <button className="brand" onClick={() => setView("landing")}>
          <span className="brand-mark"><Bus size={20} /></span>
          <span>TicketEase</span>
        </button>
        <div className="top-actions">
          <button className="icon-button" title="Toggle theme" onClick={() => setDark(!dark)}>
            {dark ? <Sun size={18} /> : <Moon size={18} />}
          </button>
          <button className="primary small" onClick={() => setView("auth")}>Sign in</button>
        </div>
      </header>
      <main>
        <AnimatePresence mode="wait">
          {view === "auth" ? (
            <AuthView key="auth" onAuth={onAuth} showToast={showToast} />
          ) : (
            <LandingView key="landing" onStart={() => setView("auth")} />
          )}
        </AnimatePresence>
      </main>
    </>
  );
}

function DashboardExperience({
  user,
  view,
  setView,
  dark,
  setDark,
  notifications,
  profileOpen,
  setProfileOpen,
  logout,
  locations,
  schedules,
  setSchedules,
  selectedScheduleId,
  setSelectedScheduleId,
  socket,
  showToast
}) {
  function go(nextView) {
    setSelectedScheduleId(null);
    setView(nextView);
  }

  const title = selectedScheduleId ? "Seat booking" : view === "admin" ? "Admin" : view === "waitlist" ? "Waitlist" : view === "rides" ? "Ride board" : "Buses";

  return (
    <div className="dashboard-shell">
      <aside className="sidebar">
        <button className="brand sidebar-brand" onClick={() => go("buses")}>
          <span className="brand-mark"><Bus size={19} /></span>
          <span>TicketEase</span>
        </button>
        <nav className="sidebar-nav">
          <button className={view === "buses" ? "active" : ""} onClick={() => go("buses")}><LayoutDashboard size={18} /> Buses</button>
          <button className={view === "waitlist" ? "active" : ""} onClick={() => go("waitlist")}><Users size={18} /> Waitlist</button>
          <button className={view === "rides" ? "active" : ""} onClick={() => go("rides")}><Car size={18} /> Rides</button>
          {user.role === "admin" && <button className={view === "admin" ? "active" : ""} onClick={() => go("admin")}><ShieldCheck size={18} /> Admin</button>}
        </nav>
      </aside>
      <section className="workspace">
        <header className="dashboard-header">
          <div>
            <span className="eyebrow">{title}</span>
            <h1>{title}</h1>
          </div>
          <div className="top-actions">
            <NotificationBell notifications={notifications} />
            <ProfileMenu user={user} dark={dark} setDark={setDark} open={profileOpen} setOpen={setProfileOpen} logout={logout} />
          </div>
        </header>
        <main className="workspace-main">
          <AnimatePresence mode="wait">
            {view === "admin" && user.role === "admin" && <AdminView key="admin" locations={locations} showToast={showToast} />}
            {view === "waitlist" && <WaitlistOverview key="waitlist" schedules={schedules} onSelect={(id) => { setView("buses"); setSelectedScheduleId(id); }} />}
            {view === "rides" && <RideBoard key="rides" schedules={schedules} />}
            {view === "buses" && !selectedScheduleId && (
              <BusSearchView
                key="buses"
                locations={locations}
                schedules={schedules}
                setSchedules={setSchedules}
                onSelect={setSelectedScheduleId}
                showToast={showToast}
              />
            )}
            {view === "buses" && selectedScheduleId && (
              <ScheduleView
                key={selectedScheduleId}
                scheduleId={selectedScheduleId}
                user={user}
                socket={socket}
                showToast={showToast}
                onBack={() => setSelectedScheduleId(null)}
              />
            )}
          </AnimatePresence>
        </main>
      </section>
    </div>
  );
}

function ProfileMenu({ user, dark, setDark, open, setOpen, logout }) {
  return (
    <div className="profile-menu-wrap">
      <button className="avatar-button" onClick={() => setOpen(!open)} title="Profile">
        {user.name.slice(0, 1).toUpperCase()}
      </button>
      {open && (
        <div className="profile-menu">
          <div className="profile-block">
            <b>{user.name}</b>
            <span>{user.email}</span>
          </div>
          <dl>
            <div><dt>Gender</dt><dd>{user.gender}</dd></div>
            <div><dt>Age</dt><dd>{user.age || "-"}</dd></div>
          </dl>
          <button onClick={() => setDark(!dark)}>{dark ? <Sun size={16} /> : <Moon size={16} />} Theme</button>
          <button onClick={logout}><LogOut size={16} /> Sign out</button>
        </div>
      )}
    </div>
  );
}

function NotificationBell({ notifications }) {
  return (
    <div className="bell" title={notifications[0]?.message || "Notifications"}>
      <Bell size={18} />
      {notifications.length > 0 && <span>{notifications.length}</span>}
    </div>
  );
}

function LandingView({ onStart }) {
  return (
    <motion.section className="landing-page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <section className="landing-hero">
        <div>
          <span className="eyebrow"><CircleDot size={14} /> Real-time campus mobility</span>
          <h1>TicketEase</h1>
          <p>Fast seat locks, live availability, waitlist priority, and clean trip control for Amity University Raipur.</p>
          <button className="primary" onClick={onStart}>Get started</button>
        </div>
        <SeatPreview />
      </section>
      <section className="feature-grid">
        <div><Ticket size={22} /><h3>Atomic booking</h3><p>One seat, one winner.</p></div>
        <div><Bell size={22} /><h3>Live updates</h3><p>No refresh needed.</p></div>
        <div><Users size={22} /><h3>Smart waitlist</h3><p>Queue, chat, reassign.</p></div>
      </section>
    </motion.section>
  );
}

function SeatPreview() {
  return (
    <div className="live-map" aria-hidden="true">
      <div className="bus-window" />
      <div className="aisle-light" />
      {Array.from({ length: 20 }, (_, index) => {
        const status = index % 6 === 0 ? "booked" : index % 5 === 0 ? "held" : "available";
        return (
          <span key={index} className={status} style={{ "--i": index }}>
            <i />
            <b>{index + 1}</b>
          </span>
        );
      })}
    </div>
  );
}

function WaitlistOverview({ schedules, onSelect }) {
  return (
    <motion.section className="page-stack" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="task-grid">
        {schedules.map((schedule) => (
          <button className="task-card" key={schedule.id} onClick={() => onSelect(schedule.id)}>
            <span>{formatTime(schedule.departureAt)}</span>
            <b>{schedule.source} {"->"} {schedule.destination}</b>
            <small>{schedule.counts.available} open seats</small>
          </button>
        ))}
      </div>
    </motion.section>
  );
}

function RideBoard({ schedules }) {
  return (
    <motion.section className="page-stack" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="task-grid">
        {schedules.map((schedule) => (
          <div className="task-card" key={schedule.id}>
            <span>{formatTime(schedule.departureAt)}</span>
            <b>{schedule.source} {"->"} {schedule.destination}</b>
            <small>{(schedule.rides || []).length} ride requests</small>
          </div>
        ))}
      </div>
    </motion.section>
  );
}

function AuthView({ onAuth, showToast }) {
  const [mode, setMode] = useState("login");
  const [form, setForm] = useState({ name: "", email: "", password: "Password123", gender: "female", age: "", universityId: "" });

  async function submit(event) {
    event.preventDefault();
    try {
      const path = mode === "login" ? "/auth/login" : "/auth/register";
      onAuth(await api(path, { method: "POST", body: form }));
    } catch (error) {
      showToast(error);
    }
  }

  function fill(email) {
    setForm((current) => ({ ...current, email, password: "Password123" }));
  }

  return (
    <motion.section className="auth-layout" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}>
      <div className="auth-hero">
        <span className="eyebrow"><CircleDot size={14} /> Real-time bus booking platform</span>
        <h1>The seat you tap is yours in milliseconds.</h1>
        <p>Live locks, rotating refresh tokens, Supabase-ready row locks, waitlist chat, and check-in automation for Amity University Raipur students.</p>
        <div className="metric-strip">
          <strong>6 min</strong><span>seat hold</span>
          <strong>1 hr</strong><span>booking window</span>
          <strong>0</strong><span>double bookings</span>
        </div>
      </div>
      <form className="auth-card" onSubmit={submit}>
        <h2>{mode === "login" ? "Welcome back" : "Create account"}</h2>
        {mode === "register" && <input placeholder="Full name" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}
        {mode === "register" && <input placeholder="Age" type="number" min="16" max="80" value={form.age} onChange={(e) => setForm({ ...form, age: e.target.value })} />}
        <input placeholder="Email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} />
        <input placeholder="Password" type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} />
        {mode === "register" && (
          <div className="segmented">
            {["female", "male", "other"].map((gender) => (
              <button type="button" className={form.gender === gender ? "selected" : ""} onClick={() => setForm({ ...form, gender })} key={gender}>{gender}</button>
            ))}
          </div>
        )}
        <button className="primary wide" type="submit">{mode === "login" ? "Sign in" : "Sign up"}</button>
        <div className="demo-list">
          {DEMO_ACCOUNTS.map(([label, email]) => (
            <button type="button" key={email} onClick={() => fill(email)}>
              <Users size={18} /><span>{label}</span><small>Fill</small>
            </button>
          ))}
        </div>
        <button type="button" className="link-button" onClick={() => setMode(mode === "login" ? "register" : "login")}>
          {mode === "login" ? "New here? Create an account" : "Already registered? Sign in"}
        </button>
      </form>
    </motion.section>
  );
}

function BusSearchView({ locations, schedules, setSchedules, onSelect, showToast }) {
  const [source, setSource] = useState("Amity University Raipur");
  const [destination, setDestination] = useState("");

  async function search(event) {
    event.preventDefault();
    try {
      const params = new URLSearchParams();
      if (source) params.set("source", source);
      if (destination) params.set("destination", destination);
      const data = await api(`/schedules?${params}`);
      setSchedules(data.schedules);
    } catch (error) {
      showToast(error);
    }
  }

  return (
    <motion.section className="page-stack" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <form className="search-panel" onSubmit={search}>
        <label>Source<select value={source} onChange={(e) => setSource(e.target.value)}>{locations.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Destination<select value={destination} onChange={(e) => setDestination(e.target.value)}><option value="">Any Raipur location</option>{locations.filter((item) => item !== source).map((item) => <option key={item}>{item}</option>)}</select></label>
        <button className="primary"><Search size={18} /> Search buses</button>
      </form>

      <div className="section-title">
        <h2>Available schedules</h2>
        <span className="pill"><CircleDot size={10} /> live seat counts</span>
      </div>
      <div className="schedule-list">
        {schedules.map((schedule) => <ScheduleCard key={schedule.id} schedule={schedule} onSelect={() => onSelect(schedule.id)} />)}
      </div>
    </motion.section>
  );
}

function ScheduleCard({ schedule, onSelect }) {
  const state = bookingState(schedule);
  return (
    <button className={`schedule-card ${state === "departed" ? "departed" : ""}`} onClick={onSelect}>
      <div className="time-block"><strong>{formatTime(schedule.departureAt)}</strong><span>{schedule.busName}</span></div>
      <div className="route-block">
          <b>{schedule.source}</b><span>{"->"}</span><b>{schedule.destination}</b>
        <small>{state === "locked" ? `opens in ${countdownTo(schedule.bookingOpenAt)}` : state}</small>
      </div>
      <div className="capacity">
        <span>{schedule.counts.available} seats left</span>
        <div><i style={{ width: `${(schedule.counts.booked / schedule.counts.capacity) * 100}%` }} /></div>
        <small>{schedule.counts.booked}/{schedule.counts.capacity}</small>
      </div>
    </button>
  );
}

function ScheduleView({ scheduleId, user, socket, showToast, onBack }) {
  const [schedule, setSchedule] = useState(null);
  const [waitlist, setWaitlist] = useState([]);
  const [preferFemale, setPreferFemale] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [holds, setHolds] = useState([]);
  const [chat, setChat] = useState("");
  const [ride, setRide] = useState({ seatsNeeded: 1, notes: "" });

  useEffect(() => {
    api(`/schedules/${scheduleId}`)
      .then((data) => {
        setSchedule(data.schedule);
        setWaitlist(data.waitlist);
      })
      .catch(showToast);
  }, [scheduleId]);

  useEffect(() => {
    if (!socket) return;
    socket.emit("schedule:join", scheduleId);
    socket.on("schedule:update", (next) => next.id === scheduleId && setSchedule(next));
    socket.on("waitlist:update", setWaitlist);
    socket.on("chat:new", (message) => setSchedule((current) => current ? { ...current, chat: [...current.chat, message] } : current));
    socket.on("ride:new", (item) => setSchedule((current) => current ? { ...current, rides: [...current.rides, item] } : current));
    return () => {
      socket.emit("schedule:leave", scheduleId);
      socket.off("schedule:update");
      socket.off("waitlist:update");
      socket.off("chat:new");
      socket.off("ride:new");
    };
  }, [socket, scheduleId]);

  useEffect(() => {
    if (preferFemale && user?.gender === "female") {
      api(`/schedules/${scheduleId}/female-suggestions`)
        .then((data) => setSuggestions(data.suggestions))
        .catch(showToast);
    } else {
      setSuggestions([]);
    }
  }, [preferFemale, scheduleId, user?.gender]);

  async function lockSeat(seat) {
    if (!user) return showToast("Sign in to hold a seat.");
    if (bookingState(schedule) !== "open") return showToast("Booking is not open for this bus yet.");
    const activeHold = holds.find((item) => item.id === seat.id);
    if (activeHold) return releaseHold(activeHold);
    if (seat.status !== "available") return showToast("That seat is unavailable.");
    try {
      const data = await api(`/schedules/${scheduleId}/seats/${seat.id}/lock`, { method: "POST" });
      setHolds((current) => [
        ...current.filter((item) => item.id !== data.seat.id),
        { ...data.seat, passengerGender: user.gender || "other" }
      ]);
      setSchedule(data.schedule);
    } catch (error) {
      showToast(error);
    }
  }

  async function releaseHold(seat) {
    try {
      const data = await api(`/schedules/${scheduleId}/seats/${seat.id}/lock`, {
        method: "DELETE",
        body: { lockId: seat.lockId }
      });
      setHolds((current) => current.filter((item) => item.id !== seat.id));
      setSchedule(data.schedule);
    } catch (error) {
      showToast(error);
    }
  }

  function updateHoldGender(seatId, passengerGender) {
    setHolds((current) => current.map((seat) => (seat.id === seatId ? { ...seat, passengerGender } : seat)));
  }

  async function confirmPayment() {
    try {
      if (!holds.length) return;
      const data = await api(`/schedules/${scheduleId}/bookings/confirm`, {
        method: "POST",
        body: {
          preferFemale,
          seats: holds.map((seat) => ({ seatId: seat.id, lockId: seat.lockId, passengerGender: seat.passengerGender || user.gender || "other" }))
        }
      });
      const confirmed = new Set(data.seats.map((seat) => seat.id));
      setHolds((current) => current.filter((item) => !confirmed.has(item.id)));
      setSchedule(data.schedule);
      showToast(`${data.seats.length} seat${data.seats.length > 1 ? "s" : ""} confirmed.`);
    } catch (error) {
      showToast(error);
    }
  }

  async function joinWaitlist() {
    try {
      const data = await api(`/schedules/${scheduleId}/waitlist`, { method: "POST" });
      setWaitlist(data.waitlist);
      showToast(`You are waitlist position ${data.position}.`);
    } catch (error) {
      showToast(error);
    }
  }

  async function checkIn() {
    try {
      const data = await api(`/schedules/${scheduleId}/check-in`, { method: "POST" });
      setSchedule(data.schedule);
      showToast("Check-in confirmed.");
    } catch (error) {
      showToast(error);
    }
  }

  async function sendChat(event) {
    event.preventDefault();
    if (!chat.trim()) return;
    await api(`/schedules/${scheduleId}/chat`, { method: "POST", body: { message: chat } }).catch(showToast);
    setChat("");
  }

  async function postRide(event) {
    event.preventDefault();
    await api(`/schedules/${scheduleId}/rides`, { method: "POST", body: { ...ride, from: schedule.source, to: schedule.destination } }).catch(showToast);
    setRide({ seatsNeeded: 1, notes: "" });
  }

  if (!schedule) return <div className="loading">Loading schedule...</div>;

  const state = bookingState(schedule);
  const allUnavailable = schedule.counts.available === 0;
  const femaleAdjacentSeatIds = adjacentFemaleSeatIds(schedule.seats);

  return (
    <motion.section className="detail-grid" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <button className="back-button" onClick={onBack}><ChevronLeft size={18} /> Today&apos;s schedule</button>
      <section className="trip-header">
        <div className="trip-title">
          <span className="brand-mark"><Bus size={24} /></span>
            <div><h1>{schedule.source} {"->"} {schedule.destination}</h1><p>{schedule.busName} - {formatDate(schedule.departureAt)}</p></div>
        </div>
        <div className="trip-time"><strong>{formatTime(schedule.departureAt)}</strong><span className={`pill ${state === "departed" ? "departed-pill" : ""}`}>{state === "locked" ? `opens ${countdownTo(schedule.bookingOpenAt)}` : state}</span></div>
      </section>

      <section className="timeline">
        <span><b>{formatTime(schedule.bookingOpenAt)}</b>booking opens</span>
        <span><b>{formatTime(schedule.checkInStartAt)}</b>check-in starts</span>
        <span><b>{formatTime(schedule.reallocationAt)}</b>unconfirmed released</span>
      </section>

      {state === "locked" && <div className="notice"><CalendarClock size={18} /> Booking opens in {countdownTo(schedule.bookingOpenAt)}. Seat buttons are disabled until then.</div>}

      <section className="booking-grid">
        <div className="seat-panel">
          <div className="panel-head">
            <div><h2>Interactive seat map</h2><p>{schedule.counts.available} available / {schedule.counts.locked} held / {schedule.counts.booked} booked</p></div>
            <button className="secondary" onClick={checkIn}><ShieldCheck size={18} /> Check in</button>
          </div>
          {user?.gender === "female" && (
            <label className="preference">
              <input type="checkbox" checked={preferFemale} onChange={(e) => setPreferFemale(e.target.checked)} />
              Prefer Female Co-Passenger
            </label>
          )}
          <SeatMap seats={schedule.seats} disabled={state !== "open"} onSeatClick={lockSeat} holds={holds} suggestions={suggestions} femaleAdjacentSeatIds={femaleAdjacentSeatIds} />
          <div className="legend">
            <span className="available" /> Available <span className="held" /> Held <span className="female-booked" /> Female <span className="male-booked" /> Male <span className="selected" /> Selected
          </div>
        </div>

        <aside className="side-stack">
          <HoldCard holds={holds} onPay={confirmPayment} onGenderChange={updateHoldGender} />
          <SuggestionCard suggestions={suggestions} onPick={(seatId) => lockSeat(schedule.seats.find((seat) => seat.id === seatId))} />
          <WaitlistCard waitlist={waitlist} allUnavailable={allUnavailable} onJoin={joinWaitlist} />
        </aside>
      </section>

      <section className="collab-grid">
        <div className="collab-panel">
          <h2>Waitlist group chat</h2>
          <div className="chat-box">
            {(schedule.chat || []).slice(-6).map((item) => <p key={item.id}><b>{item.name}</b> {item.message}</p>)}
          </div>
          <form onSubmit={sendChat} className="inline-form">
            <input value={chat} onChange={(e) => setChat(e.target.value)} placeholder="Coordinate alternatives during peak rush" />
            <button className="primary">Send</button>
          </form>
        </div>
        <div className="collab-panel">
          <h2>Shared ride requests</h2>
          <div className="ride-list">
            {(schedule.rides || []).slice(-4).map((item) => <p key={item.id}><b>{item.name}</b> needs {item.seatsNeeded} seat(s). {item.notes}</p>)}
          </div>
          <form onSubmit={postRide} className="inline-form ride-form">
            <input type="number" min="1" max="6" value={ride.seatsNeeded} onChange={(e) => setRide({ ...ride, seatsNeeded: e.target.value })} />
            <input value={ride.notes} onChange={(e) => setRide({ ...ride, notes: e.target.value })} placeholder="Carpool note" />
            <button className="primary">Post</button>
          </form>
        </div>
      </section>
    </motion.section>
  );
}

function SeatMap({ seats, disabled, onSeatClick, holds, suggestions, femaleAdjacentSeatIds }) {
  const suggestionIds = new Set(suggestions.map((item) => item.seatId));
  const heldIds = new Set(holds.map((seat) => seat.id));
  return (
    <div className="seat-map">
      {seats.map((seat) => {
        const bookedGenderClass = seat.status === "booked" && seat.passengerGender ? `${seat.passengerGender}-booked` : "";
        const adjacentClass = femaleAdjacentSeatIds.has(seat.id) ? "female-adjacent" : "";
        return (
          <button
            key={seat.id}
            disabled={disabled || (seat.status !== "available" && !heldIds.has(seat.id))}
            className={`seat ${seat.status} ${bookedGenderClass} ${adjacentClass} ${heldIds.has(seat.id) ? "selected" : ""} ${suggestionIds.has(seat.id) ? "suggested" : ""}`}
            onClick={() => onSeatClick(seat)}
            title={femaleAdjacentSeatIds.has(seat.id) ? "Female adjacent preference seat" : seat.status}
          >
            {seat.label}
          </button>
        );
      })}
    </div>
  );
}

function HoldCard({ holds, onPay, onGenderChange }) {
  if (!holds.length) {
    return <div className="info-card"><Ticket size={22} /><h3>No seats held</h3></div>;
  }
  const expiresAt = holds.map((seat) => new Date(seat.lockExpiresAt).getTime()).sort((a, b) => a - b)[0];
  return (
    <div className="info-card accent">
      <WalletCards size={22} />
      <h3>{holds.length} seat{holds.length > 1 ? "s" : ""} held</h3>
      <p>{holds.map((seat) => seat.label).join(", ")} / expires {countdownTo(expiresAt)}</p>
      <div className="seat-gender-list">
        {holds.map((seat) => (
          <label key={seat.id}>
            <span>{seat.label}</span>
            <select value={seat.passengerGender || "other"} onChange={(event) => onGenderChange(seat.id, event.target.value)}>
              <option value="female">Female</option>
              <option value="male">Male</option>
              <option value="other">Other</option>
            </select>
          </label>
        ))}
      </div>
      <button className="primary wide" onClick={onPay}><Check size={18} /> Pay and confirm</button>
    </div>
  );
}

function SuggestionCard({ suggestions, onPick }) {
  if (!suggestions.length) {
    return <div className="info-card"><Users size={22} /><h3>Female preference</h3><p>No matching adjacent seat is currently available. Normal booking can continue.</p></div>;
  }
  return (
    <div className="info-card">
      <Users size={22} />
      <h3>Suggested seats</h3>
      {suggestions.map((item) => <button className="suggestion-row" key={item.seatId} onClick={() => onPick(item.seatId)}>Seat {item.label}<small>{item.reason}</small></button>)}
    </div>
  );
}

function WaitlistCard({ waitlist, allUnavailable, onJoin }) {
  return (
    <div className="info-card">
      <h3>Waiting list <span className="pill">{waitlist.length} waiting</span></h3>
      <p>{waitlist.length ? "Seats released at minute 50 go to this queue automatically." : "Nobody is waiting yet."}</p>
      <button className="secondary wide" onClick={onJoin}>{allUnavailable ? "Join waitlist" : "Join backup waitlist"}</button>
      <div className="waitlist">
        {waitlist.slice(0, 5).map((item) => <span key={item.id}>#{item.position} {item.name}</span>)}
      </div>
    </div>
  );
}

function AdminView({ locations, showToast }) {
  const [overview, setOverview] = useState(null);
  const [form, setForm] = useState({ source: "Amity University Raipur", destination: "Saddu", busName: "AUR Shuttle", departureAt: "" });

  function load() {
    api("/admin/overview").then(setOverview).catch(showToast);
  }

  useEffect(load, []);

  async function createSchedule(event) {
    event.preventDefault();
    try {
      await api("/admin/schedules", { method: "POST", body: form });
      showToast("Schedule created.");
      load();
    } catch (error) {
      showToast(error);
    }
  }

  if (!overview) return <div className="loading">Loading admin dashboard...</div>;

  return (
    <motion.section className="page-stack" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="admin-hero">
        <h1>Transport admin dashboard</h1>
        <p>Manage schedules, monitor occupancy, bookings, waitlists, and student access.</p>
      </div>
      <div className="admin-metrics">
        <Metric icon={<Bus />} label="Schedules" value={overview.schedules.length} />
        <Metric icon={<Ticket />} label="Bookings" value={overview.bookings.length} />
        <Metric icon={<Users />} label="Users" value={overview.users.length} />
        <Metric icon={<Route />} label="Waitlists" value={overview.waitlists.reduce((sum, item) => sum + item.count, 0)} />
      </div>
      <section className="admin-grid">
        <form className="admin-form" onSubmit={createSchedule}>
          <h2>Create schedule</h2>
          <select value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })}>{locations.map((item) => <option key={item}>{item}</option>)}</select>
          <select value={form.destination} onChange={(e) => setForm({ ...form, destination: e.target.value })}>{locations.map((item) => <option key={item}>{item}</option>)}</select>
          <input value={form.busName} onChange={(e) => setForm({ ...form, busName: e.target.value })} />
          <input type="datetime-local" value={form.departureAt} onChange={(e) => setForm({ ...form, departureAt: e.target.value })} />
          <button className="primary">Add schedule</button>
        </form>
        <div className="table-panel">
          <h2>Seat occupancy</h2>
          {overview.schedules.map((schedule) => (
            <div className="table-row" key={schedule.id}>
              <span>{schedule.source} {"->"} {schedule.destination}</span>
              <b>{schedule.counts.booked}/{schedule.counts.capacity}</b>
            </div>
          ))}
        </div>
      </section>
    </motion.section>
  );
}

function Metric({ icon, label, value }) {
  return <div className="metric-card">{icon}<span>{label}</span><strong>{value}</strong></div>;
}
