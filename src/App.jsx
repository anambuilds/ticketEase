import { AnimatePresence, motion } from "framer-motion";
import {
  Bus,
  Check,
  ChevronLeft,
  CircleDot,
  LayoutDashboard,
  LogOut,
  PanelLeftClose,
  PanelLeftOpen,
  Moon,
  Route,
  Search,
  ShieldCheck,
  Sun,
  Ticket,
  Timer,
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
  if (Date.now() >= new Date(schedule.departureAt).getTime()) return "departed";
  return "bookable";
}

function isDepartingSoon(schedule) {
  const diff = new Date(schedule.departureAt).getTime() - Date.now();
  return diff > 0 && diff <= 90 * 60_000;
}

function seatTier(seat) {
  return seat.row <= 3 ? "premium" : "general";
}

function seatPrice(seat) {
  return seatTier(seat) === "premium" ? 649 : 449;
}

function formatSeatPrice(seat) {
  return `Rs ${seatPrice(seat)}`;
}
function pickVisibleSchedules(schedules) {
  const active = schedules.filter((schedule) => bookingState(schedule) !== "departed");
  const soon = active.filter(isDepartingSoon).slice(0, 2);
  const soonIds = new Set(soon.map((schedule) => schedule.id));
  const anytime = active.filter((schedule) => !soonIds.has(schedule.id) && !isDepartingSoon(schedule)).slice(0, 3);
  const fallback = active.filter((schedule) => !soonIds.has(schedule.id) && !anytime.some((item) => item.id === schedule.id)).slice(0, Math.max(0, 5 - soon.length - anytime.length));
  return [...soon, ...anytime, ...fallback].slice(0, 5);
}
function getRecommendedSeat(seats) {
  const available = seats.filter((seat) => seat.status === "available");
  if (!available.length) return null;
  return [...available].sort((a, b) => {
    const score = (seat) => {
      const balancedRow = Math.abs(seat.row - 5);
      const aisleBonus = seat.col === 1 || seat.col === 2 ? -0.8 : 0;
      const premiumPenalty = seatTier(seat) === "premium" ? 1.4 : 0;
      return balancedRow + aisleBonus + premiumPenalty;
    };
    return score(a) - score(b) || a.row - b.row || a.col - b.col;
  })[0];
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

function useButtonRipples() {
  useEffect(() => {
    function handlePointerDown(event) {
      const button = event.target.closest?.("button");
      if (!button || button.disabled || button.dataset.noRipple === "true") return;
      const rect = button.getBoundingClientRect();
      const ripple = document.createElement("span");
      const size = Math.max(rect.width, rect.height) * 1.35;
      ripple.className = "button-ripple";
      ripple.style.width = `${size}px`;
      ripple.style.height = `${size}px`;
      ripple.style.left = `${event.clientX - rect.left - size / 2}px`;
      ripple.style.top = `${event.clientY - rect.top - size / 2}px`;
      button.appendChild(ripple);
      window.setTimeout(() => ripple.remove(), 520);
    }

    document.addEventListener("pointerdown", handlePointerDown, { passive: true });
    return () => document.removeEventListener("pointerdown", handlePointerDown);
  }, []);
}
export default function App() {
  useButtonRipples();
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
    setSelectedScheduleId(null);
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
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  function go(nextView) {
    setSelectedScheduleId(null);
    setView(nextView);
  }

  const selectedSchedule = selectedScheduleId ? schedules.find((schedule) => schedule.id === selectedScheduleId) : null;
  const title = selectedSchedule ? "Select Seat" : view === "admin" ? "Admin" : view === "bookings" ? "My bookings" : view === "about" ? "About us" : view === "home" ? "Home" : "Buses";

  return (
    <div className={`dashboard-shell ${sidebarCollapsed ? "sidebar-collapsed" : ""}`}>
      <aside className="sidebar">
        <div className="sidebar-top">
          <button className="brand sidebar-brand" onClick={() => go("home")}>
            <span className="brand-mark"><Bus size={19} /></span>
            <span>TicketEase</span>
          </button>
          <button className="sidebar-toggle" onClick={() => setSidebarCollapsed(!sidebarCollapsed)} title={sidebarCollapsed ? "Show sidebar" : "Hide sidebar"}>
            {sidebarCollapsed ? <PanelLeftOpen size={18} /> : <PanelLeftClose size={18} />}
          </button>
        </div>
        <nav className="sidebar-nav">
          <button className={view === "buses" ? "active" : ""} onClick={() => go("buses")}><LayoutDashboard size={18} /><span>Buses</span></button>
          <button className={view === "bookings" ? "active" : ""} onClick={() => go("bookings")}><WalletCards size={18} /><span>My bookings</span></button>
          <button className={view === "about" ? "active" : ""} onClick={() => go("about")}><Route size={18} /><span>About us</span></button>
          {user.role === "admin" && <button className={view === "admin" ? "active" : ""} onClick={() => go("admin")}><ShieldCheck size={18} /><span>Admin</span></button>}
        </nav>
      </aside>
      <section className="workspace">
        <header className="dashboard-header">
          <div className="header-title">
            <h1>{title}</h1>
            {selectedSchedule && <span>{selectedSchedule.source} to {selectedSchedule.destination} / {selectedSchedule.busName} / {formatTime(selectedSchedule.departureAt)}</span>}
          </div>
          <div className="top-actions">
            <ProfileMenu user={user} dark={dark} setDark={setDark} open={profileOpen} setOpen={setProfileOpen} logout={logout} />
          </div>
        </header>
        <main className="workspace-main">
          <AnimatePresence mode="wait">
            {view === "home" && <SignedInHome key="home" onStart={() => go("buses")} />}
            {view === "about" && <AboutView key="about" />}
            {view === "bookings" && <MyBookingsView key="bookings" schedules={schedules} user={user} onSelect={(id) => { setView("buses"); setSelectedScheduleId(id); }} />}
            {view === "admin" && user.role === "admin" && <AdminView key="admin" locations={locations} showToast={showToast} />}
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
  useEffect(() => {
    if (!open) return undefined;

    function closeOnOutsidePress(event) {
      if (!event.target.closest?.(".profile-menu-wrap")) setOpen(false);
    }

    document.addEventListener("pointerdown", closeOnOutsidePress);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePress);
  }, [open, setOpen]);

  function closeAfter(action) {
    action?.();
    setOpen(false);
  }

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
          <button onClick={() => closeAfter(() => setDark(!dark))}>{dark ? <Sun size={16} /> : <Moon size={16} />} Theme</button>
          <button onClick={() => closeAfter(logout)}><LogOut size={16} /> Sign out</button>
        </div>
      )}
    </div>
  );
}

