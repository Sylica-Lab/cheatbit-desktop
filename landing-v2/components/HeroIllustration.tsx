'use client'

import { motion } from 'framer-motion'

export const HeroIllustration = () => {
  return (
    <svg viewBox="0 0 400 300" className="w-full h-full">
      {/* Background Grid */}
      <defs>
        <pattern id="grid" width="20" height="20" patternUnits="userSpaceOnUse">
          <path d="M 20 0 L 0 0 0 20" fill="none" stroke="#e2e8f0" strokeWidth="0.5"/>
        </pattern>
        <linearGradient id="gradient1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#7df9c7" stopOpacity="0.3"/>
          <stop offset="100%" stopColor="#7f97ff" stopOpacity="0.3"/>
        </linearGradient>
      </defs>
      
      <rect width="400" height="300" fill="url(#grid)"/>
      
      {/* Floating Elements */}
      <motion.g
        animate={{ y: [0, -10, 0] }}
        transition={{ duration: 4, repeat: Infinity, ease: "easeInOut" }}
      >
        {/* Main Window */}
        <rect x="50" y="40" width="300" height="220" rx="12" fill="white" stroke="#e2e8f0" strokeWidth="2"/>
        
        {/* Window Header */}
        <rect x="50" y="40" width="300" height="40" rx="12" fill="#f8fafc"/>
        <rect x="50" y="68" width="300" height="12" fill="#f8fafc"/>
        
        {/* Window Controls */}
        <circle cx="70" cy="60" r="4" fill="#ef4444"/>
        <circle cx="84" cy="60" r="4" fill="#f59e0b"/>
        <circle cx="98" cy="60" r="4" fill="#22c55e"/>
        
        {/* Dock */}
        <rect x="100" y="220" width="200" height="36" rx="18" fill="#1e293b"/>
        
        {/* Dock Items */}
        <rect x="115" y="226" width="24" height="24" rx="6" fill="#7f97ff"/>
        <rect x="150" y="226" width="50" height="24" rx="6" fill="#22c55e"/>
        <text x="160" y="242" fill="white" fontSize="10" fontWeight="600">Solve</text>
        <rect x="210" y="226" width="24" height="24" rx="6" fill="#f43f5e"/>
        <rect x="245" y="226" width="24" height="24" rx="6" fill="#8b5cf6"/>
        <rect x="280" y="226" width="24" height="24" rx="6" fill="#06b6d4"/>
        
        {/* Chat Bubbles */}
        <rect x="70" y="100" width="180" height="40" rx="8" fill="#f1f5f9"/>
        <rect x="70" y="110" width="120" height="8" rx="4" fill="#cbd5e1"/>
        <rect x="70" y="124" width="80" height="8" rx="4" fill="#cbd5e1"/>
        
        <rect x="150" y="150" width="180" height="50" rx="8" fill="#dcfce7"/>
        <rect x="160" y="160" width="100" height="8" rx="4" fill="#16a34a"/>
        <rect x="160" y="174" width="140" height="8" rx="4" fill="#22c55e"/>
        <rect x="160" y="188" width="60" height="8" rx="4" fill="#86efac"/>
        
        {/* Stealth Badge */}
        <motion.g
          animate={{ scale: [1, 1.05, 1] }}
          transition={{ duration: 2, repeat: Infinity }}
        >
          <rect x="280" y="80" width="80" height="24" rx="12" fill="#22c55e"/>
          <text x="320" y="96" textAnchor="middle" fill="white" fontSize="10" fontWeight="600">Stealth</text>
        </motion.g>
        
        {/* Connection Lines */}
        <path d="M 300 92 L 340 92" stroke="#22c55e" strokeWidth="2" strokeDasharray="4 2"/>
        <circle cx="340" cy="92" r="3" fill="#22c55e"/>
      </motion.g>
      
      {/* Floating Particles */}
      {[...Array(5)].map((_, i) => (
        <motion.circle
          key={i}
          cx={80 + i * 60}
          cy={250 + (i % 2) * 20}
          r="4"
          fill={['#7df9c7', '#8be7ff', '#7f97ff', '#a78bfa', '#f472b6'][i]}
          animate={{ 
            y: [0, -20, 0],
            opacity: [0.5, 1, 0.5]
          }}
          transition={{ 
            duration: 3 + i * 0.5, 
            repeat: Infinity, 
            ease: "easeInOut",
            delay: i * 0.3
          }}
        />
      ))}
    </svg>
  )
}
