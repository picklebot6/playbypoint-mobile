import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import type { reservationToBookingRequest } from "./booking-payload";

type BookingRequest = ReturnType<typeof reservationToBookingRequest>;

export function createTransferPlan(credentialSet: string, targetDate: string, requests: BookingRequest[]) {
  return {
    createdAt: new Date().toISOString(), credentialSet, destinationCredentialSet: "1", targetDate,
    bookings: requests.map(request => ({
      request,
      status: "pending" as "pending" | "cancelling" | "cancelled" | "rebooking" | "rebooked" | "failed_or_unknown",
      cancellationConfirmed: false,
      replacementReservationId: null as number | null,
      lastError: null as string | null,
    })),
  };
}

export async function loadTransferPlan() {
  return JSON.parse(await readFile("reports/transfer-bookings.json", "utf8")) as ReturnType<typeof createTransferPlan>;
}

export async function saveTransferPlan(
  plan: ReturnType<typeof createTransferPlan>,
  path = "reports/transfer-bookings.json",
) {
  await mkdir(dirname(path), { recursive: true });
  // Replace atomically so a failed write cannot truncate saved replacement payloads.
  const temporaryPath = `${path}.tmp`;
  await writeFile(temporaryPath, JSON.stringify(plan, null, 2) + "\n", { mode: 0o600, flush: true });
  await rename(temporaryPath, path);
}
