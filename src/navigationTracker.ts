import type { Route } from "./routing";
import { distanceBetween } from "./routeGeometry";
import { buildTrack, matchToRoute, pointAt, type RouteTrack } from "./routeMatching";
import type { RouteStep } from "./osrmSteps";
import { NO_LIVE_DATA, type LiveNavigationData, type Maneuver } from "./navigationTypes";
import { MAX_USABLE_ACCURACY_M, type LocationFix, type LocationState } from "./userLocation";

// ---------- Settings you can tweak later ----------

// "On the route" = within the GPS accuracy of it, but never tighter than 40 m or looser than 120 m
const ON_ROUTE_MIN_M = 40;
const ON_ROUTE_MAX_M = 120;
// Off route = not on the route for 3 readings in a row AND 4 s...
const OFF_ROUTE_READINGS = 3;
const OFF_ROUTE_MIN_MS = 4000;
// ...or, if clearly far away (this far), 2 readings in a row are enough
const OFF_ROUTE_FAR_M = 250;
const OFF_ROUTE_FAR_READINGS = 2;
// After this many misses the panel stops showing a distance it can't vouch for
const UNSURE_READINGS = 2;
// Progress may go BACKWARDS only if the new match is further back than this (GPS wobble
// can't undo progress, but a genuine move back, or a jump, is accepted)
const BACK_TOLERANCE_MIN_M = 30;
const BACK_TOLERANCE_MAX_M = 100;
// Arrived = within the GPS accuracy (40 to 100 m) of the destination, near the end of the route
const ARRIVAL_MIN_RADIUS_M = 40;
const ARRIVAL_MAX_RADIUS_M = 100;
const ARRIVAL_NEAR_END_M = 250;
// A maneuver counts as done once we are this far past it
const MANEUVER_PASSED_M = 15;
// GPS speed older than this is not shown
const SPEED_MAX_AGE_MS = 10000;
const MPS_TO_MPH = 2.23694;
// Console logging: only when a value changes by this much
const LOG_POSITION_STEP_M = 5;
const LOG_PROGRESS_STEP_M = 20;
const LOG_DISTANCE_STEP_M = 25;

const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, value));

// All the navigation maths, with no React in it. It receives GPS readings and
// publishes a LiveNavigationData that useNavigation turns into UI.
export class NavigationTracker {
  private route: Route | null = null;
  private track: RouteTrack | null = null;
  private steps: RouteStep[] = [];
  private announced: RouteStep[] = [];

  private progress = 0;
  private hasProgress = false;
  private lastFix: LocationFix | null = null;
  private missCount = 0;
  private missingSince: number | null = null;
  private offRoute = false;
  private arrived = false;
  private lastMatchDistanceM: number | null = null;
  private routeBearingDeg: number | null = null;
  private hasMatch = false;

  private snapshot: LiveNavigationData = NO_LIVE_DATA;
  private listeners = new Set<() => void>();

  // what was last printed to the console
  private logged = {
    lat: Number.NaN,
    lon: Number.NaN,
    progress: Number.NaN,
    stepKey: "",
    distance: Number.NaN,
    ignoredFor: "",
  };

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LiveNavigationData => this.snapshot;

  private emit() {
    for (const listener of [...this.listeners]) listener();
  }

  // Navigation started on this route: forget everything from before
  begin(route: Route) {
    this.route = route;
    this.track = buildTrack(route.geometry.coordinates);
    this.steps = route.steps ?? [];
    this.announced = this.steps.filter((step) => step.announce);
    this.progress = 0;
    this.hasProgress = false;
    this.lastFix = null;
    this.missCount = 0;
    this.missingSince = null;
    this.offRoute = false;
    this.arrived = false;
    this.lastMatchDistanceM = null;
    this.routeBearingDeg = null;
    this.hasMatch = false;
    this.snapshot = NO_LIVE_DATA;
    this.logged = {
      lat: Number.NaN,
      lon: Number.NaN,
      progress: Number.NaN,
      stepKey: "",
      distance: Number.NaN,
      ignoredFor: "",
    };
    this.logTestPoints(this.track);
    this.emit();
  }

  // Navigation ended: stop reacting. The last values stay so the panels can slide out with content.
  end() {
    this.route = null;
    this.track = null;
  }

  // Called with the latest location state (every GPS reading, and every status change)
  ingest(location: LocationState): void {
    const track = this.track;
    if (!this.route || !track) return;

    const fix = location.fix;
    if (fix && fix !== this.lastFix) {
      this.lastFix = fix;
      if (fix.accuracyM <= MAX_USABLE_ACCURACY_M) this.process(fix, track);
      else this.logIgnored(fix);
    }

    this.publish(location, fix, track, Date.now());
  }

