import bcrypt from "bcryptjs";
import { v4 as uuid } from "uuid";
import {
  buildSeatLayout,
  LOCATIONS,
  makeScheduleTimes,
  publicUser,
  scheduleWindow,
  seatNeighborNumbers
} from "../data.js";

const LOCK_MS = 6 * 60_000;

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function seatCounts(seats) {
  const booked = seats.filter((seat) => seat.status === "booked").length;
  const locked = seats.filter((seat) => seat.status === "locked").length;
  return {
    capacity: seats.length,
    booked,
    locked,
    available: seats.length - booked - locked
  };
}

function serializeSchedule(schedule) {
  const windows = scheduleWindow(schedule.departureAt);
  return {
    ...clone(schedule),
    ...windows,
    counts: seatCounts(schedule.seats)
  };
}

function isAdjacentToFemaleSeat(seat, seats) {
  const femaleNumbers = new Set(
    seats
      .filter((item) => item.status === "booked" && item.passengerGender === "female")
      .map((item) => item.number)
  );
  return seatNeighborNumbers(seat.number).some((number) => femaleNumbers.has(number));
}

function hasOpenNonFemaleAdjacentSeat(seats, heldSelectionIds, userId) {
  return seats.some((seat) => {
    const selectable = seat.status === "available" || (seat.status === "locked" && seat.lockedBy === userId && heldSelectionIds.has(seat.id));
    return selectable && !isAdjacentToFemaleSeat(seat, seats);
  });
}

export class MemoryStore {
  constructor() {
    this.users = new Map();
    this.refreshTokens = new Map();
    this.schedules = new Map();
    this.waitlist = new Map();
    this.notifications = new Map();
    this.locks = new Map();
  }

  async init() {
    await this.seed();
  }

  async seed() {
    const demoUsers = [
      ["student", "Aarav Student", "student@amity.edu", "male", "student", 21],
      ["female", "Nisha Student", "female@amity.edu", "female", "student", 20],
      ["admin", "Transport Admin", "admin@amity.edu", "other", "admin", 34]
    ];

    for (const [id, name, email, gender, role, age] of demoUsers) {
      const passwordHash = await bcrypt.hash("Password123", 10);
      this.users.set(id, {
        id,
        name,
        email,
        gender,
        role,
        age,
        passwordHash,
        phone: "",
        universityId: email === "admin@amity.edu" ? "ADMIN-AUR" : "AUR2026"
      });
    }

    makeScheduleTimes().forEach(([source, destination, departureAt, busName], index) => {
      const id = `sch-${index + 1}`;
      const schedule = {
        id,
        routeId: `route-${index + 1}`,
        busId: `bus-${(index % 4) + 1}`,
        busName,
        source,
        destination,
        departureAt: departureAt.toISOString(),
        status: "scheduled",
        reallocatedAt: null,
        seats: buildSeatLayout(id),
        chat: [],
        rides: []
      };

      if (index === 0) {
        this.demoBook(schedule, 7, "female");
        this.demoBook(schedule, 19, "student");
      }

      this.schedules.set(id, schedule);
      this.waitlist.set(id, []);
    });
  }

  demoBook(schedule, number, userId) {
    const seat = schedule.seats.find((item) => item.number === number);
    const user = this.users.get(userId);
    seat.status = "booked";
    seat.bookingId = uuid();
    seat.bookedBy = userId;
    seat.passengerGender = user.gender;
    seat.checkedInAt = null;
  }

  async withLock(key, action) {
    const previous = this.locks.get(key) || Promise.resolve();
    let release;
    const current = new Promise((resolve) => {
      release = resolve;
    });
    this.locks.set(key, current);
    await previous;
    try {
      return await action();
    } finally {
      release();
      if (this.locks.get(key) === current) this.locks.delete(key);
    }
  }

  async withSeatLock(scheduleId, seatId, action) {
    return this.withLock(`${scheduleId}:seat:${seatId}`, action);
  }

  async withScheduleLock(scheduleId, action) {
    return this.withLock(`${scheduleId}:booking`, action);
  }

  async createUser(input) {
    if ([...this.users.values()].some((user) => user.email === input.email)) {
      const error = new Error("Email already registered.");
      error.status = 409;
      throw error;
    }
    const id = uuid();
    const user = { id, role: "student", ...input };
    this.users.set(id, user);
    return publicUser(user);
  }

  async findUserByEmail(email) {
    return [...this.users.values()].find((user) => user.email === email) || null;
  }

  async findUserById(id) {
    return this.users.get(id) || null;
  }

  async saveRefreshToken(token) {
    this.refreshTokens.set(token.id, token);
  }

