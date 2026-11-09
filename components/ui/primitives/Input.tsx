import {
  Children,
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  createContext,
  forwardRef,
  isValidElement,
  useContext,
  useId,
} from "react";

const baseStyles =
  "w-full rounded-btn border-0 bg-forge-steel px-3.5 py-2 text-forge-mist placeholder-forge-ash ring-1 ring-inset ring-forge-steel/80 transition-colors focus:ring-2 focus:ring-ember focus:outline-hidden";

// A Field hands one generated id to the Label and the Input/Textarea inside it,
// so the label names the control without every call site wiring id/htmlFor.
// The same Field reserves "<id>-hint" and "<id>-error": a direct Label child
// that renders a hint owns the hint slot, an error set on the Field owns the
// error slot, and the control references both in its aria-describedby (hint id
// first, then error id, then any aria-describedby from the call site), so the
// hint and the error sit in the accessible description instead of the
// accessible name, and no id is ever referenced that renders nothing.
interface FieldIds {
  id: string;
  hintId?: string;
  errorId?: string;
  describedBy?: string;
}

const FieldIdContext = createContext<FieldIds | undefined>(undefined);

export function Field({
  children,
  className,
  error,
}: {
  children: React.ReactNode;
  className?: string;
  /** Rendered under the field and named in the control's aria-describedby. */
  error?: string;
}) {
  const id = useId();
  const hasHint = Children.toArray(children).some(
    (child) =>
      isValidElement<{ hint?: string }>(child) && child.type === Label && Boolean(child.props.hint),
  );
  const hintId = hasHint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <FieldIdContext.Provider value={{ id, hintId, errorId, describedBy }}>
      <div className={className}>{children}</div>
      {error && (
        <p id={errorId} className="text-xs text-danger mt-1.5">
          {error}
        </p>
      )}
    </FieldIdContext.Provider>
  );
}

function controlDescribedBy(
  field: FieldIds | undefined,
  explicit: string | undefined,
): string | undefined {
  return [field?.describedBy, explicit].filter(Boolean).join(" ") || undefined;
}

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", id, "aria-describedby": describedBy, ...props }, ref) => {
    const field = useContext(FieldIdContext);
    return (
      <input
        ref={ref}
        id={id ?? field?.id}
        {...props}
        aria-describedby={controlDescribedBy(field, describedBy)}
        className={`${baseStyles} ${className}`}
      />
    );
  },
);
Input.displayName = "Input";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", id, "aria-describedby": describedBy, ...props }, ref) => {
    const field = useContext(FieldIdContext);
    return (
      <textarea
        ref={ref}
        id={id ?? field?.id}
        {...props}
        aria-describedby={controlDescribedBy(field, describedBy)}
        className={`${baseStyles} ${className}`}
      />
    );
  },
);
Textarea.displayName = "Textarea";

interface LabelProps {
  children: React.ReactNode;
  required?: boolean;
  hint?: string;
  className?: string;
  /** Overrides the id of the enclosing Field. */
  htmlFor?: string;
}

export function Label({ children, required, hint, className = "", htmlFor }: LabelProps) {
  const field = useContext(FieldIdContext);
  return (
    <label
      htmlFor={htmlFor ?? field?.id}
      className={`block text-sm font-medium text-forge-ash mb-1.5 ${className}`}
    >
      {children}
      {required && (
        <span aria-hidden="true" className="text-danger ml-0.5">
          *
        </span>
      )}
      {hint && (
        <span
          {...(field?.hintId ? { id: field.hintId, "aria-hidden": "true" } : {})}
          className="text-forge-ash text-xs ml-2"
        >
          {hint}
        </span>
      )}
    </label>
  );
}
