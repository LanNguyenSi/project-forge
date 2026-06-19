import { InputHTMLAttributes, TextareaHTMLAttributes, forwardRef } from "react";

const baseStyles =
  "w-full rounded-btn border-0 bg-forge-steel px-3.5 py-2 text-forge-mist placeholder-forge-ash ring-1 ring-inset ring-forge-steel/80 transition-colors focus:ring-2 focus:ring-ember focus:outline-none";

type InputProps = InputHTMLAttributes<HTMLInputElement>;

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <input ref={ref} className={`${baseStyles} ${className}`} {...props} />
    );
  },
);
Input.displayName = "Input";

type TextareaProps = TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className = "", ...props }, ref) => {
    return (
      <textarea
        ref={ref}
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
}

export function Label({ children, required, hint, className = "" }: LabelProps) {
  return (
    <label className={`block text-sm font-medium text-forge-ash mb-1.5 ${className}`}>
      {children}
      {required && <span className="text-danger ml-0.5">*</span>}
      {hint && <span className="text-forge-ash/60 text-xs ml-2">{hint}</span>}
    </label>
  );
}
