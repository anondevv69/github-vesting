import { useState } from "react";

type Props = {
  text: string;
  label?: string;
};

export function CopyButton({ text, label = "Copy" }: Props) {
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
    <button type="button" className="copy-btn" onClick={() => void copy()}>
      {copied ? "Copied" : label}
    </button>
  );
}