function LandingView({ onStart }) {
  return (
    <motion.section className="landing-page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <section className="landing-hero">
        <div>
          <span className="eyebrow"><CircleDot size={14} /> Real-time campus mobility</span>
          <h1>Ticket<span className="ease-ombre">Ease</span></h1>
          <p>Fast seat locks, live availability, instant booking, and clean trip control for Amity University Raipur.</p>
          <button className="primary" onClick={onStart}>Get started</button>
        </div>
        <SeatPreview />
      </section>
      <section className="feature-grid">
        <div className="feature-card feature-wide">
          <span><Ticket size={18} /> Choose your seats</span>
          <h3>Pick seats live.</h3>
          <p>Held seats pulse in amber with a tiny timer, so you know what is moving.</p>
        </div>
        <div className="feature-card">
          <span><Timer size={18} /> 6 minute hold</span>
          <h3>Checkout calmly.</h3>
          <p>Click a seat and an atomic lock keeps it yours while you finish.</p>
        </div>
        <div className="feature-card">
          <span><Check size={18} /> Instant booking</span>
          <h3>Tap, pay, done.</h3>
          <p>Confirmed seats update on every screen immediately.</p>
        </div>
      </section>

    </motion.section>
  );
}

function SeatPreview() {
  const seats = Array.from({ length: 32 }, (_, index) => {
    const number = index + 1;
    let status = "available";
    if ([3, 8, 13, 19, 24, 30].includes(number)) status = "unavailable";
    if ([5, 6, 9, 10].includes(number)) status = "premium";
    if ([15, 16].includes(number)) status = "selected";
    return { number, status };
  });

  return (
    <div className="phone-showcase" aria-label="TicketEase live booking phone mockup">
      <div className="phone-glow" />
      <div className="phone-shadow" />
      <div className="phone-device">
        <div className="dynamic-island" />
        <div className="phone-screen">
          <div className="phone-status"><span>TicketEase</span><b>LIVE</b></div>
          <div className="phone-trip-card">
            <span>BUS 7A</span>
            <h3>Shankar Nagar <small>to</small> Amity University Raipur</h3>
            <div><b>2:37 PM</b><em>24 Seats Left</em></div>
          </div>
          <div className="phone-seat-toolbar">
            <span>Pick seats</span>
            <small>2 + 2 layout</small>
          </div>
          <div className="phone-seat-map">
            {seats.map((seat, index) => (
              <React.Fragment key={seat.number}>
                {index % 4 === 2 && <i className="phone-aisle" />}
                <span className={`phone-seat ${seat.status}`} style={{ "--seat-index": index }}>{seat.number}</span>
              </React.Fragment>
            ))}
          </div>
        </div>
      </div>
      <div className="phone-info-card">
        <b>BUS 7A</b>
        <span>{"Shankar Nagar ? Amity University Raipur"}</span>
        <strong>2:37 PM</strong>
        <em>24 Seats Left</em>
      </div>
    </div>
  );
}

