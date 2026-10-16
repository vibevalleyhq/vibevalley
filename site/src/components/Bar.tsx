// The bar along the top: the farm's name, the sections, the other language. See-through over the scene, solid once
// the page is scrolled past it.
import { useMotionValueEvent, useScroll } from 'motion/react'
import { useEffect, useState } from 'react'
import type { Copy } from '../i18n/zh'
import { cx } from './ui'

interface Props {
  copy: Pick<Copy, 'home' | 'title' | 'nav' | 'other'> & { name: string }
  github: string
}

/** Past the scene (the hero, #top), less the bar's own height. */
const pastScene = (y: number) => y > (document.getElementById('top')?.offsetHeight ?? innerHeight) - 80

export default function Bar({ copy, github }: Props) {
  const [solid, setSolid] = useState(false)
  const { scrollY } = useScroll()
  useMotionValueEvent(scrollY, 'change', (y) => setSolid(pastScene(y)))
  useEffect(() => setSolid(pastScene(scrollY.get())), [scrollY])
  const toChinese = copy.other.href === '/'
  return (
    <header
      className={cx(
        'fixed inset-x-0 top-0 z-20 flex items-center gap-6 px-[clamp(16px,4vw,40px)] py-3 text-cream-50 transition-[background-color,box-shadow] duration-300 ease-[steps(3)]',
        solid && 'bg-bark-900/92 shadow-[0_2px_0_var(--color-bark-900)]',
      )}
    >
      <a className="flex items-center gap-2.5 font-pixel text-2xl/none text-shadow-soft" href={copy.home}>
        <img src="/gen/icon-64.png" alt="" width="32" height="32" className="size-8 border-2 border-bark-900" />
        {copy.name}
      </a>
      <nav aria-label={copy.title} className="ml-auto flex gap-5 font-pixel text-lg/none">
        {(['how', 'features', 'screens', 'start'] as const).map((id) => (
          <a key={id} href={`#${id}`} className="hidden border-b-2 border-transparent py-1 text-shadow-soft hover:border-wheat min-[860px]:block">
            {copy.nav[id]}
          </a>
        ))}
        <a href={github} className="border-b-2 border-transparent py-1 text-shadow-soft hover:border-wheat">
          {copy.nav.github}
        </a>
      </nav>
      <a
        className="border-2 border-cream-50 px-2.5 py-1.5 font-pixel text-lg/none hover:bg-cream-50 hover:text-bark-900"
        href={copy.other.href}
        hrefLang={toChinese ? 'zh-CN' : 'en'}
        lang={toChinese ? 'zh-CN' : 'en'}
      >
        {copy.other.label}
      </a>
    </header>
  )
}
