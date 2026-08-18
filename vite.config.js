import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    // 监听所有网卡：局域网内手机/其他设备可访问（默认只监听 localhost）
    // 手机访问地址 = 电脑局域网 IP + 端口（终端启动时会打印 Network 地址）
    host: true,
    port: 5173,
  },
})
