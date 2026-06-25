import "dotenv/config";
import http from "http";
import bcrypt from "bcryptjs";
import cookieParser from "cookie-parser";
import cors from "cors";
import express from "express";
import jwt from "jsonwebtoken";
import { Server } from "socket.io";
import { v4 as uuid } from "uuid";
import { publicUser } from "./data.js";
import { MemoryStore } from "./stores/memoryStore.js";
import { PostgresStore } from "./stores/postgresStore.js";

const PORT = Number(process.env.PORT || 4000);
const CLIENT_ORIGIN = process.env.CLIENT_ORIGIN || "http://127.0.0.1:5173";
const ACCESS_SECRET = process.env.JWT_ACCESS_SECRET || "dev-access-secret-change-me";
const REFRESH_SECRET = process.env.JWT_REFRESH_SECRET || "dev-refresh-secret-change-me";
const ALLOWED_ORIGINS = new Set([
  CLIENT_ORIGIN,
  "http://127.0.0.1:5173",
  "http://localhost:5173"
]);

function corsOrigin(origin, callback) {
  if (!origin || ALLOWED_ORIGINS.has(origin)) return callback(null, true);
  return callback(new Error("Origin not allowed by CORS."));
}

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: corsOrigin, credentials: true }
});
const USE_POSTGRES = process.env.USE_POSTGRES === "true";
const store = USE_POSTGRES ? new PostgresStore() : new MemoryStore();

app.use(cors({ origin: corsOrigin, credentials: true }));
app.use(express.json());
app.use(cookieParser());

function signAccess(user) {
  return jwt.sign(
    { sub: user.id, role: user.role, email: user.email, name: user.name, gender: user.gender },
    ACCESS_SECRET,
    { expiresIn: "15m" }
  );
}

async function signRefresh(user, familyId = uuid()) {
  const tokenId = uuid();
  const refreshToken = jwt.sign({ sub: user.id, jti: tokenId, familyId }, REFRESH_SECRET, { expiresIn: "7d" });
  await store.saveRefreshToken({
    id: tokenId,
    userId: user.id,
    familyId,
    tokenHash: await bcrypt.hash(refreshToken, 10),
    expiresAt: new Date(Date.now() + 7 * 24 * 60 * 60_000).toISOString(),
    revokedAt: null
  });
  return refreshToken;
}

async function issueTokens(user) {
  return {
    accessToken: signAccess(user),
    refreshToken: await signRefresh(user),
    user: publicUser(user)
  };
}

async function auth(req, res, next) {
  try {
    const header = req.headers.authorization || "";
    const token = header.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: "Authentication required." });
    const payload = jwt.verify(token, ACCESS_SECRET);
    const user = await store.findUserById(payload.sub);
    if (!user) return res.status(401).json({ error: "User no longer exists." });
    req.user = user;
    next();
  } catch {
    res.status(401).json({ error: "Access token expired or invalid." });
  }
}

function adminOnly(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ error: "Admin access required." });
  next();
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function emitSchedule(schedule) {
  if (schedule?.id) io.to(schedule.id).emit("schedule:update", schedule);
}

async function emitNotifications(userId) {
  io.to(`user:${userId}`).emit("notifications:update", await store.getNotifications(userId));
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, mode: USE_POSTGRES ? "supabase-postgres" : "memory-demo" });
});

app.post("/api/auth/register", asyncRoute(async (req, res) => {
  const { name, email, password, gender = "other", age = "", phone = "", universityId = "" } = req.body;
  if (!name || !email || !password) return res.status(400).json({ error: "Name, email, and password are required." });
  if (password.length < 8) return res.status(400).json({ error: "Password must be at least 8 characters." });
  const passwordHash = await bcrypt.hash(password, 10);
  const user = await store.createUser({ name, email: email.toLowerCase(), passwordHash, gender, age, phone, universityId });
  const fullUser = await store.findUserById(user.id);
  res.status(201).json(await issueTokens(fullUser));
}));

app.post("/api/auth/login", asyncRoute(async (req, res) => {
  const { email, password } = req.body;
  const user = await store.findUserByEmail(String(email || "").toLowerCase());
  if (!user || !(await bcrypt.compare(password || "", user.passwordHash))) {
    return res.status(401).json({ error: "Invalid email or password." });
  }
  res.json(await issueTokens(user));
}));

app.post("/api/auth/refresh", asyncRoute(async (req, res) => {
  const raw = req.body.refreshToken || req.cookies.refreshToken;
  if (!raw) return res.status(401).json({ error: "Refresh token required." });

  let payload;
  try {
    payload = jwt.verify(raw, REFRESH_SECRET);
  } catch {
    return res.status(401).json({ error: "Refresh token expired or invalid." });
  }

  const tokenRecord = await store.getRefreshToken(payload.jti);
  if (!tokenRecord || tokenRecord.revokedAt || new Date(tokenRecord.expiresAt) <= new Date()) {
    if (payload.familyId) await store.revokeRefreshFamily(payload.familyId);
    return res.status(401).json({ error: "Refresh token rejected." });
  }
  const matches = await bcrypt.compare(raw, tokenRecord.tokenHash);
  if (!matches) {
    await store.revokeRefreshFamily(payload.familyId);
    return res.status(401).json({ error: "Refresh token replay detected." });
  }

  await store.revokeRefreshToken(payload.jti);
  const user = await store.findUserById(payload.sub);
  res.json({
    accessToken: signAccess(user),
    refreshToken: await signRefresh(user, payload.familyId),
    user: publicUser(user)
  });
}));

