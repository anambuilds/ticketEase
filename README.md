# TicketEase

A full-stack bus booking system for students travelling between Amity University Raipur and Raipur locations such as Saddu, Shankar Nagar, Ambuja Mall, VIP Road, and Marine Drive.

## Stack

- React + Vite frontend
- Node.js + Express REST API
- Socket.IO real-time updates
- Supabase PostgreSQL schema with row-level locking
- JWT access tokens and rotating refresh tokens

## Run Locally

```bash
npm install
npm run dev
```

Frontend: `http://127.0.0.1:5173`  
Backend: `http://127.0.0.1:4000`

The app runs in in-memory demo mode unless `USE_POSTGRES=true` and `DATABASE_URL` are configured.

Demo users are available from the sign-in screen:

- Student: `student@amity.edu`
- Female student: `female@amity.edu`
- Admin: `admin@amity.edu`

All demo passwords are `Password123`.

## Supabase Setup

1. Create a Supabase project.
2. Open the SQL editor.
3. Run `supabase/schema.sql`.
4. Copy the project database URI into `.env`.
5. Set `USE_POSTGRES=true`.

## Concurrency Strategy

Seat locking and booking are validated only on the backend.

- Seat rows are locked with `SELECT ... FOR UPDATE` inside a PostgreSQL transaction.
- A seat can move from `available` to `locked` only if it is not booked and no active lock exists.
- Booking verifies the same user owns the unexpired lock before inserting the booking.
- A unique partial index prevents more than one active confirmed booking per schedule seat.
- Socket.IO broadcasts every lock, booking, waitlist, chat, and reallocation update.

This protects the race condition where multiple students click the same seat at the same moment: all requests reach the same database row, PostgreSQL serializes the lock acquisition, and exactly one request can succeed.
