import { Field } from './Field.js';

interface NewPassphraseFieldsProps {
  pass: string;
  again: string;
  onPass: (value: string) => void;
  onAgain: (value: string) => void;
  hint?: string;
}

export function NewPassphraseFields({ pass, again, onPass, onAgain, hint }: NewPassphraseFieldsProps) {
  return (
    <div class="fields-2">
      <Field label="Passphrase" hint={hint}>
        <input type="password" autocomplete="new-password" value={pass} onInput={(e) => onPass(e.currentTarget.value)} />
      </Field>
      <Field label="Repeat passphrase">
        <input type="password" autocomplete="new-password" value={again} onInput={(e) => onAgain(e.currentTarget.value)} />
      </Field>
    </div>
  );
}
