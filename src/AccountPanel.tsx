import { useEffect, useRef, useState } from "react";
import "./accounts.css";
import Avatar from "./Avatar";
import AvatarPicker from "./AvatarPicker";
import AddAccountForm from "./AddAccountForm";
import FriendsSection from "./FriendsSection";
import { MAX_ACCOUNTS } from "./savedAccounts";
import {
  dismissNotice,
  setAvatar,
  setLocationSharing,
  signOutActive,
  switchAccount,
  useAccountState,
} from "./accountStore";

type Props = { open: boolean; onClose: () => void };

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M5 5 L19 19 M19 5 L5 19" />
    </svg>
  );
}

export default function AccountPanel({ open, onClose }: Props) {
  const account = useAccountState();
  const [view, setView] = useState<"main" | "add">("main");
  const [prefill, setPrefill] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [wasOpen, setWasOpen] = useState(open);
  const panelRef = useRef<HTMLElement | null>(null);

  // Closing the panel resets it (adjusted while rendering, so no extra effect is needed)
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setView("main");
      setPrefill("");
      setPickerOpen(false);
      setMessage(null);
    }
  }

  // Escape closes the panel
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  // Clicking anywhere outside the panel (and not on the Account button) closes it
  useEffect(() => {
    if (!open) return;
    const onDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (panelRef.current?.contains(target)) return;
      if (target.closest(".account-button")) return;
      onClose();
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onClose]);

  const { profile, accounts, activeId, busy } = account;
  const atLimit = accounts.length >= MAX_ACCOUNTS;

  async function handleSwitch(id: string, username: string, needsSignIn: boolean) {
    setMessage(null);
    if (needsSignIn) {
      setPrefill(username);
      setView("add");
      return;
    }
    const result = await switchAccount(id);
    if (!result.ok) setMessage(result.message);
  }

  async function handlePickAvatar(avatarId: string) {
    setMessage(null);
    const result = await setAvatar(avatarId);
    if (result.ok) setPickerOpen(false);
    else setMessage(result.message);
  }

  async function handleLocationSharing(next: boolean) {
    setMessage(null);
    const result = await setLocationSharing(next);
    if (!result.ok) setMessage(result.message);
  }

  async function handleSignOut() {
    setMessage(null);
    const result = await signOutActive();
    if (!result.ok) setMessage(result.message);
  }

  return (
    <aside
      ref={panelRef}
      className={open ? "account-panel is-open" : "account-panel"}
      aria-label="Account"
      aria-hidden={!open}
    >
      <header className="acct-header">
        <span className="acct-title">Account</span>
        <button type="button" className="acct-close" onClick={onClose} aria-label="Close account panel">
          <CloseIcon />
        </button>
      </header>

      {!account.configured && (
        <div className="acct-error">
          Supabase isn't set up yet. Add VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY to .env.local and restart the dev server.
        </div>
      )}

      {account.configured && !account.ready && <div className="acct-hint">Loading account…</div>}

      {account.configured && account.ready && view === "add" && (
        <AddAccountForm
          prefillUsername={prefill}
          onDone={() => {
            setView("main");
            setPrefill("");
          }}
          onCancel={() => {
            setView("main");
            setPrefill("");
          }}
        />
      )}

      {account.configured && account.ready && view === "main" && (
        <>
          {account.notice && (
            <div className="acct-notice">
              <span>{account.notice}</span>
              <button type="button" className="acct-link" onClick={dismissNotice}>
                Dismiss
              </button>
            </div>
          )}

          {activeId !== null && (
            <div className="acct-hero">
              {profile ? (
                <>
                  <button
                    type="button"
                    className="acct-hero-avatar"
                    onClick={() => setPickerOpen((o) => !o)}
                    aria-expanded={pickerOpen}
                    aria-label="Change profile picture"
                  >
                    <Avatar id={profile.avatarId} size={96} />
                    <span className="acct-hero-edit">Change</span>
                  </button>
                  <div className="acct-hero-name">{profile.username || "…"}</div>
                  {pickerOpen && (
                    <AvatarPicker selectedId={profile.avatarId} disabled={busy} onPick={(id) => void handlePickAvatar(id)} />
                  )}
                </>
              ) : (
                <div className="acct-hint">{account.profileError ?? "Loading profile…"}</div>
              )}
            </div>
          )}

          <section className="acct-section">
            <h3 className="acct-heading">Accounts</h3>
            {accounts.length === 0 ? (
              <div className="acct-empty">No accounts yet</div>
            ) : (
              <ul className="acct-list">
                {accounts.map((item) => {
                  const isActive = item.id === activeId;
                  return (
                    <li key={item.id}>
                      <button
                        type="button"
                        className={isActive ? "acct-row is-active" : "acct-row"}
                        disabled={busy}
                        aria-current={isActive ? "true" : undefined}
                        onClick={() => void handleSwitch(item.id, item.username, item.needsSignIn)}
                      >
                        <span className="acct-radio" aria-hidden="true">
                          {isActive ? "●" : "○"}
                        </span>
                        <Avatar id={item.avatarId} size={32} />
                        <span className="acct-row-name">{item.username || "…"}</span>
                        {item.needsSignIn && <span className="acct-row-tag">Sign in again</span>}
                        {isActive && <span className="acct-row-tag is-on">Active</span>}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
            <button
              type="button"
              className="acct-add"
              disabled={busy || atLimit}
              onClick={() => {
                setPrefill("");
                setView("add");
              }}
            >
              {accounts.length === 0 ? "+ Add an account" : "+ Add account"}
            </button>
            {atLimit && <div className="acct-hint">Maximum of {MAX_ACCOUNTS} accounts on this device.</div>}
          </section>

          {activeId !== null && profile && <FriendsSection key={activeId} active={open} />}

          {activeId !== null && profile && (
            <section className="acct-section">
              <h3 className="acct-heading">Privacy</h3>
              <div className="acct-toggle-row">
                <div className="acct-toggle-copy">
                  <div className="acct-toggle-label">Share my location with friends</div>
                  <div className="acct-toggle-help">
                    When on, accepted friends can see your current location. When off, your location stays private.
                  </div>
                </div>
                <button
                  type="button"
                  className={profile.shareLocation ? "acct-toggle is-on" : "acct-toggle"}
                  aria-pressed={profile.shareLocation}
                  aria-label="Share my location with friends"
                  disabled={busy}
                  onClick={() => void handleLocationSharing(!profile.shareLocation)}
                >
                  <span className="acct-toggle-track">
                    <span className="acct-toggle-thumb" />
                  </span>
                  <span className="acct-toggle-state">{profile.shareLocation ? "ON" : "OFF"}</span>
                </button>
              </div>
            </section>
          )}

          {activeId !== null && (
            <button type="button" className="acct-signout" disabled={busy} onClick={() => void handleSignOut()}>
              Sign out {profile ? profile.username : ""}
            </button>
          )}
        </>
      )}

      {message && <div className="acct-error">{message}</div>}
    </aside>
  );
}