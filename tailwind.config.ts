import type { Config } from "tailwindcss";

export default {
  content: [
    "./app/**/*.{js,ts,jsx,tsx,mdx}",
    "./components/**/*.{js,ts,jsx,tsx,mdx}",
  ],
  theme: {
    extend: {
      colors: {
        forge: {
          void:  "#0B0D10",
          iron:  "#14181D",
          steel: "#222A32",
          ash:   "#8A93A0",
          mist:  "#E7ECF2",
        },
        ember: {
          DEFAULT: "#F5641E",
          soft:    "#FB7A33",
        },
        gold:    "#FFB02E",
        success: "#34D399",
        warning: "#FBBF24",
        danger:  "#FB7185",
      },
      borderRadius: {
        btn:  "4px",
        card: "10px",
      },
      fontFamily: {
        display: ["var(--font-display)", "sans-serif"],
        sans:    ["var(--font-sans)", "ui-sans-serif", "system-ui", "sans-serif"],
        mono:    ["var(--font-mono)", "ui-monospace", "monospace"],
      },
      backgroundImage: {
        heat: "linear-gradient(95deg, #F5641E, #FFB02E)",
      },
    },
  },
  plugins: [],
} satisfies Config;
