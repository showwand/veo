-- Veode: location-sharing schema
-- Review the existing friend table names before applying this to a live project.
-- The app already uses the project's existing friend RPCs; this adds the minimal
-- table and RLS needed for live location sharing without duplicating users.

ALTER TABLE public.profiles
  ADD COLUMN IF NOT EXISTS share_location boolean NOT NULL DEFAULT false;

GRANT UPDATE (share_location) ON TABLE public.profiles TO authenticated;

CREATE TABLE IF NOT EXISTS public.user_locations (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  latitude double precision NOT NULL CHECK (latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK (longitude BETWEEN -180 AND 180),
  accuracy double precision NOT NULL DEFAULT 0 CHECK (accuracy >= 0),
  heading double precision,
  speed double precision,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS user_locations_updated_at_idx
  ON public.user_locations (updated_at DESC);

ALTER TABLE public.user_locations ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "user_locations_select_own" ON public.user_locations;
DROP POLICY IF EXISTS "user_locations_insert_own" ON public.user_locations;
DROP POLICY IF EXISTS "user_locations_update_own" ON public.user_locations;
DROP POLICY IF EXISTS "user_locations_delete_own" ON public.user_locations;
DROP POLICY IF EXISTS "user_locations_select_friend_shared" ON public.user_locations;

CREATE POLICY "user_locations_select_own"
  ON public.user_locations
  FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "user_locations_insert_own"
  ON public.user_locations
  FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_locations_update_own"
  ON public.user_locations
  FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "user_locations_delete_own"
  ON public.user_locations
  FOR DELETE
  USING (auth.uid() = user_id);

-- Use the existing my_friends RPC as the accepted-friend source. This avoids
-- depending on the private column layout of the project's friendship tables.
CREATE POLICY "user_locations_select_friend_shared"
  ON public.user_locations
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM public.my_friends() f
      WHERE f.id = user_locations.user_id
    )
    AND EXISTS (
      SELECT 1
      FROM public.profiles p
      WHERE p.id = user_locations.user_id
        AND p.share_location = true
    )
  );

-- The my_friends RPC must remain scoped to auth.uid() and return accepted friends
-- only, as it does for the existing Friends UI.
