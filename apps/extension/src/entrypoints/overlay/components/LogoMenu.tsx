import { Maximize, Settings } from "lucide-react";
import { openSettingsTab } from "@/lib/open-settings";
import { Combobox as ComboboxPrimitive } from "@base-ui/react";
import {
  Combobox,
  ComboboxCollection,
  ComboboxContent,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";

function closeOverlay() {
  window.parent.postMessage({ type: "OPENBROWSE_OVERLAY_CLOSE" }, "*");
}

const MENU_ITEMS = [
  { id: "settings", label: "Settings", icon: Settings },
  { id: "full-view", label: "Open Full View", icon: Maximize },
] as const;

type MenuItemId = (typeof MENU_ITEMS)[number]["id"];
const ITEM_IDS: MenuItemId[] = MENU_ITEMS.map((i) => i.id);
const ITEMS_BY_ID = new Map(MENU_ITEMS.map((i) => [i.id, i]));
const itemToStringLabel = (id: MenuItemId) => ITEMS_BY_ID.get(id)?.label ?? id;

interface LogoMenuProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function LogoMenu({ open, onOpenChange }: LogoMenuProps) {
  return (
    <Combobox
      open={open}
      onOpenChange={onOpenChange}
      items={ITEM_IDS}
      itemToStringLabel={itemToStringLabel}
      autoHighlight="always"
      onValueChange={(value) => {
        if (!value) return;
        onOpenChange(false);
        if (value === "settings") {
          void openSettingsTab();
          closeOverlay();
        } else if (value === "full-view") {
          chrome.tabs.create({ url: chrome.runtime.getURL("/home.html") });
          closeOverlay();
        }
      }}
    >
      {/* Trigger lives inside the Combobox so base-ui owns the
          toggle-vs-outside-press behavior — clicking it while open closes
          cleanly instead of close-then-reopen flashing (same as the model
          picker). Rendered chevron-free via the base-ui primitive. */}
      <ComboboxPrimitive.Trigger
        className="flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground transition-colors"
        title="Menu"
      >
        <img
          src={chrome.runtime.getURL("/icon/32.png")}
          alt="OpenBrowse"
          className="size-4 dark:hidden"
        />
        <img
          src={chrome.runtime.getURL("/icon/32-dark.png")}
          alt="OpenBrowse"
          className="size-4 hidden dark:block"
        />
      </ComboboxPrimitive.Trigger>
      <ComboboxContent side="top" align="start" sideOffset={8} className="w-auto min-w-44">
        <ComboboxList>
          <ComboboxCollection>
            {(id: MenuItemId) => {
              const item = ITEMS_BY_ID.get(id);
              if (!item) return null;
              const Icon = item.icon;
              return (
                <ComboboxItem key={id} value={id} className="gap-2">
                  <Icon className="size-3.5" />
                  <span>{item.label}</span>
                </ComboboxItem>
              );
            }}
          </ComboboxCollection>
        </ComboboxList>
        <ComboboxInput placeholder="Search..." showTrigger={false} />
        <div className="px-3 py-1.5 text-xs text-muted-foreground/60">
          OpenBrowse v{chrome.runtime.getManifest().version}
        </div>
      </ComboboxContent>
    </Combobox>
  );
}