  private logIgnored(fix: LocationFix) {
    const key = `accuracy ${Math.round(fix.accuracyM)}`;
    if (this.logged.ignoredFor === key) return;
    this.logged.ignoredFor = key;
    console.log(
      `Veode navigation: reading ignored, accuracy ±${Math.round(fix.accuracyM)} m is worse than ${MAX_USABLE_ACCURACY_M} m`
    );
  }

  private process(fix: LocationFix, track: RouteTrack) {
    this.logged.ignoredFor = "";
    const match = matchToRoute(track, fix.lat, fix.lon, this.hasProgress ? this.progress : null);
    if (!match) return;

    const threshold = clamp(fix.accuracyM, ON_ROUTE_MIN_M, ON_ROUTE_MAX_M);
    const onRoute = match.distanceM <= threshold;
    this.hasMatch = true;
    this.lastMatchDistanceM = match.distanceM;
    this.routeBearingDeg = match.bearingDeg;

    if (onRoute) {
      this.missCount = 0;
      this.missingSince = null;
      this.offRoute = false;

      if (!this.hasProgress) {
        this.progress = match.progressMeters;
      } else {
        const back = this.progress - match.progressMeters;
        const tolerance = clamp(fix.accuracyM, BACK_TOLERANCE_MIN_M, BACK_TOLERANCE_MAX_M);
        if (back <= tolerance) {
          // Normal driving or wobble: progress only moves forward
          this.progress = Math.max(this.progress, match.progressMeters);
        } else {
          // A genuine move back (or a jump): believe the new position
          this.progress = match.progressMeters;
          console.log(
            `Veode navigation: progress moved BACK by ${Math.round(back)} m (accepted, more than ${Math.round(tolerance)} m)`
          );
        }
      }
      this.hasProgress = true;
    } else {
      this.missCount += 1;
      this.missingSince ??= fix.timestamp;
      const far = match.distanceM >= OFF_ROUTE_FAR_M;
      const longEnough =
        this.missCount >= OFF_ROUTE_READINGS && fix.timestamp - this.missingSince >= OFF_ROUTE_MIN_MS;
      if ((far && this.missCount >= OFF_ROUTE_FAR_READINGS) || longEnough) {
        this.offRoute = true;
      }
    }

    // ----- arrival: GPS position is the source of truth, never the ETA clock -----
    if (!this.arrived && this.hasProgress) {
      const end = track.coords[track.coords.length - 1];
      if (end) {
        const toEnd = distanceBetween({ lat: fix.lat, lon: fix.lon }, { lat: end[1], lon: end[0] });
        const radius = clamp(fix.accuracyM, ARRIVAL_MIN_RADIUS_M, ARRIVAL_MAX_RADIUS_M);
        const remaining = track.lengthMeters - this.progress;
        if (toEnd <= radius && remaining <= ARRIVAL_NEAR_END_M + radius) this.arrived = true;
      }
    }

    // ----- diagnostics -----
    const movedSinceLog = Number.isNaN(this.logged.lat)
      ? Infinity
      : distanceBetween(
          { lat: this.logged.lat, lon: this.logged.lon },
          { lat: fix.lat, lon: fix.lon }
        );
    if (movedSinceLog >= LOG_POSITION_STEP_M) {
      this.logged.lat = fix.lat;
      this.logged.lon = fix.lon;
      console.log("Veode navigation: position", {
        lat: Number(fix.lat.toFixed(6)),
        lon: Number(fix.lon.toFixed(6)),
        accuracyM: Math.round(fix.accuracyM),
        fromRouteM: Math.round(match.distanceM),
        allowedM: Math.round(threshold),
        onRoute,
        misses: this.missCount,
      });
    }
  }

  // The first announced maneuver that is still ahead of us
  private pickStep(): RouteStep | null {
    return (
      this.announced.find((step) => step.startMeters > this.progress - MANEUVER_PASSED_M) ?? null
    );
  }

  // Time left, from the durations OSRM gave each step (no traffic involved)
  private remainingSeconds(route: Route, track: RouteTrack): number {
    if (this.arrived) return 0;
    if (this.steps.length === 0) {
      const done = track.lengthMeters > 0 ? Math.min(1, this.progress / track.lengthMeters) : 0;
      return route.durationSeconds * (1 - done);
    }

    let index = 0;
    this.steps.forEach((step, i) => {
      if (step.startMeters <= this.progress) index = i;
    });

    const current = this.steps[index];
    if (!current) return route.durationSeconds;
    const into = (this.progress - current.startMeters) / Math.max(1, current.lengthMeters);
    let seconds = current.durationSeconds * (1 - Math.min(1, Math.max(0, into)));
    for (let i = index + 1; i < this.steps.length; i++) seconds += this.steps[i]?.durationSeconds ?? 0;
    return seconds;
  }

