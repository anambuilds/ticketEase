import bcrypt from "bcryptjs";
import fs from "fs/promises";
import { Pool } from "pg";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import {
  LOCATIONS,
  makeScheduleTimes,
  publicUser,
  scheduleWindow,
  seatNeighborNumbers
} from "../data.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOCK_MS = 6 * 60_000;

function camelUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    email: row.email,
    passwordHash: row.password_hash,
    gender: row.gender,
    role: row.role,
    age: row.age || "",
    phone: row.phone || "",
    universityId: row.university_id || ""
  };
}

function camelToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    userId: row.user_id,
    familyId: row.family_id,
    tokenHash: row.token_hash,
    expiresAt: row.expires_at,
    revokedAt: row.revoked_at
  };
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

function seatFromRow(row) {
  return {
    id: row.id,
    number: row.seat_number,
    label: row.label,
    row: row.row_number,
    col: row.col_number,
    status: row.status,
    lockId: row.lock_id,
    lockedBy: row.locked_by,
    lockExpiresAt: row.lock_expires_at,
    bookingId: row.booking_id,
    bookedBy: row.booked_by,
    passengerGender: row.passenger_gender,
    preferFemale: row.prefer_female,
    checkedInAt: row.checked_in_at
  };
}

function serializeSchedule(row, seats = [], chat = [], rides = []) {
  const schedule = {
    id: row.id,
    routeId: row.route_id,
    busId: row.bus_id,
    busName: row.bus_name,
    source: row.source,
    destination: row.destination,
    departureAt: row.departure_at,
    status: row.status,
    reallocatedAt: row.reallocated_at,
    seats,
    chat,
    rides
  };
  return {
    ...schedule,
    ...scheduleWindow(schedule.departureAt),
    counts: seatCounts(seats)
  };
}

function raise(message, status = 400) {
  const error = new Error(message);
  error.status = status;
  throw error;
}

function isAdjacentToFemaleSeat(seat, seats) {
  const femaleNumbers = new Set(
    seats
      .filter((item) => item.status === "booked" && item.passenger_gender === "female")
      .map((item) => item.seat_number)
  );
  return seatNeighborNumbers(seat.seat_number).some((number) => femaleNumbers.has(number));
}

function hasOpenNonFemaleAdjacentSeat(seats, heldSelectionIds, userId) {
  return seats.some((seat) => {
    const selectable = seat.status === "available" || (seat.status === "locked" && seat.locked_by === userId && heldSelectionIds.has(seat.id));
    return selectable && !isAdjacentToFemaleSeat(seat, seats);
  });
}

export class PostgresStore {
  constructor() {
    const connectionString = process.env.DATABASE_URL || process.env.SUPABASE_DB_POOLER_URL;
    if (!connectionString) raise("DATABASE_URL is required when USE_POSTGRES=true.", 500);
    this.pool = new Pool({
      connectionString,
      ssl: { rejectUnauthorized: false }
    });
  }

  async close() {
    await this.pool.end();
  }

  async init() {
    await this.ensureSchema();
    await this.seed();
  }

  async ensureSchema() {
    const schemaPath = resolve(__dirname, "../../supabase/schema.sql");
    const schema = await fs.readFile(schemaPath, "utf8");
    await this.pool.query(schema);
    await this.pool.query("alter table app_users add column if not exists age int");
    await this.pool.query("alter table schedules add column if not exists reallocated_at timestamptz");
  }

