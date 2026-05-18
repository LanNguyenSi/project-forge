import { InputHTMLAttributes, TextareaHTMLAttributes, forwardRef } from "react";

const baseStyles =
  "w-full rounded-md border-0 bg-gray-800 px-3.5 py-2 text-gray-100 placeholder-gray-500 ring-1 ring-inset ring-gray-700 transition-colors focus:ring-2 focus:ring-blue-500 focus:outline-none";

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
    <label className={`block text-sm font-medium text-gray-400 mb-1.5 ${className}`}>
      {children}
      {required && <span className="text-red-400 ml-0.5">*</span>}
      {hint && <span className="text-gray-600 text-xs ml-2">{hint}</span>}
    </label>
  );
}
