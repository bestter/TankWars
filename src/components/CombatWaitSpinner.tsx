import { useId } from "react";

export interface CombatWaitSpinnerProps {
  readonly label: string;
  readonly className?: string;
}

/**
 * Renders a native indeterminate `<progress>` spinner paired with a visible wait cause.
 */
export function CombatWaitSpinner({ label, className }: CombatWaitSpinnerProps) {
  const labelId = useId();
  const rootClassName = className ? `retro-wait-status ${className}` : "retro-wait-status";
  return (
    <span className={rootClassName}>
      <progress className="retro-spinner" aria-labelledby={labelId} />
      <span id={labelId}>{label}</span>
    </span>
  );
}
