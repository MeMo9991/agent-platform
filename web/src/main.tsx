import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { DirectionProvider } from '@/components/foundations/direction/direction'
import '@/styles/globals.css'
import './index.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode><DirectionProvider locale="zh-CN"><App /></DirectionProvider></StrictMode>,
)
