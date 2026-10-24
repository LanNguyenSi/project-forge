import {
  InputHTMLAttributes,
  TextareaHTMLAttributes,
  createContext,
  forwardRef,
  useContext,
  useId,
} from "react";

const baseStyles =
  "w-full rounded-btn border-0 bg-forge-steel px-3.5 py-2 text-forge-mist placeholder-forge-ash ring-1 ring-inset ring-forge-steel/80 transition-colors focus:ring-2 focus:ring-ember focus:outline-hidden";

// A Field hands one generated id to the Label and the Input/Textarea inside it,
// so the label names the control without every call site wiring id/htmlFor.
const FieldIdContext = createContext<string | undefined>(undefined);

export function Field({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  const id = useId();
  return (
    <FieldIdContext.Provider value={id}>
      <div className={className}>{children}</div>
    </FieldIdContext.Provider>
  );
}

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", id, ...props }, ref) => {
    const fieldId = useContext(FieldIdContext);
    return (
      <input
        ref={ref}
        id={id ?? fieldId}
        className={`${baseStyles} ${className}`}
        {...props}
      />
    );
  },
);
Input.displayName = "Input";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", id, ...props }, ref) => {
    const fieldId = useContext(FieldIdContext);
    return (
      <textarea
        ref={ref}
        id={id ?? fieldId}
        className={`${baseStyles} ${className}`}
        {...props}
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
  const fieldId = useContext(FieldIdContext);
  return (
    <label
      htmlFor={htmlFor ?? fieldId}
      className={`block text-sm font-medium text-forge-ash mb-1.5 ${className}`}
    >
      {children}
      {required && (
        <span aria-hidden="true" className="text-danger ml-0.5">
          *
        </span>
      )}
      {hint && <span className="text-forge-ash text-xs ml-2">{hint}</span>}
    </label>
  );
}
