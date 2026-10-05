import { useState } from "react";
import { createAccount, signInAccount, useAccountState } from "./accountStore";
import {
  PASSWORD_MIN,
  USERNAME_MAX,
  USERNAME_MIN,
  normaliseUsername,
  validateUsername,
} from "./accountRules";

type Props = {
  prefillUsername: string; // set when signing in again to an expired account
  onDone: () => void;
  onCancel: () => void;
};

export default function AddAccountForm({ prefillUsername, onDone, onCancel }: Props) {
  const { busy } = useAccountState();
  const [mode, setMode] = useState<"create" | "signin">(prefillUsername ? "signin" : "create");
  const [username, setUsername] = useState(prefillUsername);
  const [password, setPassword] = useState("");
  const [error, setError] = useState<{ message: string; field?: "username" | "password" } | null>(null);

  const typed = normaliseUsername(username);
  const hint = typed === "" || mode === "signin" ? null : validateUsername(typed);

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setError(null);
    const result =
      mode === "create"
        ? await createAccount(username, password)
        : await signInAccount(username, password);
    if (result.ok) {
      setPassword("");
      onDone();
    } else {
      setError(result.field ? { message: result.message, field: result.field } : { message: result.message });
    }
  }

  return (
    <form className="acct-form" onSubmit={handleSubmit}>
      <div className="acct-tabs" role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={mode === "create"}
          className={mode === "create" ? "acct-tab is-on" : "acct-tab"}
          onClick={() => {
            setMode("create");
            setError(null);
          }}
        >
          New account
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === "signin"}
          className={mode === "signin" ? "acct-tab is-on" : "acct-tab"}
          onClick={() => {
            setMode("signin");
            setError(null);
          }}
        >
          I have an account
        </button>
      </div>

      <label className="acct-label" htmlFor="acct-username">
        Username
      </label>
      <input
        id="acct-username"
        className={error?.field === "username" ? "acct-input is-bad" : "acct-input"}
        type="text"
        value={username}
        maxLength={USERNAME_MAX + 10}
        onChange={(event) => setUsername(event.target.value)}
        autoComplete="username"
        autoCapitalize="none"
        autoCorrect="off"
        spellCheck={false}
        autoFocus
      />
      {mode === "create" && (
        <div className={hint ? "acct-hint is-bad" : "acct-hint"}>
          {hint ?? `${USERNAME_MIN}–${USERNAME_MAX} letters, numbers or _. Friends find you by this. Not case-sensitive.`}
        </div>
      )}

      <label className="acct-label" htmlFor="acct-password">
        Password
      </label>
      <input
        id="acct-password"
        className={error?.field === "password" ? "acct-input is-bad" : "acct-input"}
        type="password"
        value={password}
        onChange={(event) => setPassword(event.target.value)}
        autoComplete={mode === "create" ? "new-password" : "current-password"}
      />
      {mode === "create" && (
        <div className="acct-hint">
          At least {PASSWORD_MIN} characters. There is no password reset, so keep it safe.
        </div>
      )}

      {error && <div className="acct-error">{error.message}</div>}

      <div className="acct-actions">
        <button type="submit" className="acct-primary" disabled={busy}>
          {busy ? "Please wait…" : mode === "create" ? "Create account" : "Sign in"}
        </button>
        <button type="button" className="acct-secondary" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}