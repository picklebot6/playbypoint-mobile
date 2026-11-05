import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTransferPlan, saveTransferPlan } from "../../src/bookings/transfer-plan";
import { reservationToBookingRequest } from "../../src/bookings/booking-payload";

test("persists complete replacement payloads and retains them through cancellation status updates", async () => {
  const directory = await mkdtemp(join(tmpdir(), "playbypoint-transfer-"));
  try {
    const request = reservationToBookingRequest({
      id: 123, reference: "RES123", facility: "iTennis/iPickle Cerritos", court: "Pickleball 1",
      date: "2026-11-11", dateLabel: "Wed, Nov 11", time: "07:30 AM - 08:30 AM",
      status: "booked", canCancel: true, players: ["Player One", "Player Two"],
    }, { "Player One": 101, "Player Two": 202 });
    const plan = createTransferPlan("2", "2026-11-11", [request]);
    const path = join(directory, "reports", "transfer-bookings.json");
    for (const status of ["pending", "cancelling", "cancelled", "failed_or_unknown"] as const) {
      plan.bookings[0].status = status;
      await saveTransferPlan(plan, path);
      const stored = JSON.parse(await readFile(path, "utf8"));
      assert.equal(stored.credentialSet, "2");
      assert.equal(stored.targetDate, "2026-11-11");
      assert.equal(stored.bookings[0].status, status);
      assert.deepEqual(stored.bookings[0].request, request);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
