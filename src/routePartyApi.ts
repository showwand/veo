import { describeError, errorMessage } from "./accountErrors";
import { asNumber, asString, isRecord, parseList, type ApiResult } from "./dbParse";
import type { Route, RouteType } from "./routing";
import type { ManeuverKind } from "./navigationTypes";
import type { RouteStep } from "./osrmSteps";
import { callRpc } from "./supabaseClient";

export type SharedRoute = {
  partyId: string;
  ownerId: string;
  shareCode: string;
  route: Route;
};

export type PartyRacer = {
  userId: string;
  username: string;
  avatarId: string;
  latitude: number | null;
  longitude: number | null;
  progressMeters: number | null;
  remainingSeconds: number | null;
  updatedAt: string | null;
  locationShared: boolean;
};

const ROUTE_TYPES = new Set<RouteType>([
  "fastest",
  "scenic",
  "avoid-motorways",
  "fun",
  "alternative",
]);
const MANEUVER_KINDS = new Set<ManeuverKind>([
  "straight",
  "left",
  "right",
  "slight-left",
  "slight-right",
  "u-turn",
  "roundabout",
  "arrive",
]);

function parseSteps(value: unknown): RouteStep[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const steps: RouteStep[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    const kind = asString(item.kind);
    const instruction = asString(item.instruction);
    const startMeters = asNumber(item.startMeters);
    const lengthMeters = asNumber(item.lengthMeters);
    const durationSeconds = asNumber(item.durationSeconds);
    const osrmType = asString(item.osrmType);
    if (
      kind === null ||
      !MANEUVER_KINDS.has(kind as ManeuverKind) ||
      instruction === null ||
      startMeters === null ||
      lengthMeters === null ||
      durationSeconds === null ||
      osrmType === null
    ) {
      continue;
    }
    const location = Array.isArray(item.location) &&
      item.location.length === 2 &&
      typeof item.location[0] === "number" &&
      typeof item.location[1] === "number"
      ? [item.location[0], item.location[1]] as [number, number]
      : null;
    steps.push({
      kind: kind as ManeuverKind,
      instruction,
      announce: item.announce === true,
      startMeters,
      lengthMeters,
      durationSeconds,
      road: asString(item.road),
      osrmType,
      osrmModifier: asString(item.osrmModifier),
      location,
    });
  }
  return steps;
}

export function parseSharedRoute(
  partyId: unknown,
  ownerId: unknown,
  shareCode: unknown,
  rawRoute: unknown
): SharedRoute | null {
  if (
    typeof partyId !== "string" ||
    typeof ownerId !== "string" ||
    typeof shareCode !== "string" ||
    !isRecord(rawRoute)
  ) {
    return null;
  }

  const id = asString(rawRoute.id);
  const name = asString(rawRoute.name);
  const type = asString(rawRoute.type);
  const mode = asString(rawRoute.mode);
  const durationSeconds = asNumber(rawRoute.durationSeconds);
  const distanceValue = rawRoute.distanceMeters;
  const distanceMeters =
    distanceValue === null ? null : asNumber(distanceValue);
  const geometry = rawRoute.geometry;
  const bounds = rawRoute.bounds;
  if (
    id === null ||
    name === null ||
    type === null ||
    !ROUTE_TYPES.has(type as RouteType) ||
    (mode !== "car" && mode !== "walking") ||
    durationSeconds === null ||
    durationSeconds <= 0 ||
    (distanceValue !== null && distanceMeters === null) ||
    !isRecord(geometry) ||
    geometry.type !== "LineString" ||
    !Array.isArray(geometry.coordinates) ||
    geometry.coordinates.length < 2 ||
    geometry.coordinates.length > 5000 ||
    !Array.isArray(bounds) ||
    bounds.length !== 4 ||
    !bounds.every((coordinate) => typeof coordinate === "number" && Number.isFinite(coordinate))
  ) {
    return null;
  }

  const coordinates: [number, number][] = [];
  for (const point of geometry.coordinates) {
    if (
      !Array.isArray(point) ||
      point.length < 2 ||
      typeof point[0] !== "number" ||
      typeof point[1] !== "number" ||
      !Number.isFinite(point[0]) ||
      !Number.isFinite(point[1]) ||
      Math.abs(point[0]) > 180 ||
      Math.abs(point[1]) > 90
    ) {
      return null;
    }
    coordinates.push([point[0], point[1]]);
  }

  const route: Route = {
    id,
    name,
    type: type as RouteType,
    mode,
    geometry: { type: "LineString", coordinates },
    distanceMeters,
    durationSeconds,
    details: asString(rawRoute.details),
    bounds: bounds as Route["bounds"],
    steps: parseSteps(rawRoute.steps),
  };
  return { partyId, ownerId, shareCode, route };
}

