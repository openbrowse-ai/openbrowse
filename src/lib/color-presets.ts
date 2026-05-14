export interface ColorPreset {
  colors: string[];
  angle: number;
  radius: number;
  numPoints: number;
}

export interface PalettePage {
  name: string;
  presets: ColorPreset[];
}

const R = 84;

export const PALETTE_PAGES: PalettePage[] = [
  {
    name: "Warm",
    presets: [
      { colors: ["#e8a87c"], angle: 0.55, radius: R, numPoints: 1 },
      { colors: ["#d4738a", "#e8a87c"], angle: 0.4, radius: R, numPoints: 2 },
      { colors: ["#d4738a", "#e8a87c", "#f0c27f"], angle: 0.45, radius: R, numPoints: 3 },
      { colors: ["#c0392b"], angle: 0.0, radius: R * 0.8, numPoints: 1 },
      { colors: ["#e74c3c", "#f39c12"], angle: 0.15, radius: R, numPoints: 2 },
      { colors: ["#ff6b6b"], angle: 6.1, radius: R * 0.85, numPoints: 1 },
      { colors: ["#f7dc6f", "#f0b27a"], angle: 0.8, radius: R, numPoints: 2 },
      { colors: ["#e55d87", "#5fc3e4"], angle: 5.8, radius: R, numPoints: 2 },
    ],
  },
  {
    name: "Cool",
    presets: [
      { colors: ["#667eea"], angle: 3.8, radius: R, numPoints: 1 },
      { colors: ["#667eea", "#764ba2"], angle: 4.0, radius: R, numPoints: 2 },
      { colors: ["#4facfe", "#00f2fe"], angle: 3.5, radius: R * 0.9, numPoints: 2 },
      { colors: ["#2ecc71"], angle: 2.1, radius: R * 0.8, numPoints: 1 },
      { colors: ["#43e97b", "#38f9d7"], angle: 2.2, radius: R, numPoints: 2 },
      { colors: ["#a18cd1", "#fbc2eb"], angle: 4.5, radius: R, numPoints: 2 },
      { colors: ["#30cfd0", "#330867"], angle: 3.3, radius: R, numPoints: 2 },
      { colors: ["#89f7fe", "#66a6ff", "#764ba2"], angle: 3.6, radius: R, numPoints: 3 },
    ],
  },
  {
    name: "Muted",
    presets: [
      { colors: ["#b8c6db"], angle: 3.8, radius: R * 0.4, numPoints: 1 },
      { colors: ["#c9b1a0"], angle: 0.6, radius: R * 0.45, numPoints: 1 },
      { colors: ["#a8b5a2"], angle: 2.0, radius: R * 0.4, numPoints: 1 },
      { colors: ["#c2b4d6", "#b8c6db"], angle: 4.2, radius: R * 0.45, numPoints: 2 },
      { colors: ["#d4a5a5"], angle: 0.0, radius: R * 0.4, numPoints: 1 },
      { colors: ["#b0aeb1"], angle: 0.0, radius: R * 0.2, numPoints: 1 },
      { colors: ["#c9ccd3", "#dee4e7"], angle: 3.5, radius: R * 0.3, numPoints: 2 },
      { colors: ["#e6ddd1", "#c9b1a0"], angle: 0.7, radius: R * 0.45, numPoints: 2 },
    ],
  },
  {
    name: "Vivid",
    presets: [
      { colors: ["#f953c6"], angle: 5.5, radius: R, numPoints: 1 },
      { colors: ["#f953c6", "#b91d73"], angle: 5.6, radius: R, numPoints: 2 },
      { colors: ["#ff0844", "#ffb199"], angle: 6.1, radius: R, numPoints: 2 },
      { colors: ["#00c9ff", "#92fe9d"], angle: 3.0, radius: R, numPoints: 2 },
      { colors: ["#fc5c7d", "#6a82fb"], angle: 5.0, radius: R, numPoints: 2 },
      { colors: ["#f7971e", "#ffd200"], angle: 0.9, radius: R, numPoints: 2 },
      { colors: ["#a855f7"], angle: 4.7, radius: R, numPoints: 1 },
      { colors: ["#06b6d4", "#a855f7", "#ec4899"], angle: 4.0, radius: R, numPoints: 3 },
    ],
  },
];
