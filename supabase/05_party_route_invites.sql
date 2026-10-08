-- Separate party membership from consent to join a shared route.
CREATE TABLE IF NOT EXISTS public.party_route_invites (
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'accepted')),
  invited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, user_id)
);

ALTER TABLE public.party_route_invites ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.party_route_invites FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.remove_party_route_participation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  DELETE FROM public.party_route_invites invite
  WHERE invite.party_id = OLD.party_id AND invite.user_id = OLD.user_id;
  DELETE FROM public.party_route_progress progress
  WHERE progress.party_id = OLD.party_id AND progress.user_id = OLD.user_id;
  RETURN OLD;
END;
$function$;

DROP TRIGGER IF EXISTS party_member_route_participation_cleanup ON public.party_members;
CREATE TRIGGER party_member_route_participation_cleanup
AFTER DELETE ON public.party_members
FOR EACH ROW
EXECUTE FUNCTION public.remove_party_route_participation();

CREATE OR REPLACE FUNCTION public.my_shared_party_route()
RETURNS TABLE (party_id uuid, owner_id uuid, route_data jsonb, share_code uuid)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  RETURN QUERY
  SELECT p.id, p.owner_id, p.shared_route, p.route_share_code
  FROM public.parties p
  WHERE p.owner_id = auth.uid() AND p.shared_route IS NOT NULL;
END;
$function$;

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

  DELETE FROM public.party_route_progress progress WHERE progress.party_id = current_party_id;
  DELETE FROM public.party_route_invites invite WHERE invite.party_id = current_party_id;
  current_code := pg_catalog.gen_random_uuid();
  UPDATE public.parties p
  SET shared_route = p_route,
      route_share_code = current_code,
      route_shared_at = pg_catalog.now()
  WHERE p.id = current_party_id AND p.owner_id = current_user_id;

  RETURN QUERY SELECT current_party_id, current_code;
END;
$function$;

CREATE OR REPLACE FUNCTION public.invite_party_member_to_route(
  p_party_id uuid,
  p_member_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  IF p_member_id IS NULL OR p_member_id = auth.uid() THEN
    RAISE EXCEPTION 'invalid_route_invite';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.parties p
    JOIN public.party_members m ON m.party_id = p.id
    WHERE p.id = p_party_id
      AND p.owner_id = auth.uid()
      AND p.shared_route IS NOT NULL
      AND m.user_id = p_member_id
      AND m.status = 'accepted'
  ) THEN
    RAISE EXCEPTION 'party_member_not_available_for_route' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.party_route_invites (party_id, user_id, status, invited_at)
  VALUES (p_party_id, p_member_id, 'pending', pg_catalog.now())
  ON CONFLICT (party_id, user_id) DO UPDATE
    SET status = 'pending', invited_at = EXCLUDED.invited_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_party_route_invite_status(p_party_id uuid)
RETURNS TABLE (member_id uuid, route_status text)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.parties p
    WHERE p.id = p_party_id AND p.owner_id = auth.uid() AND p.shared_route IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'route_party_not_found' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT m.user_id, invite.status
  FROM public.party_members m
  LEFT JOIN public.party_route_invites invite
    ON invite.party_id = m.party_id AND invite.user_id = m.user_id
  WHERE m.party_id = p_party_id AND m.status = 'accepted';
END;
$function$;

