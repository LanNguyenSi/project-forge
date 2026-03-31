interface BadgeProps {
  children: React.ReactNode;
  variant?: "default" | "success" | "warning" | "danger" | "info";
  className?: string;
}

const variantStyles: Record<NonNullable<BadgeProps["variant"]>, string> = {
  default: "bg-gray-800 text-gray-400",
  success: "bg-green-950/60 text-green-400",
  warning: "bg-yellow-950/60 text-yellow-400",
  danger: "bg-red-950/60 text-red-400",
  info: "bg-blue-950/60 text-blue-400",
};

export function Badge({ children, variant = "default", className = "" }: BadgeProps) {
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-xs font-medium ${variantStyles[variant]} ${className}`}
    >
      {children}
    </span>
  );
}
