import { useEffect, useState, useSyncExternalStore } from "react";
import { distanceBetween } from "./routeGeometry";
import {
  getLocationState,
  releaseLocation,
  requestLocation,
  subscribeLocation,
} from "./userLocation";

// Set this to a monitored address via VITE_NOMINATIM_CONTACT_EMAIL.
const CONTACT_EMAIL: unknown = import.meta.env.VITE_NOMINATIM_CONTACT_EMAIL;

const MIN_CHARS = 3; // don't search for very short text
const SEARCH_DEBOUNCE_MS = 450;
const NOMINATIM_MIN_INTERVAL_MS = 1000;
const MAX_RESULTS = 8;
let lastNominatimRequestAt = 0;

// The simplified shape we use in the rest of the app
export type SearchResult = {
  id: number;
  name: string;
  lat: number;
  lon: number;
  // [west, south, east, north] - the area the place covers, used to pick a zoom level
  bounds: [number, number, number, number];
};

// "Put this place in the box". The key changes every time, so the same place can be applied again.
export type SearchFill = { place: SearchResult; key: number };

// The parts of a Nominatim result that we use
interface NominatimPlace {
  place_id: number;
  display_name: string;
  name?: string;
  lat: string; // Nominatim sends coordinates as strings
  lon: string;
  importance?: number;
  // [south, north, west, east], also strings
  boundingbox: [string, string, string, string];
}

type Status = "idle" | "loading" | "done" | "error";

type Props = {
  placeholder: string;
  variant: "start" | "end"; // decides whether the badge says A or B
  onSelect: (result: SearchResult) => void;
  onClear: () => void;
  fill?: SearchFill | null; // used by Favourites to fill the box
};

