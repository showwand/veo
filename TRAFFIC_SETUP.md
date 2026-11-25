# TomTom live traffic setup

The map displays TomTom live traffic-flow tiles when a destination or shared route is active.

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_TOMTOM_API_KEY` in `.env.local` for local development.
3. Add `VITE_TOMTOM_API_KEY` to the Vercel project's Environment Variables for Preview and Production, then redeploy.
4. Restrict the browser key to your website's origins in the TomTom developer portal. Vite variables are included in browser code and are not secret.

Without a configured key, the map shows a setup hint instead of claiming traffic data is available.
