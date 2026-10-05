import { avatarSrc } from "./avatars";

type Props = { id: string; size?: number; className?: string };

// One profile picture. Used everywhere an account or friend is shown.
export default function Avatar({ id, size = 40, className }: Props) {
  return (
    <img
      className={className ? `avatar ${className}` : "avatar"}
      src={avatarSrc(id)}
      width={size}
      height={size}
      alt=""
      draggable={false}
    />
  );
}