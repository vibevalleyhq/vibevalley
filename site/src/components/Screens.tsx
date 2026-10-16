// A look at the farm: the game's screenshots (docs/images), each drifting at its own pace as the page scrolls. A click
// opens one large, growing out of where it was; Escape, the close button or a click outside puts it back.
import { AnimatePresence, MotionConfig, motion } from 'motion/react'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { Copy } from '../i18n/zh'
import { Section, cx, useReveal, useScrollLinked } from './ui'

interface Shot {
  /** The full width, and the widths there are (images.ts). */
  src: string
  srcset: string
  width: number
  height: number
  caption: string
}

/** How wide each screenshot is shown: the first in the wider column, the others in the narrower; full width below lg. */
const SIZES = ['(min-width: 1024px) 640px, calc(100vw - 48px)', '(min-width: 1024px) 460px, calc(100vw - 48px)', '(min-width: 1024px) 460px, calc(100vw - 48px)']

interface Props {
  copy: Copy['screens']
  shots: Shot[]
  /** The close button's icon. */
  close: string
}

/** How far each screenshot drifts against the page: the first a little with it, the others against it. */
const DRIFT = [0.04, -0.05, -0.09]

export default function Screens({ copy, shots, close }: Props) {
  const root = useReveal<HTMLElement>()
  const [open, setOpen] = useState<number | null>(null)
  return (
    <MotionConfig reducedMotion="user">
      <Section ref={root} id="screens" title={copy.title}>
        <div className="grid grid-cols-1 items-start gap-7 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          {shots.map((shot, i) => (
            <Drift key={shot.src} rate={DRIFT[i] ?? 0} className={cx(i === 0 && 'lg:row-span-2', i === 1 && 'lg:mt-[60px]')}>
              <figure data-reveal className="m-0 panel p-2.5">
                <button type="button" onClick={() => setOpen(i)} title={copy.open} className="block w-full cursor-zoom-in">
                  <motion.img
                    layoutId={`shot-${i}`}
                    src={shot.src}
                    srcSet={shot.srcset}
                    sizes={SIZES[i]}
                    alt={shot.caption}
                    loading="lazy"
                    decoding="async"
                    width={shot.width}
                    height={shot.height}
                    className="block h-auto w-full border-2 border-bark-900"
                  />
                </button>
                <figcaption className="px-1 pt-2.5 pb-0.5 text-[15px] text-bark-800">{shot.caption}</figcaption>
              </figure>
            </Drift>
          ))}
        </div>
      </Section>
      <AnimatePresence>{open !== null && <Large key={open} id={open} shot={shots[open]!} label={copy.close} icon={close} onClose={() => setOpen(null)} />}</AnimatePresence>
    </MotionConfig>
  )
}

/** A screenshot's place on the page, moving against the page by its rate while it crosses the screen. */
function Drift({ rate, className, children }: { rate: number; className?: string; children: ReactNode }) {
  const ref = useScrollLinked<HTMLDivElement>('self', ['start end', 'end start'], () => [
    { keyframes: { transform: [`translateY(${600 * rate}px)`, `translateY(${-600 * rate}px)`] } },
  ])
  return (
    <div ref={ref} className={className}>
      {children}
    </div>
  )
}

/** One screenshot opened large over a shaded page. Focus stays on its close button until it closes. */
function Large({ id, shot, label, icon, onClose }: { id: number; shot: Shot; label: string; icon: string; onClose: () => void }) {
  const button = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    const before = document.activeElement as HTMLElement | null
    button.current?.focus()
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose()
      if (e.key === 'Tab') {
        e.preventDefault()
        button.current?.focus()
      }
    }
    addEventListener('keydown', key)
    document.documentElement.style.overflow = 'hidden'
    return () => {
      removeEventListener('keydown', key)
      document.documentElement.style.overflow = ''
      before?.focus({ preventScroll: true })
    }
  }, [])
  return (
    <motion.div
      role="dialog"
      aria-modal="true"
      aria-label={shot.caption}
      onClick={onClose}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.2 }}
      className="fixed inset-0 z-50 grid place-items-center bg-shade/80 p-4 sm:p-8"
    >
      <figure onClick={(e) => e.stopPropagation()} className="relative m-0 panel p-2.5">
        <motion.img layoutId={`shot-${id}`} src={shot.src} alt={shot.caption} className="block h-auto max-h-[80svh] w-auto max-w-full border-2 border-bark-900" />
        <figcaption className="px-1 pt-2.5 pb-0.5 text-[15px] text-bark-800">{shot.caption}</figcaption>
        <button
          ref={button}
          type="button"
          onClick={onClose}
          aria-label={label}
          className="absolute -top-4 -right-4 grid size-11 cursor-pointer place-items-center border-2 border-bark-900 bg-cream-50 shadow-hard inset-shadow-lit hover:bg-cream-hover"
        >
          <img src={icon} alt="" className="size-6 pixelated" />
        </button>
      </figure>
    </motion.div>
  )
}
