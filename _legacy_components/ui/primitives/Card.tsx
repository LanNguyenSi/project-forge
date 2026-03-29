interface CardProps {
  children: React.ReactNode;
  tone?: "default" | "muted" | "accent" | "success" | "warning" | "danger";
  className?: string;
  padding?: "none" | "sm" | "md" | "lg";
}

const toneStyles: Record<NonNullable<CardProps["tone"]>, string> = {
  default: "bg-gray-900/80",
  muted: "bg-gray-900/40",
  accent: "bg-blue-950/30",
  success: "bg-green-950/25",
  warning: "bg-yellow-950/25",
  danger: "bg-red-950/25",
};

const paddingStyles: Record<NonNullable<CardProps["padding"]>, string> = {
  none: "",
  sm: "p-4",
  md: "p-5 sm:p-6",
  lg: "p-6 sm:p-8",
};

export function Card({
  children,
  tone = "default",
  className = "",
  padding = "md",
}: CardProps) {
  return (
    <div
      className={`rounded-md ${toneStyles[tone]} ${paddingStyles[padding]} ${className}`}
    >
      {children}
    </div>
  );
}

interface CardHeaderProps {
  title: string;
  subtitle?: string;
  action?: React.ReactNode;
}

export function CardHeader({ title, subtitle, action }: CardHeaderProps) {
  return (
    <div className="flex items-center justify-between mb-5">
      <div>
        <h2 className="text-base font-semibold text-gray-100 tracking-tight">{title}</h2>
        {subtitle && (
          <p className="text-sm text-gray-500 mt-0.5">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}
