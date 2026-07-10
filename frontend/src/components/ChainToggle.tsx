export type CreateChainKey = "base" | "robinhood";

type Props = {
  value: CreateChainKey;
  onChange: (chain: CreateChainKey) => void;
  disabled?: boolean;
};

export function ChainToggle({ value, onChange, disabled }: Props) {
  return (
    <div className="chain-toggle" role="group" aria-label="Lock chain">
      <button
        type="button"
        className={`chain-toggle__btn${value === "base" ? " active" : ""}`}
        aria-pressed={value === "base"}
        disabled={disabled}
        onClick={() => onChange("base")}
      >
        Base
      </button>
      <button
        type="button"
        className={`chain-toggle__btn${value === "robinhood" ? " active" : ""}`}
        aria-pressed={value === "robinhood"}
        disabled={disabled}
        onClick={() => onChange("robinhood")}
      >
        Robinhood
      </button>
    </div>
  );
}