  private publish(
    location: LocationState,
    fix: LocationFix | null,
    track: RouteTrack,
    now: number
  ) {
    const route = this.route;
    if (!route) return;
    const known = this.hasProgress;

    const step = known && !this.arrived ? this.pickStep() : null;
    const maneuver: Maneuver | null = step
      ? {
          kind: step.kind,
          instruction: step.instruction,
          // From the CURRENT GPS position along the route, never the original OSRM step length
          distanceMeters: Math.max(0, step.startMeters - this.progress),
        }
      : null;

    const speedFresh = location.receivedAt !== null && now - location.receivedAt <= SPEED_MAX_AGE_MS;

    this.snapshot = {
      // No position yet = no instruction. We never show a turn measured from a place the car isn't.
      maneuver,
      positionMeters: known ? this.progress : null,
      progressFraction:
        known && track.lengthMeters > 0 ? Math.min(1, this.progress / track.lengthMeters) : null,
      routeBearingDeg: this.routeBearingDeg,
      // GPS speed only. null when the device doesn't report one: it is never estimated.
      currentSpeedMph:
        fix && fix.speedMps !== null && speedFresh ? fix.speedMps * MPS_TO_MPH : null,
      remainingSeconds: known ? this.remainingSeconds(route, track) : null,
      remainingMeters: known ? Math.max(0, track.lengthMeters - this.progress) : null,
      offRoute: this.offRoute,
      arrived: this.arrived,
      positionOnRoute: this.hasMatch ? this.missCount < UNSURE_READINGS : null,
      distanceFromRouteM: this.lastMatchDistanceM,
      gpsStatus: location.status,
      accuracyM: fix ? fix.accuracyM : null,
      updatedAt: now,
    };

    this.logNavigation(step, maneuver);
    this.emit();
  }

  // Console diagnostics: a line only when the value changed meaningfully
  private logNavigation(step: RouteStep | null, maneuver: Maneuver | null) {
    if (!this.hasProgress) return;

    if (
      Number.isNaN(this.logged.progress) ||
      Math.abs(this.progress - this.logged.progress) >= LOG_PROGRESS_STEP_M
    ) {
      this.logged.progress = this.progress;
      console.log("Veode navigation: progress", {
        progressM: Math.round(this.progress),
        ofM: Math.round(this.track?.lengthMeters ?? 0),
      });
    }

    const key = step ? `${Math.round(step.startMeters)}|${step.instruction}` : "none";
    if (key !== this.logged.stepKey) {
      this.logged.stepKey = key;
      this.logged.distance = Number.NaN;
      console.log("Veode navigation: next maneuver", {
        instruction: step?.instruction ?? null,
        atRouteM: step ? Math.round(step.startMeters) : null,
      });
    }

    if (
      maneuver &&
      (Number.isNaN(this.logged.distance) ||
        Math.abs(maneuver.distanceMeters - this.logged.distance) >= LOG_DISTANCE_STEP_M)
    ) {
      this.logged.distance = maneuver.distanceMeters;
      console.log("Veode navigation: distance to maneuver", {
        meters: Math.round(maneuver.distanceMeters),
        progressM: Math.round(this.progress),
        maneuverAtM: step ? Math.round(step.startMeters) : null,
      });
    }
  }

  // TEMPORARY: real coordinates ON the selected route, to paste into
  // Chrome DevTools -> Sensors -> Location (typed coordinates rarely land exactly on a road)
  private logTestPoints(track: RouteTrack) {
    const rows: { point: string; lat: number; lon: number }[] = [];
    const add = (point: string, meters: number) => {
      const p = pointAt(track, clamp(meters, 0, track.lengthMeters));
      if (p) rows.push({ point, lat: Number(p[1].toFixed(6)), lon: Number(p[0].toFixed(6)) });
    };

    add("route start", 0);
    for (const step of this.announced.slice(0, 6)) {
      const text = step.instruction.slice(0, 38);
      add(`300 m before: ${text}`, step.startMeters - 300);
      add(`100 m before: ${text}`, step.startMeters - 100);
      add(`30 m after:   ${text}`, step.startMeters + 30);
    }
    add("route end", track.lengthMeters);

    console.log("Veode navigation: TEMPORARY test points on this route (paste into DevTools Sensors)");
    console.table(rows);
  }
}