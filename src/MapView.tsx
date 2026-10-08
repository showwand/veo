import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Map, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./hud.css";
import "./navigation.css";
import "./gps.css";
import "./accounts.css"; // NEW
import SearchBox, { type SearchFill, type SearchResult } from "./SearchBox";
import RouteOptions from "./RouteOptions";
import TravelModeSelector from "./TravelModeSelector";
import RouteGraphic from "./RouteGraphic";
import PartyButton from "./PartyButton";
import PartyPanel from "./PartyPanel";
import BottomDrawer from "./BottomDrawer";
import FriendsHub from "./FriendsHub";
import RouteRacePanel from "./RouteRacePanel";
import StartButton from "./StartButton";
import InstructionPanel from "./InstructionPanel";
import StatusPanel from "./StatusPanel";
import TargetIcon from "./TargetIcon";
import FavouritesButton from "./FavouritesButton";
import FavouritesPanel from "./FavouritesPanel";
import AccountButton from "./AccountButton"; // NEW
import AccountPanel from "./AccountPanel"; // NEW
import { placeFromFavourite, type FavouriteRoute } from "./favourites";
import { getNavInsets } from "./navInsets";
import { ensureAccountsStarted, useAccountState } from "./accountStore"; // NEW
import { useTopActionsLayout } from "./topActions"; // NEW
import { useRouteOptions } from "./useRouteOptions";
import { useRouteOsmInfo } from "./useRouteOsmInfo";
import { useNavigation } from "./useNavigation";
import { useUserMarker } from "./useUserMarker";
import { useMapFollow } from "./useMapFollow";
import { useRouteParty } from "./useRouteParty";
import { useFriendLocations, useLocationSharing } from "./friendLocations";
import { getLocationState, hasUsableFix, useLocationStatus } from "./userLocation";
import { requestOrientationPermission } from "./deviceOrientation";
import { createCameraLayer, type CameraLayer } from "./cameraLayer";
import { createEndpointLayer, type EndpointLayer } from "./endpointLayer";
import { createSpeedLimitLayer, type SpeedLimitLayer } from "./speedLimitLayer";
import type { Route, TravelMode } from "./routing";
import { fetchFastestDrivingRoute } from "./routing";
import { joinSharedRoute, type SharedRoute } from "./routePartyApi";
import { buildTrack, coordinatesThroughDistance } from "./routeMatching";

setWorkerUrl(workerUrl);

const LONDON: [number, number] = [-0.1278, 51.5074];

// "No line" - used before a route exists, and to clear the line
const EMPTY_ROUTE = { type: "FeatureCollection" as const, features: [] };

// How much of the screen to keep clear when zooming to a place or route.
// Normal mode: the search panel covers the top-left and the route panel the bottom-left,
// so on a wide screen we leave room on the left; on a small screen, top and bottom.
// Navigation mode: the black panels cover the top and bottom, so the padding is a
// share of the screen height instead, which works at any size.
// (The padding must never exceed the map itself, or MapLibre throws an error.)
function getPadding(map: Map, navigating = false) {
  const { clientWidth, clientHeight } = map.getContainer();

  if (navigating) {
    if (clientWidth <= 700) {
      return {
        top: Math.round(clientHeight * 0.18),
        bottom: Math.round(clientHeight * 0.18),
        left: 24,
        right: 24,
      };
    }
    return {
      top: Math.round(clientHeight * 0.2),
      bottom: Math.round(clientHeight * 0.42), // the bottom panel plus the route card
      left: 40,
      right: 40,
    };
  }

  const wide = clientWidth >= 900;
  const tall = clientHeight >= 600;
  return {
    top: wide ? 80 : tall ? 260 : 40,
    bottom: tall ? 150 : 40,
    left: wide ? 440 : 30,
    right: wide ? 80 : 30,
  };
}

// Zooms the map so a whole route is visible
function fitToRoute(map: Map, route: Route, navigating = false) {
  map.fitBounds(route.bounds, {
    padding: getPadding(map, navigating),
    // A slightly quicker, steadier move while the panels slide in
    ...(navigating ? { duration: 900 } : {}),
  });
}

