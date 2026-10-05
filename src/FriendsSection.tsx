import { useEffect, useState } from "react";
import Avatar from "./Avatar";
import { normaliseUsername, validateUsername } from "./accountRules";
import {
  findProfile,
  listFriends,
  listRequests,
  removeFriend,
  respondToRequest,
  sendFriendRequest,
  type Friend,
  type FriendRequest,
  type FoundProfile,
} from "./friendsApi";

type Props = { active: boolean }; // active = the account panel is open

type Loaded = { friends: Friend[]; requests: FriendRequest[]; error: string | null };

type SearchState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "none" }
  | { status: "found"; profile: FoundProfile }
  | { status: "error"; message: string };

// Remounted (via `key`) for each account, so one account's friends can never show for another.
export default function FriendsSection({ active }: Props) {
  const [reload, setReload] = useState(0);
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const [search, setSearch] = useState<SearchState>({ status: "idle" });
  const [working, setWorking] = useState<string | null>(null); // id of the row being changed
  const [confirmRemove, setConfirmRemove] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Load when the panel opens, and again after any change
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    void Promise.all([listFriends(), listRequests()]).then(([friends, requests]) => {
      if (cancelled) return;
      setLoaded({
        friends: friends.ok ? friends.data : [],
        requests: requests.ok ? requests.data : [],
        error: !friends.ok ? friends.message : !requests.ok ? requests.message : null,
      });
    });
    return () => {
      cancelled = true;
    };
  }, [active, reload]);

  const incoming = loaded?.requests.filter((r) => r.direction === "incoming") ?? [];
  const outgoing = loaded?.requests.filter((r) => r.direction === "outgoing") ?? [];
  const friends = loaded?.friends ?? [];

  async function handleSearch(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setMessage(null);
    const name = normaliseUsername(query);
    const invalid = validateUsername(name);
    if (invalid) {
      setSearch({ status: "error", message: invalid });
      return;
    }
    setSearch({ status: "loading" });
    const result = await findProfile(name);
    if (!result.ok) setSearch({ status: "error", message: result.message });
    else if (result.data === null) setSearch({ status: "none" });
    else setSearch({ status: "found", profile: result.data });
  }

  async function handleSend(profile: FoundProfile) {
    setWorking(profile.id);
    setMessage(null);
    const result = await sendFriendRequest(profile.username);
    setWorking(null);
    if (!result.ok) {
      setMessage(result.message);
      return;
    }
    setSearch({
      status: "found",
      profile: { ...profile, relation: result.data === "accepted" ? "friends" : "outgoing" },
    });
    setReload((n) => n + 1);
  }

  async function handleRespond(request: FriendRequest, accept: boolean) {
    setWorking(request.requestId);
    setMessage(null);
    const result = await respondToRequest(request.requestId, accept);
    setWorking(null);
    if (!result.ok) setMessage(result.message);
    setReload((n) => n + 1);
  }

  async function handleRemove(friend: Friend) {
    if (confirmRemove !== friend.id) {
      setConfirmRemove(friend.id);
      return;
    }
    setWorking(friend.id);
    setMessage(null);
    const result = await removeFriend(friend.id);
    setWorking(null);
    setConfirmRemove(null);
    if (!result.ok) setMessage(result.message);
    setReload((n) => n + 1);
  }

  function relationControl(profile: FoundProfile) {
    switch (profile.relation) {
      case "none":
        return (
          <button type="button" className="acct-small is-primary" disabled={working !== null} onClick={() => void handleSend(profile)}>
            {working === profile.id ? "Sending…" : "Add friend"}
          </button>
        );
      case "incoming":
        return (
          <button type="button" className="acct-small is-primary" disabled={working !== null} onClick={() => void handleSend(profile)}>
            Accept request
          </button>
        );
      case "outgoing":
        return <span className="fr-tag">Request sent</span>;
      case "friends":
        return <span className="fr-tag">Already friends</span>;
      case "self":
        return <span className="fr-tag">That's you</span>;
    }
  }

  return (
    <section className="acct-section">
      <div className="acct-heading-row">
        <h3 className="acct-heading">Friends</h3>
        <button type="button" className="acct-link" onClick={() => setAdding((open) => !open)}>
          {adding ? "Close" : "+ Add friend"}
        </button>
      </div>

      {adding && (
        <div className="fr-add">
          <form className="fr-search" onSubmit={(event) => void handleSearch(event)}>
            <input
              className="acct-input"
              type="text"
              placeholder="Search username…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-label="Search for a friend by username"
            />
            <button type="submit" className="acct-small" disabled={search.status === "loading"}>
              Search
            </button>
          </form>
          {search.status === "loading" && <div className="acct-hint">Searching…</div>}
          {search.status === "none" && <div className="acct-hint">No user with that username.</div>}
          {search.status === "error" && <div className="acct-error">{search.message}</div>}
          {search.status === "found" && (
            <div className="fr-row">
              <Avatar id={search.profile.avatarId} size={36} />
              <span className="fr-name">{search.profile.username}</span>
              {relationControl(search.profile)}
            </div>
          )}
        </div>
      )}

      {incoming.length > 0 && (
        <>
          <div className="acct-sub">Requests</div>
          <ul className="fr-list">
            {incoming.map((request) => (
              <li key={request.requestId} className="fr-row">
                <Avatar id={request.avatarId} size={36} />
                <span className="fr-name">{request.username}</span>
                <button type="button" className="acct-small is-primary" disabled={working !== null} onClick={() => void handleRespond(request, true)}>
                  Accept
                </button>
                <button type="button" className="acct-small" disabled={working !== null} onClick={() => void handleRespond(request, false)}>
                  Decline
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      {loaded === null ? (
        <div className="acct-hint">Loading friends…</div>
      ) : friends.length === 0 ? (
        <div className="acct-empty">No friends yet.</div>
      ) : (
        <ul className="fr-list">
          {friends.map((friend) => (
            <li key={friend.id} className="fr-row">
              <Avatar id={friend.avatarId} size={36} />
              <span className="fr-name">{friend.username}</span>
              <button
                type="button"
                className={confirmRemove === friend.id ? "acct-small is-danger" : "acct-small"}
                disabled={working !== null}
                onClick={() => void handleRemove(friend)}
                onBlur={() => setConfirmRemove(null)}
              >
                {confirmRemove === friend.id ? "Confirm" : "Remove"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {outgoing.length > 0 && (
        <>
          <div className="acct-sub">Sent requests</div>
          <ul className="fr-list">
            {outgoing.map((request) => (
              <li key={request.requestId} className="fr-row">
                <Avatar id={request.avatarId} size={36} />
                <span className="fr-name">{request.username}</span>
                <span className="fr-tag">Pending</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {loaded?.error && <div className="acct-error">{loaded.error}</div>}
      {message && <div className="acct-error">{message}</div>}
    </section>
  );
}