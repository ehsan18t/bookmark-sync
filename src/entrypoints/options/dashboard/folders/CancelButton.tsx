interface CancelButtonProps {
  onClose: () => void;
}

export function CancelButton({ onClose }: CancelButtonProps) {
  return (
    <button type="button" class="ghost" onClick={onClose}>
      Cancel
    </button>
  );
}
