import "dotenv/config";
import { MemoryStore } from "./stores/memoryStore.js";
import { PostgresStore } from "./stores/postgresStore.js";

const store = process.env.USE_POSTGRES === "true" ? new PostgresStore() : new MemoryStore();
await store.init();

const schedule = (await store.searchSchedules({}))[0];
const seat = schedule.seats.find((item) => item.status === "available");
const users = await Promise.all(
  ["student@amity.edu", "female@amity.edu", "admin@amity.edu"].map((email) => store.findUserByEmail(email))
);

const attempts = await Promise.allSettled(
  Array.from({ length: 8 }, (_, index) => store.lockSeat(schedule.id, seat.id, users[index % users.length]))
);

const fulfilled = attempts.filter((attempt) => attempt.status === "fulfilled");
const rejected = attempts.filter((attempt) => attempt.status === "rejected");

console.log(`Concurrent lock attempts: ${attempts.length}`);
console.log(`Succeeded: ${fulfilled.length}`);
console.log(`Rejected: ${rejected.length}`);
console.log(`Winning lock id: ${fulfilled[0]?.value?.seat?.lockId || "none"}`);

if (fulfilled.length !== 1) {
  throw new Error("Concurrency test failed: more than one lock succeeded.");
}

process.exit(0);
