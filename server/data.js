export const LOCATIONS = [
  "Amity University Raipur",
  "Saddu",
  "Shankar Nagar",
  "Ambuja Mall",
  "VIP Road",
  "Marine Drive"
];

export const BUS_NAMES = [
  "AUR Shuttle 1",
  "AUR Shuttle 2",
  "AUR Express 3",
  "AUR Evening Loop"
];

export function makeScheduleTimes() {
  const now = new Date();
  const slots = Array.from({ length: 10 }, (_, index) => 10 + index * 30).map((minutes) => {
    const date = new Date(now.getTime() + minutes * 60_000);
    date.setSeconds(0, 0);
    return date;
  });

  return [
    ["Amity University Raipur", "Saddu", slots[0], "AUR Shuttle 1"],
    ["Saddu", "Amity University Raipur", slots[1], "AUR Shuttle 1"],
    ["Amity University Raipur", "Shankar Nagar", slots[2], "AUR Shuttle 2"],
    ["Shankar Nagar", "Amity University Raipur", slots[3], "AUR Shuttle 2"],
    ["Amity University Raipur", "Ambuja Mall", slots[4], "AUR Express 3"],
    ["Ambuja Mall", "Amity University Raipur", slots[5], "AUR Express 3"],
    ["Amity University Raipur", "VIP Road", slots[6], "AUR CityLink 4"],
    ["VIP Road", "Amity University Raipur", slots[7], "AUR CityLink 4"],
    ["Amity University Raipur", "Marine Drive", slots[8], "AUR Evening Loop"],
    ["Marine Drive", "Amity University Raipur", slots[9], "AUR Evening Loop"]
  ];
}

export function buildSeatLayout(scheduleId) {
  const seats = [];
  for (let i = 1; i <= 40; i += 1) {
    const zero = i - 1;
    const row = Math.floor(zero / 4) + 1;
    const col = zero % 4;
    seats.push({
      id: `${scheduleId}-${i}`,
      number: i,
      label: `${row}${["A", "B", "C", "D"][col]}`,
      row,
      col,
      status: "available",
      lockId: null,
      lockedBy: null,
      lockExpiresAt: null,
      bookingId: null,
      bookedBy: null,
      passengerGender: null,
      preferFemale: false,
      checkedInAt: null
    });
  }
  return seats;
}

export function seatNeighborNumbers(number) {
  const seat = number - 1;
  const rowStart = Math.floor(seat / 4) * 4 + 1;
  const col = seat % 4;
  if (col === 0) return [number + 1];
  if (col === 1) return [number - 1];
  if (col === 2) return [number + 1];
  return [number - 1];
}

export function scheduleWindow(departureAt) {
  const departure = new Date(departureAt);
  return {
    bookingOpenAt: new Date(departure.getTime() - 60 * 60_000),
    checkInStartAt: new Date(departure.getTime() - 20 * 60_000),
    reallocationAt: new Date(departure.getTime() - 10 * 60_000)
  };
}

export function publicUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    name: user.name,
    email: user.email,
    gender: user.gender,
    role: user.role,
    age: user.age || "",
    phone: user.phone || "",
    universityId: user.universityId || ""
  };
}
