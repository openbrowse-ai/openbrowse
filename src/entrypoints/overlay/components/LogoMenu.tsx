import { Maximize, Settings } from "lucide-react";
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
  anchorRef: React.RefObject<HTMLButtonElement | null>;
}

export function LogoMenu({ open, onOpenChange, anchorRef }: LogoMenuProps) {
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
          chrome.tabs.create({ url: chrome.runtime.getURL("/settings.html") });
          closeOverlay();
        } else if (value === "full-view") {
          chrome.tabs.create({ url: chrome.runtime.getURL("/home.html") });
          closeOverlay();
        }
      }}
    >
      <ComboboxContent side="top" align="start" sideOffset={8} anchor={anchorRef} className="w-auto min-w-44">
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
