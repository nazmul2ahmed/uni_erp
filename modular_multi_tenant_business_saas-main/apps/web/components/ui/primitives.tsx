"use client";

import { LoaderCircle, Search, X } from "lucide-react";
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from "react";

type ButtonVariant = "primary" | "secondary" | "outline" | "ghost" | "destructive" | "link";
type ButtonSize = "sm" | "default" | "lg";

export function Button({ variant = "primary", size = "default", loading = false, children, className = "", disabled, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize; loading?: boolean }) {
  return <button className={`button button-${variant} button-${size} ${className}`} disabled={disabled || loading} {...props}>{loading && <LoaderCircle aria-hidden="true" className="spin" size={15} />}{children}</button>;
}

export function Badge({ children, variant = "neutral" }: { children: ReactNode; variant?: string }) { return <span className={`badge badge-${variant}`}>{children}</span>; }
export function Card({ children, className = "" }: { children: ReactNode; className?: string }) { return <section className={`card ${className}`}>{children}</section>; }

export function Input({ label, description, error, required, ...props }: InputHTMLAttributes<HTMLInputElement> & { label?: string; description?: string; error?: string; required?: boolean }) {
  return <label className="field">{label && <span className="field-label">{label}{required && <span aria-hidden="true"> *</span>}</span>}<input className={`input ${error ? "input-error" : ""}`} aria-invalid={Boolean(error)} {...props} />{error ? <span className="field-error">{error}</span> : description && <span className="field-description">{description}</span>}</label>;
}

export function EmptyState({ icon, title, description, action }: { icon?: ReactNode; title: string; description: string; action?: ReactNode }) { return <div className="empty-state">{icon || <Search size={22} />}<h3>{title}</h3><p>{description}</p>{action}</div>; }
export function Skeleton({ className = "" }: { className?: string }) { return <div aria-hidden="true" className={`skeleton ${className}`} />; }

export function Dialog({ open, title, children, onClose }: { open: boolean; title: string; children: ReactNode; onClose: () => void }) {
  if (!open) return null;
  return <div className="dialog-backdrop" role="presentation" onMouseDown={onClose}><div aria-labelledby="dialog-title" aria-modal="true" className="dialog" role="dialog" onMouseDown={(event) => event.stopPropagation()}><div className="dialog-header"><h2 id="dialog-title">{title}</h2><Button aria-label="Close dialog" variant="ghost" size="sm" onClick={onClose}><X size={17} /></Button></div>{children}</div></div>;
}