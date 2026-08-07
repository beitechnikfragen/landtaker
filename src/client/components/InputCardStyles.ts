export const ACTIVE_CARD =
  "bg-lt-accent/20 border-malibu-blue/50 shadow-[var(--shadow-malibu-blue)]";
export const INACTIVE_CARD =
  "bg-white/5 border-lt-700 hover:bg-white/10 hover:border-lt-600";
export const INPUT_CLASS =
  "w-full text-center bg-black/60 text-white text-sm font-bold border border-lt-600 focus:outline-none focus:border-malibu-blue p-1 my-1";
export const CARD_LABEL_CLASS =
  "text-xs uppercase font-bold tracking-wider leading-tight break-words hyphens-auto";

export function cardClass(active: boolean, extra = ""): string {
  return `w-full h-full border cursor-pointer transition-all duration-200 active:scale-95 relative overflow-hidden ${extra} ${active ? ACTIVE_CARD : INACTIVE_CARD}`;
}
