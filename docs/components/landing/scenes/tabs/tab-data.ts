export interface TabData {
  id: string;
  title: string;
  favicon: string;
  space?: string;
}

export const INITIAL_TABS: TabData[] = [
  { id: "t1", title: "React – A JavaScript library for building user interfaces", favicon: "https://www.google.com/s2/favicons?domain=reactjs.org&sz=32" },
  { id: "t2", title: "Tailwind CSS - Rapidly build modern websites without ever leaving your HTML.", favicon: "https://www.google.com/s2/favicons?domain=tailwindcss.com&sz=32" },
  { id: "t3", title: "Pricing | Vercel", favicon: "https://www.google.com/s2/favicons?domain=vercel.com&sz=32" },
  { id: "t4", title: "Cloudflare Pages", favicon: "https://www.google.com/s2/favicons?domain=cloudflare.com&sz=32" },
  { id: "t5", title: "GitHub - openbrowse-ai/openbrowse", favicon: "https://www.google.com/s2/favicons?domain=github.com&sz=32" },
  { id: "t6", title: "Netlify Pricing and Plans", favicon: "https://www.google.com/s2/favicons?domain=netlify.com&sz=32" },
  { id: "t7", title: "Introduction | Next.js", favicon: "https://www.google.com/s2/favicons?domain=nextjs.org&sz=32" },
  { id: "t8", title: "Framer Motion", favicon: "https://www.google.com/s2/favicons?domain=framer.com&sz=32" },
  { id: "t9", title: "Supabase | The Open Source Firebase Alternative", favicon: "https://www.google.com/s2/favicons?domain=supabase.com&sz=32" },
];

// Cleaned up by AI Tidy
export const TIDIED_TABS: TabData[] = [
  // Space: Frontend Dev
  { id: "t1", title: "React Docs", favicon: "https://www.google.com/s2/favicons?domain=reactjs.org&sz=32", space: "Frontend Dev" },
  { id: "t7", title: "Next.js Intro", favicon: "https://www.google.com/s2/favicons?domain=nextjs.org&sz=32", space: "Frontend Dev" },
  { id: "t2", title: "Tailwind CSS", favicon: "https://www.google.com/s2/favicons?domain=tailwindcss.com&sz=32", space: "Frontend Dev" },
  { id: "t8", title: "Framer Motion", favicon: "https://www.google.com/s2/favicons?domain=framer.com&sz=32", space: "Frontend Dev" },
  
  // Space: Hosting Research
  { id: "t3", title: "Vercel Pricing", favicon: "https://www.google.com/s2/favicons?domain=vercel.com&sz=32", space: "Hosting" },
  { id: "t6", title: "Netlify Pricing", favicon: "https://www.google.com/s2/favicons?domain=netlify.com&sz=32", space: "Hosting" },
  { id: "t4", title: "Cloudflare Pages", favicon: "https://www.google.com/s2/favicons?domain=cloudflare.com&sz=32", space: "Hosting" },

  // Space: Tools
  { id: "t5", title: "OpenBrowse Repo", favicon: "https://www.google.com/s2/favicons?domain=github.com&sz=32", space: "Tools" },
  { id: "t9", title: "Supabase", favicon: "https://www.google.com/s2/favicons?domain=supabase.com&sz=32", space: "Tools" },
];