  async getRefreshToken(id) {
    return this.refreshTokens.get(id) || null;
  }

  async revokeRefreshToken(id) {
    const token = this.refreshTokens.get(id);
    if (token) token.revokedAt = new Date().toISOString();
  }

  async revokeRefreshFamily(familyId) {
    for (const token of this.refreshTokens.values()) {
      if (token.familyId === familyId) token.revokedAt = new Date().toISOString();
    }
  }

  async getLocations() {
    return LOCATIONS;
  }

  async searchSchedules({ source, destination }) {
    await this.releaseExpiredLocks();
    return [...this.schedules.values()]
      .filter((schedule) => !source || schedule.source === source)
      .filter((schedule) => !destination || schedule.destination === destination)
      .sort((a, b) => new Date(a.departureAt) - new Date(b.departureAt))
      .map(serializeSchedule);
  }

  async getSchedule(scheduleId) {
    await this.releaseExpiredLocks();
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) return null;
    return serializeSchedule(schedule);
  }

  async lockSeat(scheduleId, seatId, user) {
    return this.withSeatLock(scheduleId, seatId, async () => {
      await this.releaseExpiredLocks(scheduleId);
      const schedule = this.schedules.get(scheduleId);
      if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });

      const windows = scheduleWindow(schedule.departureAt);
      const now = new Date();
      if (now < windows.bookingOpenAt) {
        throw Object.assign(new Error("Booking opens one hour before departure."), { status: 423 });
      }
      if (now >= new Date(schedule.departureAt)) {
        throw Object.assign(new Error("This bus has departed."), { status: 410 });
      }

      const seat = schedule.seats.find((item) => item.id === seatId);
      if (!seat) throw Object.assign(new Error("Seat not found."), { status: 404 });
      if (seat.status !== "available") {
        throw Object.assign(new Error("Seat is no longer available."), { status: 409 });
      }

      seat.status = "locked";
      seat.lockId = uuid();
      seat.lockedBy = user.id;
      seat.lockExpiresAt = new Date(now.getTime() + LOCK_MS).toISOString();

      this.notify(user.id, "Seat held for 6 minutes. Complete payment to confirm.");
      return { seat: clone(seat), schedule: serializeSchedule(schedule) };
    });
  }

  async releaseSeatLock(scheduleId, seatId, user, { lockId } = {}) {
    return this.withSeatLock(scheduleId, seatId, async () => {
      const schedule = this.schedules.get(scheduleId);
      if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });
      const seat = schedule.seats.find((item) => item.id === seatId);
      if (!seat) throw Object.assign(new Error("Seat not found."), { status: 404 });
      if (seat.status !== "locked" || seat.lockedBy !== user.id || (lockId && seat.lockId !== lockId)) {
        throw Object.assign(new Error("Your temporary seat lock is not active."), { status: 409 });
      }

      seat.status = "available";
      seat.lockId = null;
      seat.lockedBy = null;
      seat.lockExpiresAt = null;
      return { schedule: serializeSchedule(schedule) };
    });
  }

  async bookSeat(scheduleId, seatId, user, { lockId, preferFemale }) {
    return this.withSeatLock(scheduleId, seatId, async () => {
      const schedule = this.schedules.get(scheduleId);
      if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });
      const seat = schedule.seats.find((item) => item.id === seatId);
      if (!seat) throw Object.assign(new Error("Seat not found."), { status: 404 });

      const now = new Date();
      if (seat.status !== "locked" || seat.lockId !== lockId || seat.lockedBy !== user.id) {
        throw Object.assign(new Error("Your temporary seat lock is not active."), { status: 409 });
      }
      if (new Date(seat.lockExpiresAt) <= now) {
        seat.status = "available";
        seat.lockId = null;
        seat.lockedBy = null;
        seat.lockExpiresAt = null;
        throw Object.assign(new Error("Seat lock expired."), { status: 409 });
      }

      seat.status = "booked";
      seat.bookingId = uuid();
      seat.lockId = null;
      seat.lockedBy = null;
      seat.lockExpiresAt = null;
      seat.passengerGender = user.gender;
      seat.bookedBy = user.id;
      seat.preferFemale = Boolean(preferFemale);
      seat.checkedInAt = null;

      this.notify(user.id, `Booking confirmed for seat ${seat.label}.`);
      return { bookingId: seat.bookingId, seat: clone(seat), schedule: serializeSchedule(schedule) };
    });
  }

  async confirmSeats(scheduleId, user, { seats = [], preferFemale = false }) {
    return this.withScheduleLock(scheduleId, async () => {
      const schedule = this.schedules.get(scheduleId);
      if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });
      if (!Array.isArray(seats) || seats.length === 0) {
        throw Object.assign(new Error("Select at least one held seat to confirm."), { status: 400 });
      }

      const now = new Date();
      const uniqueSelections = [...new Map(seats.map((item) => [item.seatId, item])).values()];
      const heldSelectionIds = new Set(uniqueSelections.map((item) => item.seatId));
      const hasMaleAlternative = hasOpenNonFemaleAdjacentSeat(schedule.seats, heldSelectionIds, user.id);
      const targetSeats = uniqueSelections.map((item) => {
        const seat = schedule.seats.find((candidate) => candidate.id === item.seatId);
        if (!seat) throw Object.assign(new Error("Seat not found."), { status: 404 });
        if (seat.status !== "locked" || seat.lockId !== item.lockId || seat.lockedBy !== user.id) {
          throw Object.assign(new Error(`Seat ${seat.label} is no longer held by you.`), { status: 409 });
        }
        if (new Date(seat.lockExpiresAt) <= now) {
          seat.status = "available";
          seat.lockId = null;
          seat.lockedBy = null;
          seat.lockExpiresAt = null;
          throw Object.assign(new Error(`Seat ${seat.label} hold expired.`), { status: 409 });
        }
        const passengerGender = item.passengerGender || user.gender || "other";
        if (passengerGender !== "female" && isAdjacentToFemaleSeat(seat, schedule.seats) && hasMaleAlternative) {
          throw Object.assign(new Error(`Seat ${seat.label} is beside a female passenger. Choose a female passenger for this seat or pick another available seat.`), { status: 409 });
        }
        return seat;
      });

      for (const seat of targetSeats) {
        const selection = uniqueSelections.find((item) => item.seatId === seat.id);
        seat.status = "booked";
        seat.bookingId = uuid();
        seat.lockId = null;
        seat.lockedBy = null;
        seat.lockExpiresAt = null;
        seat.passengerGender = selection?.passengerGender || user.gender || "other";
        seat.bookedBy = user.id;
        seat.preferFemale = Boolean(preferFemale);
        seat.checkedInAt = null;
      }

      const labels = targetSeats.map((seat) => seat.label).join(", ");
      this.notify(user.id, `Booking confirmed for ${labels}.`);
      return {
        bookingIds: targetSeats.map((seat) => seat.bookingId),
        seats: clone(targetSeats),
        schedule: serializeSchedule(schedule)
      };
    });
  }

  async checkIn(scheduleId, user) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });
    const windows = scheduleWindow(schedule.departureAt);
    const now = new Date();
    if (now < windows.checkInStartAt || now > windows.reallocationAt) {
      throw Object.assign(new Error("Check-in is open only from minute 40 to minute 50 of the booking window."), { status: 409 });
    }
    const target = schedule.seats.find((item) => item.status === "booked" && this.bookingBelongsToUser(item, user));
    if (!target) throw Object.assign(new Error("No confirmed booking found."), { status: 404 });
    target.checkedInAt = now.toISOString();
    this.notify(user.id, `Check-in confirmed for seat ${target.label}.`);
    return { seat: clone(target), schedule: serializeSchedule(schedule) };
  }

  bookingBelongsToUser(seat, user) {
    return seat.bookedBy === user.id;
  }

  async joinWaitlist(scheduleId, user) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });
    const queue = this.waitlist.get(scheduleId) || [];
    if (!queue.some((item) => item.userId === user.id)) {
      queue.push({ id: uuid(), userId: user.id, name: user.name, joinedAt: new Date().toISOString(), priority: user.gender === "female" ? 1 : 2 });
      queue.sort((a, b) => a.priority - b.priority || new Date(a.joinedAt) - new Date(b.joinedAt));
      this.waitlist.set(scheduleId, queue);
    }
    const position = queue.findIndex((item) => item.userId === user.id) + 1;
    this.notify(user.id, `You joined the waitlist at position ${position}.`);
    return { position, waitlist: this.publicWaitlist(scheduleId), schedule: serializeSchedule(schedule) };
  }

  async getFemaleSuggestions(scheduleId) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });
    const suggestions = [];
    for (const bookedSeat of schedule.seats.filter((seat) => seat.status === "booked" && seat.passengerGender === "female")) {
      for (const number of seatNeighborNumbers(bookedSeat.number)) {
        const seat = schedule.seats.find((item) => item.number === number);
        if (seat && seat.status === "available") {
          suggestions.push({
            seatId: seat.id,
            label: seat.label,
            reason: "Adjacent to a confirmed female passenger"
          });
        }
      }
    }
    return suggestions;
  }

  async addChatMessage(scheduleId, user, message) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });
    const item = {
      id: uuid(),
      userId: user.id,
      name: user.name,
      message: String(message || "").slice(0, 400),
      createdAt: new Date().toISOString()
    };
    schedule.chat.push(item);
    return item;
  }

  async addRide(scheduleId, user, input) {
    const schedule = this.schedules.get(scheduleId);
    if (!schedule) throw Object.assign(new Error("Schedule not found."), { status: 404 });
    const item = {
      id: uuid(),
      userId: user.id,
      name: user.name,
      from: input.from || schedule.source,
      to: input.to || schedule.destination,
      seatsNeeded: Number(input.seatsNeeded || 1),
      notes: String(input.notes || "").slice(0, 240),
      createdAt: new Date().toISOString()
    };
    schedule.rides.push(item);
    return item;
  }

  async createSchedule(input) {
    const id = `sch-${uuid().slice(0, 8)}`;
    const schedule = {
      id,
      routeId: `route-${uuid().slice(0, 8)}`,
      busId: `bus-${uuid().slice(0, 8)}`,
      busName: input.busName || "AUR Shuttle",
      source: input.source,
      destination: input.destination,
      departureAt: new Date(input.departureAt).toISOString(),
      status: "scheduled",
      reallocatedAt: null,
      seats: buildSeatLayout(id),
      chat: [],
      rides: []
    };
    this.schedules.set(id, schedule);
    this.waitlist.set(id, []);
    return serializeSchedule(schedule);
  }

  async releaseExpiredLocks(onlyScheduleId) {
    const updates = [];
    for (const schedule of this.schedules.values()) {
      if (onlyScheduleId && schedule.id !== onlyScheduleId) continue;
      let changed = false;
      for (const seat of schedule.seats) {
        if (seat.status === "locked" && seat.lockExpiresAt && new Date(seat.lockExpiresAt) <= new Date()) {
          const userId = seat.lockedBy;
          seat.status = "available";
          seat.lockId = null;
          seat.lockedBy = null;
          seat.lockExpiresAt = null;
          this.notify(userId, `Your hold on seat ${seat.label} expired.`);
          changed = true;
        }
      }
      if (changed) updates.push(serializeSchedule(schedule));
    }
    return updates;
  }

  async runReallocation() {
    const updates = [];
    for (const schedule of this.schedules.values()) {
      const windows = scheduleWindow(schedule.departureAt);
      const now = new Date();
      if (now < windows.reallocationAt || now > new Date(schedule.departureAt)) continue;
      if (schedule.reallocatedAt) continue;

      const released = schedule.seats.filter((seat) => seat.status === "booked" && !seat.checkedInAt);
      const queue = this.waitlist.get(schedule.id) || [];
      if (!released.length) {
        schedule.reallocatedAt = now.toISOString();
        continue;
      }

      for (const seat of released) {
        const next = queue.shift();
        if (!next) {
          this.notify(seat.bookedBy, `Seat ${seat.label} was released because check-in was not completed.`);
          seat.status = "available";
          seat.bookingId = null;
          seat.bookedBy = null;
          seat.passengerGender = null;
          continue;
        }
        seat.bookingId = uuid();
        seat.bookedBy = next.userId;
        seat.passengerGender = "other";
        seat.checkedInAt = null;
        this.notify(next.userId, `You were allocated seat ${seat.label} from the waitlist.`);
      }
      schedule.reallocatedAt = now.toISOString();
      updates.push(serializeSchedule(schedule));
    }
    return updates;
  }

  publicWaitlist(scheduleId) {
    return (this.waitlist.get(scheduleId) || []).map((item, index) => ({
      id: item.id,
      name: item.name,
      position: index + 1,
      joinedAt: item.joinedAt
    }));
  }

  notify(userId, message) {
    if (!userId) return;
    const list = this.notifications.get(userId) || [];
    list.unshift({ id: uuid(), message, createdAt: new Date().toISOString(), read: false });
    this.notifications.set(userId, list.slice(0, 30));
  }

  async getNotifications(userId) {
    return this.notifications.get(userId) || [];
  }

  async adminSnapshot() {
    const schedules = await this.searchSchedules({});
    return {
      users: [...this.users.values()].map(publicUser),
      schedules,
      bookings: schedules.flatMap((schedule) =>
        schedule.seats
          .filter((seat) => seat.status === "booked")
          .map((seat) => ({ scheduleId: schedule.id, seat: seat.label, route: `${schedule.source} -> ${schedule.destination}` }))
      ),
      waitlists: [...this.waitlist.entries()].map(([scheduleId, queue]) => ({ scheduleId, count: queue.length }))
    };
  }
}
