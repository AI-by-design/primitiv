import type { ReactNode } from "react"

export interface ButtonProps {
  variant?: "primary" | "secondary" | "destructive"
  size?: "sm" | "md" | "lg"
  disabled?: boolean
  onClick?: () => void
  children: ReactNode
}

export function Button({ variant = "primary", size = "md", disabled = false, onClick, children }: ButtonProps) {
  return (
    <button
      type="button"
      data-variant={variant}
      data-size={size}
      disabled={disabled}
      onClick={onClick}
      style={{
        backgroundColor: "var(--color-primary)",
        color: "var(--color-bg)",
        padding: "var(--spacing-sm) var(--spacing-md)",
        borderRadius: "var(--radius-md)",
        fontFamily: "var(--font-sans)",
        fontSize: "var(--font-size-md)",
        fontWeight: "var(--font-weight-medium)",
        border: "none",
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1
      }}
    >
      {children}
    </button>
  )
}
