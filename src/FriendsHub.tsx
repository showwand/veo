import { useEffect, useMemo, useRef, useState } from "react";
import Avatar from "./Avatar";
import { useAccountState } from "./accountStore";
import {
  listFriendMessages,
  sendFriendMessage,
  type FriendMessage,
} from "./friendChatApi";
import { listFriends, type Friend } from "./friendsApi";
import "./friendsHub.css";

type Props = { onClose: () => void; onOpenAccount: () => void };

function formatTime(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function mergeMessages(previous: FriendMessage[], latest: FriendMessage[]): FriendMessage[] {
  const merged = new Map(previous.map((message) => [message.id, message]));
  for (const message of latest) merged.set(message.id, message);
  return [...merged.values()]
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
    .slice(-100);
}

export default function FriendsHub({ onClose, onOpenAccount }: Props) {
  const account = useAccountState();
  const [friends, setFriends] = useState<Friend[]>([]);
  const [friendsLoadedForId, setFriendsLoadedForId] = useState<string | null>(null);
  const [friendsError, setFriendsError] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [conversation, setConversation] = useState<{
    key: string;
    messages: FriendMessage[];
    error: string | null;
  } | null>(null);
  const [draft, setDraft] = useState("");
  const [sending, setSending] = useState(false);
  const listEndRef = useRef<HTMLDivElement | null>(null);
  const visibleFriends = useMemo(
    () =>
      account.activeId && friendsLoadedForId === account.activeId ? friends : [],
    [account.activeId, friendsLoadedForId, friends]
  );
  const friendsLoading = account.activeId !== null && friendsLoadedForId !== account.activeId;
  const visibleFriendsError =
    account.activeId && friendsLoadedForId === account.activeId ? friendsError : null;
  const selectedFriend = useMemo(
    () => visibleFriends.find((friend) => friend.id === selectedId) ?? null,
    [visibleFriends, selectedId]
  );
  const conversationKey =
    selectedFriend && account.activeId ? `${account.activeId}:${selectedFriend.id}` : null;
  const messages = useMemo(
    () =>
      conversationKey && conversation?.key === conversationKey ? conversation.messages : [],
    [conversation, conversationKey]
  );
  const messagesLoading =
    conversationKey !== null && conversation?.key !== conversationKey;
  const messagesError =
    conversationKey && conversation?.key === conversationKey ? conversation.error : null;

  useEffect(() => {
    function handleKey(event: KeyboardEvent) {
      if (event.key === "Escape") onClose();
    }
    window.addEventListener("keydown", handleKey);
    return () => window.removeEventListener("keydown", handleKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;

    if (!account.activeId) {
      return;
    }

    void listFriends().then((result) => {
      if (cancelled) return;
      if (!result.ok) {
        setFriendsError(result.message);
        setFriends([]);
      } else {
        setFriends(result.data);
        setFriendsError(null);
        setSelectedId((current) =>
          result.data.some((friend) => friend.id === current)
            ? current
            : result.data[0]?.id ?? null
        );
      }
      setFriendsLoadedForId(account.activeId ?? null);
    });

    return () => {
      cancelled = true;
    };
  }, [account.activeId]);

  useEffect(() => {
    if (!selectedFriend || !account.activeId || !conversationKey) return;

    let cancelled = false;
    let timer: number | null = null;

    const refresh = async () => {
      const result = await listFriendMessages(selectedFriend.id);
      if (cancelled) return;
      setConversation((current) => {
        const previous = current?.key === conversationKey ? current.messages : [];
        const nextMessages = result.ok ? mergeMessages(previous, result.data) : previous;
        const unchanged =
          nextMessages.length === previous.length &&
          nextMessages.every(
            (message, index) =>
              message.id === previous[index]?.id && message.body === previous[index]?.body
          );
        return {
          key: conversationKey,
          messages: unchanged ? previous : nextMessages,
          error: result.ok ? null : result.message,
        };
      });
      timer = window.setTimeout(() => void refresh(), result.ok ? 5000 : 30000);
    };

    void refresh();
    return () => {
      cancelled = true;
      if (timer !== null) window.clearTimeout(timer);
    };
  }, [account.activeId, conversationKey, selectedFriend]);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [messages]);

  async function handleSend(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!selectedFriend || !draft.trim() || sending) return;

    setSending(true);
    const result = await sendFriendMessage(selectedFriend.id, draft);
    setSending(false);
    if (!result.ok) {
      if (conversationKey) {
        setConversation((current) => ({
          key: conversationKey,
          messages: current?.key === conversationKey ? current.messages : [],
          error: result.message,
        }));
      }
      return;
    }
    setDraft("");
    if (conversationKey) {
      setConversation((current) => {
        const currentMessages = current?.key === conversationKey ? current.messages : [];
        return {
          key: conversationKey,
          messages: currentMessages.some((message) => message.id === result.data.id)
            ? currentMessages
            : [...currentMessages, result.data],
          error: null,
        };
      });
    }
  }

  return (
    <main className="friends-hub" role="dialog" aria-modal="true" aria-label="Veode friends and chat">
      <header className="fh-topbar">
        <div className="fh-brand">
          <span className="fh-brand-mark" aria-hidden="true">V</span>
          <span className="fh-brand-name">VEODE</span>
          <span className="fh-brand-divider" aria-hidden="true" />
          <span className="fh-brand-caption">CREW LINK / FOR NOW</span>
        </div>
        <div className="fh-topbar-right">
          <span className="fh-signal"><span /> FRIEND CHANNEL</span>
          <button type="button" className="fh-close" onClick={onClose} aria-label="Return to map">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <path d="M5 5l14 14M19 5 5 19" />
            </svg>
            <span>MAP</span>
          </button>
        </div>
      </header>

      <section className="fh-layout">
        <aside className="fh-roster" aria-label="Friends">
          <div className="fh-section-kicker"><span>01</span> YOUR CREW</div>
          <div className="fh-roster-heading">
            <h1>FRIENDS</h1>
            <span className="fh-roster-count">{friends.length.toString().padStart(2, "0")}</span>
          </div>
          <p className="fh-roster-note">Pick a driver to open your private channel.</p>

          {!account.activeId ? (
            <div className="fh-empty-roster">
              <span className="fh-empty-icon" aria-hidden="true">!</span>
              <strong>SIGN IN TO CONNECT</strong>
              <span>Your friend list and chats are tied to your Veode account.</span>
              <button type="button" className="fh-empty-action" onClick={onOpenAccount}>
                OPEN ACCOUNT
              </button>
            </div>
          ) : friendsLoading ? (
            <div className="fh-loading"><span className="fh-loader" /> SCANNING CREW…</div>
          ) : visibleFriendsError ? (
            <div className="fh-error" role="alert">{visibleFriendsError}</div>
          ) : visibleFriends.length === 0 ? (
            <div className="fh-empty-roster">
              <span className="fh-empty-icon" aria-hidden="true">+</span>
              <strong>NO CREW MEMBERS YET</strong>
              <span>Add friends from your Account panel to start a conversation.</span>
              <button type="button" className="fh-empty-action" onClick={onOpenAccount}>
                ADD FRIENDS
              </button>
            </div>
          ) : (
            <ul className="fh-friend-list">
              {visibleFriends.map((friend, index) => (
                <li key={friend.id}>
                  <button
                    type="button"
                    className={selectedFriend?.id === friend.id ? "fh-friend is-selected" : "fh-friend"}
                    aria-pressed={selectedFriend?.id === friend.id}
                    onClick={() => {
                      setSelectedId(friend.id);
                      setDraft("");
                    }}
                  >
                    <span className="fh-friend-index">{String(index + 1).padStart(2, "0")}</span>
                    <Avatar id={friend.avatarId} size={44} className="fh-avatar" />
                    <span className="fh-friend-copy">
                      <strong>{friend.username}</strong>
                      <span>VEODE DRIVER</span>
                    </span>
                    <span className="fh-friend-chevron" aria-hidden="true">›</span>
                  </button>
                </li>
              ))}
            </ul>
          )}

          <div className="fh-roster-footer">
            <span className="fh-footer-line" />
            <span>STAY IN FORMATION</span>
          </div>
        </aside>

        <div className="fh-divider" aria-hidden="true">
          <span>V</span>
        </div>

        <section className="fh-chat" aria-label="Friend chat">
          <div className="fh-chat-backdrop" aria-hidden="true">
            <span className="fh-speed-mark fh-speed-mark-one" />
            <span className="fh-speed-mark fh-speed-mark-two" />
            <span className="fh-speed-mark fh-speed-mark-three" />
          </div>
          <header className="fh-chat-header">
            <div>
              <div className="fh-section-kicker"><span>02</span> PRIVATE COMMS</div>
              <h2>{selectedFriend ? selectedFriend.username : "CREW CHAT"}</h2>
              <p>{selectedFriend ? "DIRECT DRIVER CHANNEL" : "SELECT A FRIEND TO GET STARTED"}</p>
            </div>
            {selectedFriend && <Avatar id={selectedFriend.avatarId} size={52} className="fh-chat-avatar" />}
          </header>

          <div className="fh-message-area" aria-live="polite">
            {!account.activeId ? (
              <div className="fh-chat-empty">
                <span className="fh-chat-emblem" aria-hidden="true">V</span>
                <strong>YOUR NEXT MESSAGE STARTS HERE</strong>
                <span>Sign in to open your crew channels.</span>
              </div>
            ) : !selectedFriend && visibleFriends.length === 0 && !friendsLoading && !visibleFriendsError ? (
              <div className="fh-chat-empty">
                <span className="fh-chat-emblem" aria-hidden="true">V</span>
                <strong>YOUR NEXT MESSAGE STARTS HERE</strong>
                <span>Add a friend to bring your crew onto the same frequency.</span>
              </div>
            ) : !selectedFriend ? (
              <div className="fh-chat-empty">
                <span className="fh-chat-emblem" aria-hidden="true">↖</span>
                <strong>CHOOSE YOUR COPILOT</strong>
                <span>Your conversations take the fast lane on this side.</span>
              </div>
            ) : messagesLoading && messages.length === 0 ? (
              <div className="fh-chat-empty">
                <span className="fh-loader" />
                <strong>CONNECTING CHANNEL</strong>
              </div>
            ) : messagesError && messages.length === 0 ? (
              <div className="fh-chat-empty is-error" role="alert">
                <strong>CHANNEL OFFLINE</strong>
                <span>{messagesError}</span>
                <span>Apply the friend chat database migration to enable messaging.</span>
              </div>
            ) : messages.length === 0 ? (
              <div className="fh-chat-empty">
                <span className="fh-chat-emblem" aria-hidden="true">V</span>
                <strong>NO MESSAGES ON THIS RUN</strong>
                <span>Say hello to {selectedFriend.username} and start the conversation.</span>
              </div>
            ) : (
              <ol className="fh-messages">
                {messages.map((message) => {
                  const own = message.senderId === account.activeId;
                  return (
                    <li className={own ? "fh-message is-own" : "fh-message"} key={message.id}>
                      {!own && <Avatar id={selectedFriend.avatarId} size={30} className="fh-message-avatar" />}
                      <div className="fh-message-content">
                        <span className="fh-message-author">{own ? "YOU" : selectedFriend.username}</span>
                        <p>{message.body}</p>
                        <time dateTime={message.createdAt}>{formatTime(message.createdAt)}</time>
                      </div>
                    </li>
                  );
                })}
                <div ref={listEndRef} />
              </ol>
            )}
          </div>

          {messagesError && messages.length > 0 && (
            <div className="fh-inline-error" role="alert">{messagesError}</div>
          )}

          <form className="fh-composer" onSubmit={(event) => void handleSend(event)}>
            <label className="fh-composer-label" htmlFor="fh-message-input">
              TRANSMIT MESSAGE
            </label>
            <div className="fh-compose-row">
              <input
                id="fh-message-input"
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                placeholder={selectedFriend ? `Message ${selectedFriend.username}…` : "Select a friend first"}
                maxLength={2000}
                disabled={!selectedFriend || sending}
              />
              <button type="submit" disabled={!selectedFriend || !draft.trim() || sending}>
                <span>{sending ? "SENDING" : "SEND"}</span>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M4 12 20 4l-5 16-3-7-8-1Zm8 1 8-9" />
                </svg>
              </button>
            </div>
            <div className="fh-composer-footer">
              <span>PRIVATE FRIEND-TO-FRIEND MESSAGES</span>
              <span>{draft.length}/2000</span>
            </div>
          </form>
        </section>
      </section>
    </main>
  );
}
