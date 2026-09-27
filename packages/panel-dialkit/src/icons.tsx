const iconProps = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": true,
} as const;

export function ClipboardIcon() {
  return (
    <svg {...iconProps}>
      <rect x="8" y="3" width="8" height="4" rx="1" />
      <path d="M16 5h2a1 1 0 0 1 1 1v14a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1V6a1 1 0 0 1 1-1h2" />
    </svg>
  );
}

export function CheckIcon() {
  return (
    <svg {...iconProps}>
      <path d="M5 12l5 5L20 7" />
    </svg>
  );
}

export function CodeIcon() {
  return (
    <svg {...iconProps}>
      <path d="M8 8l-4 4 4 4M16 8l4 4-4 4" />
    </svg>
  );
}