CREATE OR REPLACE FUNCTION public.my_party_route_invites()
RETURNS TABLE (
  party_id uuid,
  owner_id uuid,
  owner_username text,
  owner_avatar_id text,
  route_data jsonb,
  share_code uuid
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT p.id, p.owner_id, profile.username::text, profile.avatar_id::text,
    p.shared_route, p.route_share_code
  FROM public.party_route_invites invite
  JOIN public.parties p ON p.id = invite.party_id
  JOIN public.profiles profile ON profile.id = p.owner_id
  JOIN public.party_members member
    ON member.party_id = p.id AND member.user_id = auth.uid() AND member.status = 'accepted'
  WHERE invite.user_id = auth.uid()
    AND invite.status = 'pending'
    AND p.shared_route IS NOT NULL;
END;
$function$;

CREATE OR REPLACE FUNCTION public.respond_to_party_route_invite(
  p_party_id uuid,
  p_accept boolean
)
RETURNS TABLE (party_id uuid, owner_id uuid, route_data jsonb, share_code uuid)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  IF p_accept IS NULL THEN
    RAISE EXCEPTION 'invalid_route_invite_response';
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM public.party_route_invites invite
    JOIN public.parties p ON p.id = invite.party_id
    JOIN public.party_members m
      ON m.party_id = p.id AND m.user_id = auth.uid() AND m.status = 'accepted'
    WHERE invite.party_id = p_party_id
      AND invite.user_id = auth.uid()
      AND invite.status = 'pending'
      AND p.shared_route IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'route_invite_not_found';
  END IF;

  IF p_accept THEN
    UPDATE public.party_route_invites invite
    SET status = 'accepted'
    WHERE invite.party_id = p_party_id
      AND invite.user_id = auth.uid()
      AND invite.status = 'pending';
    RETURN QUERY
    SELECT p.id, p.owner_id, p.shared_route, p.route_share_code
    FROM public.parties p
    WHERE p.id = p_party_id AND p.shared_route IS NOT NULL;
  ELSE
    DELETE FROM public.party_route_invites invite
    WHERE invite.party_id = p_party_id AND invite.user_id = auth.uid();
    DELETE FROM public.party_route_progress progress
    WHERE progress.party_id = p_party_id AND progress.user_id = auth.uid();
  END IF;
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
        SELECT 1 FROM public.party_route_invites invite
        JOIN public.party_members member
          ON member.party_id = invite.party_id AND member.user_id = invite.user_id
        WHERE invite.party_id = p.id AND invite.user_id = current_user_id
          AND invite.status IN ('pending', 'accepted') AND member.status = 'accepted'
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
  WHERE p.route_share_code = p_share_code AND p.shared_route IS NOT NULL;
  IF target_party_id IS NULL THEN
    RAISE EXCEPTION 'route_link_not_found';
  END IF;

  IF target_owner_id <> current_user_id THEN
    INSERT INTO public.party_members (party_id, user_id, status)
    VALUES (target_party_id, current_user_id, 'accepted')
    ON CONFLICT (party_id, user_id) DO UPDATE SET status = 'accepted';
    INSERT INTO public.party_route_invites (party_id, user_id, status, invited_at)
    VALUES (target_party_id, current_user_id, 'accepted', pg_catalog.now())
    ON CONFLICT (party_id, user_id) DO UPDATE SET status = 'accepted';
  END IF;

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
    SELECT 1 FROM public.parties p
    WHERE p.id = p_party_id AND p.shared_route IS NOT NULL
      AND (
        p.owner_id = current_user_id
        OR EXISTS (
          SELECT 1 FROM public.party_route_invites invite
          JOIN public.party_members member
            ON member.party_id = invite.party_id AND member.user_id = invite.user_id
          WHERE invite.party_id = p.id AND invite.user_id = current_user_id
            AND invite.status = 'accepted' AND member.status = 'accepted'
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
    SET latitude = EXCLUDED.latitude, longitude = EXCLUDED.longitude,
        progress_m = EXCLUDED.progress_m, remaining_seconds = EXCLUDED.remaining_seconds,
        updated_at = EXCLUDED.updated_at;
END;
$function$;

CREATE OR REPLACE FUNCTION public.get_party_route_race(p_party_id uuid)
RETURNS TABLE (
  user_id uuid, username text, avatar_id text,
  latitude double precision, longitude double precision,
  progress_m double precision, remaining_seconds integer,
  updated_at timestamptz, location_shared boolean
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
    SELECT 1 FROM public.parties p
    WHERE p.id = p_party_id AND p.shared_route IS NOT NULL
      AND (
        p.owner_id = current_user_id
        OR EXISTS (
          SELECT 1 FROM public.party_route_invites invite
          JOIN public.party_members member
            ON member.party_id = invite.party_id AND member.user_id = invite.user_id
          WHERE invite.party_id = p.id AND invite.user_id = current_user_id
            AND invite.status = 'accepted' AND member.status = 'accepted'
        )
      )
  ) THEN
    RAISE EXCEPTION 'not_in_route_party' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT member.user_id, profile.username::text, profile.avatar_id::text,
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
    SELECT p.owner_id AS user_id FROM public.parties p WHERE p.id = p_party_id
    UNION
    SELECT invite.user_id FROM public.party_route_invites invite
    JOIN public.party_members member
      ON member.party_id = invite.party_id AND member.user_id = invite.user_id
    WHERE invite.party_id = p_party_id AND invite.status = 'accepted'
      AND member.status = 'accepted'
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
  DELETE FROM public.party_route_progress progress WHERE progress.party_id = p_party_id;
  DELETE FROM public.party_route_invites invite WHERE invite.party_id = p_party_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.invite_party_member_to_route(uuid, uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.remove_party_route_participation() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_party_route_invite_status(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_shared_party_route() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_party_route_invites() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_to_party_route_invite(uuid, boolean) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invite_party_member_to_route(uuid, uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_party_route_invite_status(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_shared_party_route() TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_party_route_invites() TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_party_route_invite(uuid, boolean) TO authenticated;
