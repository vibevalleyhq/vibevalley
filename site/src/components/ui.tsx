// The pieces the islands share: the game's button, a section with its heading, and how parts come in as they reach
// the screen. Styles are Tailwind utilities on the game's theme (styles/global.css).
import { animate, inView, resize, scroll, steps, useInView, type DOMKeyframesDefinition } from 'motion/react'
import { useEffect, useRef, useState, type AnchorHTMLAttributes, type CSSProperties, type ReactNode, type Ref, type RefObject } from 'react'

/** Class names, the falsy ones left out. */
export const cx = (...names: (string | false | null | undefined)[]) => names.filter(Boolean).join(' ')

/** CSS variables in a style. */
export const vars = (v: Record<`--${string}`, string | number>) => v as CSSProperties

/** Those who ask for less motion: nothing follows the page or the pointer, nothing comes in (read once, in the browser). */
export const STILL = typeof window !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches

type ScrollOffset = NonNullable<NonNullable<Parameters<typeof scroll>[1]>['offset']>

/** One animation tied to the scroll: its keyframes, and where along the stretch of scroll each falls (0 to 1). */
export interface ScrollPart {
  keyframes: DOMKeyframesDefinition
  times?: number[]
}

/**
 * Plays animations of an element as the page scrolls past a target, with Motion's scroll(): the browser runs them on
 * a native scroll or view timeline where it has them (in step with the scroll, off the main thread), Motion in script
 * where it has not. The offset is the stretch of scroll, as Motion's ('start end' to 'end start': while the target
 * crosses the screen); parts() gives the animations from the target's size, again whenever that changes. Transform
 * and opacity only, so they stay on the compositor. Nothing moves for those who ask for less motion, unless the
 * animation is no motion at all (fading: still: true).
 */
export function useScrollLinked<T extends HTMLElement>(
  target: RefObject<HTMLElement | null> | 'self',
  offset: ScrollOffset,
  parts: (target: HTMLElement) => ScrollPart[],
  { still = false }: { still?: boolean } = {},
) {
  const ref = useRef<T>(null)
  useEffect(() => {
    const el = ref.current
    const over = target === 'self' ? el : target.current
    if (!el || !over || (STILL && !still)) return
    let stops: (() => void)[] = []
    const stop = () => {
      stops.forEach((s) => s())
      stops = []
    }
    const start = () => {
      stop()
      for (const part of parts(over)) {
        const animation = animate(el, part.keyframes, { ease: 'linear', duration: 1, times: part.times })
        stops.push(scroll(animation, { target: over, offset }), () => animation.cancel())
      }
    }
    start()
    const watching = resize(over, start)
    return () => {
      watching()
      stop()
    }
  }, [])
  return ref
}

/** Marks the element data-off while it is off the screen, so its animations hold still (global.css). */
export function useOffScreen<T extends HTMLElement>(ref: RefObject<T | null>) {
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const watch = new IntersectionObserver(([e]) => el.toggleAttribute('data-off', !e!.isIntersecting))
    watch.observe(el)
    return () => watch.disconnect()
  }, [ref])
}

/** The game's button: a link in the pixel font, lit along its top-left edge, on a hard drop that it sinks into when pressed. */
export function PixelLink({ primary, className, children, ...rest }: { primary?: boolean; children: ReactNode } & AnchorHTMLAttributes<HTMLAnchorElement>) {
  return (
    <a
      className={cx(
        'inline-flex items-center gap-2.5 border-2 border-bark-900 px-5 py-2.5 font-pixel text-2xl/none shadow-hard active:translate-0.5 active:shadow-none',
        primary ? 'bg-leaf-500 text-cream-50 inset-shadow-lit inset-shadow-leaf-hover hover:bg-leaf-hover' : 'bg-cream-50 text-bark-900 inset-shadow-lit hover:bg-cream-hover',
        className,
      )}
      {...rest}
    >
      {children}
    </a>
  )
}

/** A section of the page below the scene: its heading after a little wheat-coloured block, then what it holds. */
export function Section({ id, title, alt, ref, children }: { id: string; title: string; alt?: boolean; ref?: Ref<HTMLElement>; children: ReactNode }) {
  return (
    <section ref={ref} id={id} aria-labelledby={`${id}-title`} className={cx('relative px-[clamp(16px,5vw,64px)] py-[clamp(64px,9vw,120px)]', alt && 'border-y-2 border-bark-900 bg-cream-100')}>
      <div className="mx-auto max-w-[1120px]">
        <Heading id={`${id}-title`}>{title}</Heading>
        {children}
      </div>
    </section>
  )
}

/** A section's heading (also a second one inside a section). */
export function Heading({ id, className, children }: { id?: string; className?: string; children: ReactNode }) {
  return (
    <h2
      id={id}
      data-reveal
      className={cx(
        'mb-9 flex items-center gap-3.5 text-[clamp(30px,3.6vw,42px)] before:size-3.5 before:shrink-0 before:border-2 before:border-bark-900 before:bg-wheat before:shadow-hard-sm',
        className,
      )}
    >
      {children}
    </h2>
  )
}

/**
 * Brings in the parts of an island marked data-reveal as they reach the screen: up and into view in a few pixel
 * steps, data-reveal's milliseconds after the others in its row. Only what is still below the screen when the island
 * wakes is hidden first, so nothing on screen blinks; without the script, or for those who ask for less motion, every
 * part simply stays where it is.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const root = ref.current
    if (!root || STILL) return
    const stops: (() => void)[] = []
    for (const el of root.querySelectorAll<HTMLElement>('[data-reveal]')) {
      if (el.getBoundingClientRect().top < innerHeight) continue
      el.style.opacity = '0'
      el.style.transform = 'translateY(24px)'
      const stop = inView(
        el,
        () => {
          animate(el, { opacity: 1, transform: 'translateY(0px)' }, { duration: 0.4, ease: steps(4), delay: (Number(el.dataset.reveal) || 0) / 1000 })
          stop()
        },
        { margin: '0px 0px -8% 0px' },
      )
      stops.push(stop)
    }
    return () => stops.forEach((stop) => stop())
  }, [])
  return ref
}

/** A number counting up from 0 the first time it comes on screen, in steps like a game's counter. The page is built
 *  with the number itself, which stays for those who ask for less motion. */
export function CountUp({ to, className }: { to: number; className?: string }) {
  const ref = useRef<HTMLSpanElement>(null)
  const seen = useInView(ref, { once: true, margin: '0px 0px -10% 0px' })
  const [shown, setShown] = useState(to)
  useEffect(() => {
    if (!seen || STILL) return
    const run = animate(0, to, { duration: 1.1, ease: steps(Math.min(12, to)), onUpdate: (v) => setShown(Math.round(v)) })
    return () => run.stop()
  }, [seen, to])
  return (
    <span ref={ref} className={cx('tabular-nums', className)}>
      {shown}
    </span>
  )
}
