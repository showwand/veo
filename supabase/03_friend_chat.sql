-- Veode: private one-to-one messaging between accepted friends.
-- Clients access messages only through the security-definer RPCs below.

CREATE TABLE IF NOT EXISTS public.friend_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sender_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  recipient_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  body text NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at timestamptz NOT NULL DEFAULT now(),
  CHECK (sender_id <> recipient_id)
);

CREATE INDEX IF NOT EXISTS friend_messages_conversation_idx
  ON public.friend_messages (sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS friend_messages_recipient_idx
  ON public.friend_messages (recipient_id, sender_id, created_at DESC);

ALTER TABLE public.friend_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.friend_messages FROM anon, authenticated;

CREATE OR REPLACE FUNCTION public.list_friend_messages(
  p_friend_id uuid,
  p_limit integer DEFAULT 100
)
RETURNS TABLE (
  id uuid,
  sender_id uuid,
  recipient_id uuid,
  body text,
  created_at timestamptz
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
  IF p_friend_id IS NULL OR p_friend_id = current_user_id
     OR NOT EXISTS (
       SELECT 1 FROM public.my_friends() f WHERE f.id = p_friend_id
     ) THEN
    RAISE EXCEPTION 'not_friends' USING ERRCODE = '42501';
  END IF;

  RETURN QUERY
  SELECT recent.id, recent.sender_id, recent.recipient_id, recent.body, recent.created_at
  FROM (
    SELECT m.id, m.sender_id, m.recipient_id, m.body, m.created_at
    FROM public.friend_messages m
    WHERE (m.sender_id = current_user_id AND m.recipient_id = p_friend_id)
       OR (m.sender_id = p_friend_id AND m.recipient_id = current_user_id)
    ORDER BY m.created_at DESC, m.id DESC
    LIMIT LEAST(GREATEST(COALESCE(p_limit, 100), 1), 100)
  ) recent
  ORDER BY recent.created_at ASC, recent.id ASC;
END;
$function$;

CREATE OR REPLACE FUNCTION public.send_friend_message(
  p_friend_id uuid,
  p_body text
)
RETURNS TABLE (
  id uuid,
  sender_id uuid,
  recipient_id uuid,
  body text,
  created_at timestamptz
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  current_user_id uuid := auth.uid();
  message_id uuid;
BEGIN
  IF current_user_id IS NULL THEN
    RAISE EXCEPTION 'not_signed_in' USING ERRCODE = '42501';
  END IF;
  IF p_friend_id IS NULL OR p_friend_id = current_user_id
     OR NOT EXISTS (
       SELECT 1 FROM public.my_friends() f WHERE f.id = p_friend_id
     ) THEN
    RAISE EXCEPTION 'not_friends' USING ERRCODE = '42501';
  END IF;
  IF p_body IS NULL OR char_length(btrim(p_body)) NOT BETWEEN 1 AND 2000 THEN
    RAISE EXCEPTION 'invalid_message';
  END IF;

  INSERT INTO public.friend_messages (sender_id, recipient_id, body)
  VALUES (current_user_id, p_friend_id, btrim(p_body))
  RETURNING friend_messages.id INTO message_id;

  RETURN QUERY
  SELECT m.id, m.sender_id, m.recipient_id, m.body, m.created_at
  FROM public.friend_messages m
  WHERE m.id = message_id;
END;
$function$;

REVOKE ALL ON FUNCTION public.list_friend_messages(uuid, integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.send_friend_message(uuid, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION public.list_friend_messages(uuid, integer) TO authenticated;
GRANT EXECUTE ON FUNCTION public.send_friend_message(uuid, text) TO authenticated;
