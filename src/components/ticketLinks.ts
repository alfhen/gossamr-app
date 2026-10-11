import { createContext, useContext } from "react";

/** How a ticket key in rendered text behaves. Without a provider the classic inbox's store answers. */
export interface TicketLinks {
  /** The ticket's title when its key can be opened here, '' when it can be but its title isn't known; null otherwise. */
  titleOf(key: string): string | null;
  open(key: string): void;
  /** A hook each rendered key calls, subscribing it to whatever `titleOf` reads, so a key turns into a link once that loads. */
  useKnown?(): void;
}

export const TicketLinksContext = createContext<TicketLinks | null>(null);

export const useTicketLinks = () => useContext(TicketLinksContext);
