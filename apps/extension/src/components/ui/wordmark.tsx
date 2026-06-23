export function Wordmark({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/icon/wordmark.svg"
        alt="OpenBrowse"
        className={`dark:hidden ${className ?? ""}`}
      />
      <img
        src="/icon/wordmark-dark.svg"
        alt="OpenBrowse"
        className={`hidden dark:block ${className ?? ""}`}
      />
    </>
  );
}
