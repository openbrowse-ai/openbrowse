export function ProgressEmptyArt() {
  // A minimalist checklist: rounded rectangle with three rows;
  // first row has a small check, others remain blank.
  return (
    <svg
      width="56"
      height="48"
      viewBox="0 0 56 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-muted-foreground/40"
      aria-hidden="true"
    >
      {/* Outer card */}
      <rect
        x="4.5"
        y="4.5"
        width="47"
        height="39"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="var(--background)"
      />
      {/* Row 1: filled bullet + line + check */}
      <circle cx="13" cy="14" r="2" fill="currentColor" opacity="0.6" />
      <path
        d="M19 14H42"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.55"
      />
      <path
        d="M37 11.5L39 14L42 10.5"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        strokeLinejoin="round"
        className="text-foreground/60"
      />
      {/* Row 2 */}
      <circle
        cx="13"
        cy="24"
        r="2"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M19 24H38"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.4"
      />
      {/* Row 3 */}
      <circle
        cx="13"
        cy="34"
        r="2"
        stroke="currentColor"
        strokeWidth="1.25"
      />
      <path
        d="M19 34H32"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}

export function WorkingFolderEmptyArt() {
  // A staggered stack of two file shapes — back file peeks behind front file.
  return (
    <svg
      width="56"
      height="48"
      viewBox="0 0 56 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-muted-foreground/40"
      aria-hidden="true"
    >
      {/* Back file (offset, lighter) */}
      <path
        d="M14 6H26L32 12V36C32 37.1 31.1 38 30 38H14C12.9 38 12 37.1 12 36V8C12 6.9 12.9 6 14 6Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        opacity="0.55"
        fill="var(--background)"
      />
      <path
        d="M26 6V12H32"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        opacity="0.55"
      />
      {/* Front file */}
      <path
        d="M22 12H34L40 18V40C40 41.1 39.1 42 38 42H22C20.9 42 20 41.1 20 40V14C20 12.9 20.9 12 22 12Z"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
        fill="var(--background)"
      />
      <path
        d="M34 12V18H40"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinejoin="round"
      />
      {/* Content lines on front file */}
      <path
        d="M25 26H35"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.5"
      />
      <path
        d="M25 31H32"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
        opacity="0.4"
      />
    </svg>
  );
}

export function ContextEmptyArt() {
  // Three small staggered rounded cards, matching the empty-state style of
  // ProgressEmptyArt / WorkingFolderEmptyArt.
  return (
    <svg
      width="56"
      height="48"
      viewBox="0 0 56 48"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      className="text-muted-foreground/40"
      aria-hidden="true"
    >
      <rect
        x="10"
        y="10"
        width="22"
        height="22"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="var(--background)"
        opacity="0.55"
      />
      <rect
        x="18"
        y="15"
        width="22"
        height="22"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="var(--background)"
        opacity="0.75"
      />
      <rect
        x="26"
        y="20"
        width="22"
        height="22"
        rx="5"
        stroke="currentColor"
        strokeWidth="1.25"
        fill="var(--background)"
      />
      <path
        d="M37 28V34M34 31H40"
        stroke="currentColor"
        strokeWidth="1.25"
        strokeLinecap="round"
      />
    </svg>
  );
}
