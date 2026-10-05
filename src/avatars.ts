// The profile pictures. The database stores only an id such as "avatar_04".
// TO ADD ONE: add a line to DEFINITIONS with the next id (avatar_09 ...).
// The id must match avatar_NN (two digits), which is also what the database allows.
// To use real image files instead, set `src` to an imported file, e.g.
//   import car from "./avatars/avatar_09.png"  ->  src: car

export type Avatar = { id: string; label: string; src: string };

const BG = "#0d0f15";

function toDataUri(svg: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

function build(color: string, motif: (c: string) => string): string {
  return toDataUri(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" fill="${BG}"/>` +
      `<circle cx="32" cy="32" r="29" fill="none" stroke="${color}" stroke-width="2" opacity="0.45"/>` +
      `${motif(color)}</svg>`
  );
}

const DEFINITIONS: { id: string; label: string; color: string; motif: (c: string) => string }[] = [
  {
    id: "avatar_01",
    label: "Bolt",
    color: "#c6ff00",
    motif: (c) => `<path d="M36 8 L16 36 H29 L26 56 L48 26 H34 Z" fill="${c}"/>`,
  },
  {
    id: "avatar_02",
    label: "Wheel",
    color: "#00e5ff",
    motif: (c) =>
      `<circle cx="32" cy="32" r="18" fill="none" stroke="${c}" stroke-width="5"/>` +
      `<circle cx="32" cy="32" r="4" fill="${c}"/>` +
      `<path d="M32 14V28M32 36V50M14 32H28M36 32H50" stroke="${c}" stroke-width="3"/>`,
  },
  {
    id: "avatar_03",
    label: "Gauge",
    color: "#ff8a00",
    motif: (c) =>
      `<path d="M12 42 A20 20 0 0 1 52 42" fill="none" stroke="${c}" stroke-width="5"/>` +
      `<path d="M32 42 L42 24" stroke="${c}" stroke-width="4" stroke-linecap="round"/>` +
      `<circle cx="32" cy="42" r="4" fill="${c}"/>`,
  },
  {
    id: "avatar_04",
    label: "Flag",
    color: "#f4f6fb",
    motif: (c) =>
      `<path d="M18 10 V54" stroke="${c}" stroke-width="4"/>` +
      `<g fill="${c}"><rect x="20" y="12" width="10" height="7"/><rect x="40" y="12" width="10" height="7"/>` +
      `<rect x="30" y="19" width="10" height="7"/><rect x="20" y="26" width="10" height="7"/>` +
      `<rect x="40" y="26" width="10" height="7"/></g>` +
      `<rect x="20" y="12" width="30" height="21" fill="none" stroke="${c}" stroke-width="2"/>`,
  },
  {
    id: "avatar_05",
    label: "Coupe",
    color: "#ff3d8b",
    motif: (c) =>
      `<path d="M10 38 L14 28 Q16 24 21 24 H40 Q44 24 47 28 L54 33 Q57 34 57 38 V42 H10 Z" fill="${c}"/>` +
      `<path d="M19 28 H29 V33 H16 Z M32 28 H40 L45 33 H32 Z" fill="${BG}"/>` +
      `<circle cx="21" cy="43" r="6" fill="${BG}" stroke="${c}" stroke-width="3"/>` +
      `<circle cx="46" cy="43" r="6" fill="${BG}" stroke="${c}" stroke-width="3"/>`,
  },
  {
    id: "avatar_06",
    label: "Helmet",
    color: "#4d7cff",
    motif: (c) =>
      `<path d="M14 40 A18 18 0 0 1 50 40 V46 H14 Z" fill="${c}"/>` +
      `<path d="M28 30 H50 V39 H28 Z" fill="${BG}"/>`,
  },
  {
    id: "avatar_07",
    label: "Road",
    color: "#a66bff",
    motif: (c) =>
      `<path d="M26 10 H38 L54 54 H10 Z" fill="${c}" opacity="0.9"/>` +
      `<path d="M32 14 V22 M32 28 V38 M32 44 V54" stroke="${BG}" stroke-width="3"/>`,
  },
  {
    id: "avatar_08",
    label: "Flame",
    color: "#ff3d4a",
    motif: (c) =>
      `<path d="M34 8 C36 18 48 24 46 38 C45 48 38 54 32 54 C24 54 17 48 18 38 C19 31 24 28 26 22 C29 26 29 30 31 31 C34 26 33 16 34 8 Z" fill="${c}"/>`,
  },
];

export const AVATARS: Avatar[] = DEFINITIONS.map((d) => ({
  id: d.id,
  label: d.label,
  src: build(d.color, d.motif),
}));

export const DEFAULT_AVATAR_ID = "avatar_01";

const BY_ID = new Map(AVATARS.map((avatar) => [avatar.id, avatar] as const));

export function isAvatarId(id: string): boolean {
  return BY_ID.has(id);
}

// Unknown ids fall back to the default picture
export function avatarSrc(id: string): string {
  return (BY_ID.get(id) ?? BY_ID.get(DEFAULT_AVATAR_ID))?.src ?? "";
}