import Image from "next/image";

export function Logo({ className }: { className?: string }) {
  return (
    <>
      <Image
        src="/icon/logo.svg"
        alt="OpenBrowse"
        width={24}
        height={24}
        className={`dark:hidden ${className ?? ""}`}
      />
      <Image
        src="/icon/logo-dark.svg"
        alt="OpenBrowse"
        width={24}
        height={24}
        className={`hidden dark:block ${className ?? ""}`}
      />
    </>
  );
}
