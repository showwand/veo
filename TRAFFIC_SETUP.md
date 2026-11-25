# TomTom live traffic setup

The map displays TomTom live traffic-flow tiles when a destination or shared route is active.

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_TOMTOM_API_KEY` in `.env.local` for local development.
3. Add `VITE_TOMTOM_API_KEY` to the Vercel project's Environment Variables for Preview and Production, then redeploy.
4. In the TomTom developer portal, allow every origin used by the app, including the local Vite origin (`http://localhost:5173` and, if used, `http://127.0.0.1:5173`) and your production website origin. A key restricted to the production site will reject local tile requests with `InvalidReferer`. Vite variables are included in browser code and are not secret.

Without a configured key, the map shows a setup hint instead of claiming traffic data is available.

The current route and navigation durations come from OSRM and are not traffic-adjusted. TomTom tiles show traffic conditions on the map only; they do not alter the route-time calculations.
