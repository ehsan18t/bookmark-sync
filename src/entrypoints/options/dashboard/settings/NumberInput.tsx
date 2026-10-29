interface NumberInputProps {
  value: string;
  onChange: (value: string) => void;
  min: number;
  max?: number;
}

export function NumberInput({ value, onChange, min, max }: NumberInputProps) {
  return <input type="number" min={min} max={max} value={value} onInput={(e) => onChange(e.currentTarget.value)} />;
}
