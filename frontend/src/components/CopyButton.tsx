import { useState } from "react";

type Props = {
  text: string;
  label?: string;
  /** Minimal icon-only button for tight layouts (footer, etc.) */
  icon?: boolean;
};

export function CopyButton({ text, label = "Copy", icon = false }: Props) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignore */
    }
  }

  return (
    <button
      type="button"
      className={`copy-btn${icon ? " copy-btn--icon" : ""}`}
      onClick={() => void copy()}
      title={copied ? "Copied" : label}
      aria-label={copied ? "Copied" : label}
    >
      {icon ? (copied ? "✓" : "⧉") : copied ? "Copied" : label}
    </button>
  );
}
