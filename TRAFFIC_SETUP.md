# TomTom live traffic setup

Veode uses TomTom's traffic-aware Routing API for car-route estimates and traffic sections. It requests data only for the small set of candidate routes being evaluated, and draws congestion colors only over the selected route. It does not load a world-wide traffic-tile overlay.

1. Copy `.env.example` to `.env.local`.
2. Set `VITE_TOMTOM_API_KEY` in `.env.local` for local development.
3. Add `VITE_TOMTOM_API_KEY` to the Vercel project's Environment Variables for Preview and Production, then redeploy.
4. In the TomTom developer portal, enable access to the Routing API and allow the production website origin, such as `showwand.com` and `www.showwand.com`. You do not need to specify a port for the production domain. A key restricted to the production site will reject requests from local development at `localhost` or `127.0.0.1`; test the restricted key on the deployed website, or add a separate local origin only if TomTom's key settings support it. Vite variables are included in browser code and are not secret.

If TomTom routing is unavailable, the existing OSRM route options remain available, but are shown as estimates without live traffic. Navigation turn guidance continues to use OSRM.

During car-route search, TomTom evaluates the OSRM candidate roads with current traffic and Veode orders the available options by TomTom's reported traffic-aware travel time. The colored line reflects TomTom's traffic severity sections for the selected route. While navigating, Veode checks every two minutes for a traffic-aware alternative and offers it when the estimate is at least two minutes and 15% faster; it never switches routes without confirmation. Navigation progress timing continues to use OSRM step estimates.