function parseSharedRouteRow(value: unknown): SharedRoute | null {
  if (!isRecord(value)) return null;
  return parseSharedRoute(
    value.party_id,
    value.owner_id,
    value.share_code,
    value.route_data
  );
}

export async function sharePartyRoute(route: Route): Promise<ApiResult<SharedRoute>> {
  try {
    const shareableRoute = {
      id: route.id,
      name: route.name,
      type: route.type,
      mode: route.mode,
      geometry: route.geometry,
      distanceMeters: route.distanceMeters,
      durationSeconds: route.durationSeconds,
      details: route.details ?? null,
      bounds: route.bounds,
      steps: route.steps ?? [],
    };
    const { data, error } = await callRpc("share_party_route", { p_route: shareableRoute });
    if (error) return { ok: false, message: describeError(error) };
    const parsed = parseList(data, (row) => {
      const partyId = asString(row.party_id);
      const shareCode = asString(row.share_code);
      if (partyId === null || shareCode === null) return null;
      return { partyId, shareCode };
    })[0];
    if (!parsed) {
      return { ok: false, message: "The server did not return a party and route link." };
    }

    const confirmed = await getPartyRoute(parsed.partyId);
    if (!confirmed.ok) {
      return {
        ok: false,
        message: `The route link was created, but its saved route could not be loaded: ${confirmed.message}`,
      };
    }
    if (confirmed.data.shareCode !== parsed.shareCode) {
      return { ok: false, message: "The server returned a different route link than expected." };
    }
    return confirmed;
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function getPartyRoute(partyId: string): Promise<ApiResult<SharedRoute>> {
  try {
    const { data, error } = await callRpc("get_party_route", { p_party_id: partyId });
    if (error) return { ok: false, message: describeError(error) };
    const shared = parseList(data, (row) => parseSharedRouteRow(row))[0] ?? null;
    return shared
      ? { ok: true, data: shared }
      : { ok: false, message: "This party does not have a shareable route." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function joinSharedRoute(shareCode: string): Promise<ApiResult<SharedRoute>> {
  try {
    const { data, error } = await callRpc("join_shared_route", { p_share_code: shareCode });
    if (error) {
      const message = errorMessage(error);
      return {
        ok: false,
        message: message.includes("route_link_not_found")
          ? "This route link is invalid or has expired."
          : describeError(error),
      };
    }
    const shared = parseList(data, (row) => parseSharedRouteRow(row))[0] ?? null;
    return shared
      ? { ok: true, data: shared }
      : { ok: false, message: "The server returned an invalid shared route." };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function getPartyRouteRace(partyId: string): Promise<ApiResult<PartyRacer[]>> {
  try {
    const { data, error } = await callRpc("get_party_route_race", { p_party_id: partyId });
    if (error) return { ok: false, message: describeError(error) };
    return {
      ok: true,
      data: parseList(data, (row): PartyRacer | null => {
        const userId = asString(row.user_id);
        const username = asString(row.username);
        if (userId === null || username === null) return null;
        return {
          userId,
          username,
          avatarId: asString(row.avatar_id) ?? "avatar_01",
          latitude: asNumber(row.latitude),
          longitude: asNumber(row.longitude),
          progressMeters: asNumber(row.progress_m),
          remainingSeconds: asNumber(row.remaining_seconds),
          updatedAt: asString(row.updated_at),
          locationShared: row.location_shared === true,
        };
      }),
    };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function reportPartyRouteProgress(
  partyId: string,
  latitude: number,
  longitude: number,
  progressMeters: number,
  remainingSeconds: number
): Promise<ApiResult<null>> {
  try {
    const { error } = await callRpc("report_party_route_progress", {
      p_party_id: partyId,
      p_latitude: latitude,
      p_longitude: longitude,
      p_progress_m: Math.max(0, progressMeters),
      p_remaining_seconds: Math.max(0, Math.round(remainingSeconds)),
    });
    if (error) {
      const message = errorMessage(error);
      return {
        ok: false,
        message: message.includes("location_sharing_disabled")
          ? "Turn on location sharing in Account to appear on the route map."
          : describeError(error),
      };
    }
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function clearPartySharedRoute(partyId: string): Promise<ApiResult<null>> {
  try {
    const { error } = await callRpc("clear_party_shared_route", { p_party_id: partyId });
    if (error) return { ok: false, message: describeError(error) };
    return { ok: true, data: null };
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}

export async function acceptPartyRouteInvite(partyId: string): Promise<ApiResult<SharedRoute>> {
  try {
    const routeResult = await getPartyRoute(partyId);
    if (!routeResult.ok) return routeResult;
    const { error } = await callRpc("respond_to_party_invite", {
      p_party_id: partyId,
      p_accept: true,
    });
    if (error) return { ok: false, message: describeError(error) };
    return routeResult;
  } catch (error) {
    return { ok: false, message: describeError(error) };
  }
}
