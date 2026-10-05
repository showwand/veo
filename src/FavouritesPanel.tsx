import { useEffect, useState } from "react";
import "./favourites.css";
import "./accounts.css";
import type { SearchResult } from "./SearchBox";
import type { FavouriteRoute } from "./favourites";
import { useFavourites } from "./useFavourites";

type Props = {
  open: boolean;
  onClose: () => void;
  start: SearchResult | null; // the current A
  destination: SearchResult | null; // the current B
  onLoad: (favourite: FavouriteRoute) => void;
  accountId: string | null; // null = not signed in (favourites stay on this device)
  accountName: string | null;
};

// "Buckingham Palace, The Mall, London, ..." -> "Buckingham Palace"
const short = (name: string) => name.split(", ")[0] ?? name;

function ArrowIcon() {
  return (
    <svg viewBox="0 0 24 10" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M1 5 H21 M16 1 L21 5 L16 9" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2.4">
      <path d="M5 5 L19 19 M19 5 L5 19" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M4 7 H20 M9 7 V4 H15 V7 M6 7 L7 20 H17 L18 7 M10 11 V16 M14 11 V16" />
    </svg>
  );
}

export default function FavouritesPanel({
  open,
  onClose,
  start,
  destination,
  onLoad,
  accountId,
  accountName,
}: Props) {
  // Signed in: this account's favourites in Supabase. Signed out: this browser's list.
  const favs = useFavourites(accountId, open);
  const [mode, setMode] = useState<"list" | "add">("list");
  const [name, setName] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importHidden, setImportHidden] = useState(false);
  const [importing, setImporting] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);

  // Closing the panel returns it to the list view next time (adjusted while rendering)
  if (open !== wasOpen) {
    setWasOpen(open);
    if (!open) {
      setMode("list");
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

  const canSave = start !== null && destination !== null;
  const items = favs.items;

  function beginAdd() {
    if (!start || !destination) return;
    setName(`${short(start.name)} → ${short(destination.name)}`);
    setMessage(null);
    setMode("add");
  }

  async function handleSave(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!start || !destination) return;
    const finalName = name.trim() || `${short(start.name)} → ${short(destination.name)}`;
    setSaving(true);
    const error = await favs.add(finalName, start, destination);
    setSaving(false);
    if (error) {
      setMessage(error);
    } else {
      setMode("list");
      setMessage(null);
    }
  }

  async function handleRemove(id: string) {
    const error = await favs.remove(id);
    setMessage(error);
  }

  async function handleImport() {
    setImporting(true);
    const error = await favs.importLocal();
    setImporting(false);
    setMessage(error);
  }

  const addHint = canSave ? null : "Choose a starting point and a destination first.";
  const showImport = accountId !== null && favs.localCount > 0 && !importHidden;

  return (
    <aside
      className={open ? "favourites-panel is-open" : "favourites-panel"}
      aria-label="Favourite routes"
      aria-hidden={!open}
    >
      <header className="fav-header">
        <span className="fav-title">Favourite routes</span>
        <button type="button" className="fav-close" onClick={onClose} aria-label="Close favourites">
          <CloseIcon />
        </button>
      </header>

      <div className="fav-owner">
        {accountId !== null ? `Saved to ${accountName ?? "this account"}` : "Saved on this device only"}
      </div>

      {showImport && (
        <div className="fav-import">
          You have {favs.localCount} favourite {favs.localCount === 1 ? "route" : "routes"} saved on this device (not in
          an account). Import {favs.localCount === 1 ? "it" : "them"} into {accountName ?? "this account"}?
          <div className="fav-import-actions">
            <button type="button" className="fav-primary" disabled={importing} onClick={() => void handleImport()}>
              {importing ? "Importing…" : "Import"}
            </button>
            <button type="button" className="fav-secondary" disabled={importing} onClick={() => setImportHidden(true)}>
              Not now
            </button>
          </div>
        </div>
      )}

      {mode === "list" && (
        <>
          {favs.loading ? (
            <div className="fav-hint">Loading favourites…</div>
          ) : items.length === 0 ? (
            <div className="fav-empty">
              <div className="fav-empty-title">No favourite routes yet.</div>
              <button type="button" className="fav-primary" onClick={beginAdd} disabled={!canSave}>
                Add your first route
              </button>
            </div>
          ) : (
            <ul className="fav-list">
              {items.map((item) => (
                <li key={item.id} className="fav-item">
                  <button type="button" className="fav-load" onClick={() => onLoad(item)} title="Load this route">
                    <span className="fav-name">{item.name}</span>
                    <span className="fav-route">
                      <span className="fav-badge">A</span>
                      <span className="fav-place">{short(item.start.name)}</span>
                      <span className="fav-arrow">
                        <ArrowIcon />
                      </span>
                      <span className="fav-badge is-end">B</span>
                      <span className="fav-place">{short(item.destination.name)}</span>
                    </span>
                    <span className="fav-go">Load</span>
                  </button>
                  <button
                    type="button"
                    className="fav-remove"
                    onClick={() => void handleRemove(item.id)}
                    aria-label={`Remove ${item.name}`}
                    title="Remove"
                  >
                    <TrashIcon />
                  </button>
                </li>
              ))}
            </ul>
          )}

          {items.length > 0 && (
            <button type="button" className="fav-add" onClick={beginAdd} disabled={!canSave}>
              + Add favourite
            </button>
          )}
          {addHint && <div className="fav-hint">{addHint}</div>}
          {favs.error && <div className="fav-hint is-error">{favs.error}</div>}
        </>
      )}

      {mode === "add" && (
        <form className="fav-form" onSubmit={(event) => void handleSave(event)}>
          <label className="fav-label" htmlFor="favourite-name">
            Name
          </label>
          <input
            id="favourite-name"
            className="fav-input"
            type="text"
            value={name}
            maxLength={60}
            onChange={(event) => setName(event.target.value)}
            autoFocus
          />
          {start && destination && (
            <div className="fav-summary">
              <span className="fav-badge">A</span>
              <span className="fav-place">{short(start.name)}</span>
              <span className="fav-arrow">
                <ArrowIcon />
              </span>
              <span className="fav-badge is-end">B</span>
              <span className="fav-place">{short(destination.name)}</span>
            </div>
          )}
          <div className="fav-actions">
            <button type="submit" className="fav-primary" disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </button>
            <button type="button" className="fav-secondary" onClick={() => setMode("list")} disabled={saving}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {message && <div className="fav-hint is-error">{message}</div>}
    </aside>
  );
}