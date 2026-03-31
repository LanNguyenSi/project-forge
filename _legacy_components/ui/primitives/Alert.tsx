interface AlertProps {
  children: React.ReactNode;
  variant?: "error" | "success" | "warning" | "info";
  onClose?: () => void;
  className?: string;
}

const variantStyles: Record<NonNullable<AlertProps["variant"]>, string> = {
  error: "border-l-red-500 bg-red-950/30 text-red-300",
  success: "border-l-green-500 bg-green-950/20 text-green-300",
  warning: "border-l-yellow-500 bg-yellow-950/20 text-yellow-300",
  info: "border-l-blue-500 bg-blue-950/20 text-blue-300",
};

export function Alert({
  children,
  variant = "info",
  onClose,
  className = "",
}: AlertProps) {
  return (
    <div
      className={`border-l-2 rounded-r-md pl-4 pr-4 py-3 text-sm ${variantStyles[variant]} ${className}`}
    >
      <div className="flex items-start gap-3">
        <div className="flex-1">{children}</div>
        {onClose && (
          <button
            onClick={onClose}
            className="opacity-50 hover:opacity-100 text-lg leading-none transition"
          >
            &times;
          </button>
        )}
      </div>
    </div>
  );
}
