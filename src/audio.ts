/**
 * Audio playback with honest availability.
 * Pre-generated MP3s do not exist until Stage 2. We probe once; if the file is
 * missing we report "unavailable" and never pretend playback happened.
 * No Polly call is ever made from the browser (spec §3).
 */
const availability = new Map<string, boolean>();

export async function audioAvailable(path: string): Promise<boolean> {
  if (availability.has(path)) return availability.get(path)!;
  try {
    const res = await fetch(path, { method: "HEAD" });
    const ok = res.ok && (res.headers.get("content-type") ?? "").includes("audio");
    availability.set(path, ok);
    return ok;
  } catch {
    availability.set(path, false);
    return false;
  }
}

export async function play(path: string): Promise<"played" | "unavailable"> {
  const ok = await audioAvailable(path);
  if (!ok) return "unavailable";
  const el = new Audio(path);
  try {
    await el.play();
    return "played";
  } catch {
    return "unavailable";
  }
}