function SignedInHome({ onStart }) {
  return <LandingView onStart={onStart} />;
}

function AboutView() {
  return (
    <motion.section className="about-page" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <div className="about-hero" data-reveal>
        <span className="eyebrow"><CircleDot size={14} /> About TicketEase</span>
        <h2>Campus bus booking without the rush.</h2>
        <p>TicketEase helps Amity University Raipur students find buses, hold seats, confirm tickets, and see live availability in one clean workspace.</p>
      </div>
      <div className="about-grid" data-reveal>
        <div><Ticket size={22} /><h3>Live seat maps</h3><p>See available, held, and booked seats before you choose.</p></div>
        <div><Timer size={22} /><h3>6 minute holds</h3><p>A temporary lock gives you time to finish checkout.</p></div>
        <div><ShieldCheck size={22} /><h3>Safer booking</h3><p>Backend validation and database locks protect against double booking.</p></div>
      </div>
    </motion.section>
  );
}

function MyBookingsView({ schedules, user, onSelect }) {
  const bookings = schedules.flatMap((schedule) =>
    schedule.seats
      .filter((seat) => seat.status === "booked" && seat.bookedBy === user.id)
      .map((seat) => ({ schedule, seat }))
  );

  return (
    <motion.section className="page-stack" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      {bookings.length === 0 ? (
        <div className="empty-state"><Ticket size={24} /><h2>No bookings yet</h2><p>Your confirmed seats will appear here.</p></div>
      ) : (
        <div className="task-grid">
          {bookings.map(({ schedule, seat }) => (
            <button className="task-card" key={`${schedule.id}-${seat.id}`} onClick={() => onSelect(schedule.id)}>
              <span>{formatTime(schedule.departureAt)}</span>
              <b>{schedule.source} {"->"} {schedule.destination}</b>
              <small>Seat {seat.label} / {schedule.busName}</small>
            </button>
          ))}
        </div>
      )}
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
        <h1>The seat you tap is yours <span className="green-ombre-text">in milliseconds.</span></h1>
        <p>Live locks, rotating refresh tokens, Supabase-ready row locks, and instant campus bus booking for Amity University Raipur students.</p>
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
  const [source, setSource] = useState("");
  const [destination, setDestination] = useState("");
  const [searching, setSearching] = useState(false);
  const visibleSchedules = pickVisibleSchedules(schedules);

  async function loadSchedules(nextSource = source, nextDestination = destination) {
    setSearching(true);
    try {
      const params = new URLSearchParams();
      if (nextSource) params.set("source", nextSource);
      if (nextDestination) params.set("destination", nextDestination);
      const data = await api(`/schedules?${params}`);
      setSchedules(data.schedules);
    } catch (error) {
      showToast(error);
    } finally {
      setSearching(false);
    }
  }

  async function search(event) {
    event.preventDefault();
    await loadSchedules();
  }

  async function clearSearch() {
    setSource("");
    setDestination("");
    await loadSchedules("", "");
  }

  return (
    <motion.section className="page-stack" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <form className="search-panel" onSubmit={search} data-reveal>
        <label>Source<select value={source} onChange={(e) => setSource(e.target.value)}><option value="">Any source</option>{locations.map((item) => <option key={item}>{item}</option>)}</select></label>
        <label>Destination<select value={destination} onChange={(e) => setDestination(e.target.value)}><option value="">Any destination</option>{locations.filter((item) => item !== source).map((item) => <option key={item}>{item}</option>)}</select></label>
        <button className="primary search-button" type="submit" disabled={searching}><Search size={18} /> {searching ? "Searching" : "Search"}</button>
      </form>

      <div className="section-title">
        <h2>Available schedules</h2>
      </div>
      <div className="schedule-list">
        {visibleSchedules.length > 0 ? (
          visibleSchedules.map((schedule) => <ScheduleCard key={schedule.id} schedule={schedule} forceSoon={isDepartingSoon(schedule)} onSelect={() => onSelect(schedule.id)} />)
        ) : (
          <div className="empty-state schedule-empty" data-reveal>
            <Ticket size={24} />
            <h2>No buses found</h2>
            <p>Try a different route or clear the search to see all available buses.</p>
            <button className="secondary" type="button" disabled={searching} onClick={clearSearch}>Show all buses</button>
          </div>
        )}
      </div>
    </motion.section>
  );
}

function ScheduleCard({ schedule, forceSoon, onSelect }) {
  const state = bookingState(schedule);
  const soon = forceSoon ?? isDepartingSoon(schedule);
  return (
    <button className={`schedule-card ${state} ${soon ? "soon" : ""}`} onClick={onSelect} data-reveal>
      <div className="time-block"><strong>{formatTime(schedule.departureAt)}</strong><span>{schedule.busName}</span></div>
      <div className="route-block">
          <b>{schedule.source}</b><span>{"->"}</span><b>{schedule.destination}</b>
        <small>{state === "departed" ? "Departed" : soon ? "Leaving soon" : "Book anytime"}</small>
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
  const [suggestions, setSuggestions] = useState([]);
  const [holds, setHolds] = useState([]);
  const [suggestionModal, setSuggestionModal] = useState(null);
  const [suggestionSeen, setSuggestionSeen] = useState(false);
  const [paymentWarning, setPaymentWarning] = useState(false);
  const [finder, setFinder] = useState({ groupSize: 2, budget: "any", mode: "together" });

  useEffect(() => {
    api(`/schedules/${scheduleId}`)
      .then((data) => setSchedule(data.schedule))
      .catch(showToast);
  }, [scheduleId]);

  useEffect(() => {
    if (!socket) return;
    socket.emit("schedule:join", scheduleId);
    socket.on("schedule:update", (next) => next.id === scheduleId && setSchedule(next));
    return () => {
      socket.emit("schedule:leave", scheduleId);
      socket.off("schedule:update");
    };
  }, [socket, scheduleId]);

  useEffect(() => {
    if (user?.gender === "female") {
      api(`/schedules/${scheduleId}/female-suggestions`)
        .then((data) => setSuggestions(data.suggestions))
        .catch(showToast);
    } else {
      setSuggestions([]);
    }
  }, [scheduleId, user?.gender]);
  useEffect(() => {
    if (!holds.length) {
      setPaymentWarning(false);
      return undefined;
    }
    const earliestExpiry = Math.min(...holds.map((seat) => new Date(seat.lockExpiresAt).getTime()));
    const delay = Math.max(0, earliestExpiry - Date.now());
    const timer = window.setTimeout(() => setPaymentWarning(true), delay);
    return () => window.clearTimeout(timer);
  }, [holds]);

  async function holdSeat(seat) {
    const optimisticSeat = {
      ...seat,
      status: "locked",
      lockId: `pending-${seat.id}`,
      lockExpiresAt: new Date(Date.now() + 6 * 60_000).toISOString(),
      lockedBy: user.id,
      passengerGender: user.gender || "other",
      isPending: true
    };

    setHolds((current) => [
      ...current.filter((item) => item.id !== seat.id),
      optimisticSeat
    ]);

    try {
      const data = await api(`/schedules/${scheduleId}/seats/${seat.id}/lock`, { method: "POST" });
      setHolds((current) => [
        ...current.filter((item) => item.id !== data.seat.id),
        { ...data.seat, passengerGender: optimisticSeat.passengerGender }
      ]);
      setSchedule(data.schedule);
    } catch (error) {
      setHolds((current) => current.filter((item) => item.id !== seat.id));
      showToast(error);
    }
  }


  async function findSeats() {
    if (bookingState(schedule) !== "bookable") return showToast("This bus has departed.");
    const groupSize = Math.max(1, Math.min(6, Number(finder.groupSize) || 1));
    const heldIds = new Set(holds.map((seat) => seat.id));
    const available = schedule.seats
      .filter((seat) => seat.status === "available" && !heldIds.has(seat.id))
      .filter((seat) => finder.budget === "any" || seatTier(seat) === finder.budget);

    const ordered = [...available].sort((a, b) => {
      if (finder.mode === "back") return b.row - a.row || a.col - b.col;
      return a.row - b.row || a.col - b.col;
    });

    let picked = [];
    if (finder.mode === "together") {
      const sides = [[0, 1], [2, 3]];
      for (const row of [...new Set(ordered.map((seat) => seat.row))]) {
        for (const side of sides) {
          const rowSeats = ordered.filter((seat) => seat.row === row && side.includes(seat.col));
          if (rowSeats.length >= Math.min(groupSize, 2)) picked.push(...rowSeats.slice(0, Math.min(groupSize, 2)));
          if (picked.length >= groupSize) break;
        }
        if (picked.length >= groupSize) break;
      }
      if (picked.length < groupSize) picked = [...picked, ...ordered.filter((seat) => !picked.some((item) => item.id === seat.id))].slice(0, groupSize);
    } else if (finder.mode === "aisle") {
      picked = ordered.filter((seat) => seat.col === 1 || seat.col === 2).slice(0, groupSize);
    } else {
      picked = ordered.slice(0, groupSize);
    }

    if (picked.length < groupSize) return showToast("Not enough matching seats are available.");
    for (const seat of picked) {
      await holdSeat(seat);
    }
    showToast(`${picked.length} seat${picked.length > 1 ? "s" : ""} held for you.`);
  }
  async function lockSeat(seat) {
    if (!user) return showToast("Sign in to hold a seat.");
    if (bookingState(schedule) !== "bookable") return showToast("This bus has departed.");
    const activeHold = holds.find((item) => item.id === seat.id);
    if (activeHold) return releaseHold(activeHold);
    if (seat.status !== "available") return showToast("That seat is unavailable.");
    if (user.gender === "female" && !suggestionSeen && schedule.seats.some((item) => item.status === "booked" && item.passengerGender === "female")) {
      setSuggestionSeen(true);
      setSuggestionModal({ seat });
      return;
    }
    return holdSeat(seat);
  }

  async function releaseHold(seat) {
    setHolds((current) => current.filter((item) => item.id !== seat.id));
    if (seat.isPending) return;

    try {
      const data = await api(`/schedules/${scheduleId}/seats/${seat.id}/lock`, {
        method: "DELETE",
        body: { lockId: seat.lockId }
      });
      setSchedule(data.schedule);
    } catch (error) {
      setHolds((current) => [
        ...current.filter((item) => item.id !== seat.id),
        seat
      ]);
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
          preferFemale: user.gender === "female",
          seats: holds.map((seat) => ({ seatId: seat.id, lockId: seat.lockId, passengerGender: seat.passengerGender || user.gender || "other" }))
        }
      });
      const confirmed = new Set(data.seats.map((seat) => seat.id));
      setHolds((current) => current.filter((item) => !confirmed.has(item.id)));
      setSchedule(data.schedule);
      showToast(`${data.seats.length} seat${data.seats.length > 1 ? "s are" : " is"} booked.`);
    } catch (error) {
      showToast(error);
    }
  }

  if (!schedule) return <div className="loading">Loading schedule...</div>;

  const state = bookingState(schedule);
  const femaleAdjacentSeatIds = adjacentFemaleSeatIds(schedule.seats);
  const femaleBookedSeats = schedule.seats.filter((seat) => seat.status === "booked" && seat.passengerGender === "female");
  const recommendedSeat = getRecommendedSeat(schedule.seats);

  return (
    <motion.section className="detail-grid" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}>
      <button className="back-button" onClick={onBack}><ChevronLeft size={18} /> Schedules</button>
      <section className="booking-grid select-seat-layout">
        <div className="seat-panel select-seat-panel">
          <div className="select-seat-screen-head">
            <button className="select-back-button" onClick={onBack} aria-label="Back to schedules"><ChevronLeft size={18} /></button>
            <h2>Select Seat</h2>
            <span />
          </div>
          <div className="legend select-seat-legend">
            <span className="available" /> Available <span className="selected" /> Selected <span className="booked" /> Unavailable
          </div>
          <div className="select-seat-stage">
            <SeatMap seats={schedule.seats} disabled={state !== "bookable"} onSeatClick={lockSeat} holds={holds} suggestions={suggestions} femaleAdjacentSeatIds={femaleAdjacentSeatIds} previewSeatLabel={recommendedSeat?.label} />
          </div>
        </div>

        <aside className="side-stack select-checkout-stack">
          <HoldCard
            holds={holds}
            fallbackSeat={recommendedSeat}
            onFallbackContinue={() => {
              if (recommendedSeat) lockSeat(recommendedSeat);
            }}
            onPay={confirmPayment}
            onGenderChange={updateHoldGender}
          />
        </aside>
      </section>

      {paymentWarning && holds.length > 0 && <PaymentWarning onPay={confirmPayment} onClose={() => setPaymentWarning(false)} />}

      {suggestionModal && (
        <SuggestionModal
          suggestions={suggestions}
          femaleBookedSeats={femaleBookedSeats}
          onClose={() => setSuggestionModal(null)}
          onContinue={() => {
            const seat = suggestionModal.seat;
            setSuggestionModal(null);
            holdSeat(seat);
          }}
          onPick={(seatId) => {
            const seat = schedule.seats.find((item) => item.id === seatId);
            setSuggestionModal(null);
            if (seat) holdSeat(seat);
          }}
        />
      )}
    </motion.section>
  );
}

