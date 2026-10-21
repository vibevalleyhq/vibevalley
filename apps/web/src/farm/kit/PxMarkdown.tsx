import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { cx, pxText } from "./base";
import { mentionHref, withMentions } from "./markdown";

// Colours follow the text around it (currentColor), so the same rules read on cream paper and on a green bubble.
// One weight and no italics: ** and * show as plain words.
const common =
  "min-w-0 break-words [&_strong]:font-normal [&_em]:not-italic [&_del]:line-through [&_p]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5 [&_blockquote]:border-l-2 [&_blockquote]:border-current/30 [&_blockquote]:pl-3 [&_blockquote]:opacity-80 [&_code]:bg-current/10 [&_code]:px-1 [&_pre]:my-2 [&_pre]:overflow-x-auto [&_pre]:bg-current/10 [&_pre]:p-2 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_table]:my-2 [&_td]:border [&_td]:border-current/25 [&_td]:px-2 [&_th]:border [&_th]:border-current/25 [&_th]:px-2 [&_th]:font-normal";

const said = cx(
  pxText.sm,
  "[&_code]:font-mono [&_h1]:text-[1.05em] [&_h2]:text-[1.05em] [&_h3]:text-[1.05em] [&_h4]:text-[1.05em] [&_h1,&_h2,&_h3,&_h4]:leading-[1.35] [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:my-1.5 [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:font-normal",
);

// Reading, a heading is the pixel font at a size it is sharp at: 24 for a title, 12 for a section, as the labels around it.
const reading = cx(
  pxText.read,
  "max-w-[560px] [&_code]:font-mono [&_code]:text-[0.9em] [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:my-2 [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:font-pixel [&_h1,&_h2,&_h3,&_h4,&_h5,&_h6]:font-normal [&_h1]:text-[24px] [&_h1]:leading-[1.3333] [&_h2,&_h3,&_h4,&_h5,&_h6]:text-[12px] [&_h2,&_h3,&_h4,&_h5,&_h6]:leading-[1.5]",
);

/**
 * GitHub-flavoured, no raw HTML. With `mentions`, @w3, @管家, @主人 and @所有人 outside code are small tags. A link
 * goes to `onOpenLink` when given, else opens in a new tab. `reading`: long text in pxText.read at most 40 characters
 * a line; headings stay pixel, code stays mono. `className` carries the colour.
 */
export function PxMarkdown({
  text,
  mentions = false,
  onOpenLink,
  reading: read = false,
  className,
}: {
  text: string;
  mentions?: boolean;
  onOpenLink?: (url: string) => void;
  reading?: boolean;
  className?: string;
}) {
  const components: Components = {
    a: ({ href, children }) =>
      href === mentionHref ? (
        <span className="inline-block bg-current/13 px-[0.3em] whitespace-nowrap">{children}</span>
      ) : (
        <a
          href={href}
          target={onOpenLink ? undefined : "_blank"}
          rel="noreferrer"
          onClick={(e) => {
            if (!onOpenLink || !href) return;
            e.preventDefault();
            onOpenLink(href);
          }}
          className="underline decoration-current/45"
        >
          {children}
        </a>
      ),
    hr: () => <div role="separator" className="my-2 h-[1.5px] bg-[repeating-linear-gradient(to_right,currentColor_0_3px,transparent_3px_6px)] opacity-40" />,
  };
  return (
    <div className={cx(common, read ? reading : said, className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {mentions ? withMentions(text) : text}
      </ReactMarkdown>
    </div>
  );
}

/** Plain text to read, as PxMarkdown with `reading` draws it. */
export function PxReadText({ text, maxLines, className }: { text: string; maxLines?: number; className?: string }) {
  return (
    <p
      className={cx(pxText.read, "max-w-[560px] whitespace-pre-wrap", maxLines !== undefined && "overflow-hidden", className)}
      style={maxLines !== undefined ? { display: "-webkit-box", WebkitBoxOrient: "vertical", WebkitLineClamp: maxLines } : undefined}
    >
      {text}
    </p>
  );
}
