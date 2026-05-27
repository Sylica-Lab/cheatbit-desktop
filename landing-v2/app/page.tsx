'use client'

import { useState } from 'react'
import { motion } from 'framer-motion'
import { 
  Check, Zap, ArrowRight
} from 'lucide-react'

const FadeIn = ({
  children,
  delay = 0,
  className = '',
}: {
  children: React.ReactNode
  delay?: number
  className?: string
}) => (
  <motion.div
    className={className}
    initial={{ opacity: 0, y: 20 }}
    whileInView={{ opacity: 1, y: 0 }}
    viewport={{ once: true }}
    transition={{ duration: 0.5, delay }}
  >
    {children}
  </motion.div>
)

export default function LandingPage() {
  const [billingCycle, setBillingCycle] = useState<'monthly' | 'yearly'>('monthly')

  return (
    <main className="min-h-screen bg-white text-slate-900">
      {/* Nav */}
      <nav className="fixed top-0 left-0 right-0 z-50 bg-white border-b border-slate-100">
        <div className="max-w-6xl mx-auto px-6 h-14 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-7 h-7 bg-slate-900 rounded-lg flex items-center justify-center">
              <Zap className="w-4 h-4 text-white" />
            </div>
            <span className="font-semibold text-sm">Sylica</span>
          </div>
          <div className="flex items-center gap-6 text-sm">
            <a href="#features" className="text-slate-500 hover:text-slate-900">Features</a>
            <a href="#pricing" className="text-slate-500 hover:text-slate-900">Pricing</a>
            <button className="px-4 py-1.5 bg-slate-900 text-white text-sm rounded-md">
              Download
            </button>
          </div>
        </div>
      </nav>

      {/* Hero - Clean with App Mockup */}
      <section className="pt-24 pb-20 px-6">
        <div className="max-w-5xl mx-auto">
          <FadeIn className="text-center mb-12">
            <h1 className="text-4xl sm:text-5xl font-semibold tracking-tight mb-4">
              Invisible interview copilot
            </h1>
            <p className="text-lg text-slate-500 mb-6">
              AI assistance that screen shares can't detect.
            </p>
            <button className="px-6 py-2.5 bg-slate-900 text-white text-sm font-medium rounded-lg inline-flex items-center gap-2">
              Start free trial <ArrowRight className="w-4 h-4" />
            </button>
          </FadeIn>

          {/* App Interface Illustration */}
          <FadeIn delay={0.1}>
            <div className="relative max-w-3xl mx-auto">
              {/* Browser/App Window */}
              <div className="bg-slate-50 rounded-2xl border border-slate-200 p-1">
                <div className="bg-white rounded-xl border border-slate-200 overflow-hidden shadow-xl">
                  {/* Title Bar */}
                  <div className="flex items-center gap-2 px-3 py-2.5 bg-slate-50 border-b border-slate-200">
                    <div className="flex gap-1.5">
                      <div className="w-2.5 h-2.5 rounded-full bg-rose-400" />
                      <div className="w-2.5 h-2.5 rounded-full bg-amber-400" />
                      <div className="w-2.5 h-2.5 rounded-full bg-emerald-400" />
                    </div>
                  </div>

                  {/* The Dock */}
                  <div className="p-3 bg-slate-50">
                    <div className="flex items-center gap-1 bg-white rounded-full border border-slate-200 p-1.5 shadow-sm">
                      <div className="w-9 h-9 rounded-full bg-gradient-to-br from-violet-500 to-purple-600 flex items-center justify-center">
                        <Zap className="w-4 h-4 text-white" />
                      </div>
                      <div className="w-px h-5 bg-slate-200" />
                      <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center">
                        <svg className="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8"/><path d="M12 17v4"/></svg>
                      </div>
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-100">
                        <svg className="w-4 h-4 text-slate-600" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="m8 3 4 8 8 4"/><path d="m17 3 1 8 8 4"/></svg>
                        <span className="text-xs text-slate-700">Analyze</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-900">
                        <Check className="w-4 h-4 text-white" />
                        <span className="text-xs text-white">Solve</span>
                      </div>
                      <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-slate-100">
                        <span className="w-2 h-2 rounded-full bg-rose-500" />
                        <span className="text-xs text-slate-700">Live</span>
                      </div>
                      <div className="px-2 py-1 rounded bg-slate-200">
                        <span className="text-[10px] font-medium text-slate-700">COMP</span>
                      </div>
                      <div className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center">
                        <svg className="w-4 h-4 text-slate-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="5" y="2" width="14" height="20" rx="2"/><path d="M12 18h.01"/></svg>
                      </div>
                    </div>
                  </div>

                  {/* Chat Panel */}
                  <div className="p-4 bg-slate-50">
                    <div className="bg-white rounded-xl border border-slate-200 p-4">
                      <div className="flex gap-3">
                        <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
                          <span className="text-xs font-bold text-emerald-700">AI</span>
                        </div>
                        <div className="flex-1 bg-slate-50 rounded-lg rounded-tl-sm p-3">
                          <p className="text-sm text-slate-700">
                            Optimal approach: memoization with O(n) time.
                          </p>
                        </div>
                      </div>
                    </div>
                  </div>
                </div>
              </div>

              {/* Floating Labels */}
              <div className="absolute -left-4 top-1/3 bg-white rounded-lg border border-slate-200 shadow-lg px-3 py-2 text-xs">
                <span className="text-emerald-600 font-medium">● Invisible</span>
                <span className="text-slate-400 ml-1">to screenshare</span>
              </div>
              <div className="absolute -right-4 bottom-1/3 bg-white rounded-lg border border-slate-200 shadow-lg px-3 py-2 text-xs">
                <span className="text-slate-600">Audio capture</span>
              </div>
            </div>
          </FadeIn>
        </div>
      </section>

      {/* Features - Visual Cards */}
      <section id="features" className="py-20 px-6 bg-slate-50">
        <div className="max-w-5xl mx-auto">
          <FadeIn className="text-center mb-12">
            <h2 className="text-2xl font-semibold">Works like magic</h2>
          </FadeIn>

          <div className="grid md:grid-cols-3 gap-6">
            {/* Card 1: Screenshot */}
            <FadeIn delay={0.1}>
              <div className="bg-white rounded-2xl border border-slate-200 p-6 h-full">
                <div className="bg-slate-900 rounded-xl p-4 mb-4 aspect-[4/3] flex flex-col">
                  <div className="flex gap-1.5 mb-3">
                    <div className="w-2 h-2 rounded-full bg-rose-400" />
                    <div className="w-2 h-2 rounded-full bg-amber-400" />
                  </div>
                  <div className="flex-1 bg-slate-800 rounded flex items-center justify-center">
                    <div className="text-center">
                      <div className="text-[10px] text-slate-500 mb-1">LeetCode</div>
                      <div className="text-xs text-slate-300 font-mono">Two Sum</div>
                    </div>
                  </div>
                  <div className="mt-3 flex items-center gap-2">
                    <div className="flex-1 h-6 rounded bg-slate-700" />
                    <div className="w-16 h-6 rounded bg-violet-500" />
                  </div>
                </div>
                <h3 className="font-semibold mb-1">Analyze</h3>
                <p className="text-sm text-slate-500">Screenshot → instant breakdown</p>
              </div>
            </FadeIn>

            {/* Card 2: Code Solution */}
            <FadeIn delay={0.2}>
              <div className="bg-white rounded-2xl border border-slate-200 p-6 h-full">
                <div className="bg-slate-900 rounded-xl p-4 mb-4 aspect-[4/3] font-mono text-[10px] leading-relaxed overflow-hidden">
                  <div className="text-slate-500">// Solution</div>
                  <div className="text-violet-400">def <span className="text-slate-300">twoSum</span>(nums, target):</div>
                  <div className="text-slate-300 pl-2">seen = {}</div>
                  <div className="text-slate-300 pl-2">for i, n in enumerate(nums):</div>
                  <div className="text-slate-300 pl-4">complement = target - n</div>
                  <div className="text-slate-300 pl-4">if complement in seen:</div>
                  <div className="text-emerald-400 pl-6">return [seen[complement], i]</div>
                  <div className="text-slate-300 pl-4">seen[n] = i</div>
                </div>
                <h3 className="font-semibold mb-1">Solve</h3>
                <p className="text-sm text-slate-500">Optimal solutions with complexity</p>
              </div>
            </FadeIn>

            {/* Card 3: Live Audio */}
            <FadeIn delay={0.3}>
              <div className="bg-white rounded-2xl border border-slate-200 p-6 h-full">
                <div className="bg-slate-900 rounded-xl p-4 mb-4 aspect-[4/3] flex flex-col items-center justify-center">
                  <div className="w-20 h-20 rounded-full border-2 border-rose-500/30 flex items-center justify-center mb-3">
                    <div className="flex items-end gap-0.5 h-8">
                      {[4, 6, 3, 8, 5, 7, 4, 6].map((h, i) => (
                        <div key={i} className="w-1 bg-rose-500 rounded-full" style={{ height: `${h * 4}px` }} />
                      ))}
                    </div>
                  </div>
                  <div className="text-xs text-slate-400">Listening...</div>
                </div>
                <h3 className="font-semibold mb-1">Live</h3>
                <p className="text-sm text-slate-500">Real-time audio assistance</p>
              </div>
            </FadeIn>
          </div>
        </div>
      </section>

      {/* Stealth Features - Simple */}
      <section className="py-20 px-6">
        <div className="max-w-5xl mx-auto">
          <FadeIn className="text-center mb-12">
            <h2 className="text-2xl font-semibold">Leaves no trace</h2>
          </FadeIn>

          <div className="grid md:grid-cols-3 gap-8 text-center">
            <FadeIn delay={0.1}>
              <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-slate-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M9.5 14.5 3 21"/><path d="M17.5 9.5 21 6"/><circle cx="14" cy="10" r="5.5"/>
                </svg>
              </div>
              <h3 className="font-medium mb-1">No meeting bots</h3>
              <p className="text-sm text-slate-500">Doesn't join as a participant</p>
            </FadeIn>
            <FadeIn delay={0.2}>
              <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-slate-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                </svg>
              </div>
              <h3 className="font-medium mb-1">Screen share safe</h3>
              <p className="text-sm text-slate-500">Invisible to recording</p>
            </FadeIn>
            <FadeIn delay={0.3}>
              <div className="w-16 h-16 bg-slate-100 rounded-2xl flex items-center justify-center mx-auto mb-4">
                <svg className="w-7 h-7 text-slate-700" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
                  <path d="M12 2a10 10 0 1 0 10 10 4 4 0 0 1-5-5 4 4 0 0 1-5-5"/>
                </svg>
              </div>
              <h3 className="font-medium mb-1">Phone relay</h3>
              <p className="text-sm text-slate-500">Mirror OTPs & camera</p>
            </FadeIn>
          </div>
        </div>
      </section>

      {/* Stats Bar */}
      <section className="py-16 px-6 bg-slate-900 text-white">
        <div className="max-w-4xl mx-auto">
          <div className="grid grid-cols-4 gap-8 text-center">
            <div>
              <div className="text-3xl font-bold">94%</div>
              <div className="text-xs text-slate-400 mt-1">Pass rate</div>
            </div>
            <div>
              <div className="text-3xl font-bold">{'<2s'}</div>
              <div className="text-xs text-slate-400 mt-1">Response</div>
            </div>
            <div>
              <div className="text-3xl font-bold">2k+</div>
              <div className="text-xs text-slate-400 mt-1">Engineers</div>
            </div>
            <div>
              <div className="text-3xl font-bold">0</div>
              <div className="text-xs text-slate-400 mt-1">Detections</div>
            </div>
          </div>
        </div>
      </section>

      {/* Pricing */}
      <section id="pricing" className="py-20 px-6 bg-slate-50">
        <div className="max-w-4xl mx-auto">
          <FadeIn className="text-center mb-10">
            <h2 className="text-2xl font-semibold mb-4">Simple pricing</h2>
            <p className="text-slate-500 max-w-2xl mx-auto mb-6">
              Start free with 10 requests per day. Upgrade when you want unlimited analysis,
              realtime voice, computer use, and multi-device connection.
            </p>
            <div className="inline-flex items-center gap-1 p-1 bg-white border border-slate-200 rounded-lg">
              <button
                onClick={() => setBillingCycle('monthly')}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                  billingCycle === 'monthly' ? 'bg-slate-900 text-white' : 'text-slate-600'
                }`}
              >
                Monthly
              </button>
              <button
                onClick={() => setBillingCycle('yearly')}
                className={`px-4 py-1.5 text-sm rounded-md transition-colors ${
                  billingCycle === 'yearly' ? 'bg-slate-900 text-white' : 'text-slate-600'
                }`}
              >
                Yearly <span className="text-emerald-600">-20%</span>
              </button>
            </div>
          </FadeIn>

          <div className="grid md:grid-cols-3 gap-6">
            {[
              {
                name: "Free",
                price: 0,
                features: ["10 requests per day", "Core screen analysis", "Basic desktop assistant"],
                cta: "Start free",
              },
              {
                name: "Pro",
                price: billingCycle === 'monthly' ? 10 : 8,
                features: [
                  "Unlimited requests",
                  "Unlimited analysis",
                  "Realtime voice conversation",
                  "Computer use",
                  "Multi-device connection",
                ],
                popular: true,
              },
              { name: "Team", price: "Custom", features: ["Everything in Pro", "Team dashboard", "Priority support"], cta: "Contact" },
            ].map((plan) => (
              <div key={plan.name} className={`rounded-2xl p-6 h-full flex flex-col ${plan.popular ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200'}`}>
                {plan.popular && <span className="text-xs font-medium text-emerald-400 mb-2">Most popular</span>}
                <h3 className="font-semibold">{plan.name}</h3>
                <div className="text-3xl font-bold my-2">{typeof plan.price === 'number' ? `$${plan.price}` : plan.price}</div>
                <ul className="space-y-2 mb-6 flex-1">
                  {plan.features.map((f) => (
                    <li key={f} className="flex items-center gap-2 text-sm">
                      <Check className={`w-4 h-4 ${plan.popular ? 'text-emerald-400' : 'text-emerald-600'}`} />
                      <span className={plan.popular ? 'text-slate-300' : 'text-slate-600'}>{f}</span>
                    </li>
                  ))}
                </ul>
                <button className={`w-full py-2 rounded-lg text-sm font-medium ${plan.popular ? 'bg-white text-slate-900' : 'bg-slate-900 text-white'}`}>
                  {plan.cta || 'Start trial'}
                </button>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="py-8 px-6 border-t border-slate-100">
        <div className="max-w-5xl mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 bg-slate-900 rounded flex items-center justify-center">
              <Zap className="w-3 h-3 text-white" />
            </div>
            <span className="text-sm font-semibold">Sylica</span>
          </div>
          <div className="flex items-center gap-6 text-sm text-slate-500">
            <a href="#" className="hover:text-slate-900">Privacy</a>
            <a href="#" className="hover:text-slate-900">Terms</a>
          </div>
        </div>
      </footer>
    </main>
  )
}
