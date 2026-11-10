import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';

export interface SelectOption {
  value: string;
  label: string;
  /** The label's language when it differs from the page's (a language's own name), for screen readers. */
  lang?: string;
}

interface SelectMenuProps {
  id?: string;
  title?: string;
  /** The accessible name, for a menu that has no `<label>` of its own. */
  label?: string;
  value: string;
  options: readonly SelectOption[];
  disabled?: boolean;
  onValueChange(value: string): void;
}

/**
 * Every dropdown in Settings. The list opens just below the control (`position="popper"`), where a
 * native `<select>` on macOS opens over it with the chosen item laid on top of the control.
 */
export function SelectMenu({
  id,
  title,
  label,
  value,
  options,
  disabled,
  onValueChange,
}: SelectMenuProps) {
  return (
    <Select value={value} disabled={disabled} onValueChange={onValueChange}>
      {/* One width for every dropdown, wide enough for the longest choice in any language, so the
          control does not grow or shrink with the chosen text. */}
      <SelectTrigger
        id={id}
        title={title}
        aria-label={label}
        size="sm"
        className="w-64 justify-between"
      >
        <SelectValue />
      </SelectTrigger>
      <SelectContent position="popper" align="start">
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} lang={option.lang}>
            {option.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
