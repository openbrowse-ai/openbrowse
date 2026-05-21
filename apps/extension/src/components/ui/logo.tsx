export function Logo({ className }: { className?: string }) {
  return (
    <>
      <img
        src="/icon/logo.svg"
        alt="OpenBrowse"
        className={`dark:hidden ${className ?? ""}`}
      />
      <img
        src="/icon/logo-dark.svg"
        alt="OpenBrowse"
        className={`hidden dark:block ${className ?? ""}`}
      />
    </>
  );
}
