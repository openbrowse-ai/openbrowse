export interface AgentScenario {
  id: string;
  label: string;
  caption: string;
  videoLight: string;
  videoDark: string;
  posterLight: string;
  posterDark: string;
}

export const SCENARIOS: AgentScenario[] = [
  {
    id: "pricing",
    label: "Research & Document",
    caption: "Compare pricing across Vercel, Netlify, and Cloudflare Pages, then write the result to a Notion doc.",
    videoLight: "/scenes/light/agent-1-pricing-notion.webm",
    videoDark: "/scenes/dark/agent-1-pricing-notion.webm",
    posterLight: "/scenes/light/agent-1-poster.jpg",
    posterDark: "/scenes/dark/agent-1-poster.jpg",
  },
  {
    id: "flight",
    label: "Book Flights",
    caption: "Find the cheapest direct flight SFO → NRT next Friday in economy.",
    videoLight: "/scenes/light/agent-2-flight.webm",
    videoDark: "/scenes/dark/agent-2-flight.webm",
    posterLight: "/scenes/light/agent-2-poster.jpg",
    posterDark: "/scenes/dark/agent-2-poster.jpg",
  },
  {
    id: "pr-check",
    label: "Review PR Checks",
    caption: "Pull the failing PR check on linear-app/web and explain what's broken.",
    videoLight: "/scenes/light/agent-3-linear-pr.webm",
    videoDark: "/scenes/dark/agent-3-linear-pr.webm",
    posterLight: "/scenes/light/agent-3-poster.jpg",
    posterDark: "/scenes/dark/agent-3-poster.jpg",
  },
  {
    id: "papers",
    label: "Summarize Papers",
    caption: "Go through Hugging Face daily papers and summarize them.",
    videoLight: "/scenes/light/agent-4-hf-papers.webm",
    videoDark: "/scenes/dark/agent-4-hf-papers.webm",
    posterLight: "/scenes/light/agent-4-poster.jpg",
    posterDark: "/scenes/dark/agent-4-poster.jpg",
  }
];
