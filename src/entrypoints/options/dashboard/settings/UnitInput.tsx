interface UnitInputProps {
  label: string;
  unit: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max?: number;
}

/** A number field with its unit shown inside the box. */
export function UnitInput({ label, unit, value, onChange, min, max }: UnitInputProps) {
  return (
    <label class="unit-field">
      <input type="number" inputMode="numeric" aria-label={label} min={min} max={max} value={value} onInput={(e) => onChange(e.currentTarget.value)} />
      <span class="unit" aria-hidden="true">
        {unit}
      </span>
    </label>
  );
}
