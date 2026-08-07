/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  darkMode: "class",
  theme: {
    extend: {
      colors: {
        surface: {
          DEFAULT: "#1e293b",
          alt: "#0f172a",
          card: "#1e293b",
          hover: "#334155",
          border: "#334155",
        },
      },
    },
  },
  plugins: [],
};