function PaymentWarning({ onPay, onClose }) {
  return (
    <div className="payment-float">
      <button onClick={onClose} className="payment-float-close">x</button>
      <b>Make payment now</b>
      <span>Your hold time has passed. Complete payment before the seat is taken by someone else.</span>
      <button className="primary" onClick={onPay}>Pay now</button>
    </div>
  );
}

function SuggestionModal({ suggestions, femaleBookedSeats, onClose, onContinue, onPick }) {
  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true">
      <div className="suggestion-modal">
        <button className="modal-close" onClick={onClose}>x</button>
        <span className="eyebrow"><Users size={14} /> Female preference</span>
        <h2>Nearby female seats are available</h2>
        <p>You can choose a seat beside an already confirmed female passenger, or continue with your selected seat.</p>
        {femaleBookedSeats.length > 0 && <div className="female-seat-list"><b>Female booked seats</b><span>{femaleBookedSeats.map((seat) => seat.label).join(", ")}</span></div>}
        <div className="suggestion-list">
          {suggestions.length > 0 ? suggestions.map((item) => <button key={item.seatId} onClick={() => onPick(item.seatId)}>Seat {item.label}<small>{item.reason}</small></button>) : <p>No adjacent female-preference seat is open right now.</p>}
        </div>
        <button className="primary wide" onClick={onContinue}>Continue with selected seat</button>
      </div>
    </div>
  );
}

