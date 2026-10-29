import { cloneElement, type VNode } from 'preact';
import { useId } from 'preact/hooks';

interface FieldProps {
  label: string;
  hint?: string;
  children: VNode<{ id?: string }>;
}

/** A labelled control; the child gets the id and hint wiring. */
export function Field({ label, hint, children }: FieldProps) {
  const id = useId();
  return (
    <div class="field">
      <label for={id}>{label}</label>
      {cloneElement(children, { id, 'aria-describedby': hint ? `${id}-hint` : undefined })}
      {hint && (
        <span class="hint" id={`${id}-hint`}>
          {hint}
        </span>
      )}
    </div>
  );
}