export default function MapView() {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<Map | null>(null);
  const speedLayerRef = useRef<SpeedLimitLayer | null>(null);
  const cameraLayerRef = useRef<CameraLayer | null>(null);
  const endpointLayerRef = useRef<EndpointLayer | null>(null);

  // Remembers which route is currently drawn on the map, so that starting or
  // ending navigation re-frames the camera without re-sending the same line to MapLibre
  const drawnRouteRef = useRef<Route | null>(null);

  // True once the map style has finished loading (we can't add a line before that)
  const [mapReady, setMapReady] = useState(false);

  // The places the user picked (null = not chosen yet)
  const [start, setStart] = useState<SearchResult | null>(null);
  const [destination, setDestination] = useState<SearchResult | null>(null);

  // "Put this place in the box" requests from Favourites
  const [startFill, setStartFill] = useState<SearchFill | null>(null);
  const [destinationFill, setDestinationFill] = useState<SearchFill | null>(null);
  const fillCounter = useRef(0);
  const [travelMode, setTravelMode] = useState<TravelMode>("car");

  // All available routes between start and destination
  const { routes, status, error: routeError } = useRouteOptions(start, destination, travelMode);

  // Which route the user picked (by id). null = "use the first one".
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  // UI only: drawer, and the three top-right panels (only one is open at a time)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [partyOpen, setPartyOpen] = useState(false);
  const [favouritesOpen, setFavouritesOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false); // NEW
  const [friendsHubOpen, setFriendsHubOpen] = useState(false);
  const [routePartyId, setRoutePartyId] = useState<string | null>(null);
  const handleRouteShare = useCallback((shared: SharedRoute) => {
    setRoutePartyId(shared.partyId);
  }, []);
  const [routeInviteCode, setRouteInviteCode] = useState<string | null>(() =>
    typeof window === "undefined"
      ? null
      : new URLSearchParams(window.location.search).get("join-route")
  );
  const [joiningRoute, setJoiningRoute] = useState(false);
  const [joinRouteError, setJoinRouteError] = useState<string | null>(null);
  const [rerouteRoute, setRerouteRoute] = useState<Route | null>(null);
  const [rerouteStatus, setRerouteStatus] = useState<
    "idle" | "loading" | "ready" | "error" | "unavailable"
  >("idle");
  const [rerouteError, setRerouteError] = useState<string | null>(null);
  const [rerouteRetry, setRerouteRetry] = useState(0);
  const rerouteAttemptRef = useRef<string | null>(null);

  // The route we actually show. If the picked id isn't in the list
  // (for example after searching somewhere new), fall back to the first route.
  const selectedRoute =
    routes.find((route) => route.id === selectedRouteId) ?? routes[0] ?? null;

  // Cameras (static dataset) and roads / speed limits (Overpass) for the SELECTED route only.
  // Failures here never affect the route: info is simply null.
  const { info: osmInfo } = useRouteOsmInfo(
    selectedRoute?.mode === "car" ? selectedRoute : null
  );

  // Navigation mode. It reuses the selected route and the OSM info above.
  // GPS, route matching and instructions live inside useNavigation.
  const navigation = useNavigation(osmInfo);
  const navActive = navigation.active; // false = route selection, true = active navigation
  const navigationRoute = navigation.snapshot?.route ?? null;
  const snap = navigation.snapshot;
  const mapRoute = navActive && navigationRoute ? navigationRoute : selectedRoute;
  const instructionRerouteStatus =
    snap?.offRoute && navigationRoute?.mode !== "car" ? "unavailable" : rerouteStatus;

  // The location dot + direction cone (works before navigation too) and the Locate action
  const locationStatus = useLocationStatus();
  const user = useUserMarker(mapRef, mapReady, navActive, snap?.routeBearingDeg ?? null);
  useLocationSharing();

  // NEW: accounts. Starts Supabase's session handling once, and tells us who is signed in.
  const account = useAccountState();
  const routeParty = useRouteParty({
    mapRef,
    mapReady,
    partyId: routePartyId,
    navigationActive: navActive,
    snapshot: snap,
    userId: account.activeId,
  });
  const routeMemberIds = useMemo(
    () =>
      new Set(
        routeParty.racers
          .filter((racer) => racer.latitude !== null && racer.longitude !== null)
          .map((racer) => racer.userId)
      ),
    [routeParty.racers]
  );
  useFriendLocations(mapRef, mapReady, routeMemberIds);
  useEffect(() => {
    ensureAccountsStarted();
  }, []);

  // NEW: puts the buttons in the order Favourites | Party | Account
  useTopActionsLayout();

  // The follow camera. Dragging the map releases it; the Follow button brings it back.
  const follow = useMapFollow({
    mapRef,
    mapReady,
    active: navActive,
    routeBearingDeg: snap?.routeBearingDeg ?? null,
    getInsets: getNavInsets,
  });

  useEffect(() => {
    if (!navActive || !snap?.offRoute || !navigationRoute) {
      rerouteAttemptRef.current = null;
      return;
    }
    if (navigationRoute.mode !== "car") return;
    if (rerouteAttemptRef.current === navigationRoute.id) return;

    const fix = getLocationState().fix;
    const coordinates = navigationRoute.geometry.coordinates;
    const end = coordinates[coordinates.length - 1];
    if (!fix || !hasUsableFix() || !end) {
      let cancelled = false;
      queueMicrotask(() => {
        if (cancelled) return;
        setRerouteStatus("error");
        setRerouteError("A reliable GPS fix is needed to suggest a new route.");
      });
      return () => {
        cancelled = true;
      };
    }

    rerouteAttemptRef.current = navigationRoute.id;
    const controller = new AbortController();
    const rerouteStart = { lat: fix.lat, lon: fix.lon };
    async function requestReroute() {
      await Promise.resolve();
      if (controller.signal.aborted) return;
      setRerouteStatus("loading");
      setRerouteError(null);
      try {
        const route = await fetchFastestDrivingRoute(
          rerouteStart,
          { lat: end[1], lon: end[0] },
          controller.signal
        );
        if (controller.signal.aborted) return;
        setRerouteRoute(route);
        setRerouteStatus("ready");
      } catch (error: unknown) {
        if (controller.signal.aborted) return;
        console.error("Veode navigation: reroute request failed", error);
        setRerouteError(
          error instanceof Error ? error.message : "A new route could not be found."
        );
        setRerouteStatus("error");
      }
    }
    void requestReroute();

    return () => controller.abort();
  }, [navActive, snap?.offRoute, navigationRoute, rerouteRetry]);

  // 1. Create the map and the (empty) route layers
  useEffect(() => {
    if (!containerRef.current) return;

    let disposed = false; // true once this effect has been cleaned up
    drawnRouteRef.current = null; // a brand-new map has no line yet

    const map = new Map({
      container: containerRef.current,
      style: "/veode-map.json",
      center: LONDON,
      zoom: 11,
    });

    mapRef.current = map;

    async function setUpLayers() {
      // Read the route colours from our CSS tokens, so the design lives in one place
      const css = getComputedStyle(document.documentElement);
      const accent = css.getPropertyValue("--accent").trim() || "#c6ff00";
      const casing = css.getPropertyValue("--route-casing").trim() || "#05060a";

      map.addSource("route", { type: "geojson", data: EMPTY_ROUTE });
      map.addSource("route-traveled", { type: "geojson", data: EMPTY_ROUTE });

      const lineLayout = { "line-join": "round", "line-cap": "round" } as const;

      // Three lines stacked on top of each other. Later layers draw on top.

      // (a) A wide, blurry accent line underneath = the glow
      map.addLayer({
        id: "route-glow",
        type: "line",
        source: "route",
        layout: lineLayout,
        paint: {
          "line-color": accent,
          "line-opacity": 0.35,
          "line-blur": 8,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 12, 16, 28],
        },
      });

      // (b) A dark line slightly wider than the main one = the outline
      map.addLayer({
        id: "route-casing",
        type: "line",
        source: "route",
        layout: lineLayout,
        paint: {
          "line-color": casing,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 7, 16, 17],
        },
      });

      // (c) The bright main line on top
      map.addLayer({
        id: "route-line",
        type: "line",
        source: "route",
        layout: lineLayout,
        paint: {
          "line-color": accent,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 11],
        },
      });

      map.addLayer({
        id: "route-traveled-casing",
        type: "line",
        source: "route-traveled",
        layout: lineLayout,
        paint: {
          "line-color": casing,
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 7, 16, 17],
        },
      });

      map.addLayer({
        id: "route-traveled-line",
        type: "line",
        source: "route-traveled",
        layout: lineLayout,
        paint: {
          "line-color": "#8b909b",
          "line-width": ["interpolate", ["linear"], ["zoom"], 8, 4, 16, 11],
        },
      });

      // Speed-limit signs, added AFTER the route and BEFORE the cameras,
      // so they sit on the line but underneath the camera icons.
      try {
        speedLayerRef.current = createSpeedLimitLayer(map);
      } catch (error) {
        console.warn("Veode: speed-limit layer could not be created", error);
      }

      // Camera icons, added AFTER the signs so they draw on top.
      try {
        const cameraLayer = await createCameraLayer(map);
        if (disposed) {
          cameraLayer.destroy();
          return;
        }
        cameraLayerRef.current = cameraLayer;
      } catch (error) {
        console.warn("Veode: camera layer could not be created", error);
      }
      if (disposed) return;

      // Start/destination pins, added LAST so they draw on top of everything.
      try {
        const endpointLayer = await createEndpointLayer(map);
        if (disposed) return;
        endpointLayerRef.current = endpointLayer;
      } catch (error) {
        console.warn("Veode: start/destination markers could not be created", error);
      }
      if (disposed) return;

      setMapReady(true);
    }

    map.on("load", () => {
      void setUpLayers();
    });

    return () => {
      disposed = true;
      setMapReady(false);
      drawnRouteRef.current = null;
      speedLayerRef.current?.destroy();
      speedLayerRef.current = null;
      cameraLayerRef.current?.destroy();
      cameraLayerRef.current = null;
      endpointLayerRef.current = null;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // 2. Draw the SELECTED route (or clear the line) and fit the map to it.
  // This runs whenever the selected route changes: new search results arrive,
  // or the user picks a different option. It also runs when navigation starts or
  // ends, so the map re-frames for the black panels (and back again).
  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReady) return;

    const source = map.getSource("route") as GeoJSONSource | undefined;
    if (!source) return;

    if (!mapRoute) {
      source.setData(EMPTY_ROUTE);
      drawnRouteRef.current = null;
      return;
    }

    // Only send the line again when the route itself changed. Starting or
    // ending navigation just needs the camera to re-frame.
    if (drawnRouteRef.current !== mapRoute) {
      source.setData({
        type: "Feature",
        properties: {},
        geometry: mapRoute.geometry,
      });
      drawnRouteRef.current = mapRoute;
    }

    // When navigation starts and we have a GPS position, the follow camera
    // takes over instead of framing the whole route. Without GPS, it frames the route as before.
    if (navActive && hasUsableFix()) return;

    fitToRoute(map, mapRoute, navActive);
  }, [mapRoute, mapReady, navActive]);

  useEffect(() => {
    const source = mapRef.current?.getSource("route-traveled") as GeoJSONSource | undefined;
    if (!source) return;
    if (!navActive || !mapRoute || snap?.positionMeters === null || snap?.positionMeters === undefined) {
      source.setData(EMPTY_ROUTE);
      return;
    }

    const track = buildTrack(mapRoute.geometry.coordinates);
    const coordinates = coordinatesThroughDistance(track, snap.positionMeters);
    source.setData(
      coordinates.length > 1
        ? {
            type: "Feature",
            properties: {},
            geometry: { type: "LineString", coordinates },
          }
        : EMPTY_ROUTE
    );
  }, [mapRoute, mapReady, navActive, snap?.positionMeters]);

  // 3. Show the cameras for the selected route.
  // osmInfo is null while loading, on failure, or when there is no route, so
  // the list becomes empty and old cameras are removed straight away.
  useEffect(() => {
    if (!mapReady) return;
    cameraLayerRef.current?.setCameras(osmInfo?.cameras ?? []);
  }, [osmInfo, mapReady]);

  // 3b. Show the speed-limit signs for the selected route.
  useEffect(() => {
    if (!mapReady) return;
    void speedLayerRef.current?.setSigns(osmInfo?.speedSigns ?? []);
  }, [osmInfo, mapReady]);

  // 4. Show the start and destination pins.
  // Runs when either place changes. A null place removes that pin.
  useEffect(() => {
    if (!mapReady) return;
    endpointLayerRef.current?.setEndpoints(start, destination);
  }, [start, destination, mapReady]);

  // Called when the user clicks a route card
  function handleRouteSelect(routeId: string) {
    setSelectedRouteId(routeId);

    // Clicking the route that is ALREADY selected changes nothing in state,
    // so the effect above won't run. Re-fit the map here so the click still does something.
    const map = mapRef.current;
    if (map && selectedRoute && routeId === selectedRoute.id) {
      fitToRoute(map, selectedRoute, navActive);
    }
  }

  function handleTravelModeChange(mode: TravelMode) {
    setTravelMode(mode);
    setSelectedRouteId(null);
  }

  // Move the map to a place the user just picked
  function moveMapTo(result: SearchResult) {
    const map = mapRef.current;
    if (!map) return;
    map.fitBounds(result.bounds, { padding: getPadding(map), maxZoom: 17 });
  }

  function handleStartSelect(result: SearchResult) {
    setStart(result);
    setSelectedRouteId(null);
    moveMapTo(result);
  }

  function handleDestinationSelect(result: SearchResult) {
    setDestination(result);
    setSelectedRouteId(null);
    moveMapTo(result);
  }

  // Loading a favourite fills the two existing search boxes and sets A and B.
  // The normal routing flow (useRouteOptions) then runs by itself: no second routing system.
  function handleLoadFavourite(favourite: FavouriteRoute) {
    if (navActive) return;
    const from = placeFromFavourite(favourite.start, -1);
    const to = placeFromFavourite(favourite.destination, -2);
    fillCounter.current += 1;
    setStartFill({ place: from, key: fillCounter.current });
    fillCounter.current += 1;
    setDestinationFill({ place: to, key: fillCounter.current });
    setStart(from);
    setDestination(to);
    setSelectedRouteId(null);
    setFavouritesOpen(false);
  }

  // Pressing Start. The three top panels and the drawer fold away first
  // (they stay mounted; they just close), then navigation begins.
  function handleStartNavigation(route: Route) {
    if (navActive) return;
    setRerouteRoute(null);
    setRerouteStatus("idle");
    setRerouteError(null);
    setFriendsHubOpen(false);
    setPartyOpen(false);
    setFavouritesOpen(false);
    setAccountOpen(false); // NEW
    setDrawerOpen(false);
    follow.enableFollow(); // every navigation begins by following the car
    void requestOrientationPermission(); // iOS needs this from a tap
    navigation.start(route); // this also asks for GPS (see useNavigation)
  }

  function handleUseReroute() {
    if (!rerouteRoute) return;
    rerouteAttemptRef.current = null;
    setRerouteRoute(null);
    setRerouteStatus("idle");
    navigation.replaceRoute(rerouteRoute);
    follow.enableFollow();
  }

  function handleEndNavigation() {
    setRerouteRoute(null);
    setRerouteStatus("idle");
    setRerouteError(null);
    navigation.end();
  }

  function handleRetryReroute() {
    rerouteAttemptRef.current = null;
    setRerouteStatus("idle");
    setRerouteError(null);
    setRerouteRetry((value) => value + 1);
  }

  function handleDismissReroute() {
    rerouteAttemptRef.current = navigationRoute?.id ?? null;
    setRerouteRoute(null);
    setRerouteStatus("idle");
    setRerouteError(null);
  }

  // The drawer opens by hovering the bottom edge. That must not happen
  // while navigating, because the drawer stays mounted (invisible) during navigation.
  function handleDrawerOpenChange(open: boolean) {
    if (navActive && open) return;
    setDrawerOpen(open);
  }

  function handleJoinedRoute(shared: SharedRoute) {
    setRerouteRoute(null);
    setRerouteStatus("idle");
    setRerouteError(null);
    setRoutePartyId(shared.partyId);
    setRouteInviteCode(null);
    setJoinRouteError(null);
    setFriendsHubOpen(false);
    setPartyOpen(false);
    setFavouritesOpen(false);
    setAccountOpen(false);
    const url = new URL(window.location.href);
    url.searchParams.delete("join-route");
    window.history.replaceState(null, "", url);
    void requestOrientationPermission();
    navigation.start(shared.route);
    follow.enableFollow();
  }

  async function handleJoinRouteLink() {
    if (!routeInviteCode || !account.activeId || joiningRoute) return;
    setJoiningRoute(true);
    setJoinRouteError(null);
    const result = await joinSharedRoute(routeInviteCode);
    setJoiningRoute(false);
    if (!result.ok) {
      setJoinRouteError(result.message);
      return;
    }
    handleJoinedRoute(result.data);
  }

  // The card list is ALWAYS the full list. In navigation mode CSS fades the
  // unselected cards and closes their gap, instead of React deleting them.
  const cardSelectedId =
    navActive && navigationRoute ? navigationRoute.id : (selectedRoute?.id ?? null);

  const stackClass = [
    "left-stack",
    drawerOpen && !navActive ? "is-raised" : "",
    navActive ? "is-navigating" : "",
  ]
    .filter(Boolean)
    .join(" ");

  // The Locate button's look
  const locateClass =
    locationStatus === "denied"
      ? "locate-button is-blocked"
      : locationStatus === "idle" || locationStatus === "unsupported"
        ? "locate-button"
        : "locate-button is-on";
  const locateTitle =
    locationStatus === "denied"
      ? "Location is blocked in your browser settings"
      : "Show my location";

  return (
    <div className={navActive ? "map-wrapper is-navigating" : "map-wrapper"}>
      <div ref={containerRef} className="map-container" />

      {/* Left column: search panel on top, route cards below.
          In navigation mode (class is-navigating) the search panel fades away, the
          unselected cards fade and close up, and the column lifts so the selected card
          sits just above the bottom black panel. Nothing here is mounted or unmounted. */}
      <div className={stackClass}>
        <div className="search-panel">
          <header className="brand">
            <span className="brand-mark" />
            <span className="brand-name">Veode</span>
            <span className="brand-tag">Navigation</span>
          </header>

          <SearchBox
            variant="start"
            placeholder="Starting point"
            onSelect={handleStartSelect}
            onClear={() => setStart(null)}
            fill={startFill}
          />
          <SearchBox
            variant="end"
            placeholder="Where to?"
            onSelect={handleDestinationSelect}
            onClear={() => setDestination(null)}
            fill={destinationFill}
          />

          <TravelModeSelector
            value={travelMode}
            onChange={handleTravelModeChange}
            disabled={navActive}
          />

          <RouteGraphic
            start={start}
            destination={destination}
            active={selectedRoute !== null}
            routeId={selectedRoute?.id ?? null}
          />
        </div>

        <div className="left-stack-spacer" />

        {/* Stays mounted while navigating (CSS folds it away), so it can animate.
            It only begins navigation. */}
        {selectedRoute && status === "done" && selectedRoute.mode !== "public-transport" && (
          <StartButton onStart={() => handleStartNavigation(selectedRoute)} />
        )}

        <RouteOptions
          routes={routes}
          selectedId={cardSelectedId}
          status={status}
          mode={travelMode}
          error={routeError}
          onSelect={handleRouteSelect}
        />
        {travelMode === "public-transport" && status === "done" && (
          <p className="route-mode-note">
            TfL journey options are shown. In-app turn-by-turn transit guidance is not available yet.
          </p>
        )}
      </div>

      {/* The party control stays available during navigation; other map actions fold away.
          Opening one panel closes the other panels. */}
      <div
        className={navActive ? "nav-aside is-navigating" : "nav-aside"}
      >
        <PartyButton
          active={partyOpen}
          onClick={() => {
            setFavouritesOpen(false);
            setAccountOpen(false);
            setPartyOpen((open) => !open);
          }}
        />
        <PartyPanel
          open={partyOpen}
          onClose={() => setPartyOpen(false)}
          route={navActive ? navigationRoute : selectedRoute}
          onShareRoute={handleRouteShare}
          onStopSharing={() => setRoutePartyId(null)}
          onJoinRoute={handleJoinedRoute}
        />

        <FavouritesButton
          active={favouritesOpen}
          onClick={() => {
            setPartyOpen(false);
            setAccountOpen(false);
            setFavouritesOpen((open) => !open);
          }}
        />
        <FavouritesPanel
          open={favouritesOpen}
          onClose={() => setFavouritesOpen(false)}
          start={start}
          destination={destination}
          onLoad={handleLoadFavourite}
          accountId={account.activeId}
          accountName={account.profile?.username ?? null}
        />

        {/* NEW */}
        <AccountButton
          active={accountOpen}
          onClick={() => {
            setPartyOpen(false);
            setFavouritesOpen(false);
            setAccountOpen((open) => !open);
          }}
        />
        <AccountPanel open={accountOpen} onClose={() => setAccountOpen(false)} />

        <BottomDrawer
          open={drawerOpen}
          onOpenChange={handleDrawerOpenChange}
          onOpenFriends={() => {
            setPartyOpen(false);
            setFavouritesOpen(false);
            setAccountOpen(false);
            setFriendsHubOpen(true);
          }}
        />

        <button
          type="button"
          className={locateClass}
          onClick={user.locate}
          aria-label={locateTitle}
          title={locateTitle}
          tabIndex={navActive ? -1 : 0}
        >
          <TargetIcon />
        </button>
      </div>

      {friendsHubOpen && (
        <FriendsHub
          onClose={() => setFriendsHubOpen(false)}
          onOpenAccount={() => {
            setFriendsHubOpen(false);
            setAccountOpen(true);
          }}
        />
      )}

      {navActive && routePartyId && (
        <RouteRacePanel
          racers={routeParty.racers}
          error={routeParty.error}
          userId={account.activeId}
        />
      )}

      {routeInviteCode && !navActive && !accountOpen && (
        <section className="route-join-prompt" role="dialog" aria-modal="true" aria-label="Join shared route">
          <div className="route-join-card">
            <div className="route-join-kicker">VEODE ROUTE LINK</div>
            <h2>JOIN THE RUN</h2>
            <p>
              Join this route to navigate alongside the party. Their standings and live map positions
              are visible while each member has location sharing enabled.
            </p>
            {joinRouteError && <div className="route-join-error" role="alert">{joinRouteError}</div>}
            {!account.activeId ? (
              <button
                type="button"
                className="route-join-primary"
                onClick={() => {
                  setAccountOpen(true);
                }}
              >
                SIGN IN TO JOIN
              </button>
            ) : (
              <button
                type="button"
                className="route-join-primary"
                disabled={joiningRoute}
                onClick={() => void handleJoinRouteLink()}
              >
                {joiningRoute ? "CONNECTING…" : "JOIN ROUTE"}
              </button>
            )}
            <button
              type="button"
              className="route-join-cancel"
              onClick={() => {
                setRouteInviteCode(null);
                const url = new URL(window.location.href);
                url.searchParams.delete("join-route");
                window.history.replaceState(null, "", url);
              }}
            >
              NOT NOW
            </button>
          </div>
        </section>
      )}

      {/* The two black navigation panels. They slide in together. */}
      <InstructionPanel
        open={navActive}
        maneuver={snap?.maneuver ?? null}
        destinationName={destination ? (destination.name.split(", ")[0] ?? null) : null}
        arrived={snap?.arrived ?? false}
        offRoute={snap?.offRoute ?? false}
        positionOnRoute={snap?.positionOnRoute ?? null}
        distanceFromRouteM={snap?.distanceFromRouteM ?? null}
        gpsStatus={snap?.gpsStatus ?? "idle"}
        gpsAccuracyM={snap?.gpsAccuracyM ?? null}
        hasTurnData={snap?.hasTurnData ?? false}
        rerouteStatus={instructionRerouteStatus}
        rerouteRoute={rerouteRoute}
        rerouteError={rerouteError}
        onUseReroute={handleUseReroute}
        onRetryReroute={handleRetryReroute}
        onDismissReroute={handleDismissReroute}
      />
      <StatusPanel
        open={navActive}
        snapshot={snap}
        followUser={follow.followUser}
        onFollow={follow.enableFollow}
        onEnd={handleEndNavigation}
      />
    </div>
  );
}