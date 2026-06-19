interface CardProps {
  children: React.ReactNode;
  tone?: "default" | "muted" | "accent" | "success" | "warning" | "danger";
  className?: string;
  padding?: "none" | "sm" | "md" | "lg";
}

const toneStyles: Record<NonNullable<CardProps["tone"]>, string> = {
  default: "bg-forge-iron",
  muted:   "bg-forge-iron/60",
  accent:  "bg-ember/10 border border-ember/20",
  success: "bg-success/10 border border-success/20",
  warning: "bg-warning/10 border border-warning/20",
  danger:  "bg-danger/10 border border-danger/20",
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
      className={`rounded-card ${toneStyles[tone]} ${paddingStyles[padding]} ${className}`}
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
        <h2 className="text-base font-semibold text-forge-mist tracking-tight">{title}</h2>
        {subtitle && (
          <p className="text-sm text-forge-ash mt-0.5">{subtitle}</p>
        )}
      </div>
      {action}
    </div>
  );
}
