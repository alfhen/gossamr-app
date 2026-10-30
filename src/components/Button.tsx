import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

export type ButtonVariant = "secondary" | "primary" | "quiet" | "pip" | "pipSolid" | "plain" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

const VARIANT: Record<ButtonVariant, string> = {
  secondary: "ws-btn--secondary",
  primary: "ws-btn--primary",
  quiet: "ws-btn--quiet",
  pip: "ws-btn--pip",
  pipSolid: "ws-btn--pip-solid",
  plain: "ws-btn--plain",
  danger: "ws-btn--danger",
};

const SIZE: Record<ButtonSize, string> = { sm: "ws-btn--sm", md: "", lg: "ws-btn--lg" };

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** A plain button in Pip's colour, for Ask Pip in a list row. */
  pip?: boolean;
  /** Red label, for an action that stops or removes something. */
  destructive?: boolean;
  /** A square button holding one glyph; give it an aria-label. */
  iconOnly?: boolean;
  children?: ReactNode;
}

export const buttonClass = ({ variant = "secondary", size = "md", pip = false, destructive = false, iconOnly = false, className = "" }: Pick<ButtonProps, "variant" | "size" | "pip" | "destructive" | "iconOnly" | "className">) =>
  ["ws-btn", VARIANT[variant], SIZE[size], iconOnly && "ws-btn--icon", pip && "is-pip", destructive && "is-danger", className].filter(Boolean).join(" ");

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button({ variant, size, pip, destructive, iconOnly, className, type = "button", ...rest }, ref) {
  return <button ref={ref} type={type} {...rest} className={buttonClass({ variant, size, pip, destructive, iconOnly, className })} />;
});
