import Avatar from "./Avatar";
import { AVATARS } from "./avatars";

type Props = { selectedId: string; disabled: boolean; onPick: (id: string) => void };

// Renders every avatar in the list, so adding one to avatars.ts is all it takes
export default function AvatarPicker({ selectedId, disabled, onPick }: Props) {
  return (
    <div className="avatar-grid" role="radiogroup" aria-label="Profile picture">
      {AVATARS.map((avatar) => (
        <button
          key={avatar.id}
          type="button"
          role="radio"
          aria-checked={avatar.id === selectedId}
          className={avatar.id === selectedId ? "avatar-choice is-selected" : "avatar-choice"}
          disabled={disabled}
          onClick={() => onPick(avatar.id)}
          title={avatar.label}
        >
          <Avatar id={avatar.id} size={52} />
        </button>
      ))}
    </div>
  );
} 