create extension if not exists pgcrypto;

create table if not exists app_users (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  email text not null unique,
  password_hash text not null,
  gender text not null check (gender in ('female', 'male', 'other')),
  role text not null default 'student' check (role in ('student', 'admin')),
  age int,
  phone text default '',
  university_id text default '',
  created_at timestamptz not null default now()
);

create table if not exists refresh_tokens (
  id uuid primary key,
  user_id uuid not null references app_users(id) on delete cascade,
  family_id uuid not null,
  token_hash text not null,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists buses (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  plate_number text,
  capacity int not null default 40,
  active boolean not null default true
);

create table if not exists routes (
  id uuid primary key default gen_random_uuid(),
  source text not null,
  destination text not null,
  active boolean not null default true,
  unique (source, destination)
);

create table if not exists schedules (
  id uuid primary key default gen_random_uuid(),
  route_id uuid not null references routes(id),
  bus_id uuid not null references buses(id),
  departure_at timestamptz not null,
  status text not null default 'scheduled' check (status in ('scheduled', 'departed', 'cancelled')),
  reallocated_at timestamptz,
  created_at timestamptz not null default now()
);

create table if not exists schedule_seats (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  seat_number int not null,
  label text not null,
  row_number int not null,
  col_number int not null,
  status text not null default 'available' check (status in ('available', 'locked', 'booked')),
  locked_by uuid references app_users(id),
  lock_id uuid,
  lock_expires_at timestamptz,
  booked_by uuid references app_users(id),
  passenger_gender text check (passenger_gender in ('female', 'male', 'other')),
  prefer_female boolean not null default false,
  checked_in_at timestamptz,
  unique (schedule_id, seat_number)
);

create table if not exists bookings (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  seat_id uuid not null references schedule_seats(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  status text not null default 'confirmed' check (status in ('confirmed', 'released', 'cancelled')),
  prefer_female boolean not null default false,
  created_at timestamptz not null default now(),
  checked_in_at timestamptz
);

create unique index if not exists one_active_booking_per_seat
  on bookings (schedule_id, seat_id)
  where status = 'confirmed';

create table if not exists waitlist_entries (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  priority int not null default 2,
  status text not null default 'waiting' check (status in ('waiting', 'allocated', 'left')),
  created_at timestamptz not null default now(),
  unique (schedule_id, user_id)
);

create index if not exists waitlist_order_idx
  on waitlist_entries (schedule_id, status, priority, created_at);

create table if not exists notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references app_users(id) on delete cascade,
  message text not null,
  read boolean not null default false,
  created_at timestamptz not null default now()
);

create table if not exists waitlist_chat_messages (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  message text not null,
  created_at timestamptz not null default now()
);

create table if not exists shared_ride_requests (
  id uuid primary key default gen_random_uuid(),
  schedule_id uuid not null references schedules(id) on delete cascade,
  user_id uuid not null references app_users(id) on delete cascade,
  ride_from text not null,
  ride_to text not null,
  seats_needed int not null default 1,
  notes text default '',
  created_at timestamptz not null default now()
);

create or replace function booking_window_open(p_schedule_id uuid)
returns boolean
language sql
stable
as $$
  select now() >= departure_at - interval '1 hour'
     and now() < departure_at
  from schedules
  where id = p_schedule_id;
$$;

create or replace function try_lock_seat(
  p_schedule_id uuid,
  p_seat_id uuid,
  p_user_id uuid
)
returns table(seat_id uuid, lock_id uuid, lock_expires_at timestamptz)
language plpgsql
as $$
declare
  v_seat schedule_seats%rowtype;
  v_lock_id uuid := gen_random_uuid();
begin
  if not booking_window_open(p_schedule_id) then
    raise exception 'Booking opens one hour before departure' using errcode = 'P0001';
  end if;

  select *
  into v_seat
  from schedule_seats
  where id = p_seat_id
    and schedule_id = p_schedule_id
  for update;

  if not found then
    raise exception 'Seat not found' using errcode = 'P0002';
  end if;

  if v_seat.status = 'booked' then
    raise exception 'Seat already booked' using errcode = 'P0003';
  end if;

  if v_seat.status = 'locked' and v_seat.lock_expires_at > now() then
    raise exception 'Seat already locked' using errcode = 'P0004';
  end if;

  update schedule_seats
  set status = 'locked',
      locked_by = p_user_id,
      lock_id = v_lock_id,
      lock_expires_at = now() + interval '6 minutes'
  where id = p_seat_id
  returning id, schedule_seats.lock_id, schedule_seats.lock_expires_at
  into seat_id, lock_id, lock_expires_at;

  return next;
end;
$$;

create or replace function confirm_locked_seat(
  p_schedule_id uuid,
  p_seat_id uuid,
  p_user_id uuid,
  p_lock_id uuid,
  p_prefer_female boolean default false
)
returns uuid
language plpgsql
as $$
declare
  v_seat schedule_seats%rowtype;
  v_user app_users%rowtype;
  v_booking_id uuid;
begin
  select *
  into v_seat
  from schedule_seats
  where id = p_seat_id
    and schedule_id = p_schedule_id
  for update;

  if not found then
    raise exception 'Seat not found' using errcode = 'P0002';
  end if;

  if v_seat.status <> 'locked'
     or v_seat.lock_id <> p_lock_id
     or v_seat.locked_by <> p_user_id
     or v_seat.lock_expires_at <= now() then
    raise exception 'Active lock required' using errcode = 'P0005';
  end if;

  select * into v_user from app_users where id = p_user_id;

  insert into bookings (schedule_id, seat_id, user_id, prefer_female)
  values (p_schedule_id, p_seat_id, p_user_id, p_prefer_female)
  returning id into v_booking_id;

  update schedule_seats
  set status = 'booked',
      locked_by = null,
      lock_id = null,
      lock_expires_at = null,
      booked_by = p_user_id,
      passenger_gender = v_user.gender,
      prefer_female = p_prefer_female
  where id = p_seat_id;

  return v_booking_id;
end;
$$;

create or replace function release_expired_locks()
returns int
language plpgsql
as $$
declare
  v_count int;
begin
  update schedule_seats
  set status = 'available',
      locked_by = null,
      lock_id = null,
      lock_expires_at = null
  where status = 'locked'
    and lock_expires_at <= now();

  get diagnostics v_count = row_count;
  return v_count;
end;
$$;

create or replace function release_unchecked_and_reallocate(p_schedule_id uuid)
returns int
language plpgsql
as $$
declare
  released_seat record;
  next_waiter record;
  v_count int := 0;
begin
  for released_seat in
    select ss.*
    from schedule_seats ss
    join schedules s on s.id = ss.schedule_id
    where ss.schedule_id = p_schedule_id
      and ss.status = 'booked'
      and ss.checked_in_at is null
      and now() >= s.departure_at - interval '10 minutes'
      and now() < s.departure_at
    for update of ss
  loop
    select *
    into next_waiter
    from waitlist_entries
    where schedule_id = p_schedule_id
      and status = 'waiting'
    order by priority asc, created_at asc
    limit 1
    for update skip locked;

    if found then
      update waitlist_entries set status = 'allocated' where id = next_waiter.id;

      update bookings
      set status = 'released'
      where schedule_id = p_schedule_id
        and seat_id = released_seat.id
        and status = 'confirmed';

      insert into bookings (schedule_id, seat_id, user_id)
      values (p_schedule_id, released_seat.id, next_waiter.user_id);

      update schedule_seats
      set booked_by = next_waiter.user_id,
          checked_in_at = null
      where id = released_seat.id;
    else
      update bookings
      set status = 'released'
      where schedule_id = p_schedule_id
        and seat_id = released_seat.id
        and status = 'confirmed';

      update schedule_seats
      set status = 'available',
          booked_by = null,
          passenger_gender = null,
          checked_in_at = null
      where id = released_seat.id;
    end if;

    v_count := v_count + 1;
  end loop;

  return v_count;
end;
$$;
