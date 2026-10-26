import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath, URL } from 'node:url';
export default defineConfig({plugins:[react()],resolve:{alias:{'@awb/contracts':fileURLToPath(new URL('../../packages/contracts/src/index.ts',import.meta.url))}},server:{port:5173}});
