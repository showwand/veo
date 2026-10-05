import { useEffect, useRef, useState } from "react";
import { Map, setWorkerUrl, type GeoJSONSource } from "maplibre-gl";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import "maplibre-gl/dist/maplibre-gl.css";
import "./hud.css";
import "./navigation.css";
import "./gps.css";
import "./accounts.css"; // NEW
import SearchBox, { type SearchFill, type SearchResult } from "./SearchBox";
import RouteOptions from "./RouteOptions";
import RouteGraphic from "./RouteGraphic";
import PartyButton from "./PartyButton";
import PartyPanel from "./PartyPanel";
import BottomDrawer from "./BottomDrawer";
import StartButton from "./StartButton";
import InstructionPanel from "./InstructionPanel";
import StatusPanel from "./StatusPanel";
import TargetIcon from "./TargetIcon";
import HeadingBadge from "./HeadingBadge";
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
import { useFriendLocations, useLocationSharing } from "./friendLocations";
import { hasUsableFix, useLocationStatus } from "./userLocation";
import { requestOrientationPermission } from "./deviceOrientation";
import { createCameraLayer, type CameraLayer } from "./cameraLayer";
import { createEndpointLayer, type EndpointLayer } from "./endpointLayer";
import { createSpeedLimitLayer, type SpeedLimitLayer } from "./speedLimitLayer";
import type { Route } from "./routing";

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

  // All available routes between start and destination
  const { routes, status } = useRouteOptions(start, destination);

  // Which route the user picked (by id). null = "use the first one".
  const [selectedRouteId, setSelectedRouteId] = useState<string | null>(null);

  // UI only: drawer, and the three top-right panels (only one is open at a time)
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [partyOpen, setPartyOpen] = useState(false);
  const [favouritesOpen, setFavouritesOpen] = useState(false);
  const [accountOpen, setAccountOpen] = useState(false); // NEW

  // The route we actually show. If the picked id isn't in the list
  // (for example after searching somewhere new), fall back to the first route.
  const selectedRoute =
    routes.find((route) => route.id === selectedRouteId) ?? routes[0] ?? null;

  // Cameras (static dataset) and roads / speed limits (Overpass) for the SELECTED route only.
  // Failures here never affect the route: info is simply null.
  const { info: osmInfo } = useRouteOsmInfo(selectedRoute);

  // Navigation mode. It reuses the selected route and the OSM info above.
  // GPS, route matching and instructions live inside useNavigation.
  const navigation = useNavigation(osmInfo);
  const navActive = navigation.active; // false = route selection, true = active navigation
  const navigationRoute = navigation.snapshot?.route ?? null;
  const snap = navigation.snapshot;

  // The location dot + direction cone (works before navigation too) and the Locate action
  const locationStatus = useLocationStatus();
  const user = useUserMarker(mapRef, mapReady);
  useLocationSharing();
  useFriendLocations(mapRef, mapReady);

  // NEW: accounts. Starts Supabase's session handling once, and tells us who is signed in.
  const account = useAccountState();
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
    getInsets: getNavInsets,
  });

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

    if (!selectedRoute) {
      source.setData(EMPTY_ROUTE);
      drawnRouteRef.current = null;
      return;
    }

    // Only send the line again when the route itself changed. Starting or
    // ending navigation just needs the camera to re-frame.
    if (drawnRouteRef.current !== selectedRoute) {
      source.setData({
        type: "Feature",
        properties: {},
        geometry: selectedRoute.geometry,
      });
      drawnRouteRef.current = selectedRoute;
    }

    // When navigation starts and we have a GPS position, the follow camera
    // takes over instead of framing the whole route. Without GPS, it frames the route as before.
    if (navActive && hasUsableFix()) return;

    fitToRoute(map, selectedRoute, navActive);
  }, [selectedRoute, mapReady, navActive]);

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
    setPartyOpen(false);
    setFavouritesOpen(false);
    setAccountOpen(false); // NEW
    setDrawerOpen(false);
    follow.enableFollow(); // every navigation begins by following the car
    void requestOrientationPermission(); // iOS needs this from a tap
    navigation.start(route); // this also asks for GPS (see useNavigation)
  }

  // The drawer opens by hovering the bottom edge. That must not happen
  // while navigating, because the drawer stays mounted (invisible) during navigation.
  function handleDrawerOpenChange(open: boolean) {
    if (navActive && open) return;
    setDrawerOpen(open);
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
        {selectedRoute && status === "done" && (
          <StartButton onStart={() => handleStartNavigation(selectedRoute)} />
        )}

        <RouteOptions
          routes={routes}
          selectedId={cardSelectedId}
          status={status}
          onSelect={handleRouteSelect}
        />
      </div>

      {/* The top-right buttons (Favourites | Party | Account), their panels, the drawer and the
          Locate button stay mounted inside .nav-aside, which fades out during navigation.
          CHANGED: opening one panel closes the other two. */}
      <div
        className={navActive ? "nav-aside is-hidden" : "nav-aside"}
        aria-hidden={navActive}
      >
        <PartyButton
          active={partyOpen}
          onClick={() => {
            setFavouritesOpen(false);
            setAccountOpen(false);
            setPartyOpen((open) => !open);
          }}
        />
        <PartyPanel open={partyOpen} onClose={() => setPartyOpen(false)} />

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

        <BottomDrawer open={drawerOpen} onOpenChange={handleDrawerOpenChange} />

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

      {/* Which way Veode thinks you face, and where that comes from */}
      <HeadingBadge />

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
      />
      <StatusPanel
        open={navActive}
        snapshot={snap}
        followUser={follow.followUser}
        onFollow={follow.enableFollow}
        onEnd={navigation.end}
      />
    </div>
  );
}