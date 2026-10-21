import { createContext, type ReactNode, useCallback, useContext, useState } from "react";

type Tone = "info" | "bad";
interface Toast {
  id: number;
  text: string;
  tone: Tone;
}

const ToastContext = createContext<(text: string, tone?: Tone) => void>(() => {});

/** A line at the bottom for four seconds: what happened, or why it did not. */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const show = useCallback((text: string, tone: Tone = "info") => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, tone }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 4000);
  }, []);
  return (
    <ToastContext.Provider value={show}>
      {children}
      <div className="pointer-events-none fixed inset-x-0 bottom-4 z-50 flex flex-col items-center gap-2" role="log" aria-label="提示">
        {toasts.map((t) => (
          <div key={t.id} className={`rounded-md px-3 py-1.5 text-sm text-page shadow-float ${t.tone === "bad" ? "bg-berry" : "bg-ink"}`}>
            {t.text}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export const useToast = () => useContext(ToastContext);
