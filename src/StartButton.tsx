type Props = { onStart: () => void };

// Only begins navigation. Choosing a route never starts it by itself.
export default function StartButton({ onStart }: Props) {
  return (
    <button type="button" className="start-button" onClick={onStart}>
      Start
    </button>
  );
}