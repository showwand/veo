// A random id made once per browser. It is how the database counts "3 accounts on this device".
// (A browser can't prove which device it is, so someone who clears their site data gets a new id.)
const KEY = "veode:device-id";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

let fallback: string | null = null; // used if the browser blocks storage

export function getDeviceId(): string {
  try {
    const existing = window.localStorage.getItem(KEY);
    if (existing && UUID.test(existing)) return existing;
    const id = crypto.randomUUID();
    window.localStorage.setItem(KEY, id);
    return id;
  } catch {
    fallback ??= crypto.randomUUID();
    return fallback;
  }
}