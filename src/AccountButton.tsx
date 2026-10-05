import "./accounts.css";
import Avatar from "./Avatar";
import { useAccountState } from "./accountStore";

type Props = { active: boolean; onClick: () => void };

function PersonIcon() {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2">
      <circle cx="12" cy="8" r="4" />
      <path d="M4 21 C4 16 8 14 12 14 C16 14 20 16 20 21" />
    </svg>
  );
}

// The far-right top button. Shows the active account's picture, or a person icon when signed out.
// Its position is set by topActions.ts.
export default function AccountButton({ active, onClick }: Props) {
  const { profile } = useAccountState();
  return (
    <button
      type="button"
      className={active ? "account-button is-active" : "account-button"}
      onClick={onClick}
      aria-label={profile ? `Account: ${profile.username}` : "Account"}
      aria-pressed={active}
      title={profile ? profile.username : "Account"}
    >
      {profile ? <Avatar id={profile.avatarId} size={36} /> : <PersonIcon />}
    </button>
  );
}