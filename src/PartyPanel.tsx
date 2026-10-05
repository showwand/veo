import { useEffect, useState } from "react";
import { avatarSrc } from "./avatars";
import { listFriends, type Friend } from "./friendsApi";
import { useAccountState } from "./accountStore";
import {
  inviteFriendToParty,
  leaveParty,
  listMyParty,
  respondToPartyInvite,
  type PartyEntry,
} from "./partyApi";

type Props = {
  open: boolean;
  onClose: () => void;
};

export default function PartyPanel({ open, onClose }: Props) {
  const account = useAccountState();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [partyEntries, setPartyEntries] = useState<PartyEntry[]>([]);
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);

  // Pressing Escape closes the panel
  useEffect(() => {
    if (!open) return;
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [open, onClose]);

  useEffect(() => {
    const userId = account.activeId;
    if (!open || !userId) return;

    let cancelled = false;
    queueMicrotask(() => {
      if (cancelled) return;
      setLoading(true);
      setError(null);
      void Promise.all([listFriends(), listMyParty()]).then(([friendsResult, partyResult]) => {
        if (cancelled) return;
        if (friendsResult.ok) setFriends(friendsResult.data);
        else setError(friendsResult.message);
        if (partyResult.ok) setPartyEntries(partyResult.data);
        else setError((current) => current ?? partyResult.message);
        setLoadedForId(userId);
        setLoading(false);
      });
    });

    return () => {
      cancelled = true;
    };
  }, [open, account.activeId, reload]);

  async function handleInvite(friend: Friend) {
    setBusyId(friend.id);
    setError(null);
    setNotice(null);
    const result = await inviteFriendToParty(friend.id);
    if (result.ok) {
      setNotice(`Invitation sent to ${friend.username}.`);
      setReload((value) => value + 1);
    } else {
      setError(result.message);
    }
    setBusyId(null);
  }

  async function handleInviteResponse(entry: PartyEntry, accept: boolean) {
    setBusyId(entry.partyId);
    setError(null);
    setNotice(null);
    const result = await respondToPartyInvite(entry.partyId, accept);
    if (result.ok) {
      setNotice(accept ? `You joined ${entry.ownerUsername}'s party.` : "Party invitation declined.");
      setReload((value) => value + 1);
    } else {
      setError(result.message);
    }
    setBusyId(null);
  }

  async function handleLeaveParty(partyId: string, ownParty: boolean, ownerUsername: string) {
    if (
      ownParty &&
      !window.confirm("End your party? This removes all members and pending invitations.")
    ) {
      return;
    }
    setBusyId(partyId);
    setError(null);
    setNotice(null);
    const result = await leaveParty(partyId);
    if (result.ok) {
      setNotice(ownParty ? "Your party has ended." : `You left ${ownerUsername}'s party.`);
      setReload((value) => value + 1);
    } else {
      setError(result.message);
    }
    setBusyId(null);
  }

  const hasCurrentAccountData = account.activeId !== null && loadedForId === account.activeId;
  const visibleEntries = hasCurrentAccountData ? partyEntries : [];
  const visibleFriends = hasCurrentAccountData ? friends : [];
  const incomingInvites = visibleEntries.filter(
    (entry) => entry.direction === "incoming" && entry.status === "pending"
  );
  const parties = new Map<string, PartyEntry[]>();
  for (const entry of visibleEntries) {
    if (entry.direction === "incoming") continue;
    const members = parties.get(entry.partyId) ?? [];
    members.push(entry);
    parties.set(entry.partyId, members);
  }

  return (
    <aside
      id="party-panel"
      className={open ? "party-panel is-open" : "party-panel"}
      aria-label="Party"
      aria-hidden={!open}
    >
      <header className="pp-header">
        <span className="pp-title">Party members</span>
        <button
          type="button"
          className="pp-close"
          aria-label="Close party panel"
          onClick={onClose}
        >
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">
            <path
              d="M3 3 L13 13 M13 3 L3 13"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="square"
              fill="none"
            />
          </svg>
        </button>
      </header>

      <div className={account.activeId ? "pp-body" : "pp-body is-signed-out"}>
        {account.activeId && loading && <div className="pp-state">Loading friends and party…</div>}
        {!account.activeId && <div className="pp-state">Sign in to use parties.</div>}
        {account.activeId && error && <div className="pp-state is-error" role="alert">{error}</div>}
        {account.activeId && notice && <div className="pp-state is-notice" role="status">{notice}</div>}

        {incomingInvites.length > 0 && (
          <section className="pp-section">
            <div className="pp-section-title">Invitations</div>
            <ul className="pp-party-list">
              {incomingInvites.map((entry) => (
                <li className="pp-party-row" key={`invite-${entry.partyId}`}>
                  <img src={avatarSrc(entry.ownerAvatarId)} alt="" />
                  <div className="pp-person-copy">
                    <strong>{entry.ownerUsername}</strong>
                    <span>invited you to their party</span>
                  </div>
                  <div className="pp-row-actions">
                    <button
                      type="button"
                      className="pp-request"
                      disabled={busyId === entry.partyId}
                      onClick={() => void handleInviteResponse(entry, true)}
                    >
                      Accept
                    </button>
                    <button
                      type="button"
                      className="pp-request is-quiet"
                      disabled={busyId === entry.partyId}
                      onClick={() => void handleInviteResponse(entry, false)}
                    >
                      Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

        {account.activeId && (
          <section className="pp-section pp-rosters">
            <div className="pp-section-title">Party members</div>
            {!hasCurrentAccountData ? (
              <div className="pp-state">Loading party roster…</div>
            ) : parties.size === 0 ? (
              <div className="pp-empty">
                <span className="pp-empty-title">No party yet</span>
                <span className="pp-empty-text">Invite a friend to start one</span>
              </div>
            ) : (
              <div className="pp-party-groups">
                {[...parties.entries()].map(([partyId, members]) => {
                  const owner = members[0];
                  const ownParty = owner.ownerId === account.activeId;
                  return (
                    <section className="pp-party-group" key={partyId}>
                      <div className="pp-party-heading">
                        <h3>{ownParty ? "Your party" : `${owner.ownerUsername}'s party`}</h3>
                        <button
                          type="button"
                          className="pp-request pp-leave"
                          disabled={busyId === partyId}
                          onClick={() => void handleLeaveParty(partyId, ownParty, owner.ownerUsername)}
                        >
                          {busyId === partyId ? "Working…" : ownParty ? "End party" : "Leave party"}
                        </button>
                      </div>
                      <ul className="pp-party-list">
                        {members.map((entry) => (
                          <li className="pp-party-row" key={`${partyId}-${entry.memberId}`}>
                            <img src={avatarSrc(entry.memberAvatarId)} alt="" />
                            <div className="pp-person-copy">
                              <strong>{entry.memberId === account.activeId ? "You" : entry.memberUsername}</strong>
                              <span>{entry.status === "accepted" ? "In party" : "Invitation pending"}</span>
                            </div>
                          </li>
                        ))}
                      </ul>
                    </section>
                  );
                })}
              </div>
            )}
            {hasCurrentAccountData && (
              <p className="pp-map-note">Party members appear on the map while their location sharing is on.</p>
            )}
          </section>
        )}
      </div>

      <section className="pp-friends">
        <div className="pp-friends-title">Friends</div>
        <ul className="pp-friend-list">
          {visibleFriends.map((friend) => {
            const existing = visibleEntries.find(
              (entry) => entry.ownerId === account.activeId && entry.memberId === friend.id
            );
            const buttonLabel = existing?.status === "accepted"
              ? "In party"
              : existing?.status === "pending"
                ? "Invited"
                : "Invite";
            return (
            <li key={friend.id} className="pp-friend">
              <img src={avatarSrc(friend.avatarId)} alt="" />
              <span className="pp-friend-name">{friend.username}</span>
              <button
                type="button"
                className="pp-request"
                disabled={!account.activeId || Boolean(existing) || busyId === friend.id}
                onClick={() => void handleInvite(friend)}
              >
                {busyId === friend.id ? "Sending…" : buttonLabel}
              </button>
            </li>
            );
          })}
          {hasCurrentAccountData && !loading && visibleFriends.length === 0 && (
            <li className="pp-friend-empty">Your accepted friends will appear here.</li>
          )}
          {!account.activeId && <li className="pp-friend-empty">Sign in to see your friends.</li>}
        </ul>
      </section>
    </aside>
  );
}