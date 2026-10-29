export type TimeUnit = 'seconds' | 'minutes';

export interface Duration {
  value: string;
  unit: TimeUnit;
}

export const toDuration = (seconds: number): Duration => (seconds >= 60 && seconds % 60 === 0 ? { value: String(seconds / 60), unit: 'minutes' } : { value: String(seconds), unit: 'seconds' });

export const toSeconds = (d: Duration) => Number(d.value) * (d.unit === 'minutes' ? 60 : 1);

interface DurationInputProps {
  label: string;
  value: Duration;
  onChange: (value: Duration) => void;
}

/** A number field with a seconds or minutes picker inside the box. */
export function DurationInput({ label, value, onChange }: DurationInputProps) {
  return (
    <div class="unit-field">
      <input type="number" inputMode="numeric" aria-label={label} min={1} value={value.value} onInput={(e) => onChange({ ...value, value: e.currentTarget.value })} />
      <select aria-label={`${label} unit`} value={value.unit} onChange={(e) => onChange({ ...value, unit: e.currentTarget.value as TimeUnit })}>
        <option value="seconds">seconds</option>
        <option value="minutes">minutes</option>
      </select>
    </div>
  );
}