  async seed() {
    const passwordHash = await bcrypt.hash("Password123", 10);
    const users = [
      ["Aarav Student", "student@amity.edu", "male", "student", 21, "AUR2026"],
      ["Nisha Student", "female@amity.edu", "female", "student", 20, "AUR2026"],
      ["Transport Admin", "admin@amity.edu", "other", "admin", 34, "ADMIN-AUR"]
    ];

    for (const [name, email, gender, role, age, universityId] of users) {
      await this.pool.query(
        `insert into app_users (name, email, password_hash, gender, role, age, university_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         on conflict (email) do update
         set name = excluded.name,
             password_hash = excluded.password_hash,
             gender = excluded.gender,
             role = excluded.role,
             age = excluded.age,
             university_id = excluded.university_id`,
        [name, email, passwordHash, gender, role, age, universityId]
      );
    }

    const scheduleState = await this.pool.query("select count(*)::int as count, max(departure_at) as latest_departure from schedules");
    if (scheduleState.rows[0].count >= 10 && new Date(scheduleState.rows[0].latest_departure) > new Date()) return;
    if (scheduleState.rows[0].count > 0) {
      await this.pool.query("truncate schedules, buses, routes restart identity cascade");
    }

    for (const [source, destination, departureAt, busName] of makeScheduleTimes()) {
      const bus = await this.pool.query(
        `insert into buses (name, capacity)
         values ($1, 40)
         returning id`,
        [busName]
      );
      const route = await this.pool.query(
        `insert into routes (source, destination)
         values ($1, $2)
         on conflict (source, destination) do update set active = true
         returning id`,
        [source, destination]
      );
      const schedule = await this.pool.query(
        `insert into schedules (route_id, bus_id, departure_at)
         values ($1, $2, $3)
         returning id`,
        [route.rows[0].id, bus.rows[0].id, departureAt.toISOString()]
      );
      await this.seedSeats(schedule.rows[0].id);
    }

    const firstSchedule = await this.pool.query("select id from schedules order by departure_at limit 1");
    if (firstSchedule.rows[0]) {
      await this.demoBook(firstSchedule.rows[0].id, 7, "female@amity.edu");
      await this.demoBook(firstSchedule.rows[0].id, 19, "student@amity.edu");
    }
  }

  async seedSeats(scheduleId) {
    for (let i = 1; i <= 40; i += 1) {
      const zero = i - 1;
      const row = Math.floor(zero / 4) + 1;
      const col = zero % 4;
      await this.pool.query(
        `insert into schedule_seats (schedule_id, seat_number, label, row_number, col_number)
         values ($1, $2, $3, $4, $5)
         on conflict (schedule_id, seat_number) do nothing`,
        [scheduleId, i, `${row}${["A", "B", "C", "D"][col]}`, row, col]
      );
    }
  }

  async demoBook(scheduleId, seatNumber, email) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const userResult = await client.query("select * from app_users where email = $1", [email]);
      const seatResult = await client.query(
        "select * from schedule_seats where schedule_id = $1 and seat_number = $2 for update",
        [scheduleId, seatNumber]
      );
      const user = userResult.rows[0];
      const seat = seatResult.rows[0];
      if (!user || !seat || seat.status === "booked") {
        await client.query("commit");
        return;
      }
      const booking = await client.query(
        "insert into bookings (schedule_id, seat_id, user_id) values ($1, $2, $3) returning id",
        [scheduleId, seat.id, user.id]
      );
      await client.query(
        `update schedule_seats
         set status = 'booked',
             booked_by = $1,
             passenger_gender = $2
         where id = $3`,
        [user.id, user.gender, seat.id]
      );
      await client.query("commit");
      return booking.rows[0].id;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async createUser(input) {
    try {
      const result = await this.pool.query(
        `insert into app_users (name, email, password_hash, gender, age, phone, university_id)
         values ($1, $2, $3, $4, $5, $6, $7)
         returning *`,
        [
          input.name,
          input.email,
          input.passwordHash,
          input.gender,
          input.age ? Number(input.age) : null,
          input.phone || "",
          input.universityId || ""
        ]
      );
      return publicUser(camelUser(result.rows[0]));
    } catch (error) {
      if (error.code === "23505") raise("Email already registered.", 409);
      throw error;
    }
  }

  async findUserByEmail(email) {
    const result = await this.pool.query("select * from app_users where email = $1", [email]);
    return camelUser(result.rows[0]);
  }

  async findUserById(id) {
    const result = await this.pool.query("select * from app_users where id = $1", [id]);
    return camelUser(result.rows[0]);
  }

  async saveRefreshToken(token) {
    await this.pool.query(
      `insert into refresh_tokens (id, user_id, family_id, token_hash, expires_at, revoked_at)
       values ($1, $2, $3, $4, $5, $6)`,
      [token.id, token.userId, token.familyId, token.tokenHash, token.expiresAt, token.revokedAt]
    );
  }

  async getRefreshToken(id) {
    const result = await this.pool.query("select * from refresh_tokens where id = $1", [id]);
    return camelToken(result.rows[0]);
  }

  async revokeRefreshToken(id) {
    await this.pool.query("update refresh_tokens set revoked_at = now() where id = $1", [id]);
  }

