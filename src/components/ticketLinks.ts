import { createContext, useContext } from "react";

/** How a ticket key in rendered text behaves. Without a provider the classic inbox's store answers. */
export interface TicketLinks {
  /** The ticket's title when its key can be opened here. */
  titleOf(key: string): string | null;
  open(key: string): void;
}

export const TicketLinksContext = createContext<TicketLinks | null>(null);

export const useTicketLinks = () => useContext(TicketLinksContext);
