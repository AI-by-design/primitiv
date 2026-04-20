import type { ReactNode } from "react"

export interface CardProps {
  elevated?: boolean
  padding?: "sm" | "md" | "lg"
  children: ReactNode
}

export function Card({ elevated = false, padding = "md", children }: CardProps) {
  const paddingValue = padding === "sm" ? "var(--spacing-sm)" : padding === "lg" ? "var(--spacing-lg)" : "var(--spacing-md)"

  return (
    <div
      data-elevated={elevated}
      style={{
        backgroundColor: "var(--color-bg)",
        border: "1px solid var(--color-border)",
        borderRadius: "var(--radius-lg)",
        padding: paddingValue,
        boxShadow: elevated ? "0 4px 12px oklch(0 0 0 / 0.08)" : "none"
      }}
    >
      {children}
    </div>
  )
}
