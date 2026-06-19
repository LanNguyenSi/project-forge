interface AlertProps {
  children: React.ReactNode;
  variant?: "error" | "success" | "warning" | "info";
  onClose?: () => void;
  className?: string;
}

const variantStyles: Record<NonNullable<AlertProps["variant"]>, string> = {
  error:   "border-l-danger bg-danger/10 text-danger",
  success: "border-l-success bg-success/10 text-success",
  warning: "border-l-warning bg-warning/10 text-warning",
  info:    "border-l-forge-ash bg-forge-steel text-forge-mist",
};

export function Alert({
  children,
  variant = "info",
  onClose,
  className = "",
}: AlertProps) {
  return (
    <div
      className={`border-l-2 rounded-r-btn pl-4 pr-4 py-3 text-sm ${variantStyles[variant]} ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1">{children}</div>
        {onClose && (
          <button
            onClick={onClose}
            aria-label="Close"
            className="opacity-50 hover:opacity-100 text-lg leading-none transition"
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );
}