export default function SearchBox({
  placeholder,
  variant,
  onSelect,
  onClear,
  fill = null,
}: Props) {
  const [query, setQuery] = useState(""); // text shown in the input
  const [results, setResults] = useState<SearchResult[]>([]);
  const [status, setStatus] = useState<Status>("idle");
  const [appliedFill, setAppliedFill] = useState<number | null>(null);
  const [focused, setFocused] = useState(false);
  const [searchEnabled, setSearchEnabled] = useState(false);
  const [searchNow, setSearchNow] = useState(0);
  const location = useSyncExternalStore(subscribeLocation, getLocationState);
  const hasLocationFix = location.fix !== null;

  // A new `fill` from outside puts that place's name in the box (React's documented
  // "adjust state while rendering" pattern, so no extra effect is needed)
  if (fill && fill.key !== appliedFill) {
    setAppliedFill(fill.key);
    setQuery(fill.place.name);
    setResults([]);
    setStatus("idle");
    setSearchEnabled(false);
  }

  // Release only the search-owned GPS reason; map following stays independent.
  useEffect(() => {
    return () => releaseLocation("search");
  }, []);

  useEffect(() => {
    const term = query.trim();
    if (!searchEnabled || term.length < MIN_CHARS) return;

    const controller = new AbortController();
    let timer = 0;
    const startSearch = () => {
      const wait = lastNominatimRequestAt + NOMINATIM_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) {
        timer = window.setTimeout(startSearch, wait);
        return;
      }
      lastNominatimRequestAt = Date.now();
      setStatus("loading");
      setResults([]);

      const fix = getLocationState().fix;
      const params = new URLSearchParams({
        q: term,
        format: "jsonv2",
        limit: String(MAX_RESULTS),
        addressdetails: "1",
        dedupe: "1",
      });
      if (typeof CONTACT_EMAIL === "string" && CONTACT_EMAIL.includes("@")) {
        params.set("email", CONTACT_EMAIL.trim());
      }
      if (fix) {
        const span = 1.5;
        params.set(
          "viewbox",
          `${Math.max(-180, fix.lon - span)},${Math.min(90, fix.lat + span)},${Math.min(180, fix.lon + span)},${Math.max(-90, fix.lat - span)}`
        );
        params.set("bounded", "0");
      }

      void fetch(`https://nominatim.openstreetmap.org/search?${params.toString()}`, {
        signal: controller.signal,
      })
        .then((response) => {
          if (!response.ok) throw new Error(`Search failed: ${response.status}`);
          return response.json() as Promise<NominatimPlace[]>;
        })
        .then((data) => {
          if (controller.signal.aborted) return;
          const normalizedTerm = normalizeSearchText(term);
          const terms = normalizedTerm.split(/\s+/).filter(Boolean);
          const ranked = data.map((item, index) => {
            const [south, north, west, east] = item.boundingbox;
            const result: SearchResult = {
              id: item.place_id,
              name: item.display_name,
              lat: Number(item.lat),
              lon: Number(item.lon),
              bounds: [Number(west), Number(south), Number(east), Number(north)],
            };
            const placeName = normalizeSearchText(item.name ?? item.display_name.split(",")[0]);
            const displayName = normalizeSearchText(item.display_name);
            const nameHasAllTerms = terms.every((word) => placeName.includes(word));
            const resultHasAllTerms = terms.every((word) => displayName.includes(word));
            const matchRank =
              placeName === normalizedTerm
                ? 0
                : placeName.startsWith(normalizedTerm)
                  ? 1
                  : nameHasAllTerms
                    ? 2
                    : resultHasAllTerms
                      ? 3
                      : 4;
            const distance = fix ? distanceBetween(fix, result) : 0;
            return {
              result,
              index,
              matchRank,
              distance,
              importance: Number.isFinite(item.importance) ? item.importance ?? 0 : 0,
            };
          });

          ranked.sort(
            (a, b) =>
              a.matchRank - b.matchRank ||
              a.distance - b.distance ||
              b.importance - a.importance ||
              a.index - b.index
          );
          setResults(ranked.map((item) => item.result));
          setStatus("done");
        })
        .catch((error: unknown) => {
          if (error instanceof DOMException && error.name === "AbortError") return;
          if (controller.signal.aborted) return;
          setResults([]);
          setStatus("error");
        });
    };
    timer = window.setTimeout(startSearch, searchNow > 0 ? 0 : SEARCH_DEBOUNCE_MS);

    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, searchEnabled, searchNow, hasLocationFix]);

  function handleFocus() {
    setFocused(true);
    if (variant === "start") requestLocation("search");
  }

  function handleBlur(event: React.FocusEvent<HTMLDivElement>) {
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setFocused(false);
    if (variant === "start") releaseLocation("search");
  }

  function handleChange(e: React.ChangeEvent<HTMLInputElement>) {
    const text = e.target.value;
    setQuery(text);
    setSearchEnabled(text.trim().length >= MIN_CHARS);

    // If the box is emptied, forget the chosen place (this removes the route)
    if (text.trim() === "") {
      setResults([]);
      setStatus("idle");
      onClear();
    } else if (text.trim().length < MIN_CHARS) {
      setResults([]);
      setStatus("idle");
    }
  }

  // Runs when the user presses Enter inside the form
  function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault(); // stops the browser from reloading the page
    if (query.trim().length < MIN_CHARS) return;
    setSearchEnabled(true);
    setSearchNow((value) => value + 1);
  }

  function handlePick(result: SearchResult) {
    setQuery(result.name); // show the chosen place in the input
    setResults([]); // hide the list
    setStatus("idle");
    setSearchEnabled(false);
    setFocused(false);
    if (variant === "start") releaseLocation("search");
    onSelect(result);
  }

  function handleUseMyLocation() {
    const fix = getLocationState().fix;
    if (variant !== "start" || !fix) return;
    const latSpan = 0.002;
    const lonSpan = Math.min(180, latSpan / Math.max(0.1, Math.cos((fix.lat * Math.PI) / 180)));
    handlePick({
      id: -1,
      name: "My location",
      lat: fix.lat,
      lon: fix.lon,
      bounds: [
        Math.max(-180, fix.lon - lonSpan),
        Math.max(-90, fix.lat - latSpan),
        Math.min(180, fix.lon + lonSpan),
        Math.min(90, fix.lat + latSpan),
      ],
    });
  }

  const isEnd = variant === "end";

  return (
    <div className="search-box" onFocusCapture={handleFocus} onBlurCapture={handleBlur}>
      <form onSubmit={handleSubmit}>
        <div className="search-field">
          <span className={isEnd ? "search-badge is-end" : "search-badge"}>
            {isEnd ? "B" : "A"}
          </span>
          <input
            type="text"
            value={query}
            onChange={handleChange}
            placeholder={placeholder}
            aria-label={placeholder}
          />
          {query.trim().length >= MIN_CHARS && <span className="search-hint">ENTER</span>}
        </div>
      </form>

      {variant === "start" && focused && (
        <div className="search-location-option">
          <button
            type="button"
            disabled={!location.fix}
            onPointerDown={(event) => event.preventDefault()}
            onClick={handleUseMyLocation}
          >
            <span className="search-location-copy">
              <strong>Use my location</strong>
              <span>
                {location.fix
                  ? `GPS accuracy about ${Math.round(location.fix.accuracyM)} m`
                  : location.status === "denied"
                    ? "Allow location access in your browser"
                    : "Finding your location…"}
              </span>
            </span>
            <span className="search-location-arrow" aria-hidden="true">A</span>
          </button>
        </div>
      )}

      {status === "loading" && (
        <div className="search-message is-loading">Searching…</div>
      )}

      {status === "error" && (
        <div className="search-message is-error">
          Couldn't search right now. Check your connection and try again.
        </div>
      )}

      {status === "done" && results.length === 0 && (
        <div className="search-message">No results found.</div>
      )}

      {status === "done" && results.length > 0 && (
        <ul className="search-results">
          {results.map((result) => {
            // "Buckingham Palace, The Mall, London, ..." -> title + the rest
            const [title, ...rest] = result.name.split(", ");
            const detail = rest.join(", ");
            return (
              <li key={result.id}>
                <button type="button" onClick={() => handlePick(result)}>
                  <span className="result-title">{title}</span>
                  {detail && <span className="result-detail">{detail}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

function normalizeSearchText(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();
}