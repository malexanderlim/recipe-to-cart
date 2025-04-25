/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    "./frontend/**/*.{html,js}", // Scan HTML and JS files in the frontend directory
  ],
  theme: {
    extend: {
      colors: {
        'instacart-green': '#003D29',
        'instacart-cream': '#FAF1E5',
      },
      height: {
        '46px': '46px',
      },
      padding: {
        '18px': '18px',
      }
    },
  },
  plugins: [],
} 