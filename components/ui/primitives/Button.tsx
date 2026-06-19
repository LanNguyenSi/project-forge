import { ButtonHTMLAttributes, forwardRef } from "react";

type Variant = "primary" | "secondary" | "danger" | "ghost" | "success";
type Size = "sm" | "md" | "lg";

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  block?: boolean;
  loading?: boolean;
}

// WCAG AA note: ember primary uses text-forge-void (#0B0D10 on #F5641E = 6.14:1 contrast)
const variantStyles: Record<Variant, string> = {
  primary:
    "bg-ember text-forge-void hover:bg-ember-soft focus-visible:ring-ember",
  secondary:
    "bg-forge-steel text-forge-mist hover:bg-forge-steel/70 hover:text-forge-mist focus-visible:ring-forge-ash",
  danger:
    "bg-danger/15 text-danger hover:bg-danger/25 focus-visible:ring-danger",
  ghost:
    "text-forge-ash hover:text-forge-mist hover:bg-forge-steel/60 focus-visible:ring-forge-ash",
  success:
    "bg-success/15 text-success hover:bg-success/25 focus-visible:ring-success",
};

const sizeStyles: Record<Size, string> = {
  sm: "px-3 py-1.5 text-xs",
  md: "px-4 py-2 text-sm",
  lg: "px-5 py-2.5 text-sm",
};

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  (
    {
      variant = "primary",
      size = "md",
      block = false,
      loading = false,
      disabled,
      className = "",
      children,
      ...props
    },
    ref,
  ) => {
    return (
      <button
        ref={ref}
        disabled={disabled || loading}
        className={`
          inline-flex items-center justify-center gap-2 rounded-btn font-medium
          transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-offset-2
          focus-visible:ring-offset-forge-void
          disabled:cursor-not-allowed disabled:opacity-50
          ${variantStyles[variant]}
          ${sizeStyles[size]}
          ${block ? "w-full" : ""}
          ${className}
        `}
        {...props}
      >
        {loading && (
          <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
        )}
        {children}
      </button>
    );
  },
);
Button.displayName = "Button";
