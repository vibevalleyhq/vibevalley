// How to start: the one warning first, what you need, and the commands to build the app, with a button that copies
// them and says so.
import { AnimatePresence, MotionConfig, motion, steps } from 'motion/react'
import { useRef, useState } from 'react'
import type { Copy } from '../i18n/zh'
import { Section, useReveal } from './ui'

interface Props {
  copy: Pick<Copy, 'start' | 'safety'>
  commands: string[]
  readme: string
  /** The warning's mark, the list's check, the copy button's icon. */
  icons: { warn: string; check: string; copy: string }
}

export default function Start({ copy, commands, readme, icons }: Props) {
  const root = useReveal<HTMLElement>()
  return (
    <MotionConfig reducedMotion="user">
      <Section ref={root} id="start" alt title={copy.start.title}>
        <div data-reveal role="note" className="flex items-start gap-5 panel bg-warn! p-6">
          <img loading="lazy" src={icons.warn} alt="" className="size-12 flex-none object-contain pixelated" />
          <div>
            <h3 className="mb-1.5 text-2xl text-berry">{copy.safety.title}</h3>
            <p className="text-base">{copy.safety.text}</p>
            <p className="mt-2 text-base">{copy.safety.wip}</p>
          </div>
        </div>
        <div className="mt-7 grid grid-cols-1 items-start gap-7 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.3fr)]">
          <div data-reveal className="panel p-6">
            <h3 className="text-2xl">{copy.start.needs}</h3>
            <ul className="mt-3">
              {copy.start.list.map((item) => (
                <li key={item} className="flex items-start gap-2.5 py-1.5 text-base">
                  <img loading="lazy" src={icons.check} alt="" className="mt-[5px] size-5 flex-none object-contain pixelated" />
                  {item}
                </li>
              ))}
            </ul>
          </div>
          <div data-reveal className="panel p-6">
            <div className="flex items-center justify-between gap-3">
              <h3 className="text-2xl">{copy.start.build}</h3>
              <CopyButton text={commands.join('\n')} icon={icons.copy} check={icons.check} label={copy.start.copy} done={copy.start.copied} />
            </div>
            <pre className="mt-3.5 overflow-x-auto border-2 border-bark-900 bg-bark-900 px-5 py-[18px] font-mono text-sm/[1.8] text-cream-50 shadow-[inset_0_0_0_2px_var(--color-bark-600)]">
              {commands.map((c) => (
                <span key={c} className="block">
                  <span className="text-wheat select-none">$ </span>
                  {c}
                </span>
              ))}
            </pre>
            <p className="mt-3.5 text-[15px] text-bark-800">
              {copy.start.more}{' '}
              <a href={readme} className="underline">
                {copy.start.readme}
              </a>
            </p>
          </div>
        </div>
      </Section>
    </MotionConfig>
  )
}

/** Copies the commands; its label hops over to "copied" and back. */
function CopyButton({ text, icon, check, label, done }: { text: string; icon: string; check: string; label: string; done: string }) {
  const [copied, setCopied] = useState(false)
  const timer = useRef(0)
  async function copy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    window.clearTimeout(timer.current)
    timer.current = window.setTimeout(() => setCopied(false), 1600)
  }
  return (
    <button type="button" onClick={copy} className="inline-flex h-8 cursor-pointer items-center overflow-hidden border-2 border-bark-900 bg-cream-50 px-2 font-pixel text-sm/none text-bark-900 hover:bg-cream-hover">
      <AnimatePresence mode="popLayout" initial={false}>
        <motion.span
          key={copied ? 'done' : 'copy'}
          initial={{ y: 14, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -14, opacity: 0 }}
          transition={{ duration: 0.2, ease: steps(3) }}
          className="inline-flex items-center gap-1.5"
        >
          <img src={copied ? check : icon} alt="" className="size-4 object-contain pixelated" />
          {copied ? done : label}
        </motion.span>
      </AnimatePresence>
      <span className="sr-only" aria-live="polite">
        {copied ? done : ''}
      </span>
    </button>
  )
}
