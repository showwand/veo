-- Veode: persistent friend-party invitations and membership
-- Party access is exposed through security-definer RPCs; clients cannot read or
-- modify the underlying tables directly.

CREATE TABLE IF NOT EXISTS public.parties (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id uuid NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS public.party_members (
  party_id uuid NOT NULL REFERENCES public.parties(id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  status text NOT NULL CHECK (status IN ('pending', 'accepted')),
  invited_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (party_id, user_id)
);

ALTER TABLE public.parties ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.party_members ENABLE ROW LEVEL SECURITY;

REVOKE ALL ON TABLE public.parties FROM anon, authenticated;
REVOKE ALL ON TABLE public.party_members FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.invite_friend_to_party(p_friend_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_user_id uuid := auth.uid();
  current_party_id uuid;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;

  IF p_friend_id IS NULL OR p_friend_id = current_user_id THEN
    RAISE EXCEPTION 'invalid_friend';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.my_friends() f WHERE f.id = p_friend_id
  ) THEN
    RAISE EXCEPTION 'not_friends' USING ERRCODE = '42501';
  END IF;

  INSERT INTO public.parties (owner_id)
  VALUES (current_user_id)
  ON CONFLICT (owner_id) DO NOTHING;

  SELECT p.id INTO current_party_id
  FROM public.parties p
  WHERE p.owner_id = current_user_id;

  INSERT INTO public.party_members (party_id, user_id, status)
  VALUES (current_party_id, p_friend_id, 'pending')
  ON CONFLICT (party_id, user_id) DO UPDATE
    SET status = 'pending', invited_at = now()
    WHERE public.party_members.status <> 'accepted';

  RETURN current_party_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.my_party()
RETURNS TABLE (
  party_id uuid,
  owner_id uuid,
  owner_username text,
  owner_avatar_id text,
  member_id uuid,
  member_username text,
  member_avatar_id text,
  status text,
  direction text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT
    p.id,
    p.owner_id,
    owner_profile.username::text,
    owner_profile.avatar_id::text,
    m.user_id,
    member_profile.username::text,
    member_profile.avatar_id::text,
    m.status::text,
    CASE WHEN p.owner_id = auth.uid() THEN 'outgoing' ELSE 'member' END::text
  FROM public.parties p
  JOIN public.party_members m ON m.party_id = p.id
  JOIN public.profiles owner_profile ON owner_profile.id = p.owner_id
  JOIN public.profiles member_profile ON member_profile.id = m.user_id
  WHERE p.owner_id = auth.uid()
     OR (m.user_id = auth.uid() AND m.status = 'accepted')

  UNION ALL

  SELECT
    p.id,
    p.owner_id,
    owner_profile.username::text,
    owner_profile.avatar_id::text,
    m.user_id,
    member_profile.username::text,
    member_profile.avatar_id::text,
    m.status::text,
    'incoming'::text
  FROM public.party_members m
  JOIN public.parties p ON p.id = m.party_id
  JOIN public.profiles owner_profile ON owner_profile.id = p.owner_id
  JOIN public.profiles member_profile ON member_profile.id = m.user_id
  WHERE m.user_id = auth.uid()
    AND m.status = 'pending';
$function$;

CREATE OR REPLACE FUNCTION public.respond_to_party_invite(
  p_party_id uuid,
  p_accept boolean
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

  IF p_accept THEN
    UPDATE public.party_members m
    SET status = 'accepted'
    FROM public.parties p
    WHERE m.party_id = p_party_id
      AND m.user_id = auth.uid()
      AND m.status = 'pending'
      AND p.id = m.party_id
      AND p.owner_id <> auth.uid();
  ELSE
    DELETE FROM public.party_members m
    USING public.parties p
    WHERE m.party_id = p_party_id
      AND m.user_id = auth.uid()
      AND m.status = 'pending'
      AND p.id = m.party_id
      AND p.owner_id <> auth.uid();
  END IF;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'party_invite_not_found';
  END IF;
END;
$function$;

CREATE OR REPLACE FUNCTION public.leave_party(p_party_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
BEGIN
  IF auth.uid() IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;

  DELETE FROM public.parties p
  WHERE p.id = p_party_id
    AND p.owner_id = auth.uid();

  IF FOUND THEN
    RETURN;
  END IF;

  DELETE FROM public.party_members m
  USING public.parties p
  WHERE m.party_id = p_party_id
    AND m.user_id = auth.uid()
    AND m.status = 'accepted'
    AND p.id = m.party_id
    AND p.owner_id <> auth.uid();

  IF NOT FOUND THEN
    RAISE EXCEPTION 'party_membership_not_found';
  END IF;
END;
$function$;

REVOKE ALL ON FUNCTION public.invite_friend_to_party(uuid) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.my_party() FROM PUBLIC;
REVOKE ALL ON FUNCTION public.respond_to_party_invite(uuid, boolean) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.leave_party(uuid) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.invite_friend_to_party(uuid) TO authenticated;
GRANT EXECUTE ON FUNCTION public.my_party() TO authenticated;
GRANT EXECUTE ON FUNCTION public.respond_to_party_invite(uuid, boolean) TO authenticated;
GRANT EXECUTE ON FUNCTION public.leave_party(uuid) TO authenticated;
