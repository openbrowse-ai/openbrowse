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

export function Wordmark({ className }: { className?: string }) {
  return (
    <>
      <Image
        src="/icon/wordmark.svg"
        alt="OpenBrowse"
        width={1831}
        height={307}
        className={`w-auto dark:hidden ${className ?? ""}`}
      />
      <Image
        src="/icon/wordmark-dark.svg"
        alt="OpenBrowse"
        width={1831}
        height={307}
        className={`hidden w-auto dark:block ${className ?? ""}`}
      />
    </>
  );
}
