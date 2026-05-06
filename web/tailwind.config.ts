import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        viral: {
          yellow: "#FFEB00",
          amber: "#FFC74C",
          cyan: "#33D9FF",
        },
      },
    },
  },
  plugins: [],
};

export default config;
