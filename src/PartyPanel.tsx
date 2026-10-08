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
import type { Route } from "./routing";
import {
  getPartyRouteInviteStatuses,
  getMySharedPartyRoute,
  invitePartyMemberToRoute,
  listMyPartyRouteInvites,
  respondToPartyRouteInvite,
  clearPartySharedRoute,
  sharePartyRoute,
  type PartyRouteInvite,
  type RouteInviteStatus,
  type SharedRoute,
} from "./routePartyApi";

type Props = {
  open: boolean;
  onClose: () => void;
  route: Route | null;
  onShareRoute: (shared: SharedRoute) => void;
  onStopSharing: () => void;
  onJoinRoute: (shared: SharedRoute) => void;
};

export default function PartyPanel({
  open,
  onClose,
  route,
  onShareRoute,
  onStopSharing,
  onJoinRoute,
}: Props) {
  const account = useAccountState();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [partyEntries, setPartyEntries] = useState<PartyEntry[]>([]);
  const [routeInvites, setRouteInvites] = useState<PartyRouteInvite[]>([]);
  const [routeInviteStatuses, setRouteInviteStatuses] = useState<
    Map<string, RouteInviteStatus>
  >(new Map());
  const [loadedForId, setLoadedForId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [sharedRoute, setSharedRoute] = useState<SharedRoute | null>(null);
  const [shareBusy, setShareBusy] = useState(false);
  const [shareError, setShareError] = useState<string | null>(null);
  const [copyNotice, setCopyNotice] = useState<string | null>(null);

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
      void Promise.all([
        listFriends(),
        listMyParty(),
        listMyPartyRouteInvites(),
        sharedRoute ? Promise.resolve(null) : getMySharedPartyRoute(),
        sharedRoute ? getPartyRouteInviteStatuses(sharedRoute.partyId) : Promise.resolve(null),
      ]).then(([friendsResult, partyResult, routeInvitesResult, savedRouteResult, statusesResult]) => {
        if (cancelled) return;
        if (friendsResult.ok) setFriends(friendsResult.data);
        else setError(friendsResult.message);
        if (partyResult.ok) setPartyEntries(partyResult.data);
        else setError((current) => current ?? partyResult.message);
        if (routeInvitesResult.ok) setRouteInvites(routeInvitesResult.data);
        else setError((current) => current ?? routeInvitesResult.message);
        if (savedRouteResult?.ok && savedRouteResult.data && !sharedRoute) {
          setSharedRoute(savedRouteResult.data);
          onShareRoute(savedRouteResult.data);
        } else if (savedRouteResult && !savedRouteResult.ok) {
          setError((current) => current ?? savedRouteResult.message);
        }
        if (statusesResult?.ok) setRouteInviteStatuses(statusesResult.data);
        else if (statusesResult && !statusesResult.ok) {
          setError((current) => current ?? statusesResult.message);
        } else {
          setRouteInviteStatuses(new Map());
        }
        setLoadedForId(userId);
        setLoading(false);
      });
    });

    return () => {
      cancelled = true;
    };
  }, [open, account.activeId, reload, sharedRoute, onShareRoute]);

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

  async function handleShareRoute() {
    if (!route || route.mode === "public-transport" || !account.activeId) return;
    setShareBusy(true);
    setShareError(null);
    setCopyNotice(null);
    const result = await sharePartyRoute(route, account.activeId);
    setShareBusy(false);
    if (!result.ok) {
      setShareError(result.message);
      return;
    }
    setSharedRoute(result.data);
    onShareRoute(result.data);
    setNotice("Route is ready to share with your crew.");
    setReload((value) => value + 1);
  }

  async function handleCopyRouteLink() {
    if (!sharedRoute) return;
    const link = new URL(window.location.href);
    link.search = "";
    link.searchParams.set("join-route", sharedRoute.shareCode);
    try {
      await navigator.clipboard.writeText(link.toString());
      setCopyNotice("Route link copied.");
    } catch (error) {
      console.warn("Veode route sharing: clipboard access failed", error);
      setCopyNotice("Copy the route link from the field below.");
    }
  }

  async function handleRouteInvite(entry: PartyRouteInvite, accept: boolean) {
    const partyId = entry.sharedRoute.partyId;
    setBusyId(partyId);
    setError(null);
    const result = await respondToPartyRouteInvite(partyId, accept);
    setBusyId(null);
    if (!result.ok) {
      setError(result.message);
      return;
    }
    setRouteInvites((current) => current.filter((invite) => invite.sharedRoute.partyId !== partyId));
    setNotice(accept ? `Joining ${entry.ownerUsername}'s route.` : "Route invitation declined.");
    setReload((value) => value + 1);
    if (accept && result.data) onJoinRoute(result.data);
  }

  async function handleInviteToRoute(partyId: string, memberId: string, username: string) {
    setBusyId(memberId);
    setError(null);
    const result = await invitePartyMemberToRoute(partyId, memberId);
    if (result.ok) {
      setRouteInviteStatuses((current) => new Map(current).set(memberId, "pending"));
      setNotice(`Route invitation sent to ${username}.`);
    } else {
      setError(result.message);
    }
    setBusyId(null);
  }

  async function handleStopSharing() {
    if (!sharedRoute) return;
    setShareBusy(true);
    setShareError(null);
    const result = await clearPartySharedRoute(sharedRoute.partyId);
    setShareBusy(false);
    if (!result.ok) {
      setShareError(result.message);
      return;
    }
    setSharedRoute(null);
    setCopyNotice(null);
    onStopSharing();
    setNotice("The public route link has been revoked.");
    setReload((value) => value + 1);
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

        <section className="pp-section pp-route-share">
          <div className="pp-section-title">Share a route</div>
          {!route ? (
            <div className="pp-state">Choose a route first, then invite your crew to join it.</div>
          ) : route.mode === "public-transport" ? (
            <div className="pp-state">Route party progress currently supports driving and walking routes.</div>
          ) : (
            <>
              <div className="pp-route-summary">
                <strong>{route.name}</strong>
                <span>{Math.ceil(route.durationSeconds / 60)} min planned</span>
              </div>
              <button
                type="button"
                className="pp-request pp-route-share-button"
                disabled={!account.activeId || shareBusy}
                onClick={() => void handleShareRoute()}
              >
                {shareBusy ? "Preparing route…" : sharedRoute ? "Refresh route link" : "Share this route"}
              </button>
              {!account.activeId && <div className="pp-state">Sign in to share a route.</div>}
              {shareError && <div className="pp-state is-error" role="alert">{shareError}</div>}
              {sharedRoute && (
                <div className="pp-route-link">
                  <label htmlFor="pp-route-link">Anyone with this link can join:</label>
                  <input
                    id="pp-route-link"
                    value={(() => {
                      const link = new URL(window.location.href);
                      link.search = "";
                      link.searchParams.set("join-route", sharedRoute.shareCode);
                      return link.toString();
                    })()}
                    readOnly
                    onFocus={(event) => event.currentTarget.select()}
                  />
                  <button type="button" className="pp-request" onClick={() => void handleCopyRouteLink()}>
                    Copy route link
                  </button>
                  <button
                    type="button"
                    className="pp-request pp-route-revoke"
                    disabled={shareBusy}
                    onClick={() => void handleStopSharing()}
                  >
                    {shareBusy ? "Working…" : "Stop sharing route"}
                  </button>
                  {copyNotice && <span role="status">{copyNotice}</span>}
                </div>
              )}
            </>
          )}
        </section>

        {routeInvites.length > 0 && (
          <section className="pp-section">
            <div className="pp-section-title">Route invitations</div>
            <ul className="pp-party-list">
              {routeInvites.map((invite) => (
                <li className="pp-party-row" key={`route-invite-${invite.sharedRoute.partyId}`}>
                  <img src={avatarSrc(invite.ownerAvatarId)} alt="" />
                  <div className="pp-person-copy">
                    <strong>{invite.ownerUsername}</strong>
                    <span>invited you to join their route</span>
                  </div>
                  <div className="pp-row-actions">
                    <button
                      type="button"
                      className="pp-request pp-route-invite-action"
                      disabled={busyId === invite.sharedRoute.partyId}
                      onClick={() => void handleRouteInvite(invite, true)}
                    >
                      {busyId === invite.sharedRoute.partyId ? "Joining…" : "Accept"}
                    </button>
                    <button
                      type="button"
                      className="pp-request is-quiet"
                      disabled={busyId === invite.sharedRoute.partyId}
                      onClick={() => void handleRouteInvite(invite, false)}
                    >
                      Decline
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}

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
                              <span>
                                {entry.status !== "accepted"
                                  ? "Invitation pending"
                                  : ownParty && sharedRoute?.partyId === partyId && entry.memberId !== account.activeId
                                    ? routeInviteStatuses.get(entry.memberId) === "accepted"
                                      ? "Joined route"
                                      : routeInviteStatuses.get(entry.memberId) === "pending"
                                        ? "Route invitation pending"
                                        : "In party"
                                    : "In party"}
                              </span>
                            </div>
                            {ownParty &&
                              entry.status === "accepted" &&
                              entry.memberId !== account.activeId &&
                              sharedRoute?.partyId === partyId &&
                              routeInviteStatuses.get(entry.memberId) !== "accepted" && (
                                <button
                                  type="button"
                                  className="pp-request"
                                  disabled={
                                    busyId === entry.memberId ||
                                    routeInviteStatuses.get(entry.memberId) === "pending"
                                  }
                                  onClick={() =>
                                    void handleInviteToRoute(partyId, entry.memberId, entry.memberUsername)
                                  }
                                >
                                  {busyId === entry.memberId
                                    ? "Sending…"
                                    : routeInviteStatuses.get(entry.memberId) === "pending"
                                      ? "Invited"
                                      : "Invite to route"}
                                </button>
                              )}
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