function SeatMap({ seats, disabled, onSeatClick, holds, suggestions, femaleAdjacentSeatIds, previewSeatLabel = null }) {
  const suggestionIds = new Set(suggestions.map((item) => item.seatId));
  const heldIds = new Set(holds.map((seat) => seat.id));
  const columns = ["A", "B", "C", "D"];
  const totalRows = Math.max(...seats.map((seat) => seat.row), 9);
  const rows = Array.from({ length: totalRows }, (_, index) => index + 1);
  const seatByLabel = new Map(seats.map((seat) => [seat.label, seat]));

  function renderSeat(seat) {
    if (!seat) return <span className="seat-cell empty" />;
    const bookedGenderClass = seat.status === "booked" && seat.passengerGender ? `${seat.passengerGender}-booked` : "";
    const adjacentClass = femaleAdjacentSeatIds.has(seat.id) ? "female-adjacent" : "";
    const isHeld = heldIds.has(seat.id);
    const isPreview = !holds.length && previewSeatLabel && seat.label === previewSeatLabel && seat.status === "available";
    const unavailable = seat.status !== "available" && !isHeld;
    return (
      <button
        key={seat.id}
        disabled={disabled || unavailable}
        className={`seat ${seat.status} ${seatTier(seat)} ${bookedGenderClass} ${adjacentClass} ${isHeld || isPreview ? "selected" : ""} ${suggestionIds.has(seat.id) ? "suggested" : ""}`}
        onClick={() => onSeatClick(seat)}
        title={`${seat.label} / ${seatTier(seat)} / ${formatSeatPrice(seat)}`}
        aria-label={`${seat.label} ${seatTier(seat)} ${formatSeatPrice(seat)}`}
      >
        {unavailable ? <span className="seat-x">x</span> : <><span>{seat.label.replace(/^\d+/, "")}</span>{seatTier(seat) === "premium" && <small className="premium-tag">p</small>}</>}
      </button>
    );
  }

  return (
    <div className="select-seat-map-card">
      <div className="select-column-heads"><span>A</span><span>B</span><i /><span>C</span><span>D</span></div>
      <div className="select-seat-grid">
        {rows.map((row) => (
          <div className="select-seat-row" style={{ "--row-index": row }} key={row}>
            {renderSeat(seatByLabel.get(`${row}${columns[0]}`))}
            {renderSeat(seatByLabel.get(`${row}${columns[1]}`))}
            <span className="select-row-number">{row}</span>
            {renderSeat(seatByLabel.get(`${row}${columns[2]}`))}
            {renderSeat(seatByLabel.get(`${row}${columns[3]}`))}
          </div>
        ))}
      </div>
    </div>
  );
}

