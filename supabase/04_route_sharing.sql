-- Veode: routes attached to the existing friend-party system, with optional
-- authenticated link joining and explicitly opted-in member progress.

ALTER TABLE public.parties
  ADD COLUMN IF NOT EXISTS shared_route jsonb,
  ADD COLUMN IF NOT EXISTS route_share_code uuid,
  ADD COLUMN IF NOT EXISTS route_shared_at timestamptz;

CREATE UNIQUE INDEX IF NOT EXISTS parties_route_share_code_idx
  ON public.parties (route_share_code)
  WHERE route_share_code IS NOT NULL;

CREATE TABLE IF NOT EXISTS public.party_route_progress (
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  progress_m double precision NOT NULL CHECK (progress_m >= 0),
  remaining_seconds integer NOT NULL CHECK (remaining_seconds >= 0),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, user_id)
);

CREATE INDEX IF NOT EXISTS party_route_progress_updated_idx
  ON public.party_route_progress (party_id, updated_at DESC);

ALTER TABLE public.party_route_progress ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.party_route_progress FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.share_party_route(p_route jsonb)
RETURNS TABLE (party_id uuid, share_code uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_user_id uuid := auth.uid();
  current_party_id uuid;
  current_code uuid;
  route_coordinates jsonb;
  route_duration numeric;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  IF p_route IS NULL
     OR pg_catalog.octet_length(p_route::text) > 1000000
     OR COALESCE(p_route->>'mode', '') NOT IN ('car', 'walking')
     OR p_route->'geometry'->>'type' IS DISTINCT FROM 'LineString' THEN
    RAISE EXCEPTION 'invalid_shared_route';
  END IF;
  route_coordinates := p_route->'geometry'->'coordinates';
  route_duration := (p_route->>'durationSeconds')::numeric;
  IF route_coordinates IS NULL
     OR pg_catalog.jsonb_typeof(route_coordinates) <> 'array'
     OR pg_catalog.jsonb_array_length(route_coordinates) < 2
     OR pg_catalog.jsonb_array_length(route_coordinates) > 5000
     OR route_duration IS NULL
     OR route_duration <= 0
     OR EXISTS (
       SELECT 1
       FROM pg_catalog.jsonb_array_elements(route_coordinates) AS coordinates(coordinate)
       WHERE CASE
         WHEN pg_catalog.jsonb_typeof(coordinate) <> 'array' THEN true
         WHEN pg_catalog.jsonb_array_length(coordinate) <> 2 THEN true
         WHEN pg_catalog.jsonb_typeof(coordinate->0) <> 'number' THEN true
         WHEN pg_catalog.jsonb_typeof(coordinate->1) <> 'number' THEN true
         ELSE (coordinate->>0)::numeric NOT BETWEEN -180 AND 180
           OR (coordinate->>1)::numeric NOT BETWEEN -90 AND 90
       END
     ) THEN
    RAISE EXCEPTION 'invalid_shared_route';
  END IF;

  INSERT INTO public.parties (owner_id)
  VALUES (current_user_id)
  ON CONFLICT (owner_id) DO NOTHING;

  SELECT p.id INTO current_party_id
  FROM public.parties p
  WHERE p.owner_id = current_user_id;

  current_code := pg_catalog.gen_random_uuid();
  UPDATE public.parties p
  SET shared_route = p_route,
      route_share_code = current_code,
      route_shared_at = pg_catalog.now()
  WHERE p.id = current_party_id
    AND p.owner_id = current_user_id;

  RETURN QUERY SELECT current_party_id, current_code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_party_route(p_party_id uuid)
RETURNS TABLE (party_id uuid, owner_id uuid, route_data jsonb, share_code uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_user_id uuid := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.id, p.owner_id, p.shared_route, p.route_share_code
  FROM public.parties p
  WHERE p.id = p_party_id
    AND p.shared_route IS NOT NULL
    AND (
      p.owner_id = current_user_id
      OR EXISTS (
        SELECT 1 FROM public.party_members m
        WHERE m.party_id = p.id
          AND m.user_id = current_user_id
          AND m.status IN ('pending', 'accepted')
      )
    );
END;
$function$;

CREATE OR REPLACE FUNCTION public.join_shared_route(p_share_code uuid)
RETURNS TABLE (party_id uuid, owner_id uuid, route_data jsonb, share_code uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_user_id uuid := auth.uid();
  target_party_id uuid;
  target_owner_id uuid;
  target_route jsonb;
  target_code uuid;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;

  SELECT p.id, p.owner_id, p.shared_route, p.route_share_code
  INTO target_party_id, target_owner_id, target_route, target_code
  FROM public.parties p
  WHERE p.route_share_code = p_share_code
    AND p.shared_route IS NOT NULL;
  IF target_party_id IS NULL THEN
    RAISE EXCEPTION 'route_link_not_found';
  END IF;
  IF target_owner_id = current_user_id THEN
    RETURN QUERY SELECT target_party_id, target_owner_id, target_route, target_code;
    RETURN;
  END IF;

  INSERT INTO public.party_members (party_id, user_id, status)
  VALUES (target_party_id, current_user_id, 'accepted')
  ON CONFLICT (party_id, user_id) DO UPDATE
    SET status = 'accepted';

  RETURN QUERY SELECT target_party_id, target_owner_id, target_route, target_code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.report_party_route_progress(
  p_party_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_progress_m double precision,
  p_remaining_seconds integer
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_user_id uuid := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  IF p_latitude IS NULL OR p_latitude NOT BETWEEN -90 AND 90
     OR p_longitude IS NULL OR p_longitude NOT BETWEEN -180 AND 180
     OR p_progress_m IS NULL OR p_progress_m < 0
     OR p_remaining_seconds IS NULL OR p_remaining_seconds < 0 THEN
    RAISE EXCEPTION 'invalid_route_progress';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.parties p
    WHERE p.id = p_party_id
      AND p.shared_route IS NOT NULL
      AND (
        p.owner_id = current_user_id
        OR EXISTS (
          SELECT 1 FROM public.party_members m
          WHERE m.party_id = p.id AND m.user_id = current_user_id AND m.status = 'accepted'
        )
      )
  ) THEN
    RAISE EXCEPTION 'not_in_route_party' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.profiles p
    WHERE p.id = current_user_id AND p.share_location = true
  ) THEN
    RAISE EXCEPTION 'location_sharing_disabled' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.party_route_progress (
    party_id, user_id, latitude, longitude, progress_m, remaining_seconds, updated_at
  )
  VALUES (
    p_party_id, current_user_id, p_latitude, p_longitude, p_progress_m,
    p_remaining_seconds, pg_catalog.now()
  )
  ON CONFLICT (party_id, user_id) DO UPDATE
    SET latitude = EXCLUDED.latitude,
        longitude = EXCLUDED.longitude,
        progress_m = EXCLUDED.progress_m,
        remaining_seconds = EXCLUDED.remaining_seconds,
        updated_at = EXCLUDED.updated_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_party_route_race(p_party_id uuid)
RETURNS TABLE (
  user_id uuid,
  username text,
  avatar_id text,
  latitude double precision,
  longitude double precision,
  progress_m double precision,
  remaining_seconds integer,
  updated_at timestamptz,
  location_shared boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_user_id uuid := auth.uid();
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1
    FROM public.parties p
    WHERE p.id = p_party_id
      AND p.shared_route IS NOT NULL
      AND (
        p.owner_id = current_user_id
        OR EXISTS (
          SELECT 1 FROM public.party_members m
          WHERE m.party_id = p.id AND m.user_id = current_user_id AND m.status = 'accepted'
        )
      )
  ) THEN
    RAISE EXCEPTION 'not_in_route_party' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT
    member.user_id,
    profile.username::text,
    profile.avatar_id::text,
    CASE WHEN profile.share_location AND progress.updated_at > pg_catalog.now() - interval '3 minutes'
      THEN progress.latitude ELSE NULL END,
    CASE WHEN profile.share_location AND progress.updated_at > pg_catalog.now() - interval '3 minutes'
      THEN progress.longitude ELSE NULL END,
    CASE WHEN profile.share_location AND progress.updated_at > pg_catalog.now() - interval '3 minutes'
      THEN progress.progress_m ELSE NULL END,
    CASE WHEN profile.share_location AND progress.updated_at > pg_catalog.now() - interval '3 minutes'
      THEN progress.remaining_seconds ELSE NULL END,
    CASE WHEN profile.share_location THEN progress.updated_at ELSE NULL END,
    profile.share_location
  FROM (
    SELECT p.owner_id AS user_id
    FROM public.parties p WHERE p.id = p_party_id
    UNION
    SELECT m.user_id FROM public.party_members m
    WHERE m.party_id = p_party_id AND m.status = 'accepted'
  ) member
  JOIN public.profiles profile ON profile.id = member.user_id
  LEFT JOIN public.party_route_progress progress
    ON progress.party_id = p_party_id AND progress.user_id = member.user_id
  ORDER BY
    (CASE WHEN profile.share_location THEN progress.progress_m ELSE NULL END) DESC NULLS LAST,
    profile.username;
END;
$function$;

CREATE OR REPLACE FUNCTION public.clear_party_shared_route(p_party_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  UPDATE public.parties p
  SET shared_route = NULL, route_share_code = NULL, route_shared_at = NULL
  WHERE p.id = p_party_id AND p.owner_id = auth.uid();
  IF NOT FOUND THEN
    RAISE EXCEPTION 'route_party_not_found' USING ERRCODE = '42501';
  END IF;
  DELETE FROM public.party_route_progress progress
  WHERE progress.party_id = p_party_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.share_party_route(jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_party_route(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.join_shared_route(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.report_party_route_progress(uuid, double precision, double precision, double precision, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_party_route_race(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.clear_party_shared_route(uuid) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.share_party_route(jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_party_route(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.join_shared_route(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.report_party_route_progress(uuid, double precision, double precision, double precision, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_party_route_race(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.clear_party_shared_route(uuid) TO authenticated;
