declare module "*.svg?raw" {
  const content: string;
  export default content;
}

declare global {
  interface Window {
    __OPENBROWSE_DEBUG_PARTS?: unknown;
    __OPENBROWSE_DEBUG_HISTORY?: string[];
  }
}

export {};