app.post("/api/auth/logout", auth, asyncRoute(async (req, res) => {
  const { refreshToken } = req.body;
  if (refreshToken) {
    try {
      const payload = jwt.verify(refreshToken, REFRESH_SECRET);
      await store.revokeRefreshFamily(payload.familyId);
    } catch {
      // The access token already proves the logout caller.
    }
  }
  res.json({ ok: true });
}));

app.get("/api/me", auth, asyncRoute(async (req, res) => {
  res.json({ user: publicUser(req.user), notifications: await store.getNotifications(req.user.id) });
}));

app.get("/api/locations", asyncRoute(async (_req, res) => {
  res.json({ locations: await store.getLocations() });
}));

app.get("/api/schedules", asyncRoute(async (req, res) => {
  res.json({ schedules: await store.searchSchedules(req.query) });
}));

app.get("/api/schedules/:scheduleId", asyncRoute(async (req, res) => {
  const schedule = await store.getSchedule(req.params.scheduleId);
  if (!schedule) return res.status(404).json({ error: "Schedule not found." });
  res.json({ schedule, waitlist: await store.publicWaitlist(req.params.scheduleId) });
}));

app.post("/api/schedules/:scheduleId/seats/:seatId/lock", auth, asyncRoute(async (req, res) => {
  const result = await store.lockSeat(req.params.scheduleId, req.params.seatId, req.user);
  emitSchedule(result.schedule);
  await emitNotifications(req.user.id);
  res.json(result);
}));

app.delete("/api/schedules/:scheduleId/seats/:seatId/lock", auth, asyncRoute(async (req, res) => {
  const result = await store.releaseSeatLock(req.params.scheduleId, req.params.seatId, req.user, req.body);
  emitSchedule(result.schedule);
  res.json(result);
}));

app.post("/api/schedules/:scheduleId/seats/:seatId/book", auth, asyncRoute(async (req, res) => {
  const result = await store.bookSeat(req.params.scheduleId, req.params.seatId, req.user, req.body);
  emitSchedule(result.schedule);
  await emitNotifications(req.user.id);
  res.json(result);
}));

app.post("/api/schedules/:scheduleId/bookings/confirm", auth, asyncRoute(async (req, res) => {
  const result = await store.confirmSeats(req.params.scheduleId, req.user, req.body);
  emitSchedule(result.schedule);
  await emitNotifications(req.user.id);
  res.json(result);
}));

app.post("/api/schedules/:scheduleId/check-in", auth, asyncRoute(async (req, res) => {
  const result = await store.checkIn(req.params.scheduleId, req.user);
  emitSchedule(result.schedule);
  await emitNotifications(req.user.id);
  res.json(result);
}));

app.post("/api/schedules/:scheduleId/waitlist", auth, asyncRoute(async (req, res) => {
  const result = await store.joinWaitlist(req.params.scheduleId, req.user);
  emitSchedule(result.schedule);
  io.to(req.params.scheduleId).emit("waitlist:update", result.waitlist);
  await emitNotifications(req.user.id);
  res.json(result);
}));

app.get("/api/schedules/:scheduleId/female-suggestions", auth, asyncRoute(async (req, res) => {
  res.json({ suggestions: await store.getFemaleSuggestions(req.params.scheduleId) });
}));

app.post("/api/schedules/:scheduleId/chat", auth, asyncRoute(async (req, res) => {
  const message = await store.addChatMessage(req.params.scheduleId, req.user, req.body.message);
  io.to(req.params.scheduleId).emit("chat:new", message);
  res.status(201).json({ message });
}));

app.post("/api/schedules/:scheduleId/rides", auth, asyncRoute(async (req, res) => {
  const ride = await store.addRide(req.params.scheduleId, req.user, req.body);
  io.to(req.params.scheduleId).emit("ride:new", ride);
  res.status(201).json({ ride });
}));

app.get("/api/admin/overview", auth, adminOnly, asyncRoute(async (_req, res) => {
  res.json(await store.adminSnapshot());
}));

app.post("/api/admin/schedules", auth, adminOnly, asyncRoute(async (req, res) => {
  const schedule = await store.createSchedule(req.body);
  emitSchedule(schedule);
  res.status(201).json({ schedule });
}));

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (!token) return next();
  try {
    const payload = jwt.verify(token, ACCESS_SECRET);
    socket.userId = payload.sub;
    next();
  } catch {
    next();
  }
});

io.on("connection", (socket) => {
  if (socket.userId) socket.join(`user:${socket.userId}`);

  socket.on("schedule:join", (scheduleId) => {
    socket.join(scheduleId);
  });

  socket.on("schedule:leave", (scheduleId) => {
    socket.leave(scheduleId);
  });
});

app.use((err, _req, res, _next) => {
  const status = err.status || 500;
  if (status >= 500) console.error(err);
  res.status(status).json({ error: err.message || "Something went wrong." });
});

await store.init();

setInterval(async () => {
  try {
    const lockUpdates = await store.releaseExpiredLocks();
    lockUpdates.forEach(emitSchedule);
    const reallocations = await store.runReallocation();
    reallocations.forEach(emitSchedule);
  } catch (error) {
    console.warn("Background seat maintenance skipped:", error.message || error);
  }
}, 5_000);

server.listen(PORT, () => {
  console.log(`Amity BusLive API running on http://127.0.0.1:${PORT}`);
});