  async revokeRefreshFamily(familyId) {
    await this.pool.query("update refresh_tokens set revoked_at = now() where family_id = $1", [familyId]);
  }

  async getLocations() {
    return LOCATIONS;
  }

  async scheduleRows({ source, destination } = {}) {
    const params = [];
    const clauses = [];
    if (source) {
      params.push(source);
      clauses.push(`r.source = $${params.length}`);
    }
    if (destination) {
      params.push(destination);
      clauses.push(`r.destination = $${params.length}`);
    }
    const where = clauses.length ? `where ${clauses.join(" and ")}` : "";
    const result = await this.pool.query(
      `select s.*, r.source, r.destination, b.name as bus_name
       from schedules s
       join routes r on r.id = s.route_id
       join buses b on b.id = s.bus_id
       ${where}
       order by s.departure_at`,
      params
    );
    return result.rows;
  }

  async seatsFor(scheduleId, client = this.pool) {
    const result = await client.query(
      `select ss.*,
              b.id as booking_id
       from schedule_seats ss
       left join bookings b on b.seat_id = ss.id and b.status = 'confirmed'
       where ss.schedule_id = $1
       order by ss.seat_number`,
      [scheduleId]
    );
    return result.rows.map(seatFromRow);
  }

  async chatFor(scheduleId) {
    const result = await this.pool.query(
      `select m.id, m.user_id, u.name, m.message, m.created_at
       from waitlist_chat_messages m
       join app_users u on u.id = m.user_id
       where m.schedule_id = $1
       order by m.created_at`,
      [scheduleId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      message: row.message,
      createdAt: row.created_at
    }));
  }

  async ridesFor(scheduleId) {
    const result = await this.pool.query(
      `select r.*, u.name
       from shared_ride_requests r
       join app_users u on u.id = r.user_id
       where r.schedule_id = $1
       order by r.created_at`,
      [scheduleId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      from: row.ride_from,
      to: row.ride_to,
      seatsNeeded: row.seats_needed,
      notes: row.notes,
      createdAt: row.created_at
    }));
  }

  async hydrateSchedule(row, client = this.pool) {
    return serializeSchedule(
      row,
      await this.seatsFor(row.id, client),
      await this.chatFor(row.id),
      await this.ridesFor(row.id)
    );
  }

  async searchSchedules(query) {
    await this.releaseExpiredLocks();
    const rows = await this.scheduleRows(query);
    return Promise.all(rows.map((row) => this.hydrateSchedule(row)));
  }

  async getSchedule(scheduleId, client = this.pool) {
    await this.releaseExpiredLocks(scheduleId);
    const result = await client.query(
      `select s.*, r.source, r.destination, b.name as bus_name
       from schedules s
       join routes r on r.id = s.route_id
       join buses b on b.id = s.bus_id
       where s.id = $1`,
      [scheduleId]
    );
    if (!result.rows[0]) return null;
    return this.hydrateSchedule(result.rows[0], client);
  }

  async lockSeat(scheduleId, seatId, user) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      await this.releaseExpiredLocks(scheduleId, client);
      const scheduleResult = await client.query("select * from schedules where id = $1", [scheduleId]);
      const schedule = scheduleResult.rows[0];
      if (!schedule) raise("Schedule not found.", 404);
      const now = new Date();
      if (now >= new Date(schedule.departure_at)) raise("This bus has departed.", 410);

      const seatResult = await client.query(
        "select * from schedule_seats where id = $1 and schedule_id = $2 for update",
        [seatId, scheduleId]
      );
      const seat = seatResult.rows[0];
      if (!seat) raise("Seat not found.", 404);
      if (seat.status !== "available") raise("Seat is no longer available.", 409);

      const lockResult = await client.query(
        `update schedule_seats
         set status = 'locked',
             locked_by = $1,
             lock_id = gen_random_uuid(),
             lock_expires_at = $2
         where id = $3
         returning *`,
        [user.id, new Date(now.getTime() + LOCK_MS).toISOString(), seatId]
      );
      await this.notify(user.id, "Seat held for 6 minutes. Complete payment to confirm.", client);
      const nextSchedule = await this.getSchedule(scheduleId, client);
      await client.query("commit");
      return { seat: seatFromRow(lockResult.rows[0]), schedule: nextSchedule };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseSeatLock(scheduleId, seatId, user, { lockId } = {}) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const seatResult = await client.query(
        "select * from schedule_seats where id = $1 and schedule_id = $2 for update",
        [seatId, scheduleId]
      );
      const seat = seatResult.rows[0];
      if (!seat) raise("Seat not found.", 404);
      if (seat.status !== "locked" || seat.locked_by !== user.id || (lockId && seat.lock_id !== lockId)) {
        raise("Your temporary seat lock is not active.", 409);
      }

      await client.query(
        `update schedule_seats
         set status = 'available',
             locked_by = null,
             lock_id = null,
             lock_expires_at = null
         where id = $1`,
        [seatId]
      );
      const schedule = await this.getSchedule(scheduleId, client);
      await client.query("commit");
      return { schedule };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async bookSeat(scheduleId, seatId, user, { lockId, preferFemale }) {
    const result = await this.confirmSeats(scheduleId, user, { seats: [{ seatId, lockId }], preferFemale });
    return { bookingId: result.bookingIds[0], seat: result.seats[0], schedule: result.schedule };
  }

  async confirmSeats(scheduleId, user, { seats = [], preferFemale = false }) {
    if (!Array.isArray(seats) || seats.length === 0) raise("Select at least one held seat to confirm.", 400);
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const uniqueSelections = [...new Map(seats.map((item) => [item.seatId, item])).values()];
      const ids = uniqueSelections.map((item) => item.seatId);
      const seatResult = await client.query(
        `select * from schedule_seats
         where schedule_id = $1 and id = any($2::uuid[])
         order by seat_number
         for update`,
        [scheduleId, ids]
      );
      if (seatResult.rows.length !== uniqueSelections.length) raise("Seat not found.", 404);
      const allSeats = (await client.query("select * from schedule_seats where schedule_id = $1", [scheduleId])).rows;
      const heldSelectionIds = new Set(ids);
      const hasMaleAlternative = hasOpenNonFemaleAdjacentSeat(allSeats, heldSelectionIds, user.id);

      const now = new Date();
      const byId = new Map(uniqueSelections.map((item) => [item.seatId, item.lockId]));
      const genderById = new Map(uniqueSelections.map((item) => [item.seatId, item.passengerGender || user.gender || "other"]));
      for (const seat of seatResult.rows) {
        if (seat.status !== "locked" || seat.lock_id !== byId.get(seat.id) || seat.locked_by !== user.id) {
          raise(`Seat ${seat.label} is no longer held by you.`, 409);
        }
        if (new Date(seat.lock_expires_at) <= now) {
          await client.query(
            `update schedule_seats
             set status = 'available', locked_by = null, lock_id = null, lock_expires_at = null
             where id = $1`,
            [seat.id]
          );
          raise(`Seat ${seat.label} hold expired.`, 409);
        }
        const passengerGender = genderById.get(seat.id);
        if (passengerGender !== "female" && isAdjacentToFemaleSeat(seat, allSeats) && hasMaleAlternative) {
          raise(`Seat ${seat.label} is beside a female passenger. Choose a female passenger for this seat or pick another available seat.`, 409);
        }
      }

      const booked = [];
      const bookingIds = [];
      for (const seat of seatResult.rows) {
        const passengerGender = genderById.get(seat.id);
        const booking = await client.query(
          `insert into bookings (schedule_id, seat_id, user_id, prefer_female)
           values ($1, $2, $3, $4)
           returning id`,
          [scheduleId, seat.id, user.id, Boolean(preferFemale)]
        );
        bookingIds.push(booking.rows[0].id);
        const updated = await client.query(
          `update schedule_seats
           set status = 'booked',
               locked_by = null,
               lock_id = null,
               lock_expires_at = null,
               booked_by = $1,
               passenger_gender = $2,
               prefer_female = $3,
               checked_in_at = null
           where id = $4
           returning *`,
          [user.id, passengerGender, Boolean(preferFemale), seat.id]
        );
        booked.push(seatFromRow({ ...updated.rows[0], booking_id: booking.rows[0].id }));
      }

      const labels = booked.map((seat) => seat.label).join(", ");
      await this.notify(user.id, `Booking confirmed for ${labels}.`, client);
      const schedule = await this.getSchedule(scheduleId, client);
      await client.query("commit");
      return { bookingIds, seats: booked, schedule };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async checkIn(scheduleId, user) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const scheduleResult = await client.query("select * from schedules where id = $1", [scheduleId]);
      const schedule = scheduleResult.rows[0];
      if (!schedule) raise("Schedule not found.", 404);
      const windows = scheduleWindow(schedule.departure_at);
      const now = new Date();
      if (now < windows.checkInStartAt || now > windows.reallocationAt) {
        raise("Check-in is open only from minute 40 to minute 50 of the booking window.", 409);
      }
      const seatResult = await client.query(
        `select * from schedule_seats
         where schedule_id = $1 and status = 'booked' and booked_by = $2
         order by seat_number
         limit 1
         for update`,
        [scheduleId, user.id]
      );
      if (!seatResult.rows[0]) raise("No confirmed booking found.", 404);
      const updated = await client.query(
        `update schedule_seats set checked_in_at = $1 where id = $2 returning *`,
        [now.toISOString(), seatResult.rows[0].id]
      );
      await client.query(
        `update bookings set checked_in_at = $1 where schedule_id = $2 and seat_id = $3 and status = 'confirmed'`,
        [now.toISOString(), scheduleId, seatResult.rows[0].id]
      );
      await this.notify(user.id, `Check-in confirmed for seat ${seatResult.rows[0].label}.`, client);
      const nextSchedule = await this.getSchedule(scheduleId, client);
      await client.query("commit");
      return { seat: seatFromRow(updated.rows[0]), schedule: nextSchedule };
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async joinWaitlist(scheduleId, user) {
    await this.pool.query(
      `insert into waitlist_entries (schedule_id, user_id, priority)
       values ($1, $2, $3)
       on conflict (schedule_id, user_id) do nothing`,
      [scheduleId, user.id, user.gender === "female" ? 1 : 2]
    );
    const waitlist = this.publicWaitlist(scheduleId);
    const list = await waitlist;
    const position = list.findIndex((item) => item.userId === user.id || item.name === user.name) + 1;
    await this.notify(user.id, `You joined the waitlist at position ${position}.`);
    return { position, waitlist: list, schedule: await this.getSchedule(scheduleId) };
  }

  async getFemaleSuggestions(scheduleId) {
    const schedule = await this.getSchedule(scheduleId);
    if (!schedule) raise("Schedule not found.", 404);
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
    const result = await this.pool.query(
      `insert into waitlist_chat_messages (schedule_id, user_id, message)
       values ($1, $2, $3)
       returning id, created_at`,
      [scheduleId, user.id, String(message || "").slice(0, 400)]
    );
    return {
      id: result.rows[0].id,
      userId: user.id,
      name: user.name,
      message: String(message || "").slice(0, 400),
      createdAt: result.rows[0].created_at
    };
  }

  async addRide(scheduleId, user, input) {
    const result = await this.pool.query(
      `insert into shared_ride_requests (schedule_id, user_id, ride_from, ride_to, seats_needed, notes)
       values ($1, $2, $3, $4, $5, $6)
       returning *`,
      [
        scheduleId,
        user.id,
        input.from || "",
        input.to || "",
        Number(input.seatsNeeded || 1),
        String(input.notes || "").slice(0, 240)
      ]
    );
    const row = result.rows[0];
    return {
      id: row.id,
      userId: user.id,
      name: user.name,
      from: row.ride_from,
      to: row.ride_to,
      seatsNeeded: row.seats_needed,
      notes: row.notes,
      createdAt: row.created_at
    };
  }

  async createSchedule(input) {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const bus = await client.query("insert into buses (name, capacity) values ($1, 40) returning id", [input.busName || "AUR Shuttle"]);
      const route = await client.query(
        `insert into routes (source, destination)
         values ($1, $2)
         on conflict (source, destination) do update set active = true
         returning id`,
        [input.source, input.destination]
      );
      const schedule = await client.query(
        "insert into schedules (route_id, bus_id, departure_at) values ($1, $2, $3) returning id",
        [route.rows[0].id, bus.rows[0].id, new Date(input.departureAt).toISOString()]
      );
      await this.seedSeats(schedule.rows[0].id);
      await client.query("commit");
      return this.getSchedule(schedule.rows[0].id);
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  async releaseExpiredLocks(onlyScheduleId, client = this.pool) {
    const params = [];
    let filter = "";
    if (onlyScheduleId) {
      params.push(onlyScheduleId);
      filter = `and schedule_id = $${params.length}`;
    }
    const before = await client.query(
      `select distinct schedule_id from schedule_seats
       where status = 'locked' and lock_expires_at <= now() ${filter}`,
      params
    );
    await client.query(
      `update schedule_seats
       set status = 'available',
           locked_by = null,
           lock_id = null,
           lock_expires_at = null
       where status = 'locked' and lock_expires_at <= now() ${filter}`,
      params
    );
    return Promise.all(before.rows.map((row) => this.getSchedule(row.schedule_id, client)));
  }

  async runReallocation() {
    const schedules = await this.pool.query(
      `select id from schedules
       where reallocated_at is null
         and now() >= departure_at - interval '10 minutes'
         and now() < departure_at`
    );
    const updates = [];
    for (const schedule of schedules.rows) {
      const client = await this.pool.connect();
      try {
        await client.query("begin");
        const released = await client.query(
          `select * from schedule_seats
           where schedule_id = $1 and status = 'booked' and checked_in_at is null
           order by seat_number
           for update`,
          [schedule.id]
        );
        for (const seat of released.rows) {
          const next = await client.query(
            `select * from waitlist_entries
             where schedule_id = $1 and status = 'waiting'
             order by priority, created_at
             limit 1
             for update skip locked`,
            [schedule.id]
          );
          await client.query(
            "update bookings set status = 'released' where schedule_id = $1 and seat_id = $2 and status = 'confirmed'",
            [schedule.id, seat.id]
          );
          if (next.rows[0]) {
            const waiter = next.rows[0];
            await client.query("update waitlist_entries set status = 'allocated' where id = $1", [waiter.id]);
            await client.query(
              "insert into bookings (schedule_id, seat_id, user_id) values ($1, $2, $3)",
              [schedule.id, seat.id, waiter.user_id]
            );
            await client.query(
              "update schedule_seats set booked_by = $1, checked_in_at = null where id = $2",
              [waiter.user_id, seat.id]
            );
            await this.notify(waiter.user_id, `You were allocated seat ${seat.label} from the waitlist.`, client);
          } else {
            await client.query(
              `update schedule_seats
               set status = 'available',
                   booked_by = null,
                   passenger_gender = null,
                   checked_in_at = null
               where id = $1`,
              [seat.id]
            );
            await this.notify(seat.booked_by, `Seat ${seat.label} was released because check-in was not completed.`, client);
          }
        }
        await client.query("update schedules set reallocated_at = now() where id = $1", [schedule.id]);
        const update = await this.getSchedule(schedule.id, client);
        await client.query("commit");
        updates.push(update);
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    return updates;
  }

  async publicWaitlist(scheduleId) {
    const result = await this.pool.query(
      `select w.id, w.user_id, u.name, w.created_at
       from waitlist_entries w
       join app_users u on u.id = w.user_id
       where w.schedule_id = $1 and w.status = 'waiting'
       order by w.priority, w.created_at`,
      [scheduleId]
    );
    return result.rows.map((row, index) => ({
      id: row.id,
      userId: row.user_id,
      name: row.name,
      position: index + 1,
      joinedAt: row.created_at
    }));
  }

  async notify(userId, message, client = this.pool) {
    if (!userId) return;
    await client.query("insert into notifications (user_id, message) values ($1, $2)", [userId, message]);
  }

  async getNotifications(userId) {
    const result = await this.pool.query(
      `select id, message, read, created_at
       from notifications
       where user_id = $1
       order by created_at desc
       limit 30`,
      [userId]
    );
    return result.rows.map((row) => ({
      id: row.id,
      message: row.message,
      read: row.read,
      createdAt: row.created_at
    }));
  }

  async adminSnapshot() {
    const schedules = await this.searchSchedules({});
    const users = await this.pool.query("select * from app_users order by created_at desc");
    const waitlists = await this.pool.query(
      "select schedule_id, count(*)::int as count from waitlist_entries where status = 'waiting' group by schedule_id"
    );
    return {
      users: users.rows.map((row) => publicUser(camelUser(row))),
      schedules,
      bookings: schedules.flatMap((schedule) =>
        schedule.seats
          .filter((seat) => seat.status === "booked")
          .map((seat) => ({ scheduleId: schedule.id, seat: seat.label, route: `${schedule.source} -> ${schedule.destination}` }))
      ),
      waitlists: waitlists.rows.map((row) => ({ scheduleId: row.schedule_id, count: row.count }))
    };
  }
}
