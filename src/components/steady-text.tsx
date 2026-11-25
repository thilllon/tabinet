interface SteadyTextProps {
  text: string;
  /** Every text that could stand here instead. */
  variants: readonly string[];
  /** Read out when it changes. Only one line of a row is. */
  live?: boolean;
  className?: string;
}

/**
 * A line whose text changes without moving anything under it: the other texts it could hold are
 * laid out invisibly in the same grid cell, so it is always as tall as the tallest at this width.
 * Only `text` is seen and read out.
 */
export function SteadyText({ text, variants, live = false, className }: SteadyTextProps) {
  const Line = live ? 'output' : 'p';
  return (
    <div className={className}>
      <div className="grid">
        {[...new Set(variants)].map((variant) => (
          <span key={variant} aria-hidden="true" className="invisible col-start-1 row-start-1">
            {variant}
          </span>
        ))}
        <Line className="col-start-1 row-start-1">{text}</Line>
      </div>
    </div>
  );
}
