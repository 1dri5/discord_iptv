import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    allowedHosts: ['pickup-proxy-answer-cooler.trycloudflare.com'],
    proxy: {
      '/api': 'http://localhost:3000',
      '/socket.io': {
        target: 'http://localhost:3000',
        ws: true,
      },
      '/m3u8': 'http://localhost:3000',
      '/chunk': 'http://localhost:3000',
    },
  },
})