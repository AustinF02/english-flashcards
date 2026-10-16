import type { DeviceEntry } from "./progress";

/**
 * A browser's identity for idempotency: a random id plus the next op number.
 * See the IDEMPOTENCY WINDOW note in progress.ts. The id is NOT a secret and not an
 * authenticator; user isolation comes only from the verified token on the server.
 */
export interface Device {
  id: string;
  nextSeq: number;
}

const KEY = "ef_device_v1";

export function newDeviceId(): string {
  const a = new Uint8Array(12);
  crypto.getRandomValues(a);
  return Array.from(a, (b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Decide this browser's identity after reading the server copy:
 *  - the server knows our id  -> keep it, and continue after the server's mark
 *    (never behind our own stored counter)
 *  - the server does not      -> brand-new identity starting at seq 1. That is correct for a
 *    first run, a different signed-in user, cleared storage, and a device evicted by the cap.
 */
export function reconcileDevice(
  stored: Device | null,
  serverDevices: DeviceEntry[],
  makeId: () => string = newDeviceId,
): Device {
  const known = stored && serverDevices.find(([id]) => id === stored.id);
  if (stored && known) return { id: stored.id, nextSeq: Math.max(stored.nextSeq, known[1] + 1) };
  return { id: makeId(), nextSeq: 1 };
}

export function loadDevice(): Device | null {
  try {
    const d = JSON.parse(localStorage.getItem(KEY) ?? "null") as Device | null;
    return d && typeof d.id === "string" && Number.isInteger(d.nextSeq) && d.nextSeq >= 1 ? d : null;
  } catch {
    return null;
  }
}

export function saveDevice(d: Device): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(d));
  } catch {
    /* blocked storage: identity lasts for this page only */
  }
}