function HoldCard({ holds, fallbackSeat, onFallbackContinue, onPay, onGenderChange }) {
  const hasHolds = holds.length > 0;
  const displaySeat = hasHolds ? holds.map((seat) => seat.label).join(", ") : fallbackSeat?.label || "-";
  const total = hasHolds ? holds.reduce((sum, seat) => sum + seatPrice(seat), 0) : fallbackSeat ? seatPrice(fallbackSeat) : 0;
  return (
    <div className="info-card accent select-summary-card">
      <h3>Booking details</h3>
      <dl className="select-summary-list">
        <div><dt>{hasHolds ? "Your Seat" : "Recommended Seat"}</dt><dd>{hasHolds ? `Seat ${displaySeat}` : fallbackSeat ? `Seat ${displaySeat}` : "Choose a seat"}</dd></div>
        <div><dt>Total Price</dt><dd>Rs {total}</dd></div>
      </dl>
      {!hasHolds && <p className="ticket-suggestion">Recommended for comfort. Tap any seat on the map to change it.</p>}
      <div className="fare-summary"><span>General <b>Rs 449</b></span><span>Premium <b>Rs 649</b></span></div>
      {hasHolds && (
        <div className="seat-gender-list compact">
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
      )}
      <button className="primary wide continue-button" disabled={!hasHolds && !fallbackSeat} onClick={hasHolds ? onPay : onFallbackContinue}>{hasHolds ? "Continue" : "Use recommended"}</button>
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

