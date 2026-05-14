import { Kbd } from "@/components/ui/kbd";
import { Search } from "lucide-react";
import { useRef } from "react";

interface TabSearchProps {
  value: string;
  onChange: (value: string) => void;
  inputRef?: React.RefObject<HTMLInputElement | null>;
}

export function TabSearch({ value, onChange, inputRef }: TabSearchProps) {
  const localRef = useRef<HTMLInputElement>(null);
  const ref = inputRef ?? localRef;

  return (
    <div className="relative px-2">
      <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-[var(--muted-foreground)]" />
      <input
        ref={ref}
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape" && value) {
            e.preventDefault();
            onChange("");
            ref.current?.blur();
          }
        }}
        placeholder="Search tabs..."
        className="w-full h-8 pl-8 pr-8 text-xs bg-[var(--muted)] rounded-md border border-[var(--border)] outline-none placeholder:text-[var(--muted-foreground)] focus:ring-1 focus:ring-[var(--ring)]"
      />
      <Kbd className="absolute right-4 top-1/2 -translate-y-1/2">
        {value ? "esc" : "/"}
      </Kbd>
    </div>
  );
}
