// subset-font ships no types: the one function the prepare script calls.
declare module 'subset-font' {
  export default function subsetFont(font: Buffer, text: string, options?: { targetFormat?: 'sfnt' | 'woff' | 'woff2' | 'truetype' }): Promise<Buffer>
}